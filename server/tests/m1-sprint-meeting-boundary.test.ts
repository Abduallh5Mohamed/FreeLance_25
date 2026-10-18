import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import { quietConsole, restoreConsole } from './helpers/quiet-console';

test.beforeEach(quietConsole);
test.afterEach(restoreConsole);
import jwt from 'jsonwebtoken';
import type { NextFunction, RequestHandler } from 'express';
import { createOptionalAuth } from '../src/middleware/auth';
import type { PrincipalRepository } from '../src/security/principal-repository';
import {
    createMeetingsRouter,
    MeetingsDataAccess,
    MeetingsRouterDeps,
} from '../src/routes/meetings';

/**
 * M1 sprint meeting-boundary regression suite (behavioral, hermetic).
 *
 * Drives the production meetings router (`createMeetingsRouter`) through its
 * injected seams: a fixture-backed SQL adapter, the REAL optional-auth
 * middleware (`createOptionalAuth`) over an injected principal repository,
 * and a stand-in for the server-verified platform-capability lookup. No
 * database, network, Docker, or real service is contacted; the MySQL pool in
 * src/db.ts is never created because no production query runs (db.ts only
 * runs dotenv.config() at import and there is no .env file read here).
 *
 * Evidence classes, labeled per test:
 *  - behavioral: the real handler's own JS decision (status codes, denied
 *    side effects such as an absent INSERT/UPDATE/DELETE, rows returned to
 *    the caller);
 *  - decision-boundary (SQL text + bound params): scoping applied by MySQL
 *    WHERE clauses is asserted hermetically via the exact SQL and bindings
 *    the real handler executed. Live row-level filtering remains the
 *    integration suite's responsibility (NOT RUN here).
 *
 * Scope note: the verified platform capability is a server-side lookup
 * (super_admin / seeded permission key) implemented in
 * security/admin-permissions.ts, outside this task's allowedPaths. The
 * injected stand-in replicates only its contract (returns true for the one
 * fixture super_admin, false otherwise); the SQL-backed lookup itself is not
 * exercised hermetically and is called out as a limit.
 */

const TEST_SECRET = 'test-only-secret-with-sufficient-length';

