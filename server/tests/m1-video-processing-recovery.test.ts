/**
 * M1 video processing reliability + recovery regressions (hermetic: no DB,
 * no MinIO, no network, no real env keys, no Docker).
 *
 * Exercises the REAL processing lifecycle orchestration exported from
 * server/src/routes/videos.ts against injected adapters:
 *  - runVideoProcessingJob        -> the single protected execution path
 *  - createSqlVideoJobLoader      -> exact tenant/video/job ownership read
 *  - createSqlVideoJobClaim       -> atomic pending/stale claim
 *  - createSqlVideoJobSettler     -> terminal settling consistent with videos
 *  - createPendingVideoJobLoader  -> the unified recovery read (pending + crashed)
 *  - loadPendingJobsWithRetry     -> transient read failure retry + backoff
 *  - reconcileVideoProcessingQueue-> bounded sweep (batch/saturation)
 *  - scheduleVideoQueueConsumer   -> startup + periodic consumer cadence
 *  - createSqlUploadLockManager   -> cross-process named-lock serialization
 *  - evaluateUploadContentRequest / evaluateUploadCompletion -> size/authority
 *
 * Required scenarios: old/new startup duplication, two independent worker
 * instances competing, different-tenant queue/video mismatch, crash
 * before/after commit, released/lost lock, enqueue/rollback/release failure,
 * transient queue read failure recovery, bounded concurrency, shutdown,
 * replay, and the existing upload size/authority cases.
 *
 * Test limits (explicit):
 *  - Hermetic only: fixtures are injected adapters and fake rows; no MySQL,
 *    MinIO, Docker, network, or real env key is touched. The MinIO client
 *    import below only satisfies the route module's import-time construction
 *    and never connects.
 *  - The fake named-lock registry arbitrates the PRODUCTION lock names
 *    (uploadLockName-derived processing names are asserted by text); real
 *    cross-process exclusion is MySQL GET_LOCK's job, and live MySQL
 *    verification remains pending by design of the task acceptance.
 *  - Unit/static sections are labeled as such: SQL-text assertions prove
 *    the emitted predicates, not a MySQL engine.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
    PendingVideoJob,
    UploadLockConnection,
    VideoJobRunDeps,
    VideoJobRow,
    VideoQueueConsumerHandle,
} from '../src/routes/videos';

process.env.MINIO_ACCESS_KEY ??= 'test-access-key';
process.env.MINIO_SECRET_KEY ??= 'test-secret-key';

const {
    runVideoProcessingJob,
    createSqlVideoJobLoader,
    createSqlVideoJobClaim,
    createSqlVideoJobSettler,
    loadPendingJobsWithRetry,
    createPendingVideoJobLoader,
    reconcileVideoProcessingQueue,
    scheduleVideoQueueConsumer,
    requestVideoProcessingShutdown,
    isVideoProcessingShutdown,
    videoProcessingConcurrency,
    videoQueuePollSeconds,
    videoQueueBatchSize,
    processingLeaseMinutes,
    videoQueueLoadAttempts,
    videoQueueLoadBackoffMs,
    videoProcessingWorkerId,
    PROCESSING_LOCK_POOL_SIZE,
    DEFAULT_PROCESSING_CONCURRENCY,
    DEFAULT_VIDEO_QUEUE_POLL_SECONDS,
    DEFAULT_VIDEO_QUEUE_BATCH_SIZE,
    DEFAULT_VIDEO_QUEUE_LOAD_ATTEMPTS,
    DEFAULT_VIDEO_QUEUE_LOAD_BACKOFF_MS,
    DEFAULT_PROCESSING_LEASE_MINUTES,
    createSqlUploadLockManager,
    createUploadLockManagerFromPool,
    toUploadLockConnection,
    claimAndEnqueueOnConnection,
    evaluateUploadContentRequest,
    evaluateUploadCompletion,
    DEFAULT_UPLOAD_SESSION_TTL_MINUTES,
} = require('../src/routes/videos') as typeof import('../src/routes/videos');

const videos = readFileSync(join(__dirname, '..', 'src', 'routes', 'videos.ts'), 'utf8');
const indexSource = readFileSync(join(__dirname, '..', 'src', 'index.ts'), 'utf8');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const VIDEO = 'video-1';
const TENANT = 'tenant-1';

const jobRow = (over: Partial<VideoJobRow> = {}): VideoJobRow => ({
    videoId: VIDEO,
    tenantId: TENANT,
    queueStatus: 'pending',
    videoStatus: 'processing',
    ...over,
});

/** Records every adapter call of a protected run. */
interface RunRecorder {
    loadCalls: [string, string][];
    claims: string[];
    settles: { videoId: string; settled: string }[];
    runs: [string, string][];
    claimResult: boolean;
    job: VideoJobRow | null;
    runError: Error | null;
    settleError: Error | null;
}

const recorder = (over: Partial<RunRecorder> = {}): RunRecorder => ({
    loadCalls: [],
    claims: [],
    settles: [],
    runs: [],
    claimResult: true,
    job: jobRow(),
    runError: null,
    settleError: null,
    ...over,
});

