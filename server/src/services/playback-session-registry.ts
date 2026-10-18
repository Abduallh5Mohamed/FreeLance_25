/**
 * V5 device registry + concurrent-session slot manager.
 *
 * Configurable per-tenant policy (max concurrent sessions, max devices).
 * Slot acquisition is atomic within the JS event loop: the limit check and
 * the slot insert happen in one synchronous critical section, so two
 * concurrent starts can never oversubscribe. Warning / self-revoke /
 * support-revoke paths are audited through the injected audit sink.
 *
 * Pure in-memory state; no DB, no network. A DB-backed adapter can mirror
 * the same interface.
 */
export interface PlaybackPolicy {
    tenantId: string | null;
    maxConcurrentSessions: number;
    maxDevices: number;
    warningThreshold: number;
    selfRevokeAllowed: boolean;
    supportRevokeAllowed: boolean;
}

export const DEFAULT_PLAYBACK_POLICY: Omit<PlaybackPolicy, 'tenantId'> = {
    maxConcurrentSessions: 2,
    maxDevices: 3,
    warningThreshold: 1,
    selfRevokeAllowed: true,
    supportRevokeAllowed: true,
};

/**
 * Hard server-side ceilings. Every policy source — a tenant row, an injected
 * provider, and (critically) any caller-supplied object — is clamped to these
 * values, so no principal can raise its own anti-sharing limits above what the
 * server permits. The ceilings are the single authority for policy magnitude.
 */
export const PLAYBACK_POLICY_CEILINGS = {
    maxConcurrentSessions: 10,
    maxDevices: 10,
} as const;

function clampPositiveInt(value: number, fallback: number, ceiling: number): number {
    if (!Number.isFinite(value) || value <= 0) return fallback;
    return Math.min(Math.trunc(value), ceiling);
}

export function normalizePlaybackPolicy(input: unknown, tenantId: string | null = null): PlaybackPolicy {
    const raw = (input && typeof input === 'object') ? (input as Record<string, unknown>) : {};
    const maxConcurrent = Number(raw.maxConcurrentSessions ?? raw.max_concurrent_sessions ?? DEFAULT_PLAYBACK_POLICY.maxConcurrentSessions);
    const maxDevices = Number(raw.maxDevices ?? raw.max_devices ?? DEFAULT_PLAYBACK_POLICY.maxDevices);
    const warning = Number(raw.warningThreshold ?? raw.warning_threshold ?? Math.max(0, maxConcurrent - 1));
    const maxConcurrentSessions = clampPositiveInt(maxConcurrent, DEFAULT_PLAYBACK_POLICY.maxConcurrentSessions, PLAYBACK_POLICY_CEILINGS.maxConcurrentSessions);
    const normalized = {
        tenantId,
        maxConcurrentSessions,
        maxDevices: clampPositiveInt(maxDevices, DEFAULT_PLAYBACK_POLICY.maxDevices, PLAYBACK_POLICY_CEILINGS.maxDevices),
        warningThreshold: Number.isFinite(warning) && warning >= 0 ? Math.min(Math.trunc(warning), maxConcurrentSessions) : 0,
        selfRevokeAllowed: raw.selfRevokeAllowed !== false && raw.self_revoke_allowed !== false,
        supportRevokeAllowed: raw.supportRevokeAllowed !== false && raw.support_revoke_allowed !== false,
    };
    return normalized;
}

/**
 * Thrown when registering a device would exceed the tenant's `maxDevices`
 * ceiling. Registration is deny-by-default: the server rejects the new device
 * rather than silently growing the device table without bound.
 */
export class PlaybackDeviceLimitError extends Error {
    readonly limit: number;

    constructor(limit: number) {
        super('device_limit');
        this.name = 'PlaybackDeviceLimitError';
        this.limit = limit;
    }
}

export interface PlaybackDevice {
    id: string;
    tenantId: string;
    userId: string;
    fingerprint: string;
    label: string | null;
    status: 'active' | 'revoked';
    firstSeenAt: string;
    lastSeenAt: string;
    revokedAt: string | null;
    revokedBy: string | null;
    revokeReason: string | null;
}

export interface PlaybackSlot {
    id: string;
    tenantId: string;
    userId: string;
    deviceId: string;
    sessionId: string;
    status: 'active' | 'ended' | 'revoked';
    startedAt: string;
    lastHeartbeatAt: string;
    endedAt: string | null;
    endedReason: string | null;
}

export interface SlotAcquisitionResult {
    acquired: boolean;
    slot: PlaybackSlot | null;
    reason: 'ok' | 'device_not_found' | 'device_revoked' | 'device_limit' | 'concurrency_limit' | 'duplicate_session';
    warning: boolean;
    activeSlots: number;
}

export interface RevokeResult {
    revoked: boolean;
    reason: string;
}

export interface PlaybackSessionRegistryDeps {
    idFactory?: () => string;
    now?: () => Date;
    audit?: (event: Record<string, unknown>) => void | Promise<void>;
    policyProvider?: (tenantId: string) => PlaybackPolicy | null | undefined;
}

