import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';
import { createAuthenticateToken } from '../src/middleware/auth';
import {
    isStudentEligibleForSession,
    normalizeAttendanceState,
    validateBulkInput,
    validateCorrectionInput,
    validateMarkInput,
} from '../src/services/attendance-records';
import {
    createAttendanceRecordsRouter,
    type AttendanceDataAccess,
} from '../src/routes/attendance-records';
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

const INSTRUCTOR_A = tokenFor({ id: 'instructor-a', role: 'instructor', tv: 0, tenant_id: 'tenant-a' });
const INSTRUCTOR_B = tokenFor({ id: 'instructor-b', role: 'instructor', tv: 0, tenant_id: 'tenant-b' });
const STUDENT_A = tokenFor({ id: 'student-a', role: 'student', tv: 0, student_enrollment_id: 'enr-a' });

// ---------------------------------------------------------------------------
// Pure domain policy
// ---------------------------------------------------------------------------

test('normalizeAttendanceState accepts only the four states', () => {
    assert.equal(normalizeAttendanceState('present'), 'present');
    assert.equal(normalizeAttendanceState('excused'), 'excused');
    assert.equal(normalizeAttendanceState('maybe'), null);
    assert.equal(normalizeAttendanceState(3), null);
});

test('validateMarkInput rejects malformed payloads and accepts a valid one', () => {
    assert.equal(validateMarkInput({}).ok, false);
    assert.equal(validateMarkInput({ student_id: 'stu-1' }).ok, false);
    assert.equal(validateMarkInput({ student_id: 'stu-1', state: 'present' }).ok, true);
    assert.equal(validateMarkInput({ student_id: '!bad!', state: 'present' }).ok, false);
    assert.equal(validateMarkInput({ student_id: 'stu-1', state: 'present', reason: 'x'.repeat(300) }).ok, false);
});

test('validateBulkInput rejects empty, oversized and duplicate payloads', () => {
    assert.equal(validateBulkInput({}).ok, false);
    assert.equal(validateBulkInput({ records: [] }).ok, false);
    assert.equal(validateBulkInput({ records: [{ student_id: 's1', state: 'present' }, { student_id: 's1', state: 'absent' }] }).ok, false);
    const ok = validateBulkInput({ records: [{ student_id: 's1', state: 'present' }, { student_id: 's2', state: 'late' }] });
    assert.equal(ok.ok, true);
    if (ok.ok) assert.equal(ok.value.records.length, 2);
});

test('validateCorrectionInput requires a state and a reason', () => {
    assert.equal(validateCorrectionInput({ state: 'present' }).ok, false);
    assert.equal(validateCorrectionInput({ reason: 'typo' }).ok, false);
    assert.equal(validateCorrectionInput({ state: 'excused', reason: 'medical note' }).ok, true);
});

test('isStudentEligibleForSession is deny-by-default by scope', () => {
    const tenantSession = { tenantId: 'tenant-a', groupId: null, branchId: null };
    assert.equal(isStudentEligibleForSession(tenantSession, { id: 's', tenantId: 'tenant-a', groupId: null, branchId: null }), true);
    assert.equal(isStudentEligibleForSession(tenantSession, { id: 's', tenantId: 'tenant-b', groupId: null, branchId: null }), false);

    const groupSession = { tenantId: 'tenant-a', groupId: 'grp-1', branchId: null };
    assert.equal(isStudentEligibleForSession(groupSession, { id: 's', tenantId: 'tenant-a', groupId: 'grp-1', branchId: null }), true);
    assert.equal(isStudentEligibleForSession(groupSession, { id: 's', tenantId: 'tenant-a', groupId: 'grp-2', branchId: null }), false);
    assert.equal(isStudentEligibleForSession(groupSession, { id: 's', tenantId: 'tenant-a', groupId: null, branchId: null }), false);

    const branchSession = { tenantId: 'tenant-a', groupId: null, branchId: 'br-1' };
    assert.equal(isStudentEligibleForSession(branchSession, { id: 's', tenantId: 'tenant-a', groupId: null, branchId: 'br-1' }), true);
    assert.equal(isStudentEligibleForSession(branchSession, { id: 's', tenantId: 'tenant-a', groupId: null, branchId: 'br-2' }), false);
});

// ---------------------------------------------------------------------------
// Route harness
// ---------------------------------------------------------------------------

const AUTHORITY: Record<string, string> = { 'instructor-a': 'instructor' };

const buildRouter = (responder: (sql: string, params: unknown[]) => unknown[] | null) => {
    const db = makeFakeDataAccess(responder);
    const users = {
        'instructor-a': { is_active: 1, token_version: 0, suspension_active: 0, role: 'instructor' },
        'instructor-b': { is_active: 1, token_version: 0, suspension_active: 0, role: 'instructor' },
        'student-a': { is_active: 1, token_version: 0, suspension_active: 0, role: 'student' },
    };
    const repository = makeRepository(users, {
        instructorAccounts: {
            'instructor-a': { tenant_status: 'active', legacy_compat: 1, allowed: 1 },
            'instructor-b': { tenant_status: 'active', legacy_compat: 1, allowed: 1 },
        },
        memberships: { 'instructor-a': [{ tenant_id: 'tenant-a' }], 'instructor-b': [{ tenant_id: 'tenant-b' }] },
        enrollments: {
            'student-a': [{ id: 'enr-a', user_id: 'student-a', tenant_id: 'tenant-a', instructor_id: 'instructor-a', group_id: 'grp-1', grade_id: null }],
        },
    });
    const router = createAttendanceRecordsRouter({
        db,
        authenticate: createAuthenticateToken(repository),
        loadActiveTenantAuthority: async (userId: string, tenantId: string) => {
            const authority = AUTHORITY[userId];
            return authority && tenantId === 'tenant-a' ? { authority } : null;
        },
        now: () => new Date('2026-06-01T00:00:00Z'),
        transaction: async <T>(fn: (tx: AttendanceDataAccess) => Promise<T>) => fn(db),
    });
    return { router, executed: db.executed };
};

