/**
 * M1 upload contract regressions (hermetic: no DB, no MinIO, no network, no
 * real env keys, no Docker).
 *
 * Exercises the private upload contract's REAL decision code in
 * server/src/routes/videos.ts against injected adapters:
 *  - evaluateUploadContentRequest  -> PUT  /upload/:videoId/content (byte transfer)
 *  - evaluateUploadCompletion     -> POST /upload/complete (finalization)
 *  - createSqlUploadSessionReader -> the scoped session load (tenant/creator)
 *  - evaluateCourseUploadPolicy   -> POST /upload/init (allocation authority)
 *  - buildUploadInitContract      -> the contract handed to the browser
 *  - runUploadByteTransfer        -> the serialized transfer orchestration
 *  - runUploadCompletion          -> the serialized finalization orchestration
 *  - recheckUploadAuthority       -> live TTL + course authority re-check
 *  - createSqlUploadLockManager   -> cross-process MySQL named-lock serialization
 *  - claimAndEnqueueOnConnection  -> the single-transaction claim + enqueue
 *
 * plus the MinIO service guard in server/src/services/minio.ts:
 *  - guardUploadStream / createObjectStreamUploader / putObjectStream
 *
 * Required scenarios: authorized byte transfer, expired session, unsupported
 * type, oversized/truncated transfer, tampered object key, missing object,
 * size mismatch, replay after claim, wrong tenant, wrong creator, the
 * no-storage-URL contract shape, and the corrective follow-up scenarios:
 * PUT-vs-PUT, PUT-vs-complete, late PUT after commit, enqueue-failure
 * rollback + retry, permission revoked before bytes and at completion,
 * expired completion, disconnected/truncated/oversized streams, duplication.
 *
 * Test limits (explicit):
 *  - Hermetic only: fixtures are injected adapters and fake rows; no MySQL,
 *    MinIO, Docker, network, or real env key is touched. The MinIO client
 *    import below only satisfies the route module's import-time construction
 *    and never connects.
 *  - The HTTP layer is not exercised (no supertest in the repo): the route
 *    handlers delegate every decision to the exported pure functions and
 *    injected readers above, and static wiring scans assert the delegation.
 *  - The SQL adapter section drives the REAL createSqlUploadSessionReader
 *    over a recording executor that MIRRORS the emitted SQL's WHERE
 *    semantics; it proves the predicates, not a MySQL engine.
 *  - The fake transaction connection mirrors the emitted SQL semantics and
 *    models BEGIN/COMMIT/ROLLBACK with snapshot restore; it proves the
 *    orchestration's transaction discipline, not a MySQL engine.
 *  - The fake cross-process lock registry arbitrates the PRODUCTION
 *    uploadLockName values; real cross-process exclusion is MySQL
 *    GET_LOCK's job (live MySQL verification remains pending by design).
 *  - The fake put client mirrors the audited installed SDK's single-part
 *    drain behavior (readAsBuffer semantics); live MinIO/edge byte-streaming
 *    validation remains pending by design of the task acceptance.
 *  - Isolation of module import: no .env exists on disk (verified), so
 *    db.ts's dotenv.config() is a no-op; MINIO_* dummy keys are set before
 *    the route module is required and the pool is never opened.
 */
import { test } from 'node:test';
import { quietConsole, restoreConsole } from './helpers/quiet-console';
import assert from 'node:assert';

test.beforeEach(quietConsole);
test.afterEach(restoreConsole);
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'stream';
import type {
    CourseUploadPolicyReader,
    UploadSessionRow,
    UploadTransferDeps,
    UploadCompletionDeps,
    UploadLockManager,
    UploadLockConnection,
    UploadPrincipal,
} from '../src/routes/videos';
import type { PutObjectClient } from '../src/services/minio';

process.env.MINIO_ACCESS_KEY ??= 'test-access-key';
process.env.MINIO_SECRET_KEY ??= 'test-secret-key';

const {
    evaluateUploadContentRequest,
    evaluateUploadCompletion,
    createSqlUploadSessionReader,
    buildUploadInitContract,
    uploadContentPath,
    uploadObjectKey,
    normalizeUploadExtension,
    isResourceBoundUploadKey,
    resolveUploadContentType,
    evaluateCourseUploadPolicy,
    UPLOAD_ALLOWED_EXTENSIONS,
    UPLOAD_ALLOWED_CONTENT_TYPES,
    DEFAULT_UPLOAD_SESSION_TTL_MINUTES,
    runUploadByteTransfer,
    runUploadCompletion,
    recheckUploadAuthority,
    createSqlUploadLockManager,
    uploadLockName,
    UPLOAD_LOCK_TIMEOUT_SECONDS,
    claimAndEnqueueOnConnection,
    createUploadLockManagerFromPool,
    reconcileVideoProcessingQueue,
    createPendingVideoJobLoader,
    UPLOAD_LOCK_POOL_SIZE,
    getUploadLockPool,
    PROCESSING_LOCK_POOL_SIZE,
    DEFAULT_PROCESSING_LEASE_MINUTES,
    DEFAULT_VIDEO_QUEUE_BATCH_SIZE,
} = require('../src/routes/videos') as typeof import('../src/routes/videos');

const {
    guardUploadStream,
    createObjectStreamUploader,
    UploadStreamSizeError,
} = require('../src/services/minio') as typeof import('../src/services/minio');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CREATED_AT = new Date('2026-10-14T10:00:00.000Z');

const sessionRow = (over: Partial<UploadSessionRow> & { id: string }): UploadSessionRow => ({
    course_id: 'course-1',
    tenant_id: 'tenant-1',
    uploaded_by: 'teacher-1',
    original_key: `originals/${over.id}.mp4`,
    file_size_bytes: 2048,
    status: 'uploading',
    created_at: CREATED_AT,
    delivery_provider: 'minio',
    ...over,
});

const contentInput = (over: Partial<Parameters<typeof evaluateUploadContentRequest>[1]> = {}) => ({
    contentTypeHeader: 'video/mp4',
    contentLengthHeader: '2048',
    now: new Date('2026-10-14T10:30:00.000Z'),
    maxSizeBytes: 5000 * 1024 * 1024,
    ttlMinutes: DEFAULT_UPLOAD_SESSION_TTL_MINUTES,
    ...over,
});

// ---------------------------------------------------------------------------
// Serialization / transaction / stream-guard harnesses (injected adapters)
// ---------------------------------------------------------------------------

const principal: UploadPrincipal = { id: 'teacher-1', tenantId: 'tenant-1' };
const transferHeaders = { contentType: 'video/mp4', contentLength: '2048' };
const transferNow = new Date('2026-10-14T10:30:00.000Z');

/** A Readable that emits exactly `size` bytes in `chunkSize` chunks. */
const byteStream = (size: number, chunkSize = 1024): Readable => {
    let sent = 0;
    return Readable.from((async function* () {
        while (sent < size) {
            const take = Math.min(chunkSize, size - sent);
            sent += take;
            yield Buffer.alloc(take, 1);
        }
    })());
};

/** A Readable that emits `chunks` chunks and then stays open (for aborts). */
const slowStream = (chunks: number, chunkSize = 1024): Readable => {
    let sent = 0;
    const stream = new Readable({ read() {} });
    const timer = setInterval(() => {
        if (sent < chunks) {
            sent += 1;
            stream.push(Buffer.alloc(chunkSize, 1));
        } else {
            clearInterval(timer);
        }
    }, 2);
    stream.on('close', () => clearInterval(timer));
    return stream;
};

/**
 * A put client that mirrors the audited installed SDK single-part boundary:
 * the stream is fully drained and the ACTUAL drained byte count is what would
 * be stored (mirrors readAsBuffer + Content-Length: buf.length semantics).
 */
const fakePutClient = (options: { failAfterDrain?: Error; removeError?: Error } = {}) => {
    const puts: { bucket: string; objectKey: string; size: number }[] = [];
    const removals: string[] = [];
    let drained = 0;
    const client: PutObjectClient & {
        puts: typeof puts;
        removals: typeof removals;
        drained: () => number;
    } = {
        puts,
        removals,
        drained: () => drained,
        putObject: async (bucket, objectKey, stream, size) => {
            puts.push({ bucket, objectKey, size });
            for await (const chunk of stream) drained += (chunk as Buffer).length;
            if (options.failAfterDrain) throw options.failAfterDrain;
            return {};
        },
        removeObject: async (_bucket, objectKey) => {
            removals.push(objectKey);
            if (options.removeError) throw options.removeError;
            return {};
        },
    };
    return client;
};

/**
 * Cross-"process" lock arbitration over the PRODUCTION uploadLockName values:
 * a shared holder registry models MySQL's per-connection GET_LOCK exclusion
 * (the lock itself is the database's job; live MySQL stays pending).
 */
const createFakeLockRegistry = (timeoutMs = 25) => {
    const holders = new Map<string, string>();
    return {
        holders,
        manager: (label: string, makeConnection: () => UploadLockConnection): UploadLockManager => ({
            acquire: async (tenantId: string, videoId: string) => {
                const name = uploadLockName(tenantId, videoId);
                const connection = makeConnection();
                const deadline = Date.now() + timeoutMs;
                for (;;) {
                    if (!holders.has(name)) {
                        holders.set(name, label);
                        return {
                            connection,
                            release: async () => {
                                if (holders.get(name) === label) holders.delete(name);
                                await connection.release();
                            },
                        };
                    }
                    if (Date.now() >= deadline) {
                        await connection.release(); // a denied caller leaks no connection
                        return null;
                    }
                    await new Promise((resolve) => setTimeout(resolve, 2));
                }
            },
        }),
    };
};

const recordingConnection = (): UploadLockConnection & { statements: string[]; released: boolean } => {
    const statements: string[] = [];
    const connection = {
        statements,
        released: false,
        query: async <T>(sql: string): Promise<T[]> => {
            statements.push(sql);
            return [] as T[];
        },
        execute: async () => ({ affectedRows: 0 }),
        beginTransaction: async () => {},
        commit: async () => {},
        rollback: async () => {},
        release: async () => {
            connection.released = true;
        },
    };
    return connection;
};