const depsFor = (rec: RunRecorder, acquire: VideoJobRunDeps['acquireProcessingLock']): VideoJobRunDeps => ({
    loadJob: async (videoId, tenantId) => {
        rec.loadCalls.push([videoId, tenantId]);
        return rec.job;
    },
    acquireProcessingLock: acquire,
    claimJob: async (videoId) => {
        rec.claims.push(videoId);
        return rec.claimResult;
    },
    settleJob: async (videoId, outcome) => {
        rec.settles.push({ videoId, settled: outcome.settled });
        if (rec.settleError) throw rec.settleError;
    },
    runProcessing: async (videoId, tenantId) => {
        rec.runs.push([videoId, tenantId]);
        if (rec.runError) throw rec.runError;
    },
    workerId: 'worker-test',
});

// ---------------------------------------------------------------------------
// Cross-process named-lock harness
// ---------------------------------------------------------------------------

interface FakeRawConnection {
    query: (sql: string, params?: unknown[]) => Promise<[unknown, unknown]>;
    execute: (sql: string, params?: unknown[]) => Promise<[unknown, unknown]>;
    beginTransaction: () => Promise<void>;
    commit: () => Promise<void>;
    rollback: () => Promise<void>;
    release: () => void;
    destroy: () => void;
    released: boolean;
    destroyed: boolean;
}

/**
 * Arbitrates MySQL named locks across simulated processes in-process. The
 * registry keys are whatever the production managers ask for, so two
 * managers over separate connections behave like two server processes: the
 * second never acquires a held name. `destroy` models MySQL's session-death
 * semantics by freeing the holder's names.
 */
class NamedLockRegistry {
    readonly held = new Set<string>();
    releaseFails = false;
    connections: FakeRawConnection[] = [];

    connection(): FakeRawConnection {
        const registry = this;
        const heldByThis = new Set<string>();
        const connection: FakeRawConnection = {
            released: false,
            destroyed: false,
            query: async (sql: string, params: unknown[] = []): Promise<[unknown, unknown]> => {
                if (/SELECT GET_LOCK/.test(sql)) {
                    const name = String(params[0]);
                    let acquired = false;
                    if (!registry.held.has(name)) {
                        registry.held.add(name);
                        heldByThis.add(name);
                        acquired = true;
                    }
                    return [[{ acquired: acquired ? 1 : 0 }], null];
                }
                if (/SELECT RELEASE_LOCK/.test(sql)) {
                    if (registry.releaseFails) throw new Error('simulated RELEASE_LOCK failure');
                    const name = String(params[0]);
                    registry.held.delete(name);
                    heldByThis.delete(name);
                    return [[{ released: 1 }], null];
                }
                throw new Error(`unexpected lock query: ${sql}`);
            },
            execute: async (): Promise<[unknown, unknown]> => [{ affectedRows: 1 }, null],
            beginTransaction: async () => undefined,
            commit: async () => undefined,
            rollback: async () => undefined,
            release: () => {
                connection.released = true;
            },
            destroy: () => {
                connection.destroyed = true;
                for (const name of heldByThis) registry.held.delete(name);
                heldByThis.clear();
            },
        };
        this.connections.push(connection);
        return connection;
    }

    /** A lock manager over its OWN connection — one simulated process. */
    manager(options: { timeoutSeconds?: number } = {}): ReturnType<typeof createUploadLockManagerFromPool> {
        return createUploadLockManagerFromPool(
            { getConnection: async () => this.connection() },
            options,
        );
    }

    isHeld(name: string): boolean {
        return this.held.has(name);
    }
}

/** Recording generic SQL executor/executor for the production adapters. */
const sqlRecorder = () => {
    const seen: { sql: string; params: unknown[] }[] = [];
    return {
        seen,
        queryOne: async <T>(sql: string, params: unknown[] = []): Promise<T | null> => {
            seen.push({ sql, params });
            return null;
        },
        execute: async (sql: string, params: unknown[] = []): Promise<{ affectedRows: number }> => {
            seen.push({ sql, params });
            return { affectedRows: 1 };
        },
    };
};

// ---------------------------------------------------------------------------
// A. Exact tenant/video/job ownership + the production SQL adapters (static)
// ---------------------------------------------------------------------------

test('lifecycle: a pending job owned by the exact tenant runs, claims and settles', async () => {
    const rec = recorder();
    const registry = new NamedLockRegistry();
    const manager = registry.manager();

    const outcome = await runVideoProcessingJob(VIDEO, TENANT, depsFor(rec, manager.acquire));

    assert.equal(outcome, 'processed');
    assert.deepEqual(rec.loadCalls, [[VIDEO, TENANT]]);
    assert.deepEqual(rec.claims, [VIDEO]);
    assert.deepEqual(rec.runs, [[VIDEO, TENANT]]);
    assert.deepEqual(rec.settles, [{ videoId: VIDEO, settled: 'completed' }]);
    assert.equal(registry.isHeld('anything'), false, 'the lock is released after the run');
});

test('lifecycle: a null tenant is denied before any load, claim or run', async () => {
    const rec = recorder();
    const registry = new NamedLockRegistry();
    const outcome = await runVideoProcessingJob(VIDEO, '', depsFor(rec, registry.manager().acquire));
    assert.equal(outcome, 'no_job');
    assert.deepEqual(rec.loadCalls, []);
    assert.deepEqual(rec.claims, []);
    assert.deepEqual(rec.runs, []);
});

test('lifecycle: a queue row and video row from different tenants never match (no_job, nothing runs)', async () => {
    const rec = recorder({ job: null }); // the exact-match loader found no consistent pair
    const registry = new NamedLockRegistry();
    const outcome = await runVideoProcessingJob(VIDEO, TENANT, depsFor(rec, registry.manager().acquire));
    assert.equal(outcome, 'no_job');
    assert.deepEqual(rec.claims, []);
    assert.deepEqual(rec.runs, []);
});