const auditAction = (executed: { sql: string; params: unknown[] }[], action: string) =>
    executed.find((e) => e.sql.includes('INSERT INTO audit_events') && (e.params[3] as string) === action);

const sessionLoad = (sql: string) => sql.includes('FROM schedule_sessions') && sql.includes('WHERE id = ? AND tenant_id = ?');
const eligibleQuery = (sql: string) => sql.includes('FROM students s LEFT JOIN');
const existingQuery = (sql: string) => sql.includes('FROM attendance_records') && sql.includes('student_id=?');
const inserted = (executed: { sql: string }[]) => executed.some((e) => e.sql.includes('INSERT INTO attendance_records'));
const updated = (executed: { sql: string }[]) => executed.some((e) => e.sql.includes('UPDATE attendance_records'));

const sessionRecord = {
    id: 'se-1', tenant_id: 'tenant-a', branch_id: null, group_id: 'grp-1', title: 'x',
    audience: 'group', timezone: 'UTC', starts_at: '2026-06-01 09:00:00', ends_at: '2026-06-01 10:00:00',
    status: 'scheduled', created_by: 'instructor-a',
};

const recordRow = { id: 'ar-1', tenant_id: 'tenant-a', session_id: 'se-1', student_id: 'stu-1', state: 'absent', reason: null, version: 1 };

// --- single mark ---
test('attendance: anonymous mark is 401 with no data access', async () => {
    const { router, executed } = buildRouter(() => []);
    const response = await invokeRoute(router, { method: 'POST', url: '/sessions/se-1/records', body: { student_id: 'stu-1', state: 'present' } });
    assert.equal(response.statusCode, 401);
    assert.equal(executed.length, 0);
});

test('attendance: a cross-tenant instructor is 403', async () => {
    const { router } = buildRouter(() => []);
    const response = await invokeRoute(router, { method: 'POST', url: '/sessions/se-1/records', token: INSTRUCTOR_B, body: { student_id: 'stu-1', state: 'present' } });
    assert.equal(response.statusCode, 403);
});

test('attendance: invalid payload is 400 and no write', async () => {
    const { router, executed } = buildRouter(() => []);
    const response = await invokeRoute(router, { method: 'POST', url: '/sessions/se-1/records', token: INSTRUCTOR_A, body: { student_id: 'stu-1', state: 'maybe' } });
    assert.equal(response.statusCode, 400);
    assert.equal(inserted(executed), false);
});

test('attendance: an unknown session is 404', async () => {
    const { router } = buildRouter((sql) => (sessionLoad(sql) ? [] : []));
    const response = await invokeRoute(router, { method: 'POST', url: '/sessions/missing/records', token: INSTRUCTOR_A, body: { student_id: 'stu-1', state: 'present' } });
    assert.equal(response.statusCode, 404);
});

test('attendance: a cancelled session cannot be marked (409)', async () => {
    const { router, executed } = buildRouter((sql) => (sessionLoad(sql) ? [{ ...sessionRecord, status: 'cancelled' }] : []));
    const response = await invokeRoute(router, { method: 'POST', url: '/sessions/se-1/records', token: INSTRUCTOR_A, body: { student_id: 'stu-1', state: 'present' } });
    assert.equal(response.statusCode, 409);
    assert.equal(inserted(executed), false);
});

test('attendance: a student not enrolled in the session is 403 and no write', async () => {
    const { router, executed } = buildRouter((sql) => {
        if (sessionLoad(sql)) return [sessionRecord];
        if (eligibleQuery(sql)) return [];
        return [];
    });
    const response = await invokeRoute(router, { method: 'POST', url: '/sessions/se-1/records', token: INSTRUCTOR_A, body: { student_id: 'stu-9', state: 'present' } });
    assert.equal(response.statusCode, 403);
    assert.equal(inserted(executed), false);
});

test('attendance: a new mark inserts, audits actor/time/reason and returns 201', async () => {
    const { router, executed } = buildRouter((sql) => {
        if (sessionLoad(sql)) return [sessionRecord];
        if (eligibleQuery(sql)) return [{ id: 'stu-1' }];
        if (existingQuery(sql)) return [];
        return [];
    });
    const response = await invokeRoute(router, {
        method: 'POST', url: '/sessions/se-1/records', token: INSTRUCTOR_A,
        body: { student_id: 'stu-1', state: 'present', reason: 'arrived' },
    });
    assert.equal(response.statusCode, 201);
    assert.equal((response.body as { state?: string }).state, 'present');
    const insert = executed.find((e) => e.sql.includes('INSERT INTO attendance_records'));
    assert.ok(insert);
    assert.match(insert!.sql, /marked_at/);
    const audit = auditAction(executed, 'attendance.mark');
    assert.ok(audit);
    assert.equal(audit!.params[1], 'instructor-a');
    assert.equal(audit!.params[8], 'arrived');
});

test('attendance: an identical re-mark is idempotent (200, no write)', async () => {
    const { router, executed } = buildRouter((sql) => {
        if (sessionLoad(sql)) return [sessionRecord];
        if (eligibleQuery(sql)) return [{ id: 'stu-1' }];
        if (existingQuery(sql)) return [{ ...recordRow, state: 'present' }];
        return [];
    });
    const response = await invokeRoute(router, {
        method: 'POST', url: '/sessions/se-1/records', token: INSTRUCTOR_A,
        body: { student_id: 'stu-1', state: 'present' },
    });
    assert.equal(response.statusCode, 200);
    assert.equal((response.body as { idempotent?: boolean }).idempotent, true);
    assert.equal(inserted(executed), false);
    assert.equal(updated(executed), false);
});

