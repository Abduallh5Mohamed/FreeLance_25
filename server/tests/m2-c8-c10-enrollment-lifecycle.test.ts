import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';
import { Router } from 'express';
import { createAuthenticateToken } from '../src/middleware/auth';
import {
    createEnrollmentLifecycleHandler,
    createStudentWorkspaceSelectHandler,
    validateEnrollmentLifecycleInput,
} from '../src/routes/student-enrollment';
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

// ---------------------------------------------------------------------------
// Pure unit: validateEnrollmentLifecycleInput (server is the only authority)
// ---------------------------------------------------------------------------

test('validate: rejects term longer than 60 characters', () => {
    const r = validateEnrollmentLifecycleInput({ term: 'x'.repeat(61) });
    assert.equal(r.ok, false);
});

test('validate: rejects an unknown enrollment_status', () => {
    const r = validateEnrollmentLifecycleInput({ enrollment_status: 'pending' });
    assert.equal(r.ok, false);
});

test('validate: rejects a non-ISO date', () => {
    const r = validateEnrollmentLifecycleInput({ enrollment_start_date: 'next tuesday' });
    assert.equal(r.ok, false);
});

test('validate: rejects start after end', () => {
    const r = validateEnrollmentLifecycleInput({ enrollment_start_date: '2026-06-01', enrollment_end_date: '2026-05-01' });
    assert.equal(r.ok, false);
});

test('validate: rejects a zero-length half-open enrollment window', () => {
    const r = validateEnrollmentLifecycleInput({ enrollment_start_date: '2026-06-01', enrollment_end_date: '2026-06-01' });
    assert.equal(r.ok, false);
});

test('validate: ignores all payment fields and never grants access', () => {
    const r = validateEnrollmentLifecycleInput({
        amount: 999, price: 50, paymentstatus: 'paid', payment_status: 'cleared',
        enrollment_status: 'active',
    });
    assert.equal(r.ok, true);
    if (r.ok) {
        assert.equal(r.value.status, 'active');
        assert.equal('amount' in (r.value as object), false);
        assert.equal('price' in (r.value as object), false);
        assert.equal('paymentstatus' in (r.value as object), false);
    }
});

test('validate: accepts a clean term + dates + status', () => {
    const r = validateEnrollmentLifecycleInput({
        term: 'Term 2', enrollment_start_date: '2026-01-01', enrollment_end_date: '2026-06-30', enrollment_status: 'active',
    });
    assert.equal(r.ok, true);
    if (r.ok) {
        assert.equal(r.value.term, 'Term 2');
        assert.equal(r.value.status, 'active');
        assert.equal(r.value.startDate, '2026-01-01');
        assert.equal(r.value.endDate, '2026-06-30');
    }
});

// ---------------------------------------------------------------------------
// Handler: PUT /:id/lifecycle (C8/C10)
// ---------------------------------------------------------------------------

const INSTRUCTOR_A = tokenFor({ id: 'instructor-a', role: 'instructor', tv: 0, tenant_id: 'tenant-a' });
const STUDENT_A = tokenFor({ id: 'student-a', role: 'student', tv: 0 });
const INSTRUCTOR_NO_TENANT = tokenFor({ id: 'instructor-a', role: 'instructor', tv: 0 });

interface LifecycleHarness {
    router: Router;
    executed: ExecutedStatement[];
    counter: { calls: number };
}

const buildLifecycleHarness = (opts: {
    studentRow: Record<string, unknown> | null;
    resolveTenant: (i: string, t: string) => { id: string; business_name: string; owner_user_id: string } | null;
    hasMembership?: boolean;
}): LifecycleHarness => {
    const counter = { calls: 0 };
    const db = makeFakeDataAccess((sql) => {
        if (sql.includes('FROM students WHERE id=? AND tenant_id=? AND instructor_id=?')) {
            return opts.studentRow ? [opts.studentRow] : [];
        }
        return [];
    });
    const users = {
        'instructor-a': { is_active: 1, token_version: 0, suspension_active: 0, role: 'instructor' },
        'student-a': { is_active: 1, token_version: 0, suspension_active: 0, role: 'student' },
    };
    const repository = makeRepository(users, {
        instructorAccounts: { 'instructor-a': { tenant_status: 'active', legacy_compat: 1, allowed: 1 } },
        memberships: { 'instructor-a': opts.hasMembership === false ? [] : [{ tenant_id: 'tenant-a' }] },
    });
    const transaction = async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => {
        counter.calls += 1;
        return fn({ queryOne: db.queryOne, execute: db.execute });
    };
    const router = Router();
    router.use(createAuthenticateToken(repository));
    router.put('/:id/lifecycle', createEnrollmentLifecycleHandler({
        queryOne: db.queryOne,
        execute: db.execute,
        resolveTenant: opts.resolveTenant,
        transaction: transaction as never,
    }));
    return { router, executed: db.executed, counter };
};

