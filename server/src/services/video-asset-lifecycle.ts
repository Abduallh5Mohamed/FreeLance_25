/**
 * V1 — provider-neutral video asset lifecycle.
 *
 * A single state machine models every provider's asset independently of its
 * vendor API:
 *
 *     uploaded ──▶ processing ──▶ ready
 *         │             │
 *         └────────────▶ failed ──▶ processing (bounded retry)
 *
 * The module is split the same way as the M1 video-access policy:
 *
 *  1. a PURE state machine (`evaluateAssetTransition`, `evaluateFailureOutcome`)
 *     that is behaviorally tested without any I/O; and
 *  2. a service (`createVideoAssetLifecycle`) that orchestrates provider
 *     callbacks over an injected store. The SQL store adapter
 *     (`createSqlVideoAssetStore`) lives here too, so the service itself has
 *     no eager import of db, minio, or a network client.
 *
 * Guarantees required by the acceptance row:
 *  - illegal transitions are rejected (deny-by-default; a terminal asset never
 *    silently re-opens);
 *  - provider callbacks are idempotent: the callback table's
 *    UNIQUE(provider, callback_id) is the race guard, so a replayed callback is
 *    a no-op and never double-applies a transition;
 *  - every callback is signature-verified through an INJECTED verifier; an
 *    unverified callback is ignored and audited, never applied;
 *  - the owning tenant is verified from server rows — a callback that names a
 *    different tenant is rejected and audited;
 *  - processing retries are bounded; when the attempt budget is exhausted the
 *    asset is dead-lettered with a reason, and no further retry is granted.
 *
 * No `any`, no ts-ignore, no network, no runtime DDL.
 */
import { randomUUID } from 'crypto';
import { AuditRecordInput, recordAudit } from '../security/audit';

/* =========================================================================
 * Pure state machine
 * ========================================================================= */

export const ASSET_STATES = ['uploaded', 'processing', 'ready', 'failed'] as const;
export type AssetState = (typeof ASSET_STATES)[number];

export function normalizeAssetState(value: unknown): AssetState | null {
    if (typeof value !== 'string') return null;
    return (ASSET_STATES as readonly string[]).includes(value) ? (value as AssetState) : null;
}

/**
 * Legal forward transitions. `ready` and `failed` are terminal for the
 * transition table itself; a `failed` asset may only re-enter `processing`
 * while it still has retry budget (enforced by the service, not this table).
 */
const LEGAL_TRANSITIONS: Record<AssetState, readonly AssetState[]> = {
    uploaded: ['processing', 'failed'],
    processing: ['ready', 'failed'],
    failed: ['processing'],
    ready: [],
};

export type TransitionDenialReason = 'unknown-state' | 'illegal-transition';

export type AssetTransitionDecision =
    | { allowed: true; idempotent: boolean }
    | { allowed: false; reason: TransitionDenialReason };

/**
 * Evaluate one transition. Repeating the current state is an idempotent no-op
 * (allowed, `idempotent: true`); any move absent from the table is rejected.
 */
export function evaluateAssetTransition(from: unknown, to: unknown): AssetTransitionDecision {
    const fromState = normalizeAssetState(from);
    const toState = normalizeAssetState(to);
    if (fromState === null || toState === null) return { allowed: false, reason: 'unknown-state' };
    if (fromState === toState) return { allowed: true, idempotent: true };
    return LEGAL_TRANSITIONS[fromState].includes(toState)
        ? { allowed: true, idempotent: false }
        : { allowed: false, reason: 'illegal-transition' };
}

export const DEFAULT_MAX_ATTEMPTS = 3;
export const MAX_ATTEMPTS_CEILING = 10;

/** Bound the retry budget into [1, MAX_ATTEMPTS_CEILING]. */
export function normalizeMaxAttempts(value: unknown): number {
    const parsed = typeof value === 'number' ? Math.trunc(value) : Number.parseInt(String(value ?? ''), 10);
    if (!Number.isFinite(parsed)) return DEFAULT_MAX_ATTEMPTS;
    return Math.min(MAX_ATTEMPTS_CEILING, Math.max(1, parsed));
}

export type FailureOutcome =
    | { retry: true }
    | { retry: false; deadLettered: true; reason: string };

/**
 * Decide whether a failed attempt may be retried. `attempts` is the number of
 * attempts ALREADY consumed; when it reaches the budget the asset is
 * dead-lettered instead of retried forever.
 */
export function evaluateFailureOutcome(attempts: number, maxAttempts: number): FailureOutcome {
    const consumed = Number.isFinite(attempts) && attempts > 0 ? Math.trunc(attempts) : 0;
    const budget = normalizeMaxAttempts(maxAttempts);
    return consumed < budget
        ? { retry: true }
        : { retry: false, deadLettered: true, reason: 'max_attempts_exceeded' };
}

/* =========================================================================
 * Store boundary
 * ========================================================================= */

export interface NewVideoAsset {
    id: string;
    tenantId: string;
    ownerUserId: string;
    provider: string;
    providerAssetId: string;
    title: string;
    maxAttempts: number;
}

export interface VideoAssetRecord {
    id: string;
    tenantId: string;
    ownerUserId: string;
    provider: string;
    providerAssetId: string;
    title: string;
    status: AssetState;
    attempts: number;
    maxAttempts: number;
    lastError: string | null;
    deadLettered: boolean;
    deadLetterReason: string | null;
}

export interface AssetUpdate {
    status: AssetState;
    attempts: number;
    lastError: string | null;
    deadLettered: boolean;
    deadLetterReason: string | null;
    /** Compare-and-set guard: the row must currently be in this state. */
    expectedStatus: AssetState;
}

export interface NewVideoAssetCallback {
    id: string;
    tenantId: string;
    assetId: string;
    provider: string;
    callbackId: string;
    targetState: AssetState;
    outcome: string;
    detail: string | null;
}

/**
 * All persistence the lifecycle needs. Production wires the SQL adapter;
 * hermetic tests inject an in-memory store and drive the REAL service.
 */
export interface VideoAssetStore {
    insertAsset(row: NewVideoAsset): Promise<void>;
    /** Tenant-scoped read: a cross-tenant id resolves to null. */
    findAssetById(id: string, tenantId: string): Promise<VideoAssetRecord | null>;
    /** Provider-keyed read used by callbacks that carry no caller tenant. */
    findAssetByProvider(provider: string, providerAssetId: string): Promise<VideoAssetRecord | null>;
    /** Returns affected rows (0 means the compare-and-set lost a race). */
    updateAsset(id: string, tenantId: string, update: AssetUpdate): Promise<number>;
    /** Returns false when the callback was already recorded (idempotent). */
    insertCallback(row: NewVideoAssetCallback): Promise<boolean>;
    recordAudit(input: AuditRecordInput): Promise<void>;
}

/* =========================================================================
 * Service
 * ========================================================================= */

