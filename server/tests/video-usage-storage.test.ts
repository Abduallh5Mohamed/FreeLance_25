/**
 * B2-W6 — storage byte meter per asset (regression suite).
 *
 * Every case drives the REAL `createMediaMeteringService` over the REAL
 * in-memory adapter. The adapter only stores events and counters; it never
 * decides a transition or a delta, so the assertions exercise the production
 * decision path rather than a mock that pre-answers it.
 *
 * Units under test are bytes only. Watch seconds live in a separate ledger and
 * are asserted here solely to prove the two units never move each other.
 */
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import {
    STORAGE_METER_ERRORS,
    createInMemoryMediaMeteringStore,
    createMediaMeteringService,
    type InMemoryMediaMeteringStore,
    type MediaMeteringService,
    type MediaMeteringStore,
    type VerifiedBytesInput,
} from '../src/services/media-usage-reconciliation';
import {
    createVideoUsageEventService,
    type NewUsageEventRow,
    type VideoUsageStore,
} from '../src/services/video-usage-events';
import {
    createVideoAssetLifecycle,
    type AssetUpdate,
    type NewVideoAsset,
    type NewVideoAssetCallback,
    type VideoAssetRecord,
    type VideoAssetStore,
} from '../src/services/video-asset-lifecycle';
import { verifyUsageCallbackFromEnv, type UsageCallbackInput } from '../src/routes/video-assets';
import type { AuditRecordInput } from '../src/security/audit';

const TENANT = 'tenant-a';
const ASSET = 'asset-1';

const seqId = (): (() => string) => {
    let n = 0;
    return () => `meter-${++n}`;
};

interface MeterHarness {
    store: InMemoryMediaMeteringStore;
    service: MediaMeteringService;
}

const build = (): MeterHarness => {
    const store = createInMemoryMediaMeteringStore([{ id: ASSET, tenantId: TENANT }]);
    const service = createMediaMeteringService({ store, idFactory: seqId(), now: () => 1_000 });
    return { store, service };
};

const bytesInput = (overrides: Partial<VerifiedBytesInput> = {}): VerifiedBytesInput => ({
    tenantId: TENANT,
    assetId: ASSET,
    resultingBytes: 1_000,
    operationId: 'op-upload',
    source: 'provider-callback',
    occurredAtMs: 100,
    ...overrides,
});

/* =========================================================================
 * Upload / replace deltas
 * ========================================================================= */

test('storage: an upload establishes the asset meter exactly once', async () => {
    const { store, service } = build();
    const first = await service.recordVerifiedBytes(bytesInput());
    assert.deepEqual(first, {
        recorded: true,
        deduplicated: false,
        transition: 'upload',
        bytesDelta: 1_000,
        storageBytes: 1_000,
    });
    assert.equal(await service.storageBytesForAsset(TENANT, ASSET), 1_000);
    assert.equal(store.events.length, 1);
});

test('storage: a replayed upload callback is absorbed and never double counts', async () => {
    const { store, service } = build();
    await service.recordVerifiedBytes(bytesInput());
    const replay = await service.recordVerifiedBytes(bytesInput());
    assert.deepEqual(replay, {
        recorded: false,
        deduplicated: true,
        transition: null,
        storageBytes: 1_000,
    });
    assert.equal(store.events.length, 1);
    assert.equal(await service.storageBytesForAsset(TENANT, ASSET), 1_000);
});

test('storage: a replacement applies a delta, not a second full amount', async () => {
    const { store, service } = build();
    await service.recordVerifiedBytes(bytesInput({ operationId: 'op-1', resultingBytes: 1_000, occurredAtMs: 100 }));
    const replaced = await service.recordVerifiedBytes(bytesInput({ operationId: 'op-2', resultingBytes: 600, occurredAtMs: 200 }));
    assert.deepEqual(replaced, {
        recorded: true,
        deduplicated: false,
        transition: 'replace',
        bytesDelta: -400,
        storageBytes: 600,
    });
    assert.equal(await service.storageBytesForAsset(TENANT, ASSET), 600);
    assert.equal(store.events.length, 2);
});

test('storage: a replacement with the same size applies a zero delta', async () => {
    const { service } = build();
    await service.recordVerifiedBytes(bytesInput({ operationId: 'op-1', resultingBytes: 800, occurredAtMs: 100 }));
    const same = await service.recordVerifiedBytes(bytesInput({ operationId: 'op-2', resultingBytes: 800, occurredAtMs: 200 }));
    assert.deepEqual(same, {
        recorded: true,
        deduplicated: false,
        transition: 'replace',
        bytesDelta: 0,
        storageBytes: 800,
    });
});

