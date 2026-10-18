import assert from 'node:assert/strict';
import test from 'node:test';
import { quietConsole, restoreConsole } from './helpers/quiet-console';

test.beforeEach(quietConsole);
test.afterEach(restoreConsole);
import jwt from 'jsonwebtoken';
import type { NextFunction, Response } from 'express';
import { AuthRequest, createAuthenticateToken, createOptionalAuth } from '../src/middleware/auth';
import type { PrincipalRepository, UsersIdentityRow } from '../src/security/principal-repository';
import { isUsersIdentityLive } from '../src/security/identity-scope';
import {
    createDeleteStudentEnrollmentHandler,
    createSearchByPhoneHandler,
    resolveJwtLifetimeSeconds,
    MAX_JWT_LIFETIME_SECONDS,
} from '../src/routes/auth';

const TEST_SECRET = 'test-only-secret-with-sufficient-length';
const originalSecret = process.env.JWT_SECRET;
process.env.JWT_SECRET = TEST_SECRET;

test.after(() => {
    if (originalSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = originalSecret;
});

type CapturedResponse = Response & { statusCode?: number; body?: unknown };

const createResponse = (): CapturedResponse => {
    const response = {
        status(code: number) {
            response.statusCode = code;
            return response;
        },
        json(body: unknown) {
            if (response.statusCode === undefined) response.statusCode = 200;
            response.body = body;
            return response;
        },
    } as CapturedResponse;
    return response;
};

const makeRepository = (identity: UsersIdentityRow | null): PrincipalRepository => ({
    findUsersIdentity: async () => identity,
    findStaffIdentity: async () => null,
    findInstructorAccount: async () => null,
    findStudentEnrollments: async () => [],
    findActiveTenantMemberships: async () => [],
});

const invokeAuth = async (roleClaim: string, identity: UsersIdentityRow | null, optional = false) => {
    const token = jwt.sign({ id: 'user-a', role: roleClaim, tv: 0 }, TEST_SECRET);
    const request = { headers: { authorization: `Bearer ${token}` }, method: 'GET', originalUrl: '/api/example' } as AuthRequest;
    const response = createResponse();
    let nextCalled = false;
    const middleware = optional
        ? createOptionalAuth(makeRepository(identity))
        : createAuthenticateToken(makeRepository(identity));
    await middleware(request, response, (() => { nextCalled = true; }) as NextFunction);
    return { request, response, nextCalled };
};

test('users identity liveness rejects a stale JWT role as well as inactive or stale-version identities', () => {
    assert.equal(isUsersIdentityLive({ is_active: 1, token_version: 0, role: 'teacher' }, 0, 'teacher'), true);
    assert.equal(isUsersIdentityLive({ is_active: 1, token_version: 0, role: 'student' }, 0, 'teacher'), false);
    assert.equal(isUsersIdentityLive({ is_active: 0, token_version: 0, role: 'teacher' }, 0, 'teacher'), false);
    assert.equal(isUsersIdentityLive({ is_active: 1, token_version: 2, role: 'teacher' }, 0, 'teacher'), false);
});

test('authenticateToken projects the live database role into the principal', async () => {
    const { request, response, nextCalled } = await invokeAuth('teacher', {
        is_active: 1, token_version: 0, suspension_active: 0, role: 'teacher',
    });
    assert.equal(nextCalled, true);
    assert.equal(response.statusCode, undefined);
    assert.equal(request.user?.role, 'teacher');
});

test('authenticateToken and optionalAuth revoke a demoted role claim', async () => {
    for (const optional of [false, true]) {
        const { request, response, nextCalled } = await invokeAuth('admin', {
            is_active: 1, token_version: 0, suspension_active: 0, role: 'teacher',
        }, optional);
        assert.equal(nextCalled, false);
        assert.equal(response.statusCode, 401);
        assert.deepEqual(response.body, { error: 'Session revoked', code: 'SESSION_REVOKED' });
        assert.equal(request.user, undefined);
    }
});

test('student enrollment deletion preserves the global user and scopes the enrollment to tenant', async () => {
    const statements: Array<{ sql: string; params: unknown[] }> = [];
    const handler = createDeleteStudentEnrollmentHandler({
        queryOne: async <T>(sql: string, params: unknown[] = []) => {
            statements.push({ sql, params });
            assert.match(sql, /WHERE id = \? AND tenant_id = \?/);
            assert.deepEqual(params, ['enrollment-a', 'tenant-a']);
            return { id: 'enrollment-a', tenant_id: 'tenant-a' } as T;
        },
        execute: async (sql, params = []) => {
            statements.push({ sql, params });
            return { affectedRows: 1 };
        },
        isPlatformAdmin: async () => false,
    });
    const response = createResponse();
    await handler({
        params: { studentId: 'enrollment-a' },
        user: { id: 'teacher-a', role: 'teacher', tenantId: 'tenant-a', email: null, phone: null },
    } as AuthRequest, response);

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.body, {
        message: 'Student enrollment deleted; global user account preserved',
        userDeleted: false,
        studentDeleted: true,
        enrollmentDeleted: true,
    });
    assert.equal(statements.length, 3);
    assert.match(statements[1].sql, /DELETE FROM student_courses/);
    assert.match(statements[2].sql, /DELETE FROM students WHERE id = \? AND tenant_id = \?/);
    assert.equal(statements.some(({ sql }) => /DELETE\s+FROM\s+users/i.test(sql)), false);
});

