/**
 * B2-W6 — storage reconciliation suite.
 *
 * Reconciliation is read-only by contract: it compares the materialized
 * per-tenant / per-asset counter with a rebuild from the recorded events and
 * reports a scoped discrepancy. It must never insert an event or overwrite a
 * counter, even when the counter is wrong. That property is enforced by the
 * type it accepts (`MediaMeteringReadStore` has no write handle at all) and
 * re-asserted at runtime by tracing the calls it makes.
 *
 * The atomicity cases drive the REAL append path over the REAL in-memory
 * adapter, whose `withTransaction` really executes the callback and discards
 * its staged writes on a throw.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
    STORAGE_METER_ERRORS,
    createInMemoryMediaMeteringStore,
    createMediaMeteringService,
    reconcileStorageUsage,
    type InMemoryMediaMeteringStore,
    type MediaMeteringReadStore,
    type MediaMeteringService,
    type MediaMeteringStore,
    type MediaMeteringTransaction,
    type StorageMeterEventRow,
} from '../src/services/media-usage-reconciliation';

const TENANT = 'tenant-a';

const seqId = (): (() => string) => {
    let n = 0;
    return () => `rec-${++n}`;
};

interface Harness {
    store: InMemoryMediaMeteringStore;
    service: MediaMeteringService;
}

const build = (): Harness => {
    const store = createInMemoryMediaMeteringStore([
        { id: 'asset-1', tenantId: TENANT },
        { id: 'asset-2', tenantId: TENANT },
    ]);
    const service = createMediaMeteringService({ store, idFactory: seqId(), now: () => 5_000 });
    return { store, service };
};

/**
 * Simulate a counter written OUTSIDE the append path (the drift reconciliation
 * exists to detect). The append path itself has no loose counter write.
 */
const driftCounter = (store: InMemoryMediaMeteringStore, assetId: string | null, total: number): void => {
    store.counters.set(`${TENANT}\u0000${assetId ?? '*'}`, total);
};

interface RecordingStore {
    store: MediaMeteringReadStore;
    calls: string[];
}

const recording = (inner: MediaMeteringReadStore): RecordingStore => {
    const calls: string[] = [];
    const store: MediaMeteringReadStore = {
        listEvents: async (tenantId, assetId) => {
            calls.push('listEvents');
            return inner.listEvents(tenantId, assetId);
        },
        readStorageCounter: async (tenantId, assetId) => {
            calls.push('readStorageCounter');
            return inner.readStorageCounter(tenantId, assetId);
        },
    };
    return { store, calls };
};

type FaultPoint = 'event' | 'tenant-counter' | 'asset-counter' | 'audit';

interface FaultHarness {
    store: MediaMeteringStore;
    /** Statements the unit actually reached, in order — proof the callback ran. */
    attempts: string[];
}

/**
 * Wrap the real adapter's transaction and abort at one chosen statement. The
 * callback still executes up to that point, so a rollback assertion is not
 * satisfied by a callback that never ran.
 */
const faulting = (inner: InMemoryMediaMeteringStore, fault: FaultPoint): FaultHarness => {
    const attempts: string[] = [];
    const store: MediaMeteringStore = {
        listEvents: (tenantId, assetId) => inner.listEvents(tenantId, assetId),
        readStorageCounter: (tenantId, assetId) => inner.readStorageCounter(tenantId, assetId),
        withTransaction: (unit, work) => inner.withTransaction(unit, async (tx) => {
            const guarded: MediaMeteringTransaction = {
                findAssetTenant: (assetId) => tx.findAssetTenant(assetId),
                listEvents: (tenantId, assetId) => tx.listEvents(tenantId, assetId),
                readStorageCounter: (tenantId, assetId) => tx.readStorageCounter(tenantId, assetId),
                insertEvent: async (row) => {
                    attempts.push('event');
                    if (fault === 'event') throw new Error('injected: event write failed');
                    return tx.insertEvent(row);
                },
                writeStorageCounter: async (tenantId, assetId, total) => {
                    const point = assetId === null ? 'tenant-counter' : 'asset-counter';
                    attempts.push(point);
                    if (fault === point) throw new Error(`injected: ${point} failed`);
                    return tx.writeStorageCounter(tenantId, assetId, total);
                },
                recordAudit: async (input) => {
                    attempts.push('audit');
                    if (fault === 'audit') throw new Error('injected: audit failed');
                    return tx.recordAudit(input);
                },
            };
            return work(guarded);
        }),
    };
    return { store, attempts };
};