test('static: the production job loader joins queue and video rows on exact, non-null tenant equality', async () => {
    const rec = sqlRecorder();
    await createSqlVideoJobLoader({ queryOne: rec.queryOne })(VIDEO, TENANT);
    assert.equal(rec.seen.length, 1);
    const { sql, params } = rec.seen[0];
    assert.match(sql, /FROM video_processing_queue q/);
    assert.match(sql, /INNER JOIN videos v ON v\.id = q\.video_id/);
    assert.match(sql, /q\.tenant_id IS NOT NULL/);
    assert.match(sql, /v\.tenant_id IS NOT NULL/);
    assert.match(sql, /q\.tenant_id = v\.tenant_id/);
    assert.match(sql, /q\.tenant_id = \?/);
    assert.deepEqual(params, [VIDEO, TENANT]);

    // a null caller tenant is denied before the database is touched at all
    const nullRec = sqlRecorder();
    assert.equal(await createSqlVideoJobLoader({ queryOne: nullRec.queryOne })(VIDEO, ''), null);
    assert.equal(nullRec.seen.length, 0);
});

test('static: the production claim takes pending or stale processing rows with started_at and worker_id', async () => {
    const rec = sqlRecorder();
    const claimed = await createSqlVideoJobClaim({ execute: rec.execute })(VIDEO, 'worker-7');
    assert.equal(claimed, true);
    const { sql, params } = rec.seen[0];
    assert.match(sql, /UPDATE video_processing_queue/);
    assert.match(sql, /status = 'processing'/);
    assert.match(sql, /started_at = NOW\(\)/);
    assert.match(sql, /worker_id = \?/);
    assert.match(sql, /WHERE video_id = \? AND status IN \('pending', 'processing'\)/);
    assert.deepEqual(params, ['worker-7', VIDEO]);
});

test('static: the production settler writes terminal states once, failed carrying the error message', async () => {
    const completed = sqlRecorder();
    await createSqlVideoJobSettler({ execute: completed.execute })(VIDEO, { settled: 'completed' });
    let { sql, params } = completed.seen[0];
    assert.match(sql, /SET status = 'completed', completed_at = NOW\(\), error_message = NULL, worker_id = NULL/);
    assert.match(sql, /WHERE video_id = \? AND status <> 'completed'/);
    assert.deepEqual(params, [VIDEO]);

    const failed = sqlRecorder();
    await createSqlVideoJobSettler({ execute: failed.execute })(VIDEO, { settled: 'failed', error: 'boom' });
    ({ sql, params } = failed.seen[0]);
    assert.match(sql, /SET status = 'failed', completed_at = NOW\(\), error_message = \?, worker_id = NULL/);
    assert.match(sql, /WHERE video_id = \? AND status <> 'failed'/);
    assert.deepEqual(params, ['boom', VIDEO]);

    // the recorded error is bounded: a runaway message cannot flood the row
    const long = sqlRecorder();
    await createSqlVideoJobSettler({ execute: long.execute })(VIDEO, { settled: 'failed', error: 'x'.repeat(5000) });
    assert.equal((long.seen[0].params[0] as string).length, 1000);
});

// ---------------------------------------------------------------------------
// B. Cross-process exclusion: two independent worker instances
// ---------------------------------------------------------------------------

test('exclusion: two independent workers competing for one video run the processor exactly once', async () => {
    const registry = new NamedLockRegistry();
    const workerA = recorder();
    const workerB = recorder();

    // Worker A takes the named lock and runs; worker B's arrive while the
    // lock is held must be denied — not queued, not run.
    const runningA = runVideoProcessingJob(VIDEO, TENANT, depsFor(workerA, registry.manager().acquire));
    const deniedB = await runVideoProcessingJob(VIDEO, TENANT, depsFor(workerB, registry.manager().acquire));

    assert.equal(deniedB, 'locked');
    assert.deepEqual(workerB.loadCalls, [[VIDEO, TENANT]], 'the loser still verifies ownership first');
    assert.deepEqual(workerB.claims, []);
    assert.deepEqual(workerB.runs, []);

    assert.equal(await runningA, 'processed');
    assert.deepEqual(workerA.runs, [[VIDEO, TENANT]]);
    assert.deepEqual(workerA.settles, [{ videoId: VIDEO, settled: 'completed' }]);
});

test('exclusion: a same-process concurrent second run is also denied by the named lock', async () => {
    const registry = new NamedLockRegistry();
    const first = recorder();
    const second = recorder();

    const running = runVideoProcessingJob(VIDEO, TENANT, depsFor(first, registry.manager().acquire));
    const denied = await runVideoProcessingJob(VIDEO, TENANT, depsFor(second, registry.manager().acquire));
    assert.equal(denied, 'locked');
    await running;
    assert.deepEqual(second.runs, []);
});

test('exclusion: a released lock frees the video for the next run (replay after a settle is a fresh job)', async () => {
    const registry = new NamedLockRegistry();
    const first = recorder();
    assert.equal(await runVideoProcessingJob(VIDEO, TENANT, depsFor(first, registry.manager().acquire)), 'processed');

    // A new committed job (e.g. an admin re-open) runs through the same path.
    const second = recorder({ job: jobRow() });
    assert.equal(await runVideoProcessingJob(VIDEO, TENANT, depsFor(second, registry.manager().acquire)), 'processed');
    assert.deepEqual(second.runs, [[VIDEO, TENANT]]);
    assert.equal(registry.connections.every((c) => c.released || c.destroyed), true, 'every lock connection is returned or destroyed, never leaked');
});

