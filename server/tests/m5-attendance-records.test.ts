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
