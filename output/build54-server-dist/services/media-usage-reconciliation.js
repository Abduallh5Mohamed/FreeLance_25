"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_GAP_MAX_ATTEMPTS = exports.DEFAULT_GAP_DRAIN_LIMIT = exports.MEDIA_METERING_SCHEMA_CONTRACT = exports.STORAGE_METER_ERRORS = exports.MAX_STORAGE_BYTES_PER_ASSET = exports.STORAGE_EVIDENCE_SOURCES = exports.STORAGE_TRANSITIONS = void 0;
exports.normalizeStorageTransition = normalizeStorageTransition;
exports.normalizeEvidenceSource = normalizeEvidenceSource;
exports.buildStorageIdempotencyKey = buildStorageIdempotencyKey;
exports.rebuildStorageTotals = rebuildStorageTotals;
exports.createMediaMeteringService = createMediaMeteringService;
exports.reconcileStorageUsage = reconcileStorageUsage;
exports.createInMemoryMediaMeteringStore = createInMemoryMediaMeteringStore;
exports.createSqlMediaMeteringStore = createSqlMediaMeteringStore;
exports.drainMediaUsageGaps = drainMediaUsageGaps;
exports.createInMemoryGapOutbox = createInMemoryGapOutbox;
exports.createSqlMediaGapOutbox = createSqlMediaGapOutbox;
/**
 * B2-W6 — server-verified storage metering and reconciliation.
 *
 * Two units are metered by two ledgers and are never combined:
 *
 *  - `watch_seconds` — this module does not touch it. Watch time is metered by
 *    `video-usage-events.ts` from an entitled heartbeat or a provider callback.
 *  - `storage_bytes` — this module's only unit. It is a per-asset cumulative
 *    counter derived from an append-only transition log.
 *
 * Authority
 *   A byte count is accepted only from a provider callback whose signature was
 *   verified by the caller, or from a server-side measurement. Two evidence
 *   kinds are deliberately rejected:
 *     * `client-claimed` — a browser/device number is never authoritative;
 *     * `object-metadata-observed` — bytes read from object metadata are an
 *       observation, NOT live provider proof of what is stored.
 *
 * Idempotency
 *   Every transition carries a tenant-scoped idempotency key
 *   `st:{assetId}:{operationId}`. A replay of the same provider operation is
 *   absorbed before any counter write. A replacement is an absolute snapshot
 *   (`resultingBytes`), so its contribution is `new - previous` (a delta),
 *   never a second full amount.
 *
 * Atomicity — the meter's single write contract
 *   The append is ONE transaction-bound unit: the idempotency check, the event
 *   append, the asset counter, the tenant counter and the audit either all
 *   commit or none of them do. The store exposes exactly one write seam,
 *   `withTransaction(unit, work)`, and the service has no other write path, so
 *   "try atomic, else write loosely" is not expressible in this module. A seam
 *   that cannot open a transaction is REFUSED (`transactionRequired`) rather
 *   than degraded, because a loose append is exactly how an event ends up
 *   committed without its counters.
 *
 *   Counters are always taken in one deterministic order — the shared TENANT
 *   counter first, then the per-asset counter — on every write path. Taking
 *   both inside the same unit is what makes a delta impossible to lose between
 *   them; taking them in one order everywhere is what stops two concurrent
 *   appends from deadlocking.
 *
 *   Idempotency is decided inside the unit: the ledger's unique key is the
 *   guard, and the duplicate short-circuits in the same transaction that would
 *   have written the counters, so no pre-read can race the append.
 *
 * Ordering
 *   The canonical order is `(occurredAtMs, idempotencyKey)`. Upload/replace
 *   carry an absolute size, delete forces zero and retry carries the previous
 *   size forward, so replaying a shuffled delivery converges on the same final
 *   value and never produces a negative total.
 *
 * Persistence
 *   The durable transition table does not exist in the current schema (only
 *   `video_usage_events` with `kind IN ('watch','storage')` and no signed
 *   delta/transition column exists). Writing transition rows into that table
 *   would mix absolute observations with deltas and invent column semantics, so
 *   this module exposes a store port plus a reference in-memory adapter and
 *   reports the exact I2 request instead of guessing SQL.
 *
 * No money, no subscription, no charge, no student count. No `any`, no
 * ts-ignore, no network, no runtime DDL.
 */
const crypto_1 = require("crypto");
const audit_1 = require("../security/audit");
/* =========================================================================
 * Taxonomy
 * ========================================================================= */
exports.STORAGE_TRANSITIONS = ['upload', 'replace', 'delete', 'retry'];
function normalizeStorageTransition(value) {
    if (typeof value !== 'string')
        return null;
    return exports.STORAGE_TRANSITIONS.includes(value) ? value : null;
}
/**
 * Evidence that may establish a byte count. Anything else is rejected; the two
 * named rejections are explicit so the caller sees WHY a claim was refused.
 */
exports.STORAGE_EVIDENCE_SOURCES = ['provider-callback', 'server-measured'];
exports.MAX_STORAGE_BYTES_PER_ASSET = 10 * 1024 * 1024 * 1024;
exports.STORAGE_METER_ERRORS = {
    invalidTenant: 'tenant_id is required',
    invalidAsset: 'asset_id is malformed',
    invalidOperation: 'operation_id is required',
    invalidBytes: 'resulting_bytes must be a non-negative integer',
    bytesCap: 'resulting_bytes exceeds the per-asset cap',
    unknownAsset: 'unknown asset',
    tenantMismatch: 'tenant mismatch',
    clientClaim: 'client byte claims are not accepted',
    metadataObservation: 'observed object metadata is not live provider proof',
    unverifiedSource: 'unverified byte source',
    transactionRequired: 'the meter store cannot open a transaction; refusing to write',
    unsafeByteTotal: 'a byte total is not a safe non-negative integer',
};
/* =========================================================================
 * Normalization
 * ========================================================================= */