export interface ProviderCallbackInput {
    provider: string;
    callbackId: string;
    signature: string;
    providerAssetId: string;
    targetState: unknown;
    /** Optional tenant claim inside the signed payload; verified against the row. */
    tenantId?: string | null;
    detail?: string | null;
    error?: string | null;
    /**
     * Optional byte size carried by the SIGNED payload. It is honoured only
     * after signature verification and only on a `ready` transition, where the
     * provider has finished writing the asset. Never read from a client.
     */
    storageBytes?: number | null;
}

/**
 * Structural port satisfied by `MediaMeteringService`. Kept local so the
 * lifecycle has no runtime dependency on the metering module.
 */
export interface AssetStorageMeterPort {
    recordVerifiedBytes(input: {
        tenantId: unknown;
        assetId: unknown;
        resultingBytes: unknown;
        operationId: unknown;
        source: unknown;
        occurredAtMs?: unknown;
    }): Promise<{ recorded: boolean; deduplicated: boolean } | { error: string }>;
}

/**
 * How a verified byte count was handled at the lifecycle boundary.
 *  - `recorded`     — the meter accepted the transition;
 *  - `deduplicated` — the meter had already seen this operation id;
 *  - `deferred`     — the meter was composed but failed, so the gap is left for
 *                     reconciliation (the asset state commit is not rolled back);
 *  - `unconfigured` — no durable meter is composed in this deployment. The bytes
 *                     are NOT metered and the fact is audited rather than dropped.
 */
export type MeteringOutcome = 'recorded' | 'deduplicated' | 'deferred' | 'unconfigured';

/**
 * W6-R2 — the gap outbox, as a structural port.
 *
 * A `deferred`/`unconfigured` byte count used to be an audit row only: the fact
 * was recorded, but nothing re-drove it, so reconciliation could detect the gap
 * and never close it. This port is satisfied by
 * `createInMemoryGapOutbox()` / `createSqlMediaGapOutbox()` in
 * `media-usage-reconciliation.ts` (same shape, no runtime dependency), and
 * `drainMediaUsageGaps()` replays the row through the same verified path.
 */
export interface AssetMeteringGapPort {
    enqueue(row: {
        id: string;
        tenantId: string;
        assetId: string;
        operationId: string;
        resultingBytes: number;
        source: 'provider-callback' | 'server-measured';
        occurredAtMs: number;
        reason: 'metering_deferred' | 'metering_unconfigured';
        status: 'pending';
        attempts: 0;
        lastAttemptAtMs: null;
        lastError: null;
        createdAtMs: number;
    }): Promise<{ enqueued: boolean; duplicate: boolean }>;
}

export type SignatureVerifier = (callback: ProviderCallbackInput) => boolean | Promise<boolean>;

export type CallbackResult =
    | { status: 'applied'; state: AssetState; attempts: number; deadLettered: boolean; metering?: MeteringOutcome }
    | { status: 'duplicate'; state: AssetState }
    | { status: 'ignored'; reason: 'unverified-signature' | 'unknown-asset' | 'unknown-target-state' }
    | { status: 'rejected'; reason: 'cross-tenant' | 'illegal-transition' | 'conflict'; from: AssetState };

export type TransitionOutcome =
    | { ok: true; state: AssetState; attempts: number; deadLettered: boolean }
    | { ok: false; reason: 'not-found' | 'illegal-transition' | 'conflict' | 'dead-lettered' | 'retry-exhausted'; from?: AssetState };

export type RegisterAssetResult =
    | { ok: true; id: string; state: AssetState }
    | { ok: false; reason: 'invalid-input' };

export interface VideoAssetLifecycle {
    registerAsset(input: {
        tenantId: string;
        ownerUserId: string;
        provider: string;
        providerAssetId: string;
        title?: string;
    }): Promise<RegisterAssetResult>;
    /** Moves `uploaded`/`failed` to `processing`, consuming one attempt. */
    beginProcessing(tenantId: string, assetId: string): Promise<TransitionOutcome>;
    getAsset(tenantId: string, assetId: string): Promise<VideoAssetRecord | null>;
    applyProviderCallback(callback: ProviderCallbackInput): Promise<CallbackResult>;
}

export interface VideoAssetLifecycleDeps {
    store: VideoAssetStore;
    verifyCallbackSignature: SignatureVerifier;
    now?: () => Date;
    idFactory?: () => string;
    maxAttempts?: number;
    /**
     * Optional storage meter. When present, a verified `ready` callback that
     * carries `storageBytes` records a tenant-scoped storage transition keyed by
     * the callback id (so a replay is absorbed).
     */
    meterStorage?: AssetStorageMeterPort;
    /**
     * W6-R2 — when present, a verified byte count the meter could not record is
     * enqueued here (same unit key the meter would have used), so the gap is
     * durable and replayable instead of being an audit row only.
     */
    gapOutbox?: AssetMeteringGapPort;
}

const PROVIDER_KEY_RE = /^[A-Za-z0-9_.:-]{1,128}$/;

export function normalizeProviderKey(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (!trimmed || trimmed.length > 128) return null;
    return PROVIDER_KEY_RE.test(trimmed) ? trimmed : null;
}

const ASSET_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

export function normalizeAssetId(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (!trimmed || trimmed.length > 128) return null;
    return ASSET_ID_RE.test(trimmed) ? trimmed : null;
}

const MAX_TITLE_LENGTH = 200;

