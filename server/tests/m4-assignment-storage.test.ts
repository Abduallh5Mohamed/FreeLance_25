import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import { createAuthenticateToken } from '../src/middleware/auth';
import {
    deriveUploadStatus,
    validateFinalizeRequest,
} from '../src/services/assignments';
import {
    MAX_SIGNATURE_PREFIX_BYTES,
    expectedContentType,
    normalizeContentType,
    parseSubmissionStorageKey,
    uploadAuthorizationTtlSeconds,
    verifyObjectSignature,
    verifySubmissionStorageKey,
} from '../src/services/assignment-storage';
import type {
    AssignmentObjectStore,
    MalwareScanInput,
    MalwareScanner,
} from '../src/services/assignment-storage';
import type { BucketProvisioningClient } from '../src/services/minio';
import { createAssignmentsRouter, type AssignmentsDataAccess } from '../src/routes/assignments';
import {
    TEST_SECRET,
    makeFakeDataAccess,
    makeRepository,
    tokenFor,
    invokeRoute,
} from './helpers/m2-harness';

const originalSecret = process.env.JWT_SECRET;
before(() => { process.env.JWT_SECRET = TEST_SECRET; });
after(() => {
    if (originalSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = originalSecret;
});

// The provisioning adapter under test lives in services/minio.ts, which reads
// its bucket/credential environment at module load. Pin a clean, synthetic
// environment for the duration of this file: no real credentials are used and
// no connection is ever opened (the injected client never touches the SDK).
const minioEnvBackup = new Map(
    Object.keys(process.env)
        .filter((key) => key.startsWith('MINIO_'))
        .map((key) => [key, process.env[key] as string]),
);
before(() => {
    process.env.MINIO_ACCESS_KEY = 'm4-test-access-key';
    process.env.MINIO_SECRET_KEY = 'm4-test-secret-key';
    for (const key of minioEnvBackup.keys()) delete process.env[key];
});
after(() => {
    for (const key of [...minioEnvBackup.keys(), 'MINIO_ACCESS_KEY', 'MINIO_SECRET_KEY']) {
        delete process.env[key];
    }
    for (const [key, value] of minioEnvBackup) process.env[key] = value;
});

/* ------------------------------------------------------------------------- */
/* Pure adapter policy                                                        */
/* ------------------------------------------------------------------------- */

test('storage key: parses the canonical shape and rejects anything else', () => {
    const key = 'tenants/tenant-a/assignments/a-1/enr-a/sub-1.pdf';
    assert.deepEqual(parseSubmissionStorageKey(key), {
        tenantId: 'tenant-a',
        assignmentId: 'a-1',
        enrollmentId: 'enr-a',
        submissionId: 'sub-1',
        fileExtension: 'pdf',
    });
    assert.equal(parseSubmissionStorageKey('tenants/tenant-a/assignments/a-1/enr-a/../../etc/passwd'), null);
    assert.equal(parseSubmissionStorageKey('tenants/tenant-a/assignments/a-1/enr-a/sub-1.PDF'), null);
    assert.equal(parseSubmissionStorageKey('tenants/tenant-a/assignments/a-1/enr-a/sub-1'), null);
    assert.equal(parseSubmissionStorageKey('other/tenant-a/assignments/a-1/enr-a/sub-1.pdf'), null);
    assert.equal(parseSubmissionStorageKey(''), null);
});

test('storage key: every identifier and the extension must match the server facts', () => {
    const key = 'tenants/tenant-a/assignments/a-1/enr-a/sub-1.pdf';
    const expected = {
        tenantId: 'tenant-a', assignmentId: 'a-1', enrollmentId: 'enr-a',
        submissionId: 'sub-1', fileExtension: 'pdf',
    };
    assert.equal(verifySubmissionStorageKey(key, expected), true);
    assert.equal(verifySubmissionStorageKey(key, { ...expected, tenantId: 'tenant-b' }), false);
    assert.equal(verifySubmissionStorageKey(key, { ...expected, assignmentId: 'a-2' }), false);
    assert.equal(verifySubmissionStorageKey(key, { ...expected, enrollmentId: 'enr-b' }), false);
    assert.equal(verifySubmissionStorageKey(key, { ...expected, submissionId: 'sub-2' }), false);
    assert.equal(verifySubmissionStorageKey(key, { ...expected, fileExtension: 'png' }), false);
});

test('content type: exact expected MIME per verifiable extension, parameters normalised', () => {
    assert.equal(expectedContentType('pdf'), 'application/pdf');
    assert.equal(expectedContentType('JPG'), 'image/jpeg');
    assert.equal(expectedContentType('docx'), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    assert.equal(expectedContentType('exe'), null);
    assert.equal(normalizeContentType('Application/PDF; charset=binary'), 'application/pdf');
    assert.equal(normalizeContentType('  image/png '), 'image/png');
    assert.equal(normalizeContentType(null), null);
    assert.equal(normalizeContentType('   '), null);
});

test('signature: each supported type is checked against its bounded prefix', () => {
    assert.deepEqual(verifyObjectSignature('pdf', Buffer.from('%PDF-1.7\n', 'ascii')), { ok: true });
    assert.deepEqual(verifyObjectSignature('png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), { ok: true });
    assert.deepEqual(verifyObjectSignature('jpg', Buffer.from([0xff, 0xd8, 0xff, 0xe0])), { ok: true });
    assert.deepEqual(verifyObjectSignature('zip', Buffer.from([0x50, 0x4b, 0x03, 0x04])), { ok: true });
    assert.deepEqual(verifyObjectSignature('docx', Buffer.from([0x50, 0x4b, 0x03, 0x04])), { ok: true });
    assert.deepEqual(verifyObjectSignature('doc', Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])), { ok: true });
    assert.deepEqual(verifyObjectSignature('txt', Buffer.from('plain text\n', 'utf8')), { ok: true });
});

test('signature: wrong magic bytes, unsupported types, NUL text and short prefixes fail closed', () => {
    assert.deepEqual(verifyObjectSignature('pdf', Buffer.from('<html>', 'ascii')), { ok: false, reason: 'signature_mismatch' });
    assert.deepEqual(verifyObjectSignature('png', Buffer.from([0x89, 0x50])), { ok: false, reason: 'insufficient_bytes' });
    assert.deepEqual(verifyObjectSignature('exe', Buffer.from([0x4d, 0x5a])), { ok: false, reason: 'unsupported_type' });
    assert.deepEqual(verifyObjectSignature('txt', Buffer.from([0x61, 0x00, 0x62])), { ok: false, reason: 'signature_mismatch' });
    assert.deepEqual(verifyObjectSignature('pdf', Buffer.alloc(0)), { ok: false, reason: 'insufficient_bytes' });
});

test('upload authorization lifetime is clamped to the short-lived window', () => {
    assert.equal(uploadAuthorizationTtlSeconds(undefined), 300);
    assert.equal(uploadAuthorizationTtlSeconds(10), 60);
    assert.equal(uploadAuthorizationTtlSeconds(9999), 600);
    assert.equal(uploadAuthorizationTtlSeconds(Number.NaN), 300);
});

test('upload status derivation: uploaded is not clean', () => {
    assert.equal(deriveUploadStatus(0, 'pending'), 'pending_upload');
    assert.equal(deriveUploadStatus(0, 'clean'), 'pending_upload', 'no verified object can never be clean');
    assert.equal(deriveUploadStatus(2048, 'pending'), 'pending_scan');
    assert.equal(deriveUploadStatus(2048, 'clean'), 'finalized');
    assert.equal(deriveUploadStatus(2048, 'infected'), 'quarantined');
    assert.equal(deriveUploadStatus(2048, 'failed'), 'quarantined');
});

test('finalize request accepts no client object facts', () => {
    assert.deepEqual(validateFinalizeRequest({}), { ok: true, value: null });
    assert.deepEqual(validateFinalizeRequest(undefined), { ok: true, value: null });
    for (const body of [
        { storage_key: 'tenants/x/y.pdf' },
        { file_size_bytes: 10 },
        { scan_status: 'clean' },
        { checksum: 'abc' },
        { etag: 'abc' },
        { unknown: 'x' },
    ]) {
        assert.equal(validateFinalizeRequest(body).ok, false, `${Object.keys(body)[0]} must be rejected`);
    }
});

/* ------------------------------------------------------------------------- */
/* Route harness                                                             */
/* ------------------------------------------------------------------------- */

const STUDENT_A = tokenFor({ id: 'student-a', role: 'student', tv: 0, student_enrollment_id: 'enr-a' });
const STUDENT_B = tokenFor({ id: 'student-b', role: 'student', tv: 0, student_enrollment_id: 'enr-b' });

const ENROLLMENT_A = {
    id: 'enr-a', user_id: 'student-a', tenant_id: 'tenant-a', instructor_id: 'instructor-a',
    group_id: 'grp-1', grade_id: null, branch_id: 'br-1', branch_scope: 'branch',
};
const ENROLLMENT_B = { ...ENROLLMENT_A, id: 'enr-b', user_id: 'student-b' };

const ASSIGNMENT = {
    id: 'a-1', tenant_id: 'tenant-a', branch_id: null, branch_scope: 'tenant', course_id: null, group_id: null,
    title: 'HW', instructions: null, deadline_at: null, deadline_timezone: 'UTC', late_policy: 'block',
    resubmission_policy: 'allow', max_submissions: 5, max_file_bytes: 1000000, allowed_file_types: '["pdf"]',
    status: 'published', archived_at: null, version: 0,
};

const STORAGE_KEY = 'tenants/tenant-a/assignments/a-1/enr-a/sub-1.pdf';

const pendingSubmission = () => ({
    id: 'sub-1', assignment_id: 'a-1', tenant_id: 'tenant-a', student_enrollment_id: 'enr-a',
    student_user_id: 'student-a', version: 1, status: 'submitted', file_name: 'hw.pdf',
    file_type: 'application/pdf', file_size_bytes: 0, scan_status: 'pending', is_late: 0,
    submitted_at: '2026-01-01 00:00:00', revoked_at: null, storage_key: STORAGE_KEY,
});

const finalizedSubmission = () => ({
    ...pendingSubmission(), file_size_bytes: 2048, scan_status: 'pending',
});

const makeObjectStore = (overrides: Partial<AssignmentObjectStore> = {}): AssignmentObjectStore => ({
    statObject: async () => ({
        sizeBytes: 2048,
        contentType: 'application/pdf',
        etag: 'etag-1',
        lastModified: new Date('2026-01-01T00:00:00Z'),
    }),
    readPrefix: async () => Buffer.from('%PDF-1.7\n', 'ascii'),
    createUploadUrl: async ({ objectKey, expiresInSeconds }) =>
        `https://storage.invalid/private/${objectKey}?expires=${expiresInSeconds}`,
    removeObject: async () => undefined,
    ...overrides,
});

interface BuildOptions {
    submission?: Record<string, unknown> | null;
    store?: Partial<AssignmentObjectStore>;
    scanner?: MalwareScanner;
    assignment?: Record<string, unknown>;
    now?: Date;
    scanTimeoutMs?: number;
    execute?: (sql: string, params?: unknown[]) => Promise<{ insertId?: number; affectedRows?: number }>;
    submissionReads?: () => Record<string, unknown> | null;
}

const build = (opts: BuildOptions = {}) => {
    const submission = opts.submission === undefined ? pendingSubmission() : opts.submission;
    const db = makeFakeDataAccess((sql, params) => {
        if (sql.includes('FROM students s LEFT JOIN')) return [ENROLLMENT_A];
        if (sql.includes('FROM assignments') && sql.includes('id = ?')) return [opts.assignment ?? ASSIGNMENT];
        if (sql.includes('FROM assignment_submissions') && sql.includes('storage_key')) {
            const row = opts.submissionReads ? opts.submissionReads() : submission;
            if (!row) return [];
            const [id, assignmentId, tenantId, enrollmentId] = params as string[];
            const matches = row.id === id
                && row.assignment_id === assignmentId
                && row.tenant_id === tenantId
                && row.student_enrollment_id === enrollmentId;
            return matches ? [row] : [];
        }
        return [];
    });
    const repository = makeRepository(
        {
            'student-a': { is_active: 1, token_version: 0, suspension_active: 0, role: 'student' },
            'student-b': { is_active: 1, token_version: 0, suspension_active: 0, role: 'student' },
        },
        { enrollments: { 'student-a': [ENROLLMENT_A], 'student-b': [ENROLLMENT_B] } },
    );
    const dataAccess: AssignmentsDataAccess = {
        query: db.query,
        queryOne: db.queryOne,
        execute: opts.execute ?? db.execute,
    };
    const router = createAssignmentsRouter({
        db: dataAccess,
        authenticate: createAuthenticateToken(repository),
        loadActiveTenantAuthority: async () => null,
        now: () => opts.now ?? new Date('2026-01-01T00:00:00Z'),
        transaction: async <T>(fn: (tx: AssignmentsDataAccess) => Promise<T>) => fn(dataAccess),
        objectStore: makeObjectStore(opts.store),
        malwareScanner: opts.scanner,
        scanTimeoutMs: opts.scanTimeoutMs,
    });
    return { router, executed: db.executed };
};

const finalize = (router: ReturnType<typeof build>['router'], token = STUDENT_A) =>
    invokeRoute(router, {
        method: 'POST', url: '/a-1/submissions/sub-1/finalize', token, body: {},
    });

const auditActions = (executed: Array<{ sql: string; params: unknown[] }>) =>
    executed.filter((e) => e.sql.includes('INSERT INTO audit_events')).map((e) => e.params[3] as string);

/* ------------------------------------------------------------------------- */
/* Positive control                                                          */
/* ------------------------------------------------------------------------- */

test('finalize: verified object + clean scanner records the size atomically and audits', async () => {
    const cleanScanner: MalwareScanner = { scan: async () => ({ verdict: 'clean' }) };
    const { router, executed } = build({ scanner: cleanScanner });
    const response = await finalize(router);
    assert.equal(response.statusCode, 200);
    const body = response.body as Record<string, unknown>;
    assert.equal(body.upload_status, 'finalized');
    assert.equal(body.scan_status, 'clean');
    assert.equal(body.file_size_bytes, 2048);
    assert.equal('storage_key' in body, false);
    assert.equal('url' in body, false);

    const update = executed.find((e) => e.sql.includes('UPDATE assignment_submissions'));
    assert.ok(update);
    assert.deepEqual(update!.params.slice(0, 2), [2048, 'clean']);
    assert.equal(update!.params[2], 'sub-1');
    assert.equal(update!.params[3], 'a-1');
    assert.equal(update!.params[4], 'tenant-a');
    assert.equal(update!.params[5], 'enr-a', 'the update is bound to the verified enrollment');
    assert.match(update!.sql, /file_size_bytes=0 AND scan_status='pending'/, 'the write is race-guarded');
    assert.ok(auditActions(executed).includes('assignment.submission.finalize'));
});

test('finalize: without a scanner the upload stays pending_scan (202), never clean', async () => {
    const { router, executed } = build();
    const response = await finalize(router);
    assert.equal(response.statusCode, 202);
    const body = response.body as Record<string, unknown>;
    assert.equal(body.upload_status, 'pending_scan');
    assert.equal(body.scan_status, 'pending');
    assert.equal(body.file_size_bytes, 2048);
    const update = executed.find((e) => e.sql.includes('UPDATE assignment_submissions'));
    assert.ok(update);
    assert.equal(update!.params[1], 'pending', 'no clean verdict is fabricated');
    assert.ok(auditActions(executed).includes('assignment.submission.finalize'));
});

test('finalize: idempotent retry returns the recorded state without stat/update/audit', async () => {
    let statCalls = 0;
    const { router, executed } = build({
        submission: finalizedSubmission(),
        store: {
            statObject: async () => {
                statCalls += 1;
                return { sizeBytes: 2048, contentType: 'application/pdf', etag: 'e', lastModified: null };
            },
        },
    });
    const response = await finalize(router);
    assert.equal(response.statusCode, 200);
    assert.equal((response.body as { upload_status?: string }).upload_status, 'pending_scan');
    assert.equal(statCalls, 0, 'a finalized row is never re-verified');
    assert.equal(executed.some((e) => e.sql.includes('UPDATE assignment_submissions')), false);
    assert.equal(auditActions(executed).length, 0);
});

/* ------------------------------------------------------------------------- */
/* Denials                                                                   */
/* ------------------------------------------------------------------------- */

test('finalize: client-supplied key/size/scan facts are rejected before storage', async () => {
    let statCalls = 0;
    const { router, executed } = build({
        store: {
            statObject: async () => {
                statCalls += 1;
                return null;
            },
        },
    });
    const response = await invokeRoute(router, {
        method: 'POST', url: '/a-1/submissions/sub-1/finalize', token: STUDENT_A,
        body: { storage_key: STORAGE_KEY, file_size_bytes: 2048, scan_status: 'clean' },
    });
    assert.equal(response.statusCode, 400);
    assert.equal((response.body as { code?: string }).code, 'untrusted_finalize_fields');
    assert.equal(statCalls, 0);
    assert.equal(executed.some((e) => e.sql.includes('UPDATE assignment_submissions')), false);
});

test('finalize: a missing object is 404 and nothing is recorded', async () => {
    const { router, executed } = build({ store: { statObject: async () => null } });
    const response = await finalize(router);
    assert.equal(response.statusCode, 404);
    assert.equal((response.body as { code?: string }).code, 'object_not_found');
    assert.equal(executed.some((e) => e.sql.includes('UPDATE assignment_submissions')), false);
    assert.equal(auditActions(executed).length, 0);
});

test('finalize: a storage failure is 502 and nothing is recorded', async () => {
    const { router, executed } = build({
        store: { statObject: async () => { throw new Error('storage down'); } },
    });
    const response = await finalize(router);
    assert.equal(response.statusCode, 502);
    assert.equal((response.body as { code?: string }).code, 'storage_unavailable');
    assert.equal(executed.some((e) => e.sql.includes('UPDATE assignment_submissions')), false);
});

test('finalize: an oversize object is 413, removed best-effort and not recorded', async () => {
    const removed: string[] = [];
    const mutableRemovals: string[] = [];
    const { router, executed } = build({
        store: {
            statObject: async () => ({
                sizeBytes: 2000000, contentType: 'application/pdf', etag: 'e', lastModified: null,
            }),
            capabilities: { conditionalDelete: true },
            removeObject: async (key) => { mutableRemovals.push(key); },
            removeObjectVersion: async ({ objectKey, etag, sizeBytes }) => {
                removed.push(`${objectKey}#${etag}:${sizeBytes}`);
                return 'removed';
            },
        },
    });
    const response = await finalize(router);
    assert.equal(response.statusCode, 413);
    assert.equal((response.body as { code?: string }).code, 'file_size_out_of_bounds');
    assert.deepEqual(removed, [`${STORAGE_KEY}#e:2000000`],
        'the rejected version is the one the server stat\'ed, removed by exact version');
    assert.deepEqual(mutableRemovals, [], 'a rejection never deletes by mutable key');
    assert.equal(executed.some((e) => e.sql.includes('UPDATE assignment_submissions')), false);
});

test('finalize: an undersize object is rejected and removed', async () => {
    const removed: string[] = [];
    const mutableRemovals: string[] = [];
    const { router } = build({
        store: {
            statObject: async () => ({ sizeBytes: 5, contentType: 'application/pdf', etag: 'e', lastModified: null }),
            capabilities: { conditionalDelete: true },
            removeObject: async (key) => { mutableRemovals.push(key); },
            removeObjectVersion: async ({ objectKey, etag, sizeBytes }) => {
                removed.push(`${objectKey}#${etag}:${sizeBytes}`);
                return 'removed';
            },
        },
    });
    const response = await finalize(router);
    assert.equal(response.statusCode, 400);
    assert.deepEqual(removed, [`${STORAGE_KEY}#e:5`]);
    assert.deepEqual(mutableRemovals, [], 'a rejection never deletes by mutable key');
});

test('finalize: a stored content-type mismatch is 422 and removed', async () => {
    const removed: string[] = [];
    const mutableRemovals: string[] = [];
    const { router } = build({
        store: {
            statObject: async () => ({
                sizeBytes: 2048, contentType: 'text/html', etag: 'e', lastModified: null,
            }),
            capabilities: { conditionalDelete: true },
            removeObject: async (key) => { mutableRemovals.push(key); },
            removeObjectVersion: async ({ objectKey, etag, sizeBytes }) => {
                removed.push(`${objectKey}#${etag}:${sizeBytes}`);
                return 'removed';
            },
        },
    });
    const response = await finalize(router);
    assert.equal(response.statusCode, 422);
    assert.equal((response.body as { code?: string }).code, 'content_type_mismatch');
    assert.deepEqual(removed, [`${STORAGE_KEY}#e:2048`]);
    assert.deepEqual(mutableRemovals, [], 'a rejection never deletes by mutable key');
});

test('finalize: a missing stored content-type fails closed', async () => {
    const { router } = build({
        store: {
            statObject: async () => ({ sizeBytes: 2048, contentType: null, etag: 'e', lastModified: null }),
        },
    });
    assert.equal((await finalize(router)).statusCode, 422);
});

test('finalize: a signature mismatch (renamed HTML as PDF) is 422 and removed', async () => {
    const removed: string[] = [];
    const mutableRemovals: string[] = [];
    const { router } = build({
        store: {
            readPrefix: async () => Buffer.from('<html><body>not a pdf</body></html>', 'ascii'),
            capabilities: { conditionalDelete: true },
            removeObject: async (key) => { mutableRemovals.push(key); },
            removeObjectVersion: async ({ objectKey, etag, sizeBytes }) => {
                removed.push(`${objectKey}#${etag}:${sizeBytes}`);
                return 'removed';
            },
        },
    });
    const response = await finalize(router);
    assert.equal(response.statusCode, 422);
    assert.equal((response.body as { code?: string }).code, 'signature_mismatch');
    assert.deepEqual(removed, [`${STORAGE_KEY}#etag-1:2048`]);
    assert.deepEqual(mutableRemovals, [], 'a rejection never deletes by mutable key');
});

test('finalize: a forged/foreign storage key is 409 before any storage call', async () => {
    let statCalls = 0;
    const { router, executed } = build({
        submission: { ...pendingSubmission(), storage_key: 'tenants/tenant-b/assignments/a-1/enr-a/sub-1.pdf' },
        store: {
            statObject: async () => {
                statCalls += 1;
                return null;
            },
        },
    });
    const response = await finalize(router);
    assert.equal(response.statusCode, 409);
    assert.equal((response.body as { code?: string }).code, 'storage_binding_mismatch');
    assert.equal(statCalls, 0);
    assert.equal(executed.some((e) => e.sql.includes('UPDATE assignment_submissions')), false);
});

test('finalize: a key whose submission segment does not match is 409', async () => {
    const { router } = build({
        submission: { ...pendingSubmission(), storage_key: 'tenants/tenant-a/assignments/a-1/enr-a/sub-9.pdf' },
    });
    assert.equal((await finalize(router)).statusCode, 409);
});

test('finalize: a foreign or missing submission is 404 and leaks no facts', async () => {
    const missing = build({ submission: null });
    const response = await finalize(missing.router);
    assert.equal(response.statusCode, 404);
    assert.deepEqual(response.body, { error: 'Submission not found' });

    const foreign = build({ submission: { ...pendingSubmission(), tenant_id: 'tenant-b' } });
    assert.equal((await finalize(foreign.router, STUDENT_B)).statusCode, 404);
});

test('finalize: the own-submission read is bound to tenant, assignment and enrollment', async () => {
    const { router, executed } = build();
    await finalize(router);
    const read = executed.find((e) => e.sql.includes('storage_key') && e.sql.includes('FROM assignment_submissions'));
    assert.ok(read);
    assert.match(read!.sql, /id = \? AND assignment_id = \? AND tenant_id = \? AND student_enrollment_id = \?/);
    assert.deepEqual(read!.params, ['sub-1', 'a-1', 'tenant-a', 'enr-a']);
});

test('finalize: a revoked submission is 409 before storage', async () => {
    let statCalls = 0;
    const { router } = build({
        submission: { ...pendingSubmission(), status: 'revoked' },
        store: {
            statObject: async () => {
                statCalls += 1;
                return null;
            },
        },
    });
    const response = await finalize(router);
    assert.equal(response.statusCode, 409);
    assert.equal((response.body as { code?: string }).code, 'submission_revoked');
    assert.equal(statCalls, 0);
});

test('finalize: a closed window is 403 before storage', async () => {
    let statCalls = 0;
    const { router } = build({
        assignment: { ...ASSIGNMENT, deadline_at: '2026-06-01 12:00:00', late_policy: 'block' },
        now: new Date('2026-06-01T13:00:00Z'),
        store: {
            statObject: async () => {
                statCalls += 1;
                return null;
            },
        },
    });
    const response = await finalize(router);
    assert.equal(response.statusCode, 403);
    assert.equal((response.body as { code?: string }).code, 'DEADLINE_PASSED');
    assert.equal(statCalls, 0);
});

/* ------------------------------------------------------------------------- */
/* Scanner outcomes                                                          */
/* ------------------------------------------------------------------------- */

test('finalize: an infected verdict quarantines, audits and removes the object', async () => {
    const removed: string[] = [];
    const mutableRemovals: string[] = [];
    const infectedScanner: MalwareScanner = {
        scan: async () => ({ verdict: 'infected', signature: 'EICAR-Test' }),
    };
    const { router, executed } = build({
        scanner: infectedScanner,
        store: {
            // The delete is only legal against the exact scanned version, so the
            // adapter must declare (and enforce) that capability.
            capabilities: { conditionalDelete: true },
            removeObject: async (key) => { mutableRemovals.push(key); },
            removeObjectVersion: async ({ objectKey, etag, sizeBytes }) => {
                removed.push(`${objectKey}#${etag}:${sizeBytes}`);
                return 'removed';
            },
        },
    });
    const response = await finalize(router);
    assert.equal(response.statusCode, 422);
    const body = response.body as Record<string, unknown>;
    assert.equal(body.code, 'scan_infected');
    assert.equal(body.upload_status, 'quarantined');
    assert.equal(body.scan_status, 'infected');
    assert.deepEqual(removed, [`${STORAGE_KEY}#etag-1:2048`],
        'the quarantined object is not left readable, and only the scanned version is removed');
    assert.deepEqual(mutableRemovals, [], 'a verdict never triggers a mutable-key delete');
    const update = executed.find((e) => e.sql.includes('UPDATE assignment_submissions'));
    assert.ok(update);
    assert.equal(update!.params[1], 'infected');
    assert.ok(auditActions(executed).includes('assignment.submission.finalize'));
});

test('finalize: an infected verdict with no exact-version capability quarantines and leaves cleanup pending', async () => {
    const mutableRemovals: string[] = [];
    const infectedScanner: MalwareScanner = { scan: async () => ({ verdict: 'infected' }) };
    const { router, executed } = build({
        scanner: infectedScanner,
        // No capability: this is the production MinIO adapter's declared shape.
        store: { removeObject: async (key) => { mutableRemovals.push(key); } },
    });
    const response = await finalize(router);
    assert.equal(response.statusCode, 422);
    const body = response.body as Record<string, unknown>;
    assert.equal(body.code, 'scan_infected');
    assert.equal(body.scan_status, 'infected', 'the row is quarantined and stays unreadable');
    assert.deepEqual(mutableRemovals, [],
        'no delete is attempted at all when the store cannot name the exact version');
    const update = executed.find((e) => e.sql.includes('UPDATE assignment_submissions'));
    assert.ok(update);
    assert.equal(update!.params[1], 'infected');
});

test('finalize: an object replaced between the verification re-stat and the quarantine delete keeps the new bytes', async () => {
    let currentEtag = 'etag-1';
    const destroyed: string[] = [];
    const mutableRemovals: string[] = [];
    const infectedScanner: MalwareScanner = { scan: async () => ({ verdict: 'infected' }) };
    const { router } = build({
        scanner: infectedScanner,
        store: {
            statObject: async () => ({
                sizeBytes: 2048, contentType: 'application/pdf', etag: currentEtag, lastModified: null,
            }),
            capabilities: { conditionalDelete: true },
            removeObject: async (key) => { mutableRemovals.push(key); },
            removeObjectVersion: async ({ etag, sizeBytes }) => {
                if (currentEtag !== etag) return 'version_replaced';
                destroyed.push(`${etag}:${sizeBytes}`);
                return 'removed';
            },
        },
        // A concurrent uploader rewrites the key while the finalize write is in
        // flight: after the verification re-stat, before the quarantine delete.
        execute: async (sql, params) => {
            if (sql.includes('UPDATE assignment_submissions')) currentEtag = 'etag-2';
            return makeFakeDataAccess(() => []).execute(sql, params);
        },
    });
    const response = await finalize(router);
    assert.equal(response.statusCode, 422);
    assert.equal((response.body as { scan_status?: string }).scan_status, 'infected',
        'the row is still quarantined, never clean');
    assert.deepEqual(destroyed, [], 'the replacement upload is never deleted');
    assert.deepEqual(mutableRemovals, [], 'no mutable-key delete is issued');
});

/* ------------------------------------------------------------------------- */
/* Rejection and cancel cleanup: exact version, never the mutable key         */
/* ------------------------------------------------------------------------- */

/** One immutable version of the object at the (single, mutable) storage key. */
interface ObjectVersionFact {
    etag: string;
    sizeBytes: number;
    contentType?: string | null;
    prefix?: Buffer;
}

interface RejectionStoreOptions {
    /** The version the server is allowed to observe when it stats the key. */
    stat: ObjectVersionFact;
    /**
     * The version actually live when a delete arrives. Defaults to `stat`; set
     * it to model a concurrent re-upload that landed after the stat.
     */
    live?: ObjectVersionFact;
    /** False ⇒ the adapter can only delete by key (the production MinIO shape). */
    exactVersion?: boolean;
}

/**
 * A fake store over one mutable key holding immutable versions.
 *
 * The version-bound delete is enforced by the store itself, exactly as a real
 * conditional delete is: it compares the precondition against the version that
 * is live when the delete arrives and answers `version_replaced` instead of
 * destroying a different version. The capability gate and the precondition
 * binding both live in the code under test, so nothing here pre-decides whether
 * a delete is legal or what it is allowed to destroy.
 */
const makeRejectionStore = (options: RejectionStoreOptions) => {
    const { stat } = options;
    const live = options.live ?? stat;
    const exact = options.exactVersion !== false;
    const destroyed: string[] = [];
    const mutableRemovals: string[] = [];
    const versionRemovals: string[] = [];
    const store: AssignmentObjectStore = {
        statObject: async () => ({
            sizeBytes: stat.sizeBytes,
            contentType: stat.contentType ?? 'application/pdf',
            etag: stat.etag,
            lastModified: null,
        }),
        readPrefix: async () => stat.prefix ?? Buffer.from('%PDF-1.7\n', 'ascii'),
        createUploadUrl: async ({ objectKey, expiresInSeconds }) =>
            `https://storage.invalid/private/${objectKey}?expires=${expiresInSeconds}`,
        removeObject: async (key) => { mutableRemovals.push(key); },
        ...(exact
            ? {
                capabilities: { conditionalDelete: true },
                removeObjectVersion: async ({ objectKey, etag, sizeBytes }) => {
                    versionRemovals.push(`${objectKey}#${etag}:${sizeBytes}`);
                    if (etag !== live.etag || sizeBytes !== live.sizeBytes) return 'version_replaced';
                    destroyed.push(`${objectKey}#${etag}:${sizeBytes}`);
                    return 'removed';
                },
            }
            : {}),
    };
    return { store, destroyed, mutableRemovals, versionRemovals };
};

/**
 * The route reports a pending version-exact cleanup through its operator log,
 * because the denial response body is part of the frozen contract. Capture
 * `console.error` for the duration of one call so a test can assert the report.
 */
const withCapturedErrors = async (fn: () => Promise<void>): Promise<string[]> => {
    const original = console.error;
    const lines: string[] = [];
    console.error = (...args: unknown[]) => { lines.push(args.map((arg) => String(arg)).join(' ')); };
    try {
        await fn();
    } finally {
        console.error = original;
    }
    return lines;
};

const REPLACEMENT = { etag: 'etag-2', sizeBytes: 4096 };

/** The four admission denials that clean up after themselves. */
const denialBranches: Array<{
    name: string;
    status: number;
    code: string;
    stat: ObjectVersionFact;
}> = [
    {
        name: 'size over the assignment limit',
        status: 413,
        code: 'file_size_out_of_bounds',
        stat: { etag: 'etag-1', sizeBytes: 2000000 },
    },
    {
        name: 'a verified size outside the allowed window',
        status: 400,
        code: 'file_size_out_of_bounds',
        stat: { etag: 'etag-1', sizeBytes: 5 },
    },
    {
        name: 'a stored content-type mismatch',
        status: 422,
        code: 'content_type_mismatch',
        stat: { etag: 'etag-1', sizeBytes: 2048, contentType: 'text/html' },
    },
    {
        name: 'a signature mismatch',
        status: 422,
        code: 'signature_mismatch',
        stat: {
            etag: 'etag-1',
            sizeBytes: 2048,
            prefix: Buffer.from('<html><body>not a pdf</body></html>', 'ascii'),
        },
    },
];

for (const branch of denialBranches) {
    test(`finalize: ${branch.name} removes exactly the stat'ed version, never the mutable key`, async () => {
        const { store, destroyed, mutableRemovals, versionRemovals } = makeRejectionStore({ stat: branch.stat });
        const { router, executed } = build({ store });

        const response = await finalize(router);
        assert.equal(response.statusCode, branch.status);
        assert.equal((response.body as { code?: string }).code, branch.code);
        assert.deepEqual(destroyed, [`${STORAGE_KEY}#${branch.stat.etag}:${branch.stat.sizeBytes}`],
            'the rejected version is the one the server stat\'ed, destroyed by exact version');
        assert.deepEqual(versionRemovals, destroyed, 'the delete names the stat\'ed version');
        assert.deepEqual(mutableRemovals, [], 'a denial never deletes by mutable key');
        assert.equal(executed.some((e) => e.sql.includes('UPDATE assignment_submissions')), false,
            'a rejected upload is never recorded');
    });

    test(`finalize: ${branch.name} after a concurrent re-upload keeps the replacement and deletes nothing`, async () => {
        // The key was rewritten between the server's stat and the cleanup: the
        // store now holds a different version than the one that was rejected.
        const { store, destroyed, mutableRemovals, versionRemovals } = makeRejectionStore({
            stat: branch.stat,
            live: REPLACEMENT,
        });
        const { router } = build({ store });

        const response = await finalize(router);
        assert.equal(response.statusCode, branch.status, 'the denial is unchanged by the race');
        assert.equal((response.body as { code?: string }).code, branch.code);
        assert.deepEqual(destroyed, [], 'the concurrent re-upload survives the cleanup');
        assert.deepEqual(mutableRemovals, [], 'no mutable-key delete is issued');
        assert.deepEqual(versionRemovals, [`${STORAGE_KEY}#${branch.stat.etag}:${branch.stat.sizeBytes}`],
            'the store was still asked to delete only the stat\'ed version, and refused');
    });

    test(`finalize: ${branch.name} on a key-only adapter deletes nothing and reports the cleanup pending`, async () => {
        const { store, mutableRemovals, versionRemovals } = makeRejectionStore({
            stat: branch.stat,
            exactVersion: false,
        });
        const { router } = build({ store });

        const response = await finalize(router);
        assert.equal(response.statusCode, branch.status, 'the denial is unchanged without the capability');
        assert.equal((response.body as { code?: string }).code, branch.code);
        assert.deepEqual(mutableRemovals, [], 'nothing is deleted when the version cannot be proven');
        assert.deepEqual(versionRemovals, [], 'no exact-version delete is even attempted');

        const reports = await withCapturedErrors(async () => { await finalize(router); });
        assert.ok(reports.some((line) => line.includes('Assignment rejection cleanup pending')),
            'the pending cleanup is reported to the operator, never claimed as done');
    });
}

test('finalize: a scanner that cannot answer is 502 and leaves the row retryable', async () => {
    const failedScanner: MalwareScanner = { scan: async () => ({ verdict: 'failed', reason: 'timeout' }) };
    const failed = build({ scanner: failedScanner });
    const failedRes = await finalize(failed.router);
    assert.equal(failedRes.statusCode, 502);
    assert.equal((failedRes.body as { code?: string }).code, 'scan_unavailable');
    assert.equal(failed.executed.some((e) => e.sql.includes('UPDATE assignment_submissions')), false);
    assert.equal(auditActions(failed.executed).length, 0);

    const throwing: MalwareScanner = { scan: async () => { throw new Error('scanner offline'); } };
    const thrown = build({ scanner: throwing });
    assert.equal((await finalize(thrown.router)).statusCode, 502);
    assert.equal(thrown.executed.some((e) => e.sql.includes('UPDATE assignment_submissions')), false);
});

/* ------------------------------------------------------------------------- */
/* Races                                                                     */
/* ------------------------------------------------------------------------- */

test('finalize: a racing winner with the same verified size is answered idempotently', async () => {
    let reads = 0;
    const { router, executed } = build({
        submissionReads: () => {
            reads += 1;
            return reads === 1 ? pendingSubmission() : finalizedSubmission();
        },
        execute: async (sql, params) => {
            if (sql.includes('UPDATE assignment_submissions')) return { affectedRows: 0 };
            return makeFakeDataAccess(() => []).execute(sql, params);
        },
    });
    const response = await finalize(router);
    assert.equal(response.statusCode, 200);
    assert.equal((response.body as { upload_status?: string }).upload_status, 'pending_scan');
    assert.equal(reads, 2, 'the loser re-reads committed state');
    assert.equal(auditActions(executed).length, 0, 'the loser never audits');
});

test('finalize: a racing winner with a different size is 409', async () => {
    let reads = 0;
    const { router } = build({
        submissionReads: () => {
            reads += 1;
            return reads === 1 ? pendingSubmission() : { ...finalizedSubmission(), file_size_bytes: 4096 };
        },
        execute: async (sql, params) => {
            if (sql.includes('UPDATE assignment_submissions')) return { affectedRows: 0 };
            return makeFakeDataAccess(() => []).execute(sql, params);
        },
    });
    const response = await finalize(router);
    assert.equal(response.statusCode, 409);
    assert.equal((response.body as { code?: string }).code, 'finalize_conflict');
});

/* ------------------------------------------------------------------------- */
/* Upload authorization re-issue                                             */
/* ------------------------------------------------------------------------- */

const authorize = (router: ReturnType<typeof build>['router'], token = STUDENT_A) =>
    invokeRoute(router, {
        method: 'POST', url: '/a-1/submissions/sub-1/upload-authorization', token,
    });

test('upload authorization: a pending own version gets a fresh short-lived URL', async () => {
    const { router } = build();
    const response = await authorize(router);
    assert.equal(response.statusCode, 200);
    const body = response.body as Record<string, unknown>;
    assert.equal(body.upload_status, 'pending_upload');
    const upload = body.upload as Record<string, unknown>;
    assert.equal(upload.expires_in_seconds, 300);
    assert.match(String(upload.url), /tenants\/tenant-a\/assignments\/a-1\/enr-a\/sub-1\.pdf/);
});

test('upload authorization: finalized, revoked and foreign versions are refused', async () => {
    assert.equal((await authorize(build({ submission: finalizedSubmission() }).router)).statusCode, 409);
    const revoked = build({ submission: { ...pendingSubmission(), status: 'revoked' } });
    const revokedRes = await authorize(revoked.router);
    assert.equal(revokedRes.statusCode, 409);
    assert.equal((revokedRes.body as { code?: string }).code, 'submission_revoked');
    assert.equal((await authorize(build({ submission: null }).router)).statusCode, 404);
});

test('upload authorization: a forged key is 409 and a storage failure is 502', async () => {
    const forged = build({
        submission: { ...pendingSubmission(), storage_key: 'tenants/tenant-a/assignments/a-1/enr-a/sub-9.pdf' },
    });
    assert.equal((await authorize(forged.router)).statusCode, 409);

    const failing = build({
        store: { createUploadUrl: async () => { throw new Error('signing failed'); } },
    });
    const response = await authorize(failing.router);
    assert.equal(response.statusCode, 502);
    assert.equal((response.body as { code?: string }).code, 'storage_unavailable');
});

test('upload authorization: a closed window is 403 before signing', async () => {
    let signed = 0;
    const { router } = build({
        assignment: { ...ASSIGNMENT, status: 'closed' },
        store: {
            createUploadUrl: async () => {
                signed += 1;
                return 'https://storage.invalid/x';
            },
        },
    });
    const response = await authorize(router);
    assert.equal(response.statusCode, 403);
    assert.equal(signed, 0);
});

test('adapter: the bounded signature read never exceeds the documented cap', () => {
    assert.equal(MAX_SIGNATURE_PREFIX_BYTES, 4096);
});

/* ------------------------------------------------------------------------- */
/* Bucket provisioning (injected adapter)                                     */
/* ------------------------------------------------------------------------- */

type ProvisioningCall = { kind: 'exists' | 'make' | 'policy'; bucket: string };

/**
 * A fake provisioning client. `setBucketPolicy` is a tripwire: a bucket
 * policy is the only way a MinIO bucket becomes public, so any call during
 * initialization fails the test loudly instead of silently granting access.
 */
const makeProvisioningClient = (existing: Set<string>): {
    client: BucketProvisioningClient;
    calls: ProvisioningCall[];
} => {
    const calls: ProvisioningCall[] = [];
    const client: BucketProvisioningClient & {
        setBucketPolicy: (bucket: string, policy: string) => Promise<void>;
    } = {
        bucketExists: async (bucket) => {
            calls.push({ kind: 'exists', bucket });
            return existing.has(bucket);
        },
        makeBucket: async (bucket) => {
            calls.push({ kind: 'make', bucket });
            existing.add(bucket);
        },
        setBucketPolicy: async (bucket) => {
            calls.push({ kind: 'policy', bucket });
            throw new Error('bucket provisioning must never set a bucket policy');
        },
    };
    return { client, calls };
};

test('bucket initialization: creates the missing private assignment bucket and never grants public access', async () => {
    const { BUCKETS, createBucketInitializer } = await import('../src/services/minio');

    assert.equal(BUCKETS.ASSIGNMENTS, 'assignment-submissions');
    assert.deepEqual(
        [BUCKETS.ORIGINALS, BUCKETS.HLS, BUCKETS.THUMBNAILS, BUCKETS.PREVIEWS, BUCKETS.PAYMENT_PROOFS],
        ['videos-original', 'videos-hls', 'videos-thumbnails', 'video-previews', 'payment-proofs'],
        'the video and payment buckets keep their existing names',
    );

    const existing = new Set<string>([
        BUCKETS.ORIGINALS, BUCKETS.HLS, BUCKETS.THUMBNAILS, BUCKETS.PREVIEWS, BUCKETS.PAYMENT_PROOFS,
    ]);
    const { client, calls } = makeProvisioningClient(existing);
    await createBucketInitializer(client)();

    assert.deepEqual(
        calls.filter((call) => call.kind === 'exists').map((call) => call.bucket),
        Object.values(BUCKETS),
        'every configured bucket is probed, including the private assignment bucket',
    );
    assert.deepEqual(
        calls.filter((call) => call.kind === 'make').map((call) => call.bucket),
        [BUCKETS.ASSIGNMENTS],
        'only the missing assignment bucket is created; existing buckets are preserved untouched',
    );
    assert.deepEqual(
        calls.filter((call) => call.kind === 'policy'),
        [],
        'no bucket policy is ever set: the assignment bucket, like every bucket, stays private',
    );
});

test('bucket initialization: existing buckets are never re-created or re-policed', async () => {
    const { BUCKETS, createBucketInitializer } = await import('../src/services/minio');
    const existing = new Set<string>(Object.values(BUCKETS));
    const { client, calls } = makeProvisioningClient(existing);
    await createBucketInitializer(client)();

    assert.deepEqual(calls.filter((call) => call.kind === 'make'), [], 'provisioning is idempotent');
    assert.deepEqual(calls.filter((call) => call.kind === 'policy'), []);
});

/* ------------------------------------------------------------------------- */
/* Object replacement between verification and scan                           */
/* ------------------------------------------------------------------------- */

test('finalize: an object replaced between verification and scan cannot keep a stale clean verdict', async () => {
    const scanInputs: MalwareScanInput[] = [];
    let statCalls = 0;
    const cleanScanner: MalwareScanner = {
        scan: async (input) => {
            scanInputs.push(input);
            return { verdict: 'clean' };
        },
    };
    const { router, executed } = build({
        scanner: cleanScanner,
        store: {
            statObject: async () => {
                statCalls += 1;
                return statCalls === 1
                    ? { sizeBytes: 2048, contentType: 'application/pdf', etag: 'etag-1', lastModified: null }
                    : { sizeBytes: 4096, contentType: 'application/pdf', etag: 'etag-2', lastModified: null };
            },
        },
    });
    const response = await finalize(router);
    assert.equal(response.statusCode, 409);
    assert.equal((response.body as { code?: string }).code, 'object_replaced');
    assert.equal(scanInputs.length, 1);
    assert.equal(scanInputs[0].etag, 'etag-1', 'the scanner is bound to the stat\'ed object version');
    assert.equal(scanInputs[0].objectKey, STORAGE_KEY);
    assert.equal(statCalls, 2, 'the object is re-stat\'ed after the scan');
    assert.equal(executed.some((e) => e.sql.includes('UPDATE assignment_submissions')), false,
        'a verdict for a replaced object never writes a row');
    assert.equal(auditActions(executed).length, 0);
});

test('finalize: a replaced object is refused even without a scanner (recorded size stays true)', async () => {
    const replacedByEtag = build({
        store: {
            statObject: (() => {
                let calls = 0;
                return async () => {
                    calls += 1;
                    return calls === 1
                        ? { sizeBytes: 2048, contentType: 'application/pdf', etag: 'etag-1', lastModified: null }
                        : { sizeBytes: 2048, contentType: 'application/pdf', etag: 'etag-2', lastModified: null };
                };
            })(),
        },
    });
    const etagResponse = await finalize(replacedByEtag.router);
    assert.equal(etagResponse.statusCode, 409);
    assert.equal((etagResponse.body as { code?: string }).code, 'object_replaced');
    assert.equal(replacedByEtag.executed.some((e) => e.sql.includes('UPDATE assignment_submissions')), false);

    const replacedBySize = build({
        store: {
            statObject: (() => {
                let calls = 0;
                return async () => {
                    calls += 1;
                    return calls === 1
                        ? { sizeBytes: 2048, contentType: 'application/pdf', etag: 'etag-1', lastModified: null }
                        : { sizeBytes: 4096, contentType: 'application/pdf', etag: 'etag-1', lastModified: null };
                };
            })(),
        },
    });
    const sizeResponse = await finalize(replacedBySize.router);
    assert.equal(sizeResponse.statusCode, 409);
    assert.equal((sizeResponse.body as { code?: string }).code, 'object_replaced',
        'a same-ETag size change is still a replacement');
});

/* ------------------------------------------------------------------------- */
/* Bounded scanner execution                                                  */
/* ------------------------------------------------------------------------- */

test('finalize: a scan that exceeds the wall-clock bound fails closed, never clean', async () => {
    const hanging: MalwareScanner = { scan: () => new Promise(() => undefined) };
    const { router, executed } = build({ scanner: hanging, scanTimeoutMs: 50 });
    const response = await finalize(router);
    assert.equal(response.statusCode, 502);
    assert.equal((response.body as { code?: string }).code, 'scan_unavailable');
    assert.equal(executed.some((e) => e.sql.includes('UPDATE assignment_submissions')), false);
    assert.equal(auditActions(executed).length, 0);
});

test('finalize: a fast scan still finalizes under the same small bound', async () => {
    const { router } = build({
        scanner: { scan: async () => ({ verdict: 'clean' }) },
        scanTimeoutMs: 50,
    });
    const response = await finalize(router);
    assert.equal(response.statusCode, 200);
    assert.equal((response.body as { scan_status?: string }).scan_status, 'clean');
});

/* ------------------------------------------------------------------------- */
/* Immutable object/version binding at readiness                              */
/* ------------------------------------------------------------------------- */

test('finalize: an adapter that cannot express an object version fails closed', async () => {
    for (const etag of [null, '']) {
        let removals = 0;
        const { router, executed } = build({
            store: {
                statObject: async () => ({
                    sizeBytes: 2048, contentType: 'application/pdf', etag, lastModified: null,
                }),
                removeObject: async () => { removals += 1; },
            },
        });
        const response = await finalize(router);
        assert.equal(response.statusCode, 503, `etag=${String(etag)} cannot be verified`);
        assert.equal((response.body as { code?: string }).code, 'object_version_unbound');
        assert.equal(executed.some((e) => e.sql.includes('UPDATE assignment_submissions')), false,
            'an unbound object never becomes ready');
        assert.equal(auditActions(executed).length, 0);
        assert.equal(removals, 0, 'an unverifiable object is not destroyed');
    }
});

test('finalize: the scanned version and the recorded version are the same object', async () => {
    const scanInputs: MalwareScanInput[] = [];
    const { router, executed } = build({
        scanner: {
            scan: async (input) => {
                scanInputs.push(input);
                return { verdict: 'clean' };
            },
        },
        store: {
            statObject: async () => ({
                sizeBytes: 2048, contentType: 'application/pdf', etag: 'etag-bound', lastModified: null,
            }),
        },
    });
    const response = await finalize(router);
    assert.equal(response.statusCode, 200);
    assert.equal(scanInputs.length, 1);
    assert.equal(scanInputs[0].etag, 'etag-bound', 'the verdict is produced for the stat\'ed version');
    const update = executed.find((e) => e.sql.includes('UPDATE assignment_submissions'));
    assert.ok(update);
    assert.equal(update!.params[0], 2048, 'the recorded size is the size of the verified version');
});

/* ------------------------------------------------------------------------- */
/* Duplicate finalize / concurrent retry                                      */
/* ------------------------------------------------------------------------- */

test('finalize: two concurrent finalizes record exactly one verdict and never a second version', async () => {
    const state = pendingSubmission();
    const updates: unknown[][] = [];
    let audits = 0;
    const cleanScanner: MalwareScanner = {
        scan: async () => {
            await new Promise((resolve) => setImmediate(resolve));
            return { verdict: 'clean' };
        },
    };
    const { router, executed } = build({
        submissionReads: () => ({ ...state }),
        scanner: cleanScanner,
        execute: async (sql, params = []) => {
            if (sql.includes('UPDATE assignment_submissions')) {
                const [size, scanStatus, id, assignmentId, tenantId, enrollmentId] = params as [
                    number, string, string, string, string, string,
                ];
                // The conditional update the SQL predicate performs, atomically.
                if (state.file_size_bytes !== 0 || state.scan_status !== 'pending') return { affectedRows: 0 };
                if (state.id !== id || state.assignment_id !== assignmentId
                    || state.tenant_id !== tenantId || state.student_enrollment_id !== enrollmentId) {
                    return { affectedRows: 0 };
                }
                state.file_size_bytes = size;
                state.scan_status = scanStatus;
                updates.push(params);
                return { affectedRows: 1 };
            }
            if (sql.includes('INSERT INTO audit_events')) audits += 1;
            return { affectedRows: 1, insertId: 0 };
        },
    });

    const [first, second] = await Promise.all([finalize(router), finalize(router)]);
    assert.equal(updates.length, 1, 'exactly one conditional write wins');
    assert.equal(audits, 1, 'the loser never audits');
    assert.equal(executed.some((e) => e.sql.includes('INSERT INTO assignment_submissions')), false,
        'finalize never creates a second version of the same submission');
    assert.deepEqual([first.statusCode, second.statusCode], [200, 200],
        'the loser re-reads the committed winner and answers idempotently');
    for (const response of [first, second]) {
        assert.equal((response.body as { scan_status?: string }).scan_status, 'clean');
        assert.equal((response.body as { file_size_bytes?: number }).file_size_bytes, 2048);
    }
});

test('finalize: a racing winner that recorded a different verdict is a conflict, not a success', async () => {
    let reads = 0;
    const { router } = build({
        submissionReads: () => {
            reads += 1;
            return reads === 1
                ? pendingSubmission()
                : { ...finalizedSubmission(), scan_status: 'infected' };
        },
        execute: async (sql, params) => {
            if (sql.includes('UPDATE assignment_submissions')) return { affectedRows: 0 };
            return makeFakeDataAccess(() => []).execute(sql, params);
        },
    });
    const response = await finalize(router);
    assert.equal(response.statusCode, 409);
    assert.equal((response.body as { code?: string }).code, 'finalize_conflict',
        'a clean attempt must never be answered as if it produced the recorded infected state');
});

test('finalize: a revoke that wins the race is never recorded as a ready version', async () => {
    let reads = 0;
    const updates: string[] = [];
    const { router, executed } = build({
        submissionReads: () => {
            reads += 1;
            return reads === 1
                ? pendingSubmission()
                : { ...pendingSubmission(), status: 'revoked', revoked_at: '2026-01-01 00:00:01' };
        },
        execute: async (sql, params) => {
            if (sql.includes('UPDATE assignment_submissions')) {
                updates.push(sql);
                return { affectedRows: 0 };
            }
            return makeFakeDataAccess(() => []).execute(sql, params);
        },
    });
    const response = await finalize(router);
    assert.equal(response.statusCode, 409);
    assert.equal((response.body as { code?: string }).code, 'submission_revoked',
        'a revoked version must never be reported as finalized/ready');
    assert.equal(updates.length, 1);
    assert.match(updates[0], /status<>'revoked'/,
        'the conditional write cannot land on a row a staff revoke already owns');
    assert.equal(auditActions(executed).length, 0, 'a revoked version is never audited as finalized');
});

/* ------------------------------------------------------------------------- */
/* Admission size: what the adapter can and cannot enforce                    */
/* ------------------------------------------------------------------------- */

const createSubmission = (router: ReturnType<typeof build>['router']) =>
    invokeRoute(router, {
        method: 'POST', url: '/a-1/submissions', token: STUDENT_A,
        body: { file_name: 'hw.pdf', file_type: 'application/pdf' },
    });

test('upload authorization: a store that signs a content-length range enforces the cap before admission', async () => {
    const signed: Array<{ objectKey: string; contentType: string; expiresInSeconds: number; maxBytes: number }> = [];
    const { router } = build({
        store: {
            createUploadAuthorization: async (input) => {
                signed.push(input);
                return {
                    method: 'POST',
                    url: `https://storage.invalid/post/${input.objectKey}`,
                    fields: { key: input.objectKey, policy: 'signed-range' },
                    maxBytesEnforced: true,
                };
            },
        },
    });
    const response = await createSubmission(router);
    assert.equal(response.statusCode, 201);
    const upload = (response.body as { upload: Record<string, unknown> }).upload;
    assert.equal(upload.method, 'POST');
    assert.equal(upload.max_bytes_enforced, true);
    assert.equal(upload.max_bytes_enforcement, 'signed_content_length_range');
    assert.equal(upload.max_bytes, 1000000);
    assert.deepEqual(upload.fields, { key: signed[0].objectKey, policy: 'signed-range' });
    assert.equal(signed.length, 1);
    assert.equal(signed[0].maxBytes, 1000000, 'the signed range is the assignment maximum');
    assert.match(signed[0].objectKey, /^tenants\/tenant-a\/assignments\/a-1\/enr-a\/[0-9a-f-]{36}\.pdf$/);
});

test('upload authorization: presigned PUT cannot bind a length and the response says so', async () => {
    const { router } = build();
    const response = await createSubmission(router);
    assert.equal(response.statusCode, 201);
    const upload = (response.body as { upload: Record<string, unknown> }).upload;
    assert.equal(upload.method, 'PUT');
    assert.equal(upload.max_bytes, 1000000);
    assert.equal(upload.max_bytes_enforced, false,
        'a JSON max_bytes never constrains the PUT body');
    assert.equal(upload.max_bytes_enforcement, 'finalize_stat_only');
});

/* ------------------------------------------------------------------------- */
/* No object-serving endpoint                                                 */
/* ------------------------------------------------------------------------- */

test('download: the router exposes no endpoint that serves a stored object', () => {
    const { router } = build();
    const stack = (router as unknown as {
        stack: Array<{ route?: { path: string; methods: Record<string, boolean> } }>;
    }).stack;
    const routes = stack
        .filter((layer) => layer.route !== undefined)
        .map((layer) => `${Object.keys(layer.route!.methods).sort().join('|').toUpperCase()} ${layer.route!.path}`)
        .sort();
    assert.deepEqual(routes, [
        'GET /',
        'GET /:id',
        'GET /:id/submissions',
        'GET /:id/submissions/mine',
        'GET /student',
        'PATCH /:id',
        'POST /',
        'POST /:id/archive',
        'POST /:id/publish',
        'POST /:id/submissions',
        'POST /:id/submissions/:submissionId/cancel',
        'POST /:id/submissions/:submissionId/finalize',
        'POST /:id/submissions/:submissionId/revoke',
        'POST /:id/submissions/:submissionId/upload-authorization',
    ].sort(), 'no route serves object bytes: staff can never read a pending or foreign file');
    for (const route of routes) {
        assert.equal(/file|download|object|content|bytes|url/i.test(route), false,
            `${route} looks like an object-serving route`);
    }
});