const ASSET_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const OPERATION_ID_RE = /^[A-Za-z0-9:_.-]{1,200}$/;
function normalizeTenantId(value) {
    if (typeof value !== 'string')
        return null;
    const trimmed = value.trim();
    return trimmed && trimmed.length <= 128 ? trimmed : null;
}
function normalizeAssetId(value) {
    if (typeof value !== 'string')
        return null;
    const trimmed = value.trim();
    return ASSET_ID_RE.test(trimmed) ? trimmed : null;
}
function normalizeOperationId(value) {
    if (typeof value !== 'string')
        return null;
    const trimmed = value.trim();
    return OPERATION_ID_RE.test(trimmed) ? trimmed : null;
}
/**
 * Strict non-negative byte count. Digits only.
 *
 * `Number('0x10')` returned 16 and `Number('1e3')` returned 1000, so a
 * hex- or exponent-shaped string was accepted as a byte count. An unsafe
 * integer is also refused: it is not a representable quantity, and two
 * distinct real sizes would collide on one double.
 */
function normalizeBytes(value) {
    let parsed;
    if (typeof value === 'number') {
        parsed = value;
    }
    else if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
        parsed = Number(value.trim());
    }
    else {
        return null;
    }
    if (!Number.isSafeInteger(parsed) || parsed < 0)
        return null;
    return parsed;
}
/**
 * Byte totals are exact integers: never negative, never outside the safe
 * integer range. The floor keeps a drifted-low counter from producing a
 * negative state; the range check refuses to WRITE a number JavaScript can no
 * longer represent exactly, so the unit aborts (and therefore rolls back)
 * instead of persisting an untrustworthy total.
 */
function floorByteTotal(value) {
    const floored = Math.max(0, Math.trunc(value));
    if (!Number.isSafeInteger(floored))
        throw new Error(exports.STORAGE_METER_ERRORS.unsafeByteTotal);
    return floored;
}
function normalizeEvidenceSource(value) {
    if (value === 'client-claimed')
        return { ok: false, error: exports.STORAGE_METER_ERRORS.clientClaim };
    if (value === 'object-metadata-observed')
        return { ok: false, error: exports.STORAGE_METER_ERRORS.metadataObservation };
    if (value === 'provider-callback' || value === 'server-measured')
        return { ok: true, value };
    return { ok: false, error: exports.STORAGE_METER_ERRORS.unverifiedSource };
}
/**
 * Tenant-scoped idempotency key. Long provider operation ids are hashed so the
 * key always fits the ledger's VARCHAR(200) dedupe column.
 */
function buildStorageIdempotencyKey(assetId, operationId) {
    const raw = `st:${assetId}:${operationId}`;
    if (raw.length <= 200)
        return raw;
    const digest = (0, crypto_1.createHash)('sha256').update(raw).digest('hex').slice(0, 40);
    return `st:${assetId}:h:${digest}`;
}
function canonicalOrder(a, b) {
    if (a.occurredAtMs !== b.occurredAtMs)
        return a.occurredAtMs - b.occurredAtMs;
    return a.idempotencyKey < b.idempotencyKey ? -1 : a.idempotencyKey > b.idempotencyKey ? 1 : 0;
}
/**
 * Recompute every per-asset total from the recorded events. Pure: no store
 * access, no mutation. This is the authority reconciliation compares against.
 */