const isLifecycleUpdate = (sql: string) => sql.includes('UPDATE students') && sql.includes('SET term=COALESCE');
const auditAction = (executed: ExecutedStatement[], action: string): ExecutedStatement | undefined =>
    executed.find((e) => e.sql.includes('INSERT INTO audit_events') && (e.params[3] as string) === action);

test('lifecycle: anonymous is 401', async () => {
    const { router } = buildLifecycleHarness({ studentRow: null, resolveTenant: () => null });
    const response = await invokeRoute(router, { method: 'PUT', url: '/enr-1/lifecycle', body: { enrollment_status: 'active' } });
    assert.equal(response.statusCode, 401);
});

test('lifecycle: a student token is denied 403 (instructor-only)', async () => {
    const { router } = buildLifecycleHarness({ studentRow: null, resolveTenant: () => null });
    const response = await invokeRoute(router, { method: 'PUT', url: '/enr-1/lifecycle', token: STUDENT_A, body: { enrollment_status: 'active' } });
    assert.equal(response.statusCode, 403);
});

test('lifecycle: instructor without a resolved tenant is 403', async () => {
    const { router } = buildLifecycleHarness({ studentRow: null, resolveTenant: () => null, hasMembership: false });
    const response = await invokeRoute(router, { method: 'PUT', url: '/enr-1/lifecycle', token: INSTRUCTOR_NO_TENANT, body: { enrollment_status: 'active' } });
    assert.equal(response.statusCode, 403);
});

test('lifecycle: no active instructor workspace -> 409 (server-resolved tenant)', async () => {
    const { router } = buildLifecycleHarness({ studentRow: null, resolveTenant: () => null });
    const response = await invokeRoute(router, { method: 'PUT', url: '/enr-1/lifecycle', token: INSTRUCTOR_A, body: { enrollment_status: 'active' } });
    assert.equal(response.statusCode, 409);
    assert.equal((response.body as { error?: string }).error, 'Active instructor workspace required');
});

test('lifecycle: invalid input -> 400', async () => {
    const { router } = buildLifecycleHarness({
        studentRow: { id: 'enr-1', tenant_id: 'tenant-a', instructor_id: 'instructor-a', approval_status: 'approved', enrollment_status: 'active', term: null, enrollment_start_date: null, enrollment_end_date: null },
        resolveTenant: () => ({ id: 'tenant-a', business_name: 'A', owner_user_id: 'instructor-a' }),
    });
    const response = await invokeRoute(router, { method: 'PUT', url: '/enr-1/lifecycle', token: INSTRUCTOR_A, body: { enrollment_status: 'bogus' } });
    assert.equal(response.statusCode, 400);
});

test('lifecycle: unknown enrollment id -> 404 with no write', async () => {
    const { router, executed } = buildLifecycleHarness({
        studentRow: null,
        resolveTenant: () => ({ id: 'tenant-a', business_name: 'A', owner_user_id: 'instructor-a' }),
    });
    const response = await invokeRoute(router, { method: 'PUT', url: '/enr-missing/lifecycle', token: INSTRUCTOR_A, body: { enrollment_status: 'active' } });
    assert.equal(response.statusCode, 404);
    assert.equal(executed.some((e) => isLifecycleUpdate(e.sql)), false);
});