const originalSecret = process.env.JWT_SECRET;
before(() => { process.env.JWT_SECRET = TEST_SECRET; });
after(() => {
    if (originalSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = originalSecret;
});

// ---------------------------------------------------------------------------
// Fixtures: two tenants (one instructor each) plus a teacher, a staff member,
// a tenant-admin (admin role without a verified platform capability), a
// platform super_admin, and one student per tenant. Meetings: group-specific
// and grade-wide per tenant plus one inactive meeting owned by instructor-a.
// ---------------------------------------------------------------------------

interface MeetingFixture {
    id: string; title: string; description: string | null; meeting_link: string;
    meeting_type: string; meeting_password: string | null;
    grade_id: string | null; group_id: string | null; scheduled_at: string;
    duration_minutes: number; is_active: number; created_by: string | null;
}
interface GroupFixture { id: string; name: string; grade_id: string; instructor_id: string }

interface Fixtures {
    users: Record<string, { is_active: number; token_version: number; suspension_active: number }>;
    instructorAccounts: Record<string, { tenant_status: string; legacy_compat: number; allowed: number }>;
    enrollments: Record<string, Array<{
        id: string; user_id: string; tenant_id: string;
        instructor_id: string | null; group_id: string | null; grade_id: string | null;
    }>>;
    memberships: Record<string, Array<{ tenant_id: string }>>;
    groups: Record<string, GroupFixture>;
    meetings: Record<string, MeetingFixture>;
}

const makeFixtures = (): Fixtures => ({
    users: {
        'instructor-a': { is_active: 1, token_version: 0, suspension_active: 0 },
        'instructor-b': { is_active: 1, token_version: 0, suspension_active: 0 },
        'teacher-a': { is_active: 1, token_version: 0, suspension_active: 0 },
        'staff-a': { is_active: 1, token_version: 0, suspension_active: 0 },
        'student-a': { is_active: 1, token_version: 0, suspension_active: 0 },
        'student-b': { is_active: 1, token_version: 0, suspension_active: 0 },
        'tenant-admin': { is_active: 1, token_version: 0, suspension_active: 0 },
        'platform-admin': { is_active: 1, token_version: 0, suspension_active: 0 },
    },
    instructorAccounts: {
        'instructor-a': { tenant_status: 'active', legacy_compat: 1, allowed: 1 },
        'instructor-b': { tenant_status: 'active', legacy_compat: 1, allowed: 1 },
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
        'teacher-a': [{ tenant_id: 'tenant-a' }],
        'staff-a': [{ tenant_id: 'tenant-a' }],
    },
    groups: {
        'group-a': { id: 'group-a', name: 'Group A', grade_id: 'grade-a', instructor_id: 'instructor-a' },
        'group-b': { id: 'group-b', name: 'Group B', grade_id: 'grade-b', instructor_id: 'instructor-b' },
    },
    meetings: {
        'meeting-a': {
            id: 'meeting-a', title: 'Meeting A', description: null, meeting_link: 'https://meet.example/a',
            meeting_type: 'zoom', meeting_password: null, grade_id: 'grade-a', group_id: 'group-a',
            scheduled_at: '2030-01-01 10:00:00', duration_minutes: 60, is_active: 1, created_by: 'instructor-a',
        },
        'meeting-a-grade': {
            id: 'meeting-a-grade', title: 'Meeting A grade-wide', description: null, meeting_link: 'https://meet.example/ag',
            meeting_type: 'zoom', meeting_password: null, grade_id: 'grade-a', group_id: null,
            scheduled_at: '2030-01-02 10:00:00', duration_minutes: 60, is_active: 1, created_by: 'instructor-a',
        },
        'meeting-a-inactive': {
            id: 'meeting-a-inactive', title: 'Meeting A inactive', description: null, meeting_link: 'https://meet.example/ai',
            meeting_type: 'zoom', meeting_password: null, grade_id: 'grade-a', group_id: 'group-a',
            scheduled_at: '2030-01-03 10:00:00', duration_minutes: 60, is_active: 0, created_by: 'instructor-a',
        },
        'meeting-b': {
            id: 'meeting-b', title: 'Meeting B', description: null, meeting_link: 'https://meet.example/b',
            meeting_type: 'zoom', meeting_password: 'secret-b', grade_id: 'grade-b', group_id: 'group-b',
            scheduled_at: '2030-01-01 11:00:00', duration_minutes: 60, is_active: 1, created_by: 'instructor-b',
        },
        'meeting-b-grade': {
            id: 'meeting-b-grade', title: 'Meeting B grade-wide', description: null, meeting_link: 'https://meet.example/bg',
            meeting_type: 'zoom', meeting_password: null, grade_id: 'grade-b', group_id: null,
            scheduled_at: '2030-01-02 11:00:00', duration_minutes: 60, is_active: 1, created_by: 'instructor-b',
        },
    },
});

const makeRepository = (f: Fixtures): PrincipalRepository => ({
    findUsersIdentity: async (id) => {
        const row = f.users[id];
        if (!row) return null;
        return { is_active: row.is_active, token_version: row.token_version, suspension_active: row.suspension_active };
    },
    findStaffIdentity: async () => null,
    findInstructorAccount: async (id) => f.instructorAccounts[id] ?? null,
    findStudentEnrollments: async (id) => f.enrollments[id] ?? [],
    findActiveTenantMemberships: async (id) => f.memberships[id] ?? [],
});

// ---------------------------------------------------------------------------
// Fixture SQL adapter: answers the exact query shapes the router issues.
// ---------------------------------------------------------------------------

interface ExecutedStatement { sql: string; params: unknown[] }

const makeDb = (f: Fixtures, executed: ExecutedStatement[], throwOnSql?: (sql: string) => boolean) => {
    const respond = (sql: string, params: unknown[]): unknown[] => {
        if (throwOnSql?.(sql)) throw new Error('simulated database failure');

        if (sql.includes('SELECT created_by FROM online_meetings WHERE id = ?')) {
            const meeting = f.meetings[String(params[0])];
            return meeting ? [{ created_by: meeting.created_by }] : [];
        }
        if (sql.includes('SELECT UUID() as uuid')) {
            return [{ uuid: 'meeting-new' }];
        }
        if (sql.includes('SELECT id FROM `groups` WHERE id = ? AND instructor_id = ?')) {
            const group = f.groups[String(params[0])];
            return group && group.instructor_id === params[1] ? [{ id: group.id }] : [];
        }
        if (sql.includes('SELECT id, name FROM `groups` WHERE grade_id = ?')) {
            const gradeId = params[0];
            const owned = sql.includes('AND instructor_id = ?') ? params[1] : undefined;
            return Object.values(f.groups)
                .filter((g) => g.grade_id === gradeId && (owned === undefined || g.instructor_id === owned))
                .map((g) => ({ id: g.id, name: g.name }));
        }
        if (sql.includes('g.name as grade_name')) {
            const meeting = f.meetings[String(params[0])];
            if (!meeting) return [];
            const group = meeting.group_id ? f.groups[meeting.group_id] : null;
            return [{ ...meeting, grade_name: meeting.grade_id, group_name: group ? group.name : null }];
        }
        if (sql.includes('u.name as created_by_name') && sql.includes('WHERE m.id = ?')) {
            const meeting = f.meetings[String(params[0])];
            if (!meeting) return [];
            const group = meeting.group_id ? f.groups[meeting.group_id] : null;
            return [{ ...meeting, group_name: group ? group.name : null, created_by_name: 'Owner' }];
        }
        if (sql.includes('m.is_active = 1')) {
            // Student self-service list. The handler binds the caller's
            // server-derived group, grade, and instructor; the fixture
            // reproduces the SQL predicate so the returned rows are the real decision.
            const [groupId, gradeId, instructorId] = params as [string | null, string | null, string];
            return Object.values(f.meetings).filter((m) =>
                m.is_active === 1
                && m.created_by === instructorId
                && ((m.group_id != null && m.group_id === groupId)
                    || (m.group_id == null && m.grade_id === gradeId)));
        }
        if (sql.includes('ORDER BY m.scheduled_at DESC')) {
            if (sql.includes('WHERE m.created_by = ?')) {
                return Object.values(f.meetings).filter((m) => m.created_by === params[0]);
            }
            return Object.values(f.meetings);
        }
        if (sql.includes('INSERT INTO online_meetings')) {
            const [id, title, description, meeting_link, meeting_type, meeting_password, grade_id, group_id, scheduled_at, duration_minutes, created_by] =
                params as [string, string, string | null, string, string, string | null, string | null, string | null, string, number, string];
            f.meetings[id] = {
                id, title, description, meeting_link, meeting_type, meeting_password,
                grade_id, group_id, scheduled_at, duration_minutes, is_active: 1, created_by,
            };
            return [];
        }
        if (sql.includes('UPDATE online_meetings SET')) {
            const meeting = f.meetings[String(params[10])];
            if (meeting) {
                const coalesceColumns = ['title', 'description', 'meeting_link', 'meeting_type', 'grade_id', 'scheduled_at', 'duration_minutes', 'is_active'];
                const values = [params[0], params[1], params[2], params[3], params[5], params[7], params[8], params[9]];
                coalesceColumns.forEach((column, index) => {
                    if (values[index] != null) {
                        (meeting as unknown as Record<string, unknown>)[column] = values[index];
                    }
                });
                meeting.meeting_password = (params[4] as string | null) ?? null;
                meeting.group_id = (params[6] as string | null) ?? null;
            }
            return [];
        }
        if (sql.includes('DELETE FROM online_meetings WHERE id = ?')) {
            delete f.meetings[String(params[0])];
            return [];
        }
        return [];
    };

    const query: MeetingsDataAccess['query'] = async <T>(sql: string, params: unknown[] = []) => {
        executed.push({ sql, params });
        return respond(sql, params) as T[];
    };
    const queryOne: MeetingsDataAccess['queryOne'] = async <T>(sql: string, params: unknown[] = []) => {
        executed.push({ sql, params });
        const rows = respond(sql, params);
        return (rows.length > 0 ? rows[0] : null) as T | null;
    };
    const execute: MeetingsDataAccess['execute'] = async (sql: string, params: unknown[] = []) => {
        executed.push({ sql, params });
        respond(sql, params);
        return { affectedRows: 1, insertId: 0 };
    };
    return { query, queryOne, execute };
};

const makeHarness = (options: { fixtures?: Fixtures; throwOnSql?: (sql: string) => boolean } = {}) => {
    const fixtures = options.fixtures ?? makeFixtures();
    const executed: ExecutedStatement[] = [];
    const db = makeDb(fixtures, executed, options.throwOnSql);
    const repository = makeRepository(fixtures);
    const deps: MeetingsRouterDeps = {
        db,
        optionalAuthenticate: createOptionalAuth(repository) as RequestHandler,
        // Stand-in for the server-verified capability lookup: only the
        // fixture super_admin holds it; every other identity is denied.
        hasVerifiedPlatformCapability: async (userId) => userId === 'platform-admin',
    };
    return { router: createMeetingsRouter(deps), executed, fixtures };
};

interface RouteRequest {
    method: string;
    url: string;
    token?: string | null;
    body?: unknown;
}

interface CapturedResponse {
    statusCode?: number;
    body?: unknown;
    status(code: number): CapturedResponse;
    json(payload: unknown): CapturedResponse;
}

const invokeRoute = async (
    router: ReturnType<typeof createMeetingsRouter>,
    request: RouteRequest,
): Promise<CapturedResponse> => {
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
        body: request.body ?? {},
        query: {},
    };
    await (router as unknown as (r: unknown, s: unknown, n: NextFunction) => Promise<void>)(req, response, () => {});
    // Express does not await async handlers; poll (bounded) until the fake
    // response settles, matching the established lecture/materials pattern.
    const deadline = Date.now() + 5000;
    while (response.statusCode === undefined && response.body === undefined && Date.now() < deadline) {
        await new Promise((resolve) => setImmediate(resolve));
    }
    return response;
};