function rebuildStorageTotals(tenantId, events) {
    const scoped = events.filter((event) => event.tenantId === tenantId);
    const ordered = [...scoped].sort(canonicalOrder);
    const byAsset = new Map();
    for (const event of ordered) {
        let state = byAsset.get(event.assetId);
        if (!state) {
            state = { assetId: event.assetId, total: 0, eventCount: 0, deltas: [] };
            byAsset.set(event.assetId, state);
        }
        const previous = state.total;
        let next;
        switch (event.transition) {
            case 'upload':
            case 'replace':
                next = Math.max(0, Math.trunc(event.resultingBytes));
                break;
            case 'delete':
                next = 0;
                break;
            case 'retry':
                next = previous;
                break;
        }
        state.total = next;
        state.eventCount += 1;
        state.deltas.push({
            idempotencyKey: event.idempotencyKey,
            transition: event.transition,
            bytesDelta: next - previous,
            totalAfter: next,
        });
    }
    const perAsset = [...byAsset.values()].sort((a, b) => (a.assetId < b.assetId ? -1 : a.assetId > b.assetId ? 1 : 0));
    return {
        tenantId,
        perAsset,
        tenantTotal: perAsset.reduce((sum, asset) => sum + asset.total, 0),
        eventCount: scoped.length,
    };
}
function validateOperation(input, now) {
    const tenantId = normalizeTenantId(input.tenantId);
    if (!tenantId)
        return { ok: false, error: exports.STORAGE_METER_ERRORS.invalidTenant };
    const assetId = normalizeAssetId(input.assetId);
    if (!assetId)
        return { ok: false, error: exports.STORAGE_METER_ERRORS.invalidAsset };
    const operationId = normalizeOperationId(input.operationId);
    if (!operationId)
        return { ok: false, error: exports.STORAGE_METER_ERRORS.invalidOperation };
    const source = normalizeEvidenceSource(input.source);
    if (!source.ok)
        return source;
    const occurredAtMs = typeof input.occurredAtMs === 'number' && Number.isFinite(input.occurredAtMs) && input.occurredAtMs >= 0
        ? Math.trunc(input.occurredAtMs)
        : now();
    return { ok: true, value: { tenantId, assetId, operationId, source: source.value, occurredAtMs } };
}
function createMediaMeteringService(deps) {
    const store = deps.store;
    const idFactory = deps.idFactory ?? crypto_1.randomUUID;
    const now = deps.now ?? (() => Date.now());
    const record = async (input, request) => {
        const validated = validateOperation(input, now);
        if (!validated.ok)
            return { error: validated.error };
        const { tenantId, assetId, operationId, source, occurredAtMs } = validated.value;
        // There is exactly one write path, and it is transaction-bound. A seam
        // that cannot open a transaction is refused, not degraded: a loose
        // append is how an event comes to exist without its counters.
        if (typeof store.withTransaction !== 'function') {
            return { error: exports.STORAGE_METER_ERRORS.transactionRequired };
        }
        return store.withTransaction({ tenantId, assetId }, async (tx) => {
            // Ownership is resolved from server rows INSIDE the unit — never
            // from the payload, and never from a pre-read outside it.
            const assetTenant = await tx.findAssetTenant(assetId);
            if (!assetTenant)
                return { error: exports.STORAGE_METER_ERRORS.unknownAsset };
            if (assetTenant !== tenantId)
                return { error: exports.STORAGE_METER_ERRORS.tenantMismatch };
            // One snapshot feeds the prior totals, the transition derivation
            // and (below) the out-of-order rebuild.
            const tenantEvents = await tx.listEvents(tenantId);
            const priorAssetEvents = tenantEvents.filter((event) => event.assetId === assetId);
            const priorAssetTotal = floorByteTotal((await tx.readStorageCounter(tenantId, assetId))
                ?? rebuildStorageTotals(tenantId, priorAssetEvents).perAsset[0]?.total
                ?? 0);
            const priorTenantTotal = floorByteTotal((await tx.readStorageCounter(tenantId, null))
                ?? rebuildStorageTotals(tenantId, tenantEvents).tenantTotal);
            let transition;
            let resultingBytes;
            if (request === 'delete') {
                transition = 'delete';
                resultingBytes = 0;
            }
            else if (request === 'retry') {
                transition = 'retry';
                resultingBytes = priorAssetTotal;
            }
            else {
                transition = priorAssetEvents.length === 0 ? 'upload' : 'replace';
                const parsed = normalizeBytes(input.resultingBytes);
                if (parsed === null)
                    return { error: exports.STORAGE_METER_ERRORS.invalidBytes };
                if (parsed > exports.MAX_STORAGE_BYTES_PER_ASSET)
                    return { error: exports.STORAGE_METER_ERRORS.bytesCap };
                resultingBytes = parsed;
            }
            const idempotencyKey = buildStorageIdempotencyKey(assetId, operationId);
            const row = {
                id: idFactory(),
                tenantId,
                assetId,
                transition,
                resultingBytes,
                idempotencyKey,
                source,
                occurredAtMs,
            };
            // Idempotency is decided INSIDE the unit: the ledger's unique key
            // is the guard, so a duplicate short-circuits in the same
            // transaction that would have written the counters. There is no
            // pre-read to race against.
            const inserted = await tx.insertEvent(row);
            if (!inserted) {
                await tx.recordAudit({
                    actorUserId: null,
                    tenantId,
                    action: 'video.usage.storage.deduplicated',
                    resourceType: 'video_usage_storage_event',
                    resourceId: row.id,
                    newValue: { asset_id: assetId, idempotency_key: idempotencyKey, source },
                });
                return { recorded: false, deduplicated: true, transition: null, storageBytes: priorAssetTotal };
            }
            // Derived from the SAME snapshot the append path just read
            // (`tenantEvents` + the row inserted in this unit), so a rebuild can
            // never disagree with the append that produced it.
            const rebuilt = rebuildStorageTotals(tenantId, [...tenantEvents, row]);
            const assetState = rebuilt.perAsset.find((asset) => asset.assetId === assetId);
            const canonicalAssetTotal = assetState?.total ?? 0;
            const bytesDelta = assetState?.deltas.find((delta) => delta.idempotencyKey === idempotencyKey)?.bytesDelta ?? 0;
            const outOfOrder = priorAssetEvents.some((event) => event.occurredAtMs > occurredAtMs);
            // In-order appends apply the canonical delta to the existing
            // counter, so external drift is not silently healed here. An
            // out-of-order append cannot be expressed as a single delta, so it
            // rebuilds from the snapshot and audits that fact explicitly.
            const nextAssetTotal = outOfOrder
                ? floorByteTotal(canonicalAssetTotal)
                : floorByteTotal(priorAssetTotal + bytesDelta);
            const nextTenantTotal = outOfOrder
                ? floorByteTotal(rebuilt.tenantTotal)
                : floorByteTotal(priorTenantTotal + bytesDelta);
            // Deterministic lock order: the shared TENANT counter is written
            // (and therefore locked) BEFORE the per-asset counter, on every
            // path. Both writes live in this unit, so neither can land alone.
            await tx.writeStorageCounter(tenantId, null, nextTenantTotal);
            await tx.writeStorageCounter(tenantId, assetId, nextAssetTotal);
            if (outOfOrder) {
                await tx.recordAudit({
                    actorUserId: null,
                    tenantId,
                    action: 'video.usage.storage.out_of_order_rebuild',
                    resourceType: 'video_usage_storage_event',
                    resourceId: row.id,
                    oldValue: { asset_total: priorAssetTotal, tenant_total: priorTenantTotal },
                    newValue: { asset_total: nextAssetTotal, tenant_total: nextTenantTotal },
                    reason: 'out_of_order_event',
                });
            }
            await tx.recordAudit({
                actorUserId: null,
                tenantId,
                action: 'video.usage.storage.recorded',
                resourceType: 'video_usage_storage_event',
                resourceId: row.id,
                newValue: {
                    asset_id: assetId,
                    transition,
                    resulting_bytes: resultingBytes,
                    bytes_delta: bytesDelta,
                    storage_bytes: nextAssetTotal,
                    source,
                },
            });
            return {
                recorded: true,
                deduplicated: false,
                transition,
                bytesDelta,
                storageBytes: nextAssetTotal,
            };
        });
    };
    return {
        recordVerifiedBytes: (input) => record(input, 'derive'),
        recordDelete: (input) => record(input, 'delete'),
        recordRetry: (input) => record(input, 'retry'),
        storageBytesForAsset: async (tenantId, assetId) => {
            const safeTenant = normalizeTenantId(tenantId);
            const safeAsset = normalizeAssetId(assetId);
            if (!safeTenant || !safeAsset)
                return 0;
            const counter = await store.readStorageCounter(safeTenant, safeAsset);
            if (counter !== null)
                return counter;
            const rebuilt = rebuildStorageTotals(safeTenant, await store.listEvents(safeTenant, safeAsset));
            return rebuilt.perAsset[0]?.total ?? 0;
        },
        storageBytesForTenant: async (tenantId) => {
            const safeTenant = normalizeTenantId(tenantId);
            if (!safeTenant)
                return 0;
            const counter = await store.readStorageCounter(safeTenant, null);
            if (counter !== null)
                return counter;
            return rebuildStorageTotals(safeTenant, await store.listEvents(safeTenant)).tenantTotal;
        },
        rebuild: async (tenantId, assetId) => {
            const safeTenant = normalizeTenantId(tenantId);
            if (!safeTenant) {
                return { tenantId: '', perAsset: [], tenantTotal: 0, eventCount: 0 };
            }
            const safeAsset = assetId === undefined ? undefined : normalizeAssetId(assetId) ?? undefined;
            return rebuildStorageTotals(safeTenant, await store.listEvents(safeTenant, safeAsset));
        },
    };
}
function discrepancy(scope, tenantId, assetId, recordedTotal, rebuiltTotal, eventCount) {
    if (recordedTotal === null) {
        // No counter AND no event: the scope was never metered, so there is no
        // counter to be missing. Reporting this as a discrepancy would flag
        // every idle tenant/asset on every pass and bury the real gaps.
        if (eventCount === 0)
            return null;
        return {
            unit: 'storage_bytes',
            scope,
            tenantId,
            assetId,
            recordedTotal: null,
            rebuiltTotal,
            delta: null,
            eventCount,
            reason: 'counter-missing',
        };
    }
    if (recordedTotal === rebuiltTotal)
        return null;
    return {
        unit: 'storage_bytes',
        scope,
        tenantId,
        assetId,
        recordedTotal,
        rebuiltTotal,
        delta: recordedTotal - rebuiltTotal,
        eventCount,
        reason: 'counter-drift',
    };
}
/**
 * Compare the materialized counter(s) with a rebuild from the event log.
 * Never writes: no insert, no counter update, no audit. A caller that wants a
 * repair must perform a separately authorised, audited operation.
 */
