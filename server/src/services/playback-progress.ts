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