export interface PlaybackSessionRegistry {
    getPolicy(tenantId: string): PlaybackPolicy;
    setPolicy(policy: PlaybackPolicy | Record<string, unknown>, tenantId?: string): PlaybackPolicy;
    registerDevice(input: { tenantId: string; userId: string; fingerprint: string; label?: string | null; now?: Date }): PlaybackDevice;
    getDevice(deviceId: string): PlaybackDevice | null;
    listDevices(tenantId: string, userId?: string): PlaybackDevice[];
    revokeDevice(input: { deviceId: string; actorId: string; reason?: string; support?: boolean }): RevokeResult;
    acquireSlot(input: { tenantId: string; userId: string; deviceId: string; sessionId: string; policy?: PlaybackPolicy | Record<string, unknown> }): Promise<SlotAcquisitionResult>;
    releaseSlot(sessionId: string, reason?: string): boolean;
    revokeSession(input: { sessionId: string; actorId: string; actorType?: string; reason?: string; support?: boolean }): Promise<RevokeResult>;
    listSessions(tenantId: string, userId?: string, status?: string): PlaybackSlot[];
    activeSlotCount(tenantId: string, userId: string): number;
    isSessionActive(sessionId: string): boolean;
    getSession(sessionId: string): PlaybackSlot | null;
}

