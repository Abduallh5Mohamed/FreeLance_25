/**
 * Video Security Engine
 * - Violation scoring per user session
 * - Temporary account suspension
 * - Session kill
 * - Heartbeat monitoring
 * - Concurrent session detection
 */
import { query, queryOne, execute } from '../db';
import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';
import { createNotification } from '../utils/notifications';

// ═══════════════════════════════════════
// VIOLATION SCORING WEIGHTS
// ═══════════════════════════════════════
const VIOLATION_WEIGHTS: Record<string, number> = {
    devtools_open: 3,
    token_reuse: 4,
    ip_change: 3,
    suspicious_segment_rate: 3,
    fullscreen_exit: 1,
    heartbeat_loss: 5,
    screen_capture_attempt: 4,
    debugger_detected: 4,
    console_tamper: 3,
    dom_mutation: 2,
    multi_tab: 2,
    abnormal_playback: 2,
    media_recorder_detected: 5,
    print_screen: 5,
    screen_blocked: 0,
    visibility_change: 0,
};

// Threshold for auto-suspension. Digits only, and a malformed value fails
// CLOSED to the documented default rather than to NaN: `totalScore >= NaN` is
// always false, so a non-numeric env value silently disabled auto-suspension
// entirely, and `Date.now() + NaN*60000` wrote an Invalid Date into
// `suspended_until`.
const SUSPENSION_THRESHOLD = parseBoundedEnvInt(process.env.VIOLATION_THRESHOLD, 10, 1, 1_000_000);
const SUSPENSION_DURATION_MINUTES = parseBoundedEnvInt(process.env.SUSPENSION_DURATION, 30, 1, 1440);

/** Digits-only bounded env integer; anything malformed falls back to `fallback`. */
function parseBoundedEnvInt(raw: string | undefined, fallback: number, min: number, max: number): number {
    if (typeof raw !== 'string' || !/^\d+$/.test(raw.trim())) return fallback;
    const parsed = Number(raw.trim());
    if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) return fallback;
    return parsed;
}

// In-memory session store (for fast access)
interface VideoSession {
    sessionId: string;
    userId: string;
    videoId: string;
    ip: string;
    userAgent: string;
    fingerprint: string;
    screenRes: string;
    createdAt: number;
    lastHeartbeat: number;
    violationScore: number;
    isActive: boolean;
    previewOnly: boolean;
    offerId?: string;
    studentEnrollmentId?: string;
    tenantId?: string;
    segmentRequests: number[];
    manifestRequests: number[];
    keyRequests: number[];
    activeMediaRequests: number;
}

const activeSessions = new Map<string, VideoSession>();
const userSessionMap = new Map<string, string>(); // userId -> sessionId (only 1 allowed)

// ═══════════════════════════════════════
// SESSION MANAGEMENT
// ═══════════════════════════════════════

/**
 * Persistence seam for session creation. Production passes the pool-backed
 * `execute`; tests inject a failing executor to prove the fail-closed path.
 */
export interface VideoSessionPersistence {
    execute: (sql: string, params?: unknown[]) => Promise<unknown>;
}

const defaultSessionPersistence: VideoSessionPersistence = {
    execute: (sql, params) => execute(sql, params),
};

/**
 * Raised when the durable `video_sessions` row could not be written.
 *
 * A session that is not provably persisted must never become a usable grant:
 * delivery reads only the row, so an id that exists solely in this process's
 * cache would be a cache-only success. Creation therefore fails instead of
 * returning such an id.
 */
export class VideoSessionPersistenceError extends Error {
    constructor() {
        super('session_persist_failed');
        this.name = 'VideoSessionPersistenceError';
    }
}

/**
 * Create a new video session.
 * Kills any existing session for this user.
 */