test('lifecycle: updates term/dates/status atomically, audits, and uses the transaction seam', async () => {
    const { router, executed, counter } = buildLifecycleHarness({
        studentRow: { id: 'enr-1', tenant_id: 'tenant-a', instructor_id: 'instructor-a', approval_status: 'approved', enrollment_status: 'active', term: null, enrollment_start_date: null, enrollment_end_date: null },
        resolveTenant: () => ({ id: 'tenant-a', business_name: 'A', owner_user_id: 'instructor-a' }),
    });
    const response = await invokeRoute(router, {
        method: 'PUT', url: '/enr-1/lifecycle', token: INSTRUCTOR_A,
        body: { term: 'Term 2', enrollment_start_date: '2026-01-01', enrollment_end_date: '2026-06-30', enrollment_status: 'active' },
    });
    assert.equal(response.statusCode, 200);
    assert.equal((response.body as { status?: string }).status, 'ok');
    assert.equal(counter.calls, 1, 'transaction seam used');
    const update = executed.find((e) => isLifecycleUpdate(e.sql));
    assert.ok(update, 'students UPDATE executed');
    assert.deepEqual(update!.params, ['Term 2', '2026-01-01', '2026-06-30', 'active', 'enr-1', 'tenant-a', 'instructor-a']);
    assert.ok(auditAction(executed, 'enrollment.lifecycle'), 'enrollment.lifecycle audit recorded');
});

test('lifecycle: payment fields are ignored — no money value reaches the row or audit', async () => {
    const { router, executed } = buildLifecycleHarness({
        studentRow: { id: 'enr-1', tenant_id: 'tenant-a', instructor_id: 'instructor-a', approval_status: 'approved', enrollment_status: 'active', term: null, enrollment_start_date: null, enrollment_end_date: null },
        resolveTenant: () => ({ id: 'tenant-a', business_name: 'A', owner_user_id: 'instructor-a' }),
    });
    const response = await invokeRoute(router, {
        method: 'PUT', url: '/enr-1/lifecycle', token: INSTRUCTOR_A,
        body: { amount: 999, price: 50, paymentstatus: 'paid', enrollment_status: 'active' },
    });
    assert.equal(response.statusCode, 200);
    const update = executed.find((e) => isLifecycleUpdate(e.sql));
    assert.ok(update);
    // The UPDATE only touches term/dates/status columns — never amount/price.
    assert.ok(!/amount|price|payment/i.test(update!.sql), 'no monetary column in UPDATE');
    // The audit newValue captures only the lifecycle-relevant fields.
    const audit = auditAction(executed, 'enrollment.lifecycle');
    assert.ok(audit);
    const newValue = JSON.parse(audit!.params[7] as string) as Record<string, unknown>;
    assert.equal('amount' in newValue, false);
    assert.equal('price' in newValue, false);
    assert.equal('paymentstatus' in newValue, false);
    assert.equal(newValue.enrollment_status, 'active');
});

test('lifecycle: revoke is recorded server-side (C10 downstream deny is enforced at read layer)', async () => {
    const { router, executed } = buildLifecycleHarness({
        studentRow: { id: 'enr-1', tenant_id: 'tenant-a', instructor_id: 'instructor-a', approval_status: 'approved', enrollment_status: 'active', term: null, enrollment_start_date: null, enrollment_end_date: null },
        resolveTenant: () => ({ id: 'tenant-a', business_name: 'A', owner_user_id: 'instructor-a' }),
    });
    const response = await invokeRoute(router, {
        method: 'PUT', url: '/enr-1/lifecycle', token: INSTRUCTOR_A,
        body: { enrollment_status: 'revoked' },
    });
    assert.equal(response.statusCode, 200);
    assert.equal((response.body as { enrollment_status?: string }).enrollment_status, 'revoked');
    const update = executed.find((e) => isLifecycleUpdate(e.sql));
    assert.ok(update);
    assert.equal(update!.params[3], 'revoked');
    assert.ok(auditAction(executed, 'enrollment.lifecycle'), 'revoke audit recorded');
});