/* =========================================================================
 * Delete / retry
 * ========================================================================= */

test('storage: a delete cannot drive the counter negative and a second delete is idempotent', async () => {
    const { store, service } = build();
    await service.recordVerifiedBytes(bytesInput({ operationId: 'op-1', resultingBytes: 500, occurredAtMs: 100 }));

    const deleted = await service.recordDelete({ tenantId: TENANT, assetId: ASSET, operationId: 'del-1', source: 'provider-callback', occurredAtMs: 200 });
    assert.deepEqual(deleted, {
        recorded: true,
        deduplicated: false,
        transition: 'delete',
        bytesDelta: -500,
        storageBytes: 0,
    });
    assert.equal(await service.storageBytesForAsset(TENANT, ASSET), 0);

    // Same provider operation: absorbed by the idempotency key.
    const replayed = await service.recordDelete({ tenantId: TENANT, assetId: ASSET, operationId: 'del-1', source: 'provider-callback', occurredAtMs: 200 });
    assert.deepEqual(replayed, { recorded: false, deduplicated: true, transition: null, storageBytes: 0 });

    // A distinct delete against an already-empty asset stays at zero.
    const second = await service.recordDelete({ tenantId: TENANT, assetId: ASSET, operationId: 'del-2', source: 'provider-callback', occurredAtMs: 300 });
    assert.deepEqual(second, {
        recorded: true,
        deduplicated: false,
        transition: 'delete',
        bytesDelta: 0,
        storageBytes: 0,
    });
    assert.ok(await service.storageBytesForAsset(TENANT, ASSET) >= 0);
    assert.equal(store.events.length, 3);
});

test('storage: a retry transition applies a zero delta and is idempotent', async () => {
    const { service } = build();
    await service.recordVerifiedBytes(bytesInput({ operationId: 'op-1', resultingBytes: 900, occurredAtMs: 100 }));
    const retry = await service.recordRetry({ tenantId: TENANT, assetId: ASSET, operationId: 'retry-1', source: 'server-measured', occurredAtMs: 150 });
    assert.deepEqual(retry, {
        recorded: true,
        deduplicated: false,
        transition: 'retry',
        bytesDelta: 0,
        storageBytes: 900,
    });
    const replay = await service.recordRetry({ tenantId: TENANT, assetId: ASSET, operationId: 'retry-1', source: 'server-measured', occurredAtMs: 150 });
    assert.deepEqual(replay, { recorded: false, deduplicated: true, transition: null, storageBytes: 900 });
});

/* =========================================================================
 * Ordering
 * ========================================================================= */

test('storage: out-of-order callbacks converge on the logically latest size without a negative prefix', async () => {
    const { service } = build();
    // The newer absolute size arrives first; the older upload arrives second.
    await service.recordVerifiedBytes(bytesInput({ operationId: 'op-late', resultingBytes: 600, occurredAtMs: 200 }));
    await service.recordVerifiedBytes(bytesInput({ operationId: 'op-early', resultingBytes: 1_000, occurredAtMs: 100 }));
    // Canonical order is (t=100 upload 1000) then (t=200 replace 600).
    assert.equal(await service.storageBytesForAsset(TENANT, ASSET), 600);
    assert.equal(await service.storageBytesForTenant(TENANT), 600);

    const rebuilt = await service.rebuild(TENANT);
    assert.equal(rebuilt.tenantTotal, 600);
    assert.equal(rebuilt.perAsset.length, 1);
    assert.equal(rebuilt.perAsset[0]?.total, 600);
    for (const delta of rebuilt.perAsset[0]?.deltas ?? []) {
        assert.ok(delta.totalAfter >= 0, `negative prefix at ${delta.idempotencyKey}`);
    }
});

/* =========================================================================
 * Concurrency: the append path is ONE transaction, so no delta is lost
 * ========================================================================= */