/**
 * A dedicated-connection stand-in that mirrors the emitted SQL semantics and
 * models BEGIN/COMMIT/ROLLBACK with snapshot restore — it proves the
 * orchestration's transaction discipline, not a MySQL engine.
 */
const fakeTxConnection = (state: {
    row: UploadSessionRow;
    events: string[];
    queue: { video_id: string; tenant_id: string }[];
    failInsert?: boolean;
    failRollback?: boolean;
}): UploadLockConnection => {
    let inTx = false;
    let snapshot: string | null = null;
    return {
        query: async <T>(sql: string): Promise<T[]> => {
            state.events.push(sql);
            return [] as T[];
        },
        execute: async (sql: string, params: unknown[] = []) => {
            state.events.push(sql);
            if (/UPDATE videos SET status = 'processing'/.test(sql)) {
                const [id, tenantId, uploadedBy] = params as string[];
                if (!inTx) throw new Error('claim executed outside a transaction');
                const row = state.row;
                if (
                    id !== row.id ||
                    tenantId !== row.tenant_id ||
                    uploadedBy !== row.uploaded_by ||
                    row.status !== 'uploading'
                ) {
                    return { affectedRows: 0 };
                }
                row.status = 'processing';
                return { affectedRows: 1 };
            }
            if (/INSERT INTO video_processing_queue/.test(sql)) {
                if (state.failInsert) throw new Error('simulated enqueue failure');
                const [, videoId, tenantId] = params as string[];
                state.queue.push({ video_id: videoId, tenant_id: tenantId });
                return { affectedRows: 1 };
            }
            throw new Error(`unexpected statement in the fake connection: ${sql}`);
        },
        beginTransaction: async () => {
            state.events.push('BEGIN');
            inTx = true;
            snapshot = state.row.status;
        },
        commit: async () => {
            state.events.push('COMMIT');
            inTx = false;
            snapshot = null;
        },
        rollback: async () => {
            if (state.failRollback) throw new Error('simulated rollback failure');
            state.events.push('ROLLBACK');
            inTx = false;
            state.row.status = snapshot ?? state.row.status;
            snapshot = null;
        },
        release: async () => {
            state.events.push('RELEASE CONNECTION');
        },
    };
};

const makeCompletionState = (row: UploadSessionRow = sessionRow({ id: 'video-1' })) => ({
    row,
    events: [] as string[],
    queue: [] as { video_id: string; tenant_id: string }[],
});

const completionHarness = (options: {
    row?: UploadSessionRow;
    state?: ReturnType<typeof makeCompletionState>;
    registry?: ReturnType<typeof createFakeLockRegistry>;
    authority?: 'allowed' | 'expired' | 'forbidden';
    stat?: { size: number } | null;
    failInsert?: boolean;
    failRollback?: boolean;
    label?: string;
} = {}) => {
    const state = options.state ?? makeCompletionState(options.row ?? sessionRow({ id: 'video-1' }));
    const registry = options.registry ?? createFakeLockRegistry(25);
    const statCalls: string[] = [];
    const started: { videoId: string; tenantId: string }[] = [];
    const manager = registry.manager(options.label ?? 'worker-a', () =>
        fakeTxConnection({
            row: state.row,
            events: state.events,
            queue: state.queue,
            failInsert: options.failInsert,
            failRollback: options.failRollback,
        }));
    const deps: UploadCompletionDeps = {
        loadInProgressUpload: async (videoId, userId, tenantId) => {
            state.events.push('load');
            const row = state.row;
            return row.status === 'uploading' && row.id === videoId && row.uploaded_by === userId && row.tenant_id === tenantId
                ? { ...row }
                : null;
        },
        acquireUploadLock: manager.acquire,
        statOriginal: async (objectKey) => {
            statCalls.push(objectKey);
            return options.stat === undefined ? { size: state.row.file_size_bytes as number } : options.stat;
        },
        recheckAuthority: async () => options.authority ?? 'allowed',
        claimAndEnqueue: claimAndEnqueueOnConnection,
        startProcessing: (videoId, tenantId) => {
            state.events.push('startProcessing');
            started.push({ videoId, tenantId });
        },
    };
    return { deps, state, statCalls, started, registry };
};

const transferHarness = (options: {
    row?: UploadSessionRow;
    registry?: ReturnType<typeof createFakeLockRegistry>;
    authority?: 'allowed' | 'expired' | 'forbidden';
    transfer?: { barrier?: Promise<void>; fail?: Error };
    label?: string;
} = {}) => {
    const row = options.row ?? sessionRow({ id: 'video-1' });
    const transfers: { objectKey: string; sizeBytes: number; contentType: string }[] = [];
    const registry = options.registry ?? createFakeLockRegistry(25);
    const manager = registry.manager(options.label ?? 'worker-a', () => recordingConnection());
    const deps: UploadTransferDeps = {
        loadInProgressUpload: async (videoId, userId, tenantId) =>
            row.status === 'uploading' && row.id === videoId && row.uploaded_by === userId && row.tenant_id === tenantId
                ? { ...row }
                : null,
        acquireUploadLock: manager.acquire,
        recheckAuthority: async () => options.authority ?? 'allowed',
        transferBytes: async (objectKey, stream, sizeBytes, contentType) => {
            transfers.push({ objectKey, sizeBytes, contentType });
            if (options.transfer?.barrier) await options.transfer.barrier;
            if (options.transfer?.fail) throw options.transfer.fail;
            for await (const _chunk of stream) { /* mirror the SDK drain */ }
        },
    };
    return { deps, row, transfers, registry };
};

// ---------------------------------------------------------------------------
// PUT /upload/:videoId/content — byte transfer authorization
// ---------------------------------------------------------------------------

test('content: authorized creator may stream bytes to the server-derived key', () => {
    const decision = evaluateUploadContentRequest(sessionRow({ id: 'video-1' }), contentInput());
    assert.deepEqual(decision, {
        outcome: 'allowed',
        objectKey: 'originals/video-1.mp4',
        contentType: 'video/mp4',
        sizeBytes: 2048,
    });
});

test('content: undeclared browser type falls back to the server-derived extension', () => {
    const decision = evaluateUploadContentRequest(
        sessionRow({ id: 'video-1', original_key: 'originals/video-1.mkv' }),
        contentInput({ contentTypeHeader: undefined }),
    );
    assert.equal(decision.outcome, 'allowed');
    if (decision.outcome !== 'allowed') return;
    assert.equal(decision.contentType, 'video/x-matroska');
});

test('content: missing content-length falls back to the declared size', () => {
    const decision = evaluateUploadContentRequest(sessionRow({ id: 'video-1' }), contentInput({ contentLengthHeader: undefined }));
    assert.equal(decision.outcome, 'allowed');
    if (decision.outcome !== 'allowed') return;
    assert.equal(decision.sizeBytes, 2048);
});

test('content: session older than the TTL is expired', () => {
    const decision = evaluateUploadContentRequest(
        sessionRow({ id: 'video-1' }),
        contentInput({ now: new Date('2026-10-14T11:01:00.000Z') }),
    );
    assert.equal(decision.outcome, 'expired');
});

test('content: session exactly at the TTL boundary is still valid', () => {
    const decision = evaluateUploadContentRequest(
        sessionRow({ id: 'video-1' }),
        contentInput({ now: new Date('2026-10-14T11:00:00.000Z') }),
    );
    assert.equal(decision.outcome, 'allowed');
});

test('content: non-video content type is rejected', () => {
    assert.equal(
        evaluateUploadContentRequest(sessionRow({ id: 'video-1' }), contentInput({ contentTypeHeader: 'application/zip' })).outcome,
        'unsupported_type',
    );
    assert.equal(
        evaluateUploadContentRequest(sessionRow({ id: 'video-1' }), contentInput({ contentTypeHeader: 'text/html' })).outcome,
        'unsupported_type',
    );
});

test('content: content-type parameters and casing are tolerated, unknown ones are not', () => {
    const decision = evaluateUploadContentRequest(
        sessionRow({ id: 'video-1' }),
        contentInput({ contentTypeHeader: 'Video/MP4; charset=UTF-8' }),
    );
    assert.equal(decision.outcome, 'allowed');
    assert.equal(
        evaluateUploadContentRequest(sessionRow({ id: 'video-1' }), contentInput({ contentTypeHeader: 'video/avi' })).outcome,
        'unsupported_type',
    );
});

test('content: transfer larger than the declared size is rejected', () => {
    const decision = evaluateUploadContentRequest(sessionRow({ id: 'video-1' }), contentInput({ contentLengthHeader: '2049' }));
    assert.equal(decision.outcome, 'too_large');
});

test('content: transfer larger than the platform limit is rejected even within a stale declaration', () => {
    const decision = evaluateUploadContentRequest(
        sessionRow({ id: 'video-1', file_size_bytes: 10 * 1024 * 1024 }),
        contentInput({ contentLengthHeader: String(2 * 1024 * 1024), maxSizeBytes: 1024 * 1024 }),
    );
    assert.equal(decision.outcome, 'too_large');
});

test('content: zero or absent declared size denies the transfer', () => {
    assert.equal(evaluateUploadContentRequest(sessionRow({ id: 'video-1', file_size_bytes: 0 }), contentInput()).outcome, 'invalid_size');
    assert.equal(evaluateUploadContentRequest(sessionRow({ id: 'video-1', file_size_bytes: null }), contentInput()).outcome, 'invalid_size');
    assert.equal(evaluateUploadContentRequest(sessionRow({ id: 'video-1' }), contentInput({ contentLengthHeader: '0' })).outcome, 'invalid_size');
});