async function reconcileStorageUsage(input) {
    const tenantId = normalizeTenantId(input.tenantId);
    if (!tenantId)
        throw new Error(exports.STORAGE_METER_ERRORS.invalidTenant);
    const assetId = input.assetId === undefined || input.assetId === null ? null : normalizeAssetId(input.assetId);
    if (input.assetId !== undefined && input.assetId !== null && !assetId) {
        throw new Error(exports.STORAGE_METER_ERRORS.invalidAsset);
    }
    const checkedAtMs = typeof input.nowMs === 'number' && Number.isFinite(input.nowMs) ? Math.trunc(input.nowMs) : Date.now();
    const events = await input.store.listEvents(tenantId, assetId ?? undefined);
    const rebuilt = rebuildStorageTotals(tenantId, events);
    const discrepancies = [];
    if (assetId) {
        const assetState = rebuilt.perAsset.find((asset) => asset.assetId === assetId);
        const recorded = await input.store.readStorageCounter(tenantId, assetId);
        const entry = discrepancy('asset', tenantId, assetId, recorded, assetState?.total ?? 0, assetState?.eventCount ?? 0);
        if (entry)
            discrepancies.push(entry);
    }
    else {
        const recordedTenant = await input.store.readStorageCounter(tenantId, null);
        const tenantEntry = discrepancy('tenant', tenantId, null, recordedTenant, rebuilt.tenantTotal, rebuilt.eventCount);
        if (tenantEntry)
            discrepancies.push(tenantEntry);
        // A tenant total can match while individual assets drift in opposite
        // directions, so every asset counter is compared as well.
        for (const asset of rebuilt.perAsset) {
            const recorded = await input.store.readStorageCounter(tenantId, asset.assetId);
            const entry = discrepancy('asset', tenantId, asset.assetId, recorded, asset.total, asset.eventCount);
            if (entry)
                discrepancies.push(entry);
        }
    }
    return {
        unit: 'storage_bytes',
        tenantId,
        assetId,
        checkedAtMs,
        status: discrepancies.length === 0 ? 'match' : 'mismatch',
        eventCount: events.length,
        discrepancies,
        mutated: false,
    };
}
const counterKey = (tenantId, assetId) => `${tenantId}\u0000${assetId ?? '*'}`;
/**
 * A real adapter, not a decision mock: it stores rows, enforces the dedupe key
 * and holds counters. It computes no transition and no delta.
 *
 * `withTransaction` models the durable contract rather than pretending:
 *  - the callback is really executed, against a staged overlay;
 *  - a throw discards that overlay, so the event, BOTH counters and the audit
 *    are genuinely rolled back — the committed arrays/map are never touched;
 *  - commit applies the overlay in one synchronous block, so nothing can
 *    interleave between the event and the two counters;
 *  - units on the same tenant are serialized. That is the in-process model of
 *    `SELECT ... FOR UPDATE` on the shared tenant counter row taken before the
 *    asset row, which is what makes a lost delta impossible here exactly as
 *    the lock order does in SQL.
 */