const tokenFor = (claims: Record<string, unknown>): string => jwt.sign(claims, TEST_SECRET);

const INSTRUCTOR_A = tokenFor({ id: 'instructor-a', role: 'instructor', tv: 0 });
const INSTRUCTOR_B = tokenFor({ id: 'instructor-b', role: 'instructor', tv: 0 });
const TEACHER_A = tokenFor({ id: 'teacher-a', role: 'teacher', tv: 0 });
const STAFF_A = tokenFor({ id: 'staff-a', role: 'staff', tv: 0 });
const TENANT_ADMIN = tokenFor({ id: 'tenant-admin', role: 'admin', tv: 0 });
const PLATFORM_ADMIN = tokenFor({ id: 'platform-admin', role: 'admin', tv: 0 });
const STUDENT_A = tokenFor({ id: 'student-a', role: 'student', tv: 0, student_enrollment_id: 'enrollment-a' });
const STUDENT_A_NO_SCOPE = tokenFor({ id: 'student-a', role: 'student', tv: 0 });

const findExecuted = (executed: ExecutedStatement[], fragment: string) =>
    executed.find((entry) => entry.sql.includes(fragment));

const assertNoWrite = (executed: ExecutedStatement[]) => {
    for (const statement of executed) {
        assert.ok(!/\bINSERT\b/i.test(statement.sql), `unexpected INSERT: ${statement.sql}`);
        assert.ok(!/\bUPDATE\b/i.test(statement.sql), `unexpected UPDATE: ${statement.sql}`);
        assert.ok(!/\bDELETE\b/i.test(statement.sql), `unexpected DELETE: ${statement.sql}`);
    }
};