/* =========================================================================
 * Match
 * ========================================================================= */

test('reconciliation: a consistent counter reports match and mutates nothing', async () => {
    const { store, service } = build();
    await service.recordVerifiedBytes({ tenantId: TENANT, assetId: 'asset-1', resultingBytes: 1_200, operationId: 'u', source: 'provider-callback', occurredAtMs: 100 });

    const report = await reconcileStorageUsage({ store, tenantId: TENANT, assetId: 'asset-1', nowMs: 9_000 });
    assert.equal(report.status, 'match');
    assert.equal(report.unit, 'storage_bytes');
    assert.equal(report.tenantId, TENANT);
    assert.equal(report.assetId, 'asset-1');
    assert.equal(report.checkedAtMs, 9_000);
    assert.equal(report.eventCount, 1);
    assert.equal(report.mutated, false);
    assert.deepEqual(report.discrepancies, []);
});

/* =========================================================================
 * Drift
 * ========================================================================= */

test('reconciliation: a tampered asset counter is reported, not repaired', async () => {
    const { store, service } = build();
    await service.recordVerifiedBytes({ tenantId: TENANT, assetId: 'asset-1', resultingBytes: 1_000, operationId: 'u', source: 'provider-callback', occurredAtMs: 100 });
    // Simulate drift introduced outside the append path.
    driftCounter(store, 'asset-1', 4_000);

    const report = await reconcileStorageUsage({ store, tenantId: TENANT, assetId: 'asset-1', nowMs: 9_000 });
    assert.equal(report.status, 'mismatch');
    assert.equal(report.mutated, false);
    assert.deepEqual(report.discrepancies, [{
        unit: 'storage_bytes',
        scope: 'asset',
        tenantId: TENANT,
        assetId: 'asset-1',
        recordedTotal: 4_000,
        rebuiltTotal: 1_000,
        delta: 3_000,
        eventCount: 1,
        reason: 'counter-drift',
    }]);
    // The wrong counter is still wrong after reconciliation.
    assert.equal(await store.readStorageCounter(TENANT, 'asset-1'), 4_000);
});

test('reconciliation: a missing counter is reported as counter-missing', async () => {
    const { store } = build();
    // An event exists but the materialized counter was never written (for
    // example a crash between the append and the counter update).
    store.events.push({
        id: 'orphan-1',
        tenantId: TENANT,
        assetId: 'asset-1',
        transition: 'upload',
        resultingBytes: 700,
        idempotencyKey: 'orphan-op',
        source: 'provider-callback',
        occurredAtMs: 100,
    });

    const report = await reconcileStorageUsage({ store, tenantId: TENANT, assetId: 'asset-1', nowMs: 9_000 });
    assert.equal(report.status, 'mismatch');
    assert.equal(report.discrepancies[0]?.reason, 'counter-missing');
    assert.equal(report.discrepancies[0]?.recordedTotal, null);
    assert.equal(report.discrepancies[0]?.rebuiltTotal, 700);
    assert.equal(report.discrepancies[0]?.delta, null);
});

test('reconciliation: a tenant-scoped check detects per-asset drift even when the tenant total matches', async () => {
    const { store, service } = build();
    await service.recordVerifiedBytes({ tenantId: TENANT, assetId: 'asset-1', resultingBytes: 100, operationId: 'u1', source: 'provider-callback', occurredAtMs: 100 });
    await service.recordVerifiedBytes({ tenantId: TENANT, assetId: 'asset-2', resultingBytes: 100, operationId: 'u2', source: 'provider-callback', occurredAtMs: 110 });
    // Assets drift in opposite directions, so the tenant total stays 200.
    driftCounter(store, 'asset-1', 200);
    driftCounter(store, 'asset-2', 0);

    const report = await reconcileStorageUsage({ store, tenantId: TENANT, nowMs: 9_000 });
    assert.equal(report.status, 'mismatch');
    assert.equal(report.assetId, null);
    const assetScopes = report.discrepancies.map((entry) => entry.assetId).sort();
    assert.deepEqual(assetScopes, ['asset-1', 'asset-2']);
    for (const entry of report.discrepancies) {
        assert.equal(entry.scope, 'asset');
        assert.equal(entry.unit, 'storage_bytes');
        assert.equal(entry.tenantId, TENANT);
    }
});