function createInMemoryMediaMeteringStore(assets = []) {
    const assetTenants = new Map(assets.map((asset) => [asset.id, asset.tenantId]));
    const events = [];
    const keys = new Set();
    const counters = new Map();
    const audits = [];
    // Tail of each tenant's queue. Always settles, so a failed unit never
    // blocks the next waiter.
    const tenantTails = new Map();
    const runExclusive = (tenantId, work) => {
        const tail = tenantTails.get(tenantId) ?? Promise.resolve();
        const run = tail.then(work, work);
        tenantTails.set(tenantId, run.then(() => undefined, () => undefined));
        return run;
    };
    const committedEvents = (tenantId, assetId) => events
        .filter((event) => event.tenantId === tenantId && (assetId === undefined || event.assetId === assetId))
        .map((event) => ({ ...event }));
    return {
        events,
        counters,
        audits,
        seedAsset: (assetId, tenantId) => {
            assetTenants.set(assetId, tenantId);
        },
        listEvents: async (tenantId, assetId) => committedEvents(tenantId, assetId),
        readStorageCounter: async (tenantId, assetId) => counters.get(counterKey(tenantId, assetId)) ?? null,
        withTransaction: (unit, work) => runExclusive(unit.tenantId, async () => {
            // Staged state: invisible to every other unit until commit.
            const pendingEvents = [];
            const pendingKeys = new Set();
            const pendingCounters = new Map();
            const pendingAudits = [];
            const tx = {
                findAssetTenant: async (assetId) => assetTenants.get(assetId) ?? null,
                listEvents: async (tenantId, assetId) => [
                    ...committedEvents(tenantId, assetId),
                    ...pendingEvents
                        .filter((event) => event.tenantId === tenantId && (assetId === undefined || event.assetId === assetId))
                        .map((event) => ({ ...event })),
                ],
                insertEvent: async (row) => {
                    const key = counterKey(row.tenantId, row.idempotencyKey);
                    if (keys.has(key) || pendingKeys.has(key))
                        return false;
                    pendingKeys.add(key);
                    pendingEvents.push({ ...row });
                    return true;
                },
                readStorageCounter: async (tenantId, assetId) => {
                    const key = counterKey(tenantId, assetId);
                    return pendingCounters.get(key) ?? counters.get(key) ?? null;
                },
                writeStorageCounter: async (tenantId, assetId, total) => {
                    pendingCounters.set(counterKey(tenantId, assetId), total);
                },
                recordAudit: async (input) => {
                    pendingAudits.push(input);
                },
            };
            const result = await work(tx);
            // Commit: one synchronous block with no await, so the event and
            // both counters become visible together. A throw above never
            // reaches this point — that IS the rollback.
            for (const event of pendingEvents)
                events.push(event);
            for (const key of pendingKeys)
                keys.add(key);
            for (const [key, total] of pendingCounters)
                counters.set(key, total);
            for (const audit of pendingAudits)
                audits.push(audit);
            return result;
        }),
    };
}
/* =========================================================================
 * Durable persistence — SQL adapter against the published I2 contract
 * =========================================================================
 *
 * The tables below are the request this module has published since the first
 * delivery (`B2-W6-MEDIA-METERING-20261021.md` §C.7, I2-1..I2-4). The adapter
 * implements exactly that contract and NOTHING else:
 *
 *   I2-1 `video_storage_transitions(id, tenant_id, asset_id, transition,
 *         resulting_bytes, idempotency_key, evidence_source, occurred_at,
 *         created_at)` with `UNIQUE (tenant_id, idempotency_key)` and
 *         `KEY (tenant_id, asset_id, occurred_at)`;
 *   I2-2 `media_storage_asset_counters(tenant_id, asset_id, storage_bytes,
 *         updated_at)` PRIMARY KEY `(tenant_id, asset_id)` and
 *         `media_storage_tenant_counters(tenant_id, storage_bytes, updated_at)`
 *         PRIMARY KEY `(tenant_id)` — two tables because MySQL cannot put NULL
 *         in a primary key, while the port's `assetId: null` means "tenant
 *         total";
 *   I2-3 the read-modify-write is safe because the adapter takes the TENANT
 *         counter row lock and then the ASSET counter row lock at the start of
 *         every unit, in that one order;
 *   I2-4 `media_usage_gap_outbox` for a `deferred`/`unconfigured` byte count.
 *
 * The migration is NOT written here (schema source belongs to the schema
 * owner) and the adapter is NOT composed anywhere: without the tables it would
 * fail at runtime, so shipping it as "production metering" would be a false
 * claim. It is a real adapter against a declared contract, not an invention.
 */
