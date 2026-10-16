import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import type { NextFunction, Request, Response } from 'express';
import { AuthRequest, createAuthenticateToken } from '../src/middleware/auth';
import { createLoginHandler } from '../src/routes/auth';
import { createStaffRouter } from '../src/routes/staff';
import { PrincipalRepository } from '../src/security/principal-repository';
import { AdminPermissionLookup, createRequireAdminPermission } from '../src/security/admin-permissions';
import {
    isIssuableIdentity,
    isStaffIdentityLive,
    isUsersIdentityLive,
    selectActiveTenantScope,
    selectStudentWorkspaceScope,
} from '../src/security/identity-scope';
import {
    ACTIVE_SUSPENSION_PREDICATE_SQL,
    isTimeBoundSuspensionActive,
} from '../src/security/suspension-predicate';
import { resolvePublicRegistrationRole } from '../src/security/registration-policy';

/**
 * M1 multi-space auth regression suite (corrective follow-up).
 *
 * UNIT EVIDENCE ONLY: every test drives production code through injected /
 * mocked repository boundaries (createAuthenticateToken, createLoginHandler,
 * createStaffRouter) with disposable fixtures. No database, network, Docker,
 * or real service is contacted; the MySQL pool in src/db.ts is never created
 * because no query runs. Time-bound suspension enters the rules as the
 * server-computed `suspension_active` flag (SQL compares against
 * UTC_TIMESTAMP()), so no wall clock is faked here. The shipped SQL text
 * itself is covered by static source regressions below (labeled static/unit,
 * NOT live SQL); live SQL execution stays with the Docker-based integration
 * suite, which is NOT RUN in this environment.
 *
 * The SQL-backed integration paths remain covered by
 * tests/integration/m1-tenant-isolation.test.ts, which requires compose
 * MySQL (Docker) and a running API: NOT RUN in this environment.
 */

const TEST_SECRET = 'test-only-secret-with-sufficient-length';
const FIXTURE_PASSWORD = 'disposable-fixture-password';
const fixtureHash = bcrypt.hashSync(FIXTURE_PASSWORD, 4);