test('attendance: a changed re-mark becomes an audited correction (before/after)', async () => {
    const { router, executed } = buildRouter((sql) => {
        if (sessionLoad(sql)) return [sessionRecord];
        if (eligibleQuery(sql)) return [{ id: 'stu-1' }];
        if (existingQuery(sql)) return [recordRow];
        return [];
    });
    const response = await invokeRoute(router, {
        method: 'POST', url: '/sessions/se-1/records', token: INSTRUCTOR_A,
        body: { student_id: 'stu-1', state: 'present', reason: 'was actually here' },
    });
    assert.equal(response.statusCode, 200);
    assert.equal((response.body as { outcome?: string }).outcome, 'corrected');
    assert.equal(inserted(executed), false);
    assert.equal(updated(executed), true);
    const audit = auditAction(executed, 'attendance.correct');
    assert.ok(audit);
    const oldValue = JSON.parse(audit!.params[6] as string) as { state: string };
    assert.equal(oldValue.state, 'absent');
    const newValue = JSON.parse(audit!.params[7] as string) as { state: string };
    assert.equal(newValue.state, 'present');
});

test('attendance: a duplicate-key race on the first mark returns the existing row as unchanged (no 500)', async () => {
    let recordLookups = 0;
    let insertAttempts = 0;
    const db = makeFakeDataAccess((sql) => {
        if (sessionLoad(sql)) return [{ ...sessionRecord, status: 'scheduled' }];
        if (eligibleQuery(sql)) return [{ id: 'stu-1' }];
        if (existingQuery(sql)) {
            recordLookups += 1;
            return recordLookups === 1 ? [] : [{ ...recordRow, state: 'present' }];
        }
        return [];
    });
    const repository = makeRepository(
        { 'instructor-a': { is_active: 1, token_version: 0, suspension_active: 0, role: 'instructor' } },
        { instructorAccounts: { 'instructor-a': { tenant_status: 'active', legacy_compat: 1, allowed: 1 } }, memberships: { 'instructor-a': [{ tenant_id: 'tenant-a' }] } },
    );
    const dataAccess: AttendanceDataAccess = {
        query: db.query,
        queryOne: db.queryOne,
        execute: async (sql, params) => {
            if (sql.includes('INSERT INTO attendance_records')) {
                insertAttempts += 1;
                throw Object.assign(new Error('duplicate key'), { code: 'ER_DUP_ENTRY' });
            }
            return db.execute(sql, params);
        },
    };
    const router = createAttendanceRecordsRouter({
        db: dataAccess,
        authenticate: createAuthenticateToken(repository),
        loadActiveTenantAuthority: async () => ({ authority: 'instructor' }),
        transaction: async <T>(fn: (tx: AttendanceDataAccess) => Promise<T>) => fn(dataAccess),
    });
    const response = await invokeRoute(router, {
        method: 'POST', url: '/sessions/se-1/records', token: INSTRUCTOR_A,
        body: { student_id: 'stu-1', state: 'present', reason: 'arrived' },
    });
    assert.equal(response.statusCode, 200);
    const body = response.body as { outcome?: string; idempotent?: boolean; id?: string; state?: string };
    assert.equal(body.outcome, 'unchanged');
    assert.equal(body.idempotent, true);
    assert.equal(body.id, 'ar-1', 'the winner committed row is reported');
    assert.equal(body.state, 'present');
    assert.equal(insertAttempts, 1,
        'only the single losing insert attempt is made');
    const raceRead = db.executed
        .filter((statement) => statement.kind === 'queryOne' && statement.sql.includes('FROM attendance_records'))
        .pop();
    assert.ok(raceRead);
    assert.match(raceRead!.sql, /FOR UPDATE/,
        'the race re-read is a locking read so it sees the winner committed after this transaction snapshot');
    assert.equal(auditAction(db.executed, 'attendance.mark'), undefined,
        'the losing mark never audits itself');
});

// --- bulk mark ---
test('attendance: bulk mark rejects an empty or duplicate payload with 400', async () => {
    const { router, executed } = buildRouter(() => []);
    const empty = await invokeRoute(router, { method: 'POST', url: '/sessions/se-1/records/bulk', token: INSTRUCTOR_A, body: { records: [] } });
    assert.equal(empty.statusCode, 400);
    const dup = await invokeRoute(router, {
        method: 'POST', url: '/sessions/se-1/records/bulk', token: INSTRUCTOR_A,
        body: { records: [{ student_id: 'stu-1', state: 'present' }, { student_id: 'stu-1', state: 'absent' }] },
    });
    assert.equal(dup.statusCode, 400);
    assert.equal(inserted(executed), false);
});

test('attendance: bulk mark with an ineligible student writes nothing (403)', async () => {
    const { router, executed } = buildRouter((sql) => {
        if (sessionLoad(sql)) return [sessionRecord];
        if (eligibleQuery(sql)) return [{ id: 'stu-1' }];
        return [];
    });
    const response = await invokeRoute(router, {
        method: 'POST', url: '/sessions/se-1/records/bulk', token: INSTRUCTOR_A,
        body: { records: [{ student_id: 'stu-1', state: 'present' }, { student_id: 'stu-2', state: 'absent' }] },
    });
    assert.equal(response.statusCode, 403);
    assert.equal(inserted(executed), false);
});