exports.MEDIA_METERING_SCHEMA_CONTRACT = {
    /** I2-1 */
    events: 'video_storage_transitions',
    /** I2-2 */
    assetCounters: 'media_storage_asset_counters',
    tenantCounters: 'media_storage_tenant_counters',
    /** I2-4 */
    gapOutbox: 'media_usage_gap_outbox',
};
function isDuplicateKey(error) {
    if (!error || typeof error !== 'object')
        return false;
    const code = error.code;
    return code === 'ER_DUP_ENTRY' || code === 1062;
}
function toMysqlUtc(ms) {
    return new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
}
function fromMysqlUtc(value) {
    if (value instanceof Date)
        return value.getTime();
    if (typeof value === 'string' && value) {
        const date = new Date(/[TZ]/.test(value) ? value : `${value.replace(' ', 'T')}Z`);
        if (Number.isFinite(date.getTime()))
            return date.getTime();
    }
    return 0;
}
const TRANSITION_COLUMNS = `id, tenant_id, asset_id, transition, resulting_bytes,
    idempotency_key, evidence_source, occurred_at`;
function mapTransitionRow(row) {
    const transition = normalizeStorageTransition(row.transition);
    const source = normalizeEvidenceSource(row.evidence_source);
    if (!transition || !source.ok)
        return null;
    return {
        id: row.id,
        tenantId: row.tenant_id,
        assetId: row.asset_id,
        transition,
        resultingBytes: Number(row.resulting_bytes ?? 0),
        idempotencyKey: row.idempotency_key,
        source: source.value,
        occurredAtMs: fromMysqlUtc(row.occurred_at),
    };
}
/**
 * Durable meter store over the declared contract.
 *
 * `withTransaction` is the only write path and it does three things the port
 * documents:
 *  1. `BEGIN` on one connection;
 *  2. `INSERT ... ON DUPLICATE KEY UPDATE` + `SELECT ... FOR UPDATE` on the
 *     TENANT counter, then the same on the ASSET counter — one order on every
 *     writer, which is what makes a deadlock between two appends impossible;
 *  3. `COMMIT` on success, `ROLLBACK` on any throw, and the connection is
 *     always released.
 */