test('reconciliation: a scoped check never reports another asset', async () => {
    const { store, service } = build();
    await service.recordVerifiedBytes({ tenantId: TENANT, assetId: 'asset-1', resultingBytes: 100, operationId: 'u1', source: 'provider-callback', occurredAtMs: 100 });
    await service.recordVerifiedBytes({ tenantId: TENANT, assetId: 'asset-2', resultingBytes: 200, operationId: 'u2', source: 'provider-callback', occurredAtMs: 110 });
    driftCounter(store, 'asset-2', 999);

    const report = await reconcileStorageUsage({ store, tenantId: TENANT, assetId: 'asset-1', nowMs: 9_000 });
    assert.equal(report.status, 'match');
    assert.equal(report.eventCount, 1);
    assert.deepEqual(report.discrepancies, []);
});

/* =========================================================================
 * Read-only contract
 * ========================================================================= */

test('reconciliation: the store is only read, never written', async () => {
    const { store, service } = build();
    await service.recordVerifiedBytes({ tenantId: TENANT, assetId: 'asset-1', resultingBytes: 500, operationId: 'u', source: 'provider-callback', occurredAtMs: 100 });
    const recorder = recording(store);
    const eventsBefore = store.events.length;
    const countersBefore = new Map(store.counters);
    const auditsBefore = store.audits.length;

    await reconcileStorageUsage({ store: recorder.store, tenantId: TENANT, assetId: 'asset-1', nowMs: 9_000 });
    await reconcileStorageUsage({ store: recorder.store, tenantId: TENANT, nowMs: 9_000 });

    // The only surface reconciliation is given is the read pair — it cannot
    // open a transaction, insert an event, move a counter or write an audit.
    assert.deepEqual([...new Set(recorder.calls)].sort(), ['listEvents', 'readStorageCounter']);
    assert.ok(recorder.calls.includes('readStorageCounter'));
    assert.ok(recorder.calls.includes('listEvents'));
    assert.equal(store.events.length, eventsBefore);
    assert.deepEqual(store.counters, countersBefore);
    assert.equal(store.audits.length, auditsBefore);
});

test('reconciliation: a tenant with no metered events reports match instead of a missing counter', async () => {
    const { store } = build();
    // Nothing was ever appended and no counter was ever written: there is no
    // gap to report, and flagging every idle tenant would bury the real ones.
    const tenantReport = await reconcileStorageUsage({ store, tenantId: TENANT, nowMs: 9_000 });
    assert.equal(tenantReport.status, 'match');
    assert.equal(tenantReport.eventCount, 0);
    assert.deepEqual(tenantReport.discrepancies, []);

    const assetReport = await reconcileStorageUsage({ store, tenantId: TENANT, assetId: 'asset-1', nowMs: 9_000 });
    assert.equal(assetReport.status, 'match');
    assert.deepEqual(assetReport.discrepancies, []);
});

/* =========================================================================
 * Failure atomicity and recovery
 * ========================================================================= */

test('reconciliation: a failure between the event write and the first counter rolls the whole unit back', async () => {
    const { store, service } = build();
    // Committed baseline, so "no movement" is observable.
    await service.recordVerifiedBytes({
        tenantId: TENANT, assetId: 'asset-1', resultingBytes: 500, operationId: 'op-base', source: 'provider-callback', occurredAtMs: 100,
    });
    const eventsBefore = store.events.length;
    const countersBefore = new Map(store.counters);
    const auditsBefore = store.audits.length;

    const { store: failing, attempts } = faulting(store, 'tenant-counter');
    const failingService = createMediaMeteringService({ store: failing, idFactory: seqId(), now: () => 5_000 });

    await assert.rejects(
        () => failingService.recordVerifiedBytes({
            tenantId: TENANT, assetId: 'asset-1', resultingBytes: 900, operationId: 'op-fail', source: 'provider-callback', occurredAtMs: 200,
        }),
        /injected: tenant-counter failed/,
    );

    // The unit really reached the event insert before aborting — so the
    // rollback below is a rollback, not a callback that never ran.
    assert.deepEqual(attempts, ['event', 'tenant-counter']);
    assert.equal(store.events.length, eventsBefore, 'no event may survive');
    assert.deepEqual(store.counters, countersBefore, 'no counter may move');
    assert.equal(store.audits.length, auditsBefore, 'no audit may survive');

    // Nothing was recorded, so reconciliation has nothing to report as a gap.
    const report = await reconcileStorageUsage({ store, tenantId: TENANT, assetId: 'asset-1', nowMs: 9_000 });
    assert.equal(report.status, 'match');
    assert.equal(report.eventCount, 1);
    assert.equal(report.discrepancies.length, 0);
});