export function createVideoAssetLifecycle(deps: VideoAssetLifecycleDeps): VideoAssetLifecycle {
    const idFactory = deps.idFactory ?? randomUUID;
    const now = deps.now ?? ((): Date => new Date());
    const store = deps.store;
    const configuredMax = normalizeMaxAttempts(deps.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);

    const audit = async (input: AuditRecordInput): Promise<void> => {
        await store.recordAudit(input);
    };

    /**
     * Persist a metering gap for replay. The enqueue is best-effort relative to
     * the asset commit (which already happened): a failure here is audited, and
     * the audit row stays the fallback evidence. It never throws into the
     * callback, because the state transition is already durable.
     */
    const recordMeteringGap = async (
        asset: VideoAssetRecord,
        bytes: number,
        operationId: string,
        reason: 'metering_deferred' | 'metering_unconfigured',
    ): Promise<void> => {
        if (!deps.gapOutbox) return;
        const at = now().getTime();
        try {
            const result = await deps.gapOutbox.enqueue({
                id: idFactory(),
                tenantId: asset.tenantId,
                assetId: asset.id,
                operationId,
                resultingBytes: bytes,
                source: 'provider-callback',
                occurredAtMs: at,
                reason,
                status: 'pending',
                attempts: 0,
                lastAttemptAtMs: null,
                lastError: null,
                createdAtMs: at,
            });
            if (result.enqueued) {
                await audit({
                    actorUserId: null,
                    tenantId: asset.tenantId,
                    action: 'video.asset.metering_gap_enqueued',
                    resourceType: 'video_asset',
                    resourceId: asset.id,
                    reason,
                    newValue: { operation_id: operationId, storage_bytes: bytes },
                });
            }
        } catch {
            await audit({
                actorUserId: null,
                tenantId: asset.tenantId,
                action: 'video.asset.metering_gap_enqueue_failed',
                resourceType: 'video_asset',
                resourceId: asset.id,
                reason,
                newValue: { operation_id: operationId, storage_bytes: bytes },
            });
        }
    };

    return {
        registerAsset: async (input) => {
            const tenantId = typeof input.tenantId === 'string' ? input.tenantId.trim() : '';
            const ownerUserId = typeof input.ownerUserId === 'string' ? input.ownerUserId.trim() : '';
            const provider = normalizeProviderKey(input.provider);
            const providerAssetId = normalizeProviderKey(input.providerAssetId);
            if (!tenantId || !ownerUserId || !provider || !providerAssetId) {
                return { ok: false, reason: 'invalid-input' };
            }
            const title = (typeof input.title === 'string' ? input.title.trim() : '').slice(0, MAX_TITLE_LENGTH) || 'Untitled asset';
            const id = idFactory();
            await store.insertAsset({
                id,
                tenantId,
                ownerUserId,
                provider,
                providerAssetId,
                title,
                maxAttempts: configuredMax,
            });
            await audit({
                actorUserId: ownerUserId,
                tenantId,
                action: 'video.asset.created',
                resourceType: 'video_asset',
                resourceId: id,
                newValue: { provider, provider_asset_id: providerAssetId, status: 'uploaded' },
            });
            return { ok: true, id, state: 'uploaded' };
        },

        getAsset: async (tenantId, assetId) => {
            const safeTenant = typeof tenantId === 'string' ? tenantId.trim() : '';
            const safeId = normalizeAssetId(assetId);
            if (!safeTenant || !safeId) return null;
            return store.findAssetById(safeId, safeTenant);
        },

        beginProcessing: async (tenantId, assetId) => {
            const safeTenant = typeof tenantId === 'string' ? tenantId.trim() : '';
            const safeId = normalizeAssetId(assetId);
            if (!safeTenant || !safeId) return { ok: false, reason: 'not-found' };

            const asset = await store.findAssetById(safeId, safeTenant);
            if (!asset) return { ok: false, reason: 'not-found' };
            if (asset.deadLettered) return { ok: false, reason: 'dead-lettered', from: asset.status };

            if (asset.status === 'failed') {
                const outcome = evaluateFailureOutcome(asset.attempts, asset.maxAttempts);
                if (!outcome.retry) {
                    // Retry budget already spent: seal the dead-letter instead
                    // of granting another attempt.
                    await applyAssetUpdate(store, asset, {
                        status: 'failed',
                        attempts: asset.attempts,
                        lastError: asset.lastError,
                        deadLettered: true,
                        deadLetterReason: outcome.reason,
                    });
                    await audit({
                        actorUserId: asset.ownerUserId,
                        tenantId: asset.tenantId,
                        action: 'video.asset.dead_lettered',
                        resourceType: 'video_asset',
                        resourceId: asset.id,
                        reason: outcome.reason,
                    });
                    return { ok: false, reason: 'retry-exhausted', from: asset.status };
                }
            }

            const decision = evaluateAssetTransition(asset.status, 'processing');
            if (!decision.allowed) return { ok: false, reason: 'illegal-transition', from: asset.status };
            if (decision.idempotent) {
                return { ok: true, state: 'processing', attempts: asset.attempts, deadLettered: asset.deadLettered };
            }

            const attempts = asset.attempts + 1;
            const updated = await applyAssetUpdate(store, asset, {
                status: 'processing',
                attempts,
                lastError: null,
                deadLettered: false,
                deadLetterReason: null,
            });
            if (!updated) return { ok: false, reason: 'conflict', from: asset.status };
            await audit({
                actorUserId: asset.ownerUserId,
                tenantId: asset.tenantId,
                action: 'video.asset.processing_started',
                resourceType: 'video_asset',
                resourceId: asset.id,
                oldValue: { status: asset.status, attempts: asset.attempts },
                newValue: { status: 'processing', attempts },
            });
            return { ok: true, state: 'processing', attempts, deadLettered: false };
        },

        applyProviderCallback: async (callback) => {
            const provider = normalizeProviderKey(callback.provider);
            const callbackId = normalizeProviderKey(callback.callbackId);
            const providerAssetId = normalizeProviderKey(callback.providerAssetId);
            const targetState = normalizeAssetState(callback.targetState);
            const tenantClaim = typeof callback.tenantId === 'string' && callback.tenantId.trim() ? callback.tenantId.trim() : null;

            // 1. Signature first: an unverified callback is never trusted, and
            //    the rejection is recorded for investigation.
            let verified = false;
            try {
                verified = Boolean(await deps.verifyCallbackSignature(callback));
            } catch {
                verified = false;
            }
            if (!verified) {
                await audit({
                    actorUserId: null,
                    tenantId: tenantClaim,
                    action: 'video.asset.callback_ignored',
                    resourceType: 'video_asset',
                    resourceId: providerAssetId ?? 'unknown',
                    reason: 'unverified_signature',
                });
                return { status: 'ignored', reason: 'unverified-signature' };
            }

            if (!provider || !callbackId || !providerAssetId || targetState === null) {
                await audit({
                    actorUserId: null,
                    tenantId: tenantClaim,
                    action: 'video.asset.callback_ignored',
                    resourceType: 'video_asset',
                    resourceId: providerAssetId ?? 'unknown',
                    reason: targetState === null ? 'unknown_target_state' : 'malformed_callback',
                });
                return { status: 'ignored', reason: targetState === null ? 'unknown-target-state' : 'unknown-asset' };
            }

            const asset = await store.findAssetByProvider(provider, providerAssetId);
            if (!asset) {
                await audit({
                    actorUserId: null,
                    tenantId: tenantClaim,
                    action: 'video.asset.callback_ignored',
                    resourceType: 'video_asset',
                    resourceId: providerAssetId,
                    reason: 'unknown_asset',
                });
                return { status: 'ignored', reason: 'unknown-asset' };
            }

            // 2. Tenant attribution from server rows: a signed claim that
            //    disagrees with the stored row is rejected, never applied.
            if (tenantClaim !== null && tenantClaim !== asset.tenantId) {
                await audit({
                    actorUserId: null,
                    tenantId: asset.tenantId,
                    action: 'video.asset.callback_rejected',
                    resourceType: 'video_asset',
                    resourceId: asset.id,
                    reason: 'cross_tenant',
                });
                return { status: 'rejected', reason: 'cross-tenant', from: asset.status };
            }

            // 3. Idempotency: the callback ledger's unique key absorbs replays.
            const recorded = await store.insertCallback({
                id: idFactory(),
                tenantId: asset.tenantId,
                assetId: asset.id,
                provider,
                callbackId,
                targetState,
                outcome: 'pending',
                detail: callback.detail ?? callback.error ?? null,
            });
            if (!recorded) return { status: 'duplicate', state: asset.status };

            const decision = evaluateAssetTransition(asset.status, targetState);
            if (!decision.allowed) {
                await audit({
                    actorUserId: null,
                    tenantId: asset.tenantId,
                    action: 'video.asset.callback_rejected',
                    resourceType: 'video_asset',
                    resourceId: asset.id,
                    reason: 'illegal_transition',
                    oldValue: { status: asset.status },
                    newValue: { status: targetState },
                });
                return { status: 'rejected', reason: 'illegal-transition', from: asset.status };
            }
            if (decision.idempotent) return { status: 'duplicate', state: asset.status };

            let deadLettered = asset.deadLettered;
            let deadLetterReason = asset.deadLetterReason;
            let lastError = asset.lastError;
            if (targetState === 'failed') {
                lastError = (callback.error ?? callback.detail ?? 'provider_failed').slice(0, 500);
                const outcome = evaluateFailureOutcome(asset.attempts, asset.maxAttempts);
                if (!outcome.retry) {
                    deadLettered = true;
                    deadLetterReason = outcome.reason;
                }
            } else if (targetState === 'ready') {
                lastError = null;
            }

            const updated = await applyAssetUpdate(store, asset, {
                status: targetState,
                attempts: asset.attempts,
                lastError,
                deadLettered,
                deadLetterReason,
            });
            if (!updated) return { status: 'rejected', reason: 'conflict', from: asset.status };

            await audit({
                actorUserId: null,
                tenantId: asset.tenantId,
                action: deadLettered ? 'video.asset.dead_lettered' : 'video.asset.callback_applied',
                resourceType: 'video_asset',
                resourceId: asset.id,
                oldValue: { status: asset.status },
                newValue: { status: targetState },
                reason: deadLetterReason ?? undefined,
            });

            // Storage metering is bound to the existing lifecycle boundary: the
            // asset is `ready` and the byte size came from the verified payload.
            // The state commit above already happened, so a metering failure is
            // reported as `deferred` (and audited) instead of rolling back the
            // asset. Reconciliation detects the resulting gap; the durable
            // outbox that would close it is the I2 item in the delivery note.
            let metering: MeteringOutcome | null = null;
            if (targetState === 'ready' && typeof callback.storageBytes === 'number') {
                if (!deps.meterStorage) {
                    // No durable meter is composed (the transition ledger does
                    // not exist yet — I2). A verified byte count that cannot be
                    // recorded is an explicit, auditable gap; it must never look
                    // like a successful measurement or vanish silently.
                    metering = 'unconfigured';
                    await audit({
                        actorUserId: null,
                        tenantId: asset.tenantId,
                        action: 'video.asset.metering_unconfigured',
                        resourceType: 'video_asset',
                        resourceId: asset.id,
                        reason: 'meter_not_configured',
                        newValue: { storage_bytes: callback.storageBytes },
                    });
                    await recordMeteringGap(asset, callback.storageBytes, callback.callbackId, 'metering_unconfigured');
                } else {
                    try {
                        const metered = await deps.meterStorage.recordVerifiedBytes({
                            tenantId: asset.tenantId,
                            assetId: asset.id,
                            resultingBytes: callback.storageBytes,
                            operationId: callback.callbackId,
                            source: 'provider-callback',
                            occurredAtMs: now().getTime(),
                        });
                        if ('error' in metered) {
                            metering = 'deferred';
                            await audit({
                                actorUserId: null,
                                tenantId: asset.tenantId,
                                action: 'video.asset.metering_deferred',
                                resourceType: 'video_asset',
                                resourceId: asset.id,
                                reason: metered.error,
                            });
                            await recordMeteringGap(asset, callback.storageBytes, callback.callbackId, 'metering_deferred');
                        } else {
                            metering = metered.recorded ? 'recorded' : 'deduplicated';
                        }
                    } catch {
                        metering = 'deferred';
                        await audit({
                            actorUserId: null,
                            tenantId: asset.tenantId,
                            action: 'video.asset.metering_deferred',
                            resourceType: 'video_asset',
                            resourceId: asset.id,
                            reason: 'metering_error',
                        });
                        await recordMeteringGap(asset, callback.storageBytes, callback.callbackId, 'metering_deferred');
                    }
                }
            }

            return {
                status: 'applied',
                state: targetState,
                attempts: asset.attempts,
                deadLettered,
                ...(metering === null ? {} : { metering }),
            };
        },
    };
}

