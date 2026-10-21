import assert from 'node:assert/strict';
import test from 'node:test';
import {
    DEFAULT_SCAN_BATCH_SIZE,
    DEFAULT_SCAN_CONCURRENCY,
    MAX_SCAN_BATCH_SIZE,
    MAX_SCAN_CONCURRENCY,
    createAssignmentScanWorker,
    createSqlAssignmentScanStore,
    type AssignmentScanStore,
    type PendingScanCandidate,
    type ScanVerdictWrite,
} from '../src/services/assignment-scan-worker';
import { objectVersion } from '../src/services/assignment-storage';
import type {
    AssignmentObjectMetadata,
    AssignmentObjectStore,
    MalwareScanInput,
    MalwareScanVerdict,
    MalwareScanner,
} from '../src/services/assignment-storage';

const STORAGE_KEY = 'tenants/tenant-a/assignments/a-1/enr-a/sub-1.pdf';

const candidate = (overrides: Partial<PendingScanCandidate> = {}): PendingScanCandidate => ({
    submissionId: 'sub-1',
    tenantId: 'tenant-a',
    assignmentId: 'a-1',
    enrollmentId: 'enr-a',
    storageKey: STORAGE_KEY,
    fileSizeBytes: 2048,
    ...overrides,
});

const metadata = (overrides: Partial<AssignmentObjectMetadata> = {}): AssignmentObjectMetadata => ({
    sizeBytes: 2048,
    contentType: 'application/pdf',
    etag: 'etag-1',
    lastModified: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
});

interface StoreOptions {
    record?: boolean | (() => boolean);
    listFailures?: number;
    listError?: Error;
}

const makeStore = (candidates: PendingScanCandidate[], options: StoreOptions = {}) => {
    const writes: ScanVerdictWrite[] = [];
    const limits: number[] = [];
    let listCalls = 0;
    let remainingFailures = options.listFailures ?? 0;
    const store: AssignmentScanStore = {
        listPendingScanBatch: async ({ limit }) => {
            listCalls += 1;
            limits.push(limit);
            if (remainingFailures > 0) {
                remainingFailures -= 1;
                throw options.listError ?? new Error('claim store unavailable');
            }
            return candidates.slice(0, limit);
        },
        recordScanVerdict: async (write) => {
            writes.push(write);
            if (typeof options.record === 'function') return options.record();
            return options.record ?? true;
        },
    };
    return { store, writes, limits, listCalls: () => listCalls };
};

const makeObjectStore = (
    versions: Array<AssignmentObjectMetadata | null>,
    options: { removeFails?: boolean } = {},
) => {
    let stats = 0;
    const removed: string[] = [];
    const store: AssignmentObjectStore = {
        statObject: async () => {
            const version = versions[Math.min(stats, versions.length - 1)];
            stats += 1;
            return version;
        },
        readPrefix: async () => {
            throw new Error('the scan worker must never read object bytes');
        },
        createUploadUrl: async () => {
            throw new Error('the scan worker never signs uploads');
        },
        removeObject: async (key) => {
            if (options.removeFails) throw new Error('remove failed');
            removed.push(key);
        },
    };
    return { store, removed, stats: () => stats };
};

interface VersionedStoreOptions {
    /** Version the key holds when the worker first stats it. */
    initial: AssignmentObjectMetadata;
    /** Version a concurrent uploader installs at the key, if any. */
    replacement?: AssignmentObjectMetadata;
    /** The replacement lands immediately after this many `statObject` calls. */
    replaceAfterStats?: number;
    /** Declare the exact-version delete capability (default: absent, like MinIO). */
    conditionalDelete?: boolean;
    /** The exact-version delete itself fails at the store. */
    conditionalDeleteFails?: boolean;
}

/**
 * An object store that models the *current* version at the key, so a test can
 * land a concurrent replacement at a chosen point in the worker's sequence and
 * observe which bytes a delete actually destroyed.
 *
 * `removeObject` deletes whatever version is at the key right now (that is what
 * a mutable-key delete means). `removeObjectVersion` only destroys the version
 * it was asked for, and answers `version_replaced` otherwise.
 */