test('student enrollment deletion denies cross-tenant IDs and tenant admins without verified scope', async () => {
    let executeCalls = 0;
    const crossTenant = createDeleteStudentEnrollmentHandler({
        queryOne: async <T>() => null as T | null,
        execute: async () => { executeCalls += 1; return { affectedRows: 1 }; },
        isPlatformAdmin: async () => false,
    });
    const response = createResponse();
    await crossTenant({
        params: { studentId: 'enrollment-b' },
        user: { id: 'teacher-a', role: 'teacher', tenantId: 'tenant-a', email: null, phone: null },
    } as AuthRequest, response);
    assert.equal(response.statusCode, 404);
    assert.equal(executeCalls, 0);

    const unscopedAdmin = createDeleteStudentEnrollmentHandler({
        queryOne: async <T>() => { throw new Error('must not query'); },
        execute: async () => { executeCalls += 1; return { affectedRows: 1 }; },
        isPlatformAdmin: async () => false,
    });
    const denied = createResponse();
    await unscopedAdmin({
        params: { studentId: 'enrollment-b' },
        user: { id: 'admin-a', role: 'admin', email: null, phone: null },
    } as AuthRequest, denied);
    assert.equal(denied.statusCode, 403);
    assert.equal(executeCalls, 0);
});

test('student enrollment deletion fails closed on repository errors', async () => {
    const handler = createDeleteStudentEnrollmentHandler({
        queryOne: async <T>() => { throw new Error('simulated query failure'); },
        execute: async () => ({ affectedRows: 1 }),
        isPlatformAdmin: async () => false,
    });
    const response = createResponse();
    await handler({
        params: { studentId: 'enrollment-a' },
        user: { id: 'teacher-a', role: 'teacher', tenantId: 'tenant-a', email: null, phone: null },
    } as AuthRequest, response);
    assert.equal(response.statusCode, 500);
    assert.deepEqual(response.body, { error: 'Failed to delete student enrollment' });
});