export async function createVideoSession(params: {
    userId: string;
    videoId: string;
    ip: string;
    userAgent: string;
    fingerprint: string;
    screenRes: string;
    previewOnly?: boolean;
    offerId?: string;
    studentEnrollmentId?: string;
    tenantId?: string;
}, persistence: VideoSessionPersistence = defaultSessionPersistence): Promise<{ sessionId: string; watermarkSeed: string }> {
    const { userId, videoId, ip, userAgent, fingerprint, screenRes, previewOnly = false,
        offerId, studentEnrollmentId, tenantId } = params;

    // Device binding is mandatory: a session without the full binding set
    // cannot be watermarked or revoked per-device, so it fails closed here
    // even if a caller skipped the route-level validation.
    if (!ip || !userAgent || !fingerprint || !screenRes) {
        throw new Error('device_binding_required');
    }

    // Kill existing session for this user
    const existingSessionId = userSessionMap.get(userId);
    if (existingSessionId) {
        await killSession(existingSessionId, 'new_session_started');
    }

    const sessionId = uuidv4();
    const watermarkSeed = crypto.randomBytes(16).toString('hex');

    const session: VideoSession = {
        sessionId,
        userId,
        videoId,
        ip,
        userAgent,
        fingerprint,
        screenRes,
        createdAt: Date.now(),
        lastHeartbeat: Date.now(),
        violationScore: 0,
        isActive: true,
        previewOnly,
        offerId,
        studentEnrollmentId,
        tenantId,
        segmentRequests: [],
        manifestRequests: [],
        keyRequests: [],
        activeMediaRequests: 0,
    };

    // Persist BEFORE publishing the session to this process's caches. The
    // previous order published first and logged the insert failure, which left
    // a usable grant backed by nothing but local memory. A session that cannot
    // be proven durable is not a session.
    try {
        // Also invalidate sessions created by another process/instance. The
        // generated unique key in the migration is the final race-condition guard.
        await persistence.execute(
            `UPDATE video_sessions SET is_active=0,killed_reason='new_session_started',killed_at=NOW()
             WHERE user_id=? AND is_active=1`,
            [userId]
        );
        const inserted = await persistence.execute(
            `INSERT INTO video_sessions 
             (id, user_id, video_id, ip_address, user_agent, fingerprint, screen_resolution, watermark_seed, is_active, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, NOW())`,
            [sessionId, userId, videoId, ip, userAgent, fingerprint, screenRes, watermarkSeed]
        );
        // A usable count is REQUIRED. Skipping the check when `affectedRows` is
        // absent published a cache-only session — the exact failure the
        // surrounding comment says must not happen — and `Number(affected)`
        // coerced rather than validated.
        const affected = (inserted as { affectedRows?: unknown } | null | undefined)?.affectedRows;
        if (typeof affected !== 'number' || !Number.isSafeInteger(affected) || affected < 1) {
            throw new Error('video_sessions insert did not report exactly one affected row');
        }
    } catch (e) {
        console.error('[Security] Failed to persist session:', e);
        // Nothing was published: no activeSessions entry, no userSessionMap
        // entry. The caller must treat creation as failed and issue no token.
        throw new VideoSessionPersistenceError();
    }

    activeSessions.set(sessionId, session);
    userSessionMap.set(userId, sessionId);

    console.log(`[Security] Session created: ${sessionId} for user ${userId}`);
    return { sessionId, watermarkSeed };
}

/**
 * Kill a session - invalidate immediately
 */
export async function killSession(sessionId: string, reason: string): Promise<void> {
    const session = activeSessions.get(sessionId);
    if (session) {
        session.isActive = false;
        activeSessions.delete(sessionId);
        userSessionMap.delete(session.userId);
    }

    try {
        await execute(
            `UPDATE video_sessions SET is_active = 0, killed_reason = ?, killed_at = NOW() WHERE id = ?`,
            [reason, sessionId]
        );
    } catch (e) {
        console.error('[Security] Failed to update session in DB:', e);
    }

    console.log(`[Security] Session killed: ${sessionId} reason: ${reason}`);
}

/**
 * Validate session is still active
 */
export function getActiveSession(sessionId: string): VideoSession | null {
    const session = activeSessions.get(sessionId);
    if (!session || !session.isActive) return null;
    return session;
}