test('reconciliation: a failure after the first counter but before the second rolls back both', async () => {
    const { store, service } = build();
    await service.recordVerifiedBytes({
        tenantId: TENANT, assetId: 'asset-1', resultingBytes: 500, operationId: 'op-base', source: 'provider-callback', occurredAtMs: 100,
    });
    const eventsBefore = store.events.length;
    const countersBefore = new Map(store.counters);
    const auditsBefore = store.audits.length;

    const { store: failing, attempts } = faulting(store, 'asset-counter');
    const failingService = createMediaMeteringService({ store: failing, idFactory: seqId(), now: () => 5_000 });

    await assert.rejects(
        () => failingService.recordVerifiedBytes({
            tenantId: TENANT, assetId: 'asset-1', resultingBytes: 900, operationId: 'op-fail', source: 'provider-callback', occurredAtMs: 200,
        }),
        /injected: asset-counter failed/,
    );

    // The tenant counter was written first (deterministic order) and must be
    // rolled back together with the event and the asset counter.
    assert.deepEqual(attempts, ['event', 'tenant-counter', 'asset-counter']);
    assert.equal(store.events.length, eventsBefore);
    assert.deepEqual(store.counters, countersBefore);
    assert.equal(store.audits.length, auditsBefore);
    assert.equal(await store.readStorageCounter(TENANT, null), 500);
    assert.equal(await store.readStorageCounter(TENANT, 'asset-1'), 500);
});

test('reconciliation: an audit failure rolls back the event and both counters', async () => {
    const { store, service } = build();
    await service.recordVerifiedBytes({
        tenantId: TENANT, assetId: 'asset-1', resultingBytes: 500, operationId: 'op-base', source: 'provider-callback', occurredAtMs: 100,
    });
    const eventsBefore = store.events.length;
    const countersBefore = new Map(store.counters);
    const auditsBefore = store.audits.length;

    const { store: failing, attempts } = faulting(store, 'audit');
    const failingService = createMediaMeteringService({ store: failing, idFactory: seqId(), now: () => 5_000 });

    await assert.rejects(
        () => failingService.recordVerifiedBytes({
            tenantId: TENANT, assetId: 'asset-1', resultingBytes: 900, operationId: 'op-fail', source: 'provider-callback', occurredAtMs: 200,
        }),
        /injected: audit failed/,
    );

    // The audit is part of the unit: if it cannot be written, neither the
    // event nor either counter may be committed.
    assert.deepEqual(attempts, ['event', 'tenant-counter', 'asset-counter', 'audit']);
    assert.equal(store.events.length, eventsBefore);
    assert.deepEqual(store.counters, countersBefore);
    assert.equal(store.audits.length, auditsBefore);
});

