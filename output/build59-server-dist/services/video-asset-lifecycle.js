"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RecordingLibraryPromotionError = exports.DEFAULT_CLEANUP_RETENTION_MS = exports.DEFAULT_CLEANUP_MAX_ATTEMPTS = exports.MAX_ATTEMPTS_CEILING = exports.DEFAULT_MAX_ATTEMPTS = exports.ASSET_STATES = void 0;
exports.normalizeAssetState = normalizeAssetState;
exports.evaluateAssetTransition = evaluateAssetTransition;
exports.normalizeMaxAttempts = normalizeMaxAttempts;
exports.evaluateFailureOutcome = evaluateFailureOutcome;
exports.normalizeProviderKey = normalizeProviderKey;
exports.normalizeAssetId = normalizeAssetId;
exports.createVideoAssetLifecycle = createVideoAssetLifecycle;
exports.isDuplicateEntryError = isDuplicateEntryError;
exports.createSqlVideoAssetStore = createSqlVideoAssetStore;
exports.normalizeObjectKey = normalizeObjectKey;
exports.createObjectCleanupService = createObjectCleanupService;
exports.createInMemoryObjectVersionStore = createInMemoryObjectVersionStore;
exports.createRecordingLibraryPort = createRecordingLibraryPort;
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
const crypto_1 = require("crypto");
const audit_1 = require("../security/audit");
/* =========================================================================
 * Pure state machine
 * ========================================================================= */
exports.ASSET_STATES = ['uploaded', 'processing', 'ready', 'failed'];
function normalizeAssetState(value) {
    if (typeof value !== 'string')
        return null;
    return exports.ASSET_STATES.includes(value) ? value : null;
}
/**
 * Legal forward transitions. `ready` and `failed` are terminal for the
 * transition table itself; a `failed` asset may only re-enter `processing`
 * while it still has retry budget (enforced by the service, not this table).
 */
const LEGAL_TRANSITIONS = {
    uploaded: ['processing', 'failed'],
    processing: ['ready', 'failed'],
    failed: ['processing'],
    ready: [],
};
/**
 * Evaluate one transition. Repeating the current state is an idempotent no-op
 * (allowed, `idempotent: true`); any move absent from the table is rejected.
 */
function evaluateAssetTransition(from, to) {
    const fromState = normalizeAssetState(from);
    const toState = normalizeAssetState(to);
    if (fromState === null || toState === null)
        return { allowed: false, reason: 'unknown-state' };
    if (fromState === toState)
        return { allowed: true, idempotent: true };
    return LEGAL_TRANSITIONS[fromState].includes(toState)
        ? { allowed: true, idempotent: false }
        : { allowed: false, reason: 'illegal-transition' };
}
exports.DEFAULT_MAX_ATTEMPTS = 3;
exports.MAX_ATTEMPTS_CEILING = 10;
/** Bound the retry budget into [1, MAX_ATTEMPTS_CEILING]. */
function normalizeMaxAttempts(value) {
    const parsed = typeof value === 'number' ? Math.trunc(value) : Number.parseInt(String(value ?? ''), 10);
    if (!Number.isFinite(parsed))
        return exports.DEFAULT_MAX_ATTEMPTS;
    return Math.min(exports.MAX_ATTEMPTS_CEILING, Math.max(1, parsed));
}
/**
 * Decide whether a failed attempt may be retried. `attempts` is the number of
 * attempts ALREADY consumed; when it reaches the budget the asset is
 * dead-lettered instead of retried forever.
 */