/**
 * Durable liveness of a delivery session, read from `video_sessions`.
 *
 * `activeSessions` above is a per-process cache: a session killed by another
 * instance (or by a request that ran on another instance) still looks alive
 * here until this process restarts. Byte delivery therefore cannot treat the
 * map as the authority — it must read the row.
 *
 *  - `active`      the row says the session is live;
 *  - `revoked`     the row says it was killed (`is_active = 0`);
 *  - `unknown`     no row was found. The session was never provably persisted
 *                  (the insert at creation failed) or the row is gone, so it
 *                  is NOT a grant: callers must deny, including on the process
 *                  that created it;
 *  - `unavailable` the read failed — callers must deny.
 */
export type DurableSessionStatus = 'active' | 'revoked' | 'unknown' | 'unavailable';

export interface DurableSessionReader {
    queryOne: <T = unknown>(sql: string, params?: unknown[]) => Promise<T | null>;
}

export async function readDurableSessionStatus(
    reader: DurableSessionReader,
    sessionId: string,
): Promise<DurableSessionStatus> {
    if (!sessionId) return 'unknown';
    let row: { is_active: number | string | boolean | null } | null;
    try {
        row = await reader.queryOne<{ is_active: number | string | boolean | null }>(
            'SELECT is_active FROM video_sessions WHERE id = ? LIMIT 1',
            [sessionId],
        );
    } catch (e) {
        console.error('[Security] Failed to read durable session status:', e);
        return 'unavailable';
    }
    if (!row) return 'unknown';
    return Number(row.is_active) === 1 ? 'active' : 'revoked';
}

/**
 * Record heartbeat
 */
export function recordHeartbeat(sessionId: string): boolean {
    const session = activeSessions.get(sessionId);
    if (!session || !session.isActive) return false;
    session.lastHeartbeat = Date.now();
    return true;
}

/**
 * Check for dead sessions (no heartbeat for 15 seconds)
 */
export function cleanupDeadSessions(): void {
    const now = Date.now();
    for (const [id, session] of activeSessions) {
        if (now - session.lastHeartbeat > 15000 && session.isActive) {
            console.log(`[Security] Dead session detected: ${id} (no heartbeat for 15s)`);
            killSession(id, 'heartbeat_timeout');
        }
    }
}

/**
 * Dead-session cleanup is EXPLICITLY owned.
 *
 * A module-level `setInterval` used to run here on import, so merely importing
 * this module started a self-scheduling 10 s loop issuing DB `UPDATE`s through
 * `killSession` — a timer the owning process never started and cannot stop.
 * The sweep itself is still needed (a session whose heartbeat stops would
 * otherwise stay in `activeSessions` forever), so it is now started and stopped
 * by the route that owns video sessions, through the same explicit
 * `start()`/`stop()` shape the video-queue consumer already uses.
 *
 * Nothing schedules itself on import any more.
 */
let deadSessionCleanupTimer: ReturnType<typeof setInterval> | null = null;

/** Start the dead-session sweep. Idempotent: a second call is a no-op. */
export function startDeadSessionCleanup(intervalMs: number = 10_000): void {
    if (deadSessionCleanupTimer !== null) return;
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 1000) intervalMs = 10_000;
    deadSessionCleanupTimer = setInterval(cleanupDeadSessions, intervalMs);
    deadSessionCleanupTimer.unref();
}

/** Stop the dead-session sweep. Idempotent, and safe before any start. */
export function stopDeadSessionCleanup(): void {
    if (deadSessionCleanupTimer === null) return;
    clearInterval(deadSessionCleanupTimer);
    deadSessionCleanupTimer = null;
}

// ═══════════════════════════════════════
// VIOLATION SCORING
// ═══════════════════════════════════════

/**
 * Record a violation and update score.
 * Returns { suspended: boolean, score: number, action: string }
 */
export interface VideoRestrictions {
    qualityCap: number | null;
    fullscreenAllowed: boolean;
    riskScore: number;
}

