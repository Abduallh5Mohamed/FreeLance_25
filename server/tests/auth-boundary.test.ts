import assert from 'node:assert/strict';
import test from 'node:test';
import jwt from 'jsonwebtoken';
import { optionalAuth, AuthRequest } from '../src/middleware/auth';
import { enforceStudentWorkspaceBoundary } from '../src/middleware/student-workspace-boundary';
import { enforceTenantAuthorityBoundary } from '../src/middleware/tenant-authority-boundary';
import { verifySocketPrincipal } from '../src/services/socket';

const secret = 'test-only-secret-with-sufficient-entropy';
process.env.JWT_SECRET = secret;

function invokeMiddleware(middleware: any, reqOverrides: Record<string, any> = {}) {
    const req: any = { headers: {}, method: 'GET', path: '/api/courses', body: {}, query: {}, ...reqOverrides };
    const res: any = {
        statusCode: 200,
        payload: undefined,
        status(code: number) { this.statusCode = code; return this; },
        json(payload: unknown) { this.payload = payload; return this; },
    };
    let nextCalled = false;
    const next = () => { nextCalled = true; };
    return Promise.resolve(middleware(req, res, next)).then(() => ({ req, res, nextCalled }));
}

test('optional auth permits anonymous requests only when no credential was supplied', async () => {
    const result = await invokeMiddleware(optionalAuth);
    assert.equal(result.nextCalled, true);
    assert.equal(result.req.authResolved, true);
    assert.equal(result.req.user, undefined);
});

test('optional auth rejects malformed bearer headers instead of downgrading to anonymous', async () => {
    const result = await invokeMiddleware(optionalAuth, { headers: { authorization: 'Basic anything' } });
    assert.equal(result.res.statusCode, 401);
    assert.equal(result.nextCalled, false);
});

test('optional auth rejects invalid tokens instead of downgrading to anonymous', async () => {
    const result = await invokeMiddleware(optionalAuth, { headers: { authorization: 'Bearer invalid-token' } });
    assert.equal(result.res.statusCode, 401);
    assert.equal(result.nextCalled, false);
});

test('optional auth resolves supported authenticated claims for downstream routes', async () => {
    const token = jwt.sign({ id: 'admin-a', role: 'admin' }, secret, { expiresIn: '1m' });
    const result = await invokeMiddleware(optionalAuth, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(result.nextCalled, true);
    assert.equal(result.req.user.id, 'admin-a');
    assert.equal(result.req.user.role, 'admin');
});

test('student boundary blocks tenant B identifiers at the API boundary', async () => {
    const req = {
        path: '/courses', method: 'GET', body: {}, query: { tenant_id: 'tenant-b' },
        user: { id: 'student-a', role: 'student', tenantId: 'tenant-a', studentEnrollmentId: 'enrollment-a', instructorId: 'teacher-a', groupId: 'group-a', gradeId: 'grade-a' },
    } as unknown as AuthRequest;
    const res: any = { statusCode: 200, status(code: number) { this.statusCode = code; return this; }, json() { return this; } };
    let nextCalled = false;
    enforceStudentWorkspaceBoundary(req, res, () => { nextCalled = true; });
    assert.equal(res.statusCode, 403);
    assert.equal(nextCalled, false);
});

test('tenant authority ignores no client selectors: body, query, and headers are rejected', () => {
    const make = (overrides: Record<string, unknown>) => ({
        ...overrides,
        user: { id: 'teacher-a', role: 'teacher', tenantId: 'tenant-a' },
    }) as unknown as AuthRequest;
    const cases = [
        make({ body: { tenant_id: 'tenant-b' }, query: {}, headers: {} }),
        make({ body: {}, query: { tenantId: 'tenant-b' }, headers: {} }),
        make({ body: {}, query: {}, headers: { 'x-tenant-id': 'tenant-b' } }),
    ];
    for (const req of cases) {
        const res: any = { statusCode: 200, status(code: number) { this.statusCode = code; return this; }, json() { return this; } };
        let nextCalled = false;
        enforceTenantAuthorityBoundary(req, res, () => { nextCalled = true; });
        assert.equal(res.statusCode, 400);
        assert.equal(nextCalled, false);
    }
});

test('student boundary rejects cross-student body substitution and allows own enrollment', async () => {
    const req = {
        path: '/assignments', method: 'POST', body: { student_id: 'student-b' }, query: {},
        user: { id: 'student-a', role: 'student', tenantId: 'tenant-a', studentEnrollmentId: 'enrollment-a', instructorId: 'teacher-a', groupId: 'group-a', gradeId: 'grade-a' },
    } as unknown as AuthRequest;
    const res: any = { statusCode: 200, status(code: number) { this.statusCode = code; return this; }, json() { return this; } };
    let nextCalled = false;
    enforceStudentWorkspaceBoundary(req, res, () => { nextCalled = true; });
    assert.equal(res.statusCode, 403);
    assert.equal(nextCalled, false);

    req.body = { student_id: 'enrollment-a', tenant_id: 'tenant-a' };
    enforceStudentWorkspaceBoundary(req, res, () => { nextCalled = true; });
    assert.equal(nextCalled, true);
});

test('Socket.IO principal is derived from a verified JWT, not event payload identity', () => {
    const token = jwt.sign({ id: 'socket-user-a', role: 'teacher' }, secret, { expiresIn: '1m' });
    assert.deepEqual(verifySocketPrincipal(token), { id: 'socket-user-a', role: 'teacher' });
    assert.throws(() => verifySocketPrincipal('forged-token'));
    const invalidClaims = jwt.sign({ id: 'socket-user-a', role: 'platform-root' }, secret, { expiresIn: '1m' });
    assert.throws(() => verifySocketPrincipal(invalidClaims));
});
