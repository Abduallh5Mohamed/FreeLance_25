/**
 * V6 playback progress / resume service.
 *
 * Progress is server-authoritative: a client cannot move the high-water mark
 * backwards, cannot exceed the known duration, and cannot write faster than the
 * heartbeat rate limit. Records are keyed by (tenant, enrollment, asset) so a
 * forged tenant/enrollment id cannot overwrite another student's progress.
 * Resume is only granted for a device that is still permitted.
 *
 * Pure in-memory state; no DB, no network.
 */
export interface ProgressRecord {
    tenantId: string;
    studentEnrollmentId: string;
    assetId: string;
    deviceId: string | null;
    sessionId: string | null;
    positionSeconds: number;
    durationSeconds: number;
    completed: boolean;
    updatedAt: string;
    highWaterMark: number;
}

export interface ProgressWriteResult {
    accepted: boolean;
    position: number;
    reason:
        | 'ok'
        | 'invalid_input'
        | 'not_monotonic'
        | 'exceeds_duration'
        | 'negative_position'
        | 'rate_limited'
        | 'tenant_mismatch'
        | 'student_mismatch'
        | 'device_not_permitted'
        | 'session_not_active';
}

export interface ResumeResult {
    allowed: boolean;
    position: number;
    duration: number;
    completed: boolean;
    deviceId: string | null;
    reason:
        | 'ok'
        | 'not_found'
        | 'tenant_mismatch'
        | 'student_mismatch'
        | 'device_not_permitted'
        | 'asset_mismatch';
}

export interface HeartbeatResult {
    accepted: boolean;
    reason: 'ok' | 'rate_limited' | 'unknown_session';
}

export interface PlaybackProgressDeps {
    idFactory?: () => string;
    now?: () => Date;
    /** Minimum ms between progress writes for the same key. */
    minProgressIntervalMs?: number;
    /** Minimum ms between heartbeats for the same session. */
    minHeartbeatIntervalMs?: number;
    /** Tolerance (seconds) when comparing against duration. */
    durationToleranceSeconds?: number;
    /** Injected device-permission check. */
    isDevicePermitted?: (deviceId: string | null) => boolean;
}

export interface PlaybackProgressService {
    recordProgress(input: {
        tenantId: string;
        studentEnrollmentId: string;
        assetId: string;
        positionSeconds: number;
        durationSeconds?: number;
        deviceId?: string | null;
        sessionId?: string | null;
        now?: Date;
    }): ProgressWriteResult;

    recordHeartbeat(input: { sessionId: string; now?: Date }): HeartbeatResult;

    getResumePosition(input: {
        tenantId: string;
        studentEnrollmentId: string;
        assetId: string;
        deviceId?: string | null;
        now?: Date;
    }): ResumeResult;

    getProgress(input: { tenantId: string; studentEnrollmentId: string; assetId: string }): ProgressRecord | null;

    permitDevice(deviceId: string): void;
    revokeDevice(deviceId: string): void;
    isDevicePermitted(deviceId: string | null): boolean;

    reset(): void;
}

const keyOf = (tenantId: string, enrollmentId: string, assetId: string) =>
    `${tenantId}\u0000${enrollmentId}\u0000${assetId}`;

/**
 * Strict non-negative integer seconds.
 *
 * `Number(x)` accepted `''`, `null`, `[]`, `true`, `' '` and `'12.7'`; the first
 * four coerce to 0/1 and sailed through the finite check, so a malformed
 * position was recorded as a real one. A DB row with a non-numeric
 * `position_seconds` produced `NaN`, and `NaN < x` is false — which silently
 * bypassed the monotonic guard and wrote `NaN` back as `accepted: true`.
 *
 * Anything that is not a non-negative safe integer is refused by the caller as
 * invalid input, never coerced.
 */
function parseSeconds(value: unknown): number | null {
    if (typeof value === 'number') {
        return Number.isSafeInteger(value) && value >= 0 ? value : null;
    }
    if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
        const parsed = Number(value.trim());
        return Number.isSafeInteger(parsed) ? parsed : null;
    }
    return null;
}

/** Ids must be non-empty strings; `''` is not a tenant, enrollment or asset. */
function isUsableId(value: unknown): value is string {
    return typeof value === 'string' && value.trim().length > 0;
}