// ---------------------------------------------------------------------------
// Anonymous callers are rejected before any data access.
// ---------------------------------------------------------------------------

test('anonymous GET / is denied with 401 before any query', async () => {
    const { router, executed } = makeHarness();
    const response = await invokeRoute(router, { method: 'GET', url: '/' });
    assert.equal(response.statusCode, 401);
    assert.equal(executed.length, 0);
});

test('anonymous GET /student/:id is denied with 401 before any query', async () => {
    const { router, executed } = makeHarness();
    const response = await invokeRoute(router, { method: 'GET', url: '/student/student-a' });
    assert.equal(response.statusCode, 401);
    assert.equal(executed.length, 0);
});

test('anonymous GET /:id is denied with 401 before any query', async () => {
    const { router, executed } = makeHarness();
    const response = await invokeRoute(router, { method: 'GET', url: '/meeting-a' });
    assert.equal(response.statusCode, 401);
    assert.equal(executed.length, 0);
});

test('anonymous GET /groups-by-grade/:gradeId is denied with 401', async () => {
    const { router, executed } = makeHarness();
    const response = await invokeRoute(router, { method: 'GET', url: '/groups-by-grade/grade-a' });
    assert.equal(response.statusCode, 401);
    assert.equal(executed.length, 0);
});

test('anonymous POST / is denied with 401 and performs no INSERT', async () => {
    const { router, executed } = makeHarness();
    const response = await invokeRoute(router, {
        method: 'POST', url: '/',
        body: { title: 'x', meeting_link: 'https://meet.example/x', grade_id: 'grade-a', scheduled_at: '2030-01-01 10:00:00' },
    });
    assert.equal(response.statusCode, 401);
    assertNoWrite(executed);
});