test('content: BIGINT-style string sizes are accepted', () => {
    const decision = evaluateUploadContentRequest(
        sessionRow({ id: 'video-1', file_size_bytes: '2048' }),
        contentInput({ contentLengthHeader: '2048' }),
    );
    assert.equal(decision.outcome, 'allowed');
});

test('content: a tampered or foreign object key denies the transfer', () => {
    assert.equal(evaluateUploadContentRequest(sessionRow({ id: 'video-1', original_key: null }), contentInput()).outcome, 'invalid_key');
    assert.equal(evaluateUploadContentRequest(sessionRow({ id: 'video-1', original_key: 'originals/video-2.mp4' }), contentInput()).outcome, 'invalid_key');
    assert.equal(evaluateUploadContentRequest(sessionRow({ id: 'video-1', original_key: 'hls/video-1.mp4' }), contentInput()).outcome, 'invalid_key');
    assert.equal(evaluateUploadContentRequest(sessionRow({ id: 'video-1', original_key: 'originals/video-1.mp4/evil' }), contentInput()).outcome, 'invalid_key');
    assert.equal(evaluateUploadContentRequest(sessionRow({ id: 'video-1', original_key: 'originals/video-1' }), contentInput()).outcome, 'invalid_key');
});

// ---------------------------------------------------------------------------
// POST /upload/complete — finalization verification
// ---------------------------------------------------------------------------

test('complete: stored object with the exact declared size is allowed', () => {
    assert.equal(evaluateUploadCompletion(sessionRow({ id: 'video-1' }), { size: 2048 }).outcome, 'allowed');
    assert.equal(evaluateUploadCompletion(sessionRow({ id: 'video-1', file_size_bytes: '4096' }), { size: '4096' }).outcome, 'allowed');
});

test('complete: missing object denies finalization before processing', () => {
    assert.equal(evaluateUploadCompletion(sessionRow({ id: 'video-1' }), null).outcome, 'object_missing');
});

test('complete: truncated or oversized stored object denies finalization', () => {
    assert.equal(evaluateUploadCompletion(sessionRow({ id: 'video-1' }), { size: 2047 }).outcome, 'size_mismatch');
    assert.equal(evaluateUploadCompletion(sessionRow({ id: 'video-1' }), { size: 4096 }).outcome, 'size_mismatch');
    assert.equal(evaluateUploadCompletion(sessionRow({ id: 'video-1' }), { size: 0 }).outcome, 'size_mismatch');
    assert.equal(evaluateUploadCompletion(sessionRow({ id: 'video-1' }), { size: '2049' }).outcome, 'size_mismatch');
});

test('complete: tampered object key denies finalization', () => {
    assert.equal(evaluateUploadCompletion(sessionRow({ id: 'video-1', original_key: 'originals/video-9.mp4' }), { size: 2048 }).outcome, 'invalid_key');
    assert.equal(evaluateUploadCompletion(sessionRow({ id: 'video-1', original_key: null }), { size: 2048 }).outcome, 'invalid_key');
});

// ---------------------------------------------------------------------------
// Scoped session load — the REAL createSqlUploadSessionReader over a
// recording executor mirroring the emitted SQL's WHERE semantics
// ---------------------------------------------------------------------------

interface SessionSqlRow extends UploadSessionRow { }

const sessionSqlExecutor = (rows: SessionSqlRow[]) => {
    const calls: string[] = [];
    const queryOne = async <T>(sql: string, params: unknown[] = []): Promise<T | null> => {
        const norm = sql.replace(/\s+/g, ' ').trim();
        calls.push(norm);
        if (!/FROM videos/.test(norm)) return null;
        if (!/tenant_id = \?/.test(norm) || !/uploaded_by = \?/.test(norm) || !/status = 'uploading'/.test(norm)) {
            throw new Error(`Session load lost its scope predicates: ${norm}`);
        }
        const [videoId, tenantId, userId] = params as string[];
        const row = rows.find((r) =>
            r.id === videoId && r.tenant_id === tenantId && r.uploaded_by === userId && r.status === 'uploading');
        return (row ?? null) as T | null;
    };
    return { queryOne, calls };
};

const sharedRow = sessionRow({ id: 'video-1' });

test('session load: the right creator in the right tenant loads the in-progress row', async () => {
    const { queryOne, calls } = sessionSqlExecutor([sharedRow]);
    const reader = createSqlUploadSessionReader({ queryOne });
    const row = await reader.loadInProgressUpload('video-1', 'teacher-1', 'tenant-1');
    assert.equal(row?.id, 'video-1');
    assert.ok(calls[0]?.includes("status = 'uploading'"));
});

test('session load: another tenant never loads the session (denied before storage)', async () => {
    const reader = createSqlUploadSessionReader({ queryOne: sessionSqlExecutor([sharedRow]).queryOne });
    assert.equal(await reader.loadInProgressUpload('video-1', 'teacher-1', 'tenant-2'), null);
});

test('session load: another creator never loads the session', async () => {
    const reader = createSqlUploadSessionReader({ queryOne: sessionSqlExecutor([sharedRow]).queryOne });
    assert.equal(await reader.loadInProgressUpload('video-1', 'teacher-2', 'tenant-1'), null);
});

test('session load: a claimed (no longer uploading) session never loads — replay is denied', async () => {
    const claimed = sessionSqlExecutor([sessionRow({ id: 'video-1', status: 'processing' })]);
    const reader = createSqlUploadSessionReader({ queryOne: claimed.queryOne });
    assert.equal(await reader.loadInProgressUpload('video-1', 'teacher-1', 'tenant-1'), null);
});

test('session load: an unknown video id loads nothing', async () => {
    const reader = createSqlUploadSessionReader({ queryOne: sessionSqlExecutor([sharedRow]).queryOne });
    assert.equal(await reader.loadInProgressUpload('video-404', 'teacher-1', 'tenant-1'), null);
});

// ---------------------------------------------------------------------------
// POST /upload/init — allocation authority (the accepted policy, re-proven
// against the upload contract)
// ---------------------------------------------------------------------------

const uploadPolicyReader = (fixtures: {
    course?: { id: string; tenant_id: string | null; instructor_id: string | null } | null;
    membership?: { role_key: string } | null;
    owner?: { id: string } | null;
}): CourseUploadPolicyReader => ({
    loadCourse: async () => fixtures.course ?? null,
    loadActiveTeachingMembership: async () => fixtures.membership ?? null,
    loadTenantOwner: async () => fixtures.owner ?? null,
});

const ownedCourse = { id: 'course-1', tenant_id: 'tenant-1', instructor_id: 'teacher-1' };

test('init policy: assigned course instructor may allocate', async () => {
    assert.equal(await evaluateCourseUploadPolicy({ id: 'teacher-1' }, 'course-1',
        uploadPolicyReader({ course: ownedCourse, membership: { role_key: 'instructor' } })), 'allowed');
});

test('init policy: verified tenant owner may allocate without a course assignment', async () => {
    assert.equal(await evaluateCourseUploadPolicy({ id: 'owner-1' }, 'course-1',
        uploadPolicyReader({
            course: { id: 'course-1', tenant_id: 'tenant-1', instructor_id: 'teacher-1' },
            membership: { role_key: 'owner' },
            owner: { id: 'owner-1' },
        })), 'allowed');
});

test('init policy: a mere teaching member without ownership is denied', async () => {
    assert.equal(await evaluateCourseUploadPolicy({ id: 'teacher-2' }, 'course-1',
        uploadPolicyReader({ course: ownedCourse, membership: { role_key: 'instructor' } })), 'forbidden');
});

test('init policy: a revoked (non-active) membership is denied', async () => {
    assert.equal(await evaluateCourseUploadPolicy({ id: 'teacher-1' }, 'course-1',
        uploadPolicyReader({ course: ownedCourse, membership: null })), 'forbidden');
});

test('init policy: unknown course and tenant-less course never allocate', async () => {
    assert.equal(await evaluateCourseUploadPolicy({ id: 'teacher-1' }, 'course-x',
        uploadPolicyReader({ course: null })), 'course_not_found');
    assert.equal(await evaluateCourseUploadPolicy({ id: 'teacher-1' }, 'course-1',
        uploadPolicyReader({ course: { id: 'course-1', tenant_id: null, instructor_id: 'teacher-1' }, membership: { role_key: 'instructor' } })),
        'forbidden');
});

// ---------------------------------------------------------------------------
// Contract shape — no storage URL ever reaches the browser
// ---------------------------------------------------------------------------

test('contract: init returns the authenticated byte-transfer endpoint bound to the video', () => {
    const contract = buildUploadInitContract('video-1', 'originals/video-1.mp4', 60);
    assert.deepEqual(contract, {
        provider: 'minio',
        videoId: 'video-1',
        uploadUrl: '/videos/upload/video-1/content',
        uploadMethod: 'PUT',
        authenticated: true,
        objectKey: 'originals/video-1.mp4',
        expiresIn: 3600,
    });
    assert.equal(uploadContentPath('video-1'), '/videos/upload/video-1/content');
});

