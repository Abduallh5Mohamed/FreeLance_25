import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import {
    MAX_JWT_LIFETIME_SECONDS,
    createLoginHandler,
} from '../src/routes/auth';
import { createStudentWorkspaceSelectHandler } from '../src/routes/student-enrollment';
import { createStaffRouter, StaffRouterDeps } from '../src/routes/staff';
import { AuthRequest, createAuthenticateToken } from '../src/middleware/auth';
import { PrincipalRepository } from '../src/security/principal-repository';

/**
 * F1/F2 closure evidence. Both bugs were independently reproduced against
 * HEAD af799c7f63b0aed7e3f90800f2cb2f2e8e0251ec before the fix:
 *  - F1: the staff branch of canonical /api/auth/login selected staff without
 *    token_version and signed a JWT without tv, so a staff password change
 *    (which bumps the server token_version) permanently locked that login
 *    path out while /api/staff/login kept working.
 *  - F2: student workspace selection signed the scoped token with the raw
 *    process.env.JWT_EXPIRES_IN || '7d' instead of the capped validated
 *    resolver, so a malformed or oversized environment value could mint an
 *    effectively non-expiring workspace session.
 * Every case below drives the real route handler code, not a reimplementation.
 */

const TEST_SECRET = 'isolated-auth-token-version-secret';
const FIXTURE_PASSWORD = 'fixture-password-1';
const previousSecret = process.env.JWT_SECRET;
const previousExpiry = process.env.JWT_EXPIRES_IN;
before(() => { process.env.JWT_SECRET = TEST_SECRET; delete process.env.JWT_EXPIRES_IN; });
after(() => {
    if (previousSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previousSecret;
    if (previousExpiry === undefined) delete process.env.JWT_EXPIRES_IN;
    else process.env.JWT_EXPIRES_IN = previousExpiry;
});

const fixtureHash = bcrypt.hashSync(FIXTURE_PASSWORD, 4);

const response = () => {
    const output: { status?: number; body?: unknown } = {};
    const res = {
        status(code: number) { output.status = code; return res; },
        json(body: unknown) { output.body = body; return res; },
        // The staff-login route carries the real rate-limit middleware, which
        // touches these response methods before the handler answers.
        setHeader() { return res; },
        removeHeader() { return res; },
        end() { return res; },
    } as unknown as Response;
    return { res, output };
};

// ---------------------------------------------------------------------------
// F1 — canonical /api/auth/login staff branch token_version
// ---------------------------------------------------------------------------

interface StaffLoginFixtures {
    staff: Record<string, unknown> | null;
    queries: string[];
    failure?: Error;
    missingColumn?: boolean;
}

const makeLoginDeps = (fixtures: StaffLoginFixtures): Parameters<typeof createLoginHandler>[0] => ({
    queryOne: async <T>(sql: string): Promise<T | null> => {
        fixtures.queries.push(sql);
        if (sql.includes('FROM users')) return null as T | null;
        if (fixtures.missingColumn && sql.includes('FROM staff') && sql.includes('token_version')) {
            throw Object.assign(new Error("Unknown column 'token_version' in 'field list'"), { code: 'ER_BAD_FIELD_ERROR' });
        }
        if (fixtures.failure && sql.includes('FROM staff')) throw fixtures.failure;
        if (sql.includes('FROM staff')) return fixtures.staff as T | null;
        return null as T | null;
    },
    comparePassword: async (password: string, hash: string) => bcrypt.compare(password, hash),
    loadAdminPermissions: async () => [],
    loadAdminRoleCodes: async () => [],
});

const runLogin = async (fixtures: StaffLoginFixtures, body: unknown) => {
    const handler = createLoginHandler(makeLoginDeps(fixtures));
    const { res, output } = response();
    await handler({ body } as Request, res);
    return output;
};

const staffRow = async (tokenVersion?: number | null) => ({
    id: 'staff-login-path', name: 'Staff Path', email: 'staff-path@example.test',
    phone: '+201000000077', role: 'staff', accessible_pages: ['dashboard'],
    is_active: 1, password_hash: fixtureHash,
    ...(tokenVersion === undefined ? {} : { token_version: tokenVersion }),
});

const staffRepository = (version: number | null | undefined, active = 1): PrincipalRepository => ({
    findUsersIdentity: async () => null,
    findStaffIdentity: async () => ({ is_active: active, token_version: version }),
    findInstructorAccount: async () => null,
    findStudentEnrollments: async () => [],
    findActiveTenantMemberships: async () => [],
});

const runStaffRouterLogin = async (tokenVersion?: number | null) => {
    const queries: string[] = [];
    const deps: StaffRouterDeps = {
        query: async () => [],
        queryOne: async <T>(sql: string): Promise<T | null> => {
            queries.push(sql);
            if (sql.includes('FROM staff WHERE phone')) {
                return {
                    id: 'staff-login-path', name: 'Staff Path', phone: '+201000000077', role: 'staff',
                    accessible_pages: ['dashboard'], is_active: 1, password_hash: fixtureHash,
                    ...(tokenVersion === undefined ? {} : { token_version: tokenVersion }),
                } as T;
            }
            return null as T | null;
        },
        execute: async () => ({ insertId: 0, affectedRows: 0 }),
        comparePassword: async (password: string, hash: string) => bcrypt.compare(password, hash),
        authenticate: ((_req: Request, _res: Response, next: NextFunction) => next()) as RequestHandler,
        authorizeAdmin: ((_req: Request, _res: Response, next: NextFunction) => next()) as RequestHandler,
    };
    const router = createStaffRouter(deps);
    const { res, output } = response();
    const dispatch = router as unknown as (req: unknown, res: Response, next: NextFunction) => void;
    dispatch({ method: 'POST', url: '/login', originalUrl: '/login', ip: '127.0.0.9', headers: {}, body: { phone: '+201000000077', password: FIXTURE_PASSWORD } }, res, (() => undefined) as NextFunction);
    const deadline = Date.now() + 5000;
    while (output.status === undefined && output.body === undefined && Date.now() < deadline) {
        await new Promise((resolve) => setImmediate(resolve));
    }
    return output;
};

test('F1: canonical login mints the live staff token_version at version 0', async () => {
    const fixtures = { staff: await staffRow(0), queries: [] };
    const output = await runLogin(fixtures, { phone: '+201000000077', password: FIXTURE_PASSWORD });
    assert.equal(output.status, undefined);
    const decoded = jwt.verify((output.body as { token: string }).token, TEST_SECRET) as { tv: number };
    assert.equal(decoded.tv, 0);
    assert.ok(fixtures.queries.some(sql => sql.includes('FROM staff') && sql.includes('token_version')));
});

test('F1: canonical login mints the live staff token_version above 0', async () => {
    const fixtures = { staff: await staffRow(7), queries: [] };
    const output = await runLogin(fixtures, { phone: '+201000000077', password: FIXTURE_PASSWORD });
    assert.equal(output.status, undefined);
    const decoded = jwt.verify((output.body as { token: string }).token, TEST_SECRET) as { tv: number };
    assert.equal(decoded.tv, 7);
});

test('F1: both staff login paths mint the identical token version for the same row', async () => {
    const canonical = await runLogin({ staff: await staffRow(4), queries: [] }, { phone: '+201000000077', password: FIXTURE_PASSWORD });
    const staffPath = await runStaffRouterLogin(4);
    assert.equal(canonical.status, undefined);
    assert.equal(staffPath.status, undefined);
    const canonicalTv = (jwt.verify((canonical.body as { token: string }).token, TEST_SECRET) as { tv: number }).tv;
    const staffTv = (jwt.verify((staffPath.body as { token: string }).token, TEST_SECRET) as { tv: number }).tv;
    assert.equal(canonicalTv, 4);
    assert.equal(staffTv, canonicalTv);
});

test('F1: a token minted at version N is accepted until the row moves on, then denied', async () => {
    const minted = await runLogin({ staff: await staffRow(2), queries: [] }, { phone: '+201000000077', password: FIXTURE_PASSWORD });
    assert.equal(minted.status, undefined);
    const token = (minted.body as { token: string }).token;

    const authenticateAt = async (serverVersion: number) => {
        const req = { headers: { authorization: `Bearer ${token}` }, method: 'GET', originalUrl: '/api/courses' } as AuthRequest;
        const { res, output } = response();
        let nextCalled = false;
        await createAuthenticateToken(staffRepository(serverVersion))(req, res, (() => { nextCalled = true; }) as NextFunction);
        return { output, nextCalled };
    };

    const live = await authenticateAt(2);
    assert.equal(live.nextCalled, true);
    assert.equal(live.output.status, undefined);

    const bumped = await authenticateAt(3);
    assert.equal(bumped.nextCalled, false);
    assert.equal(bumped.output.status, 401);
    assert.deepEqual(bumped.output.body, { error: 'Session revoked', code: 'SESSION_REVOKED' });
});

test('F1: pre-migration missing token_version column falls back to version 0 without weakening other failures', async () => {
    const fixtures: StaffLoginFixtures = { staff: await staffRow(), queries: [], missingColumn: true };
    const output = await runLogin(fixtures, { phone: '+201000000077', password: FIXTURE_PASSWORD });
    assert.equal(output.status, undefined);
    const decoded = jwt.verify((output.body as { token: string }).token, TEST_SECRET) as { tv: number };
    assert.equal(decoded.tv, 0);
    // users lookup, staff lookup with token_version (rejected), legacy fallback.
    assert.equal(fixtures.queries.filter(sql => sql.includes('FROM staff')).length, 2);
    assert.ok(fixtures.queries.some(sql => sql.includes('FROM staff') && !sql.includes('token_version')));
});

test('F1: an unrelated database failure on the staff lookup fails closed with 500 and no token', async () => {
    const fixtures: StaffLoginFixtures = {
        staff: await staffRow(3), queries: [],
        failure: Object.assign(new Error('connection lost'), { code: 'ECONNRESET' }),
    };
    const output = await runLogin(fixtures, { phone: '+201000000077', password: FIXTURE_PASSWORD });
    assert.equal(output.status, 500);
    assert.equal((output.body as { token?: string }).token, undefined);
    assert.equal(fixtures.queries.filter(sql => sql.includes('FROM staff')).length, 1);
});

test('F1: suspension and inactive gates still precede staff token issuance', async () => {
    const suspended = await runLogin({ staff: await staffRow(1), queries: [] }, { phone: '+201000000077', password: FIXTURE_PASSWORD });
    assert.equal(suspended.status, undefined);

    const inactive = await runLogin({ staff: { ...(await staffRow(1)), is_active: 0 }, queries: [] }, { phone: '+201000000077', password: FIXTURE_PASSWORD });
    assert.equal(inactive.status, 403);
    assert.deepEqual(inactive.body, { error: 'Account is suspended', code: 'ACCOUNT_SUSPENDED' });

    const wrongPassword = await runLogin({ staff: await staffRow(1), queries: [] }, { phone: '+201000000077', password: 'wrong-password' });
    assert.equal(wrongPassword.status, 401);
    assert.deepEqual(wrongPassword.body, { error: 'Invalid credentials' });
});

// ---------------------------------------------------------------------------
// F2 — student workspace-select capped validated JWT lifetime
// ---------------------------------------------------------------------------

interface EnrollmentRow {
    id: string; tenant_id: string; instructor_id: string; group_id: string | null; grade_id: string | null;
}

const enrollmentRow: EnrollmentRow = {
    id: 'enrollment-1', tenant_id: 'tenant-1', instructor_id: 'instructor-1',
    group_id: 'group-1', grade_id: 'grade-1',
};

const studentUser = {
    id: 'student-1', role: 'student', email: 'student-1@example.test',
    phone: '+201000000088', tokenVersion: 5,
};

const runSelect = async (options: {
    enrollment?: EnrollmentRow | null;
    user?: Record<string, unknown>;
    failure?: Error;
} = {}) => {
    const handler = createStudentWorkspaceSelectHandler({
        queryOne: async <T>(_sql: string): Promise<T | null> => {
            if (options.failure) throw options.failure;
            return (options.enrollment === undefined ? enrollmentRow : options.enrollment) as T | null;
        },
    });
    const { res, output } = response();
    await handler(
        { params: { enrollmentId: 'enrollment-1' }, user: options.user ?? studentUser } as unknown as AuthRequest,
        res,
    );
    return output;
};

const decodedToken = (body: unknown) => jwt.verify((body as { token: string }).token, TEST_SECRET) as {
    tv: number; role: string; tenant_id: string; student_enrollment_id: string;
    instructor_id: string; group_id: string; grade_id: string; type: string; exp: number; iat: number;
};

test('F2: unset JWT_EXPIRES_IN uses the shared 7-day cap on the workspace token', async () => {
    delete process.env.JWT_EXPIRES_IN;
    const output = await runSelect();
    assert.equal(output.status, undefined);
    const decoded = decodedToken(output.body);
    assert.equal(decoded.exp - decoded.iat, MAX_JWT_LIFETIME_SECONDS);
});

test('F2: malformed JWT_EXPIRES_IN values fall back to the 7-day cap', async () => {
    for (const raw of ['not-a-duration', '7x', '1.5h', '-30', '  ', '10m30s']) {
        process.env.JWT_EXPIRES_IN = raw;
        const output = await runSelect();
        assert.equal(output.status, undefined, `value ${JSON.stringify(raw)} must not fail issuance`);
        const decoded = decodedToken(output.body);
        assert.equal(decoded.exp - decoded.iat, MAX_JWT_LIFETIME_SECONDS, `value ${JSON.stringify(raw)} must fall back`);
    }
});

test('F2: oversized JWT_EXPIRES_IN values are capped at 7 days', async () => {
    for (const raw of ['30d', '60d', '365d', '999999999s', '99999h']) {
        process.env.JWT_EXPIRES_IN = raw;
        const output = await runSelect();
        assert.equal(output.status, undefined);
        const decoded = decodedToken(output.body);
        assert.equal(decoded.exp - decoded.iat, MAX_JWT_LIFETIME_SECONDS, `value ${JSON.stringify(raw)} must be capped`);
    }
});

test('F2: short valid JWT_EXPIRES_IN values are honored exactly', async () => {
    for (const [raw, expected] of [['60s', 60], ['15m', 900], ['2h', 7200], ['1d', 86400]] as const) {
        process.env.JWT_EXPIRES_IN = raw;
        const output = await runSelect();
        assert.equal(output.status, undefined);
        const decoded = decodedToken(output.body);
        assert.equal(decoded.exp - decoded.iat, expected, `value ${raw} must resolve to ${expected}`);
    }
    process.env.JWT_EXPIRES_IN = '30d';
    const capped = decodedToken((await runSelect()).body);
    assert.equal(capped.exp - capped.iat, MAX_JWT_LIFETIME_SECONDS);
});

test('F2: selection preserves the live enrollment, tenant and token version claims', async () => {
    process.env.JWT_EXPIRES_IN = '30m';
    const output = await runSelect();
    assert.equal(output.status, undefined);
    const body = output.body as { token: string; tenant_id: string; student_enrollment_id: string };
    assert.equal(body.tenant_id, 'tenant-1');
    assert.equal(body.student_enrollment_id, 'enrollment-1');
    const decoded = decodedToken(body);
    assert.equal(decoded.role, 'student');
    assert.equal(decoded.tenant_id, 'tenant-1');
    assert.equal(decoded.student_enrollment_id, 'enrollment-1');
    assert.equal(decoded.instructor_id, 'instructor-1');
    assert.equal(decoded.group_id, 'group-1');
    assert.equal(decoded.grade_id, 'grade-1');
    assert.equal(decoded.tv, 5);
    assert.equal(decoded.type, 'student_scoped');
});

test('F2: the minted workspace token is revoked by a server token-version bump', async () => {
    process.env.JWT_EXPIRES_IN = '1h';
    const output = await runSelect();
    assert.equal(output.status, undefined);
    const token = (output.body as { token: string }).token;

    const authenticateAt = async (serverVersion: number) => {
        const repository: PrincipalRepository = {
            findUsersIdentity: async () => ({ is_active: 1, token_version: serverVersion, role: 'student', suspension_active: 0 }),
            findStaffIdentity: async () => null,
            findInstructorAccount: async () => null,
            findStudentEnrollments: async () => [{
                id: 'enrollment-1', user_id: 'student-1', tenant_id: 'tenant-1',
                instructor_id: 'instructor-1', group_id: 'group-1', grade_id: 'grade-1',
            }],
            findActiveTenantMemberships: async () => [],
        };
        const req = { headers: { authorization: `Bearer ${token}` }, method: 'GET', originalUrl: '/api/courses' } as AuthRequest;
        const { res, output } = response();
        let nextCalled = false;
        await createAuthenticateToken(repository)(req, res, (() => { nextCalled = true; }) as NextFunction);
        return { output, nextCalled };
    };

    const live = await authenticateAt(5);
    assert.equal(live.nextCalled, true);
    const bumped = await authenticateAt(6);
    assert.equal(bumped.nextCalled, false);
    assert.equal(bumped.output.status, 401);
});

test('F2: workspace selection denies non-students, unknown enrollments and lookup failures', async () => {
    const nonStudent = await runSelect({ user: { id: 'instructor-9', role: 'instructor', tokenVersion: 0 } });
    assert.equal(nonStudent.status, 403);

    const missing = await runSelect({ enrollment: null });
    assert.equal(missing.status, 404);
    assert.equal((missing.body as { token?: string }).token, undefined);

    let rejected = false;
    try {
        await runSelect({ failure: Object.assign(new Error('connection lost'), { code: 'ECONNRESET' }) });
    } catch { rejected = true; }
    assert.equal(rejected, true, 'a database failure must not mint a workspace token');
});