const makeVersionedObjectStore = (options: VersionedStoreOptions) => {
    let current: AssignmentObjectMetadata | null = options.initial;
    let stats = 0;
    const destroyed: string[] = [];
    const mutableRemovals: string[] = [];
    const conditionalCalls: Array<{ etag: string; sizeBytes: number }> = [];
    const store: AssignmentObjectStore = {
        statObject: async () => {
            const snapshot = current;
            stats += 1;
            if (options.replacement && options.replaceAfterStats === stats) {
                current = options.replacement;
            }
            return snapshot;
        },
        readPrefix: async () => {
            throw new Error('the scan worker must never read object bytes');
        },
        createUploadUrl: async () => {
            throw new Error('the scan worker never signs uploads');
        },
        removeObject: async (key) => {
            mutableRemovals.push(key);
            const version = objectVersion(current);
            destroyed.push(version ?? 'unversioned');
            current = null;
        },
        ...(options.conditionalDelete === true
            ? {
                capabilities: { conditionalDelete: true },
                removeObjectVersion: async ({ etag, sizeBytes }: { etag: string; sizeBytes: number }) => {
                    conditionalCalls.push({ etag, sizeBytes });
                    if (options.conditionalDeleteFails) throw new Error('exact-version delete failed');
                    const version = objectVersion(current);
                    if (version === null) return 'already_absent' as const;
                    if (version !== `${etag}:${sizeBytes}`) return 'version_replaced' as const;
                    destroyed.push(version);
                    current = null;
                    return 'removed' as const;
                },
            }
            : {}),
    };
    return { store, destroyed, mutableRemovals, conditionalCalls, stats: () => stats };
};

const scannerReturning = (verdict: MalwareScanVerdict | Error, inputs: MalwareScanInput[] = []): MalwareScanner => ({
    scan: async (input) => {
        inputs.push(input);
        if (verdict instanceof Error) throw verdict;
        return verdict;
    },
});

const buildWorker = (
    store: AssignmentScanStore,
    objectStore: AssignmentObjectStore,
    extra: {
        scanner?: MalwareScanner;
        scanTimeoutMs?: number;
        batchSize?: number;
        concurrency?: number;
        maxAttemptsPerRow?: number;
        claimAttempts?: number;
        retryDelayMs?: number;
        sleep?: (ms: number) => Promise<void>;
    } = {},
) => createAssignmentScanWorker({
    store,
    objectStore,
    scanner: extra.scanner,
    scanTimeoutMs: extra.scanTimeoutMs,
    batchSize: extra.batchSize,
    concurrency: extra.concurrency,
    maxAttemptsPerRow: extra.maxAttemptsPerRow,
    claimAttempts: extra.claimAttempts,
    retryDelayMs: extra.retryDelayMs,
    sleep: extra.sleep,
    onError: () => undefined,
});

/* ------------------------------------------------------------------------- */
/* Fail closed without a scanner                                              */
/* ------------------------------------------------------------------------- */

test('scan worker: without a scanner nothing is claimed and nothing becomes clean', async () => {
    const { store, listCalls, writes } = makeStore([candidate()]);
    const worker = buildWorker(store, makeObjectStore([metadata()]).store);
    const result = await worker.runOnce();
    assert.equal(result.aborted, 'scanner_absent');
    assert.equal(listCalls(), 0);
    assert.equal(result.claimed, 0);
    assert.equal(result.clean, 0);
    assert.equal(writes.length, 0);
});

test('scan worker: runOnce never starts itself and never schedules a timer', async () => {
    const { store, listCalls } = makeStore([candidate()]);
    buildWorker(store, makeObjectStore([metadata()]).store, {
        scanner: scannerReturning({ verdict: 'clean' }),
    });
    // Constructing the worker must not touch the store; the scheduler calls runOnce.
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(listCalls(), 0);
});

/* ------------------------------------------------------------------------- */
/* Verdicts                                                                   */
/* ------------------------------------------------------------------------- */

