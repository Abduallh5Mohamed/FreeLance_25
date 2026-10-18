import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import { createAuthenticateToken } from '../src/middleware/auth';
import {
    generateCertificateId,
    generateVerificationId,
    isEligibleForCertificate,
    isRevoked,
    publicCertificateFacts,
} from '../src/services/certificates';
import { createCertificatesRouter, type CertificatesDataAccess } from '../src/routes/certificates';
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

const INSTRUCTOR_A = tokenFor({ id: 'instructor-a', role: 'instructor', tv: 0, tenant_id: 'tenant-a' });
const INSTRUCTOR_B = tokenFor({ id: 'instructor-b', role: 'instructor', tv: 0, tenant_id: 'tenant-b' });
const INSTRUCTOR_C = tokenFor({ id: 'instructor-c', role: 'instructor', tv: 0, tenant_id: 'tenant-a' });
const STUDENT_A = tokenFor({ id: 'student-a', role: 'student', tv: 0, student_enrollment_id: 'enr-s1', tenant_id: 'tenant-a' });

const AUTHORITY: Record<string, string> = { 'instructor-a': 'owner', 'instructor-c': 'instructor' };

function build(opts: { responder?: (sql: string, params: unknown[]) => unknown[] | null } = {}) {
    const db = makeFakeDataAccess(opts.responder ?? (() => []));
    const repository = makeRepository(
        { 'instructor-a': { is_active: 1, token_version: 0 }, 'instructor-b': { is_active: 1, token_version: 0 }, 'instructor-c': { is_active: 1, token_version: 0 }, 'student-a': { is_active: 1, token_version: 0 } },
        {
            instructorAccounts: { 'instructor-a': { tenant_status: 'active', legacy_compat: 1, allowed: 1 }, 'instructor-c': { tenant_status: 'active', legacy_compat: 1, allowed: 1 } },
            memberships: { 'instructor-a': [{ tenant_id: 'tenant-a' }], 'instructor-c': [{ tenant_id: 'tenant-a' }], 'student-a': [{ tenant_id: 'tenant-a' }] },
            enrollments: { 'student-a': [{ id: 'enr-s1', user_id: 'student-a', tenant_id: 'tenant-a', instructor_id: null, group_id: null, grade_id: null }] },
        },
    );
    const loadActiveTenantAuthority = async (userId: string, tenantId: string) => {
        const authority = AUTHORITY[userId];
        return authority && tenantId === 'tenant-a' ? { authority } : null;
    };
    const router = createCertificatesRouter({
        db,
        authenticate: createAuthenticateToken(repository),
        loadActiveTenantAuthority,
    });
    return { router, executed: db.executed };
}

/**
 * Scripted server-side academic records for the issue path, so a test declares
 * what the SERVER knows rather than what the request body claims.
 */
function issueResponder(opts: {
    enrollment?: unknown[];
    course?: unknown[];
    scores?: unknown[];
    lessons?: number;
    completions?: number;
    examTotal?: number;
    examPassed?: number;
    existing?: unknown[];
} = {}) {
    return (sql: string): unknown[] => {
        if (sql.includes('FROM students')) return opts.enrollment ?? [{ id: 'enr-1' }];
        if (sql.includes('FROM courses')) return opts.course ?? [{ id: 'course-1', tenant_id: 'tenant-a', instructor_id: 'instructor-a' }];
        if (sql.includes('gradebook_policies')) return [];
        if (sql.includes('gradebook_scores')) return opts.scores ?? [{ category_id: null, item_type: 'manual', item_id: null, score: 90, max_score: 100, weight: null }];
        if (sql.includes('FROM lectures')) return [{ total: opts.lessons ?? 0 }];
        if (sql.includes('lesson_completions')) return [{ completed: opts.completions ?? 0 }];
        if (sql.includes('exam_versioned_attempts')) return [{ total: opts.examTotal ?? 0, passed: opts.examPassed ?? 0 }];
        if (sql.includes('FROM certificates')) return opts.existing ?? [];
        if (sql.includes('tenant_branding')) return [];
        return [];
    };
}

test('eligibility: score threshold', () => {
    assert.equal(isEligibleForCertificate({ finalScore: 80, threshold: 70 }), true);
    assert.equal(isEligibleForCertificate({ finalScore: 60, threshold: 70 }), false);
});

