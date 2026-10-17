import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import jwt from 'jsonwebtoken';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { AuthRequest, createAuthenticateToken, createOptionalAuth } from '../src/middleware/auth';
import type { PrincipalRepository } from '../src/security/principal-repository';
import {
    createMaterialsRouter,
    MaterialsDataAccess,
    MaterialsRouterDeps,
} from '../src/routes/materials';
import { tenantScopeBranchDeps } from './helpers/tenant-scope-branch-deps';

/**
 * M1 materials boundary regression suite (behavioral, hermetic).
 *
 * Drives the production materials router (`createMaterialsRouter`) through
 * injected seams: a fixture-backed SQL adapter, the REAL authentication
 * middleware (`createAuthenticateToken` / `createOptionalAuth`) over an
 * injected principal repository, a stand-in for the teaching-entitlement
 * guard, and a fixture platform-capability check. No database, network,
 * Docker, or real service is contacted; the MySQL pool in src/db.ts is never
 * created because no production query runs. db.ts runs dotenv.config() at
 * import (no .env file exists in this project - verified), loading nothing.
 *
 * Evidence classes used below, labeled per test:
 *  - behavioral: the real handler's own JS decision (status codes, denied
 *    side effects such as absent INSERT/UPDATE, rows returned to the caller);
 *  - decision-boundary (SQL text + params of the executed query): the list
 *    route's tenant/instructor scoping is applied by MySQL WHERE clauses, so
 *    hermetically we assert the exact SQL and bindings the real handler
 *    executed. Live row-level filtering remains the Docker integration
 *    suite's responsibility (NOT RUN here).
 *
 * Scope note: the teaching-entitlement gate itself lives in
 * middleware/teaching-access.ts, which is outside this task's allowedPaths.
 * The injected guard replicates only its documented authentication
 * precondition (no resolved principal -> 401); subscription/staff-page
 * entitlement checks are not exercised here and are called out as a limit.
 * The selected-tenant boundary under test is the materials router's own
 * server-derived check over `req.user.tenantId` (auth middleware +
 * security/identity-scope selectActiveTenantScope), so member-independent
 * instructors (zero, ambiguous, revoked, or forged selections) fail closed
 * and an instructor's own groups/courses in a non-selected tenant are
 * unreachable.
 */

const TEST_SECRET = 'test-only-secret-with-sufficient-length';