export async function getUserVideoRestrictions(userId: string): Promise<VideoRestrictions> {
    const recent = await queryOne<any>(
        `SELECT COALESCE(SUM(violation_weight),0) score FROM video_security_logs
         WHERE user_id=? AND created_at>DATE_SUB(UTC_TIMESTAMP(),INTERVAL 24 HOUR)`, [userId]
    );
    const riskScore = Number(recent?.score || 0);
    return { qualityCap: riskScore >= 4 ? 0 : null, fullscreenAllowed: riskScore < 7, riskScore };
}

export function inspectDeliveryRequest(sessionId: string, kind: 'manifest' | 'segment' | 'key'): {
    allowed: boolean; reason?: string; release: () => void;
} {
    const session = activeSessions.get(sessionId);
    if (!session) return { allowed: false, reason: 'inactive_session', release: () => undefined };
    const now = Date.now();
    const bucket = kind === 'manifest' ? session.manifestRequests : kind === 'key' ? session.keyRequests : session.segmentRequests;
    const windowMs = kind === 'segment' ? 5000 : 60000;
    while (bucket.length && bucket[0] < now - windowMs) bucket.shift();
    bucket.push(now);
    if (kind === 'segment') session.activeMediaRequests++;
    const max = kind === 'segment' ? 18 : kind === 'manifest' ? 30 : 8;
    const tooParallel = kind === 'segment' && session.activeMediaRequests > 6;
    const allowed = bucket.length <= max && !tooParallel;
    return {
        allowed,
        reason: !allowed ? `${kind}_rate=${bucket.length};parallel=${session.activeMediaRequests}` : undefined,
        release: () => { if (kind === 'segment') session.activeMediaRequests = Math.max(0, session.activeMediaRequests - 1); },
    };
}