test('anonymous PUT /:id is denied with 401 and performs no UPDATE', async () => {
    const { router, executed } = makeHarness();
    const response = await invokeRoute(router, { method: 'PUT', url: '/meeting-a', body: { title: 'hijack' } });
    assert.equal(response.statusCode, 401);
    assertNoWrite(executed);
});

test('anonymous DELETE /:id is denied with 401 and performs no DELETE', async () => {
    const { router, executed } = makeHarness();
    const response = await invokeRoute(router, { method: 'DELETE', url: '/meeting-a' });
    assert.equal(response.statusCode, 401);
    assertNoWrite(executed);
});

// ---------------------------------------------------------------------------
// GET / — manager/creator scoping and verified platform capability.
// ---------------------------------------------------------------------------

test('instructor list is scoped to created_by = own id; other creators never leak', async () => {
    const { router, executed } = makeHarness();
    const response = await invokeRoute(router, { method: 'GET', url: '/', token: INSTRUCTOR_A });
    assert.equal(response.statusCode, 200);
    const body = response.body as MeetingFixture[];
    const ids = body.map((m) => m.id).sort();
    assert.deepEqual(ids, ['meeting-a', 'meeting-a-grade', 'meeting-a-inactive']);
    assert.ok(!ids.includes('meeting-b'), 'instructor A must not see instructor B meetings');
    const listQuery = findExecuted(executed, 'ORDER BY m.scheduled_at DESC');
    assert.ok(listQuery, 'list query executed');
    assert.ok(listQuery!.sql.includes('WHERE m.created_by = ?'));
    assert.deepEqual(listQuery!.params, ['instructor-a']);
});

test('teacher is treated as a meeting manager (creator-scoped)', async () => {
    const { router, executed } = makeHarness();
    const response = await invokeRoute(router, { method: 'GET', url: '/', token: TEACHER_A });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.body, []);
    const listQuery = findExecuted(executed, 'ORDER BY m.scheduled_at DESC');
    assert.deepEqual(listQuery!.params, ['teacher-a']);
});

test('staff (non-manager, no capability) is forbidden with no data access', async () => {
    const { router, executed } = makeHarness();
    const response = await invokeRoute(router, { method: 'GET', url: '/', token: STAFF_A });
    assert.equal(response.statusCode, 403);
    assert.equal(executed.length, 0);
});

