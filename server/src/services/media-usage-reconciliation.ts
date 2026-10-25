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
import { createHash, randomUUID } from 'crypto';
import { recordAudit, type AuditRecordInput } from '../security/audit';

/* =========================================================================
 * Taxonomy
 * ========================================================================= */

export const STORAGE_TRANSITIONS = ['upload', 'replace', 'delete', 'retry'] as const;
export type StorageTransition = (typeof STORAGE_TRANSITIONS)[number];

export function normalizeStorageTransition(value: unknown): StorageTransition | null {
    if (typeof value !== 'string') return null;
    return (STORAGE_TRANSITIONS as readonly string[]).includes(value) ? (value as StorageTransition) : null;
}

/**
 * Evidence that may establish a byte count. Anything else is rejected; the two
 * named rejections are explicit so the caller sees WHY a claim was refused.
 */
export const STORAGE_EVIDENCE_SOURCES = ['provider-callback', 'server-measured'] as const;
export type StorageEvidenceSource = (typeof STORAGE_EVIDENCE_SOURCES)[number];

export const MAX_STORAGE_BYTES_PER_ASSET = 10 * 1024 * 1024 * 1024;

export const STORAGE_METER_ERRORS = {
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
} as const;

/* =========================================================================
 * Normalization
 * ========================================================================= */

const ASSET_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const OPERATION_ID_RE = /^[A-Za-z0-9:_.-]{1,200}$/;

function normalizeTenantId(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed && trimmed.length <= 128 ? trimmed : null;
}

function normalizeAssetId(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return ASSET_ID_RE.test(trimmed) ? trimmed : null;
}

function normalizeOperationId(value: unknown): string | null {
    if (typeof value !== 'string') return null;
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
function normalizeBytes(value: unknown): number | null {
    let parsed: number;
    if (typeof value === 'number') {
        parsed = value;
    } else if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
        parsed = Number(value.trim());
    } else {
        return null;
    }
    if (!Number.isSafeInteger(parsed) || parsed < 0) return null;
    return parsed;
}

/**
 * Byte totals are exact integers: never negative, never outside the safe
 * integer range. The floor keeps a drifted-low counter from producing a
 * negative state; the range check refuses to WRITE a number JavaScript can no
 * longer represent exactly, so the unit aborts (and therefore rolls back)
 * instead of persisting an untrustworthy total.
 */
function floorByteTotal(value: number): number {
    const floored = Math.max(0, Math.trunc(value));
    if (!Number.isSafeInteger(floored)) throw new Error(STORAGE_METER_ERRORS.unsafeByteTotal);
    return floored;
}

type SourceDecision = { ok: true; value: StorageEvidenceSource } | { ok: false; error: string };

export function normalizeEvidenceSource(value: unknown): SourceDecision {
    if (value === 'client-claimed') return { ok: false, error: STORAGE_METER_ERRORS.clientClaim };
    if (value === 'object-metadata-observed') return { ok: false, error: STORAGE_METER_ERRORS.metadataObservation };
    if (value === 'provider-callback' || value === 'server-measured') return { ok: true, value };
    return { ok: false, error: STORAGE_METER_ERRORS.unverifiedSource };
}

/**
 * Tenant-scoped idempotency key. Long provider operation ids are hashed so the
 * key always fits the ledger's VARCHAR(200) dedupe column.
 */
export function buildStorageIdempotencyKey(assetId: string, operationId: string): string {
    const raw = `st:${assetId}:${operationId}`;
    if (raw.length <= 200) return raw;
    const digest = createHash('sha256').update(raw).digest('hex').slice(0, 40);
    return `st:${assetId}:h:${digest}`;
}

/* =========================================================================
 * Store boundary
 * ========================================================================= */

export interface StorageMeterEventRow {
    id: string;
    tenantId: string;
    assetId: string;
    transition: StorageTransition;
    /** Absolute verified size after the transition; ignored for `retry`. */
    resultingBytes: number;
    idempotencyKey: string;
    source: StorageEvidenceSource;
    occurredAtMs: number;
}

/**
 * The read-only surface. Reconciliation is typed against THIS, so a
 * reconciliation pass has no writable handle to reach for by accident.
 */
export interface MediaMeteringReadStore {
    /** Ordered ascending by (occurredAtMs, idempotencyKey). */
    listEvents(tenantId: string, assetId?: string): Promise<StorageMeterEventRow[]>;
    /** Materialized counter; null when it was never written. */
    readStorageCounter(tenantId: string, assetId: string | null): Promise<number | null>;
}

/**
 * The scope of one metering unit: the two counter levels that must move
 * together. `tenantId` is the shared level, `assetId` the per-asset level.
 */
