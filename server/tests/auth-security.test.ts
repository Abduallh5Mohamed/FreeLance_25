import assert from 'node:assert/strict';
import test from 'node:test';
import jwt from 'jsonwebtoken';
import type { NextFunction, Response } from 'express';
import {
    AuthRequest,
    authenticateToken,
    generateVideoSessionToken,
    getJwtSecret,
    requireRoles,
    requireSelfOrRoles,
    verifyVideoSessionToken,
} from '../src/middleware/auth';
import { resolvePublicRegistrationRole } from '../src/security/registration-policy';

const TEST_SECRET = 'test-only-secret-with-sufficient-length';

type CapturedResponse = Response & {
    capturedStatus?: number;
    capturedBody?: unknown;
};

const createResponse = (): CapturedResponse => {
    const response = {
        status(code: number) {
            response.capturedStatus = code;
            return response;
        },
        json(body: unknown) {
            response.capturedBody = body;
            return response;
        },
    } as CapturedResponse;

    return response;
};

test('public registration never accepts a privileged client-supplied role', () => {
    assert.equal(resolvePublicRegistrationRole('admin'), 'student');
    assert.equal(resolvePublicRegistrationRole('teacher'), 'student');
    assert.equal(resolvePublicRegistrationRole(undefined), 'student');
});

test('JWT configuration fails closed when the secret is missing', () => {
    const originalSecret = process.env.JWT_SECRET;
    delete process.env.JWT_SECRET;

    try {
        assert.throws(() => getJwtSecret(), /JWT_SECRET is required/);
    } finally {
        if (originalSecret === undefined) {
            delete process.env.JWT_SECRET;
        } else {
            process.env.JWT_SECRET = originalSecret;
        }
    }
});

test('authenticateToken rejects a request without a bearer token', async () => {
    const request = { headers: {} } as AuthRequest;
    const response = createResponse();
    let nextCalled = false;

    await authenticateToken(request, response, (() => { nextCalled = true; }) as NextFunction);

    assert.equal(response.capturedStatus, 401);
    assert.equal(nextCalled, false);
});

test('authenticateToken attaches a verified principal', async () => {
    const originalSecret = process.env.JWT_SECRET;
    process.env.JWT_SECRET = TEST_SECRET;

    try {
        // Generic JWT attachment is independent of the instructor subscription gate,
        // which is integration-tested against tenant/subscription fixtures.
        const token = jwt.sign({ id: 'user-1', role: 'admin' }, TEST_SECRET);
        const request = { headers: { authorization: `Bearer ${token}` } } as AuthRequest;
        const response = createResponse();
        let nextCalled = false;

        await authenticateToken(request, response, (() => { nextCalled = true; }) as NextFunction);

        assert.equal(nextCalled, true);
        assert.equal(request.user?.id, 'user-1');
        assert.equal(request.user?.role, 'admin');
    } finally {
        if (originalSecret === undefined) {
            delete process.env.JWT_SECRET;
        } else {
            process.env.JWT_SECRET = originalSecret;
        }
    }
});

test('requireRoles denies a valid principal with the wrong role', () => {
    const request = { user: { id: 'user-1', role: 'student' } } as AuthRequest;
    const response = createResponse();
    let nextCalled = false;

    requireRoles('admin')(request, response, (() => { nextCalled = true; }) as NextFunction);

    assert.equal(response.capturedStatus, 403);
    assert.equal(nextCalled, false);
});

test('requireSelfOrRoles allows the owner and denies another tenant principal', () => {
    const allowRequest = {
        user: { id: 'instructor-1', role: 'instructor' },
        params: { instructorId: 'instructor-1' },
    } as unknown as AuthRequest;
    const denyRequest = {
        user: { id: 'instructor-2', role: 'instructor' },
        params: { instructorId: 'instructor-1' },
    } as unknown as AuthRequest;
    const allowResponse = createResponse();
    const denyResponse = createResponse();
    let allowNextCalled = false;
    let denyNextCalled = false;
    const policy = requireSelfOrRoles('instructorId', 'admin');

    policy(allowRequest, allowResponse, (() => { allowNextCalled = true; }) as NextFunction);
    policy(denyRequest, denyResponse, (() => { denyNextCalled = true; }) as NextFunction);

    assert.equal(allowNextCalled, true);
    assert.equal(denyNextCalled, false);
    assert.equal(denyResponse.capturedStatus, 403);
});

