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

// Threshold for auto-suspension
const SUSPENSION_THRESHOLD = parseInt(process.env.VIOLATION_THRESHOLD || '10');
const SUSPENSION_DURATION_MINUTES = parseInt(process.env.SUSPENSION_DURATION || '30');

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
}): Promise<{ sessionId: string; watermarkSeed: string }> {
    const { userId, videoId, ip, userAgent, fingerprint, screenRes, previewOnly = false,
        offerId, studentEnrollmentId, tenantId } = params;

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

    activeSessions.set(sessionId, session);
    userSessionMap.set(userId, sessionId);

    // Persist to DB
    try {
        // Also invalidate sessions created by another process/instance. The
        // generated unique key in the migration is the final race-condition guard.
        await execute(
            `UPDATE video_sessions SET is_active=0,killed_reason='new_session_started',killed_at=NOW()
             WHERE user_id=? AND is_active=1`,
            [userId]
        );
        await execute(
            `INSERT INTO video_sessions 
             (id, user_id, video_id, ip_address, user_agent, fingerprint, screen_resolution, watermark_seed, is_active, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, NOW())`,
            [sessionId, userId, videoId, ip, userAgent, fingerprint, screenRes, watermarkSeed]
        );
    } catch (e) {
        console.error('[Security] Failed to persist session:', e);
    }

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

// Run cleanup every 10 seconds
setInterval(cleanupDeadSessions, 10000);

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
 * Check if user is suspended
 */
export async function isUserSuspended(userId: string): Promise<{ suspended: boolean; until?: Date; reason?: string }> {
    try {
        const user = await queryOne(
            'SELECT suspended_until, suspension_reason FROM users WHERE id = ?',
            [userId]
        );

        if (!user || !user.suspended_until) {
            return { suspended: false };
        }

        const now = new Date();
        const until = new Date(user.suspended_until);

        if (until > now) {
            return { suspended: true, until, reason: user.suspension_reason };
        }

        // Suspension expired, clear it
        await execute(
            'UPDATE users SET suspended_until = NULL, suspension_reason = NULL WHERE id = ?',
            [userId]
        );
        return { suspended: false };
    } catch (e) {
        console.error('[Security] Failed to check suspension:', e);
        return { suspended: false };
    }
}

/**
 * Get user's active session ID (for external checks)
 */
export function getUserActiveSessionId(userId: string): string | null {
    return userSessionMap.get(userId) || null;
}