export function createPlaybackProgressService(deps: PlaybackProgressDeps = {}): PlaybackProgressService {
    const nowFn = deps.now ?? (() => new Date());
    const minProgressInterval = deps.minProgressIntervalMs ?? 2000;
    const minHeartbeatInterval = deps.minHeartbeatIntervalMs ?? 2000;
    const durationTolerance = deps.durationToleranceSeconds ?? 5;

    const progress = new Map<string, ProgressRecord>();
    const lastProgressAt = new Map<string, number>();
    const lastHeartbeatAt = new Map<string, number>();
    const permittedDevices = new Set<string>();
    const revokedDevices = new Set<string>();

    const isDevicePermitted = (deviceId: string | null): boolean => {
        if (deviceId === null) return deps.isDevicePermitted ? deps.isDevicePermitted(deviceId) : true;
        if (deps.isDevicePermitted) return deps.isDevicePermitted(deviceId);
        if (revokedDevices.has(deviceId)) return false;
        // Unknown devices are permitted until explicitly revoked; explicitly
        // permitted devices stay permitted.
        return true;
    };

    const permitDevice = (deviceId: string) => { permittedDevices.add(deviceId); revokedDevices.delete(deviceId); };
    const revokeDevice = (deviceId: string) => { permittedDevices.delete(deviceId); revokedDevices.add(deviceId); };

    const recordProgress = (input: {
        tenantId: string;
        studentEnrollmentId: string;
        assetId: string;
        positionSeconds: number;
        durationSeconds?: number;
        deviceId?: string | null;
        sessionId?: string | null;
        now?: Date;
    }): ProgressWriteResult => {
        if (!input || !isUsableId(input.tenantId) || !isUsableId(input.studentEnrollmentId) || !isUsableId(input.assetId)) {
            return { accepted: false, position: 0, reason: 'invalid_input' };
        }
        const now = input.now ?? nowFn();
        const nowMs = now.getTime();
        const position = parseSeconds(input.positionSeconds);
        if (position === null) {
            return { accepted: false, position: 0, reason: 'negative_position' };
        }
        const duration = parseSeconds(input.durationSeconds) ?? 0;
        const deviceId = input.deviceId ?? null;

        const key = keyOf(input.tenantId, input.studentEnrollmentId, input.assetId);

        // device permission
        if (deviceId !== null && !isDevicePermitted(deviceId)) {
            return { accepted: false, position, reason: 'device_not_permitted' };
        }

        // Cross-tenant forgery guard: the same enrollment+asset recorded under a
        // DIFFERENT tenant is a forgery attempt. The mirror check — same tenant,
        // different enrollment — is deliberately absent: two students in one
        // tenant watching one asset is a normal case, and records are keyed by
        // (tenant, enrollment, asset), so it is a different record, not a
        // conflict. Rejecting it permanently blocked the second student for as
        // long as the first student's row existed.
        for (const [, rec] of progress) {
            if (rec.studentEnrollmentId === input.studentEnrollmentId && rec.assetId === input.assetId && rec.tenantId !== input.tenantId) {
                return { accepted: false, position, reason: 'tenant_mismatch' };
            }
        }

        const lastAt = lastProgressAt.get(key);
        if (lastAt !== undefined && nowMs - lastAt < minProgressInterval) {
            return { accepted: false, position, reason: 'rate_limited' };
        }

        const existing = progress.get(key);
        const effectiveDuration = duration > 0 ? duration : (existing?.durationSeconds ?? 0);
        if (effectiveDuration > 0 && position > effectiveDuration + durationTolerance) {
            return { accepted: false, position, reason: 'exceeds_duration' };
        }

        if (existing && position < existing.highWaterMark) {
            return { accepted: false, position: existing.highWaterMark, reason: 'not_monotonic' };
        }

        const highWater = existing ? Math.max(existing.highWaterMark, position) : position;
        const record: ProgressRecord = {
            tenantId: input.tenantId,
            studentEnrollmentId: input.studentEnrollmentId,
            assetId: input.assetId,
            deviceId,
            sessionId: input.sessionId ?? null,
            positionSeconds: highWater,
            durationSeconds: effectiveDuration,
            completed: effectiveDuration > 0 && highWater >= effectiveDuration - durationTolerance,
            updatedAt: now.toISOString(),
            highWaterMark: highWater,
        };
        progress.set(key, record);
        lastProgressAt.set(key, nowMs);

        return { accepted: true, position: highWater, reason: 'ok' };
    };

    const recordHeartbeat = (input: { sessionId: string; now?: Date }): HeartbeatResult => {
        if (!input || typeof input.sessionId !== 'string') return { accepted: false, reason: 'unknown_session' };
        const now = input.now ?? nowFn();
        const nowMs = now.getTime();
        const last = lastHeartbeatAt.get(input.sessionId);
        if (last !== undefined && nowMs - last < minHeartbeatInterval) {
            return { accepted: false, reason: 'rate_limited' };
        }
        lastHeartbeatAt.set(input.sessionId, nowMs);
        return { accepted: true, reason: 'ok' };
    };

    const getResumePosition = (input: {
        tenantId: string;
        studentEnrollmentId: string;
        assetId: string;
        deviceId?: string | null;
        now?: Date;
    }): ResumeResult => {
        if (!input || typeof input.tenantId !== 'string' || typeof input.studentEnrollmentId !== 'string' || typeof input.assetId !== 'string') {
            return { allowed: false, position: 0, duration: 0, completed: false, deviceId: null, reason: 'asset_mismatch' };
        }
        const key = keyOf(input.tenantId, input.studentEnrollmentId, input.assetId);
        const rec = progress.get(key);
        if (!rec) {
            return { allowed: false, position: 0, duration: 0, completed: false, deviceId: null, reason: 'not_found' };
        }
        if (rec.tenantId !== input.tenantId) {
            return { allowed: false, position: 0, duration: 0, completed: false, deviceId: null, reason: 'tenant_mismatch' };
        }
        if (rec.studentEnrollmentId !== input.studentEnrollmentId) {
            return { allowed: false, position: 0, duration: 0, completed: false, deviceId: null, reason: 'student_mismatch' };
        }
        if (rec.assetId !== input.assetId) {
            return { allowed: false, position: 0, duration: 0, completed: false, deviceId: null, reason: 'asset_mismatch' };
        }
        const deviceId = input.deviceId ?? rec.deviceId ?? null;
        if (deviceId !== null && !isDevicePermitted(deviceId)) {
            return { allowed: false, position: rec.positionSeconds, duration: rec.durationSeconds, completed: rec.completed, deviceId, reason: 'device_not_permitted' };
        }
        return {
            allowed: true,
            position: rec.positionSeconds,
            duration: rec.durationSeconds,
            completed: rec.completed,
            deviceId,
            reason: 'ok',
        };
    };

    const getProgress = (input: { tenantId: string; studentEnrollmentId: string; assetId: string }): ProgressRecord | null => {
        return progress.get(keyOf(input.tenantId, input.studentEnrollmentId, input.assetId)) ?? null;
    };

    const reset = () => {
        progress.clear();
        lastProgressAt.clear();
        lastHeartbeatAt.clear();
        permittedDevices.clear();
        revokedDevices.clear();
    };

    return {
        recordProgress,
        recordHeartbeat,
        getResumePosition,
        getProgress,
        permitDevice,
        revokeDevice,
        isDevicePermitted,
        reset,
    };
}