test('attendance: bulk mark is atomic and reports created/corrected/unchanged', async () => {
    // The existing-record lookup is answered per student: stu-2 is already
    // present (idempotent), stu-3 is already absent (correction), stu-1 is new.
    const db = makeFakeDataAccess((sql, params) => {
        if (sessionLoad(sql)) return [sessionRecord];
        if (eligibleQuery(sql)) return [{ id: 'stu-1' }, { id: 'stu-2' }, { id: 'stu-3' }];
        if (existingQuery(sql)) {
            const studentId = params[2];
            if (studentId === 'stu-2') return [{ ...recordRow, id: 'ar-2', student_id: 'stu-2', state: 'present' }];
            if (studentId === 'stu-3') return [{ ...recordRow, id: 'ar-3', student_id: 'stu-3', state: 'absent' }];
            return [];
        }
        return [];
    });
    const repository = makeRepository(
        { 'instructor-a': { is_active: 1, token_version: 0, suspension_active: 0, role: 'instructor' } },
        { instructorAccounts: { 'instructor-a': { tenant_status: 'active', legacy_compat: 1, allowed: 1 } }, memberships: { 'instructor-a': [{ tenant_id: 'tenant-a' }] } },
    );
    const router = createAttendanceRecordsRouter({
        db,
        authenticate: createAuthenticateToken(repository),
        loadActiveTenantAuthority: async () => ({ authority: 'instructor' }),
        transaction: async <T>(fn: (tx: AttendanceDataAccess) => Promise<T>) => fn(db),
    });
    const response = await invokeRoute(router, {
        method: 'POST', url: '/sessions/se-1/records/bulk', token: INSTRUCTOR_A,
        body: {
            records: [
                { student_id: 'stu-1', state: 'present' },
                { student_id: 'stu-2', state: 'present' },
                { student_id: 'stu-3', state: 'late', reason: 'late bus' },
            ],
        },
    });
    assert.equal(response.statusCode, 200);
    const body = response.body as { created: number; corrected: number; unchanged: number };
    assert.equal(body.created, 1);
    assert.equal(body.corrected, 1);
    assert.equal(body.unchanged, 1);
    assert.equal(db.executed.filter((e) => e.sql.includes('INSERT INTO attendance_records')).length, 1);
    assert.equal(db.executed.filter((e) => e.sql.includes('UPDATE attendance_records')).length, 1);
});

// --- correction endpoint ---
const correctionLoad = (sql: string) => sql.includes('FROM attendance_records a') && sql.includes('INNER JOIN schedule_sessions ss');

test('attendance: correction rejects a missing reason and an unknown record', async () => {
    const noReason = buildRouter(() => []);
    assert.equal((await invokeRoute(noReason.router, { method: 'POST', url: '/records/ar-1/correct', token: INSTRUCTOR_A, body: { state: 'present' } })).statusCode, 400);
    const unknown = buildRouter(() => []);
    assert.equal((await invokeRoute(unknown.router, { method: 'POST', url: '/records/ar-1/correct', token: INSTRUCTOR_A, body: { state: 'present', reason: 'fix' } })).statusCode, 404);
});

test('attendance: a correction to the same state is 409', async () => {
    const { router } = buildRouter((sql) => (correctionLoad(sql) ? [recordRow] : []));
    const response = await invokeRoute(router, { method: 'POST', url: '/records/ar-1/correct', token: INSTRUCTOR_A, body: { state: 'absent', reason: 'fix' } });
    assert.equal(response.statusCode, 409);
});

test('attendance: correction is audited with before/after', async () => {
    const { router, executed } = buildRouter((sql) => (correctionLoad(sql) ? [recordRow] : []));
    const response = await invokeRoute(router, { method: 'POST', url: '/records/ar-1/correct', token: INSTRUCTOR_A, body: { state: 'excused', reason: 'medical note' } });
    assert.equal(response.statusCode, 200);
    assert.equal(updated(executed), true);
    const audit = auditAction(executed, 'attendance.correct');
    assert.ok(audit);
    const oldValue = JSON.parse(audit!.params[6] as string) as { state: string };
    const newValue = JSON.parse(audit!.params[7] as string) as { state: string };
    assert.equal(oldValue.state, 'absent');
    assert.equal(newValue.state, 'excused');
});

test('attendance: correction is scoped by the session visibility predicate (deny by default)', async () => {
    const { router, executed } = buildRouter(() => []);
    const response = await invokeRoute(router, { method: 'POST', url: '/records/ar-1/correct', token: INSTRUCTOR_A, body: { state: 'excused', reason: 'fix' } });
    assert.equal(response.statusCode, 404);
    const load = executed.find((e) => correctionLoad(e.sql));
    assert.ok(load);
    assert.match(load!.sql, /instructor_id = \?/);
    assert.equal(load!.params[1], 'tenant-a');
});

// ---------------------------------------------------------------------------
// 2026-10-19 exact-assignment boundaries + correction reason requirement
// ---------------------------------------------------------------------------

const BRANCH_BOUND_INSTRUCTOR = tokenFor({
    id: 'instructor-a', role: 'instructor', tv: 0, tenant_id: 'tenant-a',
    branch_id: 'br-1', branch_membership_version: 0,
});

const buildBranchBoundRouter = (responder: (sql: string, params: unknown[]) => unknown[] | null) => {
    const repository = makeRepository(
        { 'instructor-a': { is_active: 1, token_version: 0, suspension_active: 0, role: 'instructor' } },
        {
            instructorAccounts: { 'instructor-a': { tenant_status: 'active', legacy_compat: 1, allowed: 1 } },
            memberships: { 'instructor-a': [{ tenant_id: 'tenant-a' }] },
        },
    );
    const db = makeFakeDataAccess(responder);
    const router = createAttendanceRecordsRouter({
        db,
        authenticate: createAuthenticateToken({
            ...repository,
            findBranchSession: async () => ({
                branch_id: 'br-1', branch_tenant_id: 'tenant-a', branch_status: 'active',
                branch_version: 0, membership_status: 'active', membership_version: 0, membership_role: 'instructor',
            }),
        }),
        loadActiveTenantAuthority: async (_userId: string, tenantId: string) =>
            (tenantId === 'tenant-a' ? { authority: 'instructor' } : null),
        now: () => new Date('2026-06-01T00:00:00Z'),
        transaction: async <T>(fn: (tx: AttendanceDataAccess) => Promise<T>) => fn(db),
    });
    return { router, executed: db.executed };
};