test('storage: two parallel assets in one tenant both land on the shared tenant counter', async () => {
    const store = createInMemoryMediaMeteringStore([
        { id: 'asset-1', tenantId: TENANT },
        { id: 'asset-2', tenantId: TENANT },
    ]);
    const service = createMediaMeteringService({ store, idFactory: seqId(), now: () => 1_000 });

    const [first, second] = await Promise.all([
        service.recordVerifiedBytes({ tenantId: TENANT, assetId: 'asset-1', resultingBytes: 1_000, operationId: 'op-a', source: 'provider-callback', occurredAtMs: 100 }),
        service.recordVerifiedBytes({ tenantId: TENANT, assetId: 'asset-2', resultingBytes: 2_000, operationId: 'op-b', source: 'provider-callback', occurredAtMs: 110 }),
    ]);
    assert.equal('error' in first ? first.error : first.storageBytes, 1_000);
    assert.equal('error' in second ? second.error : second.storageBytes, 2_000);
    assert.equal(await service.storageBytesForAsset(TENANT, 'asset-1'), 1_000);
    assert.equal(await service.storageBytesForAsset(TENANT, 'asset-2'), 2_000);
    // The shared tenant counter must carry BOTH deltas: 1_000 + 2_000.
    assert.equal(await service.storageBytesForTenant(TENANT), 3_000);
    // ...and agree with a rebuild of what was actually recorded.
    assert.equal((await service.rebuild(TENANT)).tenantTotal, 3_000);
});

test('storage: a replacement interleaved with another append lands both deltas exactly once', async () => {
    const store = createInMemoryMediaMeteringStore([
        { id: 'asset-1', tenantId: TENANT },
        { id: 'asset-2', tenantId: TENANT },
    ]);
    const service = createMediaMeteringService({ store, idFactory: seqId(), now: () => 1_000 });
    // Committed baseline: asset-1 = 1_000, tenant = 1_000.
    await service.recordVerifiedBytes({ tenantId: TENANT, assetId: 'asset-1', resultingBytes: 1_000, operationId: 'op-base', source: 'provider-callback', occurredAtMs: 100 });

    // A replace of asset-1 (delta -400) races an append on asset-2 (+500).
    const [replaced, appended] = await Promise.all([
        service.recordVerifiedBytes({ tenantId: TENANT, assetId: 'asset-1', resultingBytes: 600, operationId: 'op-replace', source: 'provider-callback', occurredAtMs: 200 }),
        service.recordVerifiedBytes({ tenantId: TENANT, assetId: 'asset-2', resultingBytes: 500, operationId: 'op-append', source: 'provider-callback', occurredAtMs: 210 }),
    ]);
    assert.ok(!('error' in replaced));
    assert.ok(replaced.recorded);
    assert.equal(replaced.bytesDelta, -400);
    assert.ok(!('error' in appended));
    assert.ok(appended.recorded);
    assert.equal(appended.bytesDelta, 500);

    assert.equal(await service.storageBytesForAsset(TENANT, 'asset-1'), 600);
    assert.equal(await service.storageBytesForAsset(TENANT, 'asset-2'), 500);
    // Both deltas applied once: 1_000 - 400 + 500.
    assert.equal(await service.storageBytesForTenant(TENANT), 1_100);
    assert.equal(store.events.length, 3);
    assert.equal((await service.rebuild(TENANT)).tenantTotal, 1_100);
});

test('storage: a replace interleaved with an earlier-timestamped replace loses neither delta', async () => {
    const { store, service } = build();
    await service.recordVerifiedBytes(bytesInput({ operationId: 'op-base', resultingBytes: 1_000, occurredAtMs: 100 }));

    // The later event (t=400) is submitted first; the earlier one (t=200)
    // second. A read-modify-write append lets the second unit overwrite the
    // first with a total that ignores it; both must survive.
    const [later, earlier] = await Promise.all([
        service.recordVerifiedBytes(bytesInput({ operationId: 'op-late', resultingBytes: 600, occurredAtMs: 400 })),
        service.recordVerifiedBytes(bytesInput({ operationId: 'op-early', resultingBytes: 800, occurredAtMs: 200 })),
    ]);
    assert.ok(!('error' in later));
    assert.ok(!('error' in earlier));

    // Canonical order: base 1_000 -> 800 (t=200) -> 600 (t=400).
    assert.equal(await service.storageBytesForAsset(TENANT, ASSET), 600);
    assert.equal(await service.storageBytesForTenant(TENANT), 600);
    assert.equal(store.events.length, 3);
    const rebuilt = await service.rebuild(TENANT);
    assert.equal(rebuilt.tenantTotal, 600);
    assert.deepEqual(
        rebuilt.perAsset[0]?.deltas.map((delta) => [delta.transition, delta.bytesDelta]),
        [['upload', 1_000], ['replace', -200], ['replace', -200]],
    );
});

/* =========================================================================
 * Idempotency inside the unit
 * ========================================================================= */