test('admin-role token WITHOUT verified platform capability is forbidden', async () => {
    const { router, executed } = makeHarness();
    const response = await invokeRoute(router, { method: 'GET', url: '/', token: TENANT_ADMIN });
    assert.equal(response.statusCode, 403);
    assert.equal(executed.length, 0);
});

test('verified platform admin sees every meeting', async () => {
    const { router } = makeHarness();
    const response = await invokeRoute(router, { method: 'GET', url: '/', token: PLATFORM_ADMIN });
    assert.equal(response.statusCode, 200);
    assert.equal((response.body as MeetingFixture[]).length, 5);
});

// ---------------------------------------------------------------------------
// GET /student/:studentId — self-service, server-derived workspace only.
// ---------------------------------------------------------------------------

test('student A cannot enumerate student B meetings with a forged path id', async () => {
    const { router, executed } = makeHarness();
    const response = await invokeRoute(router, { method: 'GET', url: '/student/student-b', token: STUDENT_A });
    assert.equal(response.statusCode, 403);
    assert.equal((response.body as { error?: string }).error, 'Student workspace access required');
    assert.equal(executed.length, 0);
});

test('student A sees only its group and grade-wide meetings; SQL binds server scope', async () => {
    const { router, executed } = makeHarness();
    const response = await invokeRoute(router, { method: 'GET', url: '/student/student-a', token: STUDENT_A });
    assert.equal(response.statusCode, 200);
    const ids = (response.body as MeetingFixture[]).map((m) => m.id).sort();
    assert.deepEqual(ids, ['meeting-a', 'meeting-a-grade']);
    assert.ok(!ids.includes('meeting-a-inactive'), 'inactive meetings are hidden');
    assert.ok(!ids.includes('meeting-b'), 'other group meetings never leak');
    assert.ok(!ids.includes('meeting-b-grade'), 'other grade meetings never leak');
    const listQuery = findExecuted(executed, 'm.is_active = 1');
    assert.ok(listQuery, 'student list query executed');
    // Decision-boundary: bindings come from the server-derived workspace.
    assert.deepEqual(listQuery!.params, ['group-a', 'grade-a', 'instructor-a']);
    assert.ok(listQuery!.sql.includes('m.group_id = ? OR (m.group_id IS NULL AND m.grade_id = ?)'));
    assert.ok(listQuery!.sql.includes('AND m.created_by = ?'));
});

test('student without a live workspace selection is denied with no data access', async () => {
    const { router, executed } = makeHarness();
    const response = await invokeRoute(router, { method: 'GET', url: '/student/student-a', token: STUDENT_A_NO_SCOPE });
    assert.equal(response.statusCode, 403);
    assert.equal(executed.length, 0);
});

// ---------------------------------------------------------------------------
// GET /:id — creator ownership, student workspace, verified capability.
// ---------------------------------------------------------------------------

test('instructor B cannot read instructor A meeting by id (404, no leak)', async () => {
    const { router } = makeHarness();
    const response = await invokeRoute(router, { method: 'GET', url: '/meeting-a', token: INSTRUCTOR_B });
    assert.equal(response.statusCode, 404);
});

test('instructor A reads its own meeting by id', async () => {
    const { router } = makeHarness();
    const response = await invokeRoute(router, { method: 'GET', url: '/meeting-a', token: INSTRUCTOR_A });
    assert.equal(response.statusCode, 200);
    assert.equal((response.body as MeetingFixture).id, 'meeting-a');
});

test('student A reads a meeting targeting its own group', async () => {
    const { router } = makeHarness();
    const response = await invokeRoute(router, { method: 'GET', url: '/meeting-a', token: STUDENT_A });
    assert.equal(response.statusCode, 200);
});

test('student A is denied another group meeting by id (404)', async () => {
    const { router } = makeHarness();
    const response = await invokeRoute(router, { method: 'GET', url: '/meeting-b', token: STUDENT_A });
    assert.equal(response.statusCode, 404);
});