test('exclusion: a RELEASE_LOCK failure destroys the lock connection instead of pooling it', async () => {
    const registry = new NamedLockRegistry();
    registry.releaseFails = true; // the release round-trip fails for every connection
    const rec = recorder();

    // The run itself must still complete; the teardown must destroy.
    const outcome = await runVideoProcessingJob(VIDEO, TENANT, depsFor(rec, registry.manager().acquire));
    assert.equal(outcome, 'processed');
    assert.equal(rec.settles[0]!.settled, 'completed');

    const used = registry.connections[0]!;
    assert.equal(used.destroyed, true, 'an uncertain RELEASE_LOCK destroys the connection');
    assert.equal(used.released, false, 'a possibly-lock-owning connection is never returned to a pool');
    assert.equal(registry.held.size, 0, 'destroy frees the session locks (MySQL session-death semantics)');
});

test('exclusion: a lost holder frees the lock — a crashed run never deadlocks recovery', async () => {
    // Worker A acquires the lock and blocks INSIDE the processor, then its
    // connection is destroyed (the process dying). Recovery must proceed.
    const registryForCrash = new NamedLockRegistry();
    const crashed = recorder();
    let unblock: () => void = () => undefined;
    const blocked = new Promise<void>((resolve) => { unblock = resolve; });
    const crashedDeps: VideoJobRunDeps = {
        ...depsFor(crashed, registryForCrash.manager().acquire),
        runProcessing: async (videoId, tenantId) => {
            crashed.runs.push([videoId, tenantId]);
            await blocked;
        },
    };
    const crashedRun = runVideoProcessingJob(VIDEO, TENANT, crashedDeps);
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(crashed.runs.length, 1, 'the crashed worker is mid-run, holding the lock');

    for (const connection of registryForCrash.connections) connection.destroy();
    assert.equal(registryForCrash.held.size, 0, 'the dead holder no longer owns the lock');
    unblock();
    await crashedRun;

    // Recovery in another process can now take the job over.
    const registry = new NamedLockRegistry();
    const recovery = recorder({ job: jobRow({ queueStatus: 'processing' }) });
    assert.equal(await runVideoProcessingJob(VIDEO, TENANT, depsFor(recovery, registry.manager().acquire)), 'processed');
});

// ---------------------------------------------------------------------------
// C. Crash semantics, stale takeover, settling and replay
// ---------------------------------------------------------------------------

test('crash: a row claimed but not yet locked is taken over once its claimant is gone', async () => {
    // The claimant died between the row claim and the lock: the row says
    // 'processing', the lock is free. The lock is the authoritative liveness
    // check, so takeover (re-stamp + run) is safe and is the only re-run.
    const registry = new NamedLockRegistry();
    const rec = recorder({ job: jobRow({ queueStatus: 'processing' }) });
    const outcome = await runVideoProcessingJob(VIDEO, TENANT, depsFor(rec, registry.manager().acquire));
    assert.equal(outcome, 'processed');
    assert.deepEqual(rec.claims, [VIDEO], 'the stale row is re-claimed by the recovering worker');
    assert.deepEqual(rec.runs, [[VIDEO, TENANT]]);
});

test('crash: the loader only offers stale processing rows to recovery (live runs protected)', async () => {
    let seenSql = '';
    let seenParams: unknown[] = [];
    await createPendingVideoJobLoader(async (sql: string, params?: unknown[]) => {
        seenSql = sql;
        seenParams = params ?? [];
        return [];
    })();
    // pending rows are always eligible; 'processing' rows only past the horizon
    assert.match(seenSql, /q\.status IN \('pending', 'processing'\)/);
    assert.match(seenSql, /\(q\.status = 'pending' OR q\.started_at IS NULL OR q\.started_at < DATE_SUB\(NOW\(\), INTERVAL \? MINUTE\)\)/);
    assert.deepEqual(seenParams, [processingLeaseMinutes(), videoQueueBatchSize()]);
});

test('settle: a processing failure settles the queue row failed and the video state stays authoritative', async () => {
    const registry = new NamedLockRegistry();
    const rec = recorder({ runError: new Error('ffmpeg exploded') });
    const outcome = await runVideoProcessingJob(VIDEO, TENANT, depsFor(rec, registry.manager().acquire));
    assert.equal(outcome, 'processing_failed');
    assert.equal(rec.settles.length, 1);
    assert.equal(rec.settles[0]!.settled, 'failed');
    assert.deepEqual(rec.runs, [[VIDEO, TENANT]]);
});

test('settle: a settle failure is contained — the run result is not masked and nothing throws', async () => {
    const registry = new NamedLockRegistry();
    const rec = recorder({ settleError: new Error('db write failed') });
    const outcome = await runVideoProcessingJob(VIDEO, TENANT, depsFor(rec, registry.manager().acquire));
    assert.equal(outcome, 'processed', 'a failed settle must not rewrite the run result');
    assert.deepEqual(rec.runs, [[VIDEO, TENANT]]);
});