export interface MediaMeteringUnit {
    tenantId: string;
    assetId: string;
}

/**
 * A handle that is ONLY valid inside `MediaMeteringStore.withTransaction`.
 * Every method must execute on that transaction's single connection — never on
 * a pooled autocommit handle.
 */
export interface MediaMeteringTransaction {
    /** Server-side asset ownership lookup; a cross-tenant id resolves to null. */
    findAssetTenant(assetId: string): Promise<string | null>;
    /** Ordered ascending by (occurredAtMs, idempotencyKey), including this unit's writes. */
    listEvents(tenantId: string, assetId?: string): Promise<StorageMeterEventRow[]>;
    /** Returns false when (tenant_id, idempotency_key) already exists. */
    insertEvent(row: StorageMeterEventRow): Promise<boolean>;
    /** Materialized counter; null when it was never written. */
    readStorageCounter(tenantId: string, assetId: string | null): Promise<number | null>;
    /** Append-path materialization only. Reconciliation never calls this. */
    writeStorageCounter(tenantId: string, assetId: string | null, total: number): Promise<void>;
    recordAudit(input: AuditRecordInput): Promise<void>;
}

/**
 * The store port. Reads are available directly; ALL writes are reachable only
 * through the transaction callback, so there is no way to append an event or
 * move a counter outside the unit.
 */
export interface MediaMeteringStore extends MediaMeteringReadStore {
    /**
     * Run `work` as ONE connection-bound transaction over `unit`.
     *
     * Adapter contract (the I2 persistence owner must satisfy all of it):
     *  1. Lock order is TENANT counter row first, then ASSET counter row —
     *     always, on every writer. One order everywhere is what prevents a
     *     deadlock between two concurrent appends.
     *  2. `work` runs on the transaction's single connection. Statements
     *     issued by the handle must not escape to a pooled connection.
     *  3. Any throw from `work` (or from any statement) rolls back EVERYTHING
     *     — event row, both counter rows, audit row — and re-throws the
     *     original error. A partial commit is a contract violation.
     *  4. There is deliberately no fallback. An adapter that cannot open a
     *     transaction must not provide this method; the service then refuses
     *     the operation (`transactionRequired`) instead of writing loosely.
     */
    withTransaction<T>(
        unit: MediaMeteringUnit,
        work: (tx: MediaMeteringTransaction) => Promise<T>,
    ): Promise<T>;
}

/* =========================================================================
 * Rebuild
 * ========================================================================= */

export interface RebuiltStorageDelta {
    idempotencyKey: string;
    transition: StorageTransition;
    bytesDelta: number;
    totalAfter: number;
}

export interface RebuiltAssetStorage {
    assetId: string;
    total: number;
    eventCount: number;
    deltas: RebuiltStorageDelta[];
}

export interface RebuiltStorageTotals {
    tenantId: string;
    perAsset: RebuiltAssetStorage[];
    tenantTotal: number;
    eventCount: number;
}

function canonicalOrder(a: StorageMeterEventRow, b: StorageMeterEventRow): number {
    if (a.occurredAtMs !== b.occurredAtMs) return a.occurredAtMs - b.occurredAtMs;
    return a.idempotencyKey < b.idempotencyKey ? -1 : a.idempotencyKey > b.idempotencyKey ? 1 : 0;
}

/**
 * Recompute every per-asset total from the recorded events. Pure: no store
 * access, no mutation. This is the authority reconciliation compares against.
 */