test('eligibility: incomplete lessons or assignments are ineligible', () => {
    assert.equal(isEligibleForCertificate({ finalScore: 90, threshold: 70, completedLessons: 4, totalLessons: 10 }), false);
    assert.equal(isEligibleForCertificate({ finalScore: 90, threshold: 70, allAssignmentsSubmitted: false }), false);
    assert.equal(isEligibleForCertificate({ finalScore: 90, threshold: 70, allExamsPassed: false }), false);
});

test('verification id is unguessable (long hex) and unique', () => {
    const id = generateVerificationId();
    assert.ok(id.length >= 32);
    assert.ok(/^[a-f0-9]+$/.test(id));
    const ids = new Set(Array.from({ length: 50 }, () => generateVerificationId()));
    assert.equal(ids.size, 50, 'verification ids must not repeat');
    assert.ok(/^[a-f0-9]{32}$/.test(generateCertificateId()));
});

test('public facts minimal and branding-safe', () => {
    const facts = publicCertificateFacts({ verificationId: 'abc', status: 'issued', issuedAt: '2026-01-01T00:00:00.000Z', courseName: 'Math', studentName: 'Ali', tenantName: 'T', finalScore: 90 });
    assert.equal(facts.verification_id, 'abc');
    assert.equal(facts.status, 'issued');
    assert.equal(facts.branding, null);
    const branded = publicCertificateFacts({
        verificationId: 'abc', status: 'issued', issuedAt: '2026-01-01T00:00:00.000Z',
        branding: { logoUrl: 'https://x/logo.png', primaryColor: '#111', locale: 'ar' },
    });
    assert.deepEqual(branded.branding, {
        logo_url: 'https://x/logo.png', primary_color: '#111', secondary_color: null, accent_color: null, locale: 'ar',
    });
});

test('isRevoked recognizes status and timestamp', () => {
    assert.equal(isRevoked('issued', null), false);
    assert.equal(isRevoked('revoked', null), true);
    assert.equal(isRevoked('issued', '2026-01-01T00:00:00.000Z'), true);
});

test('anonymous denied for list', async () => {
    const { router, executed } = build();
    const res = await invokeRoute(router, { method: 'GET', url: '/' });
    assert.equal(res.statusCode, 401);
    assert.equal(executed.length, 0);
});

test('verify endpoint returns 404 for unknown', async () => {
    const { router } = build({ responder: () => [] });
    const res = await invokeRoute(router, { method: 'GET', url: '/verify/doesnotexist' });
    assert.equal(res.statusCode, 404);
});

test('verify endpoint is public, minimal and reports revocation', async () => {
    const row = {
        id: 'cert-1', tenant_id: 'tenant-a', student_enrollment_id: 'enr-1', course_id: 'course-1',
        verification_id: 'v'.repeat(64), status: 'revoked', final_score: 88, issued_at: '2026-01-01T00:00:00.000Z',
        issued_by: 'instructor-a', revoked_at: '2026-02-01T00:00:00.000Z', revoked_by: 'instructor-a', revoke_reason: 'mistake',
        course_name: 'Algebra', tenant_name: 'Acme Academy',
        branding_logo_url: 'https://x/logo.png', branding_primary_color: '#111', branding_secondary_color: null, branding_accent_color: null, branding_locale: 'ar',
    };
    const { router } = build({ responder: (sql) => (sql.includes('WHERE c.verification_id') ? [row] : []) });
    const res = await invokeRoute(router, { method: 'GET', url: `/verify/${'v'.repeat(64)}` });
    assert.equal(res.statusCode, 200);
    const cert = (res.body as any).certificate;
    assert.equal(cert.status, 'revoked');
    assert.equal(cert.verification_id, 'v'.repeat(64));
    // Finding #10: no internal UUIDs and no raw numeric score on the public surface.
    assert.ok(!('id' in cert) && !('student_enrollment_id' in cert) && !('issued_by' in cert), 'internal ids must never be public');
    assert.ok(!('course_id' in cert) && !('tenant_id' in cert), 'internal course/tenant UUIDs must never be public');
    assert.equal(cert.final_score, null, 'the raw score must never be projected to an anonymous verifier');
    assert.equal(cert.course, 'Algebra', 'the public surface must project a display name, not a UUID');
    assert.equal(cert.tenant, 'Acme Academy', 'the public surface must project a display name, not a UUID');
    assert.equal(cert.branding.primary_color, '#111');
});