test('attendance: a verified branch membership alone does not widen the staff session load', async () => {
    const { router, executed } = buildBranchBoundRouter(() => []);
    const response = await invokeRoute(router, {
        method: 'POST', url: '/sessions/se-foreign/records', token: BRANCH_BOUND_INSTRUCTOR,
        body: { student_id: 'stu-1', state: 'present' },
    });
    assert.equal(response.statusCode, 404);
    const load = executed.find((e) => sessionLoad(e.sql));
    assert.ok(load);
    assert.match(load!.sql, /group_id IN \(SELECT id FROM `groups` WHERE instructor_id = \?\)/);
    assert.doesNotMatch(load!.sql, /branch_id = \?/);
    assert.equal(load!.params.includes('br-1'), false);
});

test('attendance: a changed re-mark without a reason is 400 with no writes and no audit', async () => {
    const { router, executed } = buildRouter((sql) => {
        if (sessionLoad(sql)) return [sessionRecord];
        if (eligibleQuery(sql)) return [{ id: 'stu-1' }];
        if (existingQuery(sql)) return [recordRow];
        return [];
    });
    const response = await invokeRoute(router, {
        method: 'POST', url: '/sessions/se-1/records', token: INSTRUCTOR_A,
        body: { student_id: 'stu-1', state: 'present' },
    });
    assert.equal(response.statusCode, 400);
    assert.equal(inserted(executed), false);
    assert.equal(updated(executed), false);
    assert.equal(auditAction(executed, 'attendance.correct'), undefined);
});

test('attendance: a blank or whitespace-only reason on a correction is 400 with no writes', async () => {
    for (const reason of [undefined, '', '   ']) {
        const { router, executed } = buildRouter((sql) => {
            if (sessionLoad(sql)) return [sessionRecord];
            if (eligibleQuery(sql)) return [{ id: 'stu-1' }];
            if (existingQuery(sql)) return [recordRow];
            return [];
        });
        const response = await invokeRoute(router, {
            method: 'POST', url: '/sessions/se-1/records', token: INSTRUCTOR_A,
            body: { student_id: 'stu-1', state: 'present', ...(reason === undefined ? {} : { reason }) },
        });
        assert.equal(response.statusCode, 400);
        assert.equal(updated(executed), false);
        assert.equal(auditAction(executed, 'attendance.correct'), undefined);
    }
    // The dedicated correction endpoint denies the same blank/whitespace reason.
    const { router, executed } = buildRouter((sql) => (correctionLoad(sql) ? [recordRow] : []));
    const direct = await invokeRoute(router, {
        method: 'POST', url: '/records/ar-1/correct', token: INSTRUCTOR_A, body: { state: 'excused', reason: ' \t ' },
    });
    assert.equal(direct.statusCode, 400);
    assert.equal(updated(executed), false);
});

test('attendance: a valid correction through the mark path keeps the reason on the row', async () => {
    const { router, executed } = buildRouter((sql) => {
        if (sessionLoad(sql)) return [sessionRecord];
        if (eligibleQuery(sql)) return [{ id: 'stu-1' }];
        if (existingQuery(sql)) return [recordRow];
        return [];
    });
    const response = await invokeRoute(router, {
        method: 'POST', url: '/sessions/se-1/records', token: INSTRUCTOR_A,
        body: { student_id: 'stu-1', state: 'present', reason: 'arrived after the bell' },
    });
    assert.equal(response.statusCode, 200);
    assert.equal((response.body as { outcome?: string }).outcome, 'corrected');
    const update = executed.find((e) => e.sql.includes('UPDATE attendance_records'));
    assert.ok(update);
    assert.equal(update!.params[0], 'present');
    assert.equal(update!.params[1], 'arrived after the bell');
    assert.equal(update!.params[3], 'arrived after the bell');
});

test('attendance: a bulk batch containing a reasonless correction is rejected 400 with no writes', async () => {
    const { router, executed } = buildRouter((sql) => {
        if (sessionLoad(sql)) return [sessionRecord];
        if (eligibleQuery(sql)) return [{ id: 'stu-1' }, { id: 'stu-2' }];
        if (existingQuery(sql)) return [{ ...recordRow, student_id: 'stu-1' }];
        return [];
    });
    const response = await invokeRoute(router, {
        method: 'POST', url: '/sessions/se-1/records/bulk', token: INSTRUCTOR_A,
        body: { records: [
            { student_id: 'stu-1', state: 'present' },
            { student_id: 'stu-2', state: 'absent' },
        ] },
    });
    assert.equal(response.statusCode, 400);
    assert.equal(inserted(executed), false);
    assert.equal(updated(executed), false);
    assert.equal(auditAction(executed, 'attendance.correct'), undefined);
    assert.equal(auditAction(executed, 'attendance.mark'), undefined);
});

// --- student own ---
test('attendance: a non-student cannot read /me (403)', async () => {
    const { router } = buildRouter(() => []);
    const response = await invokeRoute(router, { method: 'GET', url: '/me', token: INSTRUCTOR_A });
    assert.equal(response.statusCode, 403);
});

test('attendance: a student with no enrollment is 404', async () => {
    const { router } = buildRouter(() => []);
    const response = await invokeRoute(router, { method: 'GET', url: '/me', token: STUDENT_A });
    assert.equal(response.statusCode, 404);
});

test('attendance: a student only ever reads their own records', async () => {
    const { router, executed } = buildRouter((sql) => {
        if (sql.includes('FROM students') && sql.includes('user_id=?')) return [{ id: 'stu-1', tenant_id: 'tenant-a' }];
        if (sql.includes('FROM attendance_records a') && sql.includes('INNER JOIN schedule_sessions ss')) return [{ id: 'ar-1', state: 'present' }];
        return [];
    });
    const response = await invokeRoute(router, { method: 'GET', url: '/me', token: STUDENT_A });
    assert.equal(response.statusCode, 200);
    const feed = executed.find((e) => e.sql.includes('INNER JOIN schedule_sessions ss') && e.sql.includes('a.student_id=?'));
    assert.ok(feed);
    assert.equal(feed!.params[0], 'stu-1');
    assert.equal(feed!.params[1], 'tenant-a');
});