async function applyAssetUpdate(
    store: VideoAssetStore,
    asset: VideoAssetRecord,
    update: Omit<AssetUpdate, 'expectedStatus'>,
): Promise<boolean> {
    const affected = await store.updateAsset(asset.id, asset.tenantId, {
        ...update,
        expectedStatus: asset.status,
    });
    return affected > 0;
}

/* =========================================================================
 * SQL adapter (production wiring)
 * ========================================================================= */

export interface VideoAssetDb {
    query: <T = unknown>(sql: string, params?: unknown[]) => Promise<T[]>;
    queryOne: <T = unknown>(sql: string, params?: unknown[]) => Promise<T | null>;
    execute: (sql: string, params?: unknown[]) => Promise<{ insertId?: number; affectedRows?: number }>;
}

/** Duplicate-key recognition without importing the MySQL driver. */
export function isDuplicateEntryError(error: unknown): boolean {
    if (!error || typeof error !== 'object') return false;
    return (error as { code?: unknown }).code === 'ER_DUP_ENTRY';
}

interface VideoAssetRow {
    id: string;
    tenant_id: string;
    owner_user_id: string;
    provider: string;
    provider_asset_id: string;
    title: string;
    status: string;
    attempts: number;
    max_attempts: number;
    last_error: string | null;
    dead_lettered: number | boolean;
    dead_letter_reason: string | null;
}

function mapAssetRow(row: VideoAssetRow): VideoAssetRecord | null {
    const status = normalizeAssetState(row.status);
    if (!status) return null;
    return {
        id: row.id,
        tenantId: row.tenant_id,
        ownerUserId: row.owner_user_id,
        provider: row.provider,
        providerAssetId: row.provider_asset_id,
        title: row.title,
        status,
        attempts: Number(row.attempts ?? 0),
        maxAttempts: normalizeMaxAttempts(row.max_attempts),
        lastError: row.last_error ?? null,
        deadLettered: Boolean(row.dead_lettered),
        deadLetterReason: row.dead_letter_reason ?? null,
    };
}

const ASSET_COLUMNS = `id, tenant_id, owner_user_id, provider, provider_asset_id, title,
    status, attempts, max_attempts, last_error, dead_lettered, dead_letter_reason`;

