import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import { createAuthenticateToken } from '../src/middleware/auth';
import type { BranchAccessDeps } from '../src/security/branch-access';
import {
    enrollmentMatchesAssignment,
    evaluateSubmission,
    evaluateSubmissionWindow,
    normalizeAllowedFileTypes,
    normalizeLatePolicy,
    normalizeResubmissionPolicy,
    validateAssignmentInput,
    validateUploadMetadata,
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

test('validateUploadMetadata: accepts good metadata and rejects public URL / limits', () => {
    const good = validateUploadMetadata({ file_name: 'hw.pdf', file_type: 'application/pdf', file_size_bytes: 500, storage_key: 't/a/a-1/v1-hw.pdf' }, LIMITS);
    assert.equal(good.ok, true);
    assert.equal(validateUploadMetadata({ file_name: '../evil.pdf', file_type: 'application/pdf', file_size_bytes: 500, storage_key: 'a.pdf' }, LIMITS).ok, false);
    assert.equal(validateUploadMetadata({ file_name: 'hw.pdf', file_type: 'application/pdf', file_size_bytes: 500, storage_key: 'https://cdn.example.com/hw.pdf' }, LIMITS).ok, false);
    assert.equal(validateUploadMetadata({ file_name: 'hw.pdf', file_type: 'application/pdf', file_size_bytes: 500, storage_key: '/srv/hw.pdf' }, LIMITS).ok, false);
    assert.equal(validateUploadMetadata({ file_name: 'hw.pdf', file_type: 'application/pdf', file_size_bytes: 5000, storage_key: 'a.pdf' }, LIMITS).ok, false);
    assert.equal(validateUploadMetadata({ file_name: 'hw.exe', file_type: 'application/octet-stream', file_size_bytes: 500, storage_key: 'a.exe' }, LIMITS).ok, false);
    assert.equal(validateUploadMetadata({ file_name: 'noext', file_type: 'x', file_size_bytes: 500, storage_key: 'a' }, LIMITS).ok, false);
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

test('enrollmentMatchesAssignment: deny-by-default tenant/branch/group scope', () => {
    const tenantWide = { tenantId: 'tenant-a', branchScope: 'tenant', branchId: null, groupId: null };
    assert.equal(enrollmentMatchesAssignment(tenantWide, { tenantId: 'tenant-a', branchId: 'br-1', groupId: 'grp-1' }), true);
    assert.equal(enrollmentMatchesAssignment(tenantWide, { tenantId: 'tenant-b', branchId: null, groupId: null }), false);
    const branch = { tenantId: 'tenant-a', branchScope: 'branch', branchId: 'br-1', groupId: null };
    assert.equal(enrollmentMatchesAssignment(branch, { tenantId: 'tenant-a', branchId: 'br-1', groupId: null }), true);
    assert.equal(enrollmentMatchesAssignment(branch, { tenantId: 'tenant-a', branchId: 'br-2', groupId: null }), false);
    const group = { tenantId: 'tenant-a', branchScope: 'tenant', branchId: null, groupId: 'grp-1' };
    assert.equal(enrollmentMatchesAssignment(group, { tenantId: 'tenant-a', branchId: null, groupId: 'grp-1' }), true);
    assert.equal(enrollmentMatchesAssignment(group, { tenantId: 'tenant-a', branchId: null, groupId: 'grp-2' }), false);
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
}

const build = (
    fixtures: Fixtures = {},
    opts: { now?: Date; branchAccess?: BranchAccessDeps } = {},
) => {
    const responder = (sql: string): unknown[] | null => {
        if (sql.includes('FROM students s LEFT JOIN')) return [ENROLLMENT_A];
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

test('submit: an enrolled student creates version 1 with no public URL and audits', async () => {
    const { router, executed } = build();
    const response = await invokeRoute(router, {
        method: 'POST', url: '/a-1/submissions', token: STUDENT_A,
        body: { file_name: 'hw.pdf', file_type: 'application/pdf', file_size_bytes: 500, storage_key: 'tenant-a/a-1/hw.pdf' },
    });
    assert.equal(response.statusCode, 201);
    const body = response.body as Record<string, unknown>;
    assert.equal(body.version, 1);
    assert.equal(body.status, 'submitted');
    assert.equal(body.scan_status, 'pending');
    assert.equal('storage_key' in body, false);
    assert.ok(auditAction(executed, 'assignment.submission.create'));
});

test('submit: late policy marks a submission late, and a block policy denies it', async () => {
    const late = build(
        { assignment: { ...ASSIGNMENT, deadline_at: '2026-06-01 12:00:00', late_policy: 'mark_late' } },
        { now: new Date('2026-06-01T13:00:00Z') },
    );
    const lateRes = await invokeRoute(late.router, {
        method: 'POST', url: '/a-1/submissions', token: STUDENT_A,
        body: { file_name: 'hw.pdf', file_type: 'application/pdf', file_size_bytes: 500, storage_key: 'k.pdf' },
    });
    assert.equal(lateRes.statusCode, 201);
    assert.equal((lateRes.body as { status?: string }).status, 'late');

    const blocked = build(
        { assignment: { ...ASSIGNMENT, deadline_at: '2026-06-01 12:00:00', late_policy: 'block' } },
        { now: new Date('2026-06-01T13:00:00Z') },
    );
    const blockedRes = await invokeRoute(blocked.router, {
        method: 'POST', url: '/a-1/submissions', token: STUDENT_A,
        body: { file_name: 'hw.pdf', file_type: 'application/pdf', file_size_bytes: 500, storage_key: 'k.pdf' },
    });
    assert.equal(blockedRes.statusCode, 403);
    assert.equal((blockedRes.body as { code?: string }).code, 'DEADLINE_PASSED');
});

test('submit: rejects oversize and public-URL uploads with 400, cross-tenant with 404', async () => {
    const oversize = build();
    assert.equal((await invokeRoute(oversize.router, {
        method: 'POST', url: '/a-1/submissions', token: STUDENT_A,
        body: { file_name: 'hw.pdf', file_type: 'application/pdf', file_size_bytes: 2000000, storage_key: 'k.pdf' },
    })).statusCode, 400);

    const publicUrl = build();
    assert.equal((await invokeRoute(publicUrl.router, {
        method: 'POST', url: '/a-1/submissions', token: STUDENT_A,
        body: { file_name: 'hw.pdf', file_type: 'application/pdf', file_size_bytes: 500, storage_key: 'https://x/y.pdf' },
    })).statusCode, 400);

    const crossTenant = build({ assignment: { ...ASSIGNMENT, tenant_id: 'tenant-b' } });
    assert.equal((await invokeRoute(crossTenant.router, {
        method: 'POST', url: '/a-1/submissions', token: STUDENT_A,
        body: { file_name: 'hw.pdf', file_type: 'application/pdf', file_size_bytes: 500, storage_key: 'k.pdf' },
    })).statusCode, 404);
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