test('phone lookup returns only a student with an active enrollment in the caller tenant', async () => {
    let querySql = '';
    let queryParams: unknown[] = [];
    const handler = createSearchByPhoneHandler({
        query: async <T>(sql: string, params: unknown[] = []) => {
            querySql = sql;
            queryParams = params;
            return [{ id: 'user-student-a', phone: '+201001234567', name: 'Student A', role: 'student', is_active: 1 }] as T[];
        },
        isPlatformAdmin: async () => false,
    });
    const response = createResponse();
    await handler({
        params: { phone: '01001234567' },
        user: { id: 'teacher-a', role: 'teacher', tenantId: 'tenant-a', email: null, phone: null },
    } as AuthRequest, response);

    assert.equal(response.statusCode, 200);
    assert.equal((response.body as { id: string }).id, 'user-student-a');
    assert.match(querySql, /u\.role = 'student'/);
    assert.match(querySql, /s\.is_active = 1/);
    assert.match(querySql, /s\.approval_status = 'approved'/);
    assert.match(querySql, /s\.tenant_id = \?/);
    assert.equal(queryParams[queryParams.length - 1], 'tenant-a');
    assert.doesNotMatch(querySql, /password_hash|SELECT\s+u\.\*/i);
});

test('phone lookup denies cross-tenant results, unscoped tenant users, and ambiguous matches', async () => {
    const noMatch = createSearchByPhoneHandler({
        query: async <T>() => [] as T[],
        isPlatformAdmin: async () => false,
    });
    const crossTenant = createResponse();
    await noMatch({
        params: { phone: '01001234567' },
        user: { id: 'teacher-a', role: 'teacher', tenantId: 'tenant-a', email: null, phone: null },
    } as AuthRequest, crossTenant);
    assert.equal(crossTenant.statusCode, 404);

    const unscoped = createResponse();
    await noMatch({
        params: { phone: '01001234567' },
        user: { id: 'staff-a', role: 'staff', email: null, phone: null },
    } as AuthRequest, unscoped);
    assert.equal(unscoped.statusCode, 403);

    const ambiguous = createSearchByPhoneHandler({
        query: async <T>() => [
            { id: 'user-a', phone: '01001234567', name: 'A', role: 'student', is_active: 1 },
            { id: 'user-b', phone: '01001234567', name: 'B', role: 'student', is_active: 1 },
        ] as T[],
        isPlatformAdmin: async () => false,
    });
    const ambiguousResponse = createResponse();
    await ambiguous({
        params: { phone: '01001234567' },
        user: { id: 'teacher-a', role: 'teacher', tenantId: 'tenant-a', email: null, phone: null },
    } as AuthRequest, ambiguousResponse);
    assert.equal(ambiguousResponse.statusCode, 409);
});

test('phone lookup permits a server-verified platform admin and fails closed on query errors', async () => {
    let platformQuery = '';
    const platformLookup = createSearchByPhoneHandler({
        query: async <T>(sql: string) => {
            platformQuery = sql;
            return [{ id: 'user-a', phone: '01001234567', name: 'A', role: 'student', is_active: 1 }] as T[];
        },
        isPlatformAdmin: async () => true,
    });
    const platformResponse = createResponse();
    await platformLookup({
        params: { phone: '01001234567' },
        user: { id: 'platform-admin', role: 'admin', email: null, phone: null },
    } as AuthRequest, platformResponse);
    assert.equal(platformResponse.statusCode, 200);
    assert.doesNotMatch(platformQuery, /s\.tenant_id = \?/);
    assert.match(platformQuery, /s\.is_active = 1/);

    const failing = createSearchByPhoneHandler({
        query: async <T>() => { throw new Error('simulated query failure'); },
        isPlatformAdmin: async () => false,
    });
    const failureResponse = createResponse();
    await failing({
        params: { phone: '01001234567' },
        user: { id: 'teacher-a', role: 'teacher', tenantId: 'tenant-a', email: null, phone: null },
    } as AuthRequest, failureResponse);
    assert.equal(failureResponse.statusCode, 500);
    assert.deepEqual(failureResponse.body, { error: 'Failed to search user' });
});

test('staff login lifetime remains capped at seven days without a schema migration', () => {
    assert.equal(resolveJwtLifetimeSeconds('365d'), MAX_JWT_LIFETIME_SECONDS);
    assert.equal(resolveJwtLifetimeSeconds('12h'), 12 * 60 * 60);
});
