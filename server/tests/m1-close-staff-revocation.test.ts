import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { AuthRequest, createAuthenticateToken } from '../src/middleware/auth';
import { PrincipalRepository } from '../src/security/principal-repository';
import { isStaffIdentityLive } from '../src/security/identity-scope';
import { createStaffRouter, StaffRouterDeps } from '../src/routes/staff';

const secret = 'isolated-staff-token-revocation-secret';
const previousSecret = process.env.JWT_SECRET;
before(() => { process.env.JWT_SECRET = secret; });
after(() => {
    if (previousSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previousSecret;
});

const response = () => {
    const output: { status?: number; body?: unknown } = {};
    const res = {
        status(code: number) { output.status = code; return res; },
        json(body: unknown) { output.body = body; return res; },
    } as Response;
    return { res, output };
};

const repository = (version: number | null | undefined, active = 1): PrincipalRepository => ({
    findUsersIdentity: async () => null,
    findStaffIdentity: async () => ({ is_active: active, token_version: version }),
    findInstructorAccount: async () => null,
    findStudentEnrollments: async () => [],
    findActiveTenantMemberships: async () => [],
});

const authenticate = async (claimedVersion: number | undefined, currentVersion: number | null | undefined, active = 1) => {
    const token = jwt.sign({ id: 'staff-1', role: 'staff', ...(claimedVersion === undefined ? {} : { tv: claimedVersion }) }, secret);
    const req = { headers: { authorization: `Bearer ${token}` }, method: 'GET', originalUrl: '/api/staff' } as AuthRequest;
    const { res, output } = response();
    let nextCalled = false;
    await createAuthenticateToken(repository(currentVersion, active))(req, res, (() => { nextCalled = true; }) as NextFunction);
    return { output, nextCalled };
};

interface RouterFixtures {
    staff: { id: string; phone: string; password_hash: string; is_active: number; token_version?: number | null };
    queries: string[];
    updates: Array<{ sql: string; params: unknown[] }>;
    missingVersion?: boolean;
    failure?: Error;
    failureOnExecute?: boolean;
}

const invokeStaff = async (fixtures: RouterFixtures, method: string, url: string, body: unknown = {}) => {
    const deps: StaffRouterDeps = {
        query: async () => [],
        queryOne: async <T>(sql: string): Promise<T | null> => {
            fixtures.queries.push(sql);
            if (fixtures.failure && !fixtures.failureOnExecute) throw fixtures.failure;
            if (sql.includes('FROM staff WHERE phone')) {
                if (fixtures.missingVersion && sql.includes('token_version')) {
                    throw Object.assign(new Error("Unknown column 'token_version' in 'field list'"), { code: 'ER_BAD_FIELD_ERROR' });
                }
                return fixtures.staff as T;
            }
            if (sql.includes('SELECT id, phone FROM staff')) return { id: fixtures.staff.id, phone: fixtures.staff.phone } as T;
            if (sql.includes('FROM staff WHERE id')) return fixtures.staff as T;
            return null;
        },
        execute: async (sql, params = []) => {
            fixtures.updates.push({ sql, params });
            if (fixtures.failure) throw fixtures.failure;
            if (fixtures.missingVersion && sql.includes('token_version')) {
                throw Object.assign(new Error("Unknown column 'token_version' in 'field list'"), { code: 'ER_BAD_FIELD_ERROR' });
            }
            return { insertId: 1, affectedRows: 1 };
        },
        comparePassword: async (password, hash) => bcrypt.compare(password, hash),
        authenticate: ((_req: Request, _res: Response, next: NextFunction) => next()) as RequestHandler,
        authorizeAdmin: ((_req: Request, _res: Response, next: NextFunction) => next()) as RequestHandler,
    };
    const router = createStaffRouter(deps);
    const output: { status?: number; body?: unknown } = {};
    const res = {
        setHeader() { return res; },
        status(code: number) { output.status = code; return res; },
        json(value: unknown) { output.body = value; return res; },
    } as unknown as Response;
    const dispatch = router as unknown as (req: unknown, res: Response, next: NextFunction) => void;
    dispatch({ method, url, originalUrl: url, ip: `127.0.0.${fixtures.queries.length + 1}`, headers: {}, body }, res, (() => undefined) as NextFunction);
    const deadline = Date.now() + 5000;
    while (output.status === undefined && output.body === undefined && Date.now() < deadline) {
        await new Promise((resolve) => setImmediate(resolve));
    }
    return output;
};

const fixtureRow = async (tokenVersion?: number | null): Promise<RouterFixtures> => ({
    staff: {
        id: 'staff-router-test', phone: '+201000000099',
        password_hash: await bcrypt.hash('fixture-password-1', 4), is_active: 1,
        ...(tokenVersion === undefined ? {} : { token_version: tokenVersion }),
    },
    queries: [], updates: [],
});

test('staff revocation compares the signed version with the live server row', async () => {
    assert.deepEqual(await authenticate(0, 0), { output: {}, nextCalled: true });
    const stale = await authenticate(0, 1);
    assert.equal(stale.output.status, 401);
    assert.equal(stale.nextCalled, false);
    const current = await authenticate(1, 1);
    assert.deepEqual(current, { output: {}, nextCalled: true });
});

test('legacy missing token versions default to zero, while inactive staff remain denied', async () => {
    assert.equal(isStaffIdentityLive({ is_active: 1 }, 0), true);
    assert.equal(isStaffIdentityLive({ is_active: 1, token_version: null }, undefined), true);
    const inactive = await authenticate(0, 0, 0);
    assert.equal(inactive.output.status, 401);
    assert.equal(inactive.nextCalled, false);
});

test('staff password update increments token_version in the same update statement', async () => {
    const fixtures = await fixtureRow(4);
    const result = await invokeStaff(fixtures, 'PUT', '/staff-router-test', { password: 'changed-password-1' });
    assert.equal(result.status, undefined);
    assert.equal(fixtures.updates.length, 1);
    assert.match(fixtures.updates[0].sql, /password_hash = \?, token_version = COALESCE\(token_version, 0\) \+ 1/);
    assert.deepEqual(fixtures.updates[0].params.slice(-1), ['staff-router-test']);
});

test('staff login issues the live database version in the signed tv claim', async () => {
    const fixtures = await fixtureRow(9);
    const result = await invokeStaff(fixtures, 'POST', '/login', { phone: fixtures.staff.phone, password: 'fixture-password-1' });
    assert.equal(result.status, undefined);
    const body = result.body as { token: string };
    assert.equal(jwt.verify(body.token, secret).tv, 9);
});

test('pre-migration password update and login remain compatible at version zero', async () => {
    const fixtures = await fixtureRow();
    fixtures.missingVersion = true;
    const changed = await invokeStaff(fixtures, 'PUT', '/staff-router-test', { password: 'changed-password-1' });
    assert.equal(changed.status, undefined);
    assert.equal(fixtures.updates.length, 2);
    assert.ok(fixtures.updates[0].sql.includes('token_version'));
    assert.ok(!fixtures.updates[1].sql.includes('token_version'));

    const loginFixtures = await fixtureRow();
    loginFixtures.missingVersion = true;
    const login = await invokeStaff(loginFixtures, 'POST', '/login', { phone: loginFixtures.staff.phone, password: 'fixture-password-1' });
    assert.equal(login.status, undefined);
    assert.equal(jwt.verify((login.body as { token: string }).token, secret).tv, 0);
    assert.equal(loginFixtures.queries.length, 2);
});

test('unrelated database failures are surfaced and never trigger legacy fallback', async () => {
    const loginFixtures = await fixtureRow(3);
    loginFixtures.failure = Object.assign(new Error('connection lost'), { code: 'ECONNRESET' });
    const login = await invokeStaff(loginFixtures, 'POST', '/login', { phone: loginFixtures.staff.phone, password: 'fixture-password-1' });
    assert.equal(login.status, 500);
    assert.equal(loginFixtures.queries.length, 1);

    const updateFixtures = await fixtureRow(3);
    updateFixtures.failure = Object.assign(new Error('connection lost'), { code: 'ECONNRESET' });
    updateFixtures.failureOnExecute = true;
    const update = await invokeStaff(updateFixtures, 'PUT', '/staff-router-test', { password: 'changed-password-1' });
    assert.equal(update.status, 500);
    assert.equal(updateFixtures.updates.length, 1);
});