test('scan worker: a clean verdict is recorded with a CAS bound to the verified object size', async () => {
    const inputs: MalwareScanInput[] = [];
    const { store, writes, limits } = makeStore([candidate()]);
    const objectStore = makeObjectStore([metadata(), metadata()]);
    const worker = buildWorker(store, objectStore.store, {
        scanner: scannerReturning({ verdict: 'clean' }, inputs),
        batchSize: 7,
    });
    const result = await worker.runOnce();

    assert.deepEqual(result.outcomes, [{ submissionId: 'sub-1', outcome: 'clean' }]);
    assert.equal(result.clean, 1);
    assert.equal(result.quarantined, 0);
    assert.deepEqual(limits, [7], 'the claim is bounded by the configured batch size');
    assert.equal(inputs.length, 1);
    assert.equal(inputs[0].objectKey, STORAGE_KEY);
    assert.equal(inputs[0].etag, 'etag-1');
    assert.equal(inputs[0].sizeBytes, 2048);
    assert.equal(inputs[0].extension, 'pdf');
    assert.deepEqual(writes, [{
        submissionId: 'sub-1',
        tenantId: 'tenant-a',
        assignmentId: 'a-1',
        enrollmentId: 'enr-a',
        expectedSizeBytes: 2048,
        scanStatus: 'clean',
    }]);
    assert.equal(objectStore.stats(), 2, 'the object is re-stat\'ed after the verdict');
    assert.deepEqual(objectStore.removed, []);
});

test('scan worker: an infected verdict quarantines and removes the object', async () => {
    const { store, writes } = makeStore([candidate()]);
    const objectStore = makeVersionedObjectStore({
        initial: metadata({ etag: 'etag-1' }),
        conditionalDelete: true,
    });
    const worker = buildWorker(store, objectStore.store, {
        scanner: scannerReturning({ verdict: 'infected', signature: 'EICAR-Test' }),
    });
    const result = await worker.runOnce();
    assert.deepEqual(result.outcomes, [{ submissionId: 'sub-1', outcome: 'quarantined' }]);
    assert.equal(result.quarantined, 1);
    assert.equal(result.clean, 0);
    assert.equal(writes[0].scanStatus, 'infected');
    assert.deepEqual(objectStore.destroyed, ['etag-1:2048'], 'a quarantined object is not left readable');
});

test('scan worker: a scanner timeout is not a verdict, not clean and not infected', async () => {
    const { store, writes } = makeStore([candidate()]);
    const worker = buildWorker(store, makeObjectStore([metadata()]).store, {
        scanner: { scan: () => new Promise(() => undefined) },
        scanTimeoutMs: 20,
    });
    const result = await worker.runOnce();
    assert.deepEqual(result.outcomes, [{ submissionId: 'sub-1', outcome: 'scan_failed' }]);
    assert.equal(result.clean, 0);
    assert.equal(result.quarantined, 0);
    assert.equal(result.failed, 1);
    assert.equal(writes.length, 0, 'the row stays pending and retryable');
});

test('scan worker: a scanner error is not infected', async () => {
    const { store, writes } = makeStore([candidate()]);
    const worker = buildWorker(store, makeObjectStore([metadata()]).store, {
        scanner: scannerReturning(new Error('scanner offline')),
    });
    const result = await worker.runOnce();
    assert.deepEqual(result.outcomes, [{ submissionId: 'sub-1', outcome: 'scan_failed' }]);
    assert.equal(writes.length, 0, 'no failed/infected state is fabricated from an error');
    assert.equal(result.quarantined, 0);
});

test('scan worker: an unconfirmed verdict is retried a bounded number of times and never softened', async () => {
    const inputs: MalwareScanInput[] = [];
    const { store, writes } = makeStore([candidate()]);
    const worker = buildWorker(store, makeObjectStore([metadata()]).store, {
        scanner: scannerReturning(new Error('scanner offline'), inputs),
        maxAttemptsPerRow: 2,
        retryDelayMs: 1,
    });
    const result = await worker.runOnce();
    assert.equal(inputs.length, 2, 'the attempt cap bounds the retries');
    assert.deepEqual(result.outcomes, [{ submissionId: 'sub-1', outcome: 'scan_failed' }]);
    assert.equal(writes.length, 0);
    assert.equal(result.quarantined, 0);
});

/* ------------------------------------------------------------------------- */
/* Object identity and version binding                                        */
/* ------------------------------------------------------------------------- */

test('scan worker: an object replaced between the verdict and the write is never recorded', async () => {
    const { store, writes } = makeStore([candidate()]);
    const objectStore = makeObjectStore([metadata({ etag: 'etag-1' }), metadata({ etag: 'etag-2' })]);
    const worker = buildWorker(store, objectStore.store, {
        scanner: scannerReturning({ verdict: 'clean' }),
    });
    const result = await worker.runOnce();
    assert.deepEqual(result.outcomes, [{ submissionId: 'sub-1', outcome: 'object_changed' }]);
    assert.equal(writes.length, 0, 'a verdict for a replaced object authorizes nothing');
    assert.equal(result.clean, 0);
});

