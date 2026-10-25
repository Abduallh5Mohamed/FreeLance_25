import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import { createAuthenticateToken } from '../src/middleware/auth';
import type { BranchAccessDeps } from '../src/security/branch-access';
import {
    buildSubmissionStorageKey,
    enrollmentMatchesAssignment,
    evaluateSubmission,
    evaluateSubmissionWindow,
    normalizeAllowedFileTypes,
    normalizeLatePolicy,
    normalizeResubmissionPolicy,
    validateAssignmentInput,
    validateUploadRequest,
    validateVerifiedUpload,
} from '../src/services/assignments';
import { createAssignmentsRouter, type AssignmentsDataAccess } from '../src/routes/assignments';
import type { AssignmentObjectStore, MalwareScanner } from '../src/services/assignment-storage';
import {
    ExecutedStatement,
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

const INSTRUCTOR_A = tokenFor({ id: 'instructor-a', role: 'instructor', tv: 0, tenant_id: 'tenant-a' });
const OWNER_A = tokenFor({ id: 'owner-a', role: 'instructor', tv: 0, tenant_id: 'tenant-a' });
const INSTRUCTOR_B = tokenFor({ id: 'instructor-b', role: 'instructor', tv: 0, tenant_id: 'tenant-b' });
const STUDENT_A = tokenFor({ id: 'student-a', role: 'student', tv: 0, student_enrollment_id: 'enr-a' });
const STUDENT_B = tokenFor({ id: 'student-b', role: 'student', tv: 0, student_enrollment_id: 'enr-b' });

// ---------------------------------------------------------------------------
// Pure domain policy
// ---------------------------------------------------------------------------

test('enums: late/resubmission policies and file types normalize, junk rejected', () => {
    assert.equal(normalizeLatePolicy('block'), 'block');
    assert.equal(normalizeLatePolicy('mark_late'), 'mark_late');
    assert.equal(normalizeLatePolicy('accept'), 'accept');
    assert.equal(normalizeLatePolicy('late'), null);
    assert.equal(normalizeResubmissionPolicy('allow'), 'allow');
    assert.equal(normalizeResubmissionPolicy('block'), 'block');
    assert.equal(normalizeResubmissionPolicy('once'), null);
    assert.deepEqual(normalizeAllowedFileTypes(['PDF', '.docx']), ['pdf', 'docx']);
    assert.equal(normalizeAllowedFileTypes([]), null);
    assert.equal(normalizeAllowedFileTypes(['not a type']), null);
});

test('validateAssignmentInput: valid tenant assignment and Cairo deadline -> UTC', () => {
    const result = validateAssignmentInput({
        title: 'Essay 1', instructions: 'Do it', deadline: '2026-06-01 09:00', deadline_timezone: 'Africa/Cairo',
        late_policy: 'mark_late', max_submissions: 2,
    });
    assert.equal(result.ok, true);
    if (result.ok) {
        assert.equal(result.value.deadlineUtc, '2026-06-01T06:00:00.000Z');
        assert.equal(result.value.deadlineTimeZone, 'Africa/Cairo');
        assert.equal(result.value.maxSubmissions, 2);
        assert.equal(result.value.maxFileBytes, 25 * 1024 * 1024);
    }
});

test('validateAssignmentInput: rejects malformed scope/deadline/limits', () => {
    assert.equal(validateAssignmentInput({}).ok, false);
    assert.equal(validateAssignmentInput({ title: 't', branch_scope: 'branch' }).ok, false);
    assert.equal(validateAssignmentInput({ title: 't', branch_scope: 'branch', branch_id: 'br-1', group_id: 'grp-1' }).ok, false);
    assert.equal(validateAssignmentInput({ title: 't', branch_scope: 'tenant', branch_id: 'br-1' }).ok, false);
    assert.equal(validateAssignmentInput({ title: 't', deadline: 'not-a-date' }).ok, false);
    assert.equal(validateAssignmentInput({ title: 't', deadline: '2026-06-01 09:00', deadline_timezone: 'Not/AZone' }).ok, false);
    assert.equal(validateAssignmentInput({ title: 't', late_policy: 'whenever' }).ok, false);
    assert.equal(validateAssignmentInput({ title: 't', max_submissions: 0 }).ok, false);
    assert.equal(validateAssignmentInput({ title: 't', max_file_bytes: 10 }).ok, false);
    assert.equal(validateAssignmentInput({ title: 't', allowed_file_types: [] }).ok, false);
});

const LIMITS = { maxFileBytes: 1000, allowedFileTypes: ['pdf'] };

test('validateUploadRequest: descriptive metadata only; client storage_key rejected; size claims ignored', () => {
    // The client-declared file_size_bytes is ignored entirely (server-verified later).
    const good = validateUploadRequest(
        { file_name: 'hw.pdf', file_type: 'application/pdf', file_size_bytes: 999999 }, LIMITS,
    );
    assert.equal(good.ok, true);
    if (good.ok) assert.equal(good.value.extension, 'pdf');

    assert.equal(validateUploadRequest({ file_name: 'hw.pdf', file_type: 'application/pdf', storage_key: 'tenants/x/y.pdf' }, LIMITS).ok, false,
        'a client-supplied storage_key is rejected: the key is server-owned');
    assert.equal(validateUploadRequest({ file_name: 'hw.pdf', file_type: 'application/pdf', storage_key: '' }, LIMITS).ok, true,
        'an empty storage_key is treated as absent');
    assert.equal(validateUploadRequest({ file_name: '../evil.pdf', file_type: 'application/pdf' }, LIMITS).ok, false);
    assert.equal(validateUploadRequest({ file_name: 'hw.exe', file_type: 'application/octet-stream' }, LIMITS).ok, false);
    assert.equal(validateUploadRequest({ file_name: 'noext', file_type: 'x' }, LIMITS).ok, false);
});

test('validateVerifiedUpload: only the server-verified size is accepted against the limits', () => {
    const verifiedLimits = { maxFileBytes: 100000, allowedFileTypes: ['pdf'] };
    assert.deepEqual(validateVerifiedUpload(1500, verifiedLimits), { ok: true, value: 1500 });
    assert.equal(validateVerifiedUpload(200000, verifiedLimits).ok, false, 'above max_file_bytes');
    assert.equal(validateVerifiedUpload(5, verifiedLimits).ok, false, 'below the minimum');
    assert.equal(validateVerifiedUpload(0, verifiedLimits).ok, false);
    assert.equal(validateVerifiedUpload(1.5, verifiedLimits).ok, false);
});

test('buildSubmissionStorageKey: namespaced per tenant/assignment/enrollment/submission, server-only', () => {
    const key = buildSubmissionStorageKey({
        tenantId: 'tenant-a', assignmentId: 'a-1', enrollmentId: 'enr-a',
        submissionId: 'S1a2b3c4d5e6f7089a1b2c3d4e5f60718', fileExtension: 'pdf',
    });
    assert.equal(
        key,
        'tenants/tenant-a/assignments/a-1/enr-a/S1a2b3c4d5e6f7089a1b2c3d4e5f60718.pdf',
        'the client never supplies any part of the key',
    );
    assert.equal(buildSubmissionStorageKey({
        tenantId: '../evil', assignmentId: 'a-1', enrollmentId: 'enr-a',
        submissionId: 'S1', fileExtension: 'pdf',
    }), null);
    assert.equal(buildSubmissionStorageKey({
        tenantId: 'tenant-a', assignmentId: 'a-1', enrollmentId: 'enr-a',
        submissionId: 'S1', fileExtension: 'exe/exe!',
    }), null);
});

test('submission window: status, archive and late-policy behavior', () => {
    const base = { status: 'published', archived: false, deadlineUtc: null, latePolicy: 'block' };
    assert.deepEqual(evaluateSubmissionWindow(base, new Date()), { open: true, late: false });
    assert.deepEqual(evaluateSubmissionWindow({ ...base, status: 'draft' }, new Date()), { open: false, reason: 'not_published' });
    assert.deepEqual(evaluateSubmissionWindow({ ...base, status: 'closed' }, new Date()), { open: false, reason: 'closed' });
    assert.deepEqual(evaluateSubmissionWindow({ ...base, archived: true }, new Date()), { open: false, reason: 'archived' });

    const after = new Date('2026-06-01T13:00:00Z');
    const deadline = '2026-06-01T12:00:00.000Z';
    assert.deepEqual(evaluateSubmissionWindow({ ...base, deadlineUtc: deadline }, after), { open: false, reason: 'deadline_passed' });
    assert.deepEqual(evaluateSubmissionWindow({ ...base, deadlineUtc: deadline, latePolicy: 'mark_late' }, after), { open: true, late: true });
    assert.deepEqual(evaluateSubmissionWindow({ ...base, deadlineUtc: deadline, latePolicy: 'accept' }, after), { open: true, late: false });
    assert.deepEqual(evaluateSubmissionWindow({ ...base, deadlineUtc: deadline }, new Date('2026-06-01T11:00:00Z')), { open: true, late: false });
});

test('evaluateSubmission: resubmission, limits, revoked slot reopens and version increments', () => {
    const assignment = { status: 'published', archived: false, deadlineUtc: null, latePolicy: 'block', resubmissionPolicy: 'allow', maxSubmissions: 2 };
    const now = new Date('2026-06-01T10:00:00Z');
    assert.deepEqual(evaluateSubmission(assignment, [], now), { allowed: true, late: false, nextVersion: 1 });
    assert.deepEqual(evaluateSubmission(assignment, [{ version: 1, status: 'submitted' }], now), { allowed: true, late: false, nextVersion: 2 });
    assert.deepEqual(
        evaluateSubmission(assignment, [{ version: 1, status: 'submitted' }, { version: 2, status: 'submitted' }], now),
        { allowed: false, reason: 'SUBMISSION_LIMIT_REACHED' },
    );
    assert.deepEqual(
        evaluateSubmission({ ...assignment, resubmissionPolicy: 'block' }, [{ version: 1, status: 'submitted' }], now),
        { allowed: false, reason: 'RESUBMISSION_BLOCKED' },
    );
    assert.deepEqual(
        evaluateSubmission({ ...assignment, resubmissionPolicy: 'block' }, [{ version: 1, status: 'revoked' }], now),
        { allowed: true, late: false, nextVersion: 2 },
        'a revoked version re-opens the slot',
    );
    assert.deepEqual(
        evaluateSubmission({ ...assignment, deadlineUtc: '2026-06-01T09:00:00.000Z' }, [], now),
        { allowed: false, reason: 'DEADLINE_PASSED' },
    );
});

test('enrollmentMatchesAssignment: deny-by-default tenant/branch/group/course scope', () => {
    const tenantWide = { tenantId: 'tenant-a', branchScope: 'tenant', branchId: null, groupId: null, courseId: null };
    assert.equal(enrollmentMatchesAssignment(tenantWide, { tenantId: 'tenant-a', branchId: 'br-1', groupId: 'grp-1', courseId: 'course-1' }), true);
    assert.equal(enrollmentMatchesAssignment(tenantWide, { tenantId: 'tenant-b', branchId: null, groupId: null, courseId: null }), false);
    const branch = { tenantId: 'tenant-a', branchScope: 'branch', branchId: 'br-1', groupId: null, courseId: null };
    assert.equal(enrollmentMatchesAssignment(branch, { tenantId: 'tenant-a', branchId: 'br-1', groupId: null, courseId: null }), true);
    assert.equal(enrollmentMatchesAssignment(branch, { tenantId: 'tenant-a', branchId: 'br-2', groupId: null, courseId: null }), false);
    const group = { tenantId: 'tenant-a', branchScope: 'tenant', branchId: null, groupId: 'grp-1', courseId: null };
    assert.equal(enrollmentMatchesAssignment(group, { tenantId: 'tenant-a', branchId: null, groupId: 'grp-1', courseId: null }), true);
    assert.equal(enrollmentMatchesAssignment(group, { tenantId: 'tenant-a', branchId: null, groupId: 'grp-2', courseId: null }), false);
    // A group audience takes precedence over the course fact.
    assert.equal(enrollmentMatchesAssignment(
        { ...group, courseId: 'course-9' },
        { tenantId: 'tenant-a', branchId: null, groupId: 'grp-1', courseId: null },
    ), true);
    const course = { tenantId: 'tenant-a', branchScope: 'tenant', branchId: null, groupId: null, courseId: 'course-1' };
    assert.equal(enrollmentMatchesAssignment(course, { tenantId: 'tenant-a', branchId: null, groupId: 'grp-1', courseId: 'course-1' }), true);
    assert.equal(enrollmentMatchesAssignment(course, { tenantId: 'tenant-a', branchId: null, groupId: 'grp-1', courseId: 'course-2' }), false);
    assert.equal(enrollmentMatchesAssignment(course, { tenantId: 'tenant-a', branchId: null, groupId: 'grp-1', courseId: null }), false,
        'a student group without a course never matches a course audience');
});

// ---------------------------------------------------------------------------
// Route harness
// ---------------------------------------------------------------------------

const AUTHORITY: Record<string, string> = { 'instructor-a': 'instructor', 'owner-a': 'owner' };

const ASSIGNMENT = {
    id: 'a-1', tenant_id: 'tenant-a', branch_id: null, branch_scope: 'tenant', course_id: null, group_id: null,
    title: 'HW', instructions: null, deadline_at: null, deadline_timezone: 'UTC', late_policy: 'block',
    resubmission_policy: 'allow', max_submissions: 5, max_file_bytes: 1000000, allowed_file_types: '["pdf"]',
    status: 'published', archived_at: null, version: 0,
};

const ENROLLMENT_A = { id: 'enr-a', user_id: 'student-a', tenant_id: 'tenant-a', instructor_id: 'instructor-a', group_id: 'grp-1', grade_id: null, branch_id: 'br-1', branch_scope: 'branch' };
const ENROLLMENT_B = { id: 'enr-b', user_id: 'student-b', tenant_id: 'tenant-a', instructor_id: 'instructor-a', group_id: 'grp-2', grade_id: null, branch_id: 'br-2', branch_scope: 'branch' };

const allowBranch: BranchAccessDeps = {
    findBranchById: async () => ({ id: 'br-1', tenant_id: 'tenant-a', status: 'active', version: 0 }),
    findMembership: async () => ({ id: 'bm-1', branch_id: 'br-1', user_id: 'instructor-a', role: 'instructor', status: 'active', version: 0 }),
};
const denyBranch: BranchAccessDeps = {
    findBranchById: async () => null,
    findMembership: async () => null,
};

/**
 * Hermetic object store. The URL points at an unresolvable host and is never
 * fetched: tests only assert that a short-lived private target was issued.
 */
const makeObjectStore = (overrides: Partial<AssignmentObjectStore> = {}): AssignmentObjectStore => ({
    statObject: async () => ({
        sizeBytes: 2000,
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

interface Fixtures {
    assignment?: Record<string, unknown> | null;
    assignments?: Record<string, unknown>[];
    submissions?: Record<string, unknown>[];
    submission?: Record<string, unknown> | null;
    course?: Record<string, unknown>[];
    group?: Record<string, unknown>[];
    enrollment?: Record<string, unknown> | null;
}

const build = (
    fixtures: Fixtures = {},
    opts: {
        now?: Date;
        branchAccess?: BranchAccessDeps;
        objectStore?: AssignmentObjectStore;
        malwareScanner?: MalwareScanner;
    } = {},
) => {
    const responder = (sql: string): unknown[] | null => {
        if (sql.includes('FROM students s LEFT JOIN')) return [fixtures.enrollment ?? ENROLLMENT_A];
        if (sql.includes('FROM assignments') && sql.includes('id = ?')) {
            return fixtures.assignment === null ? [] : [fixtures.assignment ?? ASSIGNMENT];
        }
        if (sql.includes('FROM assignments')) return fixtures.assignments ?? [ASSIGNMENT];
        if (sql.includes('FROM assignment_submissions') && sql.includes('WHERE id = ?')) {
            return fixtures.submission ? [fixtures.submission] : [];
        }
        if (sql.includes('FROM assignment_submissions')) return fixtures.submissions ?? [];
        if (sql.includes('FROM courses')) return fixtures.course ?? [];
        if (sql.includes('FROM `groups` g')) return fixtures.group ?? [];
        return [];
    };
    const db = makeFakeDataAccess(responder);
    const repository = makeRepository(
        {
            'instructor-a': { is_active: 1, token_version: 0, suspension_active: 0, role: 'instructor' },
            'owner-a': { is_active: 1, token_version: 0, suspension_active: 0, role: 'instructor' },
            'instructor-b': { is_active: 1, token_version: 0, suspension_active: 0, role: 'instructor' },
            'student-a': { is_active: 1, token_version: 0, suspension_active: 0, role: 'student' },
            'student-b': { is_active: 1, token_version: 0, suspension_active: 0, role: 'student' },
        },
        {
            instructorAccounts: {
                'instructor-a': { tenant_status: 'active', legacy_compat: 1, allowed: 1 },
                'owner-a': { tenant_status: 'active', legacy_compat: 1, allowed: 1 },
                'instructor-b': { tenant_status: 'active', legacy_compat: 1, allowed: 1 },
            },
            memberships: {
                'instructor-a': [{ tenant_id: 'tenant-a' }],
                'owner-a': [{ tenant_id: 'tenant-a' }],
                'instructor-b': [{ tenant_id: 'tenant-b' }],
            },
            enrollments: { 'student-a': [ENROLLMENT_A], 'student-b': [ENROLLMENT_B] },
        },
    );
    const router = createAssignmentsRouter({
        db,
        authenticate: createAuthenticateToken(repository),
        loadActiveTenantAuthority: async (userId, tenantId) => {
            const authority = AUTHORITY[userId];
            return authority && tenantId === 'tenant-a' ? { authority } : null;
        },
        branchAccess: opts.branchAccess ?? allowBranch,
        now: () => opts.now ?? new Date('2026-01-01T00:00:00Z'),
        transaction: async <T>(fn: (tx: AssignmentsDataAccess) => Promise<T>) => fn(db),
        objectStore: opts.objectStore ?? makeObjectStore(),
        malwareScanner: opts.malwareScanner,
    });
    return { router, executed: db.executed };
};

const auditAction = (executed: ExecutedStatement[], action: string) =>
    executed.find((e) => e.sql.includes('INSERT INTO audit_events') && (e.params[3] as string) === action);

// ---- GET / ---------------------------------------------------------------

test('list: anonymous 401 with no storage, cross-tenant 403, scoped 200', async () => {
    const anon = build();
    const anonRes = await invokeRoute(anon.router, { method: 'GET', url: '/' });
    assert.equal(anonRes.statusCode, 401);
    assert.equal(anon.executed.length, 0);

    const cross = build();
    assert.equal((await invokeRoute(cross.router, { method: 'GET', url: '/', token: INSTRUCTOR_B })).statusCode, 403);

    const { router, executed } = build({ assignments: [ASSIGNMENT] });
    const response = await invokeRoute(router, { method: 'GET', url: '/', token: INSTRUCTOR_A });
    assert.equal(response.statusCode, 200);
    assert.ok(executed.some((e) => e.params[0] === 'tenant-a'));
});

// ---- POST / --------------------------------------------------------------

test('create: invalid 400 (no write), branch deny 403, course outside 403', async () => {
    const invalid = build();
    const invalidRes = await invokeRoute(invalid.router, { method: 'POST', url: '/', token: INSTRUCTOR_A, body: { title: '' } });
    assert.equal(invalidRes.statusCode, 400);
    assert.equal(invalid.executed.some((e) => e.sql.includes('INSERT INTO assignments')), false);

    const branch = build({}, { branchAccess: denyBranch });
    const branchRes = await invokeRoute(branch.router, {
        method: 'POST', url: '/', token: INSTRUCTOR_A,
        body: { title: 't', branch_scope: 'branch', branch_id: 'br-1' },
    });
    assert.equal(branchRes.statusCode, 403);

    const course = build({ course: [] });
    const courseRes = await invokeRoute(course.router, {
        method: 'POST', url: '/', token: INSTRUCTOR_A, body: { title: 't', course_id: 'course-x' },
    });
    assert.equal(courseRes.statusCode, 403);
});

test('create: writes and audits a valid assignment with a deadline', async () => {
    const { router, executed } = build();
    const response = await invokeRoute(router, {
        method: 'POST', url: '/', token: INSTRUCTOR_A,
        body: { title: 'Essay', deadline: '2026-06-01 09:00', deadline_timezone: 'Africa/Cairo', late_policy: 'mark_late' },
    });
    assert.equal(response.statusCode, 201);
    const insert = executed.find((e) => e.sql.includes('INSERT INTO assignments'));
    assert.ok(insert);
    assert.equal(insert!.params[8], '2026-06-01 06:00:00');
    assert.ok(auditAction(executed, 'assignment.create'));
});

test('create: an audit failure aborts 500 rather than committing unaudited', async () => {
    const db = makeFakeDataAccess(() => []);
    const execute = async (sql: string, params?: unknown[]) => {
        if (sql.includes('INSERT INTO audit_events')) throw new Error('audit unavailable');
        return db.execute(sql, params);
    };
    const repository = makeRepository(
        { 'instructor-a': { is_active: 1, token_version: 0, suspension_active: 0, role: 'instructor' } },
        { instructorAccounts: { 'instructor-a': { tenant_status: 'active', legacy_compat: 1, allowed: 1 } }, memberships: { 'instructor-a': [{ tenant_id: 'tenant-a' }] } },
    );
    const tx: AssignmentsDataAccess = { query: db.query, queryOne: db.queryOne, execute };
    const router = createAssignmentsRouter({
        db: tx,
        authenticate: createAuthenticateToken(repository),
        loadActiveTenantAuthority: async () => ({ authority: 'instructor' }),
        branchAccess: allowBranch,
        transaction: async <T>(fn: (tx: AssignmentsDataAccess) => Promise<T>) => fn(tx),
        objectStore: makeObjectStore(),
    });
    const response = await invokeRoute(router, { method: 'POST', url: '/', token: INSTRUCTOR_A, body: { title: 't' } });
    assert.equal(response.statusCode, 500);
});

// ---- GET /:id ------------------------------------------------------------

test('read: staff 200, unknown 404, student in-audience 200, student out-of-audience 404', async () => {
    const staff = build();
    assert.equal((await invokeRoute(staff.router, { method: 'GET', url: '/a-1', token: INSTRUCTOR_A })).statusCode, 200);
    const unknown = build({ assignment: null });
    assert.equal((await invokeRoute(unknown.router, { method: 'GET', url: '/a-1', token: INSTRUCTOR_A })).statusCode, 404);
    const student = build();
    assert.equal((await invokeRoute(student.router, { method: 'GET', url: '/a-1', token: STUDENT_A })).statusCode, 200);
    const outOfAudience = build({ assignment: { ...ASSIGNMENT, branch_scope: 'branch', branch_id: 'br-9' } });
    assert.equal((await invokeRoute(outOfAudience.router, { method: 'GET', url: '/a-1', token: STUDENT_A })).statusCode, 404);
});

// ---- PATCH /:id ----------------------------------------------------------

test('edit: updates under an optimistic guard and audits; archived is 409; invalid is 400', async () => {
    const { router, executed } = build();
    const response = await invokeRoute(router, { method: 'PATCH', url: '/a-1', token: INSTRUCTOR_A, body: { title: 'Updated' } });
    assert.equal(response.statusCode, 200);
    const update = executed.find((e) => e.sql.includes('UPDATE assignments'));
    assert.ok(update);
    assert.equal(update!.params[update!.params.length - 1], 0, 'optimistic guard binds the previous version');
    assert.ok(auditAction(executed, 'assignment.update'));

    const archived = build({ assignment: { ...ASSIGNMENT, archived_at: '2026-01-01 00:00:00' } });
    assert.equal((await invokeRoute(archived.router, { method: 'PATCH', url: '/a-1', token: INSTRUCTOR_A, body: { title: 'x' } })).statusCode, 409);

    const invalid = build();
    assert.equal((await invokeRoute(invalid.router, { method: 'PATCH', url: '/a-1', token: INSTRUCTOR_A, body: { late_policy: 'nope' } })).statusCode, 400);
});

// ---- publish / archive ---------------------------------------------------

test('publish: success audited and repeat is 409', async () => {
    const draft = build({ assignment: { ...ASSIGNMENT, status: 'draft' } });
    const response = await invokeRoute(draft.router, { method: 'POST', url: '/a-1/publish', token: INSTRUCTOR_A });
    assert.equal(response.statusCode, 200);
    assert.ok(auditAction(draft.executed, 'assignment.publish'));
    const already = build({ assignment: { ...ASSIGNMENT, status: 'published' } });
    assert.equal((await invokeRoute(already.router, { method: 'POST', url: '/a-1/publish', token: INSTRUCTOR_A })).statusCode, 409);
});

test('archive: success audited and repeat is 409', async () => {
    const { router, executed } = build();
    const response = await invokeRoute(router, { method: 'POST', url: '/a-1/archive', token: INSTRUCTOR_A });
    assert.equal(response.statusCode, 200);
    assert.ok(auditAction(executed, 'assignment.archive'));
    const archived = build({ assignment: { ...ASSIGNMENT, archived_at: '2026-01-01 00:00:00' } });
    assert.equal((await invokeRoute(archived.router, { method: 'POST', url: '/a-1/archive', token: INSTRUCTOR_A })).statusCode, 409);
});

// ---- staff submissions list + revoke -------------------------------------

const SUBMISSION_ROW = {
    id: 'sub-1', assignment_id: 'a-1', tenant_id: 'tenant-a', student_enrollment_id: 'enr-a', student_user_id: 'enr-a',
    version: 1, status: 'submitted', file_name: 'hw.pdf', file_type: 'application/pdf', file_size_bytes: 100,
    scan_status: 'pending', is_late: 0, submitted_at: '2026-01-01 00:00:00', revoked_at: null,
};

test('submissions list: staff 200 projects metadata and never a public URL/storage key', async () => {
    const { router } = build({ submissions: [SUBMISSION_ROW] });
    const response = await invokeRoute(router, { method: 'GET', url: '/a-1/submissions', token: INSTRUCTOR_A });
    assert.equal(response.statusCode, 200);
    const first = (response.body as Array<Record<string, unknown>>)[0];
    assert.equal(first.file_name, 'hw.pdf');
    assert.equal('storage_key' in first, false);
    assert.equal('url' in first, false);

    const unknown = build({ assignment: null });
    assert.equal((await invokeRoute(unknown.router, { method: 'GET', url: '/a-1/submissions', token: INSTRUCTOR_A })).statusCode, 404);
});

test('revoke: success audited, unknown 404, already revoked 409', async () => {
    const { router, executed } = build({ submission: SUBMISSION_ROW });
    const response = await invokeRoute(router, { method: 'POST', url: '/a-1/submissions/sub-1/revoke', token: INSTRUCTOR_A, body: { reason: 'plagiarism' } });
    assert.equal(response.statusCode, 200);
    assert.ok(auditAction(executed, 'assignment.submission.revoke'));

    const unknown = build({ submission: null });
    assert.equal((await invokeRoute(unknown.router, { method: 'POST', url: '/a-1/submissions/sub-1/revoke', token: INSTRUCTOR_A })).statusCode, 404);
    const revoked = build({ submission: { ...SUBMISSION_ROW, status: 'revoked' } });
    assert.equal((await invokeRoute(revoked.router, { method: 'POST', url: '/a-1/submissions/sub-1/revoke', token: INSTRUCTOR_A })).statusCode, 409);
});

// ---- student list + submit + mine ----------------------------------------

test('student list: only the caller audience is returned', async () => {
    const { router } = build({
        assignments: [ASSIGNMENT, { ...ASSIGNMENT, id: 'a-2', group_id: 'grp-2' }],
    });
    const response = await invokeRoute(router, { method: 'GET', url: '/student', token: STUDENT_A });
    assert.equal(response.statusCode, 200);
    const ids = (response.body as Array<{ id: string }>).map((row) => row.id);
    assert.deepEqual(ids, ['a-1'], 'group grp-2 assignment is out of the caller audience');
});

test('course audience: a student outside the course is denied, an enrolled course student is served (read/submit)', async () => {
    const courseAssignment = { ...ASSIGNMENT, course_id: 'course-1' };

    const enrolledOtherCourse = build({
        assignment: courseAssignment,
        assignments: [courseAssignment],
        enrollment: { ...ENROLLMENT_A, course_id: 'course-7' },
    });
    assert.equal((await invokeRoute(enrolledOtherCourse.router, { method: 'GET', url: '/a-1', token: STUDENT_A })).statusCode, 404,
        'a course-audience assignment is invisible to students of other courses');
    const listed = await invokeRoute(enrolledOtherCourse.router, { method: 'GET', url: '/student', token: STUDENT_A });
    assert.deepEqual((listed.body as Array<{ id: string }>), [], 'not listed tenant-wide');
    assert.equal((await invokeRoute(enrolledOtherCourse.router, {
        method: 'POST', url: '/a-1/submissions', token: STUDENT_A,
        body: { file_name: 'hw.pdf', file_type: 'application/pdf' },
    })).statusCode, 404, 'not submittable by students outside the course');
    assert.equal(enrolledOtherCourse.executed.some((e) => e.sql.includes('INSERT INTO assignment_submissions')), false);

    const inCourse = build({
        assignment: courseAssignment,
        enrollment: { ...ENROLLMENT_A, course_id: 'course-1' },
    });
    assert.equal((await invokeRoute(inCourse.router, { method: 'GET', url: '/a-1', token: STUDENT_A })).statusCode, 200);
    const submit = await invokeRoute(inCourse.router, {
        method: 'POST', url: '/a-1/submissions', token: STUDENT_A,
        body: { file_name: 'hw.pdf', file_type: 'application/pdf' },
    });
    assert.equal(submit.statusCode, 201);
});

test('submit: an enrolled student creates version 1, gets a short-lived private target and is audited', async () => {
    const { router, executed } = build();
    const response = await invokeRoute(router, {
        method: 'POST', url: '/a-1/submissions', token: STUDENT_A,
        body: { file_name: 'hw.pdf', file_type: 'application/pdf', file_size_bytes: 500 },
    });
    assert.equal(response.statusCode, 201);
    const body = response.body as Record<string, unknown>;
    assert.equal(body.version, 1);
    assert.equal(body.status, 'submitted');
    assert.equal(body.scan_status, 'pending');
    assert.equal(body.upload_status, 'pending_upload');
    assert.equal(body.file_size_bytes, 0, 'nothing is verified before upload');
    assert.equal('storage_key' in body, false, 'the private key is never projected');
    const upload = body.upload as Record<string, unknown>;
    assert.equal(upload.method, 'PUT');
    assert.equal(upload.expires_in_seconds, 300, 'authorization is short-lived');
    assert.match(String(upload.url), /^https:\/\/storage\.invalid\/private\/tenants\/tenant-a\//);
    assert.deepEqual(upload.required_headers, { 'Content-Type': 'application/pdf' });
    const insert = executed.find((e) => e.sql.includes('INSERT INTO assignment_submissions'));
    assert.ok(insert);
    assert.equal(insert!.params[4], 'student-a', 'student_user_id is the authenticated user id');
    const storageKey = insert!.params[10] as string;
    assert.match(storageKey, /^tenants\/tenant-a\/assignments\/a-1\/enr-a\/[0-9a-f-]{36}\.pdf$/,
        'the stored key is server-generated and namespaced');
    assert.ok(auditAction(executed, 'assignment.submission.create'));
});

test('submit: a client-supplied storage_key is rejected with 400 and nothing is written', async () => {
    const { router, executed } = build();
    const response = await invokeRoute(router, {
        method: 'POST', url: '/a-1/submissions', token: STUDENT_A,
        body: { file_name: 'hw.pdf', file_type: 'application/pdf', storage_key: 'tenants/tenant-b/other/file.pdf' },
    });
    assert.equal(response.statusCode, 400);
    assert.equal(executed.some((e) => e.sql.includes('INSERT INTO assignment_submissions')), false);
});

test('submit: creation never trusts a client size and never stats storage', async () => {
    let statCalls = 0;
    const store = makeObjectStore({
        statObject: async () => {
            statCalls += 1;
            return { sizeBytes: 2000, contentType: 'application/pdf', etag: 'e', lastModified: null };
        },
    });
    const { router, executed } = build({}, { objectStore: store });
    const response = await invokeRoute(router, {
        method: 'POST', url: '/a-1/submissions', token: STUDENT_A,
        body: { file_name: 'hw.pdf', file_type: 'application/pdf', file_size_bytes: 999999 },
    });
    assert.equal(response.statusCode, 201);
    const body = response.body as Record<string, unknown>;
    assert.equal(body.upload_status, 'pending_upload');
    assert.equal(body.file_size_bytes, 0);
    assert.equal('storage_key' in body, false);
    assert.equal(statCalls, 0, 'create only authorizes; verification happens at finalize');
    const insert = executed.find((e) => e.sql.includes('INSERT INTO assignment_submissions'));
    assert.ok(insert);
    assert.equal(insert!.params[9], 0, 'no client size claim is persisted');
    assert.equal((insert!.params[10] as string).startsWith('tenants/tenant-a/assignments/a-1/enr-a/'), true);
    assert.equal(insert!.params[4], 'student-a');
});

test('submit: a file type that cannot be signature-verified is refused before any write', async () => {
    const { router, executed } = build({
        assignment: { ...ASSIGNMENT, allowed_file_types: '["exe"]' },
    });
    const response = await invokeRoute(router, {
        method: 'POST', url: '/a-1/submissions', token: STUDENT_A,
        body: { file_name: 'hw.exe', file_type: 'application/octet-stream' },
    });
    assert.equal(response.statusCode, 400);
    assert.equal((response.body as { code?: string }).code, 'unsupported_file_type');
    assert.equal(executed.some((e) => e.sql.includes('INSERT INTO assignment_submissions')), false);
});

test('submit: late policy marks a submission late, and a block policy denies it', async () => {
    const late = build(
        { assignment: { ...ASSIGNMENT, deadline_at: '2026-06-01 12:00:00', late_policy: 'mark_late' } },
        { now: new Date('2026-06-01T13:00:00Z') },
    );
    const lateRes = await invokeRoute(late.router, {
        method: 'POST', url: '/a-1/submissions', token: STUDENT_A,
        body: { file_name: 'hw.pdf', file_type: 'application/pdf' },
    });
    assert.equal(lateRes.statusCode, 201);
    assert.equal((lateRes.body as { status?: string }).status, 'late');

    const blocked = build(
        { assignment: { ...ASSIGNMENT, deadline_at: '2026-06-01 12:00:00', late_policy: 'block' } },
        { now: new Date('2026-06-01T13:00:00Z') },
    );
    const blockedRes = await invokeRoute(blocked.router, {
        method: 'POST', url: '/a-1/submissions', token: STUDENT_A,
        body: { file_name: 'hw.pdf', file_type: 'application/pdf' },
    });
    assert.equal(blockedRes.statusCode, 403);
    assert.equal((blockedRes.body as { code?: string }).code, 'DEADLINE_PASSED');
});

test('submit: cross-tenant is 404, and no storage adapter fails closed with 503 and no row', async () => {
    const crossTenant = build({ assignment: { ...ASSIGNMENT, tenant_id: 'tenant-b' } });
    assert.equal((await invokeRoute(crossTenant.router, {
        method: 'POST', url: '/a-1/submissions', token: STUDENT_A,
        body: { file_name: 'hw.pdf', file_type: 'application/pdf' },
    })).statusCode, 404);

    const dataAccess = makeFakeDataAccess((sql) => {
        if (sql.includes('FROM students s LEFT JOIN')) return [ENROLLMENT_A];
        if (sql.includes('FROM assignments') && sql.includes('id = ?')) return [ASSIGNMENT];
        return [];
    });
    const repository = makeRepository(
        { 'student-a': { is_active: 1, token_version: 0, suspension_active: 0, role: 'student' } },
        { enrollments: { 'student-a': [ENROLLMENT_A] } },
    );
    const router = createAssignmentsRouter({
        db: dataAccess,
        authenticate: createAuthenticateToken(repository),
        loadActiveTenantAuthority: async () => null,
        now: () => new Date('2026-01-01T00:00:00Z'),
        transaction: async <T>(fn: (tx: AssignmentsDataAccess) => Promise<T>) => fn(dataAccess),
    });
    const response = await invokeRoute(router, {
        method: 'POST', url: '/a-1/submissions', token: STUDENT_A,
        body: { file_name: 'hw.pdf', file_type: 'application/pdf' },
    });
    assert.equal(response.statusCode, 503);
    assert.equal((response.body as { code?: string }).code, 'upload_unavailable');
    assert.equal(dataAccess.executed.some((e) => e.sql.includes('INSERT INTO assignment_submissions')), false,
        'no submission row is written without an upload target');
});

test('submit: a duplicate-key race is answered as a 409 retry, not a 500', async () => {
    let listCalls = 0;
    const db = makeFakeDataAccess((sql) => {
        if (sql.includes('FROM students s LEFT JOIN')) return [ENROLLMENT_A];
        if (sql.includes('FROM assignments') && sql.includes('id = ?')) return [ASSIGNMENT];
        if (sql.includes('FROM assignment_submissions')) {
            listCalls += 1;
            return listCalls === 1 ? [] : [SUBMISSION_ROW];
        }
        return [];
    });
    const repository = makeRepository(
        { 'student-a': { is_active: 1, token_version: 0, suspension_active: 0, role: 'student' } },
        { enrollments: { 'student-a': [ENROLLMENT_A] } },
    );
    const dataAccess: AssignmentsDataAccess = {
        query: db.query,
        queryOne: db.queryOne,
        execute: async (sql, params) => {
            if (sql.includes('INSERT INTO assignment_submissions')) {
                throw Object.assign(new Error('duplicate'), { code: 'ER_DUP_ENTRY' });
            }
            return db.execute(sql, params);
        },
    };
    const router = createAssignmentsRouter({
        db: dataAccess,
        authenticate: createAuthenticateToken(repository),
        loadActiveTenantAuthority: async () => null,
        now: () => new Date('2026-01-01T00:00:00Z'),
        transaction: async <T>(fn: (tx: AssignmentsDataAccess) => Promise<T>) => fn(dataAccess),
        objectStore: makeObjectStore(),
    });
    const response = await invokeRoute(router, {
        method: 'POST', url: '/a-1/submissions', token: STUDENT_A,
        body: { file_name: 'hw.pdf', file_type: 'application/pdf' },
    });
    assert.equal(response.statusCode, 409);
    assert.equal(listCalls, 2, 'the retry decision re-evaluated the committed state');
    assert.equal(db.executed.some((e) => e.sql.includes('INSERT INTO audit_events') && (e.params[3] as string) === 'assignment.submission.create'), false,
        'a lost submission never audits');
});

test('submit: a duplicate-key race that reaches the policy limit is a 403 denial, not a 500', async () => {
    let listCalls = 0;
    const db = makeFakeDataAccess((sql) => {
        if (sql.includes('FROM students s LEFT JOIN')) return [ENROLLMENT_A];
        if (sql.includes('FROM assignments') && sql.includes('id = ?')) return [ASSIGNMENT];
        if (sql.includes('FROM assignment_submissions')) {
            listCalls += 1;
            return listCalls === 1
                ? []
                : Array.from({ length: 5 }, (_, index) => ({ ...SUBMISSION_ROW, id: `sub-${index + 2}`, version: index + 1 }));
        }
        return [];
    });
    const repository = makeRepository(
        { 'student-a': { is_active: 1, token_version: 0, suspension_active: 0, role: 'student' } },
        { enrollments: { 'student-a': [ENROLLMENT_A] } },
    );
    const dataAccess: AssignmentsDataAccess = {
        query: db.query,
        queryOne: db.queryOne,
        execute: async (sql, params) => {
            if (sql.includes('INSERT INTO assignment_submissions')) {
                throw Object.assign(new Error('duplicate'), { code: 'ER_DUP_ENTRY' });
            }
            return db.execute(sql, params);
        },
    };
    const router = createAssignmentsRouter({
        db: dataAccess,
        authenticate: createAuthenticateToken(repository),
        loadActiveTenantAuthority: async () => null,
        now: () => new Date('2026-01-01T00:00:00Z'),
        transaction: async <T>(fn: (tx: AssignmentsDataAccess) => Promise<T>) => fn(dataAccess),
        objectStore: makeObjectStore(),
    });
    const response = await invokeRoute(router, {
        method: 'POST', url: '/a-1/submissions', token: STUDENT_A,
        body: { file_name: 'hw.pdf', file_type: 'application/pdf' },
    });
    assert.equal(response.statusCode, 403);
    assert.equal((response.body as { code?: string }).code, 'SUBMISSION_LIMIT_REACHED');
});

test('mine: returns only the caller own versions and leaks no storage key', async () => {
    const rows = [SUBMISSION_ROW, { ...SUBMISSION_ROW, id: 'sub-2', student_enrollment_id: 'enr-b' }];
    const { router, executed } = buildStudentRouter((sql, params) => {
        if (sql.includes('FROM students s LEFT JOIN')) return [ENROLLMENT_A];
        if (sql.includes('FROM assignments') && sql.includes('id = ?')) return [ASSIGNMENT];
        if (sql.includes('FROM assignment_submissions')) return submissionRowsFor(sql, params, rows as ScriptedSubmission[]);
        return [];
    });
    const response = await invokeRoute(router, { method: 'GET', url: '/a-1/submissions/mine', token: STUDENT_A });
    assert.equal(response.statusCode, 200);
    const body = response.body as Array<Record<string, unknown>>;
    assert.equal(body.length, 1);
    assert.equal(body[0].student_enrollment_id, 'enr-a', 'the other enrollment is excluded by the SQL predicate');
    assert.equal('storage_key' in body[0], false);
    const read = executed.find((e) => e.kind === 'query' && e.sql.includes('FROM assignment_submissions'));
    assert.match(read!.sql, /student_enrollment_id = \?/);
    assert.equal(read!.params[2], 'enr-a');
});

// ---------------------------------------------------------------------------
// Own-history completeness (tenant-wide truncation regression)
// ---------------------------------------------------------------------------

type ScriptedSubmission = Record<string, unknown> & {
    assignment_id: string;
    tenant_id: string;
    student_enrollment_id: string;
    version: number;
};

/**
 * Emulates the row filtering MySQL performs, because the fake adapter returns
 * rows verbatim: the staff query is bounded (`ORDER BY version DESC LIMIT 200`)
 * while the enrollment-scoped query is not. Without this, a test could not
 * observe the truncation defect at all.
 */
const submissionRowsFor = (
    sql: string,
    params: unknown[],
    rows: ScriptedSubmission[],
): ScriptedSubmission[] => {
    const [assignmentId, tenantId, enrollmentId] = params as [string, string, string | undefined];
    const matched = rows.filter((row) =>
        row.assignment_id === assignmentId
        && row.tenant_id === tenantId
        && (enrollmentId === undefined || row.student_enrollment_id === enrollmentId));
    const ordered = [...matched].sort((left, right) => right.version - left.version);
    return sql.includes('LIMIT 200') ? ordered.slice(0, 200) : ordered;
};

const otherStudentSubmissions = (count: number): ScriptedSubmission[] =>
    Array.from({ length: count }, (_, index) => ({
        ...SUBMISSION_ROW,
        id: `other-${index + 1}`,
        student_enrollment_id: 'enr-other',
        student_user_id: 'student-other',
        version: index + 1,
    })) as ScriptedSubmission[];

const ownSubmissions = (count: number): ScriptedSubmission[] =>
    Array.from({ length: count }, (_, index) => ({
        ...SUBMISSION_ROW,
        id: `own-${index + 1}`,
        version: index + 1,
    })) as ScriptedSubmission[];

const buildStudentRouter = (
    responder: (sql: string, params: unknown[]) => unknown[] | null,
    execute?: (sql: string, params?: unknown[]) => Promise<{ insertId?: number; affectedRows?: number }>,
    options: { objectStore?: AssignmentObjectStore } = {},
) => {
    const db = makeFakeDataAccess(responder);
    const dataAccess: AssignmentsDataAccess = {
        query: db.query,
        queryOne: db.queryOne,
        execute: execute ?? db.execute,
    };
    const repository = makeRepository(
        { 'student-a': { is_active: 1, token_version: 0, suspension_active: 0, role: 'student' } },
        { enrollments: { 'student-a': [ENROLLMENT_A] } },
    );
    const router = createAssignmentsRouter({
        db: dataAccess,
        authenticate: createAuthenticateToken(repository),
        loadActiveTenantAuthority: async () => null,
        now: () => new Date('2026-01-01T00:00:00Z'),
        transaction: async <T>(fn: (tx: AssignmentsDataAccess) => Promise<T>) => fn(dataAccess),
        objectStore: options.objectStore ?? makeObjectStore(),
    });
    return { router, executed: db.executed };
};

const studentResponder = (rows: ScriptedSubmission[]) =>
    (sql: string, params: unknown[]): unknown[] | null => {
        if (sql.includes('FROM students s LEFT JOIN')) return [ENROLLMENT_A];
        if (sql.includes('FROM assignments') && sql.includes('id = ?')) return [ASSIGNMENT];
        if (sql.includes('FROM assignment_submissions')) return submissionRowsFor(sql, params, rows);
        return [];
    };

test('own history: 250 other-student submissions never truncate the caller versions or the next version', async () => {
    const rows = [...otherStudentSubmissions(250), ...ownSubmissions(3)];
    const { router, executed } = buildStudentRouter(studentResponder(rows));

    const mine = await invokeRoute(router, { method: 'GET', url: '/a-1/submissions/mine', token: STUDENT_A });
    assert.equal(mine.statusCode, 200);
    const mineBody = mine.body as Array<{ version: number; student_enrollment_id: string }>;
    assert.deepEqual(mineBody.map((row) => row.version), [3, 2, 1],
        'the caller own versions survive 250 newer tenant-wide rows');
    assert.equal(mineBody.every((row) => row.student_enrollment_id === 'enr-a'), true);

    const submit = await invokeRoute(router, {
        method: 'POST', url: '/a-1/submissions', token: STUDENT_A,
        body: { file_name: 'hw.pdf', file_type: 'application/pdf' },
    });
    assert.equal(submit.statusCode, 201);
    assert.equal((submit.body as { version?: number }).version, 4,
        'the next version is max(complete own history)+1, not a version already taken');

    const insert = executed.find((e) => e.kind === 'execute' && e.sql.includes('INSERT INTO assignment_submissions'));
    assert.ok(insert);
    assert.equal(insert!.params[3], 'enr-a');
    assert.equal(insert!.params[4], 'student-a', 'the row carries the authenticated student identity');
    assert.equal(insert!.params[5], 4);

    const ownReads = executed.filter((e) => e.kind === 'query' && e.sql.includes('FROM assignment_submissions'));
    assert.ok(ownReads.length >= 2, 'both the read and the submit decision read the own history');
    for (const read of ownReads) {
        assert.match(read.sql, /student_enrollment_id = \?/, 'own reads filter by verified enrollment in SQL');
        assert.equal(read.params[2], 'enr-a');
        assert.equal(/LIMIT/i.test(read.sql), false, 'own history is never truncated');
    }
});

test('own history: the submission limit is decided from all own versions, not the tenant window', async () => {
    const rows = [...otherStudentSubmissions(250), ...ownSubmissions(5)];
    const { router, executed } = buildStudentRouter(studentResponder(rows));

    const response = await invokeRoute(router, {
        method: 'POST', url: '/a-1/submissions', token: STUDENT_A,
        body: { file_name: 'hw.pdf', file_type: 'application/pdf' },
    });
    assert.equal(response.statusCode, 403);
    assert.equal((response.body as { code?: string }).code, 'SUBMISSION_LIMIT_REACHED',
        'five own active versions reach max_submissions even though 250 others dominate the tenant window');
    assert.equal(executed.some((e) => e.kind === 'execute' && e.sql.includes('INSERT INTO assignment_submissions')), false);
});

test('duplicate-key recovery: the retry decision reads the caller own history, not the tenant window', async () => {
    const otherRows = otherStudentSubmissions(250);
    let enrollmentReads = 0;
    const db = makeFakeDataAccess((sql, params) => {
        if (sql.includes('FROM students s LEFT JOIN')) return [ENROLLMENT_A];
        if (sql.includes('FROM assignments') && sql.includes('id = ?')) return [ASSIGNMENT];
        if (sql.includes('FROM assignment_submissions')) {
            if (sql.includes('student_enrollment_id = ?')) {
                enrollmentReads += 1;
                // The first decision sees four versions; the racing winner has
                // committed a fifth by the time the recovery re-reads.
                return enrollmentReads === 1 ? ownSubmissions(4) : ownSubmissions(5);
            }
            return submissionRowsFor(sql, params, otherRows);
        }
        return [];
    });
    const dataAccess: AssignmentsDataAccess = {
        query: db.query,
        queryOne: db.queryOne,
        execute: async (sql, params) => {
            if (sql.includes('INSERT INTO assignment_submissions')) {
                throw Object.assign(new Error('duplicate'), { code: 'ER_DUP_ENTRY' });
            }
            return db.execute(sql, params);
        },
    };
    const repository = makeRepository(
        { 'student-a': { is_active: 1, token_version: 0, suspension_active: 0, role: 'student' } },
        { enrollments: { 'student-a': [ENROLLMENT_A] } },
    );
    const router = createAssignmentsRouter({
        db: dataAccess,
        authenticate: createAuthenticateToken(repository),
        loadActiveTenantAuthority: async () => null,
        now: () => new Date('2026-01-01T00:00:00Z'),
        transaction: async <T>(fn: (tx: AssignmentsDataAccess) => Promise<T>) => fn(dataAccess),
        objectStore: makeObjectStore(),
    });

    const response = await invokeRoute(router, {
        method: 'POST', url: '/a-1/submissions', token: STUDENT_A,
        body: { file_name: 'hw.pdf', file_type: 'application/pdf' },
    });
    assert.equal(response.statusCode, 403);
    assert.equal((response.body as { code?: string }).code, 'SUBMISSION_LIMIT_REACHED',
        'the recovery sees the committed fifth own version and denies the limit');
    assert.equal(enrollmentReads, 2, 'both the first decision and the race recovery are enrollment-scoped');
    assert.equal(db.executed.some((e) => e.sql.includes('INSERT INTO audit_events')), false,
        'a lost submission never audits');
});

test('foreign tenant: own-history reads and submit are 404 and never touch submissions', async () => {
    const { router, executed } = buildStudentRouter((sql) => {
        if (sql.includes('FROM students s LEFT JOIN')) return [ENROLLMENT_A];
        // The tenant-scoped assignment lookup misses: the assignment is foreign.
        if (sql.includes('FROM assignments') && sql.includes('id = ?')) return [];
        // If any path read submissions despite the miss, this row would leak.
        if (sql.includes('FROM assignment_submissions')) return [SUBMISSION_ROW];
        return [];
    });

    const mine = await invokeRoute(router, { method: 'GET', url: '/a-1/submissions/mine', token: STUDENT_A });
    assert.equal(mine.statusCode, 404);
    assert.deepEqual(mine.body, { error: 'Assignment not found' }, 'the denial carries no assignment facts');

    const submit = await invokeRoute(router, {
        method: 'POST', url: '/a-1/submissions', token: STUDENT_A,
        body: { file_name: 'hw.pdf', file_type: 'application/pdf' },
    });
    assert.equal(submit.statusCode, 404);
    assert.equal(executed.some((e) => e.sql.includes('FROM assignment_submissions')), false,
        'no submission row is read for a foreign-tenant assignment');
    assert.equal(executed.some((e) => e.kind === 'execute' && e.sql.includes('INSERT INTO assignment_submissions')), false);
});

// ---------------------------------------------------------------------------
// Abandoned pending upload: attempt accounting, cancel and resume
// ---------------------------------------------------------------------------

/** 24 h before the harness clock (2026-01-01T00:00:00Z): past every upload TTL. */
const ABANDONED_AT = '2025-12-31 00:00:00';
/** The harness clock itself: an upload authorization issued now can still be used. */
const RECENT_AT = '2026-01-01 00:00:00';

const pendingUploadRow = (id: string, version: number, submittedAt = ABANDONED_AT): ScriptedSubmission => ({
    ...SUBMISSION_ROW,
    id,
    version,
    file_size_bytes: 0,
    scan_status: 'pending',
    submitted_at: submittedAt,
    storage_key: `tenants/tenant-a/assignments/a-1/enr-a/${id}.pdf`,
}) as ScriptedSubmission;

/**
 * Emulates the two submission reads the route performs: the enrollment-scoped
 * own-history list and the own-submission lookup by
 * (id, assignment, tenant, enrollment). Both predicates are applied here
 * because the fake adapter returns rows verbatim.
 */
const ownSubmissionResponder = (rows: ScriptedSubmission[]) =>
    (sql: string, params: unknown[]): unknown[] | null => {
        if (sql.includes('FROM students s LEFT JOIN')) return [ENROLLMENT_A];
        if (sql.includes('FROM assignments') && sql.includes('id = ?')) return [ASSIGNMENT];
        if (sql.includes('FROM assignment_submissions') && sql.includes('WHERE id = ?')) {
            const [id, assignmentId, tenantId, enrollmentId] = params as string[];
            const row = rows.find((entry) => entry.id === id
                && entry.assignment_id === assignmentId
                && entry.tenant_id === tenantId
                && entry.student_enrollment_id === enrollmentId);
            return row ? [row] : [];
        }
        if (sql.includes('FROM assignment_submissions')) return submissionRowsFor(sql, params, rows);
        return [];
    };

const submitBody = { file_name: 'hw.pdf', file_type: 'application/pdf' };

test('resubmit: abandoned pending_upload rows never exhaust the attempt budget', async () => {
    const rows = Array.from({ length: 5 }, (_, index) => pendingUploadRow(`sub-${index + 1}`, index + 1));
    const { router, executed } = buildStudentRouter(ownSubmissionResponder(rows));

    const response = await invokeRoute(router, {
        method: 'POST', url: '/a-1/submissions', token: STUDENT_A, body: submitBody,
    });
    assert.equal(response.statusCode, 201, 'five abandoned uploads must not permanently burn the limit');
    assert.equal((response.body as { version?: number }).version, 6);
    const insert = executed.find((e) => e.kind === 'execute' && e.sql.includes('INSERT INTO assignment_submissions'));
    assert.ok(insert);
    assert.equal(insert!.params[5], 6, 'the version keeps incrementing over the abandoned history');
    assert.equal(insert!.params[9], 0, 'the new row still starts unverified');
});

test('resubmit: a recent pending_upload still counts as in flight and is not silently reclaimed', async () => {
    const rows = Array.from({ length: 5 }, (_, index) => pendingUploadRow(`sub-${index + 1}`, index + 1, RECENT_AT));
    const { router, executed } = buildStudentRouter(ownSubmissionResponder(rows));

    const response = await invokeRoute(router, {
        method: 'POST', url: '/a-1/submissions', token: STUDENT_A, body: submitBody,
    });
    assert.equal(response.statusCode, 403);
    assert.equal((response.body as { code?: string }).code, 'SUBMISSION_LIMIT_REACHED');
    assert.equal(executed.some((e) => e.kind === 'execute' && e.sql.includes('INSERT INTO assignment_submissions')), false);
});

test('resubmit: resubmission_policy=block ignores an abandoned upload but still blocks a verified version', async () => {
    const blockedAssignment = { ...ASSIGNMENT, resubmission_policy: 'block' };
    const blockedResponder = (rows: ScriptedSubmission[]) => (sql: string, params: unknown[]): unknown[] | null => {
        if (sql.includes('FROM assignments') && sql.includes('id = ?')) return [blockedAssignment];
        return ownSubmissionResponder(rows)(sql, params);
    };

    const abandoned = buildStudentRouter(blockedResponder([pendingUploadRow('sub-1', 1)])).router;
    const allowed = await invokeRoute(abandoned, {
        method: 'POST', url: '/a-1/submissions', token: STUDENT_A, body: submitBody,
    });
    assert.equal(allowed.statusCode, 201, 'an abandoned upload carries no content to block a resubmission');

    const verified: ScriptedSubmission = {
        ...pendingUploadRow('sub-1', 1), file_size_bytes: 2048, scan_status: 'clean',
    } as ScriptedSubmission;
    const blocked = buildStudentRouter(blockedResponder([verified])).router;
    const denied = await invokeRoute(blocked, {
        method: 'POST', url: '/a-1/submissions', token: STUDENT_A, body: submitBody,
    });
    assert.equal(denied.statusCode, 403);
    assert.equal((denied.body as { code?: string }).code, 'RESUBMISSION_BLOCKED');
});

test('cancel: an abandoned own upload is revoked, audited and its unverified bytes removed', async () => {
    const rows = Array.from({ length: 5 }, (_, index) => pendingUploadRow(`sub-${index + 1}`, index + 1));
    const removed: string[] = [];
    const mutableRemovals: string[] = [];
    const { router, executed } = buildStudentRouter(ownSubmissionResponder(rows), undefined, {
        objectStore: makeObjectStore({
            capabilities: { conditionalDelete: true },
            removeObject: async (key) => { mutableRemovals.push(key); },
            removeObjectVersion: async ({ objectKey, etag, sizeBytes }) => {
                removed.push(`${objectKey}#${etag}:${sizeBytes}`);
                return 'removed';
            },
        }),
    });

    const response = await invokeRoute(router, {
        method: 'POST', url: '/a-1/submissions/sub-1/cancel', token: STUDENT_A,
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.body, { id: 'sub-1', status: 'revoked', cancelled: true });

    const update = executed.find((e) => e.kind === 'execute' && e.sql.includes('UPDATE assignment_submissions'));
    assert.ok(update);
    assert.match(update!.sql, /SET status='revoked'/);
    assert.match(update!.sql, /status<>'revoked'/);
    assert.match(update!.sql, /file_size_bytes=0/, 'a verified upload is never cancelled by the student');
    assert.deepEqual(update!.params, ['student-a', 'sub-1', 'a-1', 'tenant-a', 'enr-a'],
        'the cancel is bound to the caller enrollment, not to a client-supplied identity');
    assert.ok(auditAction(executed, 'assignment.submission.cancel'));
    assert.deepEqual(removed, ['tenants/tenant-a/assignments/a-1/enr-a/sub-1.pdf#etag-1:2000'],
        'the abandoned version proven to be at the key is removed by exact version');
    assert.deepEqual(mutableRemovals, [], 'a cancel never deletes by mutable key');

    const read = executed.find((e) => e.sql.includes('storage_key') && e.sql.includes('FROM assignment_submissions'));
    assert.ok(read);
    assert.match(read!.sql, /id = \? AND assignment_id = \? AND tenant_id = \? AND student_enrollment_id = \?/);
});

test('cancel: finalized, already-revoked, foreign and staff callers never change state', async () => {
    const finalized: ScriptedSubmission = {
        ...pendingUploadRow('sub-1', 1), file_size_bytes: 2048,
    } as ScriptedSubmission;
    const finalizedRun = buildStudentRouter(ownSubmissionResponder([finalized]));
    const finalizedRes = await invokeRoute(finalizedRun.router, {
        method: 'POST', url: '/a-1/submissions/sub-1/cancel', token: STUDENT_A,
    });
    assert.equal(finalizedRes.statusCode, 409);
    assert.equal((finalizedRes.body as { code?: string }).code, 'already_finalized');
    assert.equal(finalizedRun.executed.some((e) => e.kind === 'execute' && e.sql.includes('UPDATE assignment_submissions')), false);

    const revoked: ScriptedSubmission = {
        ...pendingUploadRow('sub-1', 1), status: 'revoked', revoked_at: '2026-01-01 00:00:00',
    } as ScriptedSubmission;
    const revokedRun = buildStudentRouter(ownSubmissionResponder([revoked]));
    const revokedRes = await invokeRoute(revokedRun.router, {
        method: 'POST', url: '/a-1/submissions/sub-1/cancel', token: STUDENT_A,
    });
    assert.equal(revokedRes.statusCode, 200, 'cancelling an already revoked version is idempotent');
    assert.deepEqual(revokedRes.body, { id: 'sub-1', status: 'revoked', cancelled: false });
    assert.equal(revokedRun.executed.some((e) => e.kind === 'execute' && e.sql.includes('UPDATE assignment_submissions')), false);

    const missing = buildStudentRouter(ownSubmissionResponder([]));
    assert.equal((await invokeRoute(missing.router, {
        method: 'POST', url: '/a-1/submissions/sub-1/cancel', token: STUDENT_A,
    })).statusCode, 404);

    const staff = build();
    const staffRes = await invokeRoute(staff.router, {
        method: 'POST', url: '/a-1/submissions/sub-1/cancel', token: INSTRUCTOR_A,
    });
    assert.equal(staffRes.statusCode, 403, 'cancel is a student operation on the caller own version');
    assert.equal(staff.executed.some((e) => e.kind === 'execute' && e.sql.includes('UPDATE assignment_submissions')), false);
});

test('resume: re-authorization targets the stored server key of the caller own abandoned version', async () => {
    const signed: string[] = [];
    const rows = [pendingUploadRow('sub-1', 1)];
    const { router } = buildStudentRouter(ownSubmissionResponder(rows), undefined, {
        objectStore: makeObjectStore({
            createUploadUrl: async ({ objectKey, expiresInSeconds }) => {
                signed.push(`${objectKey}|${expiresInSeconds}`);
                return `https://storage.invalid/private/${objectKey}?expires=${expiresInSeconds}`;
            },
        }),
    });

    const response = await invokeRoute(router, {
        method: 'POST', url: '/a-1/submissions/sub-1/upload-authorization', token: STUDENT_A,
    });
    assert.equal(response.statusCode, 200);
    const body = response.body as Record<string, unknown>;
    assert.equal(body.upload_status, 'pending_upload');
    assert.equal('storage_key' in body, false);
    assert.deepEqual(signed, ['tenants/tenant-a/assignments/a-1/enr-a/sub-1.pdf|300'],
        'the resumed target is the stored server key, never a client value');
});

/* ------------------------------------------------------------------------- */
/* Cancel cleanup: exact version, never the mutable key                       */
/* ------------------------------------------------------------------------- */

const cancelUrl = '/a-1/submissions/sub-1/cancel';

/**
 * A store over one mutable key holding immutable versions. The version-bound
 * delete is enforced by the store itself, as a real conditional delete is: it
 * compares the precondition against the version that is live when the delete
 * arrives. `statVersion` is what the server observes; `liveVersion` is what is
 * actually at the key when the delete runs.
 */
const makeCancelStore = (
    statVersion: { etag: string; sizeBytes: number },
    liveVersion: { etag: string; sizeBytes: number } = statVersion,
    exactVersion = true,
) => {
    const destroyed: string[] = [];
    const mutableRemovals: string[] = [];
    const versionRemovals: string[] = [];
    const store: AssignmentObjectStore = {
        statObject: async () => ({
            sizeBytes: statVersion.sizeBytes,
            contentType: 'application/pdf',
            etag: statVersion.etag,
            lastModified: null,
        }),
        readPrefix: async () => Buffer.from('%PDF-1.7\n', 'ascii'),
        createUploadUrl: async ({ objectKey, expiresInSeconds }) =>
            `https://storage.invalid/private/${objectKey}?expires=${expiresInSeconds}`,
        removeObject: async (key) => { mutableRemovals.push(key); },
        ...(exactVersion
            ? {
                capabilities: { conditionalDelete: true },
                removeObjectVersion: async ({ objectKey, etag, sizeBytes }) => {
                    versionRemovals.push(`${objectKey}#${etag}:${sizeBytes}`);
                    if (etag !== liveVersion.etag || sizeBytes !== liveVersion.sizeBytes) {
                        return 'version_replaced';
                    }
                    destroyed.push(`${objectKey}#${etag}:${sizeBytes}`);
                    return 'removed';
                },
            }
            : {}),
    };
    return { store, destroyed, mutableRemovals, versionRemovals };
};

const cancelAbandoned = async (
    store: AssignmentObjectStore,
): Promise<{ statusCode: number; body: unknown; errors: string[] }> => {
    const { router } = buildStudentRouter(ownSubmissionResponder([pendingUploadRow('sub-1', 1)]), undefined, {
        objectStore: store,
    });
    const originalError = console.error;
    const errors: string[] = [];
    console.error = (...args: unknown[]) => { errors.push(args.map((arg) => String(arg)).join(' ')); };
    try {
        const response = await invokeRoute(router, { method: 'POST', url: cancelUrl, token: STUDENT_A });
        return { statusCode: response.statusCode, body: response.body, errors };
    } finally {
        console.error = originalError;
    }
};

test('cancel: the abandoned version proven at the key is removed, and never by mutable key', async () => {
    const { store, destroyed, mutableRemovals, versionRemovals } = makeCancelStore({ etag: 'etag-1', sizeBytes: 2000 });

    const response = await cancelAbandoned(store);
    assert.equal(response.statusCode, 200, 'the cancellation response is unchanged by the cleanup');
    assert.deepEqual(response.body, { id: 'sub-1', status: 'revoked', cancelled: true });
    assert.deepEqual(versionRemovals, ['tenants/tenant-a/assignments/a-1/enr-a/sub-1.pdf#etag-1:2000'],
        'the delete names the version proven at the key, not the key alone');
    assert.deepEqual(destroyed, versionRemovals, 'the proven version is the one destroyed');
    assert.deepEqual(mutableRemovals, [], 'a cancel never deletes by mutable key');
});

test('cancel: a re-upload that lands after the stat survives the cleanup', async () => {
    // The key was rewritten between the cancel's stat and its delete: the store
    // now holds a different version than the one that was proven.
    const { store, destroyed, mutableRemovals, versionRemovals } = makeCancelStore(
        { etag: 'etag-1', sizeBytes: 2000 },
        { etag: 'etag-2', sizeBytes: 4096 },
    );

    const response = await cancelAbandoned(store);
    assert.equal(response.statusCode, 200, 'a lost cleanup race never fails the cancellation');
    assert.deepEqual(response.body, { id: 'sub-1', status: 'revoked', cancelled: true });
    assert.deepEqual(destroyed, [], 'the concurrent re-upload survives the cleanup');
    assert.deepEqual(mutableRemovals, [], 'no mutable-key delete is issued');
    assert.deepEqual(versionRemovals, ['tenants/tenant-a/assignments/a-1/enr-a/sub-1.pdf#etag-1:2000'],
        'the store was still asked to delete only the proven version, and refused');
});

test('cancel: an unprovable version or a key-only adapter deletes nothing and reports it pending', async () => {
    // A stat that yields no version: nothing may be deleted.
    const unbound = makeCancelStore({ etag: '', sizeBytes: 2000 });
    const unboundRun = await cancelAbandoned({
        ...unbound.store,
        statObject: async () => null,
    });
    assert.equal(unboundRun.statusCode, 200, 'the cancellation still succeeds');
    assert.deepEqual(unboundRun.body, { id: 'sub-1', status: 'revoked', cancelled: true });
    assert.deepEqual(unbound.destroyed, [], 'an absent object is not deleted');
    assert.deepEqual(unbound.mutableRemovals, [], 'nothing is deleted when the version cannot be proven');
    assert.ok(unboundRun.errors.some((line) => line.includes('Assignment cancel cleanup pending')),
        'the pending cleanup is reported to the operator');

    // A store that can only delete by key: the production MinIO adapter's shape.
    const keyOnly = makeCancelStore({ etag: 'etag-1', sizeBytes: 2000 }, undefined, false);
    const keyOnlyRun = await cancelAbandoned(keyOnly.store);
    assert.equal(keyOnlyRun.statusCode, 200, 'the cancellation still succeeds');
    assert.deepEqual(keyOnlyRun.body, { id: 'sub-1', status: 'revoked', cancelled: true });
    assert.deepEqual(keyOnly.mutableRemovals, [], 'a key-only adapter is never used to delete');
    assert.deepEqual(keyOnly.versionRemovals, [], 'no exact-version delete is even attempted');
    assert.ok(keyOnlyRun.errors.some((line) => line.includes('Assignment rejection cleanup pending')),
        'the pending cleanup is reported to the operator, never claimed as done');
});
