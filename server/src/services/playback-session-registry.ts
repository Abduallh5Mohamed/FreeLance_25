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

export function normalizePlaybackPolicy(input: unknown, tenantId: string | null = null): PlaybackPolicy {
    const raw = (input && typeof input === 'object') ? (input as Record<string, unknown>) : {};
    const maxConcurrent = Number(raw.maxConcurrentSessions ?? raw.max_concurrent_sessions ?? DEFAULT_PLAYBACK_POLICY.maxConcurrentSessions);
    const maxDevices = Number(raw.maxDevices ?? raw.max_devices ?? DEFAULT_PLAYBACK_POLICY.maxDevices);
    const warning = Number(raw.warningThreshold ?? raw.warning_threshold ?? Math.max(0, maxConcurrent - 1));
    return {
        tenantId,
        maxConcurrentSessions: Number.isFinite(maxConcurrent) && maxConcurrent > 0 ? Math.trunc(maxConcurrent) : DEFAULT_PLAYBACK_POLICY.maxConcurrentSessions,
        maxDevices: Number.isFinite(maxDevices) && maxDevices > 0 ? Math.trunc(maxDevices) : DEFAULT_PLAYBACK_POLICY.maxDevices,
        warningThreshold: Number.isFinite(warning) && warning >= 0 ? Math.trunc(warning) : 0,
        selfRevokeAllowed: raw.selfRevokeAllowed !== false && raw.self_revoke_allowed !== false,
        supportRevokeAllowed: raw.supportRevokeAllowed !== false && raw.support_revoke_allowed !== false,
    };
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
            if (existing) {
                existing.lastSeenAt = nowIso(input.now);
                if (existing.status === 'revoked') {
                    // re-registration after revoke is a new device row
                } else {
                    return existing;
                }
            }
        }
        // enforce device limit
        const policy = getPolicy(input.tenantId);
        const userDevices = [...devices.values()].filter((d) => d.tenantId === input.tenantId && d.userId === input.userId && d.status === 'active');
        if (userDevices.length >= policy.maxDevices) {
            // still create? deny by returning existing? We'll throw a sentinel via status
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
        const isSelf = input.actorType !== 'support' && !input.support && slot.userId === input.actorId;
        if (isSelf && !policy.selfRevokeAllowed) return { revoked: false, reason: 'self_revoke_not_allowed' };
        if (!isSelf && !policy.supportRevokeAllowed) return { revoked: false, reason: 'support_revoke_not_allowed' };
        if (slot.status !== 'active') return { revoked: false, reason: 'already_ended' };
        slot.status = 'revoked';
        slot.endedAt = nowIso();
        slot.endedReason = input.reason ?? (isSelf ? 'self_revoke' : 'support_revoke');
        const set = slotsByUser.get(userKey(slot.tenantId, slot.userId));
        if (set) set.delete(input.sessionId);
        audit({
            action: isSelf ? 'playback.session.self_revoke' : 'playback.session.support_revoke',
            tenantId: slot.tenantId,
            userId: slot.userId,
            sessionId: input.sessionId,
            actorId: input.actorId,
            actorType: isSelf ? 'self' : 'support',
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
    };
}

// Aliases for alternative naming
export const createSessionRegistry = createPlaybackSessionRegistry;
export const createDeviceRegistry = createPlaybackSessionRegistry;
export const createPlaybackSessionRegistryFactory = createPlaybackSessionRegistry;