export function rebuildStorageTotals(
    tenantId: string,
    events: readonly StorageMeterEventRow[],
): RebuiltStorageTotals {
    const scoped = events.filter((event) => event.tenantId === tenantId);
    const ordered = [...scoped].sort(canonicalOrder);
    const byAsset = new Map<string, RebuiltAssetStorage>();

    for (const event of ordered) {
        let state = byAsset.get(event.assetId);
        if (!state) {
            state = { assetId: event.assetId, total: 0, eventCount: 0, deltas: [] };
            byAsset.set(event.assetId, state);
        }
        const previous = state.total;
        let next: number;
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

/* =========================================================================
 * Service
 * ========================================================================= */

export interface VerifiedBytesInput {
    tenantId: unknown;
    assetId: unknown;
    resultingBytes: unknown;
    operationId: unknown;
    source: unknown;
    occurredAtMs?: unknown;
}

export interface StorageOperationInput {
    tenantId: unknown;
    assetId: unknown;
    operationId: unknown;
    source: unknown;
    occurredAtMs?: unknown;
}

interface RecordInput {
    tenantId: unknown;
    assetId: unknown;
    resultingBytes?: unknown;
    operationId: unknown;
    source: unknown;
    occurredAtMs?: unknown;
}

export type RecordStorageResult =
    | { recorded: true; deduplicated: false; transition: StorageTransition; bytesDelta: number; storageBytes: number }
    | { recorded: false; deduplicated: true; transition: null; storageBytes: number }
    | { error: string };

export interface MediaMeteringService {
    /** Derives `upload` for a first event and `replace` afterwards. */
    recordVerifiedBytes(input: VerifiedBytesInput): Promise<RecordStorageResult>;
    recordDelete(input: StorageOperationInput): Promise<RecordStorageResult>;
    recordRetry(input: StorageOperationInput): Promise<RecordStorageResult>;
    storageBytesForAsset(tenantId: string, assetId: string): Promise<number>;
    storageBytesForTenant(tenantId: string): Promise<number>;
    rebuild(tenantId: string, assetId?: string): Promise<RebuiltStorageTotals>;
}

export interface MediaMeteringDeps {
    store: MediaMeteringStore;
    idFactory?: () => string;
    now?: () => number;
}

type TransitionRequest = 'derive' | 'delete' | 'retry';

interface NormalizedOperation {
    tenantId: string;
    assetId: string;
    operationId: string;
    source: StorageEvidenceSource;
    occurredAtMs: number;
}

type OperationValidation =
    | { ok: true; value: NormalizedOperation }
    | { ok: false; error: string };

function validateOperation(input: {
    tenantId: unknown;
    assetId: unknown;
    operationId: unknown;
    source: unknown;
    occurredAtMs?: unknown;
}, now: () => number): OperationValidation {
    const tenantId = normalizeTenantId(input.tenantId);
    if (!tenantId) return { ok: false, error: STORAGE_METER_ERRORS.invalidTenant };
    const assetId = normalizeAssetId(input.assetId);
    if (!assetId) return { ok: false, error: STORAGE_METER_ERRORS.invalidAsset };
    const operationId = normalizeOperationId(input.operationId);
    if (!operationId) return { ok: false, error: STORAGE_METER_ERRORS.invalidOperation };
    const source = normalizeEvidenceSource(input.source);
    if (!source.ok) return source;
    const occurredAtMs = typeof input.occurredAtMs === 'number' && Number.isFinite(input.occurredAtMs) && input.occurredAtMs >= 0
        ? Math.trunc(input.occurredAtMs)
        : now();
    return { ok: true, value: { tenantId, assetId, operationId, source: source.value, occurredAtMs } };
}

export function createMediaMeteringService(deps: MediaMeteringDeps): MediaMeteringService {
    const store = deps.store;
    const idFactory = deps.idFactory ?? randomUUID;
    const now = deps.now ?? (() => Date.now());

    const record = async (
        input: RecordInput,
        request: TransitionRequest,
    ): Promise<RecordStorageResult> => {
        const validated = validateOperation(input, now);
        if (!validated.ok) return { error: validated.error };
        const { tenantId, assetId, operationId, source, occurredAtMs } = validated.value;

        // There is exactly one write path, and it is transaction-bound. A seam
        // that cannot open a transaction is refused, not degraded: a loose
        // append is how an event comes to exist without its counters.
        if (typeof store.withTransaction !== 'function') {
            return { error: STORAGE_METER_ERRORS.transactionRequired };
        }

        return store.withTransaction({ tenantId, assetId }, async (tx): Promise<RecordStorageResult> => {
            // Ownership is resolved from server rows INSIDE the unit — never
            // from the payload, and never from a pre-read outside it.
            const assetTenant = await tx.findAssetTenant(assetId);
            if (!assetTenant) return { error: STORAGE_METER_ERRORS.unknownAsset };
            if (assetTenant !== tenantId) return { error: STORAGE_METER_ERRORS.tenantMismatch };

            // One snapshot feeds the prior totals, the transition derivation
            // and (below) the out-of-order rebuild.
            const tenantEvents = await tx.listEvents(tenantId);
            const priorAssetEvents = tenantEvents.filter((event) => event.assetId === assetId);
            const priorAssetTotal = floorByteTotal(
                (await tx.readStorageCounter(tenantId, assetId))
                ?? rebuildStorageTotals(tenantId, priorAssetEvents).perAsset[0]?.total
                ?? 0,
            );
            const priorTenantTotal = floorByteTotal(
                (await tx.readStorageCounter(tenantId, null))
                ?? rebuildStorageTotals(tenantId, tenantEvents).tenantTotal,
            );

            let transition: StorageTransition;
            let resultingBytes: number;
            if (request === 'delete') {
                transition = 'delete';
                resultingBytes = 0;
            } else if (request === 'retry') {
                transition = 'retry';
                resultingBytes = priorAssetTotal;
            } else {
                transition = priorAssetEvents.length === 0 ? 'upload' : 'replace';
                const parsed = normalizeBytes(input.resultingBytes);
                if (parsed === null) return { error: STORAGE_METER_ERRORS.invalidBytes };
                if (parsed > MAX_STORAGE_BYTES_PER_ASSET) return { error: STORAGE_METER_ERRORS.bytesCap };
                resultingBytes = parsed;
            }

            const idempotencyKey = buildStorageIdempotencyKey(assetId, operationId);
            const row: StorageMeterEventRow = {
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
            if (!safeTenant || !safeAsset) return 0;
            const counter = await store.readStorageCounter(safeTenant, safeAsset);
            if (counter !== null) return counter;
            const rebuilt = rebuildStorageTotals(safeTenant, await store.listEvents(safeTenant, safeAsset));
            return rebuilt.perAsset[0]?.total ?? 0;
        },

        storageBytesForTenant: async (tenantId) => {
            const safeTenant = normalizeTenantId(tenantId);
            if (!safeTenant) return 0;
            const counter = await store.readStorageCounter(safeTenant, null);
            if (counter !== null) return counter;
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

/* =========================================================================
 * Reconciliation (read-only)
 * ========================================================================= */

export type StorageDiscrepancyReason = 'counter-drift' | 'counter-missing';

export interface StorageDiscrepancy {
    unit: 'storage_bytes';
    scope: 'tenant' | 'asset';
    tenantId: string;
    assetId: string | null;
    recordedTotal: number | null;
    rebuiltTotal: number;
    delta: number | null;
    eventCount: number;
    reason: StorageDiscrepancyReason;
}

export interface MediaUsageReconciliationReport {
    unit: 'storage_bytes';
    tenantId: string;
    assetId: string | null;
    checkedAtMs: number;
    status: 'match' | 'mismatch';
    eventCount: number;
    discrepancies: StorageDiscrepancy[];
    /** Explicit: reconciliation is a report, never a repair. */
    mutated: false;
}

export interface ReconcileStorageInput {
    /** Read-only by type: reconciliation has no write handle at all. */
    store: MediaMeteringReadStore;
    tenantId: string;
    assetId?: string | null;
    nowMs?: number;
}

function discrepancy(
    scope: 'tenant' | 'asset',
    tenantId: string,
    assetId: string | null,
    recordedTotal: number | null,
    rebuiltTotal: number,
    eventCount: number,
): StorageDiscrepancy | null {
    if (recordedTotal === null) {
        // No counter AND no event: the scope was never metered, so there is no
        // counter to be missing. Reporting this as a discrepancy would flag
        // every idle tenant/asset on every pass and bury the real gaps.
        if (eventCount === 0) return null;
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
    if (recordedTotal === rebuiltTotal) return null;
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
export async function reconcileStorageUsage(input: ReconcileStorageInput): Promise<MediaUsageReconciliationReport> {
    const tenantId = normalizeTenantId(input.tenantId);
    if (!tenantId) throw new Error(STORAGE_METER_ERRORS.invalidTenant);
    const assetId = input.assetId === undefined || input.assetId === null ? null : normalizeAssetId(input.assetId);
    if (input.assetId !== undefined && input.assetId !== null && !assetId) {
        throw new Error(STORAGE_METER_ERRORS.invalidAsset);
    }
    const checkedAtMs = typeof input.nowMs === 'number' && Number.isFinite(input.nowMs) ? Math.trunc(input.nowMs) : Date.now();

    const events = await input.store.listEvents(tenantId, assetId ?? undefined);
    const rebuilt = rebuildStorageTotals(tenantId, events);
    const discrepancies: StorageDiscrepancy[] = [];

    if (assetId) {
        const assetState = rebuilt.perAsset.find((asset) => asset.assetId === assetId);
        const recorded = await input.store.readStorageCounter(tenantId, assetId);
        const entry = discrepancy('asset', tenantId, assetId, recorded, assetState?.total ?? 0, assetState?.eventCount ?? 0);
        if (entry) discrepancies.push(entry);
    } else {
        const recordedTenant = await input.store.readStorageCounter(tenantId, null);
        const tenantEntry = discrepancy('tenant', tenantId, null, recordedTenant, rebuilt.tenantTotal, rebuilt.eventCount);
        if (tenantEntry) discrepancies.push(tenantEntry);
        // A tenant total can match while individual assets drift in opposite
        // directions, so every asset counter is compared as well.
        for (const asset of rebuilt.perAsset) {
            const recorded = await input.store.readStorageCounter(tenantId, asset.assetId);
            const entry = discrepancy('asset', tenantId, asset.assetId, recorded, asset.total, asset.eventCount);
            if (entry) discrepancies.push(entry);
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

/* =========================================================================
 * Reference adapter (hermetic tests and local composition)
 * ========================================================================= */

export interface InMemoryMediaMeteringStore extends MediaMeteringStore {
    readonly events: StorageMeterEventRow[];
    readonly counters: Map<string, number>;
    readonly audits: AuditRecordInput[];
    /** Register an asset owned by a tenant (mirrors a `video_assets` row). */
    seedAsset(assetId: string, tenantId: string): void;
}

const counterKey = (tenantId: string, assetId: string | null): string => `${tenantId}\u0000${assetId ?? '*'}`;

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
export function createInMemoryMediaMeteringStore(
    assets: ReadonlyArray<{ id: string; tenantId: string }> = [],
): InMemoryMediaMeteringStore {
    const assetTenants = new Map<string, string>(assets.map((asset) => [asset.id, asset.tenantId]));
    const events: StorageMeterEventRow[] = [];
    const keys = new Set<string>();
    const counters = new Map<string, number>();
    const audits: AuditRecordInput[] = [];

    // Tail of each tenant's queue. Always settles, so a failed unit never
    // blocks the next waiter.
    const tenantTails = new Map<string, Promise<void>>();

    const runExclusive = <T>(tenantId: string, work: () => Promise<T>): Promise<T> => {
        const tail = tenantTails.get(tenantId) ?? Promise.resolve();
        const run = tail.then(work, work);
        tenantTails.set(tenantId, run.then(() => undefined, () => undefined));
        return run;
    };

    const committedEvents = (tenantId: string, assetId?: string): StorageMeterEventRow[] =>
        events
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
            const pendingEvents: StorageMeterEventRow[] = [];
            const pendingKeys = new Set<string>();
            const pendingCounters = new Map<string, number>();
            const pendingAudits: AuditRecordInput[] = [];

            const tx: MediaMeteringTransaction = {
                findAssetTenant: async (assetId) => assetTenants.get(assetId) ?? null,
                listEvents: async (tenantId, assetId) => [
                    ...committedEvents(tenantId, assetId),
                    ...pendingEvents
                        .filter((event) => event.tenantId === tenantId && (assetId === undefined || event.assetId === assetId))
                        .map((event) => ({ ...event })),
                ],
                insertEvent: async (row) => {
                    const key = counterKey(row.tenantId, row.idempotencyKey);
                    if (keys.has(key) || pendingKeys.has(key)) return false;
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
            for (const event of pendingEvents) events.push(event);
            for (const key of pendingKeys) keys.add(key);
            for (const [key, total] of pendingCounters) counters.set(key, total);
            for (const audit of pendingAudits) audits.push(audit);
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

export const MEDIA_METERING_SCHEMA_CONTRACT = {
    /** I2-1 */
    events: 'video_storage_transitions',
    /** I2-2 */
    assetCounters: 'media_storage_asset_counters',
    tenantCounters: 'media_storage_tenant_counters',
    /** I2-4 */
    gapOutbox: 'media_usage_gap_outbox',
} as const;

export interface MediaMeteringSqlConnection {
    query: <T = unknown>(sql: string, params?: unknown[]) => Promise<T[]>;
    queryOne: <T = unknown>(sql: string, params?: unknown[]) => Promise<T | null>;
    execute: (sql: string, params?: unknown[]) => Promise<{ affectedRows?: number }>;
}

export interface MediaMeteringSqlDb {
    /** A single pooled connection; the caller releases it after commit/rollback. */
    getConnection: () => Promise<{
        connection: MediaMeteringSqlConnection;
        release: () => void | Promise<void>;
    }>;
}

function isDuplicateKey(error: unknown): boolean {
    if (!error || typeof error !== 'object') return false;
    const code = (error as { code?: unknown }).code;
    return code === 'ER_DUP_ENTRY' || code === 1062;
}

function toMysqlUtc(ms: number): string {
    return new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
}

function fromMysqlUtc(value: unknown): number {
    if (value instanceof Date) return value.getTime();
    if (typeof value === 'string' && value) {
        const date = new Date(/[TZ]/.test(value) ? value : `${value.replace(' ', 'T')}Z`);
        if (Number.isFinite(date.getTime())) return date.getTime();
    }
    return 0;
}

interface StorageTransitionDbRow {
    id: string;
    tenant_id: string;
    asset_id: string;
    transition: string;
    resulting_bytes: number | string;
    idempotency_key: string;
    evidence_source: string;
    occurred_at: unknown;
}

const TRANSITION_COLUMNS = `id, tenant_id, asset_id, transition, resulting_bytes,
    idempotency_key, evidence_source, occurred_at`;

function mapTransitionRow(row: StorageTransitionDbRow): StorageMeterEventRow | null {
    const transition = normalizeStorageTransition(row.transition);
    const source = normalizeEvidenceSource(row.evidence_source);
    if (!transition || !source.ok) return null;
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
export function createSqlMediaMeteringStore(db: MediaMeteringSqlDb): MediaMeteringStore {
    const listEventsOn = async (
        conn: MediaMeteringSqlConnection,
        tenantId: string,
        assetId?: string,
    ): Promise<StorageMeterEventRow[]> => {
        const rows = assetId === undefined
            ? await conn.query<StorageTransitionDbRow>(
                `SELECT ${TRANSITION_COLUMNS} FROM ${MEDIA_METERING_SCHEMA_CONTRACT.events}
                 WHERE tenant_id = ? ORDER BY occurred_at ASC, idempotency_key ASC`,
                [tenantId],
            )
            : await conn.query<StorageTransitionDbRow>(
                `SELECT ${TRANSITION_COLUMNS} FROM ${MEDIA_METERING_SCHEMA_CONTRACT.events}
                 WHERE tenant_id = ? AND asset_id = ? ORDER BY occurred_at ASC, idempotency_key ASC`,
                [tenantId, assetId],
            );
        return rows
            .map(mapTransitionRow)
            .filter((row): row is StorageMeterEventRow => row !== null);
    };

    const readCounterOn = async (
        conn: MediaMeteringSqlConnection,
        tenantId: string,
        assetId: string | null,
    ): Promise<number | null> => {
        const row = assetId === null
            ? await conn.queryOne<{ storage_bytes: number | string | null }>(
                `SELECT storage_bytes FROM ${MEDIA_METERING_SCHEMA_CONTRACT.tenantCounters} WHERE tenant_id = ? LIMIT 1`,
                [tenantId],
            )
            : await conn.queryOne<{ storage_bytes: number | string | null }>(
                `SELECT storage_bytes FROM ${MEDIA_METERING_SCHEMA_CONTRACT.assetCounters}
                 WHERE tenant_id = ? AND asset_id = ? LIMIT 1`,
                [tenantId, assetId],
            );
        if (!row || row.storage_bytes === null || row.storage_bytes === undefined) return null;
        const total = Number(row.storage_bytes);
        return Number.isSafeInteger(total) ? total : null;
    };

    const lockCounters = async (
        conn: MediaMeteringSqlConnection,
        unit: MediaMeteringUnit,
    ): Promise<void> => {
        // Tenant row first, always.
        await conn.execute(
            `INSERT INTO ${MEDIA_METERING_SCHEMA_CONTRACT.tenantCounters} (tenant_id, storage_bytes)
             VALUES (?, 0) ON DUPLICATE KEY UPDATE tenant_id = tenant_id`,
            [unit.tenantId],
        );
        await conn.query(
            `SELECT tenant_id FROM ${MEDIA_METERING_SCHEMA_CONTRACT.tenantCounters}
             WHERE tenant_id = ? FOR UPDATE`,
            [unit.tenantId],
        );
        // Then the asset row.
        await conn.execute(
            `INSERT INTO ${MEDIA_METERING_SCHEMA_CONTRACT.assetCounters} (tenant_id, asset_id, storage_bytes)
             VALUES (?, ?, 0) ON DUPLICATE KEY UPDATE asset_id = asset_id`,
            [unit.tenantId, unit.assetId],
        );
        await conn.query(
            `SELECT asset_id FROM ${MEDIA_METERING_SCHEMA_CONTRACT.assetCounters}
             WHERE tenant_id = ? AND asset_id = ? FOR UPDATE`,
            [unit.tenantId, unit.assetId],
        );
    };

    return {
        listEvents: (tenantId, assetId) => db.getConnection().then(async ({ connection, release }) => {
            try {
                return await listEventsOn(connection, tenantId, assetId);
            } finally {
                await release();
            }
        }),

        readStorageCounter: (tenantId, assetId) => db.getConnection().then(async ({ connection, release }) => {
            try {
                return await readCounterOn(connection, tenantId, assetId);
            } finally {
                await release();
            }
        }),

        withTransaction: async (unit, work) => {
            const { connection, release } = await db.getConnection();
            try {
                await connection.execute('START TRANSACTION');
                try {
                    await lockCounters(connection, unit);
                    const tx: MediaMeteringTransaction = {
                        findAssetTenant: async (assetId) => {
                            const row = await connection.queryOne<{ tenant_id: string | null }>(
                                'SELECT tenant_id FROM video_assets WHERE id = ? LIMIT 1',
                                [assetId],
                            );
                            return row?.tenant_id ?? null;
                        },
                        listEvents: (tenantId, assetId) => listEventsOn(connection, tenantId, assetId),
                        readStorageCounter: (tenantId, assetId) => readCounterOn(connection, tenantId, assetId),
                        insertEvent: async (row) => {
                            try {
                                await connection.execute(
                                    `INSERT INTO ${MEDIA_METERING_SCHEMA_CONTRACT.events}
                                       (id, tenant_id, asset_id, transition, resulting_bytes,
                                        idempotency_key, evidence_source, occurred_at)
                                     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                                    [
                                        row.id,
                                        row.tenantId,
                                        row.assetId,
                                        row.transition,
                                        row.resultingBytes,
                                        row.idempotencyKey,
                                        row.source,
                                        toMysqlUtc(row.occurredAtMs),
                                    ],
                                );
                                return true;
                            } catch (error) {
                                if (isDuplicateKey(error)) return false;
                                throw error;
                            }
                        },
                        writeStorageCounter: async (tenantId, assetId, total) => {
                            if (assetId === null) {
                                await connection.execute(
                                    `INSERT INTO ${MEDIA_METERING_SCHEMA_CONTRACT.tenantCounters}
                                       (tenant_id, storage_bytes, updated_at)
                                     VALUES (?, ?, UTC_TIMESTAMP())
                                     ON DUPLICATE KEY UPDATE storage_bytes = VALUES(storage_bytes),
                                                             updated_at = UTC_TIMESTAMP()`,
                                    [tenantId, total],
                                );
                                return;
                            }
                            await connection.execute(
                                `INSERT INTO ${MEDIA_METERING_SCHEMA_CONTRACT.assetCounters}
                                   (tenant_id, asset_id, storage_bytes, updated_at)
                                 VALUES (?, ?, ?, UTC_TIMESTAMP())
                                 ON DUPLICATE KEY UPDATE storage_bytes = VALUES(storage_bytes),
                                                         updated_at = UTC_TIMESTAMP()`,
                                [tenantId, assetId, total],
                            );
                        },
                        recordAudit: async (input) => {
                            await recordAudit(connection.execute, input);
                        },
                    };
                    const result = await work(tx);
                    await connection.execute('COMMIT');
                    return result;
                } catch (error) {
                    // A partial commit is a contract violation, so every throw
                    // rolls back the event, BOTH counters and the audit row.
                    await connection.execute('ROLLBACK');
                    throw error;
                }
            } finally {
                await release();
            }
        },
    };
}

/* =========================================================================
 * Gap outbox (I2-4) — a deferred or unconfigured byte count is never lost
 * ========================================================================= */

export type MediaGapReason = 'metering_deferred' | 'metering_unconfigured';

export type MediaGapStatus = 'pending' | 'delivered';

export interface MediaUsageGapRow {
    id: string;
    tenantId: string;
    assetId: string;
    operationId: string;
    resultingBytes: number;
    source: StorageEvidenceSource;
    occurredAtMs: number;
    reason: MediaGapReason;
    status: MediaGapStatus;
    attempts: number;
    lastAttemptAtMs: number | null;
    lastError: string | null;
    createdAtMs: number;
}

export interface MediaUsageGapOutbox {
    /** Deduplicated on (tenant_id, asset_id, operation_id). */
    enqueue(row: MediaUsageGapRow): Promise<{ enqueued: boolean; duplicate: boolean }>;
    /** Oldest first, bounded by `limit`. */
    listPending(tenantId: string, limit: number): Promise<MediaUsageGapRow[]>;
    markDelivered(id: string, atMs: number): Promise<void>;
    /** Keeps the row pending and records the failure; attempts is incremented. */
    markAttemptFailed(id: string, atMs: number, error: string): Promise<void>;
}

export interface GapDrainInput {
    outbox: MediaUsageGapOutbox;
    meter: Pick<MediaMeteringService, 'recordVerifiedBytes'>;
    tenantId: string;
    limit?: number;
    maxAttempts?: number;
    nowMs?: number;
}

export interface GapDrainReport {
    tenantId: string;
    attempted: number;
    delivered: number;
    deduplicated: number;
    deferred: number;
    exhausted: number;
    mutated: true;
}

export const DEFAULT_GAP_DRAIN_LIMIT = 50;
export const DEFAULT_GAP_MAX_ATTEMPTS = 5;

/**
 * Re-drive pending gaps through the SAME verified path the live callback used.
 * The meter's own idempotency key absorbs a gap that was already applied, so a
 * retry can never double-count. A row that keeps failing stops at
 * `maxAttempts` and is reported as `exhausted` instead of retrying forever.
 */
export async function drainMediaUsageGaps(input: GapDrainInput): Promise<GapDrainReport> {
    const tenantId = normalizeTenantId(input.tenantId);
    if (!tenantId) throw new Error(STORAGE_METER_ERRORS.invalidTenant);
    const limit = Math.min(500, Math.max(1, Math.trunc(input.limit ?? DEFAULT_GAP_DRAIN_LIMIT)));
    const maxAttempts = Math.max(1, Math.trunc(input.maxAttempts ?? DEFAULT_GAP_MAX_ATTEMPTS));
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
            } else {
                delivered += 1;
            }
            await input.outbox.markDelivered(gap.id, at);
        } catch (error) {
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

export interface InMemoryGapOutbox extends MediaUsageGapOutbox {
    readonly rows: MediaUsageGapRow[];
}

/** A real adapter: it stores rows, enforces the dedupe key and counts attempts. */
export function createInMemoryGapOutbox(): InMemoryGapOutbox {
    const rows: MediaUsageGapRow[] = [];
    const keys = new Set<string>();
    return {
        rows,
        enqueue: async (row) => {
            const key = `${row.tenantId}\u0000${row.assetId}\u0000${row.operationId}`;
            if (keys.has(key)) return { enqueued: false, duplicate: true };
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
            if (!row) return;
            row.status = 'delivered';
            row.lastAttemptAtMs = atMs;
            row.lastError = null;
        },
        markAttemptFailed: async (id, atMs, error) => {
            const row = rows.find((entry) => entry.id === id);
            if (!row) return;
            row.attempts += 1;
            row.lastAttemptAtMs = atMs;
            row.lastError = error.slice(0, 500);
        },
    };
}

/** SQL gap outbox over I2-4. Unique key `(tenant_id, asset_id, operation_id)`. */
export function createSqlMediaGapOutbox(db: MediaMeteringSqlDb): MediaUsageGapOutbox {
    const withConnection = async <T>(work: (conn: MediaMeteringSqlConnection) => Promise<T>): Promise<T> => {
        const { connection, release } = await db.getConnection();
        try {
            return await work(connection);
        } finally {
            await release();
        }
    };

    return {
        enqueue: (row) => withConnection(async (conn) => {
            try {
                await conn.execute(
                    `INSERT INTO ${MEDIA_METERING_SCHEMA_CONTRACT.gapOutbox}
                       (id, tenant_id, asset_id, operation_id, resulting_bytes, evidence_source,
                        occurred_at, reason, status, attempts, created_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, UTC_TIMESTAMP())`,
                    [
                        row.id,
                        row.tenantId,
                        row.assetId,
                        row.operationId,
                        row.resultingBytes,
                        row.source,
                        toMysqlUtc(row.occurredAtMs),
                        row.reason,
                    ],
                );
                return { enqueued: true, duplicate: false };
            } catch (error) {
                if (isDuplicateKey(error)) return { enqueued: false, duplicate: true };
                throw error;
            }
        }),

        listPending: (tenantId, limit) => withConnection(async (conn) => {
            const rows = await conn.query<{
                id: string; tenant_id: string; asset_id: string; operation_id: string;
                resulting_bytes: number | string; evidence_source: string; occurred_at: unknown;
                reason: string; status: string; attempts: number | string; last_attempt_at: unknown;
                last_error: string | null; created_at: unknown;
            }>(
                `SELECT id, tenant_id, asset_id, operation_id, resulting_bytes, evidence_source,
                        occurred_at, reason, status, attempts, last_attempt_at, last_error, created_at
                 FROM ${MEDIA_METERING_SCHEMA_CONTRACT.gapOutbox}
                 WHERE tenant_id = ? AND status = 'pending'
                 ORDER BY created_at ASC, id ASC LIMIT ?`,
                [tenantId, limit],
            );
            const mapped: MediaUsageGapRow[] = [];
            for (const row of rows) {
                const source = normalizeEvidenceSource(row.evidence_source);
                const reason = row.reason === 'metering_unconfigured' ? 'metering_unconfigured' : 'metering_deferred';
                if (!source.ok) continue;
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
            await conn.execute(
                `UPDATE ${MEDIA_METERING_SCHEMA_CONTRACT.gapOutbox}
                 SET status = 'delivered', last_attempt_at = ?, last_error = NULL
                 WHERE id = ?`,
                [toMysqlUtc(atMs), id],
            );
        }),

        markAttemptFailed: (id, atMs, error) => withConnection(async (conn) => {
            await conn.execute(
                `UPDATE ${MEDIA_METERING_SCHEMA_CONTRACT.gapOutbox}
                 SET attempts = attempts + 1, last_attempt_at = ?, last_error = ?
                 WHERE id = ? AND status = 'pending'`,
                [toMysqlUtc(atMs), error.slice(0, 500), id],
            );
        }),
    };
}