test('storage: a duplicate is absorbed inside the unit and never touches a counter', async () => {
    const store = createInMemoryMediaMeteringStore([{ id: ASSET, tenantId: TENANT }]);
    let transactions = 0;
    // Counts units of work without changing their semantics.
    const counting: MediaMeteringStore = {
        listEvents: (tenantId, assetId) => store.listEvents(tenantId, assetId),
        readStorageCounter: (tenantId, assetId) => store.readStorageCounter(tenantId, assetId),
        withTransaction: (unit, work) => {
            transactions += 1;
            return store.withTransaction(unit, work);
        },
    };
    const service = createMediaMeteringService({ store: counting, idFactory: seqId(), now: () => 1_000 });

    await service.recordVerifiedBytes(bytesInput({ operationId: 'op-dup', resultingBytes: 700, occurredAtMs: 100 }));
    const countersAfterFirst = new Map(store.counters);
    const replay = await service.recordVerifiedBytes(bytesInput({ operationId: 'op-dup', resultingBytes: 700, occurredAtMs: 100 }));

    // The duplicate was decided by a real unit of work (the insert is only
    // reachable through the transaction handle), not by a pre-read outside it.
    assert.equal(transactions, 2);
    assert.deepEqual(replay, { recorded: false, deduplicated: true, transition: null, storageBytes: 700 });
    assert.equal(store.events.length, 1);
    // No counter moved on the duplicate.
    assert.deepEqual(store.counters, countersAfterFirst);
    // The dedupe itself is auditable, and it committed inside the unit.
    assert.equal(store.audits.filter((audit) => audit.action === 'video.usage.storage.deduplicated').length, 1);
    assert.equal(store.audits.filter((audit) => audit.action === 'video.usage.storage.recorded').length, 1);
});

/* =========================================================================
 * Out-of-order rebuild uses the same snapshot as the append
 * ========================================================================= */

test('storage: an out-of-order append rebuilds from the snapshot it appends to', async () => {
    const { store, service } = build();
    // The newer size arrives first, the older upload second (out of order).
    await service.recordVerifiedBytes(bytesInput({ operationId: 'op-late', resultingBytes: 600, occurredAtMs: 200 }));
    await service.recordVerifiedBytes(bytesInput({ operationId: 'op-early', resultingBytes: 1_000, occurredAtMs: 100 }));

    const rebuilt = await service.rebuild(TENANT);
    assert.equal(await service.storageBytesForAsset(TENANT, ASSET), rebuilt.perAsset[0]?.total);
    assert.equal(await service.storageBytesForTenant(TENANT), rebuilt.tenantTotal);
    assert.equal(rebuilt.tenantTotal, 600);

    // The rebuild is audited with exactly the before/after it wrote, so the
    // counter and the snapshot cannot silently disagree.
    const rebuildAudits = store.audits.filter((audit) => audit.action === 'video.usage.storage.out_of_order_rebuild');
    assert.equal(rebuildAudits.length, 1);
    assert.deepEqual(rebuildAudits[0]?.newValue, { asset_total: 600, tenant_total: 600 });
    assert.deepEqual(rebuildAudits[0]?.oldValue, { asset_total: 600, tenant_total: 600 });
});

/* =========================================================================
 * No transaction seam: fail closed, never a loose write
 * ========================================================================= */

test('storage: a store without a transaction seam is refused and writes nothing', async () => {
    const store = createInMemoryMediaMeteringStore([{ id: ASSET, tenantId: TENANT }]);
    let looseWrites = 0;
    // A JS adapter that predates the transactional port: it still exposes the
    // legacy loose writes, but no `withTransaction`. TypeScript cannot express
    // "non-conforming store", so the cast is the fixture — it is the exact
    // shape the runtime guard defends against.
    const legacy = {
        listEvents: (tenantId: string, assetId?: string) => store.listEvents(tenantId, assetId),
        readStorageCounter: (tenantId: string, assetId: string | null) => store.readStorageCounter(tenantId, assetId),
        findAssetTenant: async (): Promise<string> => TENANT,
        insertEvent: async (): Promise<boolean> => { looseWrites += 1; return true; },
        writeStorageCounter: async (): Promise<void> => { looseWrites += 1; },
        recordAudit: async (): Promise<void> => { looseWrites += 1; },
    } as unknown as MediaMeteringStore;
    const service = createMediaMeteringService({ store: legacy, idFactory: seqId(), now: () => 1_000 });

    const result = await service.recordVerifiedBytes(bytesInput());
    assert.deepEqual(result, { error: STORAGE_METER_ERRORS.transactionRequired });
    assert.equal(looseWrites, 0, 'no write may happen outside a transaction');
    assert.equal(store.events.length, 0);
    assert.equal(await store.readStorageCounter(TENANT, ASSET), null);
    assert.equal(await store.readStorageCounter(TENANT, null), null);
});