test('scan worker: an object whose size differs from the verified row is skipped before scanning', async () => {
    const inputs: MalwareScanInput[] = [];
    const { store, writes } = makeStore([candidate({ fileSizeBytes: 4096 })]);
    const worker = buildWorker(store, makeObjectStore([metadata()]).store, {
        scanner: scannerReturning({ verdict: 'clean' }, inputs),
    });
    const result = await worker.runOnce();
    assert.deepEqual(result.outcomes, [{ submissionId: 'sub-1', outcome: 'object_changed' }]);
    assert.equal(inputs.length, 0, 'a different object is never scanned under the old row');
    assert.equal(writes.length, 0);
});

test('scan worker: an object the adapter cannot version is skipped, never scanned', async () => {
    const inputs: MalwareScanInput[] = [];
    const { store, writes } = makeStore([candidate()]);
    const worker = buildWorker(store, makeObjectStore([metadata({ etag: null })]).store, {
        scanner: scannerReturning({ verdict: 'clean' }, inputs),
    });
    const result = await worker.runOnce();
    assert.deepEqual(result.outcomes, [{ submissionId: 'sub-1', outcome: 'unbound_object_version' }]);
    assert.equal(inputs.length, 0);
    assert.equal(writes.length, 0);
});

test('scan worker: a key that does not match the row facts is never touched', async () => {
    const { store, writes } = makeStore([candidate({
        storageKey: 'tenants/tenant-b/assignments/a-1/enr-a/sub-1.pdf',
    })]);
    const objectStore = makeObjectStore([metadata()]);
    const worker = buildWorker(store, objectStore.store, {
        scanner: scannerReturning({ verdict: 'clean' }),
    });
    const result = await worker.runOnce();
    assert.deepEqual(result.outcomes, [{ submissionId: 'sub-1', outcome: 'binding_mismatch' }]);
    assert.equal(objectStore.stats(), 0, 'a forged row key is never stat\'ed');
    assert.equal(writes.length, 0);
});

test('scan worker: a missing object is skipped and never recorded', async () => {
    const { store, writes } = makeStore([candidate()]);
    const worker = buildWorker(store, makeObjectStore([null]).store, {
        scanner: scannerReturning({ verdict: 'clean' }),
    });
    const result = await worker.runOnce();
    assert.deepEqual(result.outcomes, [{ submissionId: 'sub-1', outcome: 'object_missing' }]);
    assert.equal(writes.length, 0);
});

test('scan worker: a lost CAS write records no verdict and is not retried', async () => {
    const inputs: MalwareScanInput[] = [];
    const { store } = makeStore([candidate()], { record: false });
    const worker = buildWorker(store, makeObjectStore([metadata(), metadata()]).store, {
        scanner: scannerReturning({ verdict: 'clean' }, inputs),
    });
    const result = await worker.runOnce();
    assert.deepEqual(result.outcomes, [{ submissionId: 'sub-1', outcome: 'verdict_not_recorded' }]);
    assert.equal(result.clean, 0);
    assert.equal(inputs.length, 1, 'the loser never loops to force a verdict');
});

test('scan worker: an infected verdict still removes the object when the row write lost', async () => {
    const { store } = makeStore([candidate()], { record: false });
    const objectStore = makeVersionedObjectStore({
        initial: metadata({ etag: 'etag-1' }),
        conditionalDelete: true,
    });
    const worker = buildWorker(store, objectStore.store, {
        scanner: scannerReturning({ verdict: 'infected' }),
    });
    const result = await worker.runOnce();
    assert.deepEqual(result.outcomes, [{ submissionId: 'sub-1', outcome: 'verdict_not_recorded' }]);
    assert.deepEqual(objectStore.destroyed, ['etag-1:2048'], 'malware bytes are not kept because the row lost a race');
    assert.deepEqual(objectStore.mutableRemovals, [], 'the delete still names the scanned version, never the mutable key');
});

/* ------------------------------------------------------------------------- */
/* Quarantine cleanup: the delete must be bound to the scanned version        */
/* ------------------------------------------------------------------------- */