test('video session tokens retain their user, video, and session binding', () => {
    const originalSecret = process.env.JWT_SECRET;
    process.env.JWT_SECRET = TEST_SECRET;

    try {
        const token = generateVideoSessionToken({
            userId: 'student-1',
            videoId: 'video-1',
            sessionId: 'session-1',
            ip: '127.0.0.1',
            userAgent: 'test-agent',
            fingerprint: 'fingerprint-1',
            screenRes: '1920x1080',
        });
        const request = {
            headers: { 'user-agent': 'test-agent', 'x-forwarded-for': '127.0.0.1' },
            ip: '127.0.0.1',
        } as unknown as AuthRequest;

        const result = verifyVideoSessionToken(token, request);

        assert.equal(result.valid, true);
        assert.equal(result.decoded?.sub, 'student-1');
        assert.equal(result.decoded?.vid, 'video-1');
        assert.equal(result.decoded?.sid, 'session-1');
    } finally {
        if (originalSecret === undefined) {
            delete process.env.JWT_SECRET;
        } else {
            process.env.JWT_SECRET = originalSecret;
        }
    }
});

test('video session tokens reject a different client binding', () => {
    const originalSecret = process.env.JWT_SECRET;
    process.env.JWT_SECRET = TEST_SECRET;

    try {
        const token = generateVideoSessionToken({
            userId: 'student-1',
            videoId: 'video-1',
            sessionId: 'session-1',
            ip: '127.0.0.1',
            userAgent: 'test-agent',
            fingerprint: 'fingerprint-1',
            screenRes: '1920x1080',
        });
        const request = {
            headers: { 'user-agent': 'other-agent', 'x-forwarded-for': '127.0.0.2' },
            ip: '127.0.0.2',
        } as unknown as AuthRequest;

        const result = verifyVideoSessionToken(token, request);

        assert.equal(result.valid, false);
        assert.match(result.reason || '', /mismatch/i);
    } finally {
        if (originalSecret === undefined) {
            delete process.env.JWT_SECRET;
        } else {
            process.env.JWT_SECRET = originalSecret;
        }
    }
});

test('video session tokens reject a different device fingerprint', () => {
    const originalSecret = process.env.JWT_SECRET;
    process.env.JWT_SECRET = TEST_SECRET;
    try {
        const token = generateVideoSessionToken({
            userId: 'student-1', videoId: 'video-1', sessionId: 'session-1',
            ip: '127.0.0.1', userAgent: 'test-agent', fingerprint: 'fingerprint-1', screenRes: '1920x1080',
        });
        const request = {
            headers: {
                'user-agent': 'test-agent', 'x-forwarded-for': '127.0.0.1',
                'x-video-fingerprint': 'fingerprint-2', 'x-screen-resolution': '1920x1080',
            },
            ip: '127.0.0.1',
        } as unknown as AuthRequest;
        const result = verifyVideoSessionToken(token, request);
        assert.equal(result.valid, false);
        assert.match(result.reason || '', /fingerprint/i);
    } finally {
        if (originalSecret === undefined) delete process.env.JWT_SECRET;
        else process.env.JWT_SECRET = originalSecret;
    }
});

test('video session tokens expire within one minute', () => {
    const originalSecret = process.env.JWT_SECRET;
    process.env.JWT_SECRET = TEST_SECRET;
    try {
        const token = generateVideoSessionToken({
            userId: 'student-1', videoId: 'video-1', sessionId: 'session-1',
            ip: '127.0.0.1', userAgent: 'test-agent', fingerprint: 'fingerprint-1', screenRes: '1920x1080',
        });
        const decoded = jwt.decode(token) as { iat: number; exp: number };
        assert.ok(decoded.exp - decoded.iat <= 60);
        assert.ok(decoded.exp - decoded.iat >= 55);
    } finally {
        if (originalSecret === undefined) delete process.env.JWT_SECRET;
        else process.env.JWT_SECRET = originalSecret;
    }
});