test('student A is denied another grade grade-wide meeting by id (404)', async () => {
    const { router } = makeHarness();
    const response = await invokeRoute(router, { method: 'GET', url: '/meeting-b-grade', token: STUDENT_A });
    assert.equal(response.statusCode, 404);
});

test('verified platform admin reads any meeting by id', async () => {
    const { router } = makeHarness();
    const response = await invokeRoute(router, { method: 'GET', url: '/meeting-b', token: PLATFORM_ADMIN });
    assert.equal(response.statusCode, 200);
});

test('admin-role token without capability cannot read a meeting by id (403)', async () => {
    const { router } = makeHarness();
    const response = await invokeRoute(router, { method: 'GET', url: '/meeting-a', token: TENANT_ADMIN });
    assert.equal(response.statusCode, 403);
});

test('unknown meeting id returns 404', async () => {
    const { router } = makeHarness();
    const response = await invokeRoute(router, { method: 'GET', url: '/does-not-exist', token: INSTRUCTOR_A });
    assert.equal(response.statusCode, 404);
});

// ---------------------------------------------------------------------------
// POST / — authorization, spoofed creator, ownership, validation.
// ---------------------------------------------------------------------------

const validCreateBody = (overrides: Record<string, unknown> = {}) => ({
    title: 'New meeting',
    description: null,
    meeting_link: 'https://meet.example/new',
    meeting_type: 'zoom',
    meeting_password: null,
    grade_id: 'grade-a',
    group_id: null,
    scheduled_at: '2030-02-01 10:00:00',
    duration_minutes: 60,
    ...overrides,
});

test('student cannot create a meeting (403, no INSERT)', async () => {
    const { router, executed } = makeHarness();
    const response = await invokeRoute(router, { method: 'POST', url: '/', token: STUDENT_A, body: validCreateBody() });
    assert.equal(response.statusCode, 403);
    assertNoWrite(executed);
});

test('spoofed created_by in the body is ignored; owner is the server-derived id', async () => {
    const { router, executed } = makeHarness();
    const response = await invokeRoute(router, {
        method: 'POST', url: '/', token: INSTRUCTOR_A,
        body: validCreateBody({ created_by: 'instructor-b' }),
    });
    assert.equal(response.statusCode, 201);
    const insert = findExecuted(executed, 'INSERT INTO online_meetings');
    assert.ok(insert, 'INSERT executed');
    assert.equal(insert!.params[10], 'instructor-a');
});

test('instructor cannot create a meeting for a group it does not own (403, no INSERT)', async () => {
    const { router, executed } = makeHarness();
    const response = await invokeRoute(router, {
        method: 'POST', url: '/', token: INSTRUCTOR_A,
        body: validCreateBody({ group_id: 'group-b' }),
    });
    assert.equal(response.statusCode, 403);
    assertNoWrite(executed);
});

test('instructor creates a meeting for its own group (201)', async () => {
    const { router, executed } = makeHarness();
    const response = await invokeRoute(router, {
        method: 'POST', url: '/', token: INSTRUCTOR_A,
        body: validCreateBody({ group_id: 'group-a' }),
    });
    assert.equal(response.statusCode, 201);
    assert.ok(findExecuted(executed, 'INSERT INTO online_meetings'));
});

test('non-http(s) meeting link is rejected before any INSERT', async () => {
    const { router, executed } = makeHarness();
    const response = await invokeRoute(router, {
        method: 'POST', url: '/', token: INSTRUCTOR_A,
        body: validCreateBody({ meeting_link: 'javascript:alert(1)' }),
    });
    assert.equal(response.statusCode, 400);
    assert.equal((response.body as { error?: string }).error, 'Invalid meeting link');
    assertNoWrite(executed);
});

test('invalid scheduled_at is rejected before any INSERT', async () => {
    const { router, executed } = makeHarness();
    const response = await invokeRoute(router, {
        method: 'POST', url: '/', token: INSTRUCTOR_A,
        body: validCreateBody({ scheduled_at: 'not-a-date' }),
    });
    assert.equal(response.statusCode, 400);
    assert.equal((response.body as { error?: string }).error, 'Invalid scheduled_at');
    assertNoWrite(executed);
});