test('settle: a failed processing run settles failed even when the settle itself fails', async () => {
    const registry = new NamedLockRegistry();
    const rec = recorder({ runError: new Error('transcode failed'), settleError: new Error('db write failed') });
    const outcome = await runVideoProcessingJob(VIDEO, TENANT, depsFor(rec, registry.manager().acquire));
    assert.equal(outcome, 'processing_failed');
    assert.equal(rec.settles[0]!.settled, 'failed');
});

test('claim: a vanished row (claim affects nothing) is contained and never runs the processor', async () => {
    const registry = new NamedLockRegistry();
    const rec = recorder({ claimResult: false });
    const outcome = await runVideoProcessingJob(VIDEO, TENANT, depsFor(rec, registry.manager().acquire));
    assert.equal(outcome, 'no_job');
    assert.deepEqual(rec.runs, []);
    assert.deepEqual(rec.settles, []);
});

test('replay: a completed or failed queue row is never re-run', async () => {
    const registry = new NamedLockRegistry();
    for (const queueStatus of ['completed', 'failed'] as const) {
        const rec = recorder({ job: jobRow({ queueStatus }) });
        const outcome = await runVideoProcessingJob(VIDEO, TENANT, depsFor(rec, registry.manager().acquire));
        assert.equal(outcome, 'already_settled');
        assert.deepEqual(rec.runs, []);
        assert.deepEqual(rec.settles, []);
    }
});

test('replay: a video already ready is never re-processed — the lost settle is repaired instead', async () => {
    // The run finished (video 'ready') but its settle was lost: the row must
    // be settled completed WITHOUT invoking the processor again — a re-run
    // would find no original object and could flip a ready video to failed.
    const registry = new NamedLockRegistry();
    const rec = recorder({ job: jobRow({ queueStatus: 'processing', videoStatus: 'ready' }) });
    const outcome = await runVideoProcessingJob(VIDEO, TENANT, depsFor(rec, registry.manager().acquire));
    assert.equal(outcome, 'already_settled');
    assert.deepEqual(rec.runs, []);
    assert.deepEqual(rec.settles, [{ videoId: VIDEO, settled: 'completed' }]);
});

test('replay: a video already failed settles the row failed without a re-run', async () => {
    const registry = new NamedLockRegistry();
    const rec = recorder({ job: jobRow({ queueStatus: 'processing', videoStatus: 'failed' }) });
    const outcome = await runVideoProcessingJob(VIDEO, TENANT, depsFor(rec, registry.manager().acquire));
    assert.equal(outcome, 'already_settled');
    assert.deepEqual(rec.runs, []);
    assert.equal(rec.settles[0]!.settled, 'failed');
});

test('replay: a video still uploading is never processed (a live upload is not a crashed job)', async () => {
    const registry = new NamedLockRegistry();
    const rec = recorder({ job: jobRow({ videoStatus: 'uploading' }) });
    const outcome = await runVideoProcessingJob(VIDEO, TENANT, depsFor(rec, registry.manager().acquire));
    assert.equal(outcome, 'video_not_processing');
    assert.deepEqual(rec.runs, []);
});

// ---------------------------------------------------------------------------
// D. Bounded sweeps, retry/backoff, consumer cadence, configuration
// ---------------------------------------------------------------------------

test('sweep: the reconciliation sweep stops at in-process saturation and never launches everything at once', async () => {
    const jobs: PendingVideoJob[] = Array.from({ length: 8 }, (_, i) => ({ videoId: `video-${i}`, tenantId: TENANT }));
    const started: string[] = [];
    const result = await reconcileVideoProcessingQueue({
        loadPendingJobs: async () => jobs,
        isProcessing: () => false,
        startProcessing: (videoId) => {
            // bound reached after two starts: remaining rows wait for next sweep
            if (started.length >= 2) return 'saturated';
            started.push(videoId);
            return 'started';
        },
    });
    assert.deepEqual(started, ['video-0', 'video-1']);
    assert.deepEqual(result.requeued, ['video-0', 'video-1']);
});

test('sweep: a job already running in this process is never double-fed', async () => {
    const started: string[] = [];
    const result = await reconcileVideoProcessingQueue({
        loadPendingJobs: async () => [{ videoId: 'video-1', tenantId: TENANT }],
        isProcessing: (videoId) => videoId === 'video-1',
        startProcessing: (videoId) => { started.push(videoId); },
    });
    assert.deepEqual(started, []);
    assert.deepEqual(result.requeued, []);
});

test('sweep: a failing load is contained and never crashes the consumer', async () => {
    const result = await reconcileVideoProcessingQueue({
        loadPendingJobs: async () => { throw new Error('simulated queue read failure'); },
        isProcessing: () => false,
        startProcessing: () => { throw new Error('nothing may start when the load failed'); },
    });
    assert.deepEqual(result.requeued, []);
});

test('sweep: a legacy double-returning starter (void) still counts as started', async () => {
    const started: string[] = [];
    const result = await reconcileVideoProcessingQueue({
        loadPendingJobs: async () => [{ videoId: 'video-1', tenantId: TENANT }],
        isProcessing: () => false,
        startProcessing: (videoId) => { started.push(videoId); },
    });
    assert.deepEqual(result.requeued, ['video-1']);
});