export function createSqlVideoAssetStore(db: VideoAssetDb): VideoAssetStore {
    return {
        insertAsset: async (row) => {
            await db.execute(
                `INSERT INTO video_assets
                   (id, tenant_id, owner_user_id, provider, provider_asset_id, title, status, attempts, max_attempts)
                 VALUES (?, ?, ?, ?, ?, ?, 'uploaded', 0, ?)`,
                [row.id, row.tenantId, row.ownerUserId, row.provider, row.providerAssetId, row.title, row.maxAttempts],
            );
        },

        findAssetById: async (id, tenantId) => {
            const row = await db.queryOne<VideoAssetRow>(
                `SELECT ${ASSET_COLUMNS} FROM video_assets WHERE id = ? AND tenant_id = ? LIMIT 1`,
                [id, tenantId],
            );
            return row ? mapAssetRow(row) : null;
        },

        findAssetByProvider: async (provider, providerAssetId) => {
            const row = await db.queryOne<VideoAssetRow>(
                `SELECT ${ASSET_COLUMNS} FROM video_assets WHERE provider = ? AND provider_asset_id = ? LIMIT 1`,
                [provider, providerAssetId],
            );
            return row ? mapAssetRow(row) : null;
        },

        updateAsset: async (id, tenantId, update) => {
            const result = await db.execute(
                `UPDATE video_assets
                 SET status = ?, attempts = ?, last_error = ?, dead_lettered = ?, dead_letter_reason = ?, updated_at = UTC_TIMESTAMP()
                 WHERE id = ? AND tenant_id = ? AND status = ?`,
                [
                    update.status,
                    update.attempts,
                    update.lastError,
                    update.deadLettered ? 1 : 0,
                    update.deadLetterReason,
                    id,
                    tenantId,
                    update.expectedStatus,
                ],
            );
            return result.affectedRows ?? 0;
        },

        insertCallback: async (row) => {
            try {
                await db.execute(
                    `INSERT INTO video_asset_callbacks
                       (id, tenant_id, asset_id, provider, callback_id, target_state, outcome, detail)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                    [row.id, row.tenantId, row.assetId, row.provider, row.callbackId, row.targetState, row.outcome, row.detail],
                );
                return true;
            } catch (error) {
                if (isDuplicateEntryError(error)) return false;
                throw error;
            }
        },

        recordAudit: async (input) => {
            await recordAudit(db.execute, input);
        },
    };
}

/* =========================================================================
 * W4-R2 — traceable, version-exact object cleanup
 * =========================================================================
 *
 * The production object store declares `conditionalDelete: false` today, which
 * means it CANNOT prove it deleted one exact version. Three rules follow, and
 * this section encodes all three instead of pretending:
 *
 *  1. a delete is only ever attempted against an EXACT version id. There is no
 *     "delete by key" path at all: a mutable key can address a replacement that
 *     was written after the decision, and deleting that would destroy the
 *     current object while claiming to clean the old one;
 *  2. when the adapter cannot prove an exact-version delete, the request is
 *     stored as `blocked-capability` and the bytes are LEFT IN PLACE. That is a
 *     safe, queryable, auditable state — not a completed cleanup;
 *  3. `deleted` is only written when the store answered for that version
 *     (`version-deleted`, or `version-absent` when it proved the version is
 *     already gone). A generic success is not accepted as proof.
 *
 * The rows are durable by contract (`video_object_cleanups` in the delivery
 * note's I2 request); this module ships the port, the service and a reference
 * adapter, and no SQL against a table that does not exist yet.
 */

export interface ObjectStoreCapability {
    /** True only when the store can delete one EXACT object version. */
    conditionalDelete: boolean;
    /** True when the bucket keeps versions at all. */
    versioning: boolean;
}

export type CleanupState = 'pending' | 'deleted' | 'blocked-capability' | 'failed';

export type CleanupEvidence = 'version-deleted' | 'version-absent' | null;

export interface ObjectCleanupRow {
    id: string;
    tenantId: string;
    assetId: string;
    objectKey: string;
    objectVersionId: string | null;
    state: CleanupState;
    evidence: CleanupEvidence;
    attempts: number;
    lastError: string | null;
    requestedAtMs: number;
    lastAttemptAtMs: number | null;
    deletedAtMs: number | null;
}

export type VersionDeleteResult = 'deleted' | 'not-found' | 'unsupported' | 'failed';

export interface ObjectVersionStore {
    capability(): Promise<ObjectStoreCapability>;
    /** MUST delete exactly this version, or answer that it cannot. */
    deleteObjectVersion(objectKey: string, versionId: string): Promise<VersionDeleteResult>;
    /** Deduplicated on (tenant_id, object_key, object_version_id). */
    insertCleanup(row: ObjectCleanupRow): Promise<{ created: boolean; duplicate: boolean }>;
    findCleanup(id: string): Promise<ObjectCleanupRow | null>;
    updateCleanup(row: ObjectCleanupRow): Promise<void>;
    listCleanups(tenantId: string, state?: CleanupState): Promise<ObjectCleanupRow[]>;
    recordAudit(input: AuditRecordInput): Promise<void>;
}

export const DEFAULT_CLEANUP_MAX_ATTEMPTS = 5;
export const DEFAULT_CLEANUP_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const OBJECT_KEY_MAX_LENGTH = 1024;

export function normalizeObjectKey(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (!trimmed || trimmed.length > OBJECT_KEY_MAX_LENGTH) return null;
    if (trimmed.startsWith('/') || trimmed.includes('\\')) return null;
    if (trimmed.split('/').some((segment) => segment === '..' || segment === '.' || segment === '')) return null;
    return trimmed;
}

export type CleanupRequestResult =
    | { ok: true; id: string; state: CleanupState }
    | { ok: false; reason: 'invalid-input' };

export interface CleanupAttemptResult {
    state: CleanupState;
    evidence: CleanupEvidence;
}

export interface CleanupReconciliation {
    tenantId: string;
    checkedAtMs: number;
    counts: Record<CleanupState, number>;
    /** Pending requests older than the retention window. */
    stale: Array<{ id: string; assetId: string; requestedAtMs: number }>;
    /** Blocked requests: bytes deliberately left in place. */
    blocked: Array<{ id: string; assetId: string; reason: string | null }>;
    /** Explicit: reconciliation is a report, never a repair. */
    mutated: false;
}

export interface ObjectCleanupService {
    request(input: {
        tenantId: string;
        assetId: string;
        objectKey: string;
        objectVersionId: string | null | undefined;
    }): Promise<CleanupRequestResult>;
    attempt(id: string, opts?: { maxAttempts?: number; nowMs?: number }): Promise<CleanupAttemptResult | null>;
    reconcile(input: {
        tenantId: string;
        retentionMs?: number;
        nowMs?: number;
    }): Promise<CleanupReconciliation>;
}

export interface ObjectCleanupDeps {
    store: ObjectVersionStore;
    now?: () => number;
    idFactory?: () => string;
    maxAttempts?: number;
}

export function createObjectCleanupService(deps: ObjectCleanupDeps): ObjectCleanupService {
    const store = deps.store;
    const now = deps.now ?? ((): number => Date.now());
    const idFactory = deps.idFactory ?? randomUUID;
    const configuredMax = Math.max(1, Math.trunc(deps.maxAttempts ?? DEFAULT_CLEANUP_MAX_ATTEMPTS));

    return {
        request: async (input) => {
            const tenantId = typeof input.tenantId === 'string' ? input.tenantId.trim() : '';
            const assetId = normalizeAssetId(input.assetId);
            const objectKey = normalizeObjectKey(input.objectKey);
            if (!tenantId || !assetId || !objectKey) return { ok: false, reason: 'invalid-input' };

            const versionId = typeof input.objectVersionId === 'string' && input.objectVersionId.trim()
                ? input.objectVersionId.trim().slice(0, 128)
                : null;
            const capability = await store.capability();
            const at = now();

            // No version, or a store that cannot prove one: record the request
            // as blocked and delete NOTHING. Never a mutable-key delete.
            const blockedReason = versionId === null
                ? 'no_object_version'
                : capability.conditionalDelete === false
                    ? 'conditional_delete_unsupported'
                    : null;

            const row: ObjectCleanupRow = {
                id: idFactory(),
                tenantId,
                assetId,
                objectKey,
                objectVersionId: versionId,
                state: blockedReason === null ? 'pending' : 'blocked-capability',
                evidence: null,
                attempts: 0,
                lastError: blockedReason,
                requestedAtMs: at,
                lastAttemptAtMs: null,
                deletedAtMs: null,
            };
            const inserted = await store.insertCleanup(row);
            await store.recordAudit({
                actorUserId: null,
                tenantId,
                action: inserted.created ? 'video.asset.cleanup_requested' : 'video.asset.cleanup_deduplicated',
                resourceType: 'video_asset_cleanup',
                resourceId: row.id,
                newValue: {
                    asset_id: assetId,
                    object_key: objectKey,
                    object_version_id: versionId,
                    state: row.state,
                    reason: blockedReason,
                },
            });
            return { ok: true, id: row.id, state: row.state };
        },

        attempt: async (id, opts) => {
            const row = await store.findCleanup(id);
            if (!row) return null;
            // Only a pending row may be attempted; a blocked or deleted row is
            // returned as-is so the caller sees the real state.
            if (row.state !== 'pending') return { state: row.state, evidence: row.evidence };
            if (!row.objectVersionId) {
                const blocked: ObjectCleanupRow = {
                    ...row,
                    state: 'blocked-capability',
                    lastError: 'no_object_version',
                };
                await store.updateCleanup(blocked);
                return { state: blocked.state, evidence: null };
            }

            const capability = await store.capability();
            const at = opts?.nowMs !== undefined && Number.isFinite(opts.nowMs) ? Math.trunc(opts.nowMs) : now();
            if (capability.conditionalDelete === false) {
                const blocked: ObjectCleanupRow = {
                    ...row,
                    state: 'blocked-capability',
                    lastError: 'conditional_delete_unsupported',
                    lastAttemptAtMs: at,
                };
                await store.updateCleanup(blocked);
                await store.recordAudit({
                    actorUserId: null,
                    tenantId: row.tenantId,
                    action: 'video.asset.cleanup_blocked',
                    resourceType: 'video_asset_cleanup',
                    resourceId: row.id,
                    reason: 'conditional_delete_unsupported',
                    newValue: { object_version_id: row.objectVersionId },
                });
                return { state: blocked.state, evidence: null };
            }

            const maxAttempts = Math.max(1, Math.trunc(opts?.maxAttempts ?? configuredMax));
            let result: VersionDeleteResult;
            try {
                result = await store.deleteObjectVersion(row.objectKey, row.objectVersionId);
            } catch {
                result = 'failed';
            }

            if (result === 'deleted' || result === 'not-found') {
                const done: ObjectCleanupRow = {
                    ...row,
                    state: 'deleted',
                    evidence: result === 'deleted' ? 'version-deleted' : 'version-absent',
                    lastError: null,
                    lastAttemptAtMs: at,
                    deletedAtMs: at,
                };
                await store.updateCleanup(done);
                await store.recordAudit({
                    actorUserId: null,
                    tenantId: row.tenantId,
                    action: 'video.asset.cleanup_deleted',
                    resourceType: 'video_asset_cleanup',
                    resourceId: row.id,
                    newValue: { object_version_id: row.objectVersionId, evidence: done.evidence },
                });
                return { state: done.state, evidence: done.evidence };
            }

            const attempts = row.attempts + 1;
            const next: ObjectCleanupRow = result === 'unsupported'
                ? {
                    ...row,
                    state: 'blocked-capability',
                    lastError: 'conditional_delete_unsupported',
                    attempts,
                    lastAttemptAtMs: at,
                }
                : {
                    ...row,
                    state: attempts >= maxAttempts ? 'failed' : 'pending',
                    lastError: result === 'failed' ? 'delete_failed' : null,
                    attempts,
                    lastAttemptAtMs: at,
                };
            await store.updateCleanup(next);
            await store.recordAudit({
                actorUserId: null,
                tenantId: row.tenantId,
                action: 'video.asset.cleanup_failed',
                resourceType: 'video_asset_cleanup',
                resourceId: row.id,
                reason: next.lastError ?? result,
                newValue: { attempts, state: next.state },
            });
            return { state: next.state, evidence: null };
        },

        reconcile: async (input) => {
            const tenantId = typeof input.tenantId === 'string' ? input.tenantId.trim() : '';
            if (!tenantId) throw new Error('tenant_id is required');
            const retentionMs = Math.max(0, Math.trunc(input.retentionMs ?? DEFAULT_CLEANUP_RETENTION_MS));
            const checkedAtMs = input.nowMs !== undefined && Number.isFinite(input.nowMs)
                ? Math.trunc(input.nowMs)
                : now();
            const rows = await store.listCleanups(tenantId);
            const counts: Record<CleanupState, number> = {
                pending: 0,
                deleted: 0,
                'blocked-capability': 0,
                failed: 0,
            };
            const stale: CleanupReconciliation['stale'] = [];
            const blocked: CleanupReconciliation['blocked'] = [];
            for (const row of rows) {
                counts[row.state] += 1;
                if (row.state === 'pending' && checkedAtMs - row.requestedAtMs > retentionMs) {
                    stale.push({ id: row.id, assetId: row.assetId, requestedAtMs: row.requestedAtMs });
                }
                if (row.state === 'blocked-capability') {
                    blocked.push({ id: row.id, assetId: row.assetId, reason: row.lastError });
                }
            }
            return { tenantId, checkedAtMs, counts, stale, blocked, mutated: false };
        },
    };
}

export interface InMemoryObjectVersionStore extends ObjectVersionStore {
    readonly rows: ObjectCleanupRow[];
    readonly audits: AuditRecordInput[];
    /** Seed an object version; `conditionalDelete` models the real capability. */
    seed(objectKey: string, versionId: string): void;
    setCapability(capability: ObjectStoreCapability): void;
}

/**
 * A real adapter: it stores rows, enforces the dedupe key, and deletes only an
 * exact seeded version. `conditionalDelete: false` makes `deleteObjectVersion`
 * answer `unsupported` — the same honest refusal the production MinIO adapter
 * has to give today.
 */
export function createInMemoryObjectVersionStore(
    initial: ObjectStoreCapability = { conditionalDelete: true, versioning: true },
): InMemoryObjectVersionStore {
    const rows: ObjectCleanupRow[] = [];
    const audits: AuditRecordInput[] = [];
    const objects = new Map<string, string>();
    const keys = new Set<string>();
    let capability = initial;

    return {
        rows,
        audits,
        seed: (objectKey, versionId) => {
            objects.set(`${objectKey}\u0000${versionId}`, versionId);
        },
        setCapability: (next) => {
            capability = next;
        },
        capability: async () => capability,
        deleteObjectVersion: async (objectKey, versionId) => {
            if (!capability.conditionalDelete) return 'unsupported';
            const key = `${objectKey}\u0000${versionId}`;
            if (!objects.has(key)) return 'not-found';
            objects.delete(key);
            return 'deleted';
        },
        insertCleanup: async (row) => {
            const key = `${row.tenantId}\u0000${row.objectKey}\u0000${row.objectVersionId ?? '*'}`;
            if (keys.has(key)) return { created: false, duplicate: true };
            keys.add(key);
            rows.push({ ...row });
            return { created: true, duplicate: false };
        },
        findCleanup: async (id) => {
            const row = rows.find((entry) => entry.id === id);
            return row ? { ...row } : null;
        },
        updateCleanup: async (row) => {
            const index = rows.findIndex((entry) => entry.id === row.id);
            if (index >= 0) rows[index] = { ...row };
        },
        listCleanups: async (tenantId, state) => rows
            .filter((row) => row.tenantId === tenantId && (state === undefined || row.state === state))
            .map((row) => ({ ...row })),
        recordAudit: async (input) => {
            audits.push(input);
        },
    };
}

/* =========================================================================
 * Phase 6 — idempotent library promotion (`RecordingLibraryPort` adapter)
 * =========================================================================
 *
 * The ingest's own ledger dedupe is NOT library idempotency: it decides whether
 * an EVENT was already handled, not whether the RECORDING already has an asset.
 * A second event naming the same recording, and a retried ingest whose ledger
 * row is still `pending`, both call this adapter again. So the dedupe has to
 * live on the row it creates.
 *
 * The row is `video_assets` (migration `20261018_06`, read-only ground truth):
 *
 *     id CHAR(36) PK, tenant_id CHAR(36), owner_user_id CHAR(36) NOT NULL,
 *     provider VARCHAR(128), provider_asset_id VARCHAR(128),
 *     title VARCHAR(200), status ENUM(...) DEFAULT 'uploaded',
 *     UNIQUE KEY uq_video_asset_provider (provider, provider_asset_id)
 *
 * That unique key is GLOBAL, not tenant-scoped. Two consequences, both handled
 * here instead of papered over:
 *
 *  1. it is the only available idempotency guard, so a repeated promotion is
 *     resolved by attempting the insert and reading the winner back — never by
 *     a pre-read (which would race) and never by `INSERT ... ON DUPLICATE KEY
 *     UPDATE` (which would let a second tenant overwrite the first tenant's
 *     title and, worse, return a row it does not own);
 *  2. it cannot represent "the same recording id in two tenants". Tenant B
 *     therefore cannot insert an id tenant A already owns. That is a SCHEMA
 *     defect, so it fails closed with a typed error; the ingest's existing
 *     catch turns it into `library: 'deferred'` and the marker stays `pending`.
 *     Another tenant's `assetId` is never returned and the row is never
 *     overwritten.
 *
 * What this adapter deliberately does NOT do:
 *  - no publication: `status` is left at its column default `'uploaded'`, no
 *    `ready`, no entitlement, no visibility. `accessPolicy: 'deny'` /
 *    `visibility: 'unpublished'` stay the ingest's decision, and this table has
 *    no visibility column to write (see the DDL request in the hand-off);
 *  - no DDL, no migration, no schema change of any kind;
 *  - no db/pool import, no connection opened here, no statement at import time
 *    and no top-level side effect: the caller injects a connection-bound runner;
 *  - no invented owner. `owner_user_id` is `NOT NULL` and the recording
 *    descriptor does not carry an owner, so a descriptor without one is refused
 *    (`owner_missing`) rather than filled with a tenant id, a sentinel or the
 *    session id. That refusal is reported as a contract/schema request.
 *
 * No `any`, no ts-ignore, no network, no runtime DDL.
 */

/**
 * Typed promotion failure. The ingest treats ANY throw from
 * `createRecordingAsset` as `library: 'deferred'` (marker stays `pending`), so
 * the code exists for the operator and the audit trail, not for control flow.
 */
export type RecordingLibraryErrorCode =
    /** Missing/blank tenant, provider or provider recording id shape. */
    | 'invalid_descriptor'
    /** `providerRecordingId` cannot be represented in VARCHAR(128) — never truncated. */
    | 'unrepresentable_key'
    /** `owner_user_id` is NOT NULL and the descriptor carries no owner. */
    | 'owner_missing'
    /**
     * The existing asset for this recording is filed for a DIFFERENT owner.
     * Charging storage against it would bill another person for this recording,
     * so the promotion refuses instead of answering with that id.
     */
    | 'owner_mismatch'
    /** The global unique key is held by a DIFFERENT tenant. Fail closed. */
    | 'cross_tenant_collision'
    /** The key matched a row that is not this exact recording (collation). */
    | 'key_collision'
    /** A duplicate was reported but the winner could not be read back. */
    | 'unresolved_duplicate'
    /** The injected runner does not provide the required connection-bound unit. */
    | 'invalid_deps';

export class RecordingLibraryPromotionError extends Error {
    constructor(public readonly code: RecordingLibraryErrorCode, message: string) {
        super(message);
        this.name = 'RecordingLibraryPromotionError';
    }
}

/** ONE connection. The read-back must see the insert's winner on this handle. */
export interface RecordingLibraryConnection {
    queryOne<T = unknown>(sql: string, params?: readonly unknown[]): Promise<T | null>;
    execute(sql: string, params?: readonly unknown[]): Promise<{ affectedRows?: number }>;
}

/**
 * The transaction runner: BEGIN/COMMIT on one pooled connection, ROLLBACK and
 * rethrow on a throw, and hand that same connection to `work`. This adapter
 * never owns a pool and never retries. `transaction` is required (not optional)
 * because the duplicate path must read back on the connection that took the
 * duplicate-key lock; a pooled read could miss an uncommitted winner and would
 * make "no row found" indistinguishable from "someone else's row".
 */
export interface RecordingLibraryRunner extends RecordingLibraryConnection {
    transaction<T>(work: (conn: RecordingLibraryConnection) => Promise<T>): Promise<T>;
}

/**
 * The descriptor fields this adapter reads. Structurally a SUPERTYPE of the
 * ingest's `RecordingAssetDescriptor`, so the returned port is assignable to
 * `RecordingLibraryPort` (contravariant parameters) without importing the
 * ingest module — that file is owned by another worker and is not a dependency
 * of this one.
 *
 * `ownerUserId` is optional HERE because today's descriptor does not carry it;
 * an absent value is a refusal, not a default.
 */
export interface RecordingLibraryDescriptor {
    tenantId: string;
    provider: string;
    providerRecordingId: string;
    title?: string | null;
    ownerUserId?: string | null;
}

export interface RecordingLibraryPromotionPort {
    /**
     * The answer carries the facts the METER needs, not just the id: the tenant
     * the row is filed under and the owner it is filed for. The ingest compares
     * both with the callback's own facts before charging storage, so an asset
     * that the unique key handed back must still be THIS recording's asset.
     */
    createRecordingAsset(
        descriptor: RecordingLibraryDescriptor,
    ): Promise<{ created: boolean; assetId: string; tenantId: string; ownerUserId: string }>;
}

interface RecordingLibraryAssetRow {
    id: string;
    tenant_id: string;
    owner_user_id: string;
    provider: string;
    provider_asset_id: string;
}

/**
 * The promotion insert. Exactly the six columns this module owns; `status`
 * falls to the column default `'uploaded'` and `attempts` / `max_attempts` to
 * theirs, so promotion cannot publish or arm a retry budget.
 */
const RECORDING_LIBRARY_INSERT = `INSERT INTO video_assets
   (id, tenant_id, owner_user_id, provider, provider_asset_id, title)
 VALUES (?, ?, ?, ?, ?, ?)`;

/**
 * Read-back on the SAME connection. The predicate is the unique key's own
 * columns, which is what makes the answer unambiguous. It selects only the
 * columns needed to PROVE ownership — nothing is returned that the caller could
 * mistake for a published asset.
 */
const RECORDING_LIBRARY_READBACK = `SELECT id, tenant_id, owner_user_id, provider, provider_asset_id
   FROM video_assets
  WHERE provider = ? AND provider_asset_id = ?
  LIMIT 1`;

/**
 * Build the library promotion port.
 *
 * Idempotent on `(tenantId, provider, providerRecordingId)`:
 *  - first promotion inserts one row and answers `{created: true, assetId}`;
 *  - a repeat in the same tenant hits `ER_DUP_ENTRY`, proves the winner belongs
 *    to the same tenant and answers `{created: false, assetId: existing.id}`;
 *  - a repeat in another tenant throws `cross_tenant_collision` — never the
 *    other tenant's id.
 */
export function createRecordingLibraryPort(
    runner: RecordingLibraryRunner,
    idFactory: () => string = randomUUID,
): RecordingLibraryPromotionPort {
    if (
        !runner
        || typeof runner.transaction !== 'function'
        || typeof runner.execute !== 'function'
        || typeof runner.queryOne !== 'function'
    ) {
        throw new RecordingLibraryPromotionError(
            'invalid_deps',
            'a connection-bound runner with transaction/execute/queryOne is required',
        );
    }

    return {
        createRecordingAsset: async (descriptor) => {
            // `tenant_id` is CHAR(36). A longer value would be an error under
            // strict mode and a SILENT TRUNCATION under a loose one, which
            // would file the asset under a different tenant — refuse instead.
            const tenantId = typeof descriptor.tenantId === 'string' ? descriptor.tenantId.trim() : '';
            if (!tenantId || tenantId.length > 36) {
                throw new RecordingLibraryPromotionError('invalid_descriptor', 'tenant_id is required (CHAR(36))');
            }
            // Canonicalised with the SAME function the ingest and the callback
            // path use, so a promoted key and a callback lookup can never
            // disagree about what the key is.
            const provider = normalizeProviderKey(descriptor.provider);
            if (!provider) {
                throw new RecordingLibraryPromotionError(
                    'invalid_descriptor',
                    'provider is not representable in VARCHAR(128)',
                );
            }
            // NEVER truncated: a 129-char id cut to 128 would collide with a
            // different recording that legitimately ends in those 128 chars.
            const providerAssetId = normalizeProviderKey(descriptor.providerRecordingId);
            if (!providerAssetId) {
                throw new RecordingLibraryPromotionError(
                    'unrepresentable_key',
                    'provider_recording_id cannot be represented in provider_asset_id VARCHAR(128)',
                );
            }
            // NOT NULL in the schema, absent from the descriptor: refuse. A
            // tenant id or a sentinel here would attribute the asset to nobody
            // in particular and would be indistinguishable from a real owner.
            const ownerUserId = typeof descriptor.ownerUserId === 'string' ? descriptor.ownerUserId.trim() : '';
            if (!ownerUserId || ownerUserId.length > 36) {
                throw new RecordingLibraryPromotionError(
                    'owner_missing',
                    'owner_user_id is NOT NULL and the descriptor carries no owner',
                );
            }
            const title = (typeof descriptor.title === 'string' ? descriptor.title.trim() : '').slice(0, MAX_TITLE_LENGTH)
                || 'Untitled asset';
            const id = idFactory();

            return runner.transaction(async (conn) => {
                try {
                    await conn.execute(RECORDING_LIBRARY_INSERT, [id, tenantId, ownerUserId, provider, providerAssetId, title]);
                } catch (error) {
                    if (!isDuplicateEntryError(error)) throw error;

                    // The key is taken. Read the winner back ON THIS CONNECTION
                    // and prove it is ours before answering with its id. A plain
                    // SELECT is a consistent read, so it sees the row that made
                    // our INSERT fail (that row committed before the duplicate
                    // was reported), while it cannot see an unrelated tenant's
                    // uncommitted work.
                    const existing = await conn.queryOne<RecordingLibraryAssetRow>(
                        RECORDING_LIBRARY_READBACK,
                        [provider, providerAssetId],
                    );
                    if (!existing || typeof existing.id !== 'string' || !existing.id) {
                        // A duplicate we cannot attribute (e.g. the PK collided,
                        // or the winner vanished). Fail closed: no assetId.
                        throw new RecordingLibraryPromotionError(
                            'unresolved_duplicate',
                            'duplicate key could not be resolved to a video_assets row',
                        );
                    }
                    if (existing.tenant_id !== tenantId) {
                        // The global unique key is doing what the schema says:
                        // tenant B cannot own a recording id tenant A already
                        // owns. Never return A's id, never overwrite A's row.
                        throw new RecordingLibraryPromotionError(
                            'cross_tenant_collision',
                            'provider_recording_id is already owned by another tenant',
                        );
                    }
                    // `uq_video_asset_provider` is compared under the table's
                    // utf8mb4_unicode_ci collation, which is case- and
                    // accent-insensitive. If the stored key is not EXACTLY the
                    // one we sent, the unique index matched a DIFFERENT
                    // recording, so this is a collision, not a repeat.
                    if (existing.provider !== provider || existing.provider_asset_id !== providerAssetId) {
                        throw new RecordingLibraryPromotionError(
                            'key_collision',
                            'provider_asset_id matched a row with a different key under a case-insensitive collation',
                        );
                    }
                    // The row is this tenant's and the key is byte-identical, so
                    // it is genuinely the same recording. It must ALSO be filed
                    // for the same owner: storage is charged against an asset,
                    // and an asset owned by someone else is not this session's
                    // recording — the caller would be metering another person's
                    // storage. Refuse instead of answering with that id.
                    if (typeof existing.owner_user_id !== 'string' || existing.owner_user_id !== ownerUserId) {
                        throw new RecordingLibraryPromotionError(
                            'owner_mismatch',
                            'the existing asset for this recording is owned by a different user',
                        );
                    }
                    return {
                        created: false,
                        assetId: existing.id,
                        tenantId: existing.tenant_id,
                        ownerUserId: existing.owner_user_id,
                    };
                }
                return { created: true, assetId: id, tenantId, ownerUserId };
            });
        },
    };
}
