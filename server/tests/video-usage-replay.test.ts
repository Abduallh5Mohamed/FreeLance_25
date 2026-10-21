/**
 * B2-W6 — replay / rebuild suite for the watch and storage ledgers.
 *
 * The two event families are exercised through their REAL services over
 * recording in-memory adapters. Replay assertions compare the materialized
 * counter with a rebuild computed purely from the recorded event rows, which is
 * the property reconciliation relies on.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
    createInMemoryMediaMeteringStore,
    createMediaMeteringService,
    rebuildStorageTotals,
    type MediaMeteringService,
    type StorageMeterEventRow,
} from '../src/services/media-usage-reconciliation';
import {
    createVideoUsageEventService,
    unitForUsageKind,
    type NewUsageEventRow,
    type VideoUsageStore,
} from '../src/services/video-usage-events';

const TENANT = 'tenant-a';
const ASSET = 'asset-1';

const seqId = (): (() => string) => {
    let n = 0;
    return () => `replay-${++n}`;
};

const meter = (): MediaMeteringService => {
    const store = createInMemoryMediaMeteringStore([{ id: ASSET, tenantId: TENANT }]);
    return createMediaMeteringService({ store, idFactory: seqId(), now: () => 1_000 });
};

interface WatchHarness {
    store: VideoUsageStore;
    events: NewUsageEventRow[];
}

const watchHarness = (): WatchHarness => {
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
    return { store, events };
};

/* =========================================================================
 * Idempotency
 * ========================================================================= */

test('replay: the same provider callback delivered twice is counted once', async () => {
    const service = meter();
    const input = {
        tenantId: TENANT,
        assetId: ASSET,
        resultingBytes: 2_048,
        operationId: 'provider:evt-9',
        source: 'provider-callback' as const,
        occurredAtMs: 500,
    };
    const first = await service.recordVerifiedBytes(input);
    const second = await service.recordVerifiedBytes({ ...input });
    assert.equal('error' in first ? false : first.recorded, true);
    assert.equal('error' in second ? false : second.deduplicated, true);
    assert.equal(await service.storageBytesForAsset(TENANT, ASSET), 2_048);
});

test('replay: the idempotency key is tenant-scoped so the same operation id is legal in another tenant', async () => {
    const store = createInMemoryMediaMeteringStore([
        { id: ASSET, tenantId: TENANT },
        { id: 'asset-b', tenantId: 'tenant-b' },
    ]);
    const service = createMediaMeteringService({ store, idFactory: seqId(), now: () => 1_000 });
    const a = await service.recordVerifiedBytes({
        tenantId: TENANT, assetId: ASSET, resultingBytes: 10, operationId: 'shared-op', source: 'provider-callback', occurredAtMs: 1,
    });
    const b = await service.recordVerifiedBytes({
        tenantId: 'tenant-b', assetId: 'asset-b', resultingBytes: 20, operationId: 'shared-op', source: 'provider-callback', occurredAtMs: 1,
    });
    assert.equal('error' in a ? false : a.recorded, true);
    assert.equal('error' in b ? false : b.recorded, true);
    assert.equal(await service.storageBytesForTenant(TENANT), 10);
    assert.equal(await service.storageBytesForTenant('tenant-b'), 20);
});

/* =========================================================================
 * Ordering
 * ========================================================================= */

test('replay: out-of-order callbacks settle on the correct final size', async () => {
    const service = meter();
    await service.recordVerifiedBytes({ tenantId: TENANT, assetId: ASSET, resultingBytes: 300, operationId: 'op-new', source: 'provider-callback', occurredAtMs: 300 });
    await service.recordVerifiedBytes({ tenantId: TENANT, assetId: ASSET, resultingBytes: 900, operationId: 'op-old', source: 'provider-callback', occurredAtMs: 100 });
    await service.recordVerifiedBytes({ tenantId: TENANT, assetId: ASSET, resultingBytes: 450, operationId: 'op-mid', source: 'provider-callback', occurredAtMs: 200 });

    assert.equal(await service.storageBytesForAsset(TENANT, ASSET), 300);
    const rebuilt = await service.rebuild(TENANT);
    assert.equal(rebuilt.tenantTotal, 300);
    assert.equal(rebuilt.eventCount, 3);
});