test('retry: a transient queue read failure retries with exponential backoff and then succeeds', async () => {
    const delays: number[] = [];
    let attempts = 0;
    const jobs = await loadPendingJobsWithRetry(
        async () => {
            attempts++;
            if (attempts < 3) throw new Error('simulated transient read failure');
            return [{ videoId: VIDEO, tenantId: TENANT }];
        },
        {
            attempts: 3,
            backoffMs: DEFAULT_VIDEO_QUEUE_LOAD_BACKOFF_MS,
            sleep: async (ms) => { delays.push(ms); },
        },
    );
    assert.equal(attempts, 3);
    assert.deepEqual(delays, [1000, 2000]);
    assert.deepEqual(jobs, [{ videoId: VIDEO, tenantId: TENANT }]);
});

test('retry: a persistent queue read failure surfaces the last error after the bounded attempts', async () => {
    const delays: number[] = [];
    let attempts = 0;
    await assert.rejects(
        () => loadPendingJobsWithRetry(
            async () => { attempts++; throw new Error('permanent read failure'); },
            { attempts: videoQueueLoadAttempts(), backoffMs: videoQueueLoadBackoffMs(), sleep: async (ms) => { delays.push(ms); } },
        ),
        /permanent read failure/,
    );
    assert.equal(attempts, DEFAULT_VIDEO_QUEUE_LOAD_ATTEMPTS);
    assert.deepEqual(delays, [1000, 2000]);
});

test('consumer: the periodic consumer sweeps immediately, then on its interval, and stops cleanly', async () => {
    const timestamps: number[] = [];
    const consumer = scheduleVideoQueueConsumer({
        intervalMs: 25,
        sweep: async () => {
            timestamps.push(Date.now());
            return { requeued: [], loadFailed: false };
        },
    });
    consumer.start();
    assert.equal(timestamps.length, 1, 'the first sweep runs immediately at startup');
    await new Promise((resolve) => setTimeout(resolve, 80));
    consumer.stop();
    const atStop = timestamps.length;
    assert.ok(atStop >= 2, `the consumer repeated on its interval (saw ${atStop})`);
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(timestamps.length, atStop, 'stop() ends the cadence immediately');
});

test('consumer: a start() after start() does not double the cadence', async () => {
    let sweeps = 0;
    const consumer: VideoQueueConsumerHandle = scheduleVideoQueueConsumer({
        intervalMs: 25,
        sweep: async () => { sweeps++; return { requeued: [], loadFailed: false }; },
    });
    consumer.start();
    consumer.start();
    await new Promise((resolve) => setTimeout(resolve, 60));
    consumer.stop();
    assert.ok(sweeps >= 1);
});

test('config: the lifecycle bounds are conservative defaults, env-tunable within sane ranges', () => {
    assert.equal(DEFAULT_PROCESSING_CONCURRENCY, 2);
    assert.equal(videoProcessingConcurrency(), 2);
    assert.equal(DEFAULT_VIDEO_QUEUE_POLL_SECONDS, 60);
    assert.equal(videoQueuePollSeconds(), 60);
    assert.equal(DEFAULT_VIDEO_QUEUE_BATCH_SIZE, 10);
    assert.equal(videoQueueBatchSize(), 10);
    assert.equal(DEFAULT_VIDEO_QUEUE_LOAD_ATTEMPTS, 3);
    assert.equal(videoQueueLoadAttempts(), 3);
    assert.equal(DEFAULT_VIDEO_QUEUE_LOAD_BACKOFF_MS, 1000);
    assert.equal(videoQueueLoadBackoffMs(), 1000);
    assert.equal(DEFAULT_PROCESSING_LEASE_MINUTES, 60);
    assert.equal(processingLeaseMinutes(), 60);

    // the lock pool is sized for the bounded concurrency plus one recovery
    // probe, and is strictly smaller than the 10-slot request pool
    assert.ok(PROCESSING_LOCK_POOL_SIZE >= DEFAULT_PROCESSING_CONCURRENCY + 1);
    assert.ok(PROCESSING_LOCK_POOL_SIZE < 10);

    // env overrides are honored and sanitized
    process.env.VIDEO_PROCESSING_CONCURRENCY = '5';
    assert.equal(videoProcessingConcurrency(), 5);
    process.env.VIDEO_PROCESSING_CONCURRENCY = 'not-a-number';
    assert.equal(videoProcessingConcurrency(), DEFAULT_PROCESSING_CONCURRENCY, 'a garbage override falls back to the default');
    delete process.env.VIDEO_PROCESSING_CONCURRENCY;

    // worker ids are process-scoped and non-empty
    assert.match(videoProcessingWorkerId(), /^wb-\d+-[0-9a-f]{8}$/);
});

// ---------------------------------------------------------------------------
// E. End-to-end lifecycle: commit -> crash -> recovery consumes exactly once
// ---------------------------------------------------------------------------

/** In-memory model of the two rows the lifecycle touches. */
interface ComposeDb {
    video: { id: string; tenant_id: string; uploaded_by: string; status: string };
    queue: { video_id: string; tenant_id: string; status: string } | null;
}

const composeConnection = (db: ComposeDb, failEnqueue = false) => {
    const snapshot = JSON.stringify(db);
    const connection: UploadLockConnection = {
        query: async () => [],
        execute: async (sql, params = []) => {
            if (/UPDATE videos SET status = 'processing'/.test(sql)) {
                if (!db.video || db.video.status !== 'uploading') return { affectedRows: 0 };
                db.video.status = 'processing';
                return { affectedRows: 1 };
            }
            if (/INSERT INTO video_processing_queue/.test(sql)) {
                if (failEnqueue) throw new Error('simulated enqueue failure');
                db.queue = { video_id: String(params[1]), tenant_id: String(params[2]), status: 'pending' };
                return { affectedRows: 1 };
            }
            throw new Error(`unexpected execute: ${sql}`);
        },
        beginTransaction: async () => undefined,
        commit: async () => undefined,
        rollback: async () => { Object.assign(db, JSON.parse(snapshot) as ComposeDb); },
        release: async () => undefined,
    };
    return connection;
};