export const createProgressService = createPlaybackProgressService;
export const createPlaybackProgress = createPlaybackProgressService;

/* =========================================================================
 * Async store boundary (injected into the route) + SQL adapter
 * ========================================================================= */

import type { PlaybackStoreDb } from './playback-session-registry';

export interface PlaybackProgressStore {
    recordProgress(input: {
        tenantId: string;
        studentEnrollmentId: string;
        assetId: string;
        positionSeconds: number;
        durationSeconds?: number;
        deviceId?: string | null;
        sessionId?: string | null;
        now?: Date;
    }): Promise<ProgressWriteResult>;
    recordHeartbeat(input: { sessionId: string; now?: Date }): Promise<HeartbeatResult>;
    getResumePosition(input: {
        tenantId: string;
        studentEnrollmentId: string;
        assetId: string;
        deviceId?: string | null;
        now?: Date;
    }): Promise<ResumeResult>;
    getProgress(input: { tenantId: string; studentEnrollmentId: string; assetId: string }): Promise<ProgressRecord | null>;
    permitDevice(deviceId: string): Promise<void>;
    revokeDevice(deviceId: string): Promise<void>;
    isDevicePermitted(deviceId: string | null): Promise<boolean>;
    reset(): Promise<void>;
}

/** Adapt the synchronous in-memory progress service to the async store port. */
export function asPlaybackProgressStore(progress: PlaybackProgressService): PlaybackProgressStore {
    return {
        recordProgress: async (input) => progress.recordProgress(input),
        recordHeartbeat: async (input) => progress.recordHeartbeat(input),
        getResumePosition: async (input) => progress.getResumePosition(input),
        getProgress: async (input) => progress.getProgress(input),
        permitDevice: async (deviceId) => progress.permitDevice(deviceId),
        revokeDevice: async (deviceId) => progress.revokeDevice(deviceId),
        isDevicePermitted: async (deviceId) => progress.isDevicePermitted(deviceId),
        reset: async () => progress.reset(),
    };
}