test('missing required fields are rejected before any INSERT', async () => {
    const { router, executed } = makeHarness();
    const response = await invokeRoute(router, {
        method: 'POST', url: '/', token: INSTRUCTOR_A,
        body: validCreateBody({ grade_id: '' }),
    });
    assert.equal(response.statusCode, 400);
    assertNoWrite(executed);
});

// ---------------------------------------------------------------------------
// PUT / DELETE — creator ownership.
// ---------------------------------------------------------------------------

test('instructor B cannot update instructor A meeting (404, no UPDATE)', async () => {
    const { router, executed } = makeHarness();
    const response = await invokeRoute(router, { method: 'PUT', url: '/meeting-a', token: INSTRUCTOR_B, body: { title: 'hijack' } });
    assert.equal(response.statusCode, 404);
    assertNoWrite(executed);
});

test('instructor A updates its own meeting (200, UPDATE executed)', async () => {
    const { router, executed } = makeHarness();
    const response = await invokeRoute(router, { method: 'PUT', url: '/meeting-a', token: INSTRUCTOR_A, body: { title: 'Renamed' } });
    assert.equal(response.statusCode, 200);
    assert.ok(findExecuted(executed, 'UPDATE online_meetings SET'));
});

test('instructor B cannot delete instructor A meeting (404, no DELETE)', async () => {
    const { router, executed } = makeHarness();
    const response = await invokeRoute(router, { method: 'DELETE', url: '/meeting-a', token: INSTRUCTOR_B });
    assert.equal(response.statusCode, 404);
    assertNoWrite(executed);
});

test('instructor A deletes its own meeting (200, DELETE executed)', async () => {
    const { router, executed } = makeHarness();
    const response = await invokeRoute(router, { method: 'DELETE', url: '/meeting-a', token: INSTRUCTOR_A });
    assert.equal(response.statusCode, 200);
    assert.ok(findExecuted(executed, 'DELETE FROM online_meetings WHERE id = ?'));
});

// ---------------------------------------------------------------------------
// GET /groups-by-grade/:gradeId — instructor ownership vs platform capability.
// ---------------------------------------------------------------------------

test('instructor groups-by-grade is scoped to owned groups; SQL binds instructor', async () => {
    const { router, executed } = makeHarness();
    const response = await invokeRoute(router, { method: 'GET', url: '/groups-by-grade/grade-a', token: INSTRUCTOR_A });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.body, [{ id: 'group-a', name: 'Group A' }]);
    const groupsQuery = findExecuted(executed, 'SELECT id, name FROM `groups` WHERE grade_id = ?');
    assert.ok(groupsQuery!.sql.includes('AND instructor_id = ?'));
    assert.deepEqual(groupsQuery!.params, ['grade-a', 'instructor-a']);
});

test('platform admin groups-by-grade returns every group of the grade', async () => {
    const { router } = makeHarness();
    const response = await invokeRoute(router, { method: 'GET', url: '/groups-by-grade/grade-b', token: PLATFORM_ADMIN });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.body, [{ id: 'group-b', name: 'Group B' }]);
});

test('admin-role token without capability cannot list groups (403)', async () => {
    const { router, executed } = makeHarness();
    const response = await invokeRoute(router, { method: 'GET', url: '/groups-by-grade/grade-a', token: TENANT_ADMIN });
    assert.equal(response.statusCode, 403);
    assert.equal(executed.length, 0);
});

// ---------------------------------------------------------------------------
// Safe error handling: a data-access failure yields 500, never a partial write.
// ---------------------------------------------------------------------------

test('a list-query failure is reported as 500 without side effects', async () => {
    const { router, executed } = makeHarness({ throwOnSql: (sql) => sql.includes('ORDER BY m.scheduled_at DESC') });
    const response = await invokeRoute(router, { method: 'GET', url: '/', token: INSTRUCTOR_A });
    assert.equal(response.statusCode, 500);
    assertNoWrite(executed);
});