test('e2e: commit then crash then restart — the sweep consumes the committed job exactly once', async () => {
    const db: ComposeDb = {
        video: { id: VIDEO, tenant_id: TENANT, uploaded_by: 'teacher-1', status: 'uploading' },
        queue: null,
    };

    // 1. finalization commits: video 'processing' + queue row 'pending' as ONE
    //    transaction on the lock connection, then the process dies before the
    //    in-process run.
    const claim = await claimAndEnqueueOnConnection(composeConnection(db))(
        uploadSession(),
        { id: 'teacher-1', tenantId: TENANT },
    );
    assert.equal(claim, 'claimed');
    assert.equal(db.video.status, 'processing');
    assert.equal(db.queue?.status, 'pending');
    // the crash: nothing else ran. The queue row is durable.

    // 2. recovery in the restarted process goes through the SAME protected
    //    path, over the real adapters against the composed state.
    const runs: string[] = [];
    const registry = new NamedLockRegistry();
    const recoveryDeps: VideoJobRunDeps = {
        loadJob: async (videoId, tenantId) => {
            if (!db.queue || !db.video) return null;
            if (db.queue.video_id !== videoId || db.video.id !== videoId) return null;
            if (db.queue.tenant_id !== tenantId || db.video.tenant_id !== tenantId) return null;
            return {
                videoId,
                tenantId,
                queueStatus: db.queue.status as VideoJobRow['queueStatus'],
                videoStatus: db.video.status,
            };
        },
        acquireProcessingLock: registry.manager().acquire,
        claimJob: async () => {
            const row = db.queue;
            if (!row || row.status !== 'pending') return false;
            row.status = 'processing';
            return true;
        },
        settleJob: async (_videoId, outcome) => {
            const row = db.queue;
            if (!row) return;
            row.status = outcome.settled;
        },
        runProcessing: async (videoId, tenantId) => {
            runs.push(`${videoId}@${tenantId}`);
            db.video.status = 'ready';
        },
        workerId: 'worker-recovery',
    };

    const outcome = await runVideoProcessingJob(VIDEO, TENANT, recoveryDeps);
    assert.equal(outcome, 'processed');
    assert.equal(db.video.status, 'ready');
    assert.equal(db.queue?.status, 'completed');

    // 3. a later sweep sees the settled row and never re-processes.
    const replay = await runVideoProcessingJob(VIDEO, TENANT, recoveryDeps);
    assert.equal(replay, 'already_settled');
    assert.deepEqual(runs, [`${VIDEO}@${TENANT}`], 'the processor ran exactly once across the crash');
});

test('e2e: a failed enqueue rolls the claim back — the upload stays retryable, nothing is queued', async () => {
    const db: ComposeDb = {
        video: { id: VIDEO, tenant_id: TENANT, uploaded_by: 'teacher-1', status: 'uploading' },
        queue: null,
    };
    await assert.rejects(
        () => claimAndEnqueueOnConnection(composeConnection(db, true))(
            uploadSession(),
            { id: 'teacher-1', tenantId: TENANT },
        ),
        /simulated enqueue failure/,
    );
    assert.equal(db.video.status, 'uploading', 'the rolled-back claim leaves the session retryable');
    assert.equal(db.queue, null, 'no queue row survives a failed enqueue');
});

// ---------------------------------------------------------------------------
// F. Startup unification: one consumer, no duplicate recovery paths
// ---------------------------------------------------------------------------