/* =========================================================================
 * Authority: tenant binding and evidence source
 * ========================================================================= */

test('storage: a foreign-tenant event is rejected before any write', async () => {
    const { store, service } = build();
    const foreign = await service.recordVerifiedBytes(bytesInput({ tenantId: 'tenant-b', operationId: 'op-x' }));
    assert.deepEqual(foreign, { error: STORAGE_METER_ERRORS.tenantMismatch });
    assert.equal(store.events.length, 0);
    assert.equal(await service.storageBytesForTenant('tenant-b'), 0);
    assert.equal(await service.storageBytesForTenant(TENANT), 0);
});

test('storage: an unknown asset is rejected before any write', async () => {
    const { store, service } = build();
    const unknown = await service.recordVerifiedBytes(bytesInput({ assetId: 'asset-ghost' }));
    assert.deepEqual(unknown, { error: STORAGE_METER_ERRORS.unknownAsset });
    assert.equal(store.events.length, 0);
});

test('storage: a forged client byte claim is ignored with no counter change', async () => {
    const { store, service } = build();
    const client = await service.recordVerifiedBytes(bytesInput({ source: 'client-claimed', resultingBytes: 9_999_999 }));
    assert.deepEqual(client, { error: STORAGE_METER_ERRORS.clientClaim });
    assert.equal(store.events.length, 0);
    assert.equal(await service.storageBytesForAsset(TENANT, ASSET), 0);
});

test('storage: object metadata is an observation, not live provider proof', async () => {
    const { store, service } = build();
    const observed = await service.recordVerifiedBytes(bytesInput({ source: 'object-metadata-observed' }));
    assert.deepEqual(observed, { error: STORAGE_METER_ERRORS.metadataObservation });
    assert.equal(store.events.length, 0);
});

test('storage: an unrecognised evidence source is rejected', async () => {
    const { store, service } = build();
    const bogus = await service.recordVerifiedBytes(bytesInput({ source: 'trust-me' }));
    assert.deepEqual(bogus, { error: STORAGE_METER_ERRORS.unverifiedSource });
    assert.equal(store.events.length, 0);
});

test('storage: malformed identity and byte fields are rejected', async () => {
    const { service } = build();
    assert.deepEqual(await service.recordVerifiedBytes(bytesInput({ tenantId: '' })), { error: STORAGE_METER_ERRORS.invalidTenant });
    assert.deepEqual(await service.recordVerifiedBytes(bytesInput({ assetId: 'bad id' })), { error: STORAGE_METER_ERRORS.invalidAsset });
    assert.deepEqual(await service.recordVerifiedBytes(bytesInput({ operationId: '' })), { error: STORAGE_METER_ERRORS.invalidOperation });
    assert.deepEqual(await service.recordVerifiedBytes(bytesInput({ resultingBytes: -1 })), { error: STORAGE_METER_ERRORS.invalidBytes });
    assert.deepEqual(await service.recordVerifiedBytes(bytesInput({ resultingBytes: 1.5 })), { error: STORAGE_METER_ERRORS.invalidBytes });
});

/* =========================================================================
 * Rebuild
 * ========================================================================= */

test('storage: rebuild from the recorded events matches the known event set exactly', async () => {
    const { store, service } = build();
    await service.recordVerifiedBytes(bytesInput({ operationId: 'op-1', resultingBytes: 1_000, occurredAtMs: 100 }));
    await service.recordVerifiedBytes(bytesInput({ operationId: 'op-2', resultingBytes: 640, occurredAtMs: 200 }));
    await service.recordRetry({ tenantId: TENANT, assetId: ASSET, operationId: 'retry-1', source: 'server-measured', occurredAtMs: 250 });
    await service.recordDelete({ tenantId: TENANT, assetId: ASSET, operationId: 'del-1', source: 'provider-callback', occurredAtMs: 300 });

    const rebuilt = await service.rebuild(TENANT);
    assert.equal(rebuilt.eventCount, 4);
    assert.equal(rebuilt.tenantTotal, 0);
    assert.deepEqual(
        rebuilt.perAsset[0]?.deltas.map((delta) => [delta.transition, delta.bytesDelta, delta.totalAfter]),
        [
            ['upload', 1_000, 1_000],
            ['replace', -360, 640],
            ['retry', 0, 640],
            ['delete', -640, 0],
        ],
    );
    // Rebuilding is pure: it neither appends nor rewrites the materialized counter.
    assert.equal(store.events.length, 4);
});

/* =========================================================================
 * Unit separation
 * ========================================================================= */