test('scan worker: an object replaced between the final re-stat and the delete keeps the new bytes', async () => {
    const { store, writes } = makeStore([candidate()]);
    // The worker stats twice (before the scan, and after it). The replacement
    // lands immediately after the second stat returns, i.e. exactly between the
    // final re-stat and the quarantine delete.
    const objectStore = makeVersionedObjectStore({
        initial: metadata({ etag: 'etag-1' }),
        replacement: metadata({ etag: 'etag-2' }),
        replaceAfterStats: 2,
        conditionalDelete: true,
    });
    const worker = buildWorker(store, objectStore.store, {
        scanner: scannerReturning({ verdict: 'infected', signature: 'EICAR-Test' }),
    });
    const result = await worker.runOnce();

    assert.deepEqual(objectStore.destroyed, [],
        'the replacement upload is never deleted: it was not the version that was scanned');
    assert.deepEqual(objectStore.mutableRemovals, [],
        'a mutable-key delete is never issued for a verdict');
    assert.deepEqual(objectStore.conditionalCalls, [{ etag: 'etag-1', sizeBytes: 2048 }],
        'the delete names the exact scanned version');
    assert.equal(writes[0].scanStatus, 'infected', 'the row is quarantined, never clean');
    assert.deepEqual(result.outcomes, [{ submissionId: 'sub-1', outcome: 'quarantined' }]);
    assert.deepEqual(result.quarantineCleanup, [{ submissionId: 'sub-1', cleanup: 'version_replaced' }]);
    assert.equal(result.clean, 0);
});

test('scan worker: an infected verdict on the scanned version removes exactly that version', async () => {
    const { store, writes } = makeStore([candidate()]);
    const objectStore = makeVersionedObjectStore({
        initial: metadata({ etag: 'etag-1' }),
        conditionalDelete: true,
    });
    const worker = buildWorker(store, objectStore.store, {
        scanner: scannerReturning({ verdict: 'infected' }),
    });
    const result = await worker.runOnce();

    assert.deepEqual(objectStore.destroyed, ['etag-1:2048']);
    assert.deepEqual(objectStore.mutableRemovals, []);
    assert.equal(writes[0].scanStatus, 'infected');
    assert.deepEqual(result.outcomes, [{ submissionId: 'sub-1', outcome: 'quarantined' }]);
    assert.deepEqual(result.quarantineCleanup, [{ submissionId: 'sub-1', cleanup: 'removed' }]);
});

test('scan worker: an adapter without exact-version delete quarantines the row and leaves cleanup pending', async () => {
    const { store, writes } = makeStore([candidate()]);
    // No capability declared: this is the production MinIO adapter's shape.
    const objectStore = makeVersionedObjectStore({ initial: metadata({ etag: 'etag-1' }) });
    const worker = buildWorker(store, objectStore.store, {
        scanner: scannerReturning({ verdict: 'infected' }),
    });
    const result = await worker.runOnce();

    assert.deepEqual(objectStore.mutableRemovals, [],
        'no delete is attempted at all without a proven exact-version capability');
    assert.deepEqual(objectStore.destroyed, []);
    assert.deepEqual(objectStore.conditionalCalls, []);
    assert.equal(writes[0].scanStatus, 'infected', 'the row is not readable after the infected verdict');
    assert.deepEqual(result.outcomes, [{ submissionId: 'sub-1', outcome: 'quarantined_cleanup_pending' }]);
    assert.deepEqual(result.quarantineCleanup, [{ submissionId: 'sub-1', cleanup: 'unsupported' }]);
    assert.equal(result.clean, 0);
});

test('scan worker: a failed exact-version delete leaves the row quarantined and reports pending cleanup', async () => {
    const { store, writes } = makeStore([candidate()]);
    const objectStore = makeVersionedObjectStore({
        initial: metadata({ etag: 'etag-1' }),
        conditionalDelete: true,
        conditionalDeleteFails: true,
    });
    const worker = buildWorker(store, objectStore.store, {
        scanner: scannerReturning({ verdict: 'infected' }),
    });
    const result = await worker.runOnce();

    assert.deepEqual(objectStore.mutableRemovals, [], 'a failed exact-version delete never falls back to the mutable key');
    assert.equal(writes[0].scanStatus, 'infected');
    assert.deepEqual(result.outcomes, [{ submissionId: 'sub-1', outcome: 'quarantined_cleanup_pending' }]);
    assert.deepEqual(result.quarantineCleanup, [{ submissionId: 'sub-1', cleanup: 'failed' }]);
});