export interface SqlPlaybackProgressDeps {
    idFactory?: () => string;
    now?: () => Date;
    minProgressIntervalMs?: number;
    minHeartbeatIntervalMs?: number;
    durationToleranceSeconds?: number;
    /** Server-side device-permission check; defaults to the device registry table. */
    isDevicePermitted?: (deviceId: string) => boolean | Promise<boolean>;
}

interface ProgressRow {
    id: string;
    tenant_id: string;
    student_enrollment_id: string;
    asset_id: string;
    device_id: string | null;
    session_id: string | null;
    position_seconds: number | string;
    duration_seconds: number | string;
    completed: number | boolean;
    updated_at: unknown;
}

const PROGRESS_COLUMNS = 'id, tenant_id, student_enrollment_id, asset_id, device_id, session_id, position_seconds, duration_seconds, completed, updated_at';

function mapProgressRow(row: ProgressRow): ProgressRecord {
    // Strict parse on the read path too: a row this module cannot read must not
    // become a `NaN`/`0` record that later bypasses the monotonic guard. The
    // caller drops unreadable rows rather than serving them.
    const position = parseSeconds(row.position_seconds);
    const duration = parseSeconds(row.duration_seconds);
    if (position === null || duration === null) {
        throw new Error('A stored playback progress row could not be read');
    }
    return {
        tenantId: row.tenant_id,
        studentEnrollmentId: row.student_enrollment_id,
        assetId: row.asset_id,
        deviceId: row.device_id,
        sessionId: row.session_id,
        positionSeconds: position,
        durationSeconds: duration,
        completed: Boolean(row.completed),
        updatedAt: toIsoTime(row.updated_at),
        highWaterMark: position,
    };
}

function toIsoTime(value: unknown): string {
    if (value instanceof Date) return value.toISOString();
    if (typeof value === 'string' && value) {
        const date = new Date(/[TZ]/.test(value) ? value : `${value.replace(' ', 'T')}Z`);
        if (Number.isFinite(date.getTime())) return date.toISOString();
    }
    return new Date(0).toISOString();
}

function toMs(value: unknown): number | null {
    if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
    if (typeof value === 'string' && value) {
        const date = new Date(/[TZ]/.test(value) ? value : `${value.replace(' ', 'T')}Z`);
        return Number.isFinite(date.getTime()) ? date.getTime() : null;
    }
    return null;
}