// --- audit failure rolls back ---
test('attendance: an audit failure fails the mark (500)', async () => {
    const db = makeFakeDataAccess((sql) => {
        if (sessionLoad(sql)) return [sessionRecord];
        if (eligibleQuery(sql)) return [{ id: 'stu-1' }];
        return [];
    });
    const execute = async (sql: string, params?: unknown[]) => {
        if (sql.includes('INSERT INTO audit_events')) throw new Error('audit storage unavailable');
        return db.execute(sql, params);
    };
    const repository = makeRepository(
        { 'instructor-a': { is_active: 1, token_version: 0, suspension_active: 0, role: 'instructor' } },
        { instructorAccounts: { 'instructor-a': { tenant_status: 'active', legacy_compat: 1, allowed: 1 } }, memberships: { 'instructor-a': [{ tenant_id: 'tenant-a' }] } },
    );
    const tx: AttendanceDataAccess = { query: db.query, queryOne: db.queryOne, execute };
    const router = createAttendanceRecordsRouter({
        db: tx,
        authenticate: createAuthenticateToken(repository),
        loadActiveTenantAuthority: async () => ({ authority: 'instructor' }),
        transaction: async <T>(fn: (tx: AttendanceDataAccess) => Promise<T>) => fn(tx),
    });
    const response = await invokeRoute(router, { method: 'POST', url: '/sessions/se-1/records', token: INSTRUCTOR_A, body: { student_id: 'stu-1', state: 'present' } });
    assert.equal(response.statusCode, 500);
});

// --- stale-version corrections through the mark path ---
const buildStaleVersionRouter = (rows: Record<string, { id: string; state: string }>) => {
    const db = makeFakeDataAccess((sql, params) => {
        if (sessionLoad(sql)) return [sessionRecord];
        if (eligibleQuery(sql)) return Object.keys(rows).map((id) => ({ id }));
        if (existingQuery(sql)) {
            const row = rows[params[2] as string];
            return row ? [{ ...recordRow, id: row.id, student_id: params[2], state: row.state }] : [];
        }
        return [];
    });
    const dataAccess: AttendanceDataAccess = {
        query: db.query,
        queryOne: db.queryOne,
        // The version guard loses: another writer already bumped the version.
        execute: async (sql, params) => {
            if (sql.includes('UPDATE attendance_records')) {
                db.executed.push({ sql, params: params ?? [], kind: 'execute' });
                return { affectedRows: 0 };
            }
            return db.execute(sql, params);
        },
    };
    const repository = makeRepository(
        { 'instructor-a': { is_active: 1, token_version: 0, suspension_active: 0, role: 'instructor' } },
        { instructorAccounts: { 'instructor-a': { tenant_status: 'active', legacy_compat: 1, allowed: 1 } }, memberships: { 'instructor-a': [{ tenant_id: 'tenant-a' }] } },
    );
    const router = createAttendanceRecordsRouter({
        db: dataAccess,
        authenticate: createAuthenticateToken(repository),
        loadActiveTenantAuthority: async () => ({ authority: 'instructor' }),
        transaction: async <T>(fn: (tx: AttendanceDataAccess) => Promise<T>) => fn(dataAccess),
    });
    return { router, executed: db.executed };
};

test('attendance: a stale-version correction through single mark is 409, not 500, and is not audited', async () => {
    const { router, executed } = buildStaleVersionRouter({ 'stu-1': { id: 'ar-1', state: 'absent' } });
    const response = await invokeRoute(router, {
        method: 'POST', url: '/sessions/se-1/records', token: INSTRUCTOR_A,
        body: { student_id: 'stu-1', state: 'present', reason: 'was here' },
    });
    assert.equal(response.statusCode, 409);
    assert.equal(auditAction(executed, 'attendance.correct'), undefined);
});

test('attendance: a stale-version correction inside a bulk batch is 409, not 500', async () => {
    const { router, executed } = buildStaleVersionRouter({ 'stu-1': { id: 'ar-1', state: 'absent' } });
    const response = await invokeRoute(router, {
        method: 'POST', url: '/sessions/se-1/records/bulk', token: INSTRUCTOR_A,
        body: { records: [{ student_id: 'stu-1', state: 'present', reason: 'was here' }] },
    });
    assert.equal(response.statusCode, 409);
    assert.equal(auditAction(executed, 'attendance.correct'), undefined);
});

// ---------------------------------------------------------------------------
// 2026-10-20 T3: bounded time filters, deterministic pagination and an
// explicit truncation indicator on the attendance list feeds, plus consistent
// correction metadata on the dedicated correction endpoint.
// ---------------------------------------------------------------------------

const STAFF_RECORDS_CAP = 500;
const STUDENT_RECORDS_CAP = 200;

/** The LIMIT the route asked MySQL for (the fake data access does not apply it). */
const limitOf = (sql: string): number => {
    const match = /LIMIT (\d+)/.exec(sql);
    return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
};

const pad2 = (value: number): string => String(value).padStart(2, '0');

const staffRecordPool = (count: number): Record<string, unknown>[] =>
    Array.from({ length: count }, (_, i) => ({
        id: `ar-${i + 1}`,
        session_id: 'se-1',
        student_id: `stu-${i + 1}`,
        state: 'present',
        reason: null,
        marked_at: `2026-01-${pad2((i % 28) + 1)} 08:00:00`,
    }));