test('scan worker: a verdict write that throws still never deletes the mutable key', async () => {
    const { store } = makeStore([candidate()], {
        record: () => { throw new Error('db write failed'); },
    });
    const objectStore = makeVersionedObjectStore({
        initial: metadata({ etag: 'etag-1' }),
        conditionalDelete: true,
    });
    const worker = buildWorker(store, objectStore.store, {
        scanner: scannerReturning({ verdict: 'infected' }),
    });
    const result = await worker.runOnce();

    assert.deepEqual(objectStore.mutableRemovals, []);
    assert.deepEqual(objectStore.conditionalCalls, [{ etag: 'etag-1', sizeBytes: 2048 }],
        'the only delete is the exact-version one, on the version that was scanned');
    assert.deepEqual(result.outcomes, [{ submissionId: 'sub-1', outcome: 'scan_failed' }]);
    assert.equal(result.clean, 0, 'a failed verdict write never yields a clean state');
});

/* ------------------------------------------------------------------------- */
/* Bounded execution                                                          */
/* ------------------------------------------------------------------------- */

test('scan worker: batch size and concurrency stay inside their bounds', async () => {
    const candidates = Array.from({ length: 25 }, (_, index) => candidate({
        submissionId: `sub-${index + 1}`,
        storageKey: `tenants/tenant-a/assignments/a-1/enr-a/sub-${index + 1}.pdf`,
    }));
    let inFlight = 0;
    let peak = 0;
    const scanner: MalwareScanner = {
        scan: async () => {
            inFlight += 1;
            peak = Math.max(peak, inFlight);
            await new Promise((resolve) => setImmediate(resolve));
            inFlight -= 1;
            return { verdict: 'clean' };
        },
    };
    const { store, limits } = makeStore(candidates);
    const worker = buildWorker(store, makeObjectStore([metadata()]).store, {
        scanner,
        batchSize: 5,
        concurrency: 2,
    });
    const result = await worker.runOnce();
    assert.deepEqual(limits, [5]);
    assert.equal(result.claimed, 5, 'a run never claims more than one bounded batch');
    assert.equal(result.outcomes.length, 5);
    assert.ok(peak <= 2, `peak concurrency ${peak} exceeded the configured pool`);
});

test('scan worker: a duplicated candidate row is processed once', async () => {
    const inputs: MalwareScanInput[] = [];
    const { store } = makeStore([candidate(), candidate()]);
    const worker = buildWorker(store, makeObjectStore([metadata(), metadata()]).store, {
        scanner: scannerReturning({ verdict: 'clean' }, inputs),
    });
    const result = await worker.runOnce();
    assert.equal(result.claimed, 2, 'the claim reports what the store returned');
    assert.equal(result.outcomes.length, 1, 'a row is never scanned twice in one run');
    assert.equal(inputs.length, 1);
});

test('scan worker: a failing claim store is retried with bounded backoff, then the run aborts', async () => {
    const sleeps: number[] = [];
    const { store, listCalls } = makeStore([candidate()], { listFailures: 3 });
    const worker = buildWorker(store, makeObjectStore([metadata()]).store, {
        scanner: scannerReturning({ verdict: 'clean' }),
        claimAttempts: 3,
        retryDelayMs: 5,
        sleep: async (ms) => { sleeps.push(ms); },
    });
    const result = await worker.runOnce();
    assert.equal(result.aborted, 'claim_failed');
    assert.equal(listCalls(), 3, 'the claim retry is bounded');
    assert.deepEqual(sleeps, [5, 10], 'backoff grows deterministically');
    assert.equal(result.claimed, 0);
});

test('scan worker: a claim store that recovers inside the retry budget is used', async () => {
    const sleeps: number[] = [];
    const { store, listCalls } = makeStore([candidate()], { listFailures: 2 });
    const worker = buildWorker(store, makeObjectStore([metadata(), metadata()]).store, {
        scanner: scannerReturning({ verdict: 'clean' }),
        claimAttempts: 3,
        retryDelayMs: 1,
        sleep: async (ms) => { sleeps.push(ms); },
    });
    const result = await worker.runOnce();
    assert.equal(listCalls(), 3);
    assert.deepEqual(sleeps, [1, 2]);
    assert.equal(result.aborted, null);
    assert.equal(result.clean, 1);
});

