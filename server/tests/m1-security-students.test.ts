import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import jwt from 'jsonwebtoken';
import type { NextFunction, RequestHandler } from 'express';
import { createAuthenticateToken, createOptionalAuth } from '../src/middleware/auth';
import type { PrincipalRepository } from '../src/security/principal-repository';
import { createStudentsRouter, type StudentsRouterDeps } from '../src/routes/students';

const TEST_SECRET = 'test-only-secret-with-sufficient-length';
const originalSecret = process.env.JWT_SECRET;
before(() => { process.env.JWT_SECRET = TEST_SECRET; });
after(() => {
    if (originalSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = originalSecret;
});

interface StudentFixture {
    id: string;
    tenant_id: string;
    name: string;
    email: string;
    phone: string;
    notes: string;
    password_hash: string;
}

interface ExecutedQuery {
    sql: string;
    params: string[];
}

const students: StudentFixture[] = [
    { id: 'enrollment-a', tenant_id: 'tenant-a', name: 'Student A', email: 'a@example.test', phone: '0100000001', notes: 'A notes', password_hash: 'hash-a' },
    { id: 'enrollment-b', tenant_id: 'tenant-b', name: 'Student B', email: 'b@example.test', phone: '0100000002', notes: 'B notes', password_hash: 'hash-b' },
];

const makeRepository = (): PrincipalRepository => ({
    findUsersIdentity: async (id) => ['teacher-a', 'teacher-b', 'student-a', 'student-b', 'platform-admin'].includes(id)
        ? { is_active: 1, token_version: 0, suspension_active: 0 }
        : null,
    findStaffIdentity: async () => null,
    findInstructorAccount: async () => null,
    findStudentEnrollments: async (id) => {
        const student = students.find((row) => row.id === (id === 'student-a' ? 'enrollment-a' : 'enrollment-b'));
        return student ? [{
            id: student.id,
            user_id: id,
            tenant_id: student.tenant_id,
            instructor_id: `instructor-${id.slice(-1)}`,
            group_id: null,
            grade_id: null,
        }] : [];
    },
    findActiveTenantMemberships: async (id) => {
        if (id === 'teacher-a') return [{ tenant_id: 'tenant-a' }];
        if (id === 'teacher-b') return [{ tenant_id: 'tenant-b' }];
        return [];
    },
});

const makeHarness = (options: { platformCapability?: boolean; failOnRead?: boolean } = {}) => {
    const executed: ExecutedQuery[] = [];
    const repository = makeRepository();
    const projectRow = (sql: string, row: StudentFixture): Record<string, unknown> => {
        const result: Record<string, unknown> = { ...row };
        if (!/\bs\.\*\b/i.test(sql) && !/\bs\.password_hash\b/i.test(sql)) delete result.password_hash;
        return result;
    };
    const query = async <T>(sql: string, params: string[] = []): Promise<T[]> => {
        executed.push({ sql, params });
        if (options.failOnRead) throw new Error('simulated database failure');
        const hasTenantFilter = /\bs\.tenant_id\s*=\s*\?/i.test(sql);
        const tenantId = params.find((value) => value === 'tenant-a' || value === 'tenant-b');
        return students
            .filter((row) => !hasTenantFilter || row.tenant_id === tenantId)
            .map((row) => projectRow(sql, row) as T);
    };
    const queryOne = async <T>(sql: string, params: string[] = []): Promise<T | null> => {
        executed.push({ sql, params });
        if (options.failOnRead) throw new Error('simulated database failure');
        const requestedValue = params[0];
        const row = students.find((student) => {
            if (/\bs\.email\s*=\s*\?/i.test(sql)) return student.email === requestedValue;
            if (/\bs\.phone\s*=\s*\?/i.test(sql)) return student.phone === requestedValue;
            if (/\bs\.barcode\s*=\s*\?/i.test(sql)) return student.id === requestedValue;
            return student.id === requestedValue;
        });
        if (!row) return null;
        const hasTenantFilter = /\bs\.tenant_id\s*=\s*\?/i.test(sql);
        const tenantId = params.find((value) => value === 'tenant-a' || value === 'tenant-b');
        if (hasTenantFilter && row.tenant_id !== tenantId) return null;
        if (/s\.tenant_id\s*=\s*\?\s+AND\s+s\.id\s*=\s*\?/i.test(sql) && params[params.length - 1] !== row.id) return null;
        return projectRow(sql, row) as T;
    };
    const deps: StudentsRouterDeps = {
        query,
        queryOne,
        authenticate: createAuthenticateToken(repository) as RequestHandler,
        optionalAuth: createOptionalAuth(repository) as RequestHandler,
        hasPlatformCapability: async () => Boolean(options.platformCapability),
    };
    return { router: createStudentsRouter(deps), executed };
};

interface RouteRequest {
    method: string;
    url: string;
    token?: string;
}

interface CapturedResponse {
    statusCode?: number;
    body?: unknown;
    status(code: number): CapturedResponse;
    json(payload: unknown): CapturedResponse;
}

const invokeRoute = async (router: ReturnType<typeof createStudentsRouter>, request: RouteRequest): Promise<CapturedResponse> => {
    const response: CapturedResponse = {
        status(code: number) { response.statusCode = code; return response; },
        json(payload: unknown) {
            if (response.statusCode === undefined) response.statusCode = 200;
            response.body = payload;
            return response;
        },
    };
    const req = {
        method: request.method,
        url: request.url,
        originalUrl: request.url,
        headers: request.token ? { authorization: `Bearer ${request.token}` } : {},
        body: {},
        query: {},
    };
    await (router as unknown as (req: unknown, res: unknown, next: NextFunction) => Promise<void>)(req, response, () => {});
    const deadline = Date.now() + 5000;
    while (response.statusCode === undefined && response.body === undefined && Date.now() < deadline) {
        await new Promise<void>((resolve) => setImmediate(resolve));
    }
    return response;
};

const tokenFor = (id: string, role: string, extra: Record<string, unknown> = {}): string =>
    jwt.sign({ id, role, tv: 0, ...extra }, TEST_SECRET);

const TEACHER_A = tokenFor('teacher-a', 'teacher');
const STUDENT_A = tokenFor('student-a', 'student', { student_enrollment_id: 'enrollment-a' });
const PLATFORM_ADMIN = tokenFor('platform-admin', 'admin');

test('student notes require authentication and deny student-role readers', async () => {
    const { router, executed } = makeHarness();
    const anonymous = await invokeRoute(router, { method: 'GET', url: '/enrollment-a/notes' });
    assert.equal(anonymous.statusCode, 401);
    const student = await invokeRoute(router, { method: 'GET', url: '/enrollment-a/notes', token: STUDENT_A });
    assert.equal(student.statusCode, 403);
    assert.equal(executed.length, 0);
});

test('tenant member can list only tenant rows and receives no password hash', async () => {
    const { router, executed } = makeHarness();
    const response = await invokeRoute(router, { method: 'GET', url: '/', token: TEACHER_A });
    assert.equal(response.statusCode, 200);
    const body = response.body as Array<Record<string, unknown>>;
    assert.deepEqual(body.map((row) => row.id), ['enrollment-a']);
    assert.equal('password_hash' in body[0], false);
    assert.match(executed[0].sql, /s\.tenant_id\s*=\s*\?/);
    assert.deepEqual(executed[0].params, ['tenant-a']);
    assert.doesNotMatch(executed[0].sql, /s\.\*|password_hash/i);
});

test('by-id and notes reads allow the active tenant and deny cross-tenant rows at SQL', async () => {
    const { router, executed } = makeHarness();
    const allowedStudent = await invokeRoute(router, { method: 'GET', url: '/enrollment-a', token: TEACHER_A });
    assert.equal(allowedStudent.statusCode, 200);
    assert.equal((allowedStudent.body as Record<string, unknown>).id, 'enrollment-a');
    assert.equal('password_hash' in (allowedStudent.body as Record<string, unknown>), false);
    const allowedNotes = await invokeRoute(router, { method: 'GET', url: '/enrollment-a/notes', token: TEACHER_A });
    assert.equal(allowedNotes.statusCode, 200);
    assert.deepEqual(allowedNotes.body, { notes: 'A notes' });

    const byId = await invokeRoute(router, { method: 'GET', url: '/enrollment-b', token: TEACHER_A });
    assert.equal(byId.statusCode, 404);
    const notes = await invokeRoute(router, { method: 'GET', url: '/enrollment-b/notes', token: TEACHER_A });
    assert.equal(notes.statusCode, 404);
    assert.equal(executed.length, 4);
    for (const statement of executed) {
        assert.match(statement.sql, /s\.tenant_id\s*=\s*\?/);
        assert.equal(statement.params.includes('tenant-a'), true);
        assert.doesNotMatch(statement.sql, /s\.\*|password_hash/i);
    }
});

test('verified platform capability permits cross-tenant reads without exposing password hashes', async () => {
    const { router, executed } = makeHarness({ platformCapability: true });
    const response = await invokeRoute(router, { method: 'GET', url: '/enrollment-b', token: PLATFORM_ADMIN });
    assert.equal(response.statusCode, 200);
    assert.equal((response.body as Record<string, unknown>).id, 'enrollment-b');
    assert.equal('password_hash' in (response.body as Record<string, unknown>), false);
    assert.doesNotMatch(executed[0].sql, /s\.tenant_id\s*=\s*\?|s\.\*|password_hash/i);
});

test('platform role claim alone and database failures fail closed', async () => {
    const unverified = makeHarness();
    const denied = await invokeRoute(unverified.router, { method: 'GET', url: '/', token: PLATFORM_ADMIN });
    assert.equal(denied.statusCode, 403);
    assert.equal(unverified.executed.length, 0);

    const failing = makeHarness({ failOnRead: true });
    const failed = await invokeRoute(failing.router, { method: 'GET', url: '/enrollment-a', token: TEACHER_A });
    assert.equal(failed.statusCode, 500);
    assert.deepEqual(failed.body, { error: 'Failed to fetch student' });
});