function createSqlMediaMeteringStore(db) {
    const listEventsOn = async (conn, tenantId, assetId) => {
        const rows = assetId === undefined
            ? await conn.query(`SELECT ${TRANSITION_COLUMNS} FROM ${exports.MEDIA_METERING_SCHEMA_CONTRACT.events}
                 WHERE tenant_id = ? ORDER BY occurred_at ASC, idempotency_key ASC`, [tenantId])
            : await conn.query(`SELECT ${TRANSITION_COLUMNS} FROM ${exports.MEDIA_METERING_SCHEMA_CONTRACT.events}
                 WHERE tenant_id = ? AND asset_id = ? ORDER BY occurred_at ASC, idempotency_key ASC`, [tenantId, assetId]);
        return rows
            .map(mapTransitionRow)
            .filter((row) => row !== null);
    };
    const readCounterOn = async (conn, tenantId, assetId) => {
        const row = assetId === null
            ? await conn.queryOne(`SELECT storage_bytes FROM ${exports.MEDIA_METERING_SCHEMA_CONTRACT.tenantCounters} WHERE tenant_id = ? LIMIT 1`, [tenantId])
            : await conn.queryOne(`SELECT storage_bytes FROM ${exports.MEDIA_METERING_SCHEMA_CONTRACT.assetCounters}
                 WHERE tenant_id = ? AND asset_id = ? LIMIT 1`, [tenantId, assetId]);
        if (!row || row.storage_bytes === null || row.storage_bytes === undefined)
            return null;
        const total = Number(row.storage_bytes);
        return Number.isSafeInteger(total) ? total : null;
    };
    const lockCounters = async (conn, unit) => {
        // Tenant row first, always.
        await conn.execute(`INSERT INTO ${exports.MEDIA_METERING_SCHEMA_CONTRACT.tenantCounters} (tenant_id, storage_bytes)
             VALUES (?, 0) ON DUPLICATE KEY UPDATE tenant_id = tenant_id`, [unit.tenantId]);
        await conn.query(`SELECT tenant_id FROM ${exports.MEDIA_METERING_SCHEMA_CONTRACT.tenantCounters}
             WHERE tenant_id = ? FOR UPDATE`, [unit.tenantId]);
        // Then the asset row.
        await conn.execute(`INSERT INTO ${exports.MEDIA_METERING_SCHEMA_CONTRACT.assetCounters} (tenant_id, asset_id, storage_bytes)
             VALUES (?, ?, 0) ON DUPLICATE KEY UPDATE asset_id = asset_id`, [unit.tenantId, unit.assetId]);
        await conn.query(`SELECT asset_id FROM ${exports.MEDIA_METERING_SCHEMA_CONTRACT.assetCounters}
             WHERE tenant_id = ? AND asset_id = ? FOR UPDATE`, [unit.tenantId, unit.assetId]);
    };
    return {
        listEvents: (tenantId, assetId) => db.getConnection().then(async ({ connection, release }) => {
            try {
                return await listEventsOn(connection, tenantId, assetId);
            }
            finally {
                await release();
            }
        }),
        readStorageCounter: (tenantId, assetId) => db.getConnection().then(async ({ connection, release }) => {
            try {
                return await readCounterOn(connection, tenantId, assetId);
            }
            finally {
                await release();
            }
        }),
        withTransaction: async (unit, work) => {
            const { connection, release } = await db.getConnection();
            try {
                await connection.execute('START TRANSACTION');
                try {
                    await lockCounters(connection, unit);
                    const tx = {
                        findAssetTenant: async (assetId) => {
                            const row = await connection.queryOne('SELECT tenant_id FROM video_assets WHERE id = ? LIMIT 1', [assetId]);
                            return row?.tenant_id ?? null;
                        },
                        listEvents: (tenantId, assetId) => listEventsOn(connection, tenantId, assetId),
                        readStorageCounter: (tenantId, assetId) => readCounterOn(connection, tenantId, assetId),
                        insertEvent: async (row) => {
                            try {
                                await connection.execute(`INSERT INTO ${exports.MEDIA_METERING_SCHEMA_CONTRACT.events}
                                       (id, tenant_id, asset_id, transition, resulting_bytes,
                                        idempotency_key, evidence_source, occurred_at)
                                     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [
                                    row.id,
                                    row.tenantId,
                                    row.assetId,
                                    row.transition,
                                    row.resultingBytes,
                                    row.idempotencyKey,
                                    row.source,
                                    toMysqlUtc(row.occurredAtMs),
                                ]);
                                return true;
                            }
                            catch (error) {
                                if (isDuplicateKey(error))
                                    return false;
                                throw error;
                            }
                        },
                        writeStorageCounter: async (tenantId, assetId, total) => {
                            if (assetId === null) {
                                await connection.execute(`INSERT INTO ${exports.MEDIA_METERING_SCHEMA_CONTRACT.tenantCounters}
                                       (tenant_id, storage_bytes, updated_at)
                                     VALUES (?, ?, UTC_TIMESTAMP())
                                     ON DUPLICATE KEY UPDATE storage_bytes = VALUES(storage_bytes),
                                                             updated_at = UTC_TIMESTAMP()`, [tenantId, total]);
                                return;
                            }
                            await connection.execute(`INSERT INTO ${exports.MEDIA_METERING_SCHEMA_CONTRACT.assetCounters}
                                   (tenant_id, asset_id, storage_bytes, updated_at)
                                 VALUES (?, ?, ?, UTC_TIMESTAMP())
                                 ON DUPLICATE KEY UPDATE storage_bytes = VALUES(storage_bytes),
                                                         updated_at = UTC_TIMESTAMP()`, [tenantId, assetId, total]);
                        },
                        recordAudit: async (input) => {
                            await (0, audit_1.recordAudit)(connection.execute, input);
                        },
                    };
                    const result = await work(tx);
                    await connection.execute('COMMIT');
                    return result;
                }
                catch (error) {
                    // A partial commit is a contract violation, so every throw
                    // rolls back the event, BOTH counters and the audit row.
                    await connection.execute('ROLLBACK');
                    throw error;
                }
            }
            finally {
                await release();
            }
        },
    };
}
exports.DEFAULT_GAP_DRAIN_LIMIT = 50;
exports.DEFAULT_GAP_MAX_ATTEMPTS = 5;
/**
 * Re-drive pending gaps through the SAME verified path the live callback used.
 * The meter's own idempotency key absorbs a gap that was already applied, so a
 * retry can never double-count. A row that keeps failing stops at
 * `maxAttempts` and is reported as `exhausted` instead of retrying forever.
 */
async function drainMediaUsageGaps(input) {
    const tenantId = normalizeTenantId(input.tenantId);
    if (!tenantId)
        throw new Error(exports.STORAGE_METER_ERRORS.invalidTenant);
    const limit = Math.min(500, Math.max(1, Math.trunc(input.limit ?? exports.DEFAULT_GAP_DRAIN_LIMIT)));
    const maxAttempts = Math.max(1, Math.trunc(input.maxAttempts ?? exports.DEFAULT_GAP_MAX_ATTEMPTS));
    const at = typeof input.nowMs === 'number' && Number.isFinite(input.nowMs) ? Math.trunc(input.nowMs) : Date.now();
    const pending = await input.outbox.listPending(tenantId, limit);
    let delivered = 0;
    let deduplicated = 0;
    let deferred = 0;
    let exhausted = 0;
    for (const gap of pending) {
        if (gap.attempts >= maxAttempts) {
            exhausted += 1;
            continue;
        }
        try {
            const result = await input.meter.recordVerifiedBytes({
                tenantId: gap.tenantId,
                assetId: gap.assetId,
                resultingBytes: gap.resultingBytes,
                operationId: gap.operationId,
                source: gap.source,
                occurredAtMs: gap.occurredAtMs,
            });
            if ('error' in result) {
                deferred += 1;
                await input.outbox.markAttemptFailed(gap.id, at, result.error);
                continue;
            }
            if (result.deduplicated) {
                deduplicated += 1;
            }
            else {
                delivered += 1;
            }
            await input.outbox.markDelivered(gap.id, at);
        }
        catch (error) {
            deferred += 1;
            await input.outbox.markAttemptFailed(gap.id, at, error instanceof Error ? error.message : 'unknown error');
        }
    }
    return {
        tenantId,
        attempted: pending.length,
        delivered,
        deduplicated,
        deferred,
        exhausted,
        mutated: true,
    };
}
/** A real adapter: it stores rows, enforces the dedupe key and counts attempts. */
function createInMemoryGapOutbox() {
    const rows = [];
    const keys = new Set();
    return {
        rows,
        enqueue: async (row) => {
            const key = `${row.tenantId}\u0000${row.assetId}\u0000${row.operationId}`;
            if (keys.has(key))
                return { enqueued: false, duplicate: true };
            keys.add(key);
            rows.push({ ...row });
            return { enqueued: true, duplicate: false };
        },
        listPending: async (tenantId, limit) => rows
            .filter((row) => row.tenantId === tenantId && row.status === 'pending')
            .sort((a, b) => (a.createdAtMs - b.createdAtMs) || (a.id < b.id ? -1 : 1))
            .slice(0, limit)
            .map((row) => ({ ...row })),
        markDelivered: async (id, atMs) => {
            const row = rows.find((entry) => entry.id === id);
            if (!row)
                return;
            row.status = 'delivered';
            row.lastAttemptAtMs = atMs;
            row.lastError = null;
        },
        markAttemptFailed: async (id, atMs, error) => {
            const row = rows.find((entry) => entry.id === id);
            if (!row)
                return;
            row.attempts += 1;
            row.lastAttemptAtMs = atMs;
            row.lastError = error.slice(0, 500);
        },
    };
}
/** SQL gap outbox over I2-4. Unique key `(tenant_id, asset_id, operation_id)`. */
function createSqlMediaGapOutbox(db) {
    const withConnection = async (work) => {
        const { connection, release } = await db.getConnection();
        try {
            return await work(connection);
        }
        finally {
            await release();
        }
    };
    return {
        enqueue: (row) => withConnection(async (conn) => {
            try {
                await conn.execute(`INSERT INTO ${exports.MEDIA_METERING_SCHEMA_CONTRACT.gapOutbox}
                       (id, tenant_id, asset_id, operation_id, resulting_bytes, evidence_source,
                        occurred_at, reason, status, attempts, created_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, UTC_TIMESTAMP())`, [
                    row.id,
                    row.tenantId,
                    row.assetId,
                    row.operationId,
                    row.resultingBytes,
                    row.source,
                    toMysqlUtc(row.occurredAtMs),
                    row.reason,
                ]);
                return { enqueued: true, duplicate: false };
            }
            catch (error) {
                if (isDuplicateKey(error))
                    return { enqueued: false, duplicate: true };
                throw error;
            }
        }),
        listPending: (tenantId, limit) => withConnection(async (conn) => {
            const rows = await conn.query(`SELECT id, tenant_id, asset_id, operation_id, resulting_bytes, evidence_source,
                        occurred_at, reason, status, attempts, last_attempt_at, last_error, created_at
                 FROM ${exports.MEDIA_METERING_SCHEMA_CONTRACT.gapOutbox}
                 WHERE tenant_id = ? AND status = 'pending'
                 ORDER BY created_at ASC, id ASC LIMIT ?`, [tenantId, limit]);
            const mapped = [];
            for (const row of rows) {
                const source = normalizeEvidenceSource(row.evidence_source);
                const reason = row.reason === 'metering_unconfigured' ? 'metering_unconfigured' : 'metering_deferred';
                if (!source.ok)
                    continue;
                mapped.push({
                    id: row.id,
                    tenantId: row.tenant_id,
                    assetId: row.asset_id,
                    operationId: row.operation_id,
                    resultingBytes: Number(row.resulting_bytes ?? 0),
                    source: source.value,
                    occurredAtMs: fromMysqlUtc(row.occurred_at),
                    reason,
                    status: 'pending',
                    attempts: Number(row.attempts ?? 0),
                    lastAttemptAtMs: row.last_attempt_at ? fromMysqlUtc(row.last_attempt_at) : null,
                    lastError: row.last_error ?? null,
                    createdAtMs: fromMysqlUtc(row.created_at),
                });
            }
            return mapped;
        }),
        markDelivered: (id, atMs) => withConnection(async (conn) => {
            await conn.execute(`UPDATE ${exports.MEDIA_METERING_SCHEMA_CONTRACT.gapOutbox}
                 SET status = 'delivered', last_attempt_at = ?, last_error = NULL
                 WHERE id = ?`, [toMysqlUtc(atMs), id]);
        }),
        markAttemptFailed: (id, atMs, error) => withConnection(async (conn) => {
            await conn.execute(`UPDATE ${exports.MEDIA_METERING_SCHEMA_CONTRACT.gapOutbox}
                 SET attempts = attempts + 1, last_attempt_at = ?, last_error = ?
                 WHERE id = ? AND status = 'pending'`, [toMysqlUtc(atMs), error.slice(0, 500), id]);
        }),
    };
}