export async function recordViolation(params: {
    sessionId: string;
    userId: string;
    videoId: string;
    violationType: string;
    details?: string;
    ip?: string;
    userAgent?: string;
    confidence?: 'low' | 'medium' | 'high';
}): Promise<{ suspended: boolean; score: number; action: string; killed: boolean; restrictions: VideoRestrictions }> {
    const { sessionId, userId, videoId, violationType, details, ip, userAgent, confidence = 'medium' } = params;

    const weight = VIOLATION_WEIGHTS[violationType] ?? 1;
    const session = activeSessions.get(sessionId);

    let totalScore = weight;
    if (session) {
        session.violationScore += weight;
        totalScore = session.violationScore;
    }

    // Log to DB
    try {
        await execute(
            `INSERT INTO video_security_logs 
             (id, user_id, video_id, activity_type, ip_address, user_agent, details, session_id, violation_score,violation_weight,confidence, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
            [uuidv4(), userId, videoId, violationType, ip || 'unknown', userAgent || 'unknown',
            details || null, sessionId, totalScore, weight, confidence]
        );
    } catch (e) {
        console.error('[Security] Failed to log violation:', e);
    }

    const restrictions = await getUserVideoRestrictions(userId);
    totalScore = Math.max(totalScore, restrictions.riskScore);
    let action = totalScore >= 7 ? 'fullscreen_disabled' : totalScore >= 4 ? 'quality_limited' : 'logged';
    let suspended = false;
    let killed = false;

    // Check if threshold exceeded
    if (totalScore >= SUSPENSION_THRESHOLD) {
        // Kill session
        await killSession(sessionId, `violation_threshold_exceeded (score: ${totalScore})`);
        killed = true;

        // Suspend account temporarily
        try {
            const suspendUntil = new Date(Date.now() + SUSPENSION_DURATION_MINUTES * 60 * 1000);
            await execute(
                `UPDATE users SET suspended_until = ?, suspension_reason = ? WHERE id = ?`,
                [suspendUntil, `تم تعليق الحساب مؤقتاً بسبب محاولات مشبوهة (نقاط المخالفات: ${totalScore})`, userId]
            );
            suspended = true;
            action = 'suspended';
            console.log(`[Security] User ${userId} SUSPENDED until ${suspendUntil.toISOString()}`);
        } catch (e) {
            console.error('[Security] Failed to suspend user:', e);
            action = 'session_killed';
        }
    } else if (totalScore >= SUSPENSION_THRESHOLD * 0.7) {
        // Warning zone
        action = 'warning';
    }

    if (confidence === 'high' || action === 'warning' || action === 'suspended') {
        try {
            const owner = await queryOne<any>(
                `SELECT s.instructor_id,s.name FROM students s WHERE s.user_id=? AND s.is_active=1 LIMIT 1`, [userId]
            );
            if (owner?.instructor_id) await createNotification({
                user_id: owner.instructor_id, user_type: 'instructor', title: 'تنبيه حماية فيديو',
                message: `تم رصد ${violationType} للطالب ${owner.name}. مستوى المخاطر: ${totalScore}.`,
                type: 'general', link: '/instructor-students',
            });
        } catch { /* Security logging must not fail because notification failed. */ }
    }

    console.log(`[Security] Violation: ${violationType} user=${userId} score=${totalScore}/${SUSPENSION_THRESHOLD} action=${action}`);

    return { suspended, score: totalScore, action, killed,
        restrictions: { qualityCap: totalScore >= 4 ? 0 : null, fullscreenAllowed: totalScore < 7, riskScore: totalScore } };
}

/**
 * Check if user is suspended.
 *
 * Fails closed: when the suspension row cannot be read (storage/security
 * lookup failure) the account is treated as suspended rather than letting an
 * unverified viewer through. The reader is injectable so hermetic tests can
 * exercise the failure path without a database.
 */
export interface SuspensionRow {
    suspended_until: Date | string | null;
    suspension_reason?: string | null;
}

const readSuspensionRow = async (userId: string): Promise<SuspensionRow | null> =>
    queryOne<SuspensionRow>(
        'SELECT suspended_until, suspension_reason FROM users WHERE id = ?',
        [userId]
    );

export const evaluateSuspensionWindow = (
    suspendedUntil: Date | string | null | undefined,
    now: Date,
): { suspended: boolean; until?: Date } => {
    // Mirrors ACTIVE_SUSPENSION_PREDICATE_SQL exactly: NULL/past/equal are not
    // suspended; only a strictly future timestamp suspends. An unparseable
    // value fails closed (treated as suspended) rather than granting access.
    if (suspendedUntil === null || suspendedUntil === undefined) return { suspended: false };
    const until = suspendedUntil instanceof Date ? suspendedUntil : new Date(suspendedUntil);
    if (Number.isNaN(until.getTime())) return { suspended: true };
    return until.getTime() > now.getTime() ? { suspended: true, until } : { suspended: false };
};

export async function isUserSuspended(
    userId: string,
    reader: (userId: string) => Promise<SuspensionRow | null> = readSuspensionRow,
): Promise<{ suspended: boolean; until?: Date; reason?: string }> {
    let user: SuspensionRow | null;
    try {
        user = await reader(userId);
    } catch (e) {
        console.error('[Security] Failed to check suspension:', e);
        // Fail closed: an unverifiable suspension state never grants playback.
        return { suspended: true, reason: 'suspension_check_unavailable' };
    }

    if (!user) {
        return { suspended: false };
    }

    const window = evaluateSuspensionWindow(user.suspended_until, new Date());
    if (window.suspended) {
        return { suspended: true, until: window.until, reason: user.suspension_reason || undefined };
    }

    // Suspension expired, clear it
    try {
        await execute(
            'UPDATE users SET suspended_until = NULL, suspension_reason = NULL WHERE id = ?',
            [userId]
        );
    } catch (e) {
        console.error('[Security] Failed to clear expired suspension:', e);
    }
    return { suspended: false };
}

/**
 * Get user's active session ID (for external checks)
 */
export function getUserActiveSessionId(userId: string): string | null {
    return userSessionMap.get(userId) || null;
}