interface WatchHarness {
    store: VideoUsageStore;
    events: NewUsageEventRow[];
    keys: Set<string>;
}

const makeWatchStore = (): WatchHarness => {
    const events: NewUsageEventRow[] = [];
    const keys = new Set<string>();
    const store: VideoUsageStore = {
        insertEvent: async (row) => {
            const key = `${row.tenantId}:${row.dedupeKey}`;
            if (keys.has(key)) return false;
            keys.add(key);
            events.push({ ...row });
            return true;
        },
        listEvents: async (tenantId, kind) =>
            events.filter((event) => event.tenantId === tenantId && (kind === undefined || event.kind === kind)),
        sumWatchSeconds: async (tenantId) =>
            events.filter((event) => event.tenantId === tenantId).reduce((sum, event) => sum + event.watchSeconds, 0),
        sumStorageBytes: async (tenantId) =>
            events.filter((event) => event.tenantId === tenantId).reduce((sum, event) => sum + event.storageBytes, 0),
        sumWatchSecondsForEnrollment: async (enrollmentId, sinceMs) =>
            events
                .filter((event) => event.studentEnrollmentId === enrollmentId && event.kind === 'watch' && event.occurredAtMs >= sinceMs)
                .reduce((sum, event) => sum + event.watchSeconds, 0),
        countWatchEventsForEnrollment: async (enrollmentId, sinceMs) =>
            events.filter((event) => event.studentEnrollmentId === enrollmentId && event.kind === 'watch' && event.occurredAtMs >= sinceMs).length,
        recordAudit: async () => undefined,
    };
    return { store, events, keys };
};

test('units: a storage event never moves the watch counter and a watch event never moves storage', async () => {
    const meter = build();
    const watch = makeWatchStore();
    const watchService = createVideoUsageEventService({ store: watch.store, idFactory: seqId() });

    await meter.service.recordVerifiedBytes(bytesInput({ operationId: 'op-1', resultingBytes: 4_096 }));
    assert.equal(await meter.service.storageBytesForAsset(TENANT, ASSET), 4_096);
    assert.equal(await watchService.watchSeconds(TENANT), 0);
    assert.equal(await watchService.rebuildWatchSeconds(TENANT), 0);

    await watchService.record({ tenantId: TENANT, kind: 'watch', dedupeKey: 'hb:sess:1', watchSeconds: 30, sessionId: 'sess-1' });
    assert.equal(await watchService.watchSeconds(TENANT), 30);
    assert.equal(await meter.service.storageBytesForAsset(TENANT, ASSET), 4_096);
    assert.equal(watch.events.length, 1);
});

/* =========================================================================
 * Lifecycle boundary binding
 * ========================================================================= */

interface LifecycleHarness {
    store: VideoAssetStore;
    audits: AuditRecordInput[];
}

const makeLifecycleStore = (): LifecycleHarness => {
    const assets = new Map<string, VideoAssetRecord>();
    const callbacks = new Set<string>();
    const audits: AuditRecordInput[] = [];
    const store: VideoAssetStore = {
        insertAsset: async (row: NewVideoAsset) => {
            assets.set(row.id, {
                id: row.id,
                tenantId: row.tenantId,
                ownerUserId: row.ownerUserId,
                provider: row.provider,
                providerAssetId: row.providerAssetId,
                title: row.title,
                status: 'uploaded',
                attempts: 0,
                maxAttempts: row.maxAttempts,
                lastError: null,
                deadLettered: false,
                deadLetterReason: null,
            });
        },
        findAssetById: async (id, tenantId) => {
            const asset = assets.get(id);
            return asset && asset.tenantId === tenantId ? { ...asset } : null;
        },
        findAssetByProvider: async (provider, providerAssetId) => {
            for (const asset of assets.values()) {
                if (asset.provider === provider && asset.providerAssetId === providerAssetId) return { ...asset };
            }
            return null;
        },
        updateAsset: async (id, tenantId, update: AssetUpdate) => {
            const asset = assets.get(id);
            if (!asset || asset.tenantId !== tenantId || asset.status !== update.expectedStatus) return 0;
            asset.status = update.status;
            asset.attempts = update.attempts;
            asset.lastError = update.lastError;
            asset.deadLettered = update.deadLettered;
            asset.deadLetterReason = update.deadLetterReason;
            return 1;
        },
        insertCallback: async (row: NewVideoAssetCallback) => {
            const key = `${row.provider}:${row.callbackId}`;
            if (callbacks.has(key)) return false;
            callbacks.add(key);
            return true;
        },
        recordAudit: async (input) => { audits.push(input); },
    };
    return { store, audits };
};