export function createPlaybackSessionRegistry(deps: PlaybackSessionRegistryDeps = {}): PlaybackSessionRegistry {
    const idFactory = deps.idFactory ?? (() => `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);
    const nowFn = deps.now ?? (() => new Date());
    const audit = deps.audit ?? (() => undefined);

    const policies = new Map<string, PlaybackPolicy>();
    const devices = new Map<string, PlaybackDevice>();
    const deviceIndex = new Map<string, string>(); // tenant:user:fingerprint -> deviceId
    const slots = new Map<string, PlaybackSlot>(); // sessionId -> slot
    const slotsByUser = new Map<string, Set<string>>(); // tenant:user -> sessionIds

    const nowIso = (d?: Date) => (d ?? nowFn()).toISOString();

    const userKey = (tenantId: string, userId: string) => `${tenantId}\u0000${userId}`;

    const getPolicy = (tenantId: string): PlaybackPolicy => {
        if (deps.policyProvider) {
            const provided = deps.policyProvider(tenantId);
            if (provided) {
                const normalized = normalizePlaybackPolicy(provided, tenantId);
                policies.set(tenantId, normalized);
                return normalized;
            }
        }
        const existing = policies.get(tenantId);
        if (existing) return existing;
        const fallback = normalizePlaybackPolicy({}, tenantId);
        policies.set(tenantId, fallback);
        return fallback;
    };

    const setPolicy = (policy: PlaybackPolicy | Record<string, unknown>, tenantId?: string): PlaybackPolicy => {
        const tid = tenantId ?? String((policy as Record<string, unknown>).tenantId ?? '');
        const normalized = normalizePlaybackPolicy(policy, tid || null);
        if (tid) policies.set(tid, normalized);
        return normalized;
    };

    const registerDevice = (input: { tenantId: string; userId: string; fingerprint: string; label?: string | null; now?: Date }): PlaybackDevice => {
        const key = `${input.tenantId}\u0000${input.userId}\u0000${input.fingerprint}`;
        const existingId = deviceIndex.get(key);
        if (existingId) {
            const existing = devices.get(existingId);
            if (existing && existing.status !== 'revoked') {
                existing.lastSeenAt = nowIso(input.now);
                return existing;
            }
            if (existing) existing.lastSeenAt = nowIso(input.now);
        }
        // deny-by-default: never grow past the tenant's device ceiling
        const policy = getPolicy(input.tenantId);
        const userDevices = [...devices.values()].filter((d) => d.tenantId === input.tenantId && d.userId === input.userId && d.status === 'active');
        if (userDevices.length >= policy.maxDevices) {
            throw new PlaybackDeviceLimitError(policy.maxDevices);
        }
        const id = idFactory();
        const device: PlaybackDevice = {
            id,
            tenantId: input.tenantId,
            userId: input.userId,
            fingerprint: input.fingerprint,
            label: input.label ?? null,
            status: 'active',
            firstSeenAt: nowIso(input.now),
            lastSeenAt: nowIso(input.now),
            revokedAt: null,
            revokedBy: null,
            revokeReason: null,
        };
        devices.set(id, device);
        deviceIndex.set(key, id);
        return device;
    };

    const getDevice = (deviceId: string): PlaybackDevice | null => devices.get(deviceId) ?? null;

    const listDevices = (tenantId: string, userId?: string): PlaybackDevice[] =>
        [...devices.values()].filter((d) => d.tenantId === tenantId && (userId === undefined || d.userId === userId));

    const revokeDevice = (input: { deviceId: string; actorId: string; reason?: string; support?: boolean }): RevokeResult => {
        const device = devices.get(input.deviceId);
        if (!device) return { revoked: false, reason: 'device_not_found' };
        if (device.status === 'revoked') return { revoked: true, reason: 'already_revoked' };
        if (!input.support && input.actorId !== device.userId) return { revoked: false, reason: 'not_owner' };
        const policy = getPolicy(device.tenantId);
        if (input.support && !policy.supportRevokeAllowed) return { revoked: false, reason: 'support_revoke_not_allowed' };
        if (!input.support && !policy.selfRevokeAllowed) return { revoked: false, reason: 'self_revoke_not_allowed' };
        device.status = 'revoked';
        device.revokedAt = nowIso();
        device.revokedBy = input.actorId;
        device.revokeReason = input.reason ?? (input.support ? 'support_revoke' : 'self_revoke');
        // end active slots on this device
        for (const slot of slots.values()) {
            if (slot.deviceId === device.id && slot.status === 'active') {
                slot.status = 'revoked';
                slot.endedAt = nowIso();
                slot.endedReason = device.revokeReason;
            }
        }
        audit({ action: input.support ? 'playback.device.support_revoke' : 'playback.device.self_revoke', deviceId: device.id, tenantId: device.tenantId, userId: device.userId, actorId: input.actorId, reason: device.revokeReason });
        return { revoked: true, reason: 'ok' };
    };

    const activeSlotCount = (tenantId: string, userId: string): number => {
        const set = slotsByUser.get(userKey(tenantId, userId));
        if (!set) return 0;
        let count = 0;
        for (const sid of set) {
            const slot = slots.get(sid);
            if (slot && slot.status === 'active') count += 1;
        }
        return count;
    };

    const acquireSlot = async (input: { tenantId: string; userId: string; deviceId: string; sessionId: string; policy?: PlaybackPolicy | Record<string, unknown> }): Promise<SlotAcquisitionResult> => {
        // Synchronous critical section starts here.
        const device = devices.get(input.deviceId);
        if (!device) return { acquired: false, slot: null, reason: 'device_not_found', warning: false, activeSlots: 0 };
        if (device.tenantId !== input.tenantId || device.userId !== input.userId) return { acquired: false, slot: null, reason: 'device_not_found', warning: false, activeSlots: activeSlotCount(input.tenantId, input.userId) };
        if (device.status !== 'active') return { acquired: false, slot: null, reason: 'device_revoked', warning: false, activeSlots: activeSlotCount(input.tenantId, input.userId) };
        if (slots.has(input.sessionId)) return { acquired: false, slot: slots.get(input.sessionId) ?? null, reason: 'duplicate_session', warning: false, activeSlots: activeSlotCount(input.tenantId, input.userId) };

        const policy = input.policy ? normalizePlaybackPolicy(input.policy, input.tenantId) : getPolicy(input.tenantId);
        // device limit check
        const userDevices = [...devices.values()].filter((d) => d.tenantId === input.tenantId && d.userId === input.userId && d.status === 'active');
        if (userDevices.length > policy.maxDevices) {
            return { acquired: false, slot: null, reason: 'device_limit', warning: false, activeSlots: activeSlotCount(input.tenantId, input.userId) };
        }

        const current = activeSlotCount(input.tenantId, input.userId);
        if (current >= policy.maxConcurrentSessions) {
            return { acquired: false, slot: null, reason: 'concurrency_limit', warning: false, activeSlots: current };
        }

        const slot: PlaybackSlot = {
            id: idFactory(),
            tenantId: input.tenantId,
            userId: input.userId,
            deviceId: input.deviceId,
            sessionId: input.sessionId,
            status: 'active',
            startedAt: nowIso(),
            lastHeartbeatAt: nowIso(),
            endedAt: null,
            endedReason: null,
        };
        slots.set(input.sessionId, slot);
        const set = slotsByUser.get(userKey(input.tenantId, input.userId)) ?? new Set<string>();
        set.add(input.sessionId);
        slotsByUser.set(userKey(input.tenantId, input.userId), set);

        const activeSlots = current + 1;
        const warning = activeSlots > policy.warningThreshold && activeSlots <= policy.maxConcurrentSessions;
        if (warning) {
            audit({ action: 'playback.session.warning', tenantId: input.tenantId, userId: input.userId, sessionId: input.sessionId, activeSlots, limit: policy.maxConcurrentSessions });
        }
        audit({ action: 'playback.session.started', tenantId: input.tenantId, userId: input.userId, deviceId: input.deviceId, sessionId: input.sessionId, activeSlots, limit: policy.maxConcurrentSessions });
        return { acquired: true, slot, reason: 'ok', warning, activeSlots };
    };

    const releaseSlot = (sessionId: string, reason = 'released'): boolean => {
        const slot = slots.get(sessionId);
        if (!slot || slot.status !== 'active') return false;
        slot.status = 'ended';
        slot.endedAt = nowIso();
        slot.endedReason = reason;
        const set = slotsByUser.get(userKey(slot.tenantId, slot.userId));
        if (set) set.delete(sessionId);
        audit({ action: 'playback.session.released', tenantId: slot.tenantId, userId: slot.userId, sessionId, reason });
        return true;
    };

    const revokeSession = async (input: { sessionId: string; actorId: string; actorType?: string; reason?: string; support?: boolean }): Promise<RevokeResult> => {
        const slot = slots.get(input.sessionId);
        if (!slot) return { revoked: false, reason: 'session_not_found' };
        const policy = getPolicy(slot.tenantId);
        const isOwner = slot.userId === input.actorId;
        const isSupport = input.support === true || input.actorType === 'support';
        if (!isOwner && !isSupport) return { revoked: false, reason: 'not_authorized' };
        if (isOwner && !isSupport && !policy.selfRevokeAllowed) return { revoked: false, reason: 'self_revoke_not_allowed' };
        if (isSupport && !policy.supportRevokeAllowed) return { revoked: false, reason: 'support_revoke_not_allowed' };
        if (slot.status !== 'active') return { revoked: false, reason: 'already_ended' };
        slot.status = 'revoked';
        slot.endedAt = nowIso();
        slot.endedReason = input.reason ?? (isOwner && !isSupport ? 'self_revoke' : 'support_revoke');
        const set = slotsByUser.get(userKey(slot.tenantId, slot.userId));
        if (set) set.delete(input.sessionId);
        audit({
            action: isOwner && !isSupport ? 'playback.session.self_revoke' : 'playback.session.support_revoke',
            tenantId: slot.tenantId,
            userId: slot.userId,
            sessionId: input.sessionId,
            actorId: input.actorId,
            actorType: isOwner && !isSupport ? 'self' : 'support',
            reason: slot.endedReason,
        });
        return { revoked: true, reason: 'ok' };
    };

    const listSessions = (tenantId: string, userId?: string, status?: string): PlaybackSlot[] =>
        [...slots.values()].filter((s) => s.tenantId === tenantId && (userId === undefined || s.userId === userId) && (status === undefined || s.status === status));

    const isSessionActive = (sessionId: string): boolean => {
        const slot = slots.get(sessionId);
        return Boolean(slot && slot.status === 'active');
    };

    const getSession = (sessionId: string): PlaybackSlot | null => slots.get(sessionId) ?? null;

    return {
        getPolicy,
        setPolicy,
        registerDevice,
        getDevice,
        listDevices,
        revokeDevice,
        acquireSlot,
        releaseSlot,
        revokeSession,
        listSessions,
        activeSlotCount,
        isSessionActive,
        getSession,
    };
}

// Aliases for alternative naming
export const createSessionRegistry = createPlaybackSessionRegistry;
export const createDeviceRegistry = createPlaybackSessionRegistry;
export const createPlaybackSessionRegistryFactory = createPlaybackSessionRegistry;

/* =========================================================================
 * Async store boundary (injected into the route)
 *
 * The route talks to the registry through an async port so an in-memory store
 * (tests, default) and a SQL store (production) are interchangeable. The
 * in-memory implementation above stays synchronous for direct unit tests and is
 * adapted with `asPlaybackSessionStore`.
 * ========================================================================= */

export interface PlaybackSessionStore {
    getPolicy(tenantId: string): Promise<PlaybackPolicy>;
    setPolicy(policy: PlaybackPolicy | Record<string, unknown>, tenantId?: string): Promise<PlaybackPolicy>;
    registerDevice(input: { tenantId: string; userId: string; fingerprint: string; label?: string | null; now?: Date }): Promise<PlaybackDevice>;
    getDevice(deviceId: string): Promise<PlaybackDevice | null>;
    listDevices(tenantId: string, userId?: string): Promise<PlaybackDevice[]>;
    revokeDevice(input: { deviceId: string; actorId: string; reason?: string; support?: boolean }): Promise<RevokeResult>;
    acquireSlot(input: { tenantId: string; userId: string; deviceId: string; sessionId: string; policy?: PlaybackPolicy | Record<string, unknown> }): Promise<SlotAcquisitionResult>;
    releaseSlot(sessionId: string, reason?: string): Promise<boolean>;
    revokeSession(input: { sessionId: string; actorId: string; actorType?: string; reason?: string; support?: boolean }): Promise<RevokeResult>;
    listSessions(tenantId: string, userId?: string, status?: string): Promise<PlaybackSlot[]>;
    activeSlotCount(tenantId: string, userId: string): Promise<number>;
    isSessionActive(sessionId: string): Promise<boolean>;
    getSession(sessionId: string): Promise<PlaybackSlot | null>;
}

/** Adapt the synchronous in-memory registry to the async store port. */
export function asPlaybackSessionStore(registry: PlaybackSessionRegistry): PlaybackSessionStore {
    return {
        getPolicy: async (tenantId) => registry.getPolicy(tenantId),
        setPolicy: async (policy, tenantId) => registry.setPolicy(policy, tenantId),
        registerDevice: async (input) => registry.registerDevice(input),
        getDevice: async (deviceId) => registry.getDevice(deviceId),
        listDevices: async (tenantId, userId) => registry.listDevices(tenantId, userId),
        revokeDevice: async (input) => registry.revokeDevice(input),
        acquireSlot: (input) => registry.acquireSlot(input),
        releaseSlot: async (sessionId, reason) => registry.releaseSlot(sessionId, reason),
        revokeSession: (input) => registry.revokeSession(input),
        listSessions: async (tenantId, userId, status) => registry.listSessions(tenantId, userId, status),
        activeSlotCount: async (tenantId, userId) => registry.activeSlotCount(tenantId, userId),
        isSessionActive: async (sessionId) => registry.isSessionActive(sessionId),
        getSession: async (sessionId) => registry.getSession(sessionId),
    };
}

/* =========================================================================
 * SQL adapter (production wiring)
 *
 * State lives in the migration-07 tables. Slot acquisition is race-safe: a
 * dedicated connection holds a transaction, locks the user's device rows with
 * `FOR UPDATE`, then re-counts active slots and inserts in one critical
 * section, so two concurrent starts can never oversubscribe. Registration is
 * deny-by-default at the tenant's `maxDevices` ceiling under the same lock.
 * ========================================================================= */

export interface PlaybackStoreDb {
    query: <T = unknown>(sql: string, params?: unknown[]) => Promise<T[]>;
    queryOne: <T = unknown>(sql: string, params?: unknown[]) => Promise<T | null>;
    execute: (sql: string, params?: unknown[]) => Promise<{ insertId?: number; affectedRows?: number }>;
    /**
     * Runs `fn` inside a single-connection transaction. When omitted (e.g. the
     * scripted hermetic fake) the callback is executed against the same handle.
     */
    transaction?: <T>(fn: (tx: PlaybackStoreDb) => Promise<T>) => Promise<T>;
}

export interface PlaybackSessionStoreDeps {
    idFactory?: () => string;
    now?: () => Date;
    audit?: (event: Record<string, unknown>) => void | Promise<void>;
    policyProvider?: (tenantId: string) => PlaybackPolicy | null | undefined;
}

interface PlaybackDeviceRow {
    id: string;
    tenant_id: string;
    user_id: string;
    device_fingerprint: string;
    device_label: string | null;
    status: string;
    first_seen_at: unknown;
    last_seen_at: unknown;
    revoked_at: unknown | null;
    revoked_by: string | null;
    revoke_reason: string | null;
}

interface PlaybackSlotRow {
    id: string;
    tenant_id: string;
    user_id: string;
    device_id: string;
    session_id: string;
    status: string;
    started_at: unknown;
    last_heartbeat_at: unknown;
    ended_at: unknown | null;
    ended_reason: string | null;
}

const DEVICE_COLUMNS = 'id, tenant_id, user_id, device_fingerprint, device_label, status, first_seen_at, last_seen_at, revoked_at, revoked_by, revoke_reason';
const SLOT_COLUMNS = 'id, tenant_id, user_id, device_id, session_id, status, started_at, last_heartbeat_at, ended_at, ended_reason';

function toIso(value: unknown): string {
    if (value instanceof Date) return value.toISOString();
    if (typeof value === 'string' && value) {
        const date = new Date(/[TZ]/.test(value) ? value : `${value.replace(' ', 'T')}Z`);
        if (Number.isFinite(date.getTime())) return date.toISOString();
    }
    return new Date(0).toISOString();
}

function mapDeviceRow(row: PlaybackDeviceRow): PlaybackDevice {
    return {
        id: row.id,
        tenantId: row.tenant_id,
        userId: row.user_id,
        fingerprint: row.device_fingerprint,
        label: row.device_label,
        status: row.status === 'revoked' ? 'revoked' : 'active',
        firstSeenAt: toIso(row.first_seen_at),
        lastSeenAt: toIso(row.last_seen_at),
        revokedAt: row.revoked_at === null || row.revoked_at === undefined ? null : toIso(row.revoked_at),
        revokedBy: row.revoked_by,
        revokeReason: row.revoke_reason,
    };
}

function mapSlotRow(row: PlaybackSlotRow): PlaybackSlot {
    const status = row.status === 'ended' || row.status === 'revoked' ? row.status : 'active';
    return {
        id: row.id,
        tenantId: row.tenant_id,
        userId: row.user_id,
        deviceId: row.device_id,
        sessionId: row.session_id,
        status,
        startedAt: toIso(row.started_at),
        lastHeartbeatAt: toIso(row.last_heartbeat_at),
        endedAt: row.ended_at === null || row.ended_at === undefined ? null : toIso(row.ended_at),
        endedReason: row.ended_reason,
    };
}

export function createSqlPlaybackSessionStore(db: PlaybackStoreDb, deps: PlaybackSessionStoreDeps = {}): PlaybackSessionStore {
    const idFactory = deps.idFactory ?? (() => `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);
    const nowFn = deps.now ?? (() => new Date());
    const audit = deps.audit ?? (() => undefined);

    const withTransaction = <T>(fn: (tx: PlaybackStoreDb) => Promise<T>): Promise<T> =>
        db.transaction ? db.transaction(fn) : fn(db);

    const loadPolicy = async (conn: PlaybackStoreDb, tenantId: string): Promise<PlaybackPolicy> => {
        if (deps.policyProvider) {
            const provided = deps.policyProvider(tenantId);
            if (provided) return normalizePlaybackPolicy(provided, tenantId);
        }
        const row = await conn.queryOne<{
            max_concurrent_sessions: number;
            max_devices: number;
            warning_threshold: number;
            self_revoke_allowed: number | boolean;
            support_revoke_allowed: number | boolean;
        }>(
            `SELECT max_concurrent_sessions, max_devices, warning_threshold, self_revoke_allowed, support_revoke_allowed
             FROM playback_tenant_policies WHERE tenant_id = ? LIMIT 1`,
            [tenantId],
        );
        if (!row) return normalizePlaybackPolicy({}, tenantId);
        return normalizePlaybackPolicy({
            maxConcurrentSessions: row.max_concurrent_sessions,
            maxDevices: row.max_devices,
            warningThreshold: row.warning_threshold,
            selfRevokeAllowed: Boolean(row.self_revoke_allowed),
            supportRevokeAllowed: Boolean(row.support_revoke_allowed),
        }, tenantId);
    };

    const readDeviceByKey = (conn: PlaybackStoreDb, tenantId: string, userId: string, fingerprint: string): Promise<PlaybackDevice | null> =>
        conn.queryOne<PlaybackDeviceRow>(
            `SELECT ${DEVICE_COLUMNS} FROM playback_devices WHERE tenant_id = ? AND user_id = ? AND device_fingerprint = ? LIMIT 1`,
            [tenantId, userId, fingerprint],
        ).then((row) => (row ? mapDeviceRow(row) : null));

    const denied = (reason: SlotAcquisitionResult['reason'], activeSlots: number): SlotAcquisitionResult =>
        ({ acquired: false, slot: null, reason, warning: false, activeSlots });

    return {
        getPolicy: (tenantId) => loadPolicy(db, tenantId),

        setPolicy: async (policy, tenantId) => {
            const tid = tenantId ?? String((policy as Record<string, unknown>).tenantId ?? '');
            const normalized = normalizePlaybackPolicy(policy, tid || null);
            if (tid) {
                await db.execute(
                    `INSERT INTO playback_tenant_policies
                       (tenant_id, max_concurrent_sessions, max_devices, warning_threshold, self_revoke_allowed, support_revoke_allowed)
                     VALUES (?, ?, ?, ?, ?, ?)
                     ON DUPLICATE KEY UPDATE
                       max_concurrent_sessions = VALUES(max_concurrent_sessions),
                       max_devices = VALUES(max_devices),
                       warning_threshold = VALUES(warning_threshold),
                       self_revoke_allowed = VALUES(self_revoke_allowed),
                       support_revoke_allowed = VALUES(support_revoke_allowed)`,
                    [
                        tid,
                        normalized.maxConcurrentSessions,
                        normalized.maxDevices,
                        normalized.warningThreshold,
                        normalized.selfRevokeAllowed ? 1 : 0,
                        normalized.supportRevokeAllowed ? 1 : 0,
                    ],
                );
            }
            return normalized;
        },

        registerDevice: (input) => withTransaction(async (tx) => {
            const policy = await loadPolicy(tx, input.tenantId);
            const existingRows = await tx.query<PlaybackDeviceRow>(
                `SELECT ${DEVICE_COLUMNS} FROM playback_devices WHERE tenant_id = ? AND user_id = ? FOR UPDATE`,
                [input.tenantId, input.userId],
            );
            const sameFingerprint = existingRows.find((row) => row.device_fingerprint === input.fingerprint);
            if (sameFingerprint) {
                if (sameFingerprint.status !== 'revoked') {
                    return mapDeviceRow(sameFingerprint);
                }
                await tx.execute(
                    `UPDATE playback_devices
                     SET status = 'active', revoked_at = NULL, revoked_by = NULL, revoke_reason = NULL,
                         device_label = COALESCE(?, device_label), last_seen_at = NOW()
                     WHERE id = ?`,
                    [input.label ?? null, sameFingerprint.id],
                );
                const refreshed = await readDeviceByKey(tx, input.tenantId, input.userId, input.fingerprint);
                if (refreshed) return refreshed;
            }
            const activeCount = existingRows.filter((row) => row.status === 'active').length;
            if (activeCount >= policy.maxDevices) {
                throw new PlaybackDeviceLimitError(policy.maxDevices);
            }
            const id = idFactory();
            await tx.execute(
                `INSERT INTO playback_devices
                   (id, tenant_id, user_id, device_fingerprint, device_label, status, first_seen_at, last_seen_at, revoked_at, revoked_by, revoke_reason)
                 VALUES (?, ?, ?, ?, ?, 'active', NOW(), NOW(), NULL, NULL, NULL)`,
                [id, input.tenantId, input.userId, input.fingerprint, input.label ?? null],
            );
            const created = await readDeviceByKey(tx, input.tenantId, input.userId, input.fingerprint);
            if (!created) throw new PlaybackDeviceLimitError(policy.maxDevices);
            return created;
        }),

        getDevice: async (deviceId) => {
            const row = await db.queryOne<PlaybackDeviceRow>(
                `SELECT ${DEVICE_COLUMNS} FROM playback_devices WHERE id = ? LIMIT 1`,
                [deviceId],
            );
            return row ? mapDeviceRow(row) : null;
        },

        listDevices: async (tenantId, userId) => {
            const params: unknown[] = [tenantId];
            let sql = `SELECT ${DEVICE_COLUMNS} FROM playback_devices WHERE tenant_id = ?`;
            if (userId !== undefined) { sql += ' AND user_id = ?'; params.push(userId); }
            sql += ' ORDER BY last_seen_at DESC';
            const rows = await db.query<PlaybackDeviceRow>(sql, params);
            return rows.map(mapDeviceRow);
        },

        revokeDevice: async (input) => {
            const row = await db.queryOne<PlaybackDeviceRow>(
                `SELECT ${DEVICE_COLUMNS} FROM playback_devices WHERE id = ? LIMIT 1`,
                [input.deviceId],
            );
            if (!row) return { revoked: false, reason: 'device_not_found' };
            if (row.status === 'revoked') return { revoked: true, reason: 'already_revoked' };
            if (!input.support && input.actorId !== row.user_id) return { revoked: false, reason: 'not_owner' };
            const policy = await loadPolicy(db, row.tenant_id);
            if (input.support && !policy.supportRevokeAllowed) return { revoked: false, reason: 'support_revoke_not_allowed' };
            if (!input.support && !policy.selfRevokeAllowed) return { revoked: false, reason: 'self_revoke_not_allowed' };
            const reason = input.reason ?? (input.support ? 'support_revoke' : 'self_revoke');
            await db.execute(
                `UPDATE playback_devices SET status = 'revoked', revoked_at = NOW(), revoked_by = ?, revoke_reason = ?
                 WHERE id = ? AND status = 'active'`,
                [input.actorId, reason, input.deviceId],
            );
            await db.execute(
                `UPDATE playback_session_slots SET status = 'revoked', ended_at = NOW(), ended_reason = ?
                 WHERE device_id = ? AND status = 'active'`,
                [reason, input.deviceId],
            );
            await audit({ action: input.support ? 'playback.device.support_revoke' : 'playback.device.self_revoke', deviceId: row.id, tenantId: row.tenant_id, userId: row.user_id, actorId: input.actorId, reason });
            return { revoked: true, reason: 'ok' };
        },

        acquireSlot: (input) => withTransaction(async (tx) => {
            // Serialize every acquisition for this user by locking their device
            // rows for the duration of the transaction.
            await tx.query(
                `SELECT id FROM playback_devices WHERE tenant_id = ? AND user_id = ? FOR UPDATE`,
                [input.tenantId, input.userId],
            );
            const deviceRow = await tx.queryOne<PlaybackDeviceRow>(
                `SELECT ${DEVICE_COLUMNS} FROM playback_devices WHERE id = ? LIMIT 1`,
                [input.deviceId],
            );
            if (!deviceRow) return denied('device_not_found', 0);
            if (deviceRow.tenant_id !== input.tenantId || deviceRow.user_id !== input.userId) {
                return denied('device_not_found', 0);
            }
            if (deviceRow.status !== 'active') {
                const active = await countActiveSlots(tx, input.tenantId, input.userId);
                return denied('device_revoked', active);
            }
            const duplicate = await tx.queryOne<PlaybackSlotRow>(
                `SELECT ${SLOT_COLUMNS} FROM playback_session_slots WHERE session_id = ? LIMIT 1`,
                [input.sessionId],
            );
            if (duplicate) {
                const active = await countActiveSlots(tx, input.tenantId, input.userId);
                return { acquired: false, slot: mapSlotRow(duplicate), reason: 'duplicate_session', warning: false, activeSlots: active };
            }
            const policy = await loadPolicy(tx, input.tenantId);
            const deviceCount = await tx.queryOne<{ c: number | string }>(
                `SELECT COUNT(*) AS c FROM playback_devices WHERE tenant_id = ? AND user_id = ? AND status = 'active'`,
                [input.tenantId, input.userId],
            );
            const current = await countActiveSlots(tx, input.tenantId, input.userId);
            if (Number(deviceCount?.c ?? 0) > policy.maxDevices) {
                return denied('device_limit', current);
            }
            if (current >= policy.maxConcurrentSessions) {
                return denied('concurrency_limit', current);
            }
            const id = idFactory();
            await tx.execute(
                `INSERT INTO playback_session_slots
                   (id, tenant_id, user_id, device_id, session_id, status, started_at, last_heartbeat_at, ended_at, ended_reason)
                 VALUES (?, ?, ?, ?, ?, 'active', NOW(), NOW(), NULL, NULL)`,
                [id, input.tenantId, input.userId, input.deviceId, input.sessionId],
            );
            const activeSlots = current + 1;
            const warning = activeSlots > policy.warningThreshold && activeSlots <= policy.maxConcurrentSessions;
            if (warning) {
                await audit({ action: 'playback.session.warning', tenantId: input.tenantId, userId: input.userId, sessionId: input.sessionId, activeSlots, limit: policy.maxConcurrentSessions });
            }
            await audit({ action: 'playback.session.started', tenantId: input.tenantId, userId: input.userId, deviceId: input.deviceId, sessionId: input.sessionId, activeSlots, limit: policy.maxConcurrentSessions });
            const created = await tx.queryOne<PlaybackSlotRow>(
                `SELECT ${SLOT_COLUMNS} FROM playback_session_slots WHERE session_id = ? LIMIT 1`,
                [input.sessionId],
            );
            const slot = created ? mapSlotRow(created) : {
                id, tenantId: input.tenantId, userId: input.userId, deviceId: input.deviceId,
                sessionId: input.sessionId, status: 'active' as const,
                startedAt: nowFn().toISOString(), lastHeartbeatAt: nowFn().toISOString(),
                endedAt: null, endedReason: null,
            };
            return { acquired: true, slot, reason: 'ok', warning, activeSlots };
        }),

        releaseSlot: async (sessionId, reason = 'released') => {
            const result = await db.execute(
                `UPDATE playback_session_slots SET status = 'ended', ended_at = NOW(), ended_reason = ?
                 WHERE session_id = ? AND status = 'active'`,
                [reason, sessionId],
            );
            if (!result.affectedRows) return false;
            await audit({ action: 'playback.session.released', sessionId, reason });
            return true;
        },

        revokeSession: async (input) => {
            const row = await db.queryOne<PlaybackSlotRow>(
                `SELECT ${SLOT_COLUMNS} FROM playback_session_slots WHERE session_id = ? LIMIT 1`,
                [input.sessionId],
            );
            if (!row) return { revoked: false, reason: 'session_not_found' };
            const policy = await loadPolicy(db, row.tenant_id);
            const isOwner = row.user_id === input.actorId;
            const isSupport = input.support === true || input.actorType === 'support';
            if (!isOwner && !isSupport) return { revoked: false, reason: 'not_authorized' };
            if (isOwner && !isSupport && !policy.selfRevokeAllowed) return { revoked: false, reason: 'self_revoke_not_allowed' };
            if (isSupport && !policy.supportRevokeAllowed) return { revoked: false, reason: 'support_revoke_not_allowed' };
            if (row.status !== 'active') return { revoked: false, reason: 'already_ended' };
            const reason = input.reason ?? (isOwner && !isSupport ? 'self_revoke' : 'support_revoke');
            await db.execute(
                `UPDATE playback_session_slots SET status = 'revoked', ended_at = NOW(), ended_reason = ?
                 WHERE session_id = ? AND status = 'active'`,
                [reason, input.sessionId],
            );
            await audit({
                action: isOwner && !isSupport ? 'playback.session.self_revoke' : 'playback.session.support_revoke',
                tenantId: row.tenant_id,
                userId: row.user_id,
                sessionId: input.sessionId,
                actorId: input.actorId,
                actorType: isOwner && !isSupport ? 'self' : 'support',
                reason,
            });
            return { revoked: true, reason: 'ok' };
        },

        listSessions: async (tenantId, userId, status) => {
            const params: unknown[] = [tenantId];
            let sql = `SELECT ${SLOT_COLUMNS} FROM playback_session_slots WHERE tenant_id = ?`;
            if (userId !== undefined) { sql += ' AND user_id = ?'; params.push(userId); }
            if (status !== undefined) { sql += ' AND status = ?'; params.push(status); }
            sql += ' ORDER BY started_at DESC';
            const rows = await db.query<PlaybackSlotRow>(sql, params);
            return rows.map(mapSlotRow);
        },

        activeSlotCount: (tenantId, userId) => countActiveSlots(db, tenantId, userId),

        isSessionActive: async (sessionId) => {
            const row = await db.queryOne<{ status: string }>(
                'SELECT status FROM playback_session_slots WHERE session_id = ? LIMIT 1',
                [sessionId],
            );
            return row?.status === 'active';
        },

        getSession: async (sessionId) => {
            const row = await db.queryOne<PlaybackSlotRow>(
                `SELECT ${SLOT_COLUMNS} FROM playback_session_slots WHERE session_id = ? LIMIT 1`,
                [sessionId],
            );
            return row ? mapSlotRow(row) : null;
        },
    };
}

function countActiveSlots(conn: PlaybackStoreDb, tenantId: string, userId: string): Promise<number> {
    return conn.queryOne<{ c: number | string }>(
        `SELECT COUNT(*) AS c FROM playback_session_slots WHERE tenant_id = ? AND user_id = ? AND status = 'active'`,
        [tenantId, userId],
    ).then((row) => Number(row?.c ?? 0));
}