test('contract: the browser contract carries no storage URL, presigned URL, or chunk helper', () => {
    const contract = buildUploadInitContract('video-1', 'originals/video-1.mp4', 30);
    const serialized = JSON.stringify(contract);
    assert.doesNotMatch(serialized, /\/storage\//);
    assert.doesNotMatch(serialized, /presign/i);
    assert.doesNotMatch(serialized, /X-Amz|signature/i);
    assert.equal(!('chunkSize' in contract), true);
    assert.equal(contract.expiresIn, 1800);
});

test('contract: object keys are server-generated and bound to the video id', () => {
    assert.equal(uploadObjectKey('video-1', '.mp4'), 'originals/video-1.mp4');
    assert.equal(isResourceBoundUploadKey('video-1', uploadObjectKey('video-1', '.mkv')), true);
    assert.equal(isResourceBoundUploadKey('video-1', uploadObjectKey('video-2', '.mkv')), false);
});

test('contract: extensions are allowlisted deny-by-default', () => {
    assert.equal(normalizeUploadExtension('clip.mp4'), '.mp4');
    assert.equal(normalizeUploadExtension('CLIP.MP4'), '.mp4');
    assert.equal(normalizeUploadExtension('lesson.mov'), '.mov');
    assert.equal(normalizeUploadExtension('notes.txt'), null);
    assert.equal(normalizeUploadExtension(''), null);
    assert.equal(normalizeUploadExtension(undefined), null);
    assert.ok(UPLOAD_ALLOWED_EXTENSIONS.every((ext: string) => Object.prototype.hasOwnProperty.call({ '.mp4': 1, '.mov': 1, '.avi': 1, '.mkv': 1, '.webm': 1 }, ext)));
});

test('contract: content types resolve only from the allowlist or the server extension', () => {
    assert.equal(resolveUploadContentType('video/mp4', '.mp4'), 'video/mp4');
    assert.equal(resolveUploadContentType('video/mp4; charset=binary', '.mp4'), 'video/mp4');
    assert.equal(resolveUploadContentType('VIDEO/WEBM', '.mp4'), 'video/webm');
    assert.equal(resolveUploadContentType(undefined, '.avi'), 'video/x-msvideo');
    assert.equal(resolveUploadContentType(undefined, '.txt'), null);
    assert.equal(resolveUploadContentType('application/pdf', '.mp4'), null);
    assert.ok(UPLOAD_ALLOWED_CONTENT_TYPES.includes('video/x-matroska'));
});

// ---------------------------------------------------------------------------
// Stream guard + object-stream uploader (production minio.ts code)
// ---------------------------------------------------------------------------

test('stream guard: an exact-length stream passes through byte-for-byte', async () => {
    const guarded = guardUploadStream(byteStream(2048, 512), 2048);
    let received = 0;
    for await (const chunk of guarded) received += (chunk as Buffer).length;
    assert.equal(received, 2048);
});

test('stream guard: a short stream fails as truncated, never as complete', async () => {
    const guarded = guardUploadStream(byteStream(1024, 512), 2048);
    await assert.rejects(
        (async () => { for await (const _chunk of guarded) { /* drain */ } })(),
        (error: unknown) => {
            assert.ok(error instanceof UploadStreamSizeError);
            assert.equal(error.kind, 'truncated');
            assert.equal(error.received, 1024);
            assert.equal(error.expected, 2048);
            return true;
        },
    );
});

test('stream guard: an overlong stream is aborted at the declared boundary and the source is destroyed', async () => {
    const source = byteStream(4096, 512);
    const guarded = guardUploadStream(source, 2048);
    await assert.rejects(
        (async () => { for await (const _chunk of guarded) { /* drain */ } })(),
        (error: unknown) => {
            assert.ok(error instanceof UploadStreamSizeError);
            assert.equal(error.kind, 'overrun');
            assert.ok(error.received > error.expected);
            return true;
        },
    );
    assert.equal(source.destroyed, true);
});

test('stream guard: a client abort mid-transfer fails the guarded stream as aborted', async () => {
    const source = slowStream(50, 512);
    const guarded = guardUploadStream(source, 1_000_000);
    const drained = (async () => { for await (const _chunk of guarded) { /* drain */ } })();
    await new Promise((resolve) => setTimeout(resolve, 10));
    source.emit('aborted');
    await assert.rejects(drained, (error: unknown) => {
        assert.ok(error instanceof UploadStreamSizeError);
        assert.equal(error.kind, 'aborted');
        return true;
    });
});

test('stream guard: a socket error mid-transfer propagates to the consumer', async () => {
    const source = slowStream(50, 512);
    const guarded = guardUploadStream(source, 1_000_000);
    const drained = (async () => { for await (const _chunk of guarded) { /* drain */ } })();
    await new Promise((resolve) => setTimeout(resolve, 10));
    source.destroy(new Error('socket hang up'));
    await assert.rejects(drained, /socket hang up/);
});

test('uploader: an exact transfer stores once and never removes the object', async () => {
    const client = fakePutClient();
    const upload = createObjectStreamUploader(client);
    await upload('videos-original', 'originals/video-1.mp4', byteStream(2048, 1024), 2048, 'video/mp4');
    assert.equal(client.puts.length, 1);
    assert.equal(client.puts[0]!.size, 2048);
    assert.equal(client.puts[0]!.objectKey, 'originals/video-1.mp4');
    assert.deepEqual(client.removals, []);
});

test('uploader: a truncated transfer rejects and the partial object is removed', async () => {
    const client = fakePutClient();
    const upload = createObjectStreamUploader(client);
    await assert.rejects(
        () => upload('videos-original', 'originals/video-1.mp4', byteStream(1024, 512), 2048, 'video/mp4'),
        UploadStreamSizeError,
    );
    assert.deepEqual(client.removals, ['originals/video-1.mp4']);
});

test('uploader: an overlong transfer rejects at the boundary and cleans up', async () => {
    const client = fakePutClient();
    const upload = createObjectStreamUploader(client);
    await assert.rejects(
        () => upload('videos-original', 'originals/video-1.mp4', byteStream(4096, 512), 2048, 'video/mp4'),
        UploadStreamSizeError,
    );
    assert.deepEqual(client.removals, ['originals/video-1.mp4']);
    // The guard stopped consuming the socket at the boundary — no unbounded buffering.
    assert.ok(client.drained() <= 2048 + 512);
});

test('uploader: an aborted transfer rejects and the partial object is removed', async () => {
    const client = fakePutClient();
    const upload = createObjectStreamUploader(client);
    const source = slowStream(50, 512);
    const promise = upload('videos-original', 'originals/video-1.mp4', source, 1_000_000, 'video/mp4');
    await new Promise((resolve) => setTimeout(resolve, 10));
    source.emit('aborted');
    await assert.rejects(promise, UploadStreamSizeError);
    assert.deepEqual(client.removals, ['originals/video-1.mp4']);
});

test('uploader: a mid-put storage failure removes the partial object', async () => {
    const client = fakePutClient({ failAfterDrain: new Error('storage rejected the put') });
    const upload = createObjectStreamUploader(client);
    await assert.rejects(
        () => upload('videos-original', 'originals/video-1.mp4', byteStream(2048, 1024), 2048, 'video/mp4'),
        /storage rejected the put/,
    );
    assert.deepEqual(client.removals, ['originals/video-1.mp4']);
});

test('uploader: a cleanup failure never masks the original transfer error', async () => {
    const client = fakePutClient({
        failAfterDrain: new Error('storage rejected the put'),
        removeError: new Error('cleanup exploded'),
    });
    const upload = createObjectStreamUploader(client);
    await assert.rejects(
        () => upload('videos-original', 'originals/video-1.mp4', byteStream(2048, 1024), 2048, 'video/mp4'),
        /storage rejected the put/,
    );
    assert.deepEqual(client.removals, ['originals/video-1.mp4']);
});

// ---------------------------------------------------------------------------
// Cross-process upload lock (production createSqlUploadLockManager)
// ---------------------------------------------------------------------------

test('upload lock: the name is deterministic, tenant/video-scoped, and MySQL-length safe', () => {
    assert.equal(uploadLockName('tenant-1', 'video-1'), uploadLockName('tenant-1', 'video-1'));
    assert.notEqual(uploadLockName('tenant-1', 'video-1'), uploadLockName('tenant-2', 'video-1'));
    assert.notEqual(uploadLockName('tenant-1', 'video-1'), uploadLockName('tenant-1', 'video-2'));
    for (const name of [uploadLockName('tenant-1', 'video-1'), uploadLockName('tenant-2', 'video-9')]) {
        assert.ok(name.length <= 64, `lock name too long for MySQL: ${name}`);
    }
});

test('upload lock: the production manager takes the named lock on a dedicated connection and releases it', async () => {
    const held = new Set<string>();
    const manager = createSqlUploadLockManager({
        acquireConnection: async () => {
            const state = { released: false };
            return {
                query: async <T>(sql: string, params?: unknown[]): Promise<T[]> => {
                    if (/GET_LOCK/.test(sql)) {
                        const [name, timeout] = params as [string, number];
                        if (held.has(name)) return [{ acquired: 0 }] as T[];
                        held.add(name);
                        return [{ acquired: 1 }] as T[];
                    }
                    if (/RELEASE_LOCK/.test(sql)) {
                        held.delete((params as string[])[0] as string);
                        return [{ released: 1 }] as T[];
                    }
                    return [] as T[];
                },
                execute: async () => ({ affectedRows: 0 }),
                beginTransaction: async () => {},
                commit: async () => {},
                rollback: async () => {},
                release: async () => {
                    state.released = true;
                },
            };
        },
    });

    const handle = await manager.acquire('tenant-1', 'video-1');
    assert.ok(handle);
    assert.equal(held.size, 1);
    await handle!.release();
    assert.equal(held.size, 0);
});

test('upload lock: a second connection is denied while the lock is held, and its connection is released', async () => {
    const held = new Set<string>();
    const connections: { released: boolean }[] = [];
    const manager = createSqlUploadLockManager({
        acquireConnection: async () => {
            const state = { released: false };
            connections.push(state);
            return {
                query: async <T>(sql: string, params?: unknown[]): Promise<T[]> => {
                    if (/GET_LOCK/.test(sql)) {
                        const [name] = params as [string, number];
                        if (held.has(name)) return [{ acquired: 0 }] as T[];
                        held.add(name);
                        return [{ acquired: 1 }] as T[];
                    }
                    if (/RELEASE_LOCK/.test(sql)) {
                        held.delete((params as string[])[0] as string);
                        return [{ released: 1 }] as T[];
                    }
                    return [] as T[];
                },
                execute: async () => ({ affectedRows: 0 }),
                beginTransaction: async () => {},
                commit: async () => {},
                rollback: async () => {},
                release: async () => {
                    state.released = true;
                },
            };
        },
    });

    const first = await manager.acquire('tenant-1', 'video-1');
    assert.ok(first);
    const second = await manager.acquire('tenant-1', 'video-1');
    assert.equal(second, null);
    assert.equal(connections.length, 2);
    assert.equal(connections[1]!.released, true); // the denied caller leaks no connection

    await first!.release();
    const third = await manager.acquire('tenant-1', 'video-1');
    assert.ok(third);
    await third!.release();
});

// ---------------------------------------------------------------------------
// Byte transfer orchestration (production runUploadByteTransfer)
// ---------------------------------------------------------------------------

test('transfer: an authorized creator streams to the server-derived key and the lock is released', async () => {
    const h = transferHarness();
    const outcome = await runUploadByteTransfer('video-1', principal, byteStream(2048, 1024), transferHeaders, transferNow, h.deps);
    assert.deepEqual(outcome, { outcome: 'stored', videoId: 'video-1', objectKey: 'originals/video-1.mp4', sizeBytes: 2048 });
    assert.deepEqual(h.transfers, [{ objectKey: 'originals/video-1.mp4', sizeBytes: 2048, contentType: 'video/mp4' }]);
    assert.equal(h.registry.holders.size, 0);
});

test('transfer: another creator never loads the session — no lock, no bytes', async () => {
    const h = transferHarness();
    const outcome = await runUploadByteTransfer('video-1', { id: 'stranger', tenantId: 'tenant-1' }, byteStream(2048), transferHeaders, transferNow, h.deps);
    assert.equal(outcome.outcome, 'not_found');
    assert.equal(h.transfers.length, 0);
    assert.equal(h.registry.holders.size, 0);
});

test('transfer: a second concurrent PUT is denied while the first holds the lock (PUT-vs-PUT)', async () => {
    const registry = createFakeLockRegistry(25);
    let releaseFirst!: () => void;
    const barrier = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const row = sessionRow({ id: 'video-1' });
    const first = transferHarness({ row, registry, label: 'worker-a', transfer: { barrier } });
    const second = transferHarness({ row, registry, label: 'worker-b' });

    const firstRun = runUploadByteTransfer('video-1', principal, byteStream(2048, 1024), transferHeaders, transferNow, first.deps);
    await new Promise((resolve) => setTimeout(resolve, 5)); // let the first PUT take the lock
    const secondOutcome = await runUploadByteTransfer('video-1', principal, byteStream(2048, 1024), transferHeaders, transferNow, second.deps);
    assert.equal(secondOutcome.outcome, 'busy');
    assert.deepEqual(second.transfers, []); // zero bytes written by the denied caller

    releaseFirst();
    const firstOutcome = await firstRun;
    assert.equal(firstOutcome.outcome, 'stored');
    assert.equal(first.transfers.length, 1);
    assert.equal(registry.holders.size, 0);
});

test('transfer: a late PUT after finalization is denied inside the lock before any byte', async () => {
    const h = transferHarness();
    const first = await runUploadByteTransfer('video-1', principal, byteStream(2048, 1024), transferHeaders, transferNow, h.deps);
    assert.equal(first.outcome, 'stored');

    h.row.status = 'processing'; // the completion committed in between
    const late = await runUploadByteTransfer('video-1', principal, byteStream(2048, 1024), transferHeaders, transferNow, h.deps);
    assert.equal(late.outcome, 'not_found');
    assert.equal(h.transfers.length, 1); // the late write never reached storage
});

test('transfer: a permission revoked after init denies before any byte', async () => {
    const h = transferHarness({ authority: 'forbidden' });
    const outcome = await runUploadByteTransfer('video-1', principal, byteStream(2048), transferHeaders, transferNow, h.deps);
    assert.equal(outcome.outcome, 'forbidden');
    assert.deepEqual(h.transfers, []);
    assert.equal(h.registry.holders.size, 0);
});

test('transfer: an expired session is denied before any byte (production TTL re-check)', async () => {
    const row = sessionRow({ id: 'video-1', created_at: new Date('2026-10-14T08:00:00.000Z') });
    const h = transferHarness({ row });
    const outcome = await runUploadByteTransfer(
        'video-1',
        principal,
        byteStream(2048),
        transferHeaders,
        new Date('2026-10-14T12:00:00.000Z'),
        {
            ...h.deps,
            recheckAuthority: (video, user, now) =>
                recheckUploadAuthority(video, user, now, uploadPolicyReader({ course: ownedCourse, membership: { role_key: 'instructor' } })),
        },
    );
    assert.equal(outcome.outcome, 'expired');
    assert.deepEqual(h.transfers, []);
});

test('transfer: a storage failure maps to a failed transfer and still releases the lock', async () => {
    const h = transferHarness({ transfer: { fail: new Error('minio exploded') } });
    const outcome = await runUploadByteTransfer('video-1', principal, byteStream(2048), transferHeaders, transferNow, h.deps);
    assert.equal(outcome.outcome, 'storage_failed');
    assert.equal(h.transfers.length, 1);
    assert.equal(h.registry.holders.size, 0);
});

test('transfer: a foreign object key is denied before the lock', async () => {
    const h = transferHarness({ row: sessionRow({ id: 'video-1', original_key: 'hls/video-1.mp4' }) });
    const outcome = await runUploadByteTransfer('video-1', principal, byteStream(2048), transferHeaders, transferNow, h.deps);
    assert.equal(outcome.outcome, 'invalid_key');
    assert.equal(h.registry.holders.size, 0);
});

// ---------------------------------------------------------------------------
// Finalization orchestration (production runUploadCompletion)
// ---------------------------------------------------------------------------

test('completion: claim and enqueue commit as one transaction, processing starts only after commit', async () => {
    const h = completionHarness();
    const outcome = await runUploadCompletion('video-1', principal, transferNow, h.deps);
    assert.equal(outcome.outcome, 'completed');

    const events = h.state.events;
    const beginAt = events.indexOf('BEGIN');
    const updateAt = events.findIndex((e) => e.startsWith('UPDATE videos'));
    const insertAt = events.findIndex((e) => e.startsWith('INSERT INTO video_processing_queue'));
    const commitAt = events.indexOf('COMMIT');
    const startAt = events.indexOf('startProcessing');
    const releaseAt = events.indexOf('RELEASE CONNECTION');
    for (const at of [beginAt, updateAt, insertAt, commitAt, startAt, releaseAt]) {
        assert.notEqual(at, -1, `missing event in ${JSON.stringify(events)}`);
    }
    assert.ok(beginAt < updateAt && updateAt < insertAt && insertAt < commitAt, 'one transaction, in order');
    assert.ok(commitAt < startAt, 'processing must start only after the commit');
    assert.ok(releaseAt < startAt, 'the lock is released before the background processing kickoff');
    assert.deepEqual(h.state.queue, [{ video_id: 'video-1', tenant_id: 'tenant-1' }]);
    assert.equal(h.state.row.status, 'processing');
    assert.deepEqual(h.started, [{ videoId: 'video-1', tenantId: 'tenant-1' }]);
});

test('completion: an enqueue failure rolls back — no processing without a job, and the retry succeeds', async () => {
    const state = makeCompletionState();
    const failing = completionHarness({ state, failInsert: true });
    const outcome = await runUploadCompletion('video-1', principal, transferNow, failing.deps);
    assert.equal(outcome.outcome, 'enqueue_failed');
    assert.ok(failing.state.events.includes('ROLLBACK'));
    assert.equal(state.row.status, 'uploading'); // rolled back: never 'processing' without a job
    assert.deepEqual(state.queue, []);
    assert.deepEqual(failing.started, []);
    assert.equal(failing.registry.holders.size, 0);

    const retry = completionHarness({ state });
    const retryOutcome = await runUploadCompletion('video-1', principal, transferNow, retry.deps);
    assert.equal(retryOutcome.outcome, 'completed');
    assert.deepEqual(state.queue, [{ video_id: 'video-1', tenant_id: 'tenant-1' }]);
    assert.equal(state.row.status, 'processing');
    assert.equal(retry.started.length, 1);
});

test('completion: a rollback failure still denies the claim and surfaces the failure', async () => {
    // Fake limit, stated plainly: when the rollback ITSELF fails, an in-memory
    // row cannot model MySQL's automatic rollback on a lost connection, so the
    // row stays mutated. The production guarantees asserted here are the ones
    // that hold regardless: no queue row, no processing start, lock released.
    const h = completionHarness({ failInsert: true, failRollback: true });
    const outcome = await runUploadCompletion('video-1', principal, transferNow, h.deps);
    assert.equal(outcome.outcome, 'enqueue_failed');
    assert.deepEqual(h.state.queue, []);
    assert.deepEqual(h.started, []);
    assert.equal(h.registry.holders.size, 0);
});

test('completion: a duplicate completion is denied — the queue keeps exactly one row', async () => {
    const state = makeCompletionState();
    const first = completionHarness({ state });
    assert.equal((await runUploadCompletion('video-1', principal, transferNow, first.deps)).outcome, 'completed');
    const second = completionHarness({ state });
    assert.equal((await runUploadCompletion('video-1', principal, transferNow, second.deps)).outcome, 'not_found');
    assert.deepEqual(state.queue, [{ video_id: 'video-1', tenant_id: 'tenant-1' }]);
    assert.deepEqual(second.started, []);
});

test('completion: a completion racing an in-flight transfer is denied, then succeeds after the transfer (PUT-vs-complete)', async () => {
    const registry = createFakeLockRegistry(30);
    const state = makeCompletionState();
    let releaseTransfer!: () => void;
    const barrier = new Promise<void>((resolve) => { releaseTransfer = resolve; });
    const t = transferHarness({ row: state.row, registry, label: 'worker-a', transfer: { barrier } });
    const c = completionHarness({ state, registry, label: 'worker-b' });

    const transferRun = runUploadByteTransfer('video-1', principal, byteStream(2048, 1024), transferHeaders, transferNow, t.deps);
    await new Promise((resolve) => setTimeout(resolve, 5)); // the PUT holds the lock
    const raced = await runUploadCompletion('video-1', principal, transferNow, c.deps);
    assert.equal(raced.outcome, 'busy');
    assert.ok(!c.state.events.some((e) => e.startsWith('UPDATE videos'))); // no claim while bytes are in flight

    releaseTransfer();
    assert.equal((await transferRun).outcome, 'stored');
    const after = await runUploadCompletion('video-1', principal, transferNow, completionHarness({ state, registry }).deps);
    assert.equal(after.outcome, 'completed');
});

test('completion: a permission revoked before the critical section denies without touching storage or the queue', async () => {
    const h = completionHarness({ authority: 'forbidden' });
    const outcome = await runUploadCompletion('video-1', principal, transferNow, h.deps);
    assert.equal(outcome.outcome, 'forbidden');
    assert.deepEqual(h.statCalls, []);
    assert.deepEqual(h.state.queue, []);
    assert.equal(h.state.row.status, 'uploading');
});

test('completion: an expired session denies inside the critical section (production TTL re-check)', async () => {
    const row = sessionRow({ id: 'video-1', created_at: new Date('2026-10-14T08:00:00.000Z') });
    const h = completionHarness({ row });
    const outcome = await runUploadCompletion(
        'video-1',
        principal,
        new Date('2026-10-14T12:00:00.000Z'),
        {
            ...h.deps,
            recheckAuthority: (video, user, now) =>
                recheckUploadAuthority(video, user, now, uploadPolicyReader({ course: ownedCourse, membership: { role_key: 'instructor' } })),
        },
    );
    assert.equal(outcome.outcome, 'expired');
    assert.deepEqual(h.statCalls, []);
    assert.deepEqual(h.state.queue, []);
});

test('completion: a missing or size-mismatched object denies the claim', async () => {
    const missing = completionHarness({ stat: null });
    assert.equal((await runUploadCompletion('video-1', principal, transferNow, missing.deps)).outcome, 'object_missing');
    const mismatched = completionHarness({ stat: { size: 2047 } });
    assert.equal((await runUploadCompletion('video-1', principal, transferNow, mismatched.deps)).outcome, 'size_mismatch');
    assert.deepEqual(mismatched.state.queue, []);
    assert.equal(mismatched.state.row.status, 'uploading');
});

test('completion: invalid requests and legacy managed videos are rejected up front', async () => {
    const h = completionHarness();
    assert.equal((await runUploadCompletion(undefined, principal, transferNow, h.deps)).outcome, 'invalid_request');
    assert.equal((await runUploadCompletion('', principal, transferNow, h.deps)).outcome, 'invalid_request');
    assert.equal((await runUploadCompletion(42, principal, transferNow, h.deps)).outcome, 'invalid_request');
    const legacy = completionHarness({ row: sessionRow({ id: 'video-1', delivery_provider: 'vdocipher' }) });
    assert.equal((await runUploadCompletion('video-1', principal, transferNow, legacy.deps)).outcome, 'legacy_managed');
});

test('completion: another creator never loads the session', async () => {
    const h = completionHarness();
    const outcome = await runUploadCompletion('video-1', { id: 'stranger', tenantId: 'tenant-1' }, transferNow, h.deps);
    assert.equal(outcome.outcome, 'not_found');
    assert.deepEqual(h.state.queue, []);
});

// ---------------------------------------------------------------------------
// Live re-authorization (production recheckUploadAuthority)
// ---------------------------------------------------------------------------

test('recheck: a current instructor-owner of the selected tenant is allowed', async () => {
    assert.equal(
        await recheckUploadAuthority(sessionRow({ id: 'video-1' }), principal, transferNow,
            uploadPolicyReader({ course: ownedCourse, membership: { role_key: 'instructor' } })),
        'allowed',
    );
});

test('recheck: a revoked membership forbids', async () => {
    assert.equal(
        await recheckUploadAuthority(sessionRow({ id: 'video-1' }), principal, transferNow,
            uploadPolicyReader({ course: ownedCourse, membership: null })),
        'forbidden',
    );
});

test('recheck: course/tenant drift with the selected workspace forbids', async () => {
    assert.equal(
        await recheckUploadAuthority(sessionRow({ id: 'video-1' }), principal, transferNow,
            uploadPolicyReader({ course: { id: 'course-1', tenant_id: 'tenant-2', instructor_id: 'teacher-1' }, membership: { role_key: 'instructor' } })),
        'forbidden',
    );
});

test('recheck: an unknown or tenant-less course forbids', async () => {
    assert.equal(
        await recheckUploadAuthority(sessionRow({ id: 'video-1' }), principal, transferNow,
            uploadPolicyReader({ course: null })),
        'forbidden',
    );
    assert.equal(
        await recheckUploadAuthority(sessionRow({ id: 'video-1' }), principal, transferNow,
            uploadPolicyReader({ course: { id: 'course-1', tenant_id: null, instructor_id: 'teacher-1' }, membership: { role_key: 'instructor' } })),
        'forbidden',
    );
});

// ---------------------------------------------------------------------------
// Static wiring regressions (the shipped sources must keep the contract)
// ---------------------------------------------------------------------------

const videos = readFileSync(join(__dirname, '..', 'src', 'routes', 'videos.ts'), 'utf8');
const minioService = readFileSync(join(__dirname, '..', 'src', 'services', 'minio.ts'), 'utf8');
const uploaderSource = readFileSync(join(__dirname, '..', '..', 'src', 'components', 'VideoUploader.tsx'), 'utf8');
const indexSource = readFileSync(join(__dirname, '..', 'src', 'index.ts'), 'utf8');

test('wiring: byte transfer is authenticated and delegates to the serialized orchestration', () => {
    const putHandler = videos.slice(
        videos.indexOf("router.put('/upload/:videoId/content'"),
        videos.indexOf("router.post('/upload/complete'"),
    );
    assert.match(putHandler, /router\.put\('\/upload\/:videoId\/content', authenticateToken/);
    assert.match(putHandler, /runUploadByteTransfer\(/);
    assert.match(putHandler, /uploadTransferDeps/);
});

test('wiring: the production transfer deps stream through the guarded putObjectStream with a live recheck', () => {
    const transferDeps = videos.slice(
        videos.indexOf('const uploadTransferDeps'),
        videos.indexOf('const uploadCompletionDeps'),
    );
    assert.match(transferDeps, /putObjectStream\(BUCKETS\.ORIGINALS, objectKey, stream, sizeBytes, contentType\)/);
    assert.match(transferDeps, /recheckUploadAuthority\(video, user, now, courseUploadPolicyReader\)/);
});

test('wiring: finalization delegates to the serialized orchestration with the atomic claim', () => {
    const completeHandler = videos.slice(
        videos.indexOf("router.post('/upload/complete'"),
        videos.indexOf('async function processVideoAsync'),
    );
    assert.match(completeHandler, /runUploadCompletion\(/);
    assert.match(completeHandler, /uploadCompletionDeps/);

    const completionDeps = videos.slice(
        videos.indexOf('const uploadCompletionDeps'),
        videos.indexOf('const router = Router()'),
    );
    assert.match(completionDeps, /claimAndEnqueue: claimAndEnqueueOnConnection/);
    assert.match(completionDeps, /statOriginal: uploadStorageVerifier\.statOriginal/);
    // Processing is started through the in-flight guarded starter; the raw
    // processVideoAsync call lives inside that guard.
    assert.match(completionDeps, /startProcessing: startVideoProcessing/);
});

test('wiring: the finalization orchestration re-checks authority, serializes on the lock, and starts processing only after commit', () => {
    const orchestration = videos.slice(
        videos.indexOf('export const runUploadCompletion'),
        videos.indexOf('/** Production wiring for the authenticated byte-transfer endpoint. */'),
    );
    assert.match(orchestration, /deps\.acquireUploadLock\(/);
    assert.match(orchestration, /deps\.loadInProgressUpload\(videoId, user\.id, user\.tenantId/); // in-lock reload
    assert.match(orchestration, /deps\.recheckAuthority\(current, user, now\)/);
    assert.match(orchestration, /deps\.claimAndEnqueue\(lock\.connection\)\(current, user\)/);
    assert.match(orchestration, /deps\.statOriginal\(current\.original_key/);
    assert.ok(
        orchestration.indexOf('deps.startProcessing(') > orchestration.indexOf('await lock.release()'),
        'processing must start after the lock is released (i.e. after commit)',
    );
});

test('wiring: the claim and the queue insert are one transaction on the lock connection', () => {
    const claim = videos.slice(
        videos.indexOf('export const claimAndEnqueueOnConnection'),
        videos.indexOf('export const runUploadCompletion'),
    );
    assert.ok(claim.indexOf('await connection.beginTransaction()') < claim.indexOf('UPDATE videos SET status = \'processing\''));
    assert.ok(claim.indexOf('UPDATE videos SET status = \'processing\'') < claim.indexOf('INSERT INTO video_processing_queue'));
    assert.ok(claim.indexOf('INSERT INTO video_processing_queue') < claim.indexOf('await connection.commit()'));
    assert.match(claim, /await connection\.rollback\(\)/);
});

test('wiring: the lock manager serializes through MySQL named locks on a dedicated connection', () => {
    const lockManager = videos.slice(
        videos.indexOf('export const createSqlUploadLockManager'),
        videos.indexOf('const sqlUploadLockManager = createUploadLockManagerFromPool'),
    );
    assert.match(lockManager, /SELECT GET_LOCK\(\?, \?\) AS acquired/);
    assert.match(lockManager, /SELECT RELEASE_LOCK\(\?\)/);
    assert.match(lockManager, /await connection\.release\(\)/);
});

test('wiring: the MinIO service guards the stream and exposes no anonymous upload URL helper', () => {
    assert.match(minioService, /export const putObjectStream = createObjectStreamUploader\(/);
    assert.match(minioService, /export const guardUploadStream = \(/);
    assert.match(minioService, /export class UploadStreamSizeError/);
    assert.doesNotMatch(minioService, /getPresignedUploadUrl/);
    const uploaderFactory = minioService.slice(
        minioService.indexOf('export const createObjectStreamUploader'),
        minioService.indexOf('const defaultPutObjectClient'),
    );
    assert.match(uploaderFactory, /guardUploadStream\(stream, size\)/);
    assert.match(uploaderFactory, /client\.removeObject\(bucket, objectKey\)/);
});

test('wiring: init allocates only through the verified policy and the private contract', () => {
    const initHandler = videos.slice(
        videos.indexOf("router.post('/upload/init'"),
        videos.indexOf("router.put('/upload/:videoId/content'"),
    );
    assert.match(initHandler, /evaluateCourseUploadPolicy\(req\.user!, course_id, courseUploadPolicyReader\)/);
    assert.match(initHandler, /uploadObjectKey\(videoId, extension\)/);
    assert.match(initHandler, /buildUploadInitContract\(videoId, objectKey, ttlMinutes\)/);
    assert.doesNotMatch(initHandler, /getPresignedUploadUrl/);
    assert.doesNotMatch(initHandler, /\/storage\//);
});

test('wiring: the uploader sends bytes through the authenticated API with the auth header', () => {
    assert.match(uploaderSource, /uploadBytesThroughApi\(`\$\{API_BASE\}\$\{uploadUrl\}`/);
    const helper = uploaderSource.slice(
        uploaderSource.indexOf('async function uploadBytesThroughApi'),
        uploaderSource.indexOf('function readServerErrorMessage'),
    );
    assert.match(helper, /xhr\.open\('PUT', url\)/);
    assert.match(helper, /setRequestHeader\('Authorization', `Bearer \$\{authToken\}`\)/);
    // The minio branch never PUTs to a raw storage/presigned URL: it uses the
    // authenticated byte-transfer endpoint only (the managed-DRM shadow helper
    // keeps its own provider contract and is unchanged).
    const startUpload = uploaderSource.slice(
        uploaderSource.indexOf('const startUpload'),
        uploaderSource.indexOf('async function uploadBytesThroughApi'),
    );
    assert.doesNotMatch(startUpload, /uploadToMinIO\(uploadUrl/);
    // No storage path ever appears in the browser bundle.
    assert.doesNotMatch(uploaderSource, /\/storage\//);
    // Signed URLs/tokens are never logged.
    assert.doesNotMatch(uploaderSource, /console\.log\([^)]*uploadUrl/);
});

test('wiring: the uploader stops retrying terminal completion outcomes but keeps retrying contention', () => {
    const completeLoop = uploaderSource.slice(
        uploaderSource.indexOf('let completeSuccess = false;'),
        uploaderSource.indexOf('if (!completeSuccess)'),
    );
    assert.match(completeLoop, /completeResponse\.status === 403/);
    assert.match(completeLoop, /completeResponse\.status === 410/);
    assert.match(uploaderSource, /async function readCompleteErrorMessage\(/);
    // Busy (409) and rolled-back enqueue (500) stay retryable: only the two
    // terminal statuses break the loop.
    assert.doesNotMatch(completeLoop, /status === 409/);
    assert.doesNotMatch(completeLoop, /status === 500/);
});

// ---------------------------------------------------------------------------
// Supervisor-reviewed production gaps (defect-exposing regressions)
// ---------------------------------------------------------------------------
// (a) the held lock connection must come from a DEDICATED pool — drawing it
//     from the shared request pool (connectionLimit 10) lets lock holders
//     starve every other request that needs a pool connection;
// (b) if RELEASE_LOCK fails the connection may still own the named lock, so it
//     must be DESTROYED — never returned to a pool that would hand the next
//     operation a session already holding the lock;
// (c) video_processing_queue needs a real consumer after a restart (a crash
//     between the claim+enqueue commit and the in-process run leaves a
//     committed 'processing' video nobody picks up), and recovery must not
//     select 'uploading' only.

test('defect lock: a failed RELEASE_LOCK destroys the connection instead of returning it to the pool', async () => {
    const held = new Set<string>();
    let destroyCalls = 0;
    let releaseCalls = 0;
    const manager = createSqlUploadLockManager({
        acquireConnection: async () => ({
            query: async <T>(sql: string, params?: unknown[]): Promise<T[]> => {
                if (/GET_LOCK/.test(sql)) {
                    held.add((params as string[])[0]);
                    return [{ acquired: 1 }] as T[];
                }
                if (/RELEASE_LOCK/.test(sql)) {
                    throw new Error('simulated RELEASE_LOCK failure');
                }
                return [] as T[];
            },
            execute: async () => ({ affectedRows: 0 }),
            beginTransaction: async () => {},
            commit: async () => {},
            rollback: async () => {},
            release: async () => {
                releaseCalls++;
            },
            destroy: async () => {
                destroyCalls++;
            },
        }),
    });

    const handle = await manager.acquire('tenant-1', 'video-1');
    assert.ok(handle);
    await handle!.release(); // a release failure must not throw at the caller
    assert.equal(destroyCalls, 1, 'a connection that may still hold the named lock must be destroyed');
    assert.equal(releaseCalls, 0, 'a failed RELEASE_LOCK must not return the connection to any pool');
});

test('defect lock: a failed GET_LOCK round-trip destroys the connection and rethrows', async () => {
    let destroyCalls = 0;
    const manager = createSqlUploadLockManager({
        acquireConnection: async () => ({
            query: async <T>(): Promise<T[]> => {
                throw new Error('simulated GET_LOCK round-trip failure');
            },
            execute: async () => ({ affectedRows: 0 }),
            beginTransaction: async () => {},
            commit: async () => {},
            rollback: async () => {},
            release: async () => {},
            destroy: async () => {
                destroyCalls++;
            },
        }),
    });

    await assert.rejects(() => manager.acquire('tenant-1', 'video-1'), /GET_LOCK/);
    assert.equal(destroyCalls, 1, 'a broken acquisition round-trip must not return the connection to a pool');
});

/**
 * A raw mysql2/promise pooled-connection stand-in (the shape the production
 * adapter maps from), recording the exact SQL and the release/destroy calls.
 */
const rawPooledConnection = (behavior: { failReleaseLock?: boolean } = {}) => {
    const calls = {
        queries: [] as [string, unknown[]][],
        executed: [] as string[],
        begun: 0,
        committed: 0,
        rolledBack: 0,
        released: 0,
        destroyed: 0,
    };
    const connection = {
        query: async (sql: string, params: unknown[] = []): Promise<[unknown, unknown]> => {
            calls.queries.push([sql, params]);
            if (/GET_LOCK/.test(sql)) return [[{ acquired: 1 }], null];
            if (/RELEASE_LOCK/.test(sql)) {
                if (behavior.failReleaseLock) throw new Error('simulated RELEASE_LOCK failure');
                return [[{ released: 1 }], null];
            }
            return [[], null];
        },
        execute: async (sql: string): Promise<[unknown, unknown]> => {
            calls.executed.push(sql);
            return [{ affectedRows: 1 }, null];
        },
        beginTransaction: async () => {
            calls.begun++;
        },
        commit: async () => {
            calls.committed++;
        },
        rollback: async () => {
            calls.rolledBack++;
        },
        release: () => {
            calls.released++;
        },
        destroy: () => {
            calls.destroyed++;
        },
    };
    return { connection, calls };
};

test('defect lock: the production pool adapter drives GET_LOCK/RELEASE_LOCK on the pooled connection', async () => {
    const { connection, calls } = rawPooledConnection();
    const manager = createUploadLockManagerFromPool({ getConnection: async () => connection });

    const handle = await manager.acquire('tenant-1', 'video-1');
    assert.ok(handle);
    assert.deepEqual(calls.queries[0], [
        'SELECT GET_LOCK(?, ?) AS acquired',
        [uploadLockName('tenant-1', 'video-1'), UPLOAD_LOCK_TIMEOUT_SECONDS],
    ]);

    await handle!.release();
    assert.deepEqual(calls.queries[1], ['SELECT RELEASE_LOCK(?)', [uploadLockName('tenant-1', 'video-1')]]);
    assert.equal(calls.released, 1, 'a clean release returns the connection to its pool');
    assert.equal(calls.destroyed, 0);
});

test('defect lock: the production pool adapter destroys the connection when RELEASE_LOCK fails', async () => {
    const { connection, calls } = rawPooledConnection({ failReleaseLock: true });
    const manager = createUploadLockManagerFromPool({ getConnection: async () => connection });

    const handle = await manager.acquire('tenant-1', 'video-1');
    assert.ok(handle);
    await handle!.release();
    assert.equal(calls.destroyed, 1, 'a failed RELEASE_LOCK must close the connection, not pool it');
    assert.equal(calls.released, 0);
});

test('defect lock: the lock pool is isolated — an exhausted request pool never blocks acquisition', async () => {
    let requestPoolTouches = 0;
    const requestPool = {
        getConnection: async () => {
            requestPoolTouches++;
            throw new Error('request pool exhausted');
        },
    };
    const { connection } = rawPooledConnection();
    // The manager composes from the dedicated lock pool alone: no code path
    // consults the request pool while a lock is held.
    const manager = createUploadLockManagerFromPool({ getConnection: async () => connection });
    const handle = await manager.acquire('tenant-1', 'video-1');
    assert.ok(handle);
    await handle!.release();
    assert.equal(requestPoolTouches, 0);
    assert.equal(typeof getUploadLockPool, 'function', 'the dedicated lock pool exists');
});

test('defect queue: reconciliation re-feeds every pending job to the processor after a restart', async () => {
    const started: [string, string][] = [];
    const result = await reconcileVideoProcessingQueue({
        loadPendingJobs: async () => [
            { videoId: 'video-committed', tenantId: 'tenant-1' },
            { videoId: 'video-crashed', tenantId: 'tenant-2' },
        ],
        isProcessing: () => false,
        startProcessing: (videoId, tenantId) => {
            started.push([videoId, tenantId]);
        },
    });
    assert.deepEqual(result.requeued, ['video-committed', 'video-crashed']);
    assert.deepEqual(started, [
        ['video-committed', 'tenant-1'],
        ['video-crashed', 'tenant-2'],
    ]);
});

test('defect queue: a job already processing in this process is never double-fed', async () => {
    const started: string[] = [];
    const result = await reconcileVideoProcessingQueue({
        loadPendingJobs: async () => [{ videoId: 'video-1', tenantId: 'tenant-1' }],
        isProcessing: (videoId) => videoId === 'video-1',
        startProcessing: (videoId) => {
            started.push(videoId);
        },
    });
    assert.deepEqual(started, []);
    assert.deepEqual(result.requeued, []);
});

test('defect queue: a failing pending-job load is contained and never crashes startup', async () => {
    const result = await reconcileVideoProcessingQueue({
        loadPendingJobs: async () => {
            throw new Error('simulated queue read failure');
        },
        isProcessing: () => false,
        startProcessing: () => {
            throw new Error('nothing may be started when the load failed');
        },
    });
    assert.deepEqual(result.requeued, []);
});

test('defect queue: the pending-job loader reads committed and crashed rows with exact tenant matching', async () => {
    let seenSql = '';
    let seenParams: unknown[] = [];
    const loader = createPendingVideoJobLoader(async (sql: string, params?: unknown[]) => {
        seenSql = sql;
        seenParams = params ?? [];
        return [
            { video_id: 'video-committed', tenant_id: 'tenant-1' },
            { video_id: 'video-crashed', tenant_id: 'tenant-2' },
        ];
    });
    const jobs = await loader();
    assert.deepEqual(jobs, [
        { videoId: 'video-committed', tenantId: 'tenant-1' },
        { videoId: 'video-crashed', tenantId: 'tenant-2' },
    ]);
    assert.match(seenSql, /FROM video_processing_queue/);
    assert.match(seenSql, /JOIN videos/);
    // committed rows whose run was lost to a restart, plus rows whose
    // claimant died mid-run (stale 'processing' past the lease horizon)
    assert.match(seenSql, /q\.status IN \('pending', 'processing'\)/);
    assert.match(seenSql, /v\.status = 'processing'/);
    // EXACT tenant matching: an inconsistent or null-tenant row is never claimed
    assert.match(seenSql, /q\.tenant_id IS NOT NULL/);
    assert.match(seenSql, /v\.tenant_id IS NOT NULL/);
    assert.match(seenSql, /q\.tenant_id = v\.tenant_id/);
    // the lease horizon and the batch size are bound parameters, not interpolated
    assert.match(seenSql, /DATE_SUB\(NOW\(\), INTERVAL \? MINUTE\)/);
    assert.match(seenSql, /LIMIT \?/);
    assert.deepEqual(seenParams, [DEFAULT_PROCESSING_LEASE_MINUTES, String(DEFAULT_VIDEO_QUEUE_BATCH_SIZE)]);
});

test('pending queue loader refuses invalid LIMIT before executing SQL', async () => {
    for (const batchSize of [0, -1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) {
        let calls = 0;
        await assert.rejects(createPendingVideoJobLoader(async () => { calls += 1; return []; }, { batchSize }), RangeError);
        assert.equal(calls, 0);
    }
});

test('defect wiring: the lock pool is a separate, smaller pool — never the request pool', () => {
    assert.ok(
        UPLOAD_LOCK_POOL_SIZE < 10,
        'the lock pool must be its own small pool, independent of the 10-slot request pool',
    );
    const wiring = videos.slice(
        videos.indexOf('const sqlUploadLockManager = createUploadLockManagerFromPool'),
        videos.indexOf('/** The authenticated principal of an upload operation. */'),
    );
    assert.match(wiring, /getUploadLockPool\(\)\.getConnection\(\)/);
    assert.doesNotMatch(wiring, /getPool\(\)\.getConnection\(\)/);
    const lockPool = videos.slice(
        videos.indexOf('export const UPLOAD_LOCK_POOL_SIZE'),
        videos.indexOf('/** Production lock manager over the DEDICATED lock pool'),
    );
    assert.match(lockPool, /mysql\.createPool\(/);
    assert.match(lockPool, /connectionLimit: UPLOAD_LOCK_POOL_SIZE/);
});

test('defect wiring: every production processing start goes through the guarded starter into the protected run', () => {
    const guarded = videos.slice(
        videos.indexOf('const inFlightVideoProcessing'),
        videos.indexOf('/** Production wiring for the authenticated byte-transfer endpoint. */'),
    );
    // per-process in-flight + bounded concurrency guard
    assert.match(guarded, /inFlightVideoProcessing\.has\(videoId\)/);
    assert.match(guarded, /activeVideoProcessing >= videoProcessingConcurrency\(\)/);
    // ...and the guarded starter feeds the ONE protected execution path
    assert.match(guarded, /runVideoProcessingJob\(videoId, tenantId, videoJobRunDeps\)/);

    // the protected run is cross-process excluded, tenant-verified, claimed and settled
    const jobDeps = videos.slice(
        videos.indexOf('const videoJobRunDeps: VideoJobRunDeps'),
        videos.indexOf('const inFlightVideoProcessing'),
    );
    assert.match(jobDeps, /acquireProcessingLock: sqlProcessingLockManager\.acquire/);
    assert.match(jobDeps, /loadJob: createSqlVideoJobLoader\(\{ queryOne \}\)/);
    assert.match(jobDeps, /claimJob: createSqlVideoJobClaim\(\{ execute \}\)/);
    assert.match(jobDeps, /settleJob: createSqlVideoJobSettler\(\{ execute \}\)/);

    const completionDeps = videos.slice(
        videos.indexOf('const uploadCompletionDeps'),
        videos.indexOf('const router = Router()'),
    );
    assert.match(completionDeps, /startProcessing: startVideoProcessing/);

    const recovery = videos.slice(
        videos.indexOf("router.post('/upload/recover-stuck'"),
        videos.indexOf('// STREAMING ENDPOINTS'),
    );
    assert.match(recovery, /startVideoProcessing\(video\.id, video\.tenant_id\)/);
});

test('defect wiring: the processing lock manager runs on its own dedicated pool with a non-blocking timeout', () => {
    const wiring = videos.slice(
        videos.indexOf('const sqlProcessingLockManager ='),
        videos.indexOf('/** Stable-ish identifier of the executing worker'),
    );
    assert.match(wiring, /getProcessingLockPool\(\)\.getConnection\(\)/);
    assert.match(wiring, /\{ timeoutSeconds: 0 \}/);
    assert.doesNotMatch(wiring, /getPool\(\)\.getConnection\(\)/);
    assert.doesNotMatch(wiring, /getUploadLockPool\(\)\.getConnection\(\)/);

    // the pools are distinct instances, not one pool shared by two lock kinds
    assert.match(videos, /let uploadLockPool: mysql\.Pool \| null = null;/);
    assert.match(videos, /let processingLockPool: mysql\.Pool \| null = null;/);
    assert.ok(
        PROCESSING_LOCK_POOL_SIZE < 10,
        'the processing lock pool is its own small pool, independent of the 10-slot request pool',
    );
});

test('defect wiring: admin recovery only re-arms settled/crashed videos, never a live upload', () => {
    const recovery = videos.slice(
        videos.indexOf("router.post('/upload/recover-stuck'"),
        videos.indexOf('// STREAMING ENDPOINTS'),
    );
    assert.match(recovery, /status IN \('processing', 'failed'\)/);
    assert.doesNotMatch(recovery, /status IN \('uploading'/);
    // a live-upload count is reported, not touched
    assert.match(recovery, /liveUploadsLeftAlone/);
    // and recovery re-opens the job row instead of starting the processor directly
    assert.match(recovery, /INSERT INTO video_processing_queue/);
    assert.doesNotMatch(recovery, /processVideo\(/);
});

test('defect wiring: no startup path resets a running job or invokes the processor directly', () => {
    // The old startup recovery (reset 'processing' -> 'uploading' + direct
    // processVideo on a fixed delay) is gone; the unified consumer owns
    // recovery, and the named lock decides which live run survives.
    assert.doesNotMatch(indexSource, /processVideo\(/);
    assert.doesNotMatch(indexSource, /status = 'uploading'/);
    assert.doesNotMatch(indexSource, /INTERVAL 10 MINUTE/);
});

test('defect wiring: a single periodic consumer feeds the processing queue after a restart', () => {
    const boot = indexSource.slice(
        indexSource.indexOf('const startServer'),
        indexSource.indexOf("server.on('error'"),
    );
    assert.match(boot, /scheduleVideoQueueConsumer\(\)/);
    // it runs only when the database is actually in use
    assert.match(boot, /if \(!skipDb\) \{[\s\S]*videoQueueConsumer\.start\(\)/);
    // and the scheduler composes the reconciliation sweep internally
    const scheduler = videos.slice(
        videos.indexOf('export const scheduleVideoQueueConsumer'),
        videos.indexOf('export const scheduleVideoQueueConsumer') + 1400,
    );
    assert.match(scheduler, /startVideoQueueReconciliation\(\)/);
    assert.match(scheduler, /videoQueuePollSeconds\(\) \* 1000/);
    assert.match(scheduler, /setInterval\(tick, intervalMs\)/);
});

test('defect wiring: shutdown stops the consumer, blocks new runs and closes the dedicated lock pools', () => {
    const shutdown = indexSource.slice(
        indexSource.indexOf('const gracefulShutdown'),
    );
    assert.match(shutdown, /videoQueueConsumer\.stop\(\)/);
    assert.match(shutdown, /requestVideoProcessingShutdown\(\)/);
    assert.match(shutdown, /inFlightVideoProcessingCount\(\) > 0/);
    assert.match(shutdown, /closeUploadLockPool\(\)/);
    assert.match(shutdown, /closeProcessingLockPool\(\)/);
});