test('lifecycle: a verified ready callback with bytes meters storage once and a replay is absorbed', async () => {
    const lifecycleStore = makeLifecycleStore();
    const meter = build();
    const lifecycle = createVideoAssetLifecycle({
        store: lifecycleStore.store,
        verifyCallbackSignature: () => true,
        idFactory: seqId(),
        meterStorage: meter.service,
    });
    const registered = await lifecycle.registerAsset({ tenantId: TENANT, ownerUserId: 'instr-a', provider: 'vdocipher', providerAssetId: 'pa-1' });
    assert.equal(registered.ok, true);
    if (!registered.ok) return;
    meter.store.seedAsset(registered.id, TENANT);
    await lifecycle.beginProcessing(TENANT, registered.id);

    const applied = await lifecycle.applyProviderCallback({
        provider: 'vdocipher',
        callbackId: 'cb-ready-1',
        signature: 'sig',
        providerAssetId: 'pa-1',
        targetState: 'ready',
        storageBytes: 8_192,
    });
    assert.equal(applied.status, 'applied');
    if (applied.status !== 'applied') return;
    assert.equal(applied.metering, 'recorded');
    assert.equal(await meter.service.storageBytesForAsset(TENANT, registered.id), 8_192);

    const replay = await lifecycle.applyProviderCallback({
        provider: 'vdocipher',
        callbackId: 'cb-ready-1',
        signature: 'sig',
        providerAssetId: 'pa-1',
        targetState: 'ready',
        storageBytes: 8_192,
    });
    assert.equal(replay.status, 'duplicate');
    assert.equal(await meter.service.storageBytesForAsset(TENANT, registered.id), 8_192);
    assert.equal(meter.store.events.length, 1);
});

test('lifecycle: a cross-tenant callback is rejected and meters nothing', async () => {
    const lifecycleStore = makeLifecycleStore();
    const meter = build();
    const lifecycle = createVideoAssetLifecycle({
        store: lifecycleStore.store,
        verifyCallbackSignature: () => true,
        idFactory: seqId(),
        meterStorage: meter.service,
    });
    const registered = await lifecycle.registerAsset({ tenantId: TENANT, ownerUserId: 'instr-a', provider: 'vdocipher', providerAssetId: 'pa-1' });
    assert.equal(registered.ok, true);
    if (!registered.ok) return;
    meter.store.seedAsset(registered.id, TENANT);
    await lifecycle.beginProcessing(TENANT, registered.id);

    const rejected = await lifecycle.applyProviderCallback({
        provider: 'vdocipher',
        callbackId: 'cb-cross',
        signature: 'sig',
        providerAssetId: 'pa-1',
        targetState: 'ready',
        tenantId: 'tenant-b',
        storageBytes: 8_192,
    });
    assert.equal(rejected.status, 'rejected');
    if (rejected.status === 'rejected') assert.equal(rejected.reason, 'cross-tenant');
    assert.equal(meter.store.events.length, 0);
    assert.equal(await meter.service.storageBytesForTenant(TENANT), 0);
});

test('lifecycle: a metering failure after the state commit is explicit, not silent', async () => {
    const lifecycleStore = makeLifecycleStore();
    const lifecycle = createVideoAssetLifecycle({
        store: lifecycleStore.store,
        verifyCallbackSignature: () => true,
        idFactory: seqId(),
        meterStorage: { recordVerifiedBytes: async () => { throw new Error('meter down'); } },
    });
    const registered = await lifecycle.registerAsset({ tenantId: TENANT, ownerUserId: 'instr-a', provider: 'vdocipher', providerAssetId: 'pa-1' });
    assert.equal(registered.ok, true);
    if (!registered.ok) return;
    await lifecycle.beginProcessing(TENANT, registered.id);

    const applied = await lifecycle.applyProviderCallback({
        provider: 'vdocipher',
        callbackId: 'cb-ready-2',
        signature: 'sig',
        providerAssetId: 'pa-1',
        targetState: 'ready',
        storageBytes: 8_192,
    });
    assert.equal(applied.status, 'applied');
    if (applied.status !== 'applied') return;
    assert.equal(applied.state, 'ready');
    assert.equal(applied.metering, 'deferred');
    assert.ok(lifecycleStore.audits.some((audit) => audit.action === 'video.asset.metering_deferred'));
});

/* =========================================================================
 * Production composition: the meter is not wired yet, and that is audited
 * ========================================================================= */

