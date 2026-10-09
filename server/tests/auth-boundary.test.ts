import assert from 'node:assert/strict';
import test from 'node:test';
import jwt from 'jsonwebtoken';
import { optionalAuth, AuthRequest } from '../src/middleware/auth';
import { enforceStudentWorkspaceBoundary } from '../src/middleware/student-workspace-boundary';

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