/** Emulates the staff records list: params are [tenantId, sessionId, from?, to?]. */
const emulateStaffRecordList = (pool: Record<string, unknown>[]) => (sql: string, params: unknown[]): unknown[] => {
    if (!sql.includes('FROM attendance_records') || !sql.includes('ORDER BY student_id')) return [];
    const from = params[2] as string | undefined;
    const to = params[3] as string | undefined;
    const filtered = pool.filter((row) =>
        (from === undefined || String(row['marked_at']) >= from) && (to === undefined || String(row['marked_at']) <= to));
    const sorted = [...filtered].sort((a, b) =>
        String(a['student_id']).localeCompare(String(b['student_id'])) || String(a['id']).localeCompare(String(b['id'])));
    return sorted.slice(0, limitOf(sql));
};

const buildStaffRecordsRouter = (pool: Record<string, unknown>[]) => buildRouter((sql, params) => {
    if (sessionLoad(sql)) return [sessionRecord];
    return emulateStaffRecordList(pool)(sql, params);
});

test('attendance: the staff records list exposes truncation instead of silently dropping rows past the cap', async () => {
    const { router, executed } = buildStaffRecordsRouter(staffRecordPool(505));
    const response = await invokeRoute(router, { method: 'GET', url: '/sessions/se-1/records', token: INSTRUCTOR_A });
    assert.equal(response.statusCode, 200);
    const body = response.body as { session_id?: string; records?: { id: string }[] };
    assert.deepEqual(
        Object.keys(body).sort(),
        ['records', 'session_id'],
        'exactly the pre-batch envelope keys, with nothing added',
    );
    assert.equal(body.session_id, 'se-1');
    assert.equal(response.headers?.['x-results-truncated'], 'true', 'the list must say it is truncated');
    assert.equal(body.records?.length, STAFF_RECORDS_CAP);
    assert.equal(body.records?.[0]?.id, 'ar-1');
    const list = executed.find((e) => e.sql.includes('FROM attendance_records'));
    assert.ok(list);
    assert.match(list!.sql, /ORDER BY student_id ASC, id ASC/);
    assert.equal(limitOf(list!.sql), STAFF_RECORDS_CAP + 1);
});

test('attendance: the staff records list pages with validated from/to bounds on marked_at', async () => {
    const { router, executed } = buildStaffRecordsRouter(staffRecordPool(505));
    const response = await invokeRoute(router, {
        method: 'GET', url: '/sessions/se-1/records', token: INSTRUCTOR_A,
        query: { from: '2026-01-10', to: '2026-01-12 08:00:00' },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers?.['x-results-truncated'], 'false');
    const body = response.body as { records?: { id: string }[] };
    assert.equal(body.records?.length, 54, 'marked_at days 10, 11 and 12, eighteen records per day');
    const list = executed.filter((e) => e.sql.includes('FROM attendance_records')).pop();
    assert.ok(list);
    assert.match(list!.sql, /marked_at >= \?/);
    assert.match(list!.sql, /marked_at <= \?/);
    assert.equal(list!.params[2], '2026-01-10 00:00:00');
    assert.equal(list!.params[3], '2026-01-12 08:00:00');
});

test('attendance: the staff records list rejects a malformed to bound with 400 and no list query', async () => {
    const { router, executed } = buildStaffRecordsRouter(staffRecordPool(1));
    const response = await invokeRoute(router, {
        method: 'GET', url: '/sessions/se-1/records', token: INSTRUCTOR_A, query: { to: 'never' },
    });
    assert.equal(response.statusCode, 400);
    assert.match((response.body as { error?: string }).error ?? '', /^to must/);
    assert.equal(executed.some((e) => e.sql.includes('FROM attendance_records')), false);
});

const studentRecordPool = (count: number): Record<string, unknown>[] =>
    Array.from({ length: count }, (_, i) => ({
        id: `ar-${i + 1}`,
        session_id: `se-${i + 1}`,
        student_id: 'stu-1',
        state: 'present',
        reason: null,
        marked_at: '2026-01-01 08:00:00',
        title: 'Class',
        starts_at: `2026-01-${pad2((i % 28) + 1)} 09:00:00`,
        ends_at: `2026-01-${pad2((i % 28) + 1)} 10:00:00`,
        timezone: 'UTC',
    }));

/** Emulates the student /me join: params are [studentId, tenantId, from?, to?]. */
const emulateStudentRecordList = (pool: Record<string, unknown>[]) => (sql: string, params: unknown[]): unknown[] => {
    if (!sql.includes('FROM attendance_records a') || !sql.includes('a.student_id=?')) return [];
    const from = params[2] as string | undefined;
    const to = params[3] as string | undefined;
    const filtered = pool.filter((row) =>
        (from === undefined || String(row['starts_at']) >= from) && (to === undefined || String(row['starts_at']) <= to));
    const sorted = [...filtered].sort((a, b) =>
        String(b['starts_at']).localeCompare(String(a['starts_at'])) || String(b['session_id']).localeCompare(String(a['session_id'])));
    return sorted.slice(0, limitOf(sql));
};

const buildStudentRecordsRouter = (pool: Record<string, unknown>[]) => buildRouter((sql, params) => {
    if (sql.includes('FROM students') && sql.includes('user_id=?')) return [{ id: 'stu-1', tenant_id: 'tenant-a' }];
    return emulateStudentRecordList(pool)(sql, params);
});

test('attendance: the student /me history exposes truncation instead of silently dropping records past the cap', async () => {
    const { router, executed } = buildStudentRecordsRouter(studentRecordPool(205));
    const response = await invokeRoute(router, { method: 'GET', url: '/me', token: STUDENT_A });
    assert.equal(response.statusCode, 200);
    const body = response.body as { student_id?: string; records?: { id: string }[] };
    assert.deepEqual(
        Object.keys(body).sort(),
        ['records', 'student_id'],
        'exactly the pre-batch envelope keys, with nothing added',
    );
    assert.equal(body.student_id, 'stu-1');
    assert.equal(response.headers?.['x-results-truncated'], 'true');
    assert.equal(body.records?.length, STUDENT_RECORDS_CAP);
    const feed = executed.find((e) => e.sql.includes('FROM attendance_records a'));
    assert.ok(feed);
    assert.match(feed!.sql, /ORDER BY ss\.starts_at DESC, ss\.id DESC/);
    assert.equal(limitOf(feed!.sql), STUDENT_RECORDS_CAP + 1);
});

test('attendance: the student /me history pages with a from bound on the session start', async () => {
    const { router, executed } = buildStudentRecordsRouter(studentRecordPool(205));
    const response = await invokeRoute(router, { method: 'GET', url: '/me', token: STUDENT_A, query: { from: '2026-01-27' } });
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers?.['x-results-truncated'], 'false');
    const body = response.body as { records?: { id: string }[] };
    assert.equal(body.records?.length, 14, 'sessions starting on 2026-01-27 and 2026-01-28, seven per day');
    const feed = executed.find((e) => e.sql.includes('FROM attendance_records a'));
    assert.ok(feed);
    assert.match(feed!.sql, /ss\.starts_at >= \?/);
    assert.equal(feed!.params[2], '2026-01-27 00:00:00');
});