test('lifecycle: verified bytes with no composed meter are audited as unconfigured, not dropped', async () => {
    const lifecycleStore = makeLifecycleStore();
    // Exactly the production composition in routes/video-assets.ts: no
    // `meterStorage`, because the durable transition ledger does not exist yet.
    const lifecycle = createVideoAssetLifecycle({
        store: lifecycleStore.store,
        verifyCallbackSignature: () => true,
        idFactory: seqId(),
    });
    const registered = await lifecycle.registerAsset({ tenantId: TENANT, ownerUserId: 'instr-a', provider: 'vdocipher', providerAssetId: 'pa-1' });
    assert.equal(registered.ok, true);
    if (!registered.ok) return;
    await lifecycle.beginProcessing(TENANT, registered.id);

    const applied = await lifecycle.applyProviderCallback({
        provider: 'vdocipher',
        callbackId: 'cb-ready-unconfigured',
        signature: 'sig',
        providerAssetId: 'pa-1',
        targetState: 'ready',
        storageBytes: 4_096,
    });
    assert.equal(applied.status, 'applied');
    if (applied.status !== 'applied') return;
    // The asset transition still commits; the byte gap is reported, not hidden.
    assert.equal(applied.state, 'ready');
    assert.equal(applied.metering, 'unconfigured');
    const audit = lifecycleStore.audits.find((entry) => entry.action === 'video.asset.metering_unconfigured');
    assert.ok(audit, 'an unconfigured meter must be audited');
    assert.equal(audit?.reason, 'meter_not_configured');
});

test('lifecycle: a byte-less ready callback never raises an unconfigured metering audit', async () => {
    const lifecycleStore = makeLifecycleStore();
    const lifecycle = createVideoAssetLifecycle({
        store: lifecycleStore.store,
        verifyCallbackSignature: () => true,
        idFactory: seqId(),
    });
    const registered = await lifecycle.registerAsset({ tenantId: TENANT, ownerUserId: 'instr-a', provider: 'vdocipher', providerAssetId: 'pa-1' });
    assert.equal(registered.ok, true);
    if (!registered.ok) return;
    await lifecycle.beginProcessing(TENANT, registered.id);

    const applied = await lifecycle.applyProviderCallback({
        provider: 'vdocipher',
        callbackId: 'cb-ready-nobytes',
        signature: 'sig',
        providerAssetId: 'pa-1',
        targetState: 'ready',
    });
    assert.equal(applied.status, 'applied');
    if (applied.status !== 'applied') return;
    assert.equal('metering' in applied, false);
    assert.equal(lifecycleStore.audits.some((entry) => entry.action === 'video.asset.metering_unconfigured'), false);
});

/* =========================================================================
 * Provider proof: the usage-callback signature covers the numbers
 * ========================================================================= */

test('authority: the production usage-callback signature covers the byte and second counts', () => {
    const previousSecret = process.env.VIDEO_CALLBACK_SECRET;
    process.env.VIDEO_CALLBACK_SECRET = 'w6-test-callback-secret';
    const sign = (parts: string[]): string =>
        createHmac('sha256', 'w6-test-callback-secret').update(parts.join('\n')).digest('hex');
    const honest: UsageCallbackInput = {
        provider: 'vdocipher',
        eventId: 'ev-1',
        tenantId: TENANT,
        kind: 'storage',
        storageBytes: 2_048,
        signature: sign(['vdocipher', 'ev-1', TENANT, 'storage', 'bytes=2048']),
    };
    try {
        assert.equal(verifyUsageCallbackFromEnv(honest), true);
        // The same captured signature cannot carry a different byte count...
        assert.equal(verifyUsageCallbackFromEnv({ ...honest, storageBytes: 9_999_999 }), false);
        // ...nor a second count, nor a different asset binding.
        assert.equal(verifyUsageCallbackFromEnv({ ...honest, watchSeconds: 3_600 }), false);
        assert.equal(verifyUsageCallbackFromEnv({ ...honest, assetId: 'asset-2' }), false);
        // A callback carrying neither number keeps the original payload shape.
        assert.equal(
            verifyUsageCallbackFromEnv({
                provider: 'vdocipher', eventId: 'ev-1', tenantId: TENANT, kind: 'storage',
                signature: sign(['vdocipher', 'ev-1', TENANT, 'storage']),
            }),
            true,
        );
        // No secret configured: fail closed.
        delete process.env.VIDEO_CALLBACK_SECRET;
        assert.equal(verifyUsageCallbackFromEnv(honest), false);
    } finally {
        if (previousSecret === undefined) delete process.env.VIDEO_CALLBACK_SECRET;
        else process.env.VIDEO_CALLBACK_SECRET = previousSecret;
    }
});