test('issue requires server-side eligibility (no recorded pass fails closed)', async () => {
    // The body declares a passing score, but the server has no academic records.
    const { router, executed } = build({ responder: issueResponder({ scores: [] }) });
    const res = await invokeRoute(router, { method: 'POST', url: '/', token: INSTRUCTOR_A, body: { student_enrollment_id: 'enr-1', course_id: 'course-1', final_score: 100, threshold: 0 } });
    assert.equal(res.statusCode, 400);
    assert.ok(!executed.some((e) => e.kind === 'execute' && e.sql.includes('INSERT INTO certificates')), 'no certificate may be written for an ineligible student');
});

test('issue ignores body-declared facts: server records below threshold are rejected', async () => {
    // Finding #2 rejection path: every declared fact would pass, but the server
    // recompute from stored scores/lessons/exams decides.
    const { router, executed } = build({ responder: issueResponder({ scores: [{ category_id: null, item_type: 'manual', item_id: null, score: 10, max_score: 100, weight: null }] }) });
    const res = await invokeRoute(router, {
        method: 'POST', url: '/', token: INSTRUCTOR_A,
        body: { student_enrollment_id: 'enr-1', course_id: 'course-1', final_score: 100, threshold: 0, completed_lessons: 10, total_lessons: 10, all_exams_passed: true, all_assignments_submitted: true },
    });
    assert.equal(res.statusCode, 400);
    assert.ok((res.body as any).reasons.includes('score_below_threshold'));
    assert.ok(!executed.some((e) => e.kind === 'execute' && e.sql.includes('INSERT INTO certificates')));
});

test('issue mints a server-generated unique verification id and audits it', async () => {
    // The body declares failing facts; the server records show a real pass.
    const { router, executed } = build({ responder: issueResponder({ lessons: 2, completions: 2, examTotal: 1, examPassed: 1 }) });
    const res = await invokeRoute(router, {
        method: 'POST', url: '/', token: INSTRUCTOR_A,
        body: {
            student_enrollment_id: 'enr-1', course_id: 'course-1',
            final_score: 0, threshold: 100, completed_lessons: 0, total_lessons: 10,
            all_exams_passed: false, all_assignments_submitted: false,
            verification_id: 'attacker-supplied',
        },
    });
    assert.equal(res.statusCode, 201);
    const body = res.body as any;
    assert.match(body.verification_id, /^[a-f0-9]{64}$/);
    assert.notEqual(body.verification_id, 'attacker-supplied');
    assert.ok(body.id);
    const audit = executed.find((e: ExecutedStatement) => e.kind === 'execute' && e.sql.includes('INSERT INTO audit_events'));
    assert.ok(audit && audit.params.includes('certificate.issue'));
});

test('issue refuses to issue twice for the same enrollment/course', async () => {
    const { router } = build({ responder: issueResponder({ lessons: 1, completions: 1, existing: [{ id: 'existing' }] }) });
    const res = await invokeRoute(router, { method: 'POST', url: '/', token: INSTRUCTOR_A, body: { student_enrollment_id: 'enr-1', course_id: 'course-1' } });
    assert.equal(res.statusCode, 409);
});

test('issue rejects an enrollment that does not exist in the caller tenant', async () => {
    const { router, executed } = build({ responder: issueResponder({ enrollment: [] }) });
    const res = await invokeRoute(router, { method: 'POST', url: '/', token: INSTRUCTOR_A, body: { student_enrollment_id: 'foreign-enr', course_id: 'course-1' } });
    assert.equal(res.statusCode, 404);
    assert.ok(!executed.some((e) => e.kind === 'execute' && e.sql.includes('INSERT INTO certificates')));
});

test('issue rejects a course that does not belong to the caller tenant', async () => {
    const { router, executed } = build({ responder: issueResponder({ course: [{ id: 'course-1', tenant_id: 'tenant-b', instructor_id: 'instructor-a' }] }) });
    const res = await invokeRoute(router, { method: 'POST', url: '/', token: INSTRUCTOR_A, body: { student_enrollment_id: 'enr-1', course_id: 'course-1' } });
    assert.equal(res.statusCode, 404);
    assert.ok(!executed.some((e) => e.kind === 'execute' && e.sql.includes('INSERT INTO certificates')));
});

