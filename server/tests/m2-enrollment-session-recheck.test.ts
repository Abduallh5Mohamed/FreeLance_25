import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { Router } from 'express';
import { createAuthenticateToken } from '../src/middleware/auth';
import { makeRepository, TEST_SECRET, tokenFor, invokeRoute } from './helpers/m2-harness';
import { validateEnrollmentLifecycleInput } from '../src/routes/student-enrollment';

test('lifecycle calendar validation rejects rolled-over dates rather than relying on SQL coercion', () => {
    assert.equal(validateEnrollmentLifecycleInput({ enrollment_start_date: '2026-02-30' }).ok, false);
    assert.equal(validateEnrollmentLifecycleInput({ enrollment_start_date: '2026-13-01' }).ok, false);
    assert.equal(validateEnrollmentLifecycleInput({ enrollment_start_date: '2028-02-29 10:00:00' }).ok, true);
});

test('selected student JWT stops authorizing subsequent resources after live enrollment removal', async () => {
    const oldSecret = process.env.JWT_SECRET;
    process.env.JWT_SECRET = TEST_SECRET;
    try {
        const repository = makeRepository({ student: { is_active: 1, token_version: 0, suspension_active: 0, role: 'student' } });
        let active = true;
        repository.findStudentEnrollments = async () => active ? [{
            id: 'enrollment', user_id: 'student', tenant_id: 'tenant', instructor_id: 'teacher', group_id: null,
        }] : [];
        const router = Router();
        router.get('/resource', createAuthenticateToken(repository), (_req, res) => res.json({ ok: true }));
        const token = tokenFor({ id: 'student', role: 'student', tenant_id: 'tenant', student_enrollment_id: 'enrollment' });
        assert.equal((await invokeRoute(router, { method: 'GET', url: '/resource', token })).statusCode, 200);
        active = false;
        const revoked = await invokeRoute(router, { method: 'GET', url: '/resource', token });
        assert.equal(revoked.statusCode, 401);
        assert.equal((revoked.body as { code: string }).code, 'WORKSPACE_REVOKED');
    } finally {
        if (oldSecret === undefined) delete process.env.JWT_SECRET;
        else process.env.JWT_SECRET = oldSecret;
    }
});

test('production enrollment lookup filters live lifecycle with inclusive start and exclusive UTC end', () => {
    const source = readFileSync(new URL('../src/security/principal-repository.ts', import.meta.url), 'utf8');
    const query = source.slice(source.indexOf('findStudentEnrollments: async'), source.indexOf('findActiveTenantMemberships: async'));
    assert.match(query, /s\.enrollment_status IS NULL OR s\.enrollment_status='active'/);
    assert.match(query, /s\.enrollment_start_date<=UTC_TIMESTAMP\(\)/);
    assert.match(query, /s\.enrollment_end_date>UTC_TIMESTAMP\(\)/);
    assert.doesNotMatch(query, /catch\s*\(/, 'schema/lookup failures must not silently grant legacy access');
});