test('reconciliation: a failed unit leaves no trace, so the legitimate retry records once', async () => {
    const { store, service } = build();
    const { store: failing } = faulting(store, 'tenant-counter');
    const failingService = createMediaMeteringService({ store: failing, idFactory: seqId(), now: () => 5_000 });

    await assert.rejects(
        () => failingService.recordVerifiedBytes({
            tenantId: TENANT, assetId: 'asset-1', resultingBytes: 900, operationId: 'op-1', source: 'provider-callback', occurredAtMs: 100,
        }),
        /injected: tenant-counter failed/,
    );
    // A rolled-back unit must not consume the idempotency key: the provider's
    // retry of the same operation has to record, exactly once.
    const retry = await service.recordVerifiedBytes({
        tenantId: TENANT, assetId: 'asset-1', resultingBytes: 900, operationId: 'op-1', source: 'provider-callback', occurredAtMs: 100,
    });
    assert.ok(!('error' in retry));
    assert.ok(retry.recorded);
    assert.equal(retry.bytesDelta, 900);
    assert.equal(store.events.length, 1);
    assert.equal(await store.readStorageCounter(TENANT, 'asset-1'), 900);
    assert.equal(await store.readStorageCounter(TENANT, null), 900);

    const report = await reconcileStorageUsage({ store, tenantId: TENANT, assetId: 'asset-1', nowMs: 9_000 });
    assert.equal(report.status, 'match');
});

test('reconciliation: an unsafe byte total is refused instead of persisted', async () => {
    const { store, service } = build();
    await service.recordVerifiedBytes({
        tenantId: TENANT, assetId: 'asset-1', resultingBytes: 500, operationId: 'op-base', source: 'provider-callback', occurredAtMs: 100,
    });
    // Corrupt stored state: a counter outside the safe-integer range.
    driftCounter(store, 'asset-1', Number.MAX_SAFE_INTEGER + 2);
    const countersBefore = new Map(store.counters);
    const eventsBefore = store.events.length;

    await assert.rejects(
        () => service.recordVerifiedBytes({
            tenantId: TENANT, assetId: 'asset-1', resultingBytes: 900, operationId: 'op-2', source: 'provider-callback', occurredAtMs: 200,
        }),
        new RegExp(STORAGE_METER_ERRORS.unsafeByteTotal),
    );
    assert.deepEqual(store.counters, countersBefore);
    assert.equal(store.events.length, eventsBefore);
});

test('reconciliation: rows from another tenant are never attributed, even if a store returns them', async () => {
    const { store, service } = build();
    await service.recordVerifiedBytes({
        tenantId: TENANT, assetId: 'asset-1', resultingBytes: 1_000, operationId: 'u', source: 'provider-callback', occurredAtMs: 100,
    });
    const foreignRow: StorageMeterEventRow = {
        id: 'foreign-1',
        tenantId: 'tenant-b',
        assetId: 'asset-1',
        transition: 'upload',
        resultingBytes: 5_000,
        idempotencyKey: 'st:asset-1:foreign',
        source: 'provider-callback',
        occurredAtMs: 50,
    };
    // A defective adapter that forgets its tenant predicate must not be able to
    // move this tenant's number.
    const leaky: MediaMeteringReadStore = {
        listEvents: async (tenantId, assetId) => [...await store.listEvents(tenantId, assetId), { ...foreignRow }],
        readStorageCounter: (tenantId, assetId) => store.readStorageCounter(tenantId, assetId),
    };
    // As if the foreign row had been counted: the rebuild must still say 1_000.
    driftCounter(store, 'asset-1', 6_000);

    const report = await reconcileStorageUsage({ store: leaky, tenantId: TENANT, assetId: 'asset-1', nowMs: 9_000 });
    assert.equal(report.status, 'mismatch');
    assert.equal(report.discrepancies[0]?.recordedTotal, 6_000);
    assert.equal(report.discrepancies[0]?.rebuiltTotal, 1_000);
    assert.equal(report.discrepancies[0]?.delta, 5_000);
});

/* =========================================================================
 * Shape
 * ========================================================================= */

test('reconciliation: the report carries only byte-unit fields and no per-student number', async () => {
    const { store, service } = build();
    await service.recordVerifiedBytes({ tenantId: TENANT, assetId: 'asset-1', resultingBytes: 256, operationId: 'u', source: 'provider-callback', occurredAtMs: 100 });
    const report = await reconcileStorageUsage({ store, tenantId: TENANT, assetId: 'asset-1', nowMs: 1 });

    assert.deepEqual(Object.keys(report).sort(), [
        'assetId', 'checkedAtMs', 'discrepancies', 'eventCount', 'mutated', 'status', 'tenantId', 'unit',
    ]);
    assert.equal(report.unit, 'storage_bytes');
    assert.equal(report.mutated, false);
    assert.ok(!('studentEnrollmentId' in report));
    assert.ok(!('watchSeconds' in report));
});
