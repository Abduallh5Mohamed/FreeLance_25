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
