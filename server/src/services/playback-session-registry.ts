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

/**
 * A single-row CAS must report exactly one affected row.
 *
 * `undefined` is neither zero (which would drop a change that happened) nor one
 * (which would fabricate a change that did not), so an unusable count throws
 * instead of being coerced with `?? 0` or tested for truthiness. Callers decide
 * what a legitimate zero means — usually "someone else won the race" — but they
 * cannot decide that when they cannot see the number at all.
 */
function requireAffectedRows(
    result: { affectedRows?: number } | undefined,
    label: string,
): number {
    const affected = result?.affectedRows;
    if (typeof affected !== 'number' || !Number.isSafeInteger(affected) || affected < 0) {
        throw new Error(`The ${label} did not report a usable affected-row count`);
    }
    return affected;
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

/**
 * Resource scope a revoke was authorized with. `platformAuthorized` is the
 * result of a live `security.manage` check; without it a support actor must
 * carry the exact server-derived tenant of the row being changed. The stores
 * re-check this against the row they lock, so the decision cannot be widened
 * by a caller and cannot drift between the route's read and the mutation.
 */
export interface RevokeAuthority {
    actorTenantId?: string | null;
    platformAuthorized?: boolean;
}

export interface RevokeSessionInput extends RevokeAuthority {
    sessionId: string;
    actorId: string;
    actorType?: string;
    reason?: string;
    support?: boolean;
}

export interface RevokeDeviceInput extends RevokeAuthority {
    deviceId: string;
    actorId: string;
    reason?: string;
    support?: boolean;
}

function supportAuthorityDenial(
    rowTenantId: string,
    input: RevokeAuthority,
): RevokeResult | null {
    if (input.platformAuthorized) return null;
    if (!input.actorTenantId) return { revoked: false, reason: 'tenant_required' };
    if (rowTenantId !== input.actorTenantId) return { revoked: false, reason: 'tenant_mismatch' };
    return null;
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
    revokeDevice(input: RevokeDeviceInput): RevokeResult;
    acquireSlot(input: { tenantId: string; userId: string; deviceId: string; sessionId: string; policy?: PlaybackPolicy | Record<string, unknown> }): Promise<SlotAcquisitionResult>;
    releaseSlot(sessionId: string, reason?: string): boolean;
    revokeSession(input: RevokeSessionInput): Promise<RevokeResult>;
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
        // The tenant is the EXPLICIT argument. Falling back to `policy.tenantId`
        // let a caller-supplied object name the tenant it wanted to configure,
        // so a policy write was addressable to any tenant id the caller typed.
        const tid = tenantId ?? '';
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

    const revokeDevice = (input: RevokeDeviceInput): RevokeResult => {
        const device = devices.get(input.deviceId);
        if (!device) return { revoked: false, reason: 'device_not_found' };
        if (device.status === 'revoked') return { revoked: true, reason: 'already_revoked' };
        if (!input.support && input.actorId !== device.userId) return { revoked: false, reason: 'not_owner' };
        if (input.support) {
            const denial = supportAuthorityDenial(device.tenantId, input);
            if (denial) return denial;
        }
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

        // The policy is ALWAYS server-derived. A caller-supplied policy object
        // used to be able to replace it, clamped only to the global ceiling —
        // so a caller who could influence that argument raised their own
        // concurrency limit from the tenant's configured 2 up to 10. The
        // ceilings bound magnitude; the tenant row is the authority. `policy`
        // remains on the input type for existing callers but is ignored here.
        const policy = getPolicy(input.tenantId);
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

    const revokeSession = async (input: RevokeSessionInput): Promise<RevokeResult> => {
        const slot = slots.get(input.sessionId);
        if (!slot) return { revoked: false, reason: 'session_not_found' };
        const policy = getPolicy(slot.tenantId);
        const isOwner = slot.userId === input.actorId;
        // Same proof as the SQL store: support intent AND support actor type,
        // never one caller-supplied flag on its own.
        const isSupport = input.support === true && input.actorType === 'support';
        if (!isOwner && !isSupport) return { revoked: false, reason: 'not_authorized' };
        if (isSupport) {
            const denial = supportAuthorityDenial(slot.tenantId, input);
            if (denial) return denial;
        }
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
    revokeDevice(input: RevokeDeviceInput): Promise<RevokeResult>;
    acquireSlot(input: { tenantId: string; userId: string; deviceId: string; sessionId: string; policy?: PlaybackPolicy | Record<string, unknown> }): Promise<SlotAcquisitionResult>;
    releaseSlot(sessionId: string, reason?: string): Promise<boolean>;
    revokeSession(input: RevokeSessionInput): Promise<RevokeResult>;
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
    /**
     * Audit sink. When the SQL store calls it, the transaction handle is
     * supplied so the audit row commits with the state change it describes
     * instead of on a separate pooled connection.
     */
    audit?: (event: Record<string, unknown>, tx?: PlaybackStoreDb) => void | Promise<void>;
    policyProvider?: (tenantId: string) => PlaybackPolicy | null | undefined;
    /**
     * Durable co-commit for a session revocation: runs inside the SAME
     * transaction as the slot status flip and the audit row, so a revoked
     * session can never keep a usable delivery entitlement (or vice versa).
     * A failure here rolls the whole revocation back.
     */
    revokeEntitlements?: (
        tx: PlaybackStoreDb,
        input: { sessionId: string; reason: string; revokedAtMs: number },
    ) => Promise<number>;
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
        // Fail CLOSED: an unknown status is not treated as active. A schema that
        // later gains `expired` or `suspended` must not have those sessions
        // silently count as live and resurrectable through every read path.
        status: row.status === 'active' ? 'active' : 'revoked',
        firstSeenAt: toIso(row.first_seen_at),
        lastSeenAt: toIso(row.last_seen_at),
        revokedAt: row.revoked_at === null || row.revoked_at === undefined ? null : toIso(row.revoked_at),
        revokedBy: row.revoked_by,
        revokeReason: row.revoke_reason,
    };
}

function mapSlotRow(row: PlaybackSlotRow): PlaybackSlot {
    // Fail CLOSED, for the same reason as `mapDeviceRow`: only the two known
    // terminal states and the active state are recognised, and anything else is
    // treated as not-active rather than as active.
    const status = row.status === 'active' || row.status === 'ended' || row.status === 'revoked'
        ? row.status
        : 'ended';
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
            // Explicit argument only, same rule as the in-memory `setPolicy`:
            // a caller-supplied `policy.tenantId` must never name the tenant a
            // durable policy write is addressed to.
            const tid = tenantId ?? '';
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

        revokeDevice: (input) => withTransaction(async (tx) => {
            const row = await tx.queryOne<PlaybackDeviceRow>(
                `SELECT ${DEVICE_COLUMNS} FROM playback_devices WHERE id = ? LIMIT 1 FOR UPDATE`,
                [input.deviceId],
            );
            if (!row) return { revoked: false, reason: 'device_not_found' };
            if (row.status === 'revoked') return { revoked: true, reason: 'already_revoked' };
            if (!input.support && input.actorId !== row.user_id) return { revoked: false, reason: 'not_owner' };
            if (input.support) {
                // Re-checked against the locked row's own tenant, not a claim.
                const denial = supportAuthorityDenial(row.tenant_id, input);
                if (denial) return denial;
            }
            const policy = await loadPolicy(tx, row.tenant_id);
            if (input.support && !policy.supportRevokeAllowed) return { revoked: false, reason: 'support_revoke_not_allowed' };
            if (!input.support && !policy.selfRevokeAllowed) return { revoked: false, reason: 'self_revoke_not_allowed' };
            const reason = input.reason ?? (input.support ? 'support_revoke' : 'self_revoke');
            // Both are CAS updates (`AND status = 'active'`) and both results
            // are asserted: `FOR UPDATE` above serialises this transaction, but
            // a lock that is not honoured would otherwise let a second revoke
            // pass the pre-checks, change zero rows, and still report success
            // and audit a revoke that never happened.
            const deviceUpdate = await tx.execute(
                `UPDATE playback_devices SET status = 'revoked', revoked_at = NOW(), revoked_by = ?, revoke_reason = ?
                 WHERE id = ? AND status = 'active'`,
                [input.actorId, reason, input.deviceId],
            );
            if (requireAffectedRows(deviceUpdate, 'playback device revoke') !== 1) {
                return { revoked: false, reason: 'already_revoked' };
            }
            const slotUpdate = await tx.execute(
                `UPDATE playback_session_slots SET status = 'revoked', ended_at = NOW(), ended_reason = ?
                 WHERE device_id = ? AND status = 'active'`,
                [reason, input.deviceId],
            );
            // A device may legitimately hold zero active slots, so zero is
            // allowed here — but the count must still be readable.
            requireAffectedRows(slotUpdate, 'playback device slot revoke');
            await audit({ action: input.support ? 'playback.device.support_revoke' : 'playback.device.self_revoke', deviceId: row.id, tenantId: row.tenant_id, userId: row.user_id, actorId: input.actorId, reason }, tx);
            return { revoked: true, reason: 'ok' };
        }),

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
            // Strict parse, never `Number(x ?? 0)`: an unreadable count is a
            // fault, not "zero devices". `>=` matches the registration guard
            // below — the old `>` made this branch unreachable.
            if (parseCount(deviceCount?.c, 'active playback device count') >= policy.maxDevices) {
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
            // Exactly one row must move. `undefined` is an error, not zero: a
            // driver that does not populate the count would otherwise be
            // reported as "nothing to release" while the slot is in fact ended,
            // and the audit would be skipped for a change that happened.
            const affected = requireAffectedRows(result, 'playback session release');
            if (affected !== 1) return false;
            await audit({ action: 'playback.session.released', sessionId, reason, tenantId: undefined, userId: undefined });
            return true;
        },

        revokeSession: (input) => withTransaction(async (tx) => {
            // Lock the slot for the duration of the transaction: the status
            // flip, the entitlement co-commit and the audit row must describe
            // one committed state, never a half-applied one.
            const row = await tx.queryOne<PlaybackSlotRow>(
                `SELECT ${SLOT_COLUMNS} FROM playback_session_slots WHERE session_id = ? LIMIT 1 FOR UPDATE`,
                [input.sessionId],
            );
            if (!row) return { revoked: false, reason: 'session_not_found' };
            const policy = await loadPolicy(tx, row.tenant_id);
            const isOwner = row.user_id === input.actorId;
            // Support authority is never inferred from a single caller flag:
            // the actor must present BOTH the support intent and the support
            // actor type, and the tenant policy must still allow it.
            const isSupport = input.support === true && input.actorType === 'support';
            if (!isOwner && !isSupport) return { revoked: false, reason: 'not_authorized' };
            if (isSupport) {
                // The locked row is the authority: a foreign or absent actor
                // tenant denies before any slot, entitlement or audit change.
                const denial = supportAuthorityDenial(row.tenant_id, input);
                if (denial) return denial;
            }
            if (isOwner && !isSupport && !policy.selfRevokeAllowed) return { revoked: false, reason: 'self_revoke_not_allowed' };
            if (isSupport && !policy.supportRevokeAllowed) return { revoked: false, reason: 'support_revoke_not_allowed' };
            if (row.status !== 'active') return { revoked: false, reason: 'already_ended' };
            const reason = input.reason ?? (isOwner && !isSupport ? 'self_revoke' : 'support_revoke');
            const update = await tx.execute(
                `UPDATE playback_session_slots SET status = 'revoked', ended_at = NOW(), ended_reason = ?
                 WHERE session_id = ? AND status = 'active'`,
                [reason, input.sessionId],
            );
            // Exactly one row must move. `undefined` is an ERROR, not zero: a
            // driver that does not populate the count would otherwise bail out
            // with `already_ended` BEFORE the entitlement co-commit and the
            // audit row run, leaving the slot revoked in the database while the
            // delivery entitlement stays live — the exact half-applied state the
            // transaction above promises is impossible.
            const affected = requireAffectedRows(update, 'playback session revoke');
            if (affected !== 1) return { revoked: false, reason: 'already_ended' };
            if (deps.revokeEntitlements) {
                await deps.revokeEntitlements(tx, {
                    sessionId: input.sessionId,
                    reason,
                    revokedAtMs: nowFn().getTime(),
                });
            }
            await audit({
                action: isOwner && !isSupport ? 'playback.session.self_revoke' : 'playback.session.support_revoke',
                tenantId: row.tenant_id,
                userId: row.user_id,
                sessionId: input.sessionId,
                actorId: input.actorId,
                actorType: isOwner && !isSupport ? 'self' : 'support',
                reason,
            }, tx);
            return { revoked: true, reason: 'ok' };
        }),

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
    ).then((row) => parseCount(row?.c, 'active playback slot count'));
}

/**
 * Strict count parsing.
 *
 * `COUNT(*)` is a non-negative integer, so anything that is not one is a driver
 * or shape fault — not a zero. Coercing it to `0` would make the concurrency
 * check pass when it cannot see the row, which oversubscribes the tenant's
 * anti-sharing limit instead of failing closed. MySQL returns COUNT as a number
 * or a decimal string; both are accepted, nothing else is.
 */
function parseCount(value: unknown, label: string): number {
    if (typeof value === 'number') {
        if (!Number.isSafeInteger(value) || value < 0) {
            throw new Error(`The ${label} is not a non-negative safe integer`);
        }
        return value;
    }
    if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
        const parsed = Number(value.trim());
        if (Number.isSafeInteger(parsed)) return parsed;
    }
    throw new Error(`The ${label} could not be read`);
}