function evaluateFailureOutcome(attempts, maxAttempts) {
    const consumed = Number.isFinite(attempts) && attempts > 0 ? Math.trunc(attempts) : 0;
    const budget = normalizeMaxAttempts(maxAttempts);
    return consumed < budget
        ? { retry: true }
        : { retry: false, deadLettered: true, reason: 'max_attempts_exceeded' };
}
const PROVIDER_KEY_RE = /^[A-Za-z0-9_.:-]{1,128}$/;
function normalizeProviderKey(value) {
    if (typeof value !== 'string')
        return null;
    const trimmed = value.trim();
    if (!trimmed || trimmed.length > 128)
        return null;
    return PROVIDER_KEY_RE.test(trimmed) ? trimmed : null;
}
const ASSET_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
function normalizeAssetId(value) {
    if (typeof value !== 'string')
        return null;
    const trimmed = value.trim();
    if (!trimmed || trimmed.length > 128)
        return null;
    return ASSET_ID_RE.test(trimmed) ? trimmed : null;
}
const MAX_TITLE_LENGTH = 200;
function createVideoAssetLifecycle(deps) {
    const idFactory = deps.idFactory ?? crypto_1.randomUUID;
    const now = deps.now ?? (() => new Date());
    const store = deps.store;
    const configuredMax = normalizeMaxAttempts(deps.maxAttempts ?? exports.DEFAULT_MAX_ATTEMPTS);
    const audit = async (input) => {
        await store.recordAudit(input);
    };
    /**
     * Persist a metering gap for replay. The enqueue is best-effort relative to
     * the asset commit (which already happened): a failure here is audited, and
     * the audit row stays the fallback evidence. It never throws into the
     * callback, because the state transition is already durable.
     */
    const recordMeteringGap = async (asset, bytes, operationId, reason) => {
        if (!deps.gapOutbox)
            return;
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
        }
        catch {
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
            if (!safeTenant || !safeId)
                return null;
            return store.findAssetById(safeId, safeTenant);
        },
        beginProcessing: async (tenantId, assetId) => {
            const safeTenant = typeof tenantId === 'string' ? tenantId.trim() : '';
            const safeId = normalizeAssetId(assetId);
            if (!safeTenant || !safeId)
                return { ok: false, reason: 'not-found' };
            const asset = await store.findAssetById(safeId, safeTenant);
            if (!asset)
                return { ok: false, reason: 'not-found' };
            if (asset.deadLettered)
                return { ok: false, reason: 'dead-lettered', from: asset.status };
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
            if (!decision.allowed)
                return { ok: false, reason: 'illegal-transition', from: asset.status };
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
            if (!updated)
                return { ok: false, reason: 'conflict', from: asset.status };
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
            }
            catch {
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
            if (!recorded)
                return { status: 'duplicate', state: asset.status };
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
            if (decision.idempotent)
                return { status: 'duplicate', state: asset.status };
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
            }
            else if (targetState === 'ready') {
                lastError = null;
            }
            const updated = await applyAssetUpdate(store, asset, {
                status: targetState,
                attempts: asset.attempts,
                lastError,
                deadLettered,
                deadLetterReason,
            });
            if (!updated)
                return { status: 'rejected', reason: 'conflict', from: asset.status };
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
            let metering = null;
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
                }
                else {
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
                        }
                        else {
                            metering = metered.recorded ? 'recorded' : 'deduplicated';
                        }
                    }
                    catch {
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
async function applyAssetUpdate(store, asset, update) {
    const affected = await store.updateAsset(asset.id, asset.tenantId, {
        ...update,
        expectedStatus: asset.status,
    });
    return affected > 0;
}
/** Duplicate-key recognition without importing the MySQL driver. */
function isDuplicateEntryError(error) {
    if (!error || typeof error !== 'object')
        return false;
    return error.code === 'ER_DUP_ENTRY';
}
function mapAssetRow(row) {
    const status = normalizeAssetState(row.status);
    if (!status)
        return null;
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
function createSqlVideoAssetStore(db) {
    return {
        insertAsset: async (row) => {
            await db.execute(`INSERT INTO video_assets
                   (id, tenant_id, owner_user_id, provider, provider_asset_id, title, status, attempts, max_attempts)
                 VALUES (?, ?, ?, ?, ?, ?, 'uploaded', 0, ?)`, [row.id, row.tenantId, row.ownerUserId, row.provider, row.providerAssetId, row.title, row.maxAttempts]);
        },
        findAssetById: async (id, tenantId) => {
            const row = await db.queryOne(`SELECT ${ASSET_COLUMNS} FROM video_assets WHERE id = ? AND tenant_id = ? LIMIT 1`, [id, tenantId]);
            return row ? mapAssetRow(row) : null;
        },
        findAssetByProvider: async (provider, providerAssetId) => {
            const row = await db.queryOne(`SELECT ${ASSET_COLUMNS} FROM video_assets WHERE provider = ? AND provider_asset_id = ? LIMIT 1`, [provider, providerAssetId]);
            return row ? mapAssetRow(row) : null;
        },
        updateAsset: async (id, tenantId, update) => {
            const result = await db.execute(`UPDATE video_assets
                 SET status = ?, attempts = ?, last_error = ?, dead_lettered = ?, dead_letter_reason = ?, updated_at = UTC_TIMESTAMP()
                 WHERE id = ? AND tenant_id = ? AND status = ?`, [
                update.status,
                update.attempts,
                update.lastError,
                update.deadLettered ? 1 : 0,
                update.deadLetterReason,
                id,
                tenantId,
                update.expectedStatus,
            ]);
            const affectedRows = result.affectedRows;
            if (typeof affectedRows !== 'number' || !Number.isSafeInteger(affectedRows)) {
                throw new Error('video-asset-lifecycle update did not report a usable affected-row count');
            }
            return affectedRows;
        },
        insertCallback: async (row) => {
            try {
                await db.execute(`INSERT INTO video_asset_callbacks
                       (id, tenant_id, asset_id, provider, callback_id, target_state, outcome, detail)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [row.id, row.tenantId, row.assetId, row.provider, row.callbackId, row.targetState, row.outcome, row.detail]);
                return true;
            }
            catch (error) {
                if (isDuplicateEntryError(error))
                    return false;
                throw error;
            }
        },
        recordAudit: async (input) => {
            await (0, audit_1.recordAudit)(db.execute, input);
        },
    };
}
exports.DEFAULT_CLEANUP_MAX_ATTEMPTS = 5;
exports.DEFAULT_CLEANUP_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const OBJECT_KEY_MAX_LENGTH = 1024;
function normalizeObjectKey(value) {
    if (typeof value !== 'string')
        return null;
    const trimmed = value.trim();
    if (!trimmed || trimmed.length > OBJECT_KEY_MAX_LENGTH)
        return null;
    if (trimmed.startsWith('/') || trimmed.includes('\\'))
        return null;
    if (trimmed.split('/').some((segment) => segment === '..' || segment === '.' || segment === ''))
        return null;
    return trimmed;
}
function createObjectCleanupService(deps) {
    const store = deps.store;
    const now = deps.now ?? (() => Date.now());
    const idFactory = deps.idFactory ?? crypto_1.randomUUID;
    const configuredMax = Math.max(1, Math.trunc(deps.maxAttempts ?? exports.DEFAULT_CLEANUP_MAX_ATTEMPTS));
    return {
        request: async (input) => {
            const tenantId = typeof input.tenantId === 'string' ? input.tenantId.trim() : '';
            const assetId = normalizeAssetId(input.assetId);
            const objectKey = normalizeObjectKey(input.objectKey);
            if (!tenantId || !assetId || !objectKey)
                return { ok: false, reason: 'invalid-input' };
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
            const row = {
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
            if (!row)
                return null;
            // Only a pending row may be attempted; a blocked or deleted row is
            // returned as-is so the caller sees the real state.
            if (row.state !== 'pending')
                return { state: row.state, evidence: row.evidence };
            if (!row.objectVersionId) {
                const blocked = {
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
                const blocked = {
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
            let result;
            try {
                result = await store.deleteObjectVersion(row.objectKey, row.objectVersionId);
            }
            catch {
                result = 'failed';
            }
            if (result === 'deleted' || result === 'not-found') {
                const done = {
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
            const next = result === 'unsupported'
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
            if (!tenantId)
                throw new Error('tenant_id is required');
            const retentionMs = Math.max(0, Math.trunc(input.retentionMs ?? exports.DEFAULT_CLEANUP_RETENTION_MS));
            const checkedAtMs = input.nowMs !== undefined && Number.isFinite(input.nowMs)
                ? Math.trunc(input.nowMs)
                : now();
            const rows = await store.listCleanups(tenantId);
            const counts = {
                pending: 0,
                deleted: 0,
                'blocked-capability': 0,
                failed: 0,
            };
            const stale = [];
            const blocked = [];
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
/**
 * A real adapter: it stores rows, enforces the dedupe key, and deletes only an
 * exact seeded version. `conditionalDelete: false` makes `deleteObjectVersion`
 * answer `unsupported` — the same honest refusal the production MinIO adapter
 * has to give today.
 */
function createInMemoryObjectVersionStore(initial = { conditionalDelete: true, versioning: true }) {
    const rows = [];
    const audits = [];
    const objects = new Map();
    const keys = new Set();
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
            if (!capability.conditionalDelete)
                return 'unsupported';
            const key = `${objectKey}\u0000${versionId}`;
            if (!objects.has(key))
                return 'not-found';
            objects.delete(key);
            return 'deleted';
        },
        insertCleanup: async (row) => {
            const key = `${row.tenantId}\u0000${row.objectKey}\u0000${row.objectVersionId ?? '*'}`;
            if (keys.has(key))
                return { created: false, duplicate: true };
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
            if (index >= 0)
                rows[index] = { ...row };
        },
        listCleanups: async (tenantId, state) => rows
            .filter((row) => row.tenantId === tenantId && (state === undefined || row.state === state))
            .map((row) => ({ ...row })),
        recordAudit: async (input) => {
            audits.push(input);
        },
    };
}
class RecordingLibraryPromotionError extends Error {
    constructor(code, message) {
        super(message);
        this.code = code;
        this.name = 'RecordingLibraryPromotionError';
    }
}
exports.RecordingLibraryPromotionError = RecordingLibraryPromotionError;
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
function createRecordingLibraryPort(runner, idFactory = crypto_1.randomUUID) {
    if (!runner
        || typeof runner.transaction !== 'function'
        || typeof runner.execute !== 'function'
        || typeof runner.queryOne !== 'function') {
        throw new RecordingLibraryPromotionError('invalid_deps', 'a connection-bound runner with transaction/execute/queryOne is required');
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
                throw new RecordingLibraryPromotionError('invalid_descriptor', 'provider is not representable in VARCHAR(128)');
            }
            // NEVER truncated: a 129-char id cut to 128 would collide with a
            // different recording that legitimately ends in those 128 chars.
            const providerAssetId = normalizeProviderKey(descriptor.providerRecordingId);
            if (!providerAssetId) {
                throw new RecordingLibraryPromotionError('unrepresentable_key', 'provider_recording_id cannot be represented in provider_asset_id VARCHAR(128)');
            }
            // NOT NULL in the schema, absent from the descriptor: refuse. A
            // tenant id or a sentinel here would attribute the asset to nobody
            // in particular and would be indistinguishable from a real owner.
            const ownerUserId = typeof descriptor.ownerUserId === 'string' ? descriptor.ownerUserId.trim() : '';
            if (!ownerUserId || ownerUserId.length > 36) {
                throw new RecordingLibraryPromotionError('owner_missing', 'owner_user_id is NOT NULL and the descriptor carries no owner');
            }
            const title = (typeof descriptor.title === 'string' ? descriptor.title.trim() : '').slice(0, MAX_TITLE_LENGTH)
                || 'Untitled asset';
            const id = idFactory();
            return runner.transaction(async (conn) => {
                try {
                    await conn.execute(RECORDING_LIBRARY_INSERT, [id, tenantId, ownerUserId, provider, providerAssetId, title]);
                }
                catch (error) {
                    if (!isDuplicateEntryError(error))
                        throw error;
                    // The key is taken. Read the winner back ON THIS CONNECTION
                    // and prove it is ours before answering with its id. A plain
                    // SELECT is a consistent read, so it sees the row that made
                    // our INSERT fail (that row committed before the duplicate
                    // was reported), while it cannot see an unrelated tenant's
                    // uncommitted work.
                    const existing = await conn.queryOne(RECORDING_LIBRARY_READBACK, [provider, providerAssetId]);
                    if (!existing || typeof existing.id !== 'string' || !existing.id) {
                        // A duplicate we cannot attribute (e.g. the PK collided,
                        // or the winner vanished). Fail closed: no assetId.
                        throw new RecordingLibraryPromotionError('unresolved_duplicate', 'duplicate key could not be resolved to a video_assets row');
                    }
                    if (existing.tenant_id !== tenantId) {
                        // The global unique key is doing what the schema says:
                        // tenant B cannot own a recording id tenant A already
                        // owns. Never return A's id, never overwrite A's row.
                        throw new RecordingLibraryPromotionError('cross_tenant_collision', 'provider_recording_id is already owned by another tenant');
                    }
                    // `uq_video_asset_provider` is compared under the table's
                    // utf8mb4_unicode_ci collation, which is case- and
                    // accent-insensitive. If the stored key is not EXACTLY the
                    // one we sent, the unique index matched a DIFFERENT
                    // recording, so this is a collision, not a repeat.
                    if (existing.provider !== provider || existing.provider_asset_id !== providerAssetId) {
                        throw new RecordingLibraryPromotionError('key_collision', 'provider_asset_id matched a row with a different key under a case-insensitive collation');
                    }
                    // The row is this tenant's and the key is byte-identical, so
                    // it is genuinely the same recording. It must ALSO be filed
                    // for the same owner: storage is charged against an asset,
                    // and an asset owned by someone else is not this session's
                    // recording — the caller would be metering another person's
                    // storage. Refuse instead of answering with that id.
                    if (typeof existing.owner_user_id !== 'string' || existing.owner_user_id !== ownerUserId) {
                        throw new RecordingLibraryPromotionError('owner_mismatch', 'the existing asset for this recording is owned by a different user');
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