test('attendance: the student /me history rejects an inverted range with 400 and no feed query', async () => {
    const { router, executed } = buildStudentRecordsRouter(studentRecordPool(1));
    const response = await invokeRoute(router, {
        method: 'GET', url: '/me', token: STUDENT_A, query: { from: '2026-02-01', to: '2026-01-01' },
    });
    assert.equal(response.statusCode, 400);
    assert.match((response.body as { error?: string }).error ?? '', /from must not be after to/);
    assert.equal(executed.some((e) => e.sql.includes('FROM attendance_records a')), false);
});

test('attendance: the correction endpoint writes reason and correction_reason like the mark path', async () => {
    const { router, executed } = buildRouter((sql) => (correctionLoad(sql) ? [recordRow] : []));
    const response = await invokeRoute(router, {
        method: 'POST', url: '/records/ar-1/correct', token: INSTRUCTOR_A, body: { state: 'excused', reason: 'medical note' },
    });
    assert.equal(response.statusCode, 200);
    assert.equal((response.body as { reason?: string }).reason, 'medical note');
    const update = executed.find((e) => e.sql.includes('UPDATE attendance_records'));
    assert.ok(update);
    assert.match(update!.sql, /reason=\?/, 'the correction must store the public reason, not only correction_reason');
    assert.match(update!.sql, /correction_reason=\?/);
    assert.equal(update!.params[0], 'excused');
    assert.equal(update!.params[1], 'medical note', 'reason is the correction reason');
    assert.equal(update!.params[2], 'instructor-a');
    assert.equal(update!.params[3], 'medical note', 'correction_reason is the same correction reason');
    const audit = auditAction(executed, 'attendance.correct');
    assert.ok(audit);
    const newValue = JSON.parse(audit!.params[7] as string) as { state: string; reason: string };
    assert.equal(newValue.state, 'excused');
    assert.equal(newValue.reason, 'medical note');
});

// ---------------------------------------------------------------------------
// 2026-10-20 T3c compatibility correction: the first T3 pass added a
// `truncated` key to the two pre-existing envelopes. The staff records list
// keeps exactly its pre-batch `{ session_id, records }` envelope and /me keeps
// exactly `{ student_id, records }`; the truncation metadata moves to the
// single X-Results-Truncated response header, which must be present as
// "true" or "false" on every response.
// ---------------------------------------------------------------------------

test('attendance: the staff records list keeps exactly its pre-batch envelope keys and exposes truncation only in the header', async () => {
    const { router, executed } = buildStaffRecordsRouter(staffRecordPool(2));
    const response = await invokeRoute(router, { method: 'GET', url: '/sessions/se-1/records', token: INSTRUCTOR_A });
    assert.equal(response.statusCode, 200);
    const body = response.body as Record<string, unknown>;
    assert.deepEqual(
        Object.keys(body).sort(),
        ['records', 'session_id'],
        'the pre-batch envelope had no truncated key',
    );
    assert.deepEqual(
        (body['records'] as { id: string }[]).map((row) => row.id),
        ['ar-1', 'ar-2'],
    );
    assert.equal(response.headers?.['x-results-truncated'], 'false', 'the header is always set, true or false');
    const list = executed.find((e) => e.sql.includes('FROM attendance_records'));
    assert.ok(list);
    assert.equal(limitOf(list!.sql), STAFF_RECORDS_CAP + 1, 'the cap+1 bounds fix is retained');
});

test('attendance: the /me history keeps exactly its pre-batch envelope keys and exposes truncation only in the header', async () => {
    const { router, executed } = buildStudentRecordsRouter(studentRecordPool(2));
    const response = await invokeRoute(router, { method: 'GET', url: '/me', token: STUDENT_A });
    assert.equal(response.statusCode, 200);
    const body = response.body as Record<string, unknown>;
    assert.deepEqual(
        Object.keys(body).sort(),
        ['records', 'student_id'],
        'the pre-batch envelope had no truncated key',
    );
    assert.deepEqual(
        (body['records'] as { id: string }[]).map((row) => row.id),
        ['ar-2', 'ar-1'],
        'the pre-batch /me ordering (starts_at DESC) is preserved',
    );
    assert.equal(response.headers?.['x-results-truncated'], 'false', 'the header is always set, true or false');
    const feed = executed.find((e) => e.sql.includes('FROM attendance_records a'));
    assert.ok(feed);
    assert.equal(limitOf(feed!.sql), STUDENT_RECORDS_CAP + 1, 'the cap+1 bounds fix is retained');
});