test('startup: the old reset-and-reprocess startup path is gone from the server', () => {
    // The removed block reset 'processing' -> 'uploading' after a fixed delay
    // and called the processor outside every lock; recovery now flows only
    // through the queue consumer and the named lock decides what survives.
    assert.doesNotMatch(indexSource, /processVideo\(/);
    assert.doesNotMatch(indexSource, /status = 'uploading'/);
    assert.doesNotMatch(indexSource, /INTERVAL 10 MINUTE/);
});

test('startup: exactly one production invocation site of the processor exists, as the run dependency', () => {
    // Every route starts work through startVideoProcessing -> the protected
    // run; only the run deps may invoke the processor itself.
    const invocations = videos.match(/processVideo\(/g) ?? [];
    assert.equal(invocations.length, 1, 'the processor is invoked from exactly one production site');
    assert.match(videos, /runProcessing: \(videoId, tenantId\) => processVideo\(videoId, tenantId\)/);
});

test('startup: the unified consumer is the single recovery entry in index.ts', () => {
    const boot = indexSource.slice(
        indexSource.indexOf('const startServer'),
        indexSource.indexOf("server.on('error'"),
    );
    assert.match(boot, /scheduleVideoQueueConsumer\(\)/);
    assert.match(boot, /videoQueueConsumer\.start\(\)/);
    assert.doesNotMatch(boot, /startVideoQueueReconciliation\(\)/, 'startup uses the consumer, not a one-shot sweep');
});

// ---------------------------------------------------------------------------
// G. Existing upload size/authority contract (compact regression set)
// ---------------------------------------------------------------------------

const uploadSession = (over: Partial<{
    id: string;
    tenant_id: string | null;
    course_id: string;
    uploaded_by: string;
    original_key: string | null;
    file_size_bytes: number | null;
    status: string;
    created_at: Date;
    delivery_provider: string | null;
}> = {}) => ({
    id: VIDEO,
    course_id: 'course-1',
    tenant_id: TENANT,
    uploaded_by: 'teacher-1',
    original_key: `originals/${VIDEO}.mp4`,
    file_size_bytes: 2048,
    status: 'uploading',
    created_at: new Date('2026-10-15T10:00:00.000Z'),
    delivery_provider: 'minio',
    ...over,
});

test('upload contract: authorized exact-size transfers pass; expired/oversized/undersized/invalid are denied', () => {
    const now = new Date('2026-10-15T10:30:00.000Z');
    const base = { now, maxSizeBytes: 5000 * 1024 * 1024, ttlMinutes: DEFAULT_UPLOAD_SESSION_TTL_MINUTES, contentLengthHeader: undefined as string | undefined };

    assert.equal(evaluateUploadContentRequest(uploadSession(), { ...base, contentTypeHeader: 'video/mp4', contentLengthHeader: '2048' }).outcome, 'allowed');
    assert.equal(evaluateUploadContentRequest(uploadSession(), { ...base, contentTypeHeader: 'video/mp4', contentLengthHeader: '99999999' }).outcome, 'too_large');
    assert.equal(evaluateUploadContentRequest(uploadSession({ file_size_bytes: null }), { ...base, contentTypeHeader: 'video/mp4' }).outcome, 'invalid_size');
    assert.equal(evaluateUploadContentRequest(uploadSession(), { ...base, contentTypeHeader: 'video/mp4', contentLengthHeader: '2048', now: new Date('2026-10-16T10:30:00.000Z') }).outcome, 'expired');
    assert.equal(evaluateUploadContentRequest(uploadSession(), { ...base, contentTypeHeader: 'application/zip', contentLengthHeader: '2048' }).outcome, 'unsupported_type');
    assert.equal(evaluateUploadContentRequest(uploadSession({ original_key: 'forged/other.mp4' }), { ...base, contentTypeHeader: 'video/mp4', contentLengthHeader: '2048' }).outcome, 'invalid_key');
});

test('upload contract: completion requires the exact stored size under the server-derived key', () => {
    const stored = { size: 2048 };
    assert.equal(evaluateUploadCompletion(uploadSession(), stored).outcome, 'allowed');
    assert.equal(evaluateUploadCompletion(uploadSession(), null).outcome, 'object_missing');
    assert.equal(evaluateUploadCompletion(uploadSession(), { size: 1024 }).outcome, 'size_mismatch');
    assert.equal(evaluateUploadCompletion(uploadSession({ original_key: null }), stored).outcome, 'invalid_key');
});

// ---------------------------------------------------------------------------
// H. Lock manager deny path + shutdown lifecycle
// (The shutdown tests come LAST on purpose: the shutdown flag is
//  module-global and must not affect any test above.)
// ---------------------------------------------------------------------------

test('lock manager: a denied acquisition returns null and releases the healthy connection (never destroys)', async () => {
    const registry = new NamedLockRegistry();
    const held = registry.manager();
    const acquired = await held.acquire(TENANT, VIDEO);
    assert.ok(acquired, 'the first process acquires');

    // A second, independent manager over a FRESH connection is denied by the
    // registry — the connection holds nothing and is released, not destroyed.
    const contender = createSqlUploadLockManager({
        acquireConnection: async () => toUploadLockConnection(registry.connection()),
    });
    const denied = await contender.acquire(TENANT, VIDEO);
    const connection = registry.connections[registry.connections.length - 1]!;
    assert.equal(denied, null, 'a contended lock is denied, never queued');
    assert.equal(connection.released, true, 'the denied connection holds nothing and is released');
    assert.equal(connection.destroyed, false);

    await acquired!.release();
});

test('shutdown: the flag blocks new runs and reports itself', () => {
    assert.equal(isVideoProcessingShutdown(), false);
    requestVideoProcessingShutdown();
    assert.equal(isVideoProcessingShutdown(), true);
});

test('shutdown: during shutdown the consumer sweep is a no-op that never touches the queue', async () => {
    let sweepCalls = 0;
    const consumer = scheduleVideoQueueConsumer({
        intervalMs: 25,
        sweep: async () => { sweepCalls++; return { requeued: [], loadFailed: false }; },
    });
    const result = await consumer.sweep();
    assert.deepEqual(result, { requeued: [], loadFailed: false });
    assert.equal(sweepCalls, 0, 'no queue work starts once shutdown is requested');
    consumer.stop();
});

test('shutdown: the reconciliation sweep stops instead of launching runs while shutting down', async () => {
    let starterCalls = 0;
    const result = await reconcileVideoProcessingQueue({
        loadPendingJobs: async () => [
            { videoId: 'video-1', tenantId: TENANT },
            { videoId: 'video-2', tenantId: TENANT },
        ],
        isProcessing: () => false,
        startProcessing: () => {
            starterCalls++;
            return 'shutting_down';
        },
    });
    assert.equal(starterCalls, 1, 'the sweep stops at the first shutdown signal');
    assert.deepEqual(result.requeued, []);
});