/* =========================================================================
 * Rebuild
 * ========================================================================= */

test('replay: rebuild matches the recorded event set and the materialized counter', async () => {
    const store = createInMemoryMediaMeteringStore([{ id: ASSET, tenantId: TENANT }]);
    const service = createMediaMeteringService({ store, idFactory: seqId(), now: () => 1_000 });
    await service.recordVerifiedBytes({ tenantId: TENANT, assetId: ASSET, resultingBytes: 1_000, operationId: 'u', source: 'provider-callback', occurredAtMs: 10 });
    await service.recordVerifiedBytes({ tenantId: TENANT, assetId: ASSET, resultingBytes: 1_400, operationId: 'r', source: 'provider-callback', occurredAtMs: 20 });
    await service.recordDelete({ tenantId: TENANT, assetId: ASSET, operationId: 'd', source: 'provider-callback', occurredAtMs: 30 });

    const recorded = await service.storageBytesForAsset(TENANT, ASSET);
    const rebuilt = rebuildStorageTotals(TENANT, store.events);
    assert.equal(rebuilt.perAsset[0]?.total, recorded);
    assert.equal(rebuilt.tenantTotal, recorded);
    assert.equal(rebuilt.eventCount, store.events.length);
});

test('replay: rebuild ignores rows belonging to another tenant', async () => {
    const rows: StorageMeterEventRow[] = [
        { id: '1', tenantId: TENANT, assetId: ASSET, transition: 'upload', resultingBytes: 100, idempotencyKey: 'a', source: 'provider-callback', occurredAtMs: 1 },
        { id: '2', tenantId: 'tenant-b', assetId: 'asset-b', transition: 'upload', resultingBytes: 999, idempotencyKey: 'b', source: 'provider-callback', occurredAtMs: 2 },
    ];
    const rebuilt = rebuildStorageTotals(TENANT, rows);
    assert.equal(rebuilt.tenantTotal, 100);
    assert.equal(rebuilt.eventCount, 1);
    assert.deepEqual(rebuilt.perAsset.map((asset) => asset.assetId), [ASSET]);
});

test('replay: watch totals rebuild from the recorded watch events', async () => {
    const harness = watchHarness();
    const service = createVideoUsageEventService({ store: harness.store, idFactory: seqId() });
    await service.record({ tenantId: TENANT, kind: 'watch', dedupeKey: 'hb:s1:1', watchSeconds: 30, sessionId: 's1' });
    await service.record({ tenantId: TENANT, kind: 'watch', dedupeKey: 'hb:s1:2', watchSeconds: 25, sessionId: 's1' });
    // A replayed bucket is absorbed, so the rebuild cannot exceed the ledger.
    await service.record({ tenantId: TENANT, kind: 'watch', dedupeKey: 'hb:s1:2', watchSeconds: 25, sessionId: 's1' });

    assert.equal(await service.watchSeconds(TENANT), 55);
    assert.equal(await service.rebuildWatchSeconds(TENANT), 55);
    assert.equal(harness.events.length, 2);
});

/* =========================================================================
 * Unit separation
 * ========================================================================= */

test('replay: storage bytes and watch seconds are distinct units and never combined', async () => {
    const storage = meter();
    const watch = watchHarness();
    const watchService = createVideoUsageEventService({ store: watch.store, idFactory: seqId() });

    await storage.recordVerifiedBytes({ tenantId: TENANT, assetId: ASSET, resultingBytes: 7_000, operationId: 'u', source: 'provider-callback', occurredAtMs: 1 });
    await watchService.record({ tenantId: TENANT, kind: 'watch', dedupeKey: 'hb:s1:1', watchSeconds: 40, sessionId: 's1' });

    assert.equal(unitForUsageKind('watch'), 'seconds');
    assert.equal(unitForUsageKind('storage'), 'bytes');
    assert.equal(await storage.storageBytesForTenant(TENANT), 7_000);
    assert.equal(await watchService.rebuildWatchSeconds(TENANT), 40);
    // Neither total is a student count: each is the raw unit total for the tenant.
    assert.notEqual(await storage.storageBytesForTenant(TENANT), await watchService.rebuildWatchSeconds(TENANT));
});