test('workspace selection requires active enrollment and enforces [start,end) using UTC database time', async () => {
    const now = '2026-06-01 12:00:00';
    const eligibleRow = {
        id: 'enr-1', tenant_id: 'tenant-a', instructor_id: 'instructor-a', group_id: null, grade_id: null,
        enrollment_status: 'active', enrollment_start_date: now, enrollment_end_date: '2026-06-01 12:00:01',
    };
    const makeWorkspaceRouter = (row: Record<string, unknown> | null) => {
        const db = makeFakeDataAccess((sql) => {
            assert.match(sql, /s\.enrollment_status IS NULL OR s\.enrollment_status='active'/);
            assert.match(sql, /s\.enrollment_start_date<=UTC_TIMESTAMP\(\)/);
            assert.match(sql, /s\.enrollment_end_date>UTC_TIMESTAMP\(\)/);
            // MySQL applies the predicates in the SELECT. This hermetic adapter
            // simulates its boundary decisions against the same fixed UTC instant.
            if (!row) return [];
            const start = row.enrollment_start_date as string | null;
            const end = row.enrollment_end_date as string | null;
            const status = row.enrollment_status as string | null;
            return (status === null || status === 'active') && (!start || start <= now) && (!end || end > now) ? [row] : [];
        });
        const repository = makeRepository({ 'student-a': { is_active: 1, token_version: 0, suspension_active: 0, role: 'student' } });
        const router = Router();
        router.use(createAuthenticateToken(repository));
        router.post('/:enrollmentId/select', createStudentWorkspaceSelectHandler({ queryOne: db.queryOne }));
        return { router, db };
    };

    const eligible = makeWorkspaceRouter(eligibleRow);
    const response = await invokeRoute(eligible.router, { method: 'POST', url: '/enr-1/select', token: STUDENT_A });
    assert.equal(response.statusCode, 200, 'start boundary is inclusive');
    assert.equal((response.body as { student_enrollment_id?: string }).student_enrollment_id, 'enr-1');

    for (const row of [
        { ...eligibleRow, enrollment_status: 'revoked' },
        { ...eligibleRow, enrollment_status: 'expired' },
        { ...eligibleRow, enrollment_start_date: '2026-06-01 12:00:01' },
        { ...eligibleRow, enrollment_end_date: now },
    ]) {
        const ineligible = makeWorkspaceRouter(row);
        const denied = await invokeRoute(ineligible.router, { method: 'POST', url: '/enr-1/select', token: STUDENT_A });
        assert.equal(denied.statusCode, 404, 'revoked/expired/not-yet-started/end-boundary enrollment is hidden');
    }
});

test('lifecycle: audit failure fails the lifecycle request instead of committing an unaudited mutation', async () => {
    const db = makeFakeDataAccess((sql) => sql.includes('FROM students WHERE id=? AND tenant_id=? AND instructor_id=?')
        ? [{ id: 'enr-1', tenant_id: 'tenant-a', instructor_id: 'instructor-a', approval_status: 'approved', enrollment_status: 'active', term: null, enrollment_start_date: null, enrollment_end_date: null }]
        : []);
    const counter = { calls: 0, rollbacks: 0 };
    const execute = async (sql: string, params?: unknown[]) => {
        if (sql.includes('INSERT INTO audit_events')) throw new Error('audit storage unavailable');
        return db.execute(sql, params);
    };
    const repository = makeRepository({ 'instructor-a': { is_active: 1, token_version: 0, suspension_active: 0, role: 'instructor' } }, {
        instructorAccounts: { 'instructor-a': { tenant_status: 'active', legacy_compat: 1, allowed: 1 } },
        memberships: { 'instructor-a': [{ tenant_id: 'tenant-a' }] },
    });
    const router = Router();
    router.use(createAuthenticateToken(repository));
    router.put('/:id/lifecycle', createEnrollmentLifecycleHandler({
        queryOne: db.queryOne,
        execute,
        resolveTenant: () => ({ id: 'tenant-a', business_name: 'A', owner_user_id: 'instructor-a' }),
        transaction: (async <T>(fn: (tx: unknown) => Promise<T>) => {
            counter.calls += 1;
            try { return await fn({ queryOne: db.queryOne, execute }); }
            catch (error) { counter.rollbacks += 1; throw error; }
        }) as never,
    }));
    const response = await invokeRoute(router, {
        method: 'PUT', url: '/enr-1/lifecycle', token: INSTRUCTOR_A, body: { enrollment_status: 'revoked' },
    });
    assert.equal(response.statusCode, 500);
    assert.equal(counter.calls, 1);
    assert.equal(counter.rollbacks, 1);
});