test('scan worker: a second concurrent run in the same process is refused', async () => {
    let release: (() => void) | undefined;
    const scanner: MalwareScanner = {
        scan: () => new Promise<MalwareScanVerdict>((resolve) => {
            release = () => resolve({ verdict: 'clean' });
        }),
    };
    const { store } = makeStore([candidate()]);
    const worker = buildWorker(store, makeObjectStore([metadata(), metadata()]).store, { scanner });
    const first = worker.runOnce();
    await new Promise((resolve) => setImmediate(resolve));
    const second = await worker.runOnce();
    assert.equal(second.aborted, 'already_running');
    assert.equal(second.claimed, 0);
    release?.();
    const firstResult = await first;
    assert.equal(firstResult.clean, 1);
});

test('scan worker: configuration is clamped to the documented bounds', async () => {
    const { store, limits } = makeStore([]);
    const worker = buildWorker(store, makeObjectStore([metadata()]).store, {
        scanner: scannerReturning({ verdict: 'clean' }),
        batchSize: 10_000,
        concurrency: 10_000,
    });
    await worker.runOnce();
    assert.deepEqual(limits, [MAX_SCAN_BATCH_SIZE]);
    assert.equal(DEFAULT_SCAN_BATCH_SIZE, 10);
    assert.equal(DEFAULT_SCAN_CONCURRENCY, 2);
    assert.equal(MAX_SCAN_CONCURRENCY, 8);
});

/* ------------------------------------------------------------------------- */
/* SQL store: existing columns only                                           */
/* ------------------------------------------------------------------------- */

test('sql scan store: the claim is bounded and excludes revoked rows', async () => {
    const statements: Array<{ sql: string; params: unknown[] }> = [];
    const store = createSqlAssignmentScanStore({
        query: async <T>(sql: string, params?: unknown[]) => {
            statements.push({ sql, params: params ?? [] });
            return [{
                id: 'sub-1',
                tenant_id: 'tenant-a',
                assignment_id: 'a-1',
                student_enrollment_id: 'enr-a',
                storage_key: STORAGE_KEY,
                file_size_bytes: 2048,
            }] as unknown as T[];
        },
        execute: async (sql, params) => {
            statements.push({ sql, params: params ?? [] });
            return { affectedRows: 1 };
        },
    });

    const batch = await store.listPendingScanBatch({ limit: 500 });
    assert.deepEqual(batch, [candidate()]);
    const list = statements[0];
    assert.match(list.sql, /FROM assignment_submissions/);
    assert.match(list.sql, /scan_status='pending'/);
    assert.match(list.sql, /file_size_bytes>0/);
    assert.match(list.sql, /status<>'revoked'/, 'a revoked version is never scanned');
    assert.match(list.sql, /LIMIT 50/, 'an over-large batch is clamped, not interpolated raw');
    assert.equal(/\b(INSERT|UPDATE|DELETE)\b/.test(list.sql), false);
    assert.deepEqual(list.params, []);
});

test('sql scan store: the verdict write is a CAS on columns that exist', async () => {
    const statements: Array<{ sql: string; params: unknown[] }> = [];
    let affectedRows = 1;
    const store = createSqlAssignmentScanStore({
        query: async <T>() => [] as T[],
        execute: async (sql, params) => {
            statements.push({ sql, params: params ?? [] });
            return { affectedRows };
        },
    });

    const write: ScanVerdictWrite = {
        submissionId: 'sub-1',
        tenantId: 'tenant-a',
        assignmentId: 'a-1',
        enrollmentId: 'enr-a',
        expectedSizeBytes: 2048,
        scanStatus: 'clean',
    };
    assert.equal(await store.recordScanVerdict(write), true);
    const statement = statements[0];
    assert.match(statement.sql, /UPDATE assignment_submissions/);
    assert.match(statement.sql, /SET scan_status=\?/);
    assert.match(statement.sql, /AND scan_status='pending' AND file_size_bytes=\?/,
        'the write only lands on the version that was scanned');
    assert.match(statement.sql, /status<>'revoked'/);
    assert.deepEqual(statement.params, ['clean', 'sub-1', 'tenant-a', 'a-1', 'enr-a', 2048]);
    for (const invented of ['scan_attempts', 'scan_claimed_at', 'scan_last_error', 'object_etag', 'upload_state']) {
        assert.equal(statement.sql.includes(invented), false,
            `${invented} does not exist in the schema and must not be written`);
    }

    affectedRows = 0;
    assert.equal(await store.recordScanVerdict({ ...write, scanStatus: 'infected' }), false,
        'a lost CAS is reported, not assumed');
});