export function createSqlPlaybackProgressService(db: PlaybackStoreDb, deps: SqlPlaybackProgressDeps = {}): PlaybackProgressStore {
    const idFactory = deps.idFactory ?? (() => `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);
    const nowFn = deps.now ?? (() => new Date());
    const minProgressInterval = deps.minProgressIntervalMs ?? 2000;
    const minHeartbeatInterval = deps.minHeartbeatIntervalMs ?? 2000;
    const durationTolerance = deps.durationToleranceSeconds ?? 5;

    const devicePermitted = async (deviceId: string | null): Promise<boolean> => {
        if (deviceId === null) return true;
        if (deps.isDevicePermitted) return deps.isDevicePermitted(deviceId);
        const row = await db.queryOne<{ status: string }>(
            'SELECT status FROM playback_devices WHERE id = ? LIMIT 1',
            [deviceId],
        );
        // Unknown devices stay permitted until explicitly revoked; a revoked
        // device is denied from the server-side registry row.
        return row ? row.status === 'active' : true;
    };

    const loadRow = (tenantId: string, enrollmentId: string, assetId: string): Promise<ProgressRow | null> =>
        db.queryOne<ProgressRow>(
            `SELECT ${PROGRESS_COLUMNS} FROM playback_progress
             WHERE tenant_id = ? AND student_enrollment_id = ? AND asset_id = ? LIMIT 1`,
            [tenantId, enrollmentId, assetId],
        );

    return {
        recordProgress: async (input) => {
            if (!input || !isUsableId(input.tenantId) || !isUsableId(input.studentEnrollmentId) || !isUsableId(input.assetId)) {
                return { accepted: false, position: 0, reason: 'invalid_input' };
            }
            const now = input.now ?? nowFn();
            const nowMs = now.getTime();
            const position = parseSeconds(input.positionSeconds);
            if (position === null) {
                return { accepted: false, position: 0, reason: 'negative_position' };
            }
            const deviceId = input.deviceId ?? null;
            if (deviceId !== null && !(await devicePermitted(deviceId))) {
                return { accepted: false, position, reason: 'device_not_permitted' };
            }

            // A stopped or revoked session must not be able to write progress.
            // Without this the write was accepted after the session ended and the
            // row's `session_id` was refreshed with a dead session — the same
            // guard `recordHeartbeat` already applies.
            if (input.sessionId) {
                const session = await db.queryOne<{ status: string }>(
                    'SELECT status FROM playback_session_slots WHERE session_id = ? LIMIT 1',
                    [input.sessionId],
                );
                if (!session || session.status !== 'active') {
                    return { accepted: false, position, reason: 'session_not_active' };
                }
            }

            const tenantConflict = await db.queryOne<{ x: number }>(
                `SELECT 1 AS x FROM playback_progress
                 WHERE student_enrollment_id = ? AND asset_id = ? AND tenant_id <> ? LIMIT 1`,
                [input.studentEnrollmentId, input.assetId, input.tenantId],
            );
            if (tenantConflict) return { accepted: false, position, reason: 'tenant_mismatch' };
            // No same-tenant/different-enrollment check: see the in-memory path.
            // Two students in one tenant on one asset are two records, not a
            // conflict, and the old check permanently blocked the second one.

            const existing = await loadRow(input.tenantId, input.studentEnrollmentId, input.assetId);
            if (existing) {
                const lastMs = toMs(existing.updated_at);
                if (lastMs !== null && nowMs - lastMs < minProgressInterval) {
                    return { accepted: false, position, reason: 'rate_limited' };
                }
            }
            const existingPosition = existing ? parseSeconds(existing.position_seconds) : null;
            if (existing && existingPosition === null) {
                // A stored position this module cannot read is a data fault, not
                // a zero: treating it as zero would let any write regress the
                // high-water mark.
                return { accepted: false, position, reason: 'invalid_input' };
            }
            const storedPosition = existingPosition ?? 0;
            const providedDuration = parseSeconds(input.durationSeconds) ?? 0;
            const existingDuration = existing ? parseSeconds(existing.duration_seconds) : null;
            if (existing && existingDuration === null) {
                return { accepted: false, position, reason: 'invalid_input' };
            }
            const effectiveDuration = providedDuration > 0 ? providedDuration : (existingDuration ?? 0);
            if (effectiveDuration > 0 && position > effectiveDuration + durationTolerance) {
                return { accepted: false, position, reason: 'exceeds_duration' };
            }
            if (existing && position < storedPosition) {
                return { accepted: false, position: storedPosition, reason: 'not_monotonic' };
            }

            const highWater = Math.max(storedPosition, position);
            const completed = effectiveDuration > 0 && highWater >= effectiveDuration - durationTolerance;
            const written = await db.execute(
                `INSERT INTO playback_progress
                   (id, tenant_id, student_enrollment_id, asset_id, device_id, session_id, position_seconds, duration_seconds, completed, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
                 ON DUPLICATE KEY UPDATE
                   position_seconds = GREATEST(position_seconds, VALUES(position_seconds)),
                   duration_seconds = GREATEST(duration_seconds, VALUES(duration_seconds)),
                   device_id = COALESCE(VALUES(device_id), device_id),
                   session_id = COALESCE(VALUES(session_id), session_id),
                   completed = GREATEST(completed, VALUES(completed)),
                   updated_at = NOW()`,
                [
                    idFactory(),
                    input.tenantId,
                    input.studentEnrollmentId,
                    input.assetId,
                    deviceId,
                    input.sessionId ?? null,
                    position,
                    effectiveDuration,
                    completed ? 1 : 0,
                ],
            );
            // The write's own count is the only evidence the row changed.
            // Discarding it made a silently failed persist indistinguishable
            // from success, and `undefined` is neither 0 nor 1 — it throws.
            const affected = written?.affectedRows;
            if (typeof affected !== 'number' || !Number.isSafeInteger(affected) || affected < 1 || affected > 2) {
                return { accepted: false, position: highWater, reason: 'invalid_input' };
            }
            return { accepted: true, position: highWater, reason: 'ok' };
        },

        recordHeartbeat: async (input) => {
            if (!input || typeof input.sessionId !== 'string' || !input.sessionId) return { accepted: false, reason: 'unknown_session' };
            const row = await db.queryOne<{ status: string; last_heartbeat_at: unknown }>(
                'SELECT status, last_heartbeat_at FROM playback_session_slots WHERE session_id = ? LIMIT 1',
                [input.sessionId],
            );
            if (!row || row.status !== 'active') return { accepted: false, reason: 'unknown_session' };
            const now = input.now ?? nowFn();
            const lastMs = toMs(row.last_heartbeat_at);
            if (lastMs !== null && now.getTime() - lastMs < minHeartbeatInterval) {
                return { accepted: false, reason: 'rate_limited' };
            }
            // The UPDATE is a refresh, not a decision, and its count is NOT
            // read: under MySQL's changed-rows semantics `SET last_heartbeat_at
            // = NOW()` reports 0 when the value it writes equals the stored
            // one, so a 0 here cannot be told apart from "no active row" and
            // must not be turned into a refusal. Liveness is decided by the
            // `status = 'active'` read above; the `AND status = 'active'`
            // predicate keeps the write from reviving a session that was ended
            // in between, and the next heartbeat re-reads.
            await db.execute(
                `UPDATE playback_session_slots SET last_heartbeat_at = NOW() WHERE session_id = ? AND status = 'active'`,
                [input.sessionId],
            );
            return { accepted: true, reason: 'ok' };
        },

        getResumePosition: async (input) => {
            if (!input || !isUsableId(input.tenantId) || !isUsableId(input.studentEnrollmentId) || !isUsableId(input.assetId)) {
                return { allowed: false, position: 0, duration: 0, completed: false, deviceId: null, reason: 'asset_mismatch' };
            }
            const row = await loadRow(input.tenantId, input.studentEnrollmentId, input.assetId);
            if (!row) return { allowed: false, position: 0, duration: 0, completed: false, deviceId: null, reason: 'not_found' };
            let record: ProgressRecord;
            try {
                record = mapProgressRow(row);
            } catch {
                // An unreadable row denies the resume rather than serving a
                // coerced position, which would resume the viewer somewhere the
                // server never recorded.
                return { allowed: false, position: 0, duration: 0, completed: false, deviceId: null, reason: 'not_found' };
            }
            const deviceId = input.deviceId ?? record.deviceId ?? null;
            if (deviceId !== null && !(await devicePermitted(deviceId))) {
                return { allowed: false, position: record.positionSeconds, duration: record.durationSeconds, completed: record.completed, deviceId, reason: 'device_not_permitted' };
            }
            return { allowed: true, position: record.positionSeconds, duration: record.durationSeconds, completed: record.completed, deviceId, reason: 'ok' };
        },

        getProgress: async (input) => {
            const row = await loadRow(input.tenantId, input.studentEnrollmentId, input.assetId);
            if (!row) return null;
            try {
                return mapProgressRow(row);
            } catch {
                return null;
            }
        },

        permitDevice: async (deviceId) => {
            await db.execute(
                `UPDATE playback_devices SET status = 'active', revoked_at = NULL, revoked_by = NULL, revoke_reason = NULL
                 WHERE id = ?`,
                [deviceId],
            );
        },

        revokeDevice: async (deviceId) => {
            await db.execute(
                `UPDATE playback_devices SET status = 'revoked', revoked_at = NOW()
                 WHERE id = ? AND status = 'active'`,
                [deviceId],
            );
        },

        isDevicePermitted: (deviceId) => devicePermitted(deviceId),

        reset: async () => undefined,
    };
}
