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
        | 'device_not_permitted';
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
        if (!input || typeof input.tenantId !== 'string' || typeof input.studentEnrollmentId !== 'string' || typeof input.assetId !== 'string') {
            return { accepted: false, position: 0, reason: 'invalid_input' };
        }
        const now = input.now ?? nowFn();
        const nowMs = now.getTime();
        const position = Number(input.positionSeconds);
        if (!Number.isFinite(position) || position < 0) {
            return { accepted: false, position: 0, reason: 'negative_position' };
        }
        const duration = Number(input.durationSeconds ?? 0);
        const deviceId = input.deviceId ?? null;

        const key = keyOf(input.tenantId, input.studentEnrollmentId, input.assetId);

        // device permission
        if (deviceId !== null && !isDevicePermitted(deviceId)) {
            return { accepted: false, position, reason: 'device_not_permitted' };
        }

        // cross-tenant / cross-student forgery guard against an existing record
        // stored under the same enrollment+asset but a different tenant/student.
        for (const [k, rec] of progress) {
            if (rec.studentEnrollmentId === input.studentEnrollmentId && rec.assetId === input.assetId && rec.tenantId !== input.tenantId) {
                return { accepted: false, position, reason: 'tenant_mismatch' };
            }
            if (rec.tenantId === input.tenantId && rec.assetId === input.assetId && rec.studentEnrollmentId !== input.studentEnrollmentId) {
                return { accepted: false, position, reason: 'student_mismatch' };
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
    const position = Number(row.position_seconds);
    return {
        tenantId: row.tenant_id,
        studentEnrollmentId: row.student_enrollment_id,
        assetId: row.asset_id,
        deviceId: row.device_id,
        sessionId: row.session_id,
        positionSeconds: position,
        durationSeconds: Number(row.duration_seconds),
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
            if (!input || typeof input.tenantId !== 'string' || typeof input.studentEnrollmentId !== 'string' || typeof input.assetId !== 'string') {
                return { accepted: false, position: 0, reason: 'invalid_input' };
            }
            const now = input.now ?? nowFn();
            const nowMs = now.getTime();
            const position = Number(input.positionSeconds);
            if (!Number.isFinite(position) || position < 0) {
                return { accepted: false, position: 0, reason: 'negative_position' };
            }
            const deviceId = input.deviceId ?? null;
            if (deviceId !== null && !(await devicePermitted(deviceId))) {
                return { accepted: false, position, reason: 'device_not_permitted' };
            }

            const tenantConflict = await db.queryOne<{ x: number }>(
                `SELECT 1 AS x FROM playback_progress
                 WHERE student_enrollment_id = ? AND asset_id = ? AND tenant_id <> ? LIMIT 1`,
                [input.studentEnrollmentId, input.assetId, input.tenantId],
            );
            if (tenantConflict) return { accepted: false, position, reason: 'tenant_mismatch' };
            const studentConflict = await db.queryOne<{ x: number }>(
                `SELECT 1 AS x FROM playback_progress
                 WHERE tenant_id = ? AND asset_id = ? AND student_enrollment_id <> ? LIMIT 1`,
                [input.tenantId, input.assetId, input.studentEnrollmentId],
            );
            if (studentConflict) return { accepted: false, position, reason: 'student_mismatch' };

            const existing = await loadRow(input.tenantId, input.studentEnrollmentId, input.assetId);
            if (existing) {
                const lastMs = toMs(existing.updated_at);
                if (lastMs !== null && nowMs - lastMs < minProgressInterval) {
                    return { accepted: false, position, reason: 'rate_limited' };
                }
            }
            const existingPosition = existing ? Number(existing.position_seconds) : 0;
            const providedDuration = Number(input.durationSeconds ?? 0);
            const effectiveDuration = providedDuration > 0 ? providedDuration : (existing ? Number(existing.duration_seconds) : 0);
            if (effectiveDuration > 0 && position > effectiveDuration + durationTolerance) {
                return { accepted: false, position, reason: 'exceeds_duration' };
            }
            if (existing && position < existingPosition) {
                return { accepted: false, position: existingPosition, reason: 'not_monotonic' };
            }

            const highWater = Math.max(existingPosition, position);
            const completed = effectiveDuration > 0 && highWater >= effectiveDuration - durationTolerance;
            await db.execute(
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
            await db.execute(
                `UPDATE playback_session_slots SET last_heartbeat_at = NOW() WHERE session_id = ? AND status = 'active'`,
                [input.sessionId],
            );
            return { accepted: true, reason: 'ok' };
        },

        getResumePosition: async (input) => {
            if (!input || typeof input.tenantId !== 'string' || typeof input.studentEnrollmentId !== 'string' || typeof input.assetId !== 'string') {
                return { allowed: false, position: 0, duration: 0, completed: false, deviceId: null, reason: 'asset_mismatch' };
            }
            const row = await loadRow(input.tenantId, input.studentEnrollmentId, input.assetId);
            if (!row) return { allowed: false, position: 0, duration: 0, completed: false, deviceId: null, reason: 'not_found' };
            const record = mapProgressRow(row);
            const deviceId = input.deviceId ?? record.deviceId ?? null;
            if (deviceId !== null && !(await devicePermitted(deviceId))) {
                return { allowed: false, position: record.positionSeconds, duration: record.durationSeconds, completed: record.completed, deviceId, reason: 'device_not_permitted' };
            }
            return { allowed: true, position: record.positionSeconds, duration: record.durationSeconds, completed: record.completed, deviceId, reason: 'ok' };
        },

        getProgress: async (input) => {
            const row = await loadRow(input.tenantId, input.studentEnrollmentId, input.assetId);
            return row ? mapProgressRow(row) : null;
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