const originalSecret = process.env.JWT_SECRET;
before(() => { process.env.JWT_SECRET = TEST_SECRET; });
after(() => {
    if (originalSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = originalSecret;
});

// ---------------------------------------------------------------------------
// Fixtures: two tenants, each with one instructor group, plus ownerless rows.
// ---------------------------------------------------------------------------

interface CourseRow { tenant_id: string | null; instructor_id: string | null }
interface GroupRow { instructor_id: string | null; course_id: string | null }
interface MaterialRow { id: string; course_id: string; title: string; is_published: number }
interface EnrollmentRow {
    id: string; user_id: string; tenant_id: string;
    instructor_id: string | null; group_id: string | null; grade_id: string | null;
}

interface Fixtures {
    users: Record<string, { is_active: number; token_version: number; suspension_active: number }>;
    staff: Record<string, { is_active: number }>;
    instructorAccounts: Record<string, { tenant_status: string; legacy_compat: number; allowed: number }>;
    enrollments: Record<string, EnrollmentRow[]>;
    memberships: Record<string, Array<{ tenant_id: string }>>;
    students: Record<string, { group_id: string | null; grade_id: string | null }>;
    courses: Record<string, CourseRow>;
    groups: Record<string, GroupRow>;
    materials: Record<string, MaterialRow>;
    materialGroups: Array<{ material_id: string; group_id: string }>;
    platformCapabilities: string[];
}

const makeFixtures = (): Fixtures => ({
    users: {
        'instructor-a': { is_active: 1, token_version: 0, suspension_active: 0 },
        'instructor-b': { is_active: 1, token_version: 0, suspension_active: 0 },
        'instructor-x': { is_active: 1, token_version: 0, suspension_active: 0 },
        'teacher-a': { is_active: 1, token_version: 0, suspension_active: 0 },
        'teacher-b': { is_active: 1, token_version: 0, suspension_active: 0 },
        'teacher-none': { is_active: 1, token_version: 0, suspension_active: 0 },
        'staff-a': { is_active: 1, token_version: 0, suspension_active: 0 },
        'staff-b': { is_active: 1, token_version: 0, suspension_active: 0 },
        'staff-none': { is_active: 1, token_version: 0, suspension_active: 0 },
        'student-a': { is_active: 1, token_version: 0, suspension_active: 0 },
        'student-b': { is_active: 1, token_version: 0, suspension_active: 0 },
        'platform-admin': { is_active: 1, token_version: 0, suspension_active: 0 },
        'claim-admin': { is_active: 1, token_version: 0, suspension_active: 0 },
    },
    staff: {},
    instructorAccounts: {
        'instructor-a': { tenant_status: 'active', legacy_compat: 1, allowed: 1 },
        'instructor-b': { tenant_status: 'active', legacy_compat: 1, allowed: 1 },
        'instructor-x': { tenant_status: 'active', legacy_compat: 1, allowed: 1 },
    },
    enrollments: {
        'student-a': [{
            id: 'enrollment-a', user_id: 'student-a', tenant_id: 'tenant-a',
            instructor_id: 'instructor-a', group_id: 'group-a', grade_id: 'grade-a',
        }],
        'student-b': [{
            id: 'enrollment-b', user_id: 'student-b', tenant_id: 'tenant-b',
            instructor_id: 'instructor-b', group_id: 'group-b', grade_id: 'grade-b',
        }],
    },
    memberships: {
        'instructor-a': [{ tenant_id: 'tenant-a' }],
        'instructor-b': [{ tenant_id: 'tenant-b' }],
        // Multi-membership instructor: two active tenants, so any request
        // without a resolvable selected tenant is ambiguous by construction.
        'instructor-x': [{ tenant_id: 'tenant-a' }, { tenant_id: 'tenant-b' }],
        'teacher-a': [{ tenant_id: 'tenant-a' }],
        'teacher-b': [{ tenant_id: 'tenant-b' }],
        'teacher-none': [],
        'staff-a': [{ tenant_id: 'tenant-a' }],
        'staff-b': [{ tenant_id: 'tenant-b' }],
        'staff-none': [],
    },
    students: {
        'enrollment-a': { group_id: 'group-a', grade_id: 'grade-a' },
        'enrollment-b': { group_id: 'group-b', grade_id: 'grade-b' },
    },
    courses: {
        'course-a': { tenant_id: 'tenant-a', instructor_id: 'instructor-a' },
        'course-a2': { tenant_id: 'tenant-a', instructor_id: 'instructor-a' },
        'course-b': { tenant_id: 'tenant-b', instructor_id: 'instructor-b' },
        // A course the multi-membership instructor owns inside tenant B.
        'course-xb': { tenant_id: 'tenant-b', instructor_id: 'instructor-x' },
        'course-unowned': { tenant_id: null, instructor_id: null },
    },
    groups: {
        'group-a': { instructor_id: 'instructor-a', course_id: 'course-a' },
        'group-b': { instructor_id: 'instructor-b', course_id: 'course-b' },
        // instructor-x's own groups inside each membership tenant.
        'group-xa': { instructor_id: 'instructor-x', course_id: 'course-a' },
        'group-xb': { instructor_id: 'instructor-x', course_id: 'course-b' },
    },
    materials: {
        'material-a': { id: 'material-a', course_id: 'course-a', title: 'Material A', is_published: 1 },
        'material-a-ungrouped': { id: 'material-a-ungrouped', course_id: 'course-a2', title: 'Ungrouped own-tenant', is_published: 1 },
        'material-b': { id: 'material-b', course_id: 'course-b', title: 'Material B', is_published: 1 },
        'material-b-ungrouped': { id: 'material-b-ungrouped', course_id: 'course-b', title: 'Foreign ungrouped', is_published: 1 },
        'material-unowned': { id: 'material-unowned', course_id: 'course-unowned', title: 'Ownerless', is_published: 1 },
        'material-xa': { id: 'material-xa', course_id: 'course-a', title: 'Multi-membership own in tenant A', is_published: 1 },
        'material-xb': { id: 'material-xb', course_id: 'course-xb', title: 'Multi-membership own in tenant B', is_published: 1 },
    },
    materialGroups: [
        { material_id: 'material-a', group_id: 'group-a' },
        { material_id: 'material-b', group_id: 'group-b' },
        { material_id: 'material-xa', group_id: 'group-xa' },
        { material_id: 'material-xb', group_id: 'group-xb' },
    ],
    platformCapabilities: ['platform-admin'],
});

const makeRepository = (f: Fixtures): PrincipalRepository => ({
    findUsersIdentity: async (id) => f.users[id] ?? null,
    findStaffIdentity: async (id) => f.staff[id] ?? null,
    findInstructorAccount: async (id) => f.instructorAccounts[id] ?? null,
    findStudentEnrollments: async (id) => f.enrollments[id] ?? [],
    findActiveTenantMemberships: async (id) => f.memberships[id] ?? [],
});

// ---------------------------------------------------------------------------
// Fixture SQL adapter: answers the exact query shapes the router issues.
// ---------------------------------------------------------------------------

interface ExecutedStatement { sql: string; params: unknown[] }

const makeDb = (f: Fixtures, executed: ExecutedStatement[]) => {
    const materialById = (id: unknown): MaterialRow | undefined =>
        typeof id === 'string' ? f.materials[id] : undefined;

    const respond = (sql: string, params: unknown[]): unknown[] => {
        // Fragment order matters: the list SQL also contains `c.name as
        // course_name` and `WHERE cm.is_published = TRUE`, so the more
        // specific shapes are matched first.
        if (sql.includes('SELECT id, branch_id, branch_scope FROM `groups`')) {
            // Branch validation for the group links of a new material.
            const ids = params as string[];
            return ids
                .filter((id) => Boolean(f.groups[id]))
                .map((id) => ({ id, branch_id: null, branch_scope: 'tenant' }));
        }
        if (sql.includes('SELECT c.tenant_id')) {
            // denyMaterialWrite: course tenant of an existing material
            const material = materialById(params[0]);
            if (!material) return [];
            return [{ tenant_id: f.courses[material.course_id]?.tenant_id ?? null }];
        }
        if (sql.includes('INNER JOIN material_groups mg ON cm.id = mg.material_id')) {
            // GET /student/:userId list: only materials assigned to the group
            const groupId = params[params.length - 1];
            const ids = f.materialGroups.filter((mg) => mg.group_id === groupId).map((mg) => mg.material_id);
            return Object.values(f.materials).filter((m) => ids.includes(m.id));
        }
        if (sql.includes('FROM courses WHERE id = ?')) {
            const course = typeof params[0] === 'string' ? f.courses[params[0]] : undefined;
            return course ? [course] : [];
        }
        if (sql.includes('FROM students')) {
            const row = typeof params[0] === 'string' ? f.students[params[0]] : undefined;
            return row ? [{ id: params[0], ...row }] : [];
        }
        if (sql.includes('WHERE cm.is_published = TRUE')) {
            // GET / list: passthrough; scoping asserted via SQL text + params.
            return Object.values(f.materials);
        }
        if (sql.includes('c.name as course_name')) {
            // GET /:id material lookup
            const material = materialById(params[0]);
            if (!material) return [];
            return [{
                ...material,
                name: 'Course',
                subject: 'Subject',
                course_tenant_id: f.courses[material.course_id]?.tenant_id ?? null,
            }];
        }
        if (sql.includes('SELECT mg.material_id')) {
            // materialInScope: material linked to an own group whose course
            // belongs to the selected tenant (group tenant derives via course)
            const [materialId, scopeId, tenantId] = params as [string, string, string];
            const linked = f.materialGroups.some(
                (mg) => mg.material_id === materialId
                    && f.groups[mg.group_id]?.instructor_id === scopeId
                    && f.courses[f.groups[mg.group_id]?.course_id ?? '']?.tenant_id === tenantId,
            );
            return linked ? [{ material_id: materialId }] : [];
        }
        if (sql.includes('COUNT(*) AS cnt')) {
            // areGroupsInScope: every requested group must be an own group
            // whose course belongs to the selected tenant
            const [scopeId, tenantId, ...groupIds] = params as [string, string, ...string[]];
            const cnt = groupIds.filter((id) =>
                f.groups[id]?.instructor_id === scopeId
                && f.courses[f.groups[id]?.course_id ?? '']?.tenant_id === tenantId,
            ).length;
            return [{ cnt }];
        }
        if (sql.includes('SELECT 1 FROM material_groups')) {
            // student assignment check
            const [materialId, groupId] = params as [string, string];
            const assigned = f.materialGroups.some((mg) => mg.material_id === materialId && mg.group_id === groupId);
            return assigned ? [{ '1': 1 }] : [];
        }
        if (sql.includes('SELECT group_id FROM material_groups')) {
            const materialId = params[0];
            return f.materialGroups
                .filter((mg) => mg.material_id === materialId)
                .map((mg) => ({ group_id: mg.group_id }));
        }
        if (sql.includes('SELECT material_type,file_url')) {
            const material = materialById(params[0]);
            return material ? [{ material_type: 'pdf', file_url: null }] : [];
        }
        if (sql.includes('SELECT * FROM course_materials WHERE id = ?')) {
            const material = materialById(params[0]);
            return material ? [{ ...material }] : [];
        }
        if (sql.includes('is_active = TRUE')) {
            // POST group existence check
            const group = typeof params[0] === 'string' ? f.groups[params[0]] : undefined;
            return group ? [{ id: params[0] }] : [];
        }
        return [];
    };

    const query: MaterialsDataAccess['query'] = async <T>(sql: string, params: unknown[] = []) => {
        executed.push({ sql, params });
        return respond(sql, params) as T[];
    };
    const queryOne: MaterialsDataAccess['queryOne'] = async <T>(sql: string, params: unknown[] = []) => {
        executed.push({ sql, params });
        const rows = respond(sql, params);
        return (rows.length > 0 ? rows[0] : null) as T | null;
    };
    const execute: MaterialsDataAccess['execute'] = async (sql: string, params: unknown[] = []) => {
        executed.push({ sql, params });
        if (sql.includes('INSERT INTO course_materials')) {
            // Materialize the inserted row so the follow-up SELECT sees it.
            const [id, course_id, title] = params as [string, string, string];
            f.materials[id] = { id, course_id, title, is_published: 1 };
        }
        return { affectedRows: 1, insertId: 0, warningStatus: 0 } as never;
    };
    return { query, queryOne, execute };
};

/**
 * Stand-in for requireTeachingWrite('materials'): replicates only its
 * authentication precondition. Entitlement checks live in teaching-access.ts
 * (outside this task's allowedPaths) and are not exercised hermetically.
 */
const teachingWriteStandIn: RequestHandler = (req, res, next) => {
    if (!(req as AuthRequest).user) {
        (res as Response).status(401).json({ error: 'Authentication required' });
        return;
    }
    next();
};

const makeHarness = (fixtures: Fixtures = makeFixtures()) => {
    const executed: ExecutedStatement[] = [];
    const db = makeDb(fixtures, executed);
    const repository = makeRepository(fixtures);
    const deps: MaterialsRouterDeps = {
        db,
        authenticate: createAuthenticateToken(repository) as RequestHandler,
        optionalAuthenticate: createOptionalAuth(repository) as RequestHandler,
        requireTeachingWriteAccess: teachingWriteStandIn,
        hasVerifiedPlatformCapability: async (userId: string) =>
            fixtures.platformCapabilities.includes(userId),
        branchAccess: tenantScopeBranchDeps((type, id) => {
            if (type !== 'material') return null;
            const material = fixtures.materials[id];
            return material ? fixtures.courses[material.course_id]?.tenant_id ?? 'tenant-a' : 'tenant-a';
        }),
    };
    return { router: createMaterialsRouter(deps), executed, fixtures };
};

interface RouteRequest {
    method: string;
    url: string;
    token?: string | null;
    body?: unknown;
    query?: Record<string, unknown>;
}

interface CapturedResponse {
    statusCode?: number;
    body?: unknown;
    status(code: number): CapturedResponse;
    json(payload: unknown): CapturedResponse;
}

const invokeRoute = async (
    router: ReturnType<typeof createMaterialsRouter>,
    request: RouteRequest,
): Promise<CapturedResponse> => {
    const response: CapturedResponse = {
        status(code: number) { response.statusCode = code; return response; },
        json(payload: unknown) { response.body = payload; return response; },
    };
    const req = {
        method: request.method,
        url: request.url,
        originalUrl: request.url,
        headers: request.token ? { authorization: `Bearer ${request.token}` } : {},
        body: request.body ?? {},
        query: request.query ?? {},
    };
    await (router as unknown as (r: unknown, s: unknown, n: NextFunction) => Promise<void>)(req, response, () => {});
    // Express does not await async handlers; poll (bounded) until the fake
    // response settles, matching the established staff-router test pattern.
    const deadline = Date.now() + 5000;
    while (response.statusCode === undefined && response.body === undefined && Date.now() < deadline) {
        await new Promise((resolve) => setImmediate(resolve));
    }
    return response;
};

const tokenFor = (claims: Record<string, unknown>): string =>
    jwt.sign(claims, TEST_SECRET);

const INSTRUCTOR_A = tokenFor({ id: 'instructor-a', role: 'instructor', tv: 0 });
const INSTRUCTOR_B = tokenFor({ id: 'instructor-b', role: 'instructor', tv: 0 });
// Multi-membership instructor: no selection, selection A, selection B, and a
// selection whose membership was revoked after issuance.
const INSTRUCTOR_X_NO_SELECTION = tokenFor({ id: 'instructor-x', role: 'instructor', tv: 0 });
const INSTRUCTOR_X_A = tokenFor({ id: 'instructor-x', role: 'instructor', tv: 0, tenant_id: 'tenant-a' });
const INSTRUCTOR_X_B = tokenFor({ id: 'instructor-x', role: 'instructor', tv: 0, tenant_id: 'tenant-b' });
const INSTRUCTOR_X_REVOKED = tokenFor({ id: 'instructor-x', role: 'instructor', tv: 0, tenant_id: 'tenant-b' });
const TEACHER_A = tokenFor({ id: 'teacher-a', role: 'teacher', tv: 0 });
const TEACHER_B = tokenFor({ id: 'teacher-b', role: 'teacher', tv: 0 });
const TEACHER_NONE = tokenFor({ id: 'teacher-none', role: 'teacher', tv: 0 });
const STAFF_A = tokenFor({ id: 'staff-a', role: 'staff', tv: 0 });
const STAFF_B = tokenFor({ id: 'staff-b', role: 'staff', tv: 0 });
const STAFF_NONE = tokenFor({ id: 'staff-none', role: 'staff', tv: 0 });
const STUDENT_A = tokenFor({ id: 'student-a', role: 'student', tv: 0, student_enrollment_id: 'enrollment-a' });
const STUDENT_A_NO_SELECTION = tokenFor({ id: 'student-a', role: 'student', tv: 0 });
const STUDENT_B = tokenFor({ id: 'student-b', role: 'student', tv: 0, student_enrollment_id: 'enrollment-b' });
const PLATFORM_ADMIN = tokenFor({ id: 'platform-admin', role: 'admin', tv: 0 });
const CLAIM_ADMIN = tokenFor({ id: 'claim-admin', role: 'admin', tv: 0 });

const listQuery = (executed: ExecutedStatement[]) =>
    executed.find((e) => e.sql.includes('WHERE cm.is_published = TRUE'));

const assertNoWrite = (executed: ExecutedStatement[]) => {
    for (const statement of executed) {
        assert.ok(!/\bINSERT\b/i.test(statement.sql), `unexpected INSERT: ${statement.sql}`);
        assert.ok(!/\bUPDATE\b/i.test(statement.sql), `unexpected UPDATE: ${statement.sql}`);
    }
};

// ---------------------------------------------------------------------------
// Anonymous and malformed credentials (behavioral)
// ---------------------------------------------------------------------------

test('anonymous list is denied with 401 before any data access', async () => {
    const { router, executed } = makeHarness();
    const response = await invokeRoute(router, { method: 'GET', url: '/' });
    assert.equal(response.statusCode, 401);
    assert.equal(executed.length, 0);
});

test('anonymous read of a single material is denied with 401 before any data access', async () => {
    const { router, executed } = makeHarness();
    const response = await invokeRoute(router, { method: 'GET', url: '/material-a' });
    assert.equal(response.statusCode, 401);
    assert.equal(executed.length, 0);
});

test('anonymous student list is denied with 401 before any data access', async () => {
    const { router, executed } = makeHarness();
    const response = await invokeRoute(router, { method: 'GET', url: '/student/student-a' });
    assert.equal(response.statusCode, 401);
    assert.equal(executed.length, 0);
});

test('anonymous create is denied with 401 before any data access', async () => {
    const { router, executed } = makeHarness();
    const response = await invokeRoute(router, {
        method: 'POST', url: '/',
        body: { course_id: 'course-a', title: 'X', material_type: 'pdf' },
    });
    assert.equal(response.statusCode, 401);
    assert.equal(executed.length, 0);
});

test('a malformed bearer token is rejected instead of downgraded to anonymous', async () => {
    const { router, executed } = makeHarness();
    const response = await invokeRoute(router, { method: 'GET', url: '/', token: 'not-a-jwt' });
    assert.equal(response.statusCode, 401);
    assert.equal(executed.length, 0);
});

// ---------------------------------------------------------------------------
// GET / list scoping (decision-boundary: SQL text + bindings executed)
// ---------------------------------------------------------------------------

test('a tenant teacher list is scoped to the membership tenant of the resolved principal', async () => {
    const { router, executed } = makeHarness();
    const response = await invokeRoute(router, { method: 'GET', url: '/', token: TEACHER_A });
    assert.equal(response.statusCode, undefined);
    assert.ok(Array.isArray(response.body));

    const list = listQuery(executed);
    assert.ok(list, 'the list query must have been executed');
    assert.match(list.sql, /EXISTS \(SELECT 1 FROM courses c2 WHERE c2\.id = cm\.course_id AND c2\.tenant_id = \?\)/);
    assert.ok(list.params.includes('tenant-a'), 'tenant binding must be the server-derived tenant');
});

test('a teacher of tenant B never receives tenant A scoping or rows', async () => {
    const { router, executed } = makeHarness();
    const response = await invokeRoute(router, { method: 'GET', url: '/', token: TEACHER_B });
    assert.equal(response.statusCode, undefined);
    const list = listQuery(executed);
    assert.ok(list);
    assert.ok(list.params.includes('tenant-b'));
    assert.ok(!list.params.includes('tenant-a'), 'tenant A must not be bound for a tenant B principal');
});

test('an authenticated identity without any tenant scope is denied (fail closed)', async () => {
    const { router, executed } = makeHarness();
    const response = await invokeRoute(router, { method: 'GET', url: '/', token: TEACHER_NONE });
    assert.equal(response.statusCode, 403);
    assert.equal(executed.length, 0, 'no data query may run for an unscoped identity');
});

test('an admin role claim without a verified platform capability is denied (fail closed)', async () => {
    const listHarness = makeHarness();
    const list = await invokeRoute(listHarness.router, { method: 'GET', url: '/', token: CLAIM_ADMIN });
    assert.equal(list.statusCode, 403);
    assert.equal(listHarness.executed.length, 0, 'no data query may run for an unverified admin claim');

    const readHarness = makeHarness();
    const read = await invokeRoute(readHarness.router, { method: 'GET', url: '/material-a', token: CLAIM_ADMIN });
    assert.equal(read.statusCode, 404);
});

test('a verified platform admin lists across tenants without a tenant predicate', async () => {
    const { router, executed, fixtures } = makeHarness();
    const response = await invokeRoute(router, { method: 'GET', url: '/', token: PLATFORM_ADMIN });
    assert.equal(response.statusCode, undefined);
    assert.equal(Array.isArray(response.body) ? (response.body as unknown[]).length : 0, Object.keys(fixtures.materials).length);
    const list = listQuery(executed);
    assert.ok(list);
    assert.doesNotMatch(list.sql, /courses c2 WHERE c2\.id = cm\.course_id/);
});

test('instructor list visibility is bounded by the selected tenant, never by cross-tenant ownership', async () => {
    const { router, executed } = makeHarness();
    const response = await invokeRoute(router, { method: 'GET', url: '/', token: INSTRUCTOR_A });
    assert.equal(response.statusCode, undefined);

    const list = listQuery(executed);
    assert.ok(list, 'the list query must have been executed');
    // Server-derived scope: the selected tenant's courses, plus own groups
    // that belong to a course of that same tenant.
    assert.match(list.sql, /c\.tenant_id = \?/);
    assert.match(list.sql, /g2\.instructor_id = \?/);
    assert.match(list.sql, /gc2\.tenant_id = \?/);
    assert.deepEqual(list.params.slice(0, 3), ['tenant-a', 'instructor-a', 'tenant-a']);
    assert.match(list.sql, /branch_scope = 'branch'/);
    // Regression pins: the ownership clauses that ignored the selected tenant
    // (leaking an instructor's own groups/courses in other tenants) must not
    // return, and the old inert null-tenant fallback is gone.
    assert.doesNotMatch(list.sql, /OR c\.instructor_id = \?/);
    assert.doesNotMatch(list.sql, /\? IS NOT NULL AND c\.tenant_id = \?/);
});

test('instructor single-material read requires a group link; cross-tenant group owners get 404', async () => {
    const own = makeHarness();
    const okResponse = await invokeRoute(own.router, { method: 'GET', url: '/material-a', token: INSTRUCTOR_A });
    assert.equal(okResponse.statusCode, undefined);
    assert.equal((okResponse.body as { id: string }).id, 'material-a');

    const foreign = makeHarness();
    const denied = await invokeRoute(foreign.router, { method: 'GET', url: '/material-a', token: INSTRUCTOR_B });
    assert.equal(denied.statusCode, 404);
});

test('an instructor cannot read a foreign tenant material that has no group link', async () => {
    const { router } = makeHarness();
    const response = await invokeRoute(router, { method: 'GET', url: '/material-b', token: INSTRUCTOR_A });
    assert.equal(response.statusCode, 404);
});

// ---------------------------------------------------------------------------
// Instructor selected-tenant boundary (the m1-large-media-02 follow-up):
// zero/ambiguous/revoked selection and cross-tenant ownership must deny.
// ---------------------------------------------------------------------------

test('an instructor with two memberships and no selection is denied on every materials route without any query', async () => {
    const listHarness = makeHarness();
    const list = await invokeRoute(listHarness.router, { method: 'GET', url: '/', token: INSTRUCTOR_X_NO_SELECTION });
    assert.equal(list.statusCode, 403);
    assert.equal((list.body as { error: string }).error, 'Workspace access required');
    assert.equal(listHarness.executed.length, 0);

    const readHarness = makeHarness();
    const read = await invokeRoute(readHarness.router, { method: 'GET', url: '/material-xa', token: INSTRUCTOR_X_NO_SELECTION });
    assert.equal(read.statusCode, 403);
    assert.equal(readHarness.executed.length, 0);

    const createHarness = makeHarness();
    const created = await invokeRoute(createHarness.router, {
        method: 'POST', url: '/', token: INSTRUCTOR_X_NO_SELECTION,
        body: createBody('course-a', { group_ids: ['group-xa'] }),
    });
    assert.equal(created.statusCode, 403);
    assertNoWrite(createHarness.executed);

    const putHarness = makeHarness();
    const put = await invokeRoute(putHarness.router, {
        method: 'PUT', url: '/material-xa', token: INSTRUCTOR_X_NO_SELECTION, body: { title: 'X' },
    });
    assert.equal(put.statusCode, 403);
    assertNoWrite(putHarness.executed);

    const deleteHarness = makeHarness();
    const del = await invokeRoute(deleteHarness.router, {
        method: 'DELETE', url: '/material-xa', token: INSTRUCTOR_X_NO_SELECTION,
    });
    assert.equal(del.statusCode, 403);
    assertNoWrite(deleteHarness.executed);
});

test('a revoked tenant selection is denied instead of silently falling back to a membership', async () => {
    // The token still claims tenant-b, but that membership is no longer
    // active server-side, so no workspace resolves.
    const revoked = makeFixtures();
    revoked.memberships['instructor-x'] = [{ tenant_id: 'tenant-a' }];

    const readHarness = makeHarness(revoked);
    const read = await invokeRoute(readHarness.router, { method: 'GET', url: '/material-xb', token: INSTRUCTOR_X_REVOKED });
    assert.equal(read.statusCode, 403);
    assert.equal((read.body as { error: string }).error, 'Workspace access required');
    assert.equal(readHarness.executed.length, 0);

    const putHarness = makeHarness(revoked);
    const put = await invokeRoute(putHarness.router, {
        method: 'PUT', url: '/material-xb', token: INSTRUCTOR_X_REVOKED, body: { title: 'X' },
    });
    assert.equal(put.statusCode, 403);
    assertNoWrite(putHarness.executed);

    const deleteHarness = makeHarness(revoked);
    const del = await invokeRoute(deleteHarness.router, {
        method: 'DELETE', url: '/material-xb', token: INSTRUCTOR_X_REVOKED,
    });
    assert.equal(del.statusCode, 403);
    assertNoWrite(deleteHarness.executed);
});

test('a selected tenant A instructor cannot reach their own course or group in tenant B', async () => {
    // Own material in tenant B (own course, own group): both read and write
    // paths deny before returning data or mutating.
    const readHarness = makeHarness();
    const read = await invokeRoute(readHarness.router, { method: 'GET', url: '/material-xb', token: INSTRUCTOR_X_A });
    assert.equal(read.statusCode, 404);
    assert.equal(readHarness.executed.length, 1, 'only the material lookup may run; the scope query must not');
    assertNoWrite(readHarness.executed);

    const putHarness = makeHarness();
    const put = await invokeRoute(putHarness.router, {
        method: 'PUT', url: '/material-xb', token: INSTRUCTOR_X_A, body: { title: 'Hijacked' },
    });
    assert.equal(put.statusCode, 404);

    const deleteHarness = makeHarness();
    const del = await invokeRoute(deleteHarness.router, {
        method: 'DELETE', url: '/material-xb', token: INSTRUCTOR_X_A,
    });
    assert.equal(del.statusCode, 404);
    assertNoWrite([...putHarness.executed, ...deleteHarness.executed]);

    // Own course in tenant B with a valid selected-tenant group: denied at the
    // course boundary.
    const createOwnCourseHarness = makeHarness();
    const createOwnCourse = await invokeRoute(createOwnCourseHarness.router, {
        method: 'POST', url: '/', token: INSTRUCTOR_X_A,
        body: createBody('course-xb', { group_ids: ['group-xa'] }),
    });
    assert.equal(createOwnCourse.statusCode, 403);
    assert.equal((createOwnCourse.body as { error: string }).error, 'Course is outside your teaching scope');
    assertNoWrite(createOwnCourseHarness.executed);

    // Selected-tenant course with an own group in tenant B: denied at the
    // group boundary.
    const createOwnGroupHarness = makeHarness();
    const createOwnGroup = await invokeRoute(createOwnGroupHarness.router, {
        method: 'POST', url: '/', token: INSTRUCTOR_X_A,
        body: createBody('course-a', { group_ids: ['group-xb'] }),
    });
    assert.equal(createOwnGroup.statusCode, 403);
    assert.equal((createOwnGroup.body as { error: string }).error, 'يجب ربط المادة بمجموعة من مجموعاتك فقط');
    assertNoWrite(createOwnGroupHarness.executed);

    // The list query for the selected tenant A never binds tenant B.
    const listHarness = makeHarness();
    await invokeRoute(listHarness.router, { method: 'GET', url: '/', token: INSTRUCTOR_X_A });
    const list = listQuery(listHarness.executed);
    assert.ok(list);
    assert.ok(list.params.includes('tenant-a'));
    assert.ok(!list.params.includes('tenant-b'), 'tenant B must not be bound for a tenant A selection');
});

test('a multi-membership instructor reads, creates, updates, and deletes inside the selected tenant', async () => {
    // Selection A: own group and own-tenant course.
    const readA = makeHarness();
    const read = await invokeRoute(readA.router, { method: 'GET', url: '/material-xa', token: INSTRUCTOR_X_A });
    assert.equal(read.statusCode, undefined);
    assert.equal((read.body as { id: string }).id, 'material-xa');

    const createHarness = makeHarness();
    const created = await invokeRoute(createHarness.router, {
        method: 'POST', url: '/', token: INSTRUCTOR_X_A,
        body: createBody('course-a', { group_ids: ['group-xa'] }),
    });
    assert.equal(created.statusCode, 201);
    assert.ok(createHarness.executed.some((e) => e.sql.includes('INSERT INTO course_materials')));

    const putHarness = makeHarness();
    const put = await invokeRoute(putHarness.router, {
        method: 'PUT', url: '/material-xa', token: INSTRUCTOR_X_A, body: { title: 'Renamed' },
    });
    assert.equal(put.statusCode, undefined);
    assert.ok(putHarness.executed.some((e) => e.sql.includes('UPDATE course_materials')));

    const deleteHarness = makeHarness();
    const del = await invokeRoute(deleteHarness.router, {
        method: 'DELETE', url: '/material-xa', token: INSTRUCTOR_X_A,
    });
    assert.equal(del.statusCode, undefined);
    assert.ok(deleteHarness.executed.some((e) => e.sql.includes('is_published = FALSE')));

    // Selection B reaches the same instructor's own tenant-B resources.
    const readB = makeHarness();
    const readForeignSide = await invokeRoute(readB.router, { method: 'GET', url: '/material-xb', token: INSTRUCTOR_X_B });
    assert.equal(readForeignSide.statusCode, undefined);
    assert.equal((readForeignSide.body as { id: string }).id, 'material-xb');
});

// ---------------------------------------------------------------------------
// Student workspace isolation (behavioral)
// ---------------------------------------------------------------------------

test('a student without a workspace selection is denied instead of listed unscoped', async () => {
    const { router, executed } = makeHarness();
    const response = await invokeRoute(router, { method: 'GET', url: '/', token: STUDENT_A_NO_SELECTION });
    assert.equal(response.statusCode, 403);
    assert.equal(executed.length, 0);
});

test('a student list only returns materials assigned to their own group', async () => {
    const { router } = makeHarness();
    const response = await invokeRoute(router, { method: 'GET', url: '/student/student-a', token: STUDENT_A });
    assert.equal(response.statusCode, undefined);
    const ids = (response.body as Array<{ id: string }>).map((m) => m.id);
    assert.deepEqual(ids, ['material-a']);
});

test('a student cannot read another student workspace', async () => {
    const { router, executed } = makeHarness();
    const response = await invokeRoute(router, { method: 'GET', url: '/student/student-b', token: STUDENT_A });
    assert.equal(response.statusCode, 403);
    assert.equal(executed.length, 0);
});

test('a student can read a material assigned to their group and cannot read one assigned to a foreign group', async () => {
    const { router } = makeHarness();
    const own = await invokeRoute(router, { method: 'GET', url: '/material-a', token: STUDENT_A });
    assert.equal(own.statusCode, undefined);
    assert.equal((own.body as { id: string }).id, 'material-a');

    const foreign = makeHarness();
    const denied = await invokeRoute(foreign.router, { method: 'GET', url: '/material-b', token: STUDENT_A });
    assert.equal(denied.statusCode, 404);
});

// ---------------------------------------------------------------------------
// Tenant-scoped single reads and fail-closed ownerless rows (behavioral)
// ---------------------------------------------------------------------------

test('same-tenant teacher reads a material; the wrong-tenant teacher gets 404', async () => {
    const same = makeHarness();
    const ok = await invokeRoute(same.router, { method: 'GET', url: '/material-a', token: TEACHER_A });
    assert.equal(ok.statusCode, undefined);
    assert.equal((ok.body as { id: string }).id, 'material-a');

    const wrong = makeHarness();
    const denied = await invokeRoute(wrong.router, { method: 'GET', url: '/material-a', token: TEACHER_B });
    assert.equal(denied.statusCode, 404);
});

test('a material whose course has no provable tenant owner fails closed for tenant identities', async () => {
    const { router } = makeHarness();
    const response = await invokeRoute(router, { method: 'GET', url: '/material-unowned', token: TEACHER_A });
    assert.equal(response.statusCode, 404);
});

test('an unknown material id is indistinguishable from a foreign one (404)', async () => {
    const { router } = makeHarness();
    const response = await invokeRoute(router, { method: 'GET', url: '/material-missing', token: TEACHER_A });
    assert.equal(response.statusCode, 404);
});

// ---------------------------------------------------------------------------
// Create: server-derived course write scope (behavioral)
// ---------------------------------------------------------------------------

const createBody = (courseId: string, overrides: Record<string, unknown> = {}) => ({
    course_id: courseId,
    title: 'New Material',
    material_type: 'pdf',
    group_ids: ['group-a'],
    ...overrides,
});

test('an instructor cannot create a material on a foreign tenant course (no INSERT issued)', async () => {
    const { router, executed } = makeHarness();
    const response = await invokeRoute(router, { method: 'POST', url: '/', token: INSTRUCTOR_A, body: createBody('course-b') });
    assert.equal(response.statusCode, 403);
    assertNoWrite(executed);
});

test('an instructor cannot create a material on an ownerless course (fail closed, no INSERT issued)', async () => {
    const { router, executed } = makeHarness();
    const response = await invokeRoute(router, { method: 'POST', url: '/', token: INSTRUCTOR_A, body: createBody('course-unowned') });
    assert.equal(response.statusCode, 403);
    assertNoWrite(executed);
});

test('an instructor creates a material on their own course with their own groups', async () => {
    const { router, executed } = makeHarness();
    const response = await invokeRoute(router, { method: 'POST', url: '/', token: INSTRUCTOR_A, body: createBody('course-a') });
    assert.equal(response.statusCode, 201);
    assert.equal((response.body as { title: string }).title, 'New Material');
    assert.ok(executed.some((e) => e.sql.includes('INSERT INTO course_materials')), 'the INSERT must have run');
});

test('an instructor cannot attach a material to a group they do not own', async () => {
    const { router, executed } = makeHarness();
    const response = await invokeRoute(router, {
        method: 'POST', url: '/', token: INSTRUCTOR_A,
        body: createBody('course-a', { group_ids: ['group-b'] }),
    });
    assert.equal(response.statusCode, 403);
    assertNoWrite(executed);
});

test('a same-tenant teacher creates a material on a tenant course; a foreign-tenant teacher is denied', async () => {
    const ok = makeHarness();
    const created = await invokeRoute(ok.router, { method: 'POST', url: '/', token: TEACHER_A, body: createBody('course-a') });
    assert.equal(created.statusCode, 201);

    const deniedHarness = makeHarness();
    const denied = await invokeRoute(deniedHarness.router, { method: 'POST', url: '/', token: TEACHER_B, body: createBody('course-a') });
    assert.equal(denied.statusCode, 403);
    assertNoWrite(deniedHarness.executed);
});

test('a teaching identity without a tenant scope cannot create a material anywhere (fail closed)', async () => {
    const { router, executed } = makeHarness();
    const response = await invokeRoute(router, { method: 'POST', url: '/', token: TEACHER_NONE, body: createBody('course-a') });
    assert.equal(response.statusCode, 403);
    assertNoWrite(executed);
});

test('creating on an unknown course fails closed with 404 and no INSERT', async () => {
    const { router, executed } = makeHarness();
    const response = await invokeRoute(router, { method: 'POST', url: '/', token: TEACHER_A, body: createBody('course-missing') });
    assert.equal(response.statusCode, 404);
    assertNoWrite(executed);
});

test('external video links are still refused before any write', async () => {
    const { router, executed } = makeHarness();
    const response = await invokeRoute(router, {
        method: 'POST', url: '/', token: TEACHER_A,
        body: createBody('course-a', { material_type: 'video', file_url: 'https://example.com/evil.mp4' }),
    });
    assert.equal(response.statusCode, 400);
    assertNoWrite(executed);
});

// ---------------------------------------------------------------------------
// Update / delete: server-derived write ownership (behavioral)
// ---------------------------------------------------------------------------

test('a wrong-tenant teacher cannot update or delete a material (no UPDATE issued)', async () => {
    const putHarness = makeHarness();
    const put = await invokeRoute(putHarness.router, {
        method: 'PUT', url: '/material-a', token: TEACHER_B, body: { title: 'Hijacked' },
    });
    assert.equal(put.statusCode, 404);

    const deleteHarness = makeHarness();
    const del = await invokeRoute(deleteHarness.router, { method: 'DELETE', url: '/material-a', token: TEACHER_B });
    assert.equal(del.statusCode, 404);

    assertNoWrite([...putHarness.executed, ...deleteHarness.executed]);
});

test('a same-tenant teacher updates a material and the UPDATE reaches the data layer', async () => {
    const { router, executed } = makeHarness();
    const response = await invokeRoute(router, {
        method: 'PUT', url: '/material-a', token: TEACHER_A, body: { title: 'Renamed' },
    });
    assert.equal(response.statusCode, undefined);
    assert.ok(executed.some((e) => e.sql.includes('UPDATE course_materials')));
});

test('an instructor without a group link cannot update or delete a material (no UPDATE issued)', async () => {
    const putHarness = makeHarness();
    const put = await invokeRoute(putHarness.router, {
        method: 'PUT', url: '/material-a', token: INSTRUCTOR_B, body: { title: 'Hijacked' },
    });
    assert.equal(put.statusCode, 404);

    const deleteHarness = makeHarness();
    const del = await invokeRoute(deleteHarness.router, { method: 'DELETE', url: '/material-a', token: INSTRUCTOR_B });
    assert.equal(del.statusCode, 404);

    assertNoWrite([...putHarness.executed, ...deleteHarness.executed]);
});

test('an instructor updates and deletes a material linked to their own group', async () => {
    const putHarness = makeHarness();
    const put = await invokeRoute(putHarness.router, {
        method: 'PUT', url: '/material-a', token: INSTRUCTOR_A, body: { title: 'Renamed' },
    });
    assert.equal(put.statusCode, undefined);
    assert.ok(putHarness.executed.some((e) => e.sql.includes('UPDATE course_materials')));

    const deleteHarness = makeHarness();
    const del = await invokeRoute(deleteHarness.router, { method: 'DELETE', url: '/material-a', token: INSTRUCTOR_A });
    assert.equal(del.statusCode, undefined);
    assert.ok(deleteHarness.executed.some((e) => e.sql.includes('is_published = FALSE')));
});

test('updating a material whose course has no provable tenant owner fails closed (no UPDATE issued)', async () => {
    const { router, executed } = makeHarness();
    const response = await invokeRoute(router, {
        method: 'PUT', url: '/material-unowned', token: TEACHER_A, body: { title: 'X' },
    });
    assert.equal(response.statusCode, 404);
    assertNoWrite(executed);
});

test('updating an unknown material id fails closed with 404 (no UPDATE issued)', async () => {
    const { router, executed } = makeHarness();
    const response = await invokeRoute(router, {
        method: 'PUT', url: '/material-missing', token: TEACHER_A, body: { title: 'X' },
    });
    assert.equal(response.statusCode, 404);
    assertNoWrite(executed);
});

// ---------------------------------------------------------------------------
// Staff scoped paths: absent scope and foreign resources are denied
// ---------------------------------------------------------------------------

test('a same-tenant staff identity reads a material; a wrong-tenant or unscoped one is denied', async () => {
    const same = makeHarness();
    const ok = await invokeRoute(same.router, { method: 'GET', url: '/material-a', token: STAFF_A });
    assert.equal(ok.statusCode, undefined);
    assert.equal((ok.body as { id: string }).id, 'material-a');

    const wrong = makeHarness();
    const denied = await invokeRoute(wrong.router, { method: 'GET', url: '/material-a', token: STAFF_B });
    assert.equal(denied.statusCode, 404);

    const unscoped = makeHarness();
    const none = await invokeRoute(unscoped.router, { method: 'GET', url: '/material-a', token: STAFF_NONE });
    assert.equal(none.statusCode, 404);
});

test('a wrong-tenant or unscoped staff identity cannot create, update, or delete materials', async () => {
    const createWrong = makeHarness();
    const created = await invokeRoute(createWrong.router, {
        method: 'POST', url: '/', token: STAFF_B, body: createBody('course-a'),
    });
    assert.equal(created.statusCode, 403);
    assertNoWrite(createWrong.executed);

    const createNone = makeHarness();
    const createdNone = await invokeRoute(createNone.router, {
        method: 'POST', url: '/', token: STAFF_NONE, body: createBody('course-a'),
    });
    assert.equal(createdNone.statusCode, 403);
    assertNoWrite(createNone.executed);

    const putWrong = makeHarness();
    const put = await invokeRoute(putWrong.router, {
        method: 'PUT', url: '/material-a', token: STAFF_B, body: { title: 'Hijacked' },
    });
    assert.equal(put.statusCode, 404);
    assertNoWrite(putWrong.executed);

    const deleteWrong = makeHarness();
    const del = await invokeRoute(deleteWrong.router, {
        method: 'DELETE', url: '/material-a', token: STAFF_B,
    });
    assert.equal(del.statusCode, 404);
    assertNoWrite(deleteWrong.executed);
});

test('a staff list is scoped to the membership tenant of the resolved principal', async () => {
    const { router, executed } = makeHarness();
    const response = await invokeRoute(router, { method: 'GET', url: '/', token: STAFF_A });
    assert.equal(response.statusCode, undefined);
    const list = listQuery(executed);
    assert.ok(list, 'the list query must have been executed');
    assert.ok(list.params.includes('tenant-a'), 'tenant binding must be the server-derived tenant');
    assert.ok(!list.params.includes('tenant-b'));
});

// ---------------------------------------------------------------------------
// Legacy external-media endpoints stay disabled without reaching any network
// ---------------------------------------------------------------------------

test('legacy external stream endpoints stay disabled (410) without contacting any external host', async () => {
    const { router } = makeHarness();
    const stream = await invokeRoute(router, { method: 'GET', url: '/stream/drive-file-id' });
    assert.equal(stream.statusCode, 410);
    const convert = await invokeRoute(router, { method: 'POST', url: '/convert-drive-url', body: { url: 'https://drive.google.com/file/d/x/view' } });
    assert.equal(convert.statusCode, 410);
    const streamUrl = await invokeRoute(router, { method: 'POST', url: '/get-stream-url', body: { file_url: 'https://drive.google.com/file/d/x/view' } });
    assert.equal(streamUrl.statusCode, 410);
});