test('issue rejects an instructor with no authority over the course', async () => {
    // Finding #6 rejection path: non-owner instructor, course taught by someone
    // else and no group/branch relation -> forbidden, no write.
    const { router, executed } = build({ responder: issueResponder({ course: [{ id: 'course-1', tenant_id: 'tenant-a', instructor_id: 'another-instructor' }] }) });
    const res = await invokeRoute(router, { method: 'POST', url: '/', token: INSTRUCTOR_C, body: { student_enrollment_id: 'enr-1', course_id: 'course-1' } });
    assert.equal(res.statusCode, 403);
    assert.ok(!executed.some((e) => e.kind === 'execute' && e.sql.includes('INSERT INTO certificates')));
});

test('issue allows the course instructor (server-derived authority)', async () => {
    const { router } = build({ responder: issueResponder({ course: [{ id: 'course-1', tenant_id: 'tenant-a', instructor_id: 'instructor-c' }] }) });
    const res = await invokeRoute(router, { method: 'POST', url: '/', token: INSTRUCTOR_C, body: { student_enrollment_id: 'enr-1', course_id: 'course-1' } });
    assert.equal(res.statusCode, 201);
});

test('a student cannot forge an issue', async () => {
    const { router } = build({ responder: () => [] });
    const res = await invokeRoute(router, { method: 'POST', url: '/', token: STUDENT_A, body: { student_enrollment_id: 'enr-s1', course_id: 'course-1', final_score: 100, threshold: 70 } });
    assert.equal(res.statusCode, 403);
});

test('a cross-tenant instructor cannot act on another tenant', async () => {
    const { router } = build({ responder: () => [] });
    const res = await invokeRoute(router, { method: 'POST', url: '/', token: INSTRUCTOR_B, body: { student_enrollment_id: 'enr-1', course_id: 'course-1', final_score: 90, threshold: 70 } });
    assert.equal(res.statusCode, 403);
});

test('revoke flips status, audits and is idempotent-safe', async () => {
    const issued = { id: 'cert-1', tenant_id: 'tenant-a', student_enrollment_id: 'enr-1', course_id: 'course-1', verification_id: 'v', status: 'issued', final_score: 90, issued_at: '2026-01-01', issued_by: 'instructor-a', revoked_at: null, revoked_by: null, revoke_reason: null, branding_logo_url: null, branding_primary_color: null, branding_secondary_color: null, branding_accent_color: null, branding_locale: null };
    const { router, executed } = build({ responder: (sql) => (sql.includes('FROM certificates WHERE tenant_id=? AND id=?') ? [issued] : []) });
    const res = await invokeRoute(router, { method: 'POST', url: '/cert-1/revoke', token: INSTRUCTOR_A, body: { reason: 'policy' } });
    assert.equal(res.statusCode, 200);
    const update = executed.find((e: ExecutedStatement) => e.kind === 'execute' && e.sql.includes('UPDATE certificates SET status=?'));
    assert.ok(update);
    assert.equal(update!.params[0], 'revoked');
    const audit = executed.find((e: ExecutedStatement) => e.kind === 'execute' && e.sql.includes('INSERT INTO audit_events'));
    assert.ok(audit && audit.params.includes('certificate.revoke'));

    const already = { ...issued, status: 'revoked' };
    const second = build({ responder: (sql) => (sql.includes('FROM certificates WHERE tenant_id=? AND id=?') ? [already] : []) });
    const res2 = await invokeRoute(second.router, { method: 'POST', url: '/cert-1/revoke', token: INSTRUCTOR_A, body: {} });
    assert.equal(res2.statusCode, 409);
});

test('a certificate cannot be revoked through a foreign tenant scope', async () => {
    const issued = { id: 'cert-1', tenant_id: 'tenant-a', student_enrollment_id: 'enr-1', course_id: 'course-1', verification_id: 'v', status: 'issued', final_score: 90, issued_at: '2026-01-01', issued_by: 'instructor-a', revoked_at: null, revoked_by: null, revoke_reason: null, branding_logo_url: null, branding_primary_color: null, branding_secondary_color: null, branding_accent_color: null, branding_locale: null };
    const { router } = build({ responder: (sql) => (sql.includes('FROM certificates WHERE tenant_id=? AND id=?') ? [issued] : []) });
    const res = await invokeRoute(router, { method: 'POST', url: '/cert-1/revoke', token: INSTRUCTOR_B, body: {} });
    assert.equal(res.statusCode, 403);
});