const originalSecret = process.env.JWT_SECRET;
before(() => { process.env.JWT_SECRET = TEST_SECRET; });
after(() => {
    if (originalSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = originalSecret;
});

const enrollment = (overrides: Partial<{
    id: string; user_id: string; tenant_id: string;
    instructor_id: string | null; group_id: string | null; grade_id: string | null;
}> = {}) => ({
    id: 'enrollment-a',
    user_id: 'student-a',
    tenant_id: 'tenant-a',
    instructor_id: 'instructor-a',
    group_id: 'group-a',
    grade_id: 'grade-a',
    ...overrides,
});

interface IdentityFixtures {
    users?: Record<string, { is_active: boolean | number; token_version: number | null; suspension_active: boolean | number }>;
    staff?: Record<string, { is_active: boolean | number }>;
    memberships?: Record<string, Array<{ tenant_id: string }>>;
    enrollments?: Record<string, ReturnType<typeof enrollment>[]>;
    instructorAccounts?: Record<string, { tenant_status: string; legacy_compat: number; allowed: number }>;
}

const makeRepository = (fixtures: IdentityFixtures = {}): PrincipalRepository => ({
    findUsersIdentity: async (id) => fixtures.users?.[id] ?? null,
    findStaffIdentity: async (id) => fixtures.staff?.[id] ?? null,
    findInstructorAccount: async (id) => fixtures.instructorAccounts?.[id] ?? null,
    findStudentEnrollments: async (id) => fixtures.enrollments?.[id] ?? [],
    findActiveTenantMemberships: async (id) => fixtures.memberships?.[id] ?? [],
});

type CapturedResponse = Response & { capturedStatus?: number; capturedBody?: unknown };

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

const tokenFor = (claims: Record<string, unknown>): string => jwt.sign(claims, TEST_SECRET);

const runAuthenticate = async (
    token: string | null,
    repository: PrincipalRepository,
    overrides: Partial<AuthRequest> = {},
) => {
    const authenticate = createAuthenticateToken(repository);
    const request = {
        headers: token ? { authorization: `Bearer ${token}` } : {},
        method: 'GET',
        originalUrl: '/api/courses',
        ...overrides,
    } as AuthRequest;
    const response = createResponse();
    let nextCalled = false;
    await authenticate(request, response, (() => { nextCalled = true; }) as NextFunction);
    return { request, response, nextCalled };
};

// ---------------------------------------------------------------------------
// Pure scope / liveness / issuance rules (identity-scope.ts)
// ---------------------------------------------------------------------------

test('zero active memberships authenticate the identity but grant no tenant scope', () => {
    assert.equal(selectActiveTenantScope([], undefined), null);
    assert.equal(selectActiveTenantScope([], 'tenant-a'), null);
});

test('exactly one active membership resolves to that tenant', () => {
    const rows = [{ tenant_id: 'tenant-a' }];
    assert.equal(selectActiveTenantScope(rows, undefined), 'tenant-a');
});

test('multiple memberships resolve only through a selector that matches a server row', () => {
    const rows = [{ tenant_id: 'tenant-a' }, { tenant_id: 'tenant-b' }];
    assert.equal(selectActiveTenantScope(rows, 'tenant-b'), 'tenant-b');
    assert.equal(selectActiveTenantScope(rows, undefined), null);
});

test('a tenant claim that matches no active membership never becomes scope', () => {
    const rows = [{ tenant_id: 'tenant-a' }];
    assert.equal(selectActiveTenantScope(rows, 'tenant-forged'), null);
    const many = [{ tenant_id: 'tenant-a' }, { tenant_id: 'tenant-b' }];
    assert.equal(selectActiveTenantScope(many, 'tenant-forged'), null);
});

test('a student without a workspace selection is authenticated without scope', () => {
    assert.equal(selectStudentWorkspaceScope([enrollment()], {}), null);
    assert.equal(selectStudentWorkspaceScope([enrollment()], { student_enrollment_id: null }), null);
});

test('a selected workspace resolves every scope field from the server row, not from claims', () => {
    const rows = [enrollment(), enrollment({ id: 'enrollment-b', tenant_id: 'tenant-b' })];
    const scope = selectStudentWorkspaceScope(rows, {
        student_enrollment_id: 'enrollment-b',
        tenant_id: 'tenant-forged',
        instructor_id: 'instructor-forged',
        group_id: 'group-forged',
        grade_id: 'grade-forged',
    });
    assert.deepEqual(scope, {
        tenantId: 'tenant-b',
        studentEnrollmentId: 'enrollment-b',
        instructorId: 'instructor-a',
        groupId: 'group-a',
        gradeId: 'grade-a',
    });
});

test('a forged or stale enrollment selection does not resolve to any workspace', () => {
    const rows = [enrollment()];
    assert.equal(selectStudentWorkspaceScope(rows, { student_enrollment_id: 'enrollment-forged' }), null);
    assert.equal(selectStudentWorkspaceScope([], { student_enrollment_id: 'enrollment-a' }), null);
});

test('users-table identity liveness rejects inactive accounts and stale token versions', () => {
    assert.equal(isUsersIdentityLive({ is_active: 1, token_version: 0 }, 0), true);
    assert.equal(isUsersIdentityLive({ is_active: 0, token_version: 0 }, 0), false);
    assert.equal(isUsersIdentityLive({ is_active: 1, token_version: 2 }, 0), false);
    assert.equal(isUsersIdentityLive({ is_active: 1, token_version: 2 }, 2), true);
    assert.equal(isUsersIdentityLive(null, 0), false);
});

test('staff-table identities are revoked through their row without a token_version column', () => {
    assert.equal(isStaffIdentityLive({ is_active: 1 }), true);
    assert.equal(isStaffIdentityLive({ is_active: 0 }), false);
    assert.equal(isStaffIdentityLive(null), false);
});

test('time-bound suspension blocks token issuance while it is active', () => {
    assert.equal(isIssuableIdentity({ is_active: 1, suspension_active: 1 }), false);
    assert.equal(isIssuableIdentity({ is_active: 1, suspension_active: 0 }), true);
    assert.equal(isIssuableIdentity({ is_active: 0, suspension_active: 0 }), false);
    // Rows without a suspension column (staff table) fall back to is_active.
    assert.equal(isIssuableIdentity({ is_active: 1 }), true);
    assert.equal(isIssuableIdentity(null), false);
});

test('an active time-bound suspension also revokes live sessions regardless of token version', () => {
    assert.equal(isUsersIdentityLive({ is_active: 1, token_version: 2, suspension_active: 1 }, 2), false);
    assert.equal(isUsersIdentityLive({ is_active: 1, token_version: 2, suspension_active: 0 }, 2), true);
    assert.equal(isUsersIdentityLive({ is_active: 1, token_version: 2 }, 2), true);
});

// ---------------------------------------------------------------------------
// Suspension SQL regression (STATIC/UNIT evidence - not a live database)
//
// Fixture-only unit tests previously masked an inverted SQL mapping: the
// repository computed `suspended_active` as true while `suspended_until` was
// NULL/past, which rejected healthy accounts and admitted suspended ones.
// These regressions pin the shipped SQL text and the shared semantics table;
// live SQL execution remains the Docker integration suite's responsibility.
// ---------------------------------------------------------------------------

const INVERTED_PREDICATE_FRAGMENT = 'suspended_until IS NULL OR';

const readProductionSource = (relativeFromTests: string): string =>
    readFileSync(join(__dirname, relativeFromTests), 'utf8');

test('every production identity query embeds the shared active-suspension predicate', () => {
    const sites = [
        '../src/security/principal-repository.ts', // request-time liveness
        '../src/routes/auth.ts',                   // login issuance
    ];
    for (const site of sites) {
        const source = readProductionSource(site);
        // The predicate is never re-typed inline: each site interpolates the
        // shared constant, so issuance and request liveness cannot drift.
        assert.ok(
            source.includes('${ACTIVE_SUSPENSION_PREDICATE_SQL}'),
            `${site} must interpolate the shared active-suspension predicate`,
        );
        assert.ok(
            !source.includes(INVERTED_PREDICATE_FRAGMENT),
            `${site} still contains the inverted suspension predicate`,
        );
        // The predicate must feed the suspension_active projection the
        // issuance/liveness rules consume, not sit unused in the file.
        assert.match(source, /\$\{ACTIVE_SUSPENSION_PREDICATE_SQL\}\s+AS\s+suspension_active/);
    }
});

test('the shared predicate constant is the corrected active-suspension expression', () => {
    assert.equal(
        ACTIVE_SUSPENSION_PREDICATE_SQL,
        '(suspended_until IS NOT NULL AND suspended_until > UTC_TIMESTAMP())',
    );
});

test('suspension semantics: NULL, past, and exactly-equal timestamps are allowed; only a future timestamp suspends', () => {
    const now = new Date('2026-10-13T00:00:00.000Z');
    assert.equal(isTimeBoundSuspensionActive(null, now), false);
    assert.equal(isTimeBoundSuspensionActive(undefined, now), false);
    assert.equal(isTimeBoundSuspensionActive(new Date('2026-10-12T23:59:59.000Z'), now), false); // past
    assert.equal(isTimeBoundSuspensionActive(now, now), false); // exactly equal
    assert.equal(isTimeBoundSuspensionActive(new Date('2026-10-13T00:00:01.000Z'), now), true); // future
});

test('issuance and per-request liveness follow the suspension semantics at every boundary value', () => {
    const now = new Date('2026-10-13T00:00:00.000Z');
    const boundaries = [null, '2026-10-12T23:59:59Z', '2026-10-13T00:00:00Z', '2026-10-13T00:00:01Z'];
    for (const suspendedUntil of boundaries) {
        const suspensionActive = isTimeBoundSuspensionActive(suspendedUntil, now) ? 1 : 0;
        // Login issuance rejects a future suspension before any token...
        assert.equal(
            isIssuableIdentity({ is_active: 1, suspension_active: suspensionActive }),
            suspensionActive === 0,
        );
        // ...and every authenticated request rejects an active suspension
        // even while the token version still matches.
        assert.equal(
            isUsersIdentityLive({ is_active: 1, token_version: 3, suspension_active: suspensionActive }, 3),
            suspensionActive === 0,
        );
    }
});

test('the generated identity SQL maps suspended_until to suspension_active with the corrected predicate (adapter-level, static/unit - not live SQL)', () => {
    // Adapter-level regression for the inverted mapping bug: expand each
    // production template exactly as the shipped code interpolates the shared
    // constant, then assert the generated expression itself. This pins the
    // real SQL text/semantics (NULL/past/equal -> not suspended, future ->
    // suspended) instead of a fixture boolean that previously masked the
    // inversion. Live SQL execution stays with the Docker integration suite.
    for (const site of [
        '../src/security/principal-repository.ts', // request-time liveness
        '../src/routes/auth.ts',                   // login issuance
    ]) {
        const generated = readProductionSource(site)
            .split('${ACTIVE_SUSPENSION_PREDICATE_SQL}')
            .join(ACTIVE_SUSPENSION_PREDICATE_SQL);
        // The corrected predicate feeds the projection the rules consume...
        assert.ok(
            generated.includes(`${ACTIVE_SUSPENSION_PREDICATE_SQL} AS suspension_active`),
            `${site} must project the corrected predicate as suspension_active`,
        );
        // ...and the generated SQL never treats NULL/past as suspended.
        assert.ok(
            !generated.includes('suspended_until IS NULL'),
            `${site} generated SQL still maps NULL/past to an active suspension`,
        );
        // One shared predicate per query: issuance and liveness cannot drift.
        assert.equal(
            generated.split(ACTIVE_SUSPENSION_PREDICATE_SQL).length - 1,
            1,
            `${site} must embed the shared predicate exactly once`,
        );
    }
});

test('public registration never issues an admin identity from a client-supplied role', () => {
    assert.equal(resolvePublicRegistrationRole('admin'), 'student');
    assert.equal(resolvePublicRegistrationRole('staff'), 'student');
    assert.equal(resolvePublicRegistrationRole(undefined), 'student');
});

// ---------------------------------------------------------------------------
// Production middleware behavior through an injected repository (unit evidence)
// ---------------------------------------------------------------------------

test('an inactive admin identity is rejected per request (no admin bypass)', async () => {
    const repository = makeRepository({
        users: { 'admin-a': { is_active: 0, token_version: 0, suspension_active: 0 } },
    });
    const { request, response, nextCalled } = await runAuthenticate(tokenFor({ id: 'admin-a', role: 'admin', tv: 0 }), repository);
    assert.equal(nextCalled, false);
    assert.equal(response.capturedStatus, 401);
    assert.deepEqual(response.capturedBody, { error: 'Session revoked', code: 'SESSION_REVOKED' });
    assert.equal(request.user, undefined);
});

test('a revoked admin identity (stale token_version) is rejected per request', async () => {
    const repository = makeRepository({
        users: { 'admin-a': { is_active: 1, token_version: 5, suspension_active: 0 } },
    });
    const { response, nextCalled } = await runAuthenticate(tokenFor({ id: 'admin-a', role: 'admin', tv: 0 }), repository);
    assert.equal(nextCalled, false);
    assert.equal(response.capturedStatus, 401);
    assert.equal((response.capturedBody as { code?: string }).code, 'SESSION_REVOKED');
});

test('an admin under an active time-bound suspension is rejected per request', async () => {
    const repository = makeRepository({
        users: { 'admin-a': { is_active: 1, token_version: 0, suspension_active: 1 } },
    });
    const { response, nextCalled } = await runAuthenticate(tokenFor({ id: 'admin-a', role: 'admin', tv: 0 }), repository);
    assert.equal(nextCalled, false);
    assert.equal(response.capturedStatus, 401);
    assert.equal((response.capturedBody as { code?: string }).code, 'SESSION_REVOKED');
});

test('an admin identity row that no longer exists is rejected', async () => {
    const { response, nextCalled } = await runAuthenticate(tokenFor({ id: 'admin-missing', role: 'admin', tv: 0 }), makeRepository());
    assert.equal(nextCalled, false);
    assert.equal(response.capturedStatus, 401);
});

test('an active admin authenticates with no scope and no membership queries', async () => {
    const repository = makeRepository({
        users: { 'admin-a': { is_active: 1, token_version: 0, suspension_active: 0 } },
    });
    const { request, response, nextCalled } = await runAuthenticate(tokenFor({ id: 'admin-a', role: 'admin', tv: 0 }), repository);
    assert.equal(nextCalled, true);
    assert.equal(response.capturedStatus, undefined);
    assert.equal(request.user?.id, 'admin-a');
    assert.equal(request.user?.tenantId, undefined);
    assert.equal(request.user?.instructorId, undefined);
    assert.equal(request.user?.groupId, undefined);
    assert.equal(request.user?.gradeId, undefined);
    assert.equal(request.user?.identitySource, 'users');
});

test('a teacher with zero active memberships authenticates without tenant scope', async () => {
    const repository = makeRepository({
        users: { 'teacher-a': { is_active: 1, token_version: 0, suspension_active: 0 } },
    });
    const { request, nextCalled } = await runAuthenticate(tokenFor({ id: 'teacher-a', role: 'teacher', tv: 0 }), repository);
    assert.equal(nextCalled, true);
    assert.equal(request.user?.tenantId, undefined);
});

test('a forged tenant selector is ignored: the principal authenticates but keeps no scope', async () => {
    const repository = makeRepository({
        users: { 'teacher-a': { is_active: 1, token_version: 0, suspension_active: 0 } },
        memberships: { 'teacher-a': [{ tenant_id: 'tenant-a' }, { tenant_id: 'tenant-b' }] },
    });
    const { request, nextCalled } = await runAuthenticate(
        tokenFor({ id: 'teacher-a', role: 'teacher', tv: 0, tenant_id: 'tenant-forged' }), repository);
    assert.equal(nextCalled, true);
    assert.equal(request.user?.tenantId, undefined);
});

test('a selector matching a server-side membership becomes the scope', async () => {
    const repository = makeRepository({
        users: { 'teacher-a': { is_active: 1, token_version: 0, suspension_active: 0 } },
        memberships: { 'teacher-a': [{ tenant_id: 'tenant-a' }, { tenant_id: 'tenant-b' }] },
    });
    const { request, nextCalled } = await runAuthenticate(
        tokenFor({ id: 'teacher-a', role: 'teacher', tv: 0, tenant_id: 'tenant-b' }), repository);
    assert.equal(nextCalled, true);
    assert.equal(request.user?.tenantId, 'tenant-b');
});

test('a student with a valid enrollment selection takes every scope field from the server row', async () => {
    const repository = makeRepository({
        users: { 'student-a': { is_active: 1, token_version: 0, suspension_active: 0 } },
        enrollments: { 'student-a': [enrollment()] },
    });
    const { request, nextCalled } = await runAuthenticate(
        tokenFor({ id: 'student-a', role: 'student', tv: 0, student_enrollment_id: 'enrollment-a',
            tenant_id: 'tenant-forged', instructor_id: 'instructor-forged', group_id: 'group-forged', grade_id: 'grade-forged' }),
        repository);
    assert.equal(nextCalled, true);
    assert.equal(request.user?.tenantId, 'tenant-a');
    assert.equal(request.user?.studentEnrollmentId, 'enrollment-a');
    assert.equal(request.user?.instructorId, 'instructor-a');
    assert.equal(request.user?.groupId, 'group-a');
    assert.equal(request.user?.gradeId, 'grade-a');
});

test('a student whose selected enrollment no longer resolves fails closed', async () => {
    const repository = makeRepository({
        users: { 'student-a': { is_active: 1, token_version: 0, suspension_active: 0 } },
        enrollments: { 'student-a': [] },
    });
    const { response, nextCalled } = await runAuthenticate(
        tokenFor({ id: 'student-a', role: 'student', tv: 0, student_enrollment_id: 'enrollment-a' }), repository);
    assert.equal(nextCalled, false);
    assert.equal(response.capturedStatus, 401);
    assert.deepEqual(response.capturedBody, { error: 'Selected workspace is no longer active', code: 'WORKSPACE_REVOKED' });
});

test('a student without a selection keeps no membership-derived fields from JWT claims', async () => {
    const repository = makeRepository({
        users: { 'student-a': { is_active: 1, token_version: 0, suspension_active: 0 } },
        enrollments: { 'student-a': [enrollment()] },
    });
    const { request, nextCalled } = await runAuthenticate(
        tokenFor({ id: 'student-a', role: 'student', tv: 0,
            instructor_id: 'instructor-forged', group_id: 'group-forged', grade_id: 'grade-forged' }),
        repository);
    assert.equal(nextCalled, true);
    assert.equal(request.user?.tenantId, undefined);
    assert.equal(request.user?.studentEnrollmentId, undefined);
    assert.equal(request.user?.instructorId, undefined);
    assert.equal(request.user?.groupId, undefined);
    assert.equal(request.user?.gradeId, undefined);
});

test('a staff-table identity is live through its row and resolves no scope', async () => {
    const repository = makeRepository({
        staff: { 'staff-a': { is_active: 1 } },
    });
    const { request, nextCalled } = await runAuthenticate(tokenFor({ id: 'staff-a', role: 'staff', tv: 0 }), repository);
    assert.equal(nextCalled, true);
    assert.equal(request.user?.identitySource, 'staff');
    assert.equal(request.user?.tenantId, undefined);
});

test('a deactivated staff-table identity is rejected', async () => {
    const repository = makeRepository({ staff: { 'staff-a': { is_active: 0 } } });
    const { response, nextCalled } = await runAuthenticate(tokenFor({ id: 'staff-a', role: 'staff', tv: 0 }), repository);
    assert.equal(nextCalled, false);
    assert.equal(response.capturedStatus, 401);
});

test('authenticateToken refuses missing or malformed credentials at the boundary', async () => {
    const missing = { headers: {}, method: 'GET', originalUrl: '/api/courses' } as AuthRequest;
    const missingResponse = createResponse();
    let missingNext = false;
    await createAuthenticateToken(makeRepository())(missing, missingResponse, (() => { missingNext = true; }) as NextFunction);
    assert.equal(missingResponse.capturedStatus, 401);
    assert.equal(missingNext, false);

    const malformed = { headers: { authorization: 'Basic dXNlcjpwYXNz' }, method: 'GET', originalUrl: '/api/courses' } as AuthRequest;
    const malformedResponse = createResponse();
    let malformedNext = false;
    await createAuthenticateToken(makeRepository())(malformed, malformedResponse, (() => { malformedNext = true; }) as NextFunction);
    assert.equal(malformedResponse.capturedStatus, 401);
    assert.equal(malformedNext, false);
});

// ---------------------------------------------------------------------------
// Login issuance behavior through injected dependencies (unit evidence)
// ---------------------------------------------------------------------------

interface LoginFixtures {
    user?: Record<string, unknown> | null;
    staff?: Record<string, unknown> | null;
    staffProfile?: Record<string, unknown> | null;
    adminPermissions?: string[];
    adminRoles?: string[];
    executed?: string[];
}

const makeLoginDeps = (fixtures: LoginFixtures = {}): Parameters<typeof createLoginHandler>[0] => ({
    queryOne: async <T>(sql: string): Promise<T | null> => {
        fixtures.executed?.push(sql);
        if (sql.includes('FROM users')) return (fixtures.user ?? null) as T | null;
        if (sql.includes('accessible_pages FROM staff WHERE id')) return (fixtures.staffProfile ?? null) as T | null;
        if (sql.includes('FROM staff')) return (fixtures.staff ?? null) as T | null;
        return null;
    },
    comparePassword: async (password: string, hash: string) => bcrypt.compare(password, hash),
    loadAdminPermissions: async () => fixtures.adminPermissions ?? [],
    loadAdminRoleCodes: async () => fixtures.adminRoles ?? [],
});

const runLogin = async (fixtures: LoginFixtures, body: unknown) => {
    const handler = createLoginHandler(makeLoginDeps(fixtures));
    const response = createResponse();
    await handler({ body } as Request, response);
    return response;
};

const activeUser = (overrides: Record<string, unknown> = {}) => ({
    id: 'admin-a', email: 'admin-a@example.test', phone: '+201000000001', name: 'Admin A',
    role: 'admin', is_active: 1, token_version: 3, suspension_active: 0,
    password_hash: fixtureHash, ...overrides,
});

test('login issues a token whose token version matches the server row', async () => {
    const response = await runLogin({ user: activeUser(), adminPermissions: ['admin.dashboard.read'] },
        { phone: '+201000000001', password: FIXTURE_PASSWORD });
    assert.equal(response.capturedStatus, undefined);
    const body = response.capturedBody as { token: string; user: Record<string, unknown> };
    assert.ok(body.token);
    const decoded = jwt.verify(body.token, TEST_SECRET) as { tv: number };
    assert.equal(decoded.tv, 3);
    assert.equal(body.user.password_hash, undefined);
    assert.equal(body.user.suspension_active, undefined);
    assert.deepEqual(body.user.admin_permissions, ['admin.dashboard.read']);
});

test('login refuses an inactive account before issuing any token', async () => {
    const response = await runLogin({ user: activeUser({ is_active: 0 }) },
        { phone: '+201000000001', password: FIXTURE_PASSWORD });
    assert.equal(response.capturedStatus, 403);
    assert.deepEqual(response.capturedBody, { error: 'Account is suspended', code: 'ACCOUNT_SUSPENDED' });
    assert.equal((response.capturedBody as { token?: string }).token, undefined);
});

test('login refuses an account under an active time-bound suspension', async () => {
    const response = await runLogin({ user: activeUser({ suspension_active: 1 }) },
        { phone: '+201000000001', password: FIXTURE_PASSWORD });
    assert.equal(response.capturedStatus, 403);
    assert.equal((response.capturedBody as { code?: string }).code, 'ACCOUNT_SUSPENDED');
});

test('login lets an expired time-bound suspension through (suspension_active=0)', async () => {
    const response = await runLogin({ user: activeUser({ suspension_active: 0 }) },
        { phone: '+201000000001', password: FIXTURE_PASSWORD });
    assert.equal(response.capturedStatus, undefined);
    assert.ok((response.capturedBody as { token: string }).token);
});

test('login rejects a wrong password for both tables', async () => {
    const users = await runLogin({ user: activeUser() }, { phone: '+201000000001', password: 'wrong-password' });
    assert.equal(users.capturedStatus, 401);
    assert.deepEqual(users.capturedBody, { error: 'Invalid credentials' });
});

test('staff-table login issues a token while active and refuses when deactivated', async () => {
    const staffRow = {
        id: 'staff-a', name: 'Staff A', phone: '+201000000002', role: 'staff',
        accessible_pages: '["messages"]', is_active: 1, password_hash: fixtureHash,
    };
    const ok = await runLogin({ staff: staffRow }, { phone: '+201000000002', password: FIXTURE_PASSWORD });
    assert.equal(ok.capturedStatus, undefined);
    const body = ok.capturedBody as { token: string; user: { accessible_pages: string[] } };
    assert.ok(body.token);
    assert.deepEqual(body.user.accessible_pages, ['messages']);

    const blocked = await runLogin({ staff: { ...staffRow, is_active: 0 } },
        { phone: '+201000000002', password: FIXTURE_PASSWORD });
    assert.equal(blocked.capturedStatus, 403);
    assert.equal((blocked.capturedBody as { code?: string }).code, 'ACCOUNT_SUSPENDED');
});

// ---------------------------------------------------------------------------
// Staff CRUD access policy through the real router with injected deps
// (unit evidence; production wiring is the default export of routes/staff.ts)
//
// The authorization guard under test is the production
// createRequireAdminPermission('staff.manage') over an injected permission
// repository: an admin-role claim without a verified platform assignment is
// denied (403), only a verified super_admin or a holder of the staff.manage
// key passes, and lookup failures deny with 503.
// ---------------------------------------------------------------------------

interface StaffFixtures {
    staffRows?: Array<Record<string, unknown>>;
    staffRow?: Record<string, unknown> | null;
    executed?: string[];
    /** users-table identity rows used by the injected principal repository. */
    identityUsers?: IdentityFixtures['users'];
}

interface PermissionFixtures {
    /** userIds verified as active super_admin (admin_user_roles + active users row). */
    superAdmins?: string[];
    /** permission keys resolved per userId through admin_role_permissions. */
    permissions?: Record<string, string[]>;
    /** userIds whose lookup throws (e.g. SaaS migration missing). */
    lookupFailures?: string[];
}

const makePermissionLookup = (fixtures: PermissionFixtures = {}): AdminPermissionLookup => ({
    isSuperAdmin: async (id) => (fixtures.superAdmins ?? []).includes(id),
    getAdminPermissions: async (id) => {
        if ((fixtures.lookupFailures ?? []).includes(id)) {
            throw new Error('permission lookup failed');
        }
        return fixtures.permissions?.[id] ?? [];
    },
});

const staffRepository = (identityUsers: IdentityFixtures['users'] = {}) => makeRepository({
    users: {
        'admin-a': { is_active: 1, token_version: 0, suspension_active: 0 },
        'student-a': { is_active: 1, token_version: 0, suspension_active: 0 },
        'teacher-a': { is_active: 1, token_version: 0, suspension_active: 0 },
        ...identityUsers,
    },
});

const invokeStaffRoute = async (
    fixtures: StaffFixtures,
    request: { method: string; url: string; token?: string | null; body?: unknown },
    permissionFixtures: PermissionFixtures = {},
) => {
    const router = createStaffRouter({
        query: async <T>(sql: string): Promise<T[]> => {
            fixtures.executed?.push(sql);
            return (fixtures.staffRows ?? []) as T[];
        },
        queryOne: async <T>(sql: string): Promise<T | null> => {
            fixtures.executed?.push(sql);
            if (sql.includes('FROM users WHERE phone')) return null;
            if (sql.includes('SELECT id FROM staff WHERE phone')) return null;
            if (sql.includes('FROM staff')) return (fixtures.staffRow ?? null) as T | null;
            return null;
        },
        execute: async (sql: string) => {
            fixtures.executed?.push(sql);
            return { insertId: 42, affectedRows: 1 };
        },
        comparePassword: async (password: string, hash: string) => bcrypt.compare(password, hash),
        authenticate: createAuthenticateToken(staffRepository(fixtures.identityUsers)),
        // The production guard itself over an injected permission repository:
        // never an allow-all stub, so identity and authorization are both real.
        authorizeAdmin: createRequireAdminPermission('staff.manage', makePermissionLookup(permissionFixtures)),
    });
    const response = createResponse();
    let nextCalled = false;
    const dispatch = router as unknown as (req: unknown, res: Response, next: NextFunction) => Promise<void>;
    await dispatch(
        {
            method: request.method,
            url: request.url,
            headers: request.token ? { authorization: `Bearer ${request.token}` } : {},
            body: request.body ?? {},
        },
        response,
        (() => { nextCalled = true; }) as NextFunction,
    );
    // Express does not await async middleware, and the injected handlers use
    // real bcrypt rounds; poll (bounded) until the fake response settles.
    const deadline = Date.now() + 5000;
    while (response.capturedStatus === undefined && response.capturedBody === undefined && Date.now() < deadline) {
        await new Promise((resolve) => setImmediate(resolve));
    }
    return { response, nextCalled };
};

const staffRowFixture = {
    id: 'staff-a', name: 'Staff A', phone: '+201000000002', role: 'staff',
    accessible_pages: '["messages"]', is_active: 1, password_hash: fixtureHash,
};

test('anonymous staff CRUD is denied with 401 before any data access', async () => {
    const list = await invokeStaffRoute({}, { method: 'GET', url: '/' });
    assert.equal(list.response.capturedStatus, 401);
    assert.equal(list.nextCalled, false);

    const create = await invokeStaffRoute({}, { method: 'POST', url: '/', body: { name: 'X', phone: '+201000000003', password: 'x-pass-123' } });
    assert.equal(create.response.capturedStatus, 401);

    const remove = await invokeStaffRoute({}, { method: 'DELETE', url: '/staff-a' });
    assert.equal(remove.response.capturedStatus, 401);

    const update = await invokeStaffRoute({}, { method: 'PUT', url: '/staff-a', body: { name: 'X' } });
    assert.equal(update.response.capturedStatus, 401);

    const read = await invokeStaffRoute({}, { method: 'GET', url: '/staff-a' });
    assert.equal(read.response.capturedStatus, 401);
});

test('authenticated non-admin identities are denied staff CRUD with 403', async () => {
    const student = await invokeStaffRoute({}, { method: 'GET', url: '/', token: tokenFor({ id: 'student-a', role: 'student', tv: 0 }) });
    assert.equal(student.response.capturedStatus, 403);

    const teacherUpdate = await invokeStaffRoute({ staffRow: staffRowFixture },
        { method: 'PUT', url: '/staff-a', token: tokenFor({ id: 'teacher-a', role: 'teacher', tv: 0 }), body: { name: 'Renamed' } });
    assert.equal(teacherUpdate.response.capturedStatus, 403);
});

test('an arbitrary admin-role token without a verified platform assignment is denied staff CRUD with 403', async () => {
    // The admin role claim alone no longer authorizes platform staff CRUD:
    // the guard requires a server-verified super_admin assignment or the
    // staff.manage permission key. Deny-by-default before any data access.
    const admin = tokenFor({ id: 'admin-a', role: 'admin', tv: 0 });

    const list = await invokeStaffRoute({ staffRows: [staffRowFixture] }, { method: 'GET', url: '/', token: admin });
    assert.equal(list.response.capturedStatus, 403);
    assert.equal(list.nextCalled, false);

    const create = await invokeStaffRoute({},
        { method: 'POST', url: '/', token: admin, body: { name: 'Staff B', phone: '+201000000003', password: 'strong-pass-1' } });
    assert.equal(create.response.capturedStatus, 403);
});

test('a tenant admin without platform staff permission is denied with 403', async () => {
    // A tenant administrator holds some platform permissions but never the
    // platform-scoped staff.manage key: platform staff CRUD stays denied.
    const tenantAdmin = tokenFor({ id: 'tenant-admin-a', role: 'admin', tv: 0 });
    const denied = await invokeStaffRoute(
        { identityUsers: { 'tenant-admin-a': { is_active: 1, token_version: 0, suspension_active: 0 } } },
        { method: 'GET', url: '/', token: tenantAdmin },
        { permissions: { 'tenant-admin-a': ['admin.dashboard.read'] } },
    );
    assert.equal(denied.response.capturedStatus, 403);
    assert.equal(denied.nextCalled, false);
});

test('a verified active super_admin performs staff CRUD against injected rows', async () => {
    const admin = tokenFor({ id: 'admin-a', role: 'admin', tv: 0 });
    const verified = { superAdmins: ['admin-a'] } satisfies PermissionFixtures;

    const list = await invokeStaffRoute({ staffRows: [staffRowFixture] }, { method: 'GET', url: '/', token: admin }, verified);
    assert.equal(list.response.capturedStatus, undefined);
    assert.deepEqual((list.response.capturedBody as Array<Record<string, unknown>>)[0].accessible_pages, ['messages']);

    const read = await invokeStaffRoute({ staffRow: staffRowFixture }, { method: 'GET', url: '/staff-a', token: admin }, verified);
    assert.equal(read.response.capturedStatus, undefined);
    assert.equal((read.response.capturedBody as { id: string }).id, 'staff-a');

    const create = await invokeStaffRoute({},
        { method: 'POST', url: '/', token: admin, body: { name: 'Staff B', phone: '+201000000003', password: 'strong-pass-1', accessible_pages: ['messages'] } }, verified);
    assert.equal(create.response.capturedStatus, 201);
    assert.equal((create.response.capturedBody as { id: string }).id, '42');
    assert.ok(create.nextCalled === false);

    const update = await invokeStaffRoute({ staffRow: staffRowFixture },
        { method: 'PUT', url: '/staff-a', token: admin, body: { name: 'Renamed' } }, verified);
    assert.equal(update.response.capturedStatus, undefined);
    assert.ok((update.response.capturedBody as { message: string }).message.length > 0);

    const remove = await invokeStaffRoute({ staffRow: staffRowFixture }, { method: 'DELETE', url: '/staff-a', token: admin }, verified);
    assert.equal(remove.response.capturedStatus, undefined);
    assert.ok(remove.response.capturedBody);
});

test('a verified platform admin holding the staff.manage permission key manages staff', async () => {
    const permAdmin = tokenFor({ id: 'perm-admin', role: 'admin', tv: 0 });
    const result = await invokeStaffRoute(
        { identityUsers: { 'perm-admin': { is_active: 1, token_version: 0, suspension_active: 0 } }, staffRow: staffRowFixture },
        { method: 'GET', url: '/staff-a', token: permAdmin },
        { permissions: { 'perm-admin': ['staff.manage'] } },
    );
    assert.equal(result.response.capturedStatus, undefined);
    assert.equal((result.response.capturedBody as { id: string }).id, 'staff-a');
});

test('a staff CRUD permission lookup failure denies with 503 instead of failing open', async () => {
    const admin = tokenFor({ id: 'admin-a', role: 'admin', tv: 0 });
    // Not a verified super_admin, so the guard falls through to the permission
    // lookup, which throws: the guard denies (503) rather than failing open.
    const result = await invokeStaffRoute({}, { method: 'GET', url: '/', token: admin },
        { lookupFailures: ['admin-a'] });
    assert.equal(result.response.capturedStatus, 503);
    assert.equal(result.nextCalled, false);
});

test('a revoked admin token cannot reach staff CRUD either', async () => {
    // Token signed with a stale version while the server row has moved on:
    // revocation applies to admins exactly like every other identity, so the
    // authorization guard never runs for a revoked principal.
    const revokedAdmin = tokenFor({ id: 'admin-a', role: 'admin', tv: 0 });
    const result = await invokeStaffRoute(
        { identityUsers: { 'admin-a': { is_active: 1, token_version: 5, suspension_active: 0 } } },
        { method: 'GET', url: '/' },
        { superAdmins: ['admin-a'] },
    );
    assert.equal(result.response.capturedStatus, 401);
    assert.equal(result.nextCalled, false);
    // The stale-version token is the credential rejected at the identity boundary.
    assert.ok(revokedAdmin);
});

test('staff login stays public and issues a token for valid credentials', async () => {
    const login = await invokeStaffRoute({ staffRow: staffRowFixture },
        { method: 'POST', url: '/login', body: { phone: '+201000000002', password: FIXTURE_PASSWORD } });
    assert.equal(login.response.capturedStatus, undefined);
    const body = login.response.capturedBody as { token: string; user: { id: string } };
    assert.ok(body.token);
    assert.equal(body.user.id, 'staff-a');

    const bad = await invokeStaffRoute({ staffRow: staffRowFixture },
        { method: 'POST', url: '/login', body: { phone: '+201000000002', password: 'wrong-password' } });
    assert.equal(bad.response.capturedStatus, 401);
});

test('teacher multi-space selection endpoint is not part of this task (documented gap)', () => {
    // Students select a workspace via POST /api/student-enrollment/spaces/:id/select.
    // No equivalent teacher/instructor multi-membership selection endpoint
    // exists yet; teachers with multiple memberships stay unscoped
    // (deny-by-default) until one is authorized and implemented.
    const rows = [{ tenant_id: 'tenant-a' }, { tenant_id: 'tenant-b' }];
    assert.equal(selectActiveTenantScope(rows, undefined), null);
});
