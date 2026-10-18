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
    opts: { now?: Date; branchAccess?: BranchAccessDeps; storageStat?: (storageKey: string) => Promise<number | null> } = {},
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
        storageStat: opts.storageStat ?? (async () => 2000),
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

test('submit: an enrolled student creates version 1 with no public URL and audits', async () => {
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
    assert.equal('storage_key' in body, false);
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

test('submit: with no verified object the submission is recorded pending_upload (0 bytes, client size ignored)', async () => {
    const { router, executed } = build({}, { storageStat: async () => null });
    const response = await invokeRoute(router, {
        method: 'POST', url: '/a-1/submissions', token: STUDENT_A,
        body: { file_name: 'hw.pdf', file_type: 'application/pdf', file_size_bytes: 999999 },
    });
    assert.equal(response.statusCode, 201);
    const body = response.body as Record<string, unknown>;
    assert.equal(body.upload_status, 'pending_upload');
    assert.equal(body.file_size_bytes, 0);
    assert.equal(typeof body.storage_key, 'string', 'the creator receives their private upload target');
    const insert = executed.find((e) => e.sql.includes('INSERT INTO assignment_submissions'));
    assert.ok(insert);
    assert.equal(insert!.params[9], 0, 'no client size claim is persisted');
    assert.equal((insert!.params[10] as string).startsWith('tenants/tenant-a/assignments/a-1/enr-a/'), true);
    assert.equal(insert!.params[4], 'student-a');
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

test('submit: the verified size (not the client claim) enforces the limits, cross-tenant is 404', async () => {
    const oversize = build({}, { storageStat: async () => 2000000 });
    assert.equal((await invokeRoute(oversize.router, {
        method: 'POST', url: '/a-1/submissions', token: STUDENT_A,
        body: { file_name: 'hw.pdf', file_type: 'application/pdf', file_size_bytes: 500 },
    })).statusCode, 400);

    const undersize = build({}, { storageStat: async () => 5 });
    assert.equal((await invokeRoute(undersize.router, {
        method: 'POST', url: '/a-1/submissions', token: STUDENT_A,
        body: { file_name: 'hw.pdf', file_type: 'application/pdf' },
    })).statusCode, 400);

    const crossTenant = build({ assignment: { ...ASSIGNMENT, tenant_id: 'tenant-b' } });
    assert.equal((await invokeRoute(crossTenant.router, {
        method: 'POST', url: '/a-1/submissions', token: STUDENT_A,
        body: { file_name: 'hw.pdf', file_type: 'application/pdf' },
    })).statusCode, 404);
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
        storageStat: async () => 2000,
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
        storageStat: async () => 2000,
    });
    const response = await invokeRoute(router, {
        method: 'POST', url: '/a-1/submissions', token: STUDENT_A,
        body: { file_name: 'hw.pdf', file_type: 'application/pdf' },
    });
    assert.equal(response.statusCode, 403);
    assert.equal((response.body as { code?: string }).code, 'SUBMISSION_LIMIT_REACHED');
});

test('mine: returns only the caller own versions and leaks no storage key', async () => {
    const { router } = build({
        submissions: [SUBMISSION_ROW, { ...SUBMISSION_ROW, id: 'sub-2', student_enrollment_id: 'enr-b' }],
    });
    const response = await invokeRoute(router, { method: 'GET', url: '/a-1/submissions/mine', token: STUDENT_A });
    assert.equal(response.statusCode, 200);
    const body = response.body as Array<Record<string, unknown>>;
    assert.equal(body.length, 1);
    assert.equal('storage_key' in body[0], false);
});
