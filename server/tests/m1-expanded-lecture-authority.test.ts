import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import jwt from 'jsonwebtoken';
import type { NextFunction, RequestHandler, Response } from 'express';
import { AuthRequest, createAuthenticateToken, createOptionalAuth } from '../src/middleware/auth';
import type { PrincipalRepository } from '../src/security/principal-repository';
import {
    createLectureRouter,
    LectureDataAccess,
    LectureRouterDeps,
} from '../src/routes/lectures';

/**
 * M1 expanded lecture-authority regression suite (behavioral, hermetic).
 *
 * Drives the production lectures router (`createLectureRouter`) through
 * injected seams: a fixture-backed SQL adapter, the REAL authentication
 * middleware (`createOptionalAuth` / `createAuthenticateToken`) over an
 * injected principal repository, and a stand-in for the teaching-entitlement
 * guard. No database, network, Docker, or real service is contacted; the
 * MySQL pool in src/db.ts is never created because no production query runs
 * (db.ts only runs dotenv.config() at import and there is no .env file).
 *
 * Evidence classes, labeled per test:
 *  - behavioral: the real handler's own JS decision (status codes, denied
 *    side effects such as absent INSERT/UPDATE, rows returned to the caller);
 *  - decision-boundary (SQL text + params of the executed query): the list
 *    route's instructor/published scoping is applied by MySQL WHERE clauses,
 *    so hermetically we assert the exact SQL and bindings the real handler
 *    executed. Live row-level filtering remains the Docker integration
 *    suite's responsibility (NOT RUN here).
 *
 * Scope note: the teaching-entitlement gate itself lives in
 * middleware/teaching-access.ts, outside this task's allowedPaths. The
 * injected stand-in replicates only its documented authentication
 * precondition (no resolved principal -> 401); subscription/staff-page
 * entitlement checks are not exercised here and are called out as a limit.
 */

const TEST_SECRET = 'test-only-secret-with-sufficient-length';

const originalSecret = process.env.JWT_SECRET;
before(() => { process.env.JWT_SECRET = TEST_SECRET; });
after(() => {
    if (originalSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = originalSecret;
});

// ---------------------------------------------------------------------------
// Fixtures: two tenants (one instructor each), one student per tenant, one
// platform admin. Lectures: one published per instructor plus one unpublished
// draft owned by instructor-a.
// ---------------------------------------------------------------------------

interface UsersRow { is_active: number; token_version: number; suspension_active: number; phone: string }
interface LectureRow {
    id: string; course_id: string; grade_id: string | null; group_id: string | null;
    instructor_id: string | null; title: string; video_url: string;
    price: number | null; is_free: number; is_published: number; display_order: number;
}
interface CourseRow { id: string; tenant_id: string | null; instructor_id: string | null; name?: string }

interface Fixtures {
    users: Record<string, UsersRow>;
    instructorAccounts: Record<string, { tenant_status: string; legacy_compat: number; allowed: number }>;
    enrollments: Record<string, Array<{
        id: string; user_id: string; tenant_id: string;
        instructor_id: string | null; group_id: string | null; grade_id: string | null;
    }>>;
    memberships: Record<string, Array<{ tenant_id: string }>>;
    studentsByPhone: Record<string, {
        id: string; name: string; phone: string;
        group_id: string | null; grade_id: string | null; instructor_id: string | null;
    }>;
    tenantsByOwner: Record<string, { id: string; status: string }>;
    courses: Record<string, CourseRow>;
    lectures: Record<string, LectureRow>;
    sharedLectures: Record<string, { id: string }>;
}

const makeFixtures = (): Fixtures => ({
    users: {
        'student-a': { is_active: 1, token_version: 0, suspension_active: 0, phone: '0100000001' },
        'student-b': { is_active: 1, token_version: 0, suspension_active: 0, phone: '0100000002' },
        'instructor-a': { is_active: 1, token_version: 0, suspension_active: 0, phone: '0100000011' },
        'instructor-b': { is_active: 1, token_version: 0, suspension_active: 0, phone: '0100000012' },
        'platform-admin': { is_active: 1, token_version: 0, suspension_active: 0, phone: '0100000099' },
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
    },
    studentsByPhone: {
        '0100000001': {
            id: 'enrollment-a', name: 'Student A', phone: '0100000001',
            group_id: 'group-a', grade_id: 'grade-a', instructor_id: 'instructor-a',
        },
        '0100000002': {
            id: 'enrollment-b', name: 'Student B', phone: '0100000002',
            group_id: 'group-b', grade_id: 'grade-b', instructor_id: 'instructor-b',
        },
    },
    tenantsByOwner: {
        'instructor-a': { id: 'tenant-a', status: 'active' },
        'instructor-b': { id: 'tenant-b', status: 'active' },
    },
    courses: {
        'course-a': { id: 'course-a', tenant_id: 'tenant-a', instructor_id: 'instructor-a' },
        'course-b': { id: 'course-b', tenant_id: 'tenant-b', instructor_id: 'instructor-b' },
        'course-legacy': { id: 'course-legacy', tenant_id: null, instructor_id: null },
    },
    lectures: {
        'lecture-a-pub': {
            id: 'lecture-a-pub', course_id: 'course-a', grade_id: 'grade-a', group_id: 'group-a',
            instructor_id: 'instructor-a', title: 'Lecture A public', video_url: 'video://video-a',
            price: 10, is_free: 0, is_published: 1, display_order: 0,
        },
        'lecture-a-draft': {
            id: 'lecture-a-draft', course_id: 'course-a', grade_id: 'grade-a', group_id: 'group-a',
            instructor_id: 'instructor-a', title: 'Lecture A draft', video_url: 'video://video-a-draft',
            price: 10, is_free: 0, is_published: 0, display_order: 1,
        },
        'lecture-b-pub': {
            id: 'lecture-b-pub', course_id: 'course-b', grade_id: 'grade-b', group_id: 'group-b',
            instructor_id: 'instructor-b', title: 'Lecture B public', video_url: 'video://video-b',
            price: 20, is_free: 0, is_published: 1, display_order: 0,
        },
    },
    sharedLectures: {},
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
    const lectureById = (id: unknown): LectureRow | undefined =>
        typeof id === 'string' ? f.lectures[id] : undefined;

    const respond = (sql: string, params: unknown[]): unknown[] => {
        // Fragment order matters: more specific shapes are matched first.
        if (throwOnSql?.(sql)) throw new Error('simulated database failure');

        if (sql.includes('SELECT id, phone, role FROM users WHERE id = ?')) {
            const row = f.users[String(params[0])];
            return row ? [{ id: params[0], phone: row.phone, role: 'student' }] : [];
        }
        if (sql.includes('FROM students WHERE phone = ?')) {
            const row = f.studentsByPhone[String(params[0])];
            return row ? [{ ...row }] : [];
        }
        if (sql.includes('FROM instructor_shared_lectures WHERE lecture_id=?')) {
            const row = f.sharedLectures[String(params[0])];
            return row ? [row] : [];
        }
        if (sql.includes('sl.lecture_id=l.id')) {
            // GET /student/:userId list. The real WHERE (published + own
            // instructor + grade/group audience + explicit shares) is applied
            // by MySQL; the fixture reproduces the published/own-instructor
            // part from the bound params so the handler's scoping bindings
            // are observable. Row-level audience filtering is asserted via
            // the SQL text/params below (integration territory).
            const [instructorId, gradeId, groupId] = params as [string | null, string | null, string | null];
            return Object.values(f.lectures).filter((l) =>
                l.is_published === 1
                && (l.instructor_id === null || l.instructor_id === instructorId)
                && (l.grade_id === gradeId || l.group_id === groupId));
        }
        if (sql.includes('FROM lectures l') && sql.includes('WHERE l.id = ?')) {
            // GET /:id single lookup with joined names.
            const lecture = lectureById(params[0]);
            if (!lecture) return [];
            return [{ ...lecture, course_name: 'Course', course_subject: 'Subject', grade_name: 'Grade', group_name: 'Group' }];
        }
        if (sql.includes('FROM lectures l')) {
            // GET / list (published-only base filter; instructor scoping is
            // appended by the handler and asserted via SQL text/params).
            return Object.values(f.lectures).filter((l) => l.is_published === 1);
        }
        if (sql.includes('SELECT id FROM courses WHERE id = ? AND tenant_id = ?')) {
            const course = f.courses[String(params[0])];
            return course && course.tenant_id === params[1] ? [course] : [];
        }
        if (sql.includes('FROM tenants WHERE owner_user_id=?')) {
            const tenant = f.tenantsByOwner[String(params[0])];
            return tenant ? [tenant] : [];
        }
        if (sql.includes('FROM courses WHERE name=?')) {
            // Mirror the real predicate (name AND instructor_id AND tenant_id):
            // fixture courses carry no name, so no default course is found
            // until the handler's INSERT INTO courses creates one.
            return Object.values(f.courses).filter(
                (c) => c.name === params[0] && c.instructor_id === (params[1] ?? null) && c.tenant_id === (params[2] ?? null)
            );
        }
        if (sql.includes('INSERT INTO courses')) {
            const [id, tenantId, instructorId, name] = params as [string, string | null, string | null, string];
            f.courses[id] = { id, tenant_id: tenantId, instructor_id: instructorId, name } as CourseRow & { name?: string };
            return [];
        }
        if (sql.includes('INSERT INTO lectures')) {
            const [id, course_id, grade_id, group_id, instructor_id, title, , video_url, , price, display_order, is_free, is_published] =
                params as [string, string, string | null, string | null, string | null, string, null, string, null, number | null, number, number, number];
            f.lectures[id] = {
                id, course_id, grade_id, group_id, instructor_id, title, video_url,
                price, display_order, is_free, is_published,
            };
            return [];
        }
        if (sql.includes('SELECT video_url FROM lectures WHERE id=?')) {
            const lecture = lectureById(params[0]);
            return lecture ? [{ video_url: lecture.video_url }] : [];
        }
        if (sql.includes('SELECT id, instructor_id FROM lectures WHERE id = ?')) {
            const lecture = lectureById(params[0]);
            return lecture ? [{ id: lecture.id, instructor_id: lecture.instructor_id }] : [];
        }
        if (sql.includes('SELECT * FROM lectures WHERE id = ?')) {
            const lecture = lectureById(params[0]);
            return lecture ? [{ ...lecture }] : [];
        }
        if (sql.includes('UPDATE lectures') && sql.includes('COALESCE(?, title)')) {
            // PUT: materialize the COALESCE update (only non-null bindings
            // change the row), then report one affected row.
            const lecture = lectureById(params[8]);
            if (lecture) {
                const values = params.slice(0, 8) as Array<unknown>;
                const columns = ['title', 'description', 'video_url', 'duration_minutes', 'price', 'display_order', 'is_free', 'is_published'];
                columns.forEach((column, index) => {
                    if (values[index] != null) {
                        (lecture as unknown as Record<string, unknown>)[column] = values[index];
                    }
                });
            }
            return [];
        }
        if (sql.includes('UPDATE lectures SET is_published = FALSE')) {
            const lecture = lectureById(params[0]);
            if (lecture) lecture.is_published = 0;
            return [];
        }
        return [];
    };

    const query: LectureDataAccess['query'] = async <T>(sql: string, params: unknown[] = []) => {
        executed.push({ sql, params });
        return respond(sql, params) as T[];
    };
    const queryOne: LectureDataAccess['queryOne'] = async <T>(sql: string, params: unknown[] = []) => {
        executed.push({ sql, params });
        const rows = respond(sql, params);
        return (rows.length > 0 ? rows[0] : null) as T | null;
    };
    const execute: LectureDataAccess['execute'] = async (sql: string, params: unknown[] = []) => {
        executed.push({ sql, params });
        respond(sql, params);
        return { affectedRows: 1, insertId: 0 };
    };
    return { query, queryOne, execute };
};

/**
 * Stand-in for requireTeachingWrite('lectures'): replicates only its
 * authentication precondition. Entitlement checks live in
 * teaching-access.ts (outside this task's allowedPaths) and are not
 * exercised hermetically.
 */
const teachingWriteStandIn: RequestHandler = (req, res, next) => {
    if (!(req as AuthRequest).user) {
        (res as Response).status(401).json({ error: 'Authentication required' });
        return;
    }
    next();
};

const makeHarness = (options: { fixtures?: Fixtures; throwOnSql?: (sql: string) => boolean } = {}) => {
    const fixtures = options.fixtures ?? makeFixtures();
    const executed: ExecutedStatement[] = [];
    const db = makeDb(fixtures, executed, options.throwOnSql);
    const repository = makeRepository(fixtures);
    const deps: LectureRouterDeps = {
        db,
        optionalAuthenticate: createOptionalAuth(repository) as RequestHandler,
        authenticate: createAuthenticateToken(repository) as RequestHandler,
        requireTeachingWriteAccess: teachingWriteStandIn,
    };
    return { router: createLectureRouter(deps), executed, fixtures };
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
    router: ReturnType<typeof createLectureRouter>,
    request: RouteRequest,
): Promise<CapturedResponse> => {
    const response: CapturedResponse = {
        status(code: number) { response.statusCode = code; return response; },
        json(payload: unknown) {
            // Express sends the current status (default 200) with json().
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
    // response settles, matching the established materials test pattern.
    const deadline = Date.now() + 5000;
    while (response.statusCode === undefined && response.body === undefined && Date.now() < deadline) {
        await new Promise((resolve) => setImmediate(resolve));
    }
    return response;
};

const tokenFor = (claims: Record<string, unknown>): string =>
    jwt.sign(claims, TEST_SECRET);

const STUDENT_A = tokenFor({ id: 'student-a', role: 'student', tv: 0, student_enrollment_id: 'enrollment-a' });
const STUDENT_B = tokenFor({ id: 'student-b', role: 'student', tv: 0, student_enrollment_id: 'enrollment-b' });
const INSTRUCTOR_A = tokenFor({ id: 'instructor-a', role: 'instructor', tv: 0 });
const INSTRUCTOR_B = tokenFor({ id: 'instructor-b', role: 'instructor', tv: 0 });
const PLATFORM_ADMIN = tokenFor({ id: 'platform-admin', role: 'admin', tv: 0 });
// instructor-a as an active member of tenant-b (a tenant they do not own),
// selected explicitly via the tenant_id claim.
const INSTRUCTOR_A_IN_TENANT_B = tokenFor({ id: 'instructor-a', role: 'instructor', tv: 0, tenant_id: 'tenant-b' });

/**
 * instructor-a becomes an active member of BOTH tenant-a (owned) and tenant-b
 * (not owned) so the selected-tenant scoping can be exercised: a single
 * membership would auto-select tenant-a, hiding the arbitrary-tenant bug that
 * used `tenants WHERE owner_user_id=? LIMIT 1`.
 */
const makeMultiTenantFixtures = (): Fixtures => {
    const f = makeFixtures();
    f.memberships['instructor-a'] = [{ tenant_id: 'tenant-a' }, { tenant_id: 'tenant-b' }];
    return f;
};

const assertNoWrite = (executed: ExecutedStatement[]) => {
    for (const statement of executed) {
        assert.ok(!/\bINSERT\b/i.test(statement.sql), `unexpected INSERT: ${statement.sql}`);
        assert.ok(!/\bUPDATE\b/i.test(statement.sql), `unexpected UPDATE: ${statement.sql}`);
    }
};

// ---------------------------------------------------------------------------
// GET /student/:userId — student visibility and forged identifiers
// ---------------------------------------------------------------------------

test('anonymous student lecture list is denied with 401 before any data access', async () => {
    const { router, executed } = makeHarness();
    const response = await invokeRoute(router, { method: 'GET', url: '/student/student-a' });
    assert.equal(response.statusCode, 401);
    assert.equal(executed.length, 0);
});

test('student A cannot enumerate student B lectures with a forged userId', async () => {
    const { router, executed } = makeHarness();
    const response = await invokeRoute(router, { method: 'GET', url: '/student/student-b', token: STUDENT_A });
    assert.equal(response.statusCode, 403);
    assert.equal((response.body as { error?: string }).error, 'Student workspace access required');
    assert.equal(executed.length, 0);
});

test('student A reads its own lectures; SQL binds its server-derived audience', async () => {
    const { router, executed } = makeHarness();
    const response = await invokeRoute(router, { method: 'GET', url: '/student/student-a', token: STUDENT_A });
    assert.equal(response.statusCode, 200);
    const body = response.body as LectureRow[];
    assert.equal(body.length, 1);
    assert.equal(body[0].id, 'lecture-a-pub');
    const listQuery = executed.find((e) => e.sql.includes('sl.lecture_id=l.id'));
    assert.ok(listQuery, 'student lecture list query was executed');
    // Decision-boundary: the handler binds the student's own instructor and
    // audience ids (from server-side rows), never a client-supplied scope.
    assert.deepEqual(listQuery!.params.slice(0, 3), ['instructor-a', 'grade-a', 'group-a']);
    assert.ok(listQuery!.sql.includes('l.is_published=TRUE'), 'published filter stays in SQL');
});

test('student A may use the client enrollment-id form of its own identifier (locked pre-existing behavior)', async () => {
    // The student UI sends user.student_id (the students.id) when set; the
    // route resolves the workspace by users.id, so this form has always
    // returned an empty list. The fix must keep that read contract intact
    // while still treating the enrollment id as the caller itself.
    const { router, executed } = makeHarness();
    const response = await invokeRoute(router, { method: 'GET', url: '/student/enrollment-a', token: STUDENT_A });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.body, []);
    assert.ok(executed.some((e) => e.sql.includes('FROM users WHERE id = ?')));
});

test('an instructor cannot read a student lecture list through the student route', async () => {
    const { router, executed } = makeHarness();
    const response = await invokeRoute(router, { method: 'GET', url: '/student/student-a', token: INSTRUCTOR_A });
    assert.equal(response.statusCode, 403);
    assert.equal(executed.length, 0);
});

// ---------------------------------------------------------------------------
// GET /:id — publication state and private source leakage
// ---------------------------------------------------------------------------

test('anonymous read of an unpublished lecture is 404 (no draft or video_url leak)', async () => {
    const { router } = makeHarness();
    const response = await invokeRoute(router, { method: 'GET', url: '/lecture-a-draft' });
    assert.equal(response.statusCode, 404);
    assert.equal((response.body as { error?: string }).error, 'Lecture not found');
    assert.ok(!JSON.stringify(response.body ?? {}).includes('video://'), 'no private video source in response');
});

test('student read of another tenant draft is 404', async () => {
    const { router } = makeHarness();
    const response = await invokeRoute(router, { method: 'GET', url: '/lecture-a-draft', token: STUDENT_B });
    assert.equal(response.statusCode, 404);
});

test('anonymous read of a published lecture stays 200 (public marketplace contract)', async () => {
    const { router } = makeHarness();
    const response = await invokeRoute(router, { method: 'GET', url: '/lecture-a-pub' });
    assert.equal(response.statusCode, 200);
    const body = response.body as LectureRow;
    assert.equal(body.id, 'lecture-a-pub');
    assert.equal(body.video_url, 'video://video-a');
});

test('owning instructor still reads its own draft', async () => {
    const { router } = makeHarness();
    const response = await invokeRoute(router, { method: 'GET', url: '/lecture-a-draft', token: INSTRUCTOR_A });
    assert.equal(response.statusCode, 200);
    assert.equal((response.body as LectureRow).id, 'lecture-a-draft');
});

test('instructor B cannot read instructor A published lecture (cross-instructor isolation)', async () => {
    const { router } = makeHarness();
    const response = await invokeRoute(router, { method: 'GET', url: '/lecture-a-pub', token: INSTRUCTOR_B });
    assert.equal(response.statusCode, 404);
});

test('platform admin cannot read another instructor draft via role alone (bare-admin deny)', async () => {
    // The previous handler granted any `role === 'admin'` token cross-tenant
    // draft access, leaking private video sources. Access now requires the
    // server-verified owning instructor scope; a bare platform admin without
    // ownership receives the same 404 as any other caller (fail closed).
    const { router } = makeHarness();
    const response = await invokeRoute(router, { method: 'GET', url: '/lecture-a-draft', token: PLATFORM_ADMIN });
    assert.equal(response.statusCode, 404);
    assert.equal((response.body as { error?: string }).error, 'Lecture not found');
    assert.ok(!JSON.stringify(response.body ?? {}).includes('video://'), 'no private video source in response');
});

// ---------------------------------------------------------------------------
// POST / — create-path ownership (forged course identifiers)
// ---------------------------------------------------------------------------

const validLectureBody = (overrides: Record<string, unknown> = {}) => ({
    title: 'New lecture',
    video_url: 'video://new-video',
    price: 10,
    ...overrides,
});

test('instructor create with a foreign-tenant course_id is 403 with no write executed', async () => {
    const { router, executed } = makeHarness();
    const response = await invokeRoute(router, {
        method: 'POST', url: '/', token: INSTRUCTOR_A,
        body: validLectureBody({ course_id: 'course-b' }),
    });
    assert.equal(response.statusCode, 403);
    assert.equal((response.body as { error?: string }).error, 'Course not found in your workspace');
    assertNoWrite(executed);
});

test('instructor create with a legacy ownerless course_id is 403 (fail closed)', async () => {
    const { router, executed } = makeHarness();
    const response = await invokeRoute(router, {
        method: 'POST', url: '/', token: INSTRUCTOR_A,
        body: validLectureBody({ course_id: 'course-legacy' }),
    });
    assert.equal(response.statusCode, 403);
    assertNoWrite(executed);
});

test('instructor create with its own course succeeds and binds its own instructor id', async () => {
    const { router, executed } = makeHarness();
    const response = await invokeRoute(router, {
        method: 'POST', url: '/', token: INSTRUCTOR_A,
        body: validLectureBody({ course_id: 'course-a', grade_id: 'grade-a', group_id: 'group-a' }),
    });
    assert.equal(response.statusCode, 201);
    const body = response.body as LectureRow;
    assert.equal(body.instructor_id, 'instructor-a');
    assert.equal(body.price, 10);
    const insert = executed.find((e) => e.sql.includes('INSERT INTO lectures'));
    assert.ok(insert, 'lecture INSERT executed');
    assert.equal(insert!.params[1], 'course-a');
    assert.equal(insert!.params[4], 'instructor-a');
});

test('instructor create without a positive price is rejected with 400', async () => {
    const { router, executed } = makeHarness();
    const response = await invokeRoute(router, {
        method: 'POST', url: '/', token: INSTRUCTOR_A,
        body: validLectureBody({ course_id: 'course-a', price: 0 }),
    });
    assert.equal(response.statusCode, 400);
    assertNoWrite(executed);
});

test('instructor create with the default course path succeeds (no course_id)', async () => {
    const { router, executed } = makeHarness();
    const response = await invokeRoute(router, {
        method: 'POST', url: '/', token: INSTRUCTOR_A,
        body: validLectureBody(),
    });
    assert.equal(response.statusCode, 201);
    const body = response.body as LectureRow;
    assert.equal(body.instructor_id, 'instructor-a');
    const courseInsert = executed.find((e) => e.sql.includes('INSERT INTO courses'));
    assert.ok(courseInsert, 'default course created');
    assert.equal(courseInsert!.params[1], 'tenant-a');
    assert.equal(courseInsert!.params[2], 'instructor-a');
});

test('platform admin create keeps the pre-existing platform-wide course path', async () => {
    const { router } = makeHarness();
    const response = await invokeRoute(router, {
        method: 'POST', url: '/', token: PLATFORM_ADMIN,
        body: validLectureBody({ course_id: 'course-b' }),
    });
    assert.equal(response.statusCode, 201);
});

test('anonymous create is denied with 401 before any data access', async () => {
    const { router, executed } = makeHarness();
    const response = await invokeRoute(router, { method: 'POST', url: '/', body: validLectureBody() });
    assert.equal(response.statusCode, 401);
    assert.equal(executed.length, 0);
});

test('instructor create with a course that does not resolve to the selected tenant is denied (wrong course deny)', async () => {
    // The precise selected-tenant course check rejects any course_id that does
    // not map to the instructor's explicitly selected active tenant.
    const { router, executed } = makeHarness();
    const response = await invokeRoute(router, {
        method: 'POST', url: '/', token: INSTRUCTOR_A,
        body: validLectureBody({ course_id: 'course-does-not-exist' }),
    });
    assert.equal(response.statusCode, 403);
    assert.equal((response.body as { error?: string }).error, 'Course not found in your workspace');
    assertNoWrite(executed);
});

test('instructor create in another tenant is denied even when the grade matches (same-grade cross-tenant deny)', async () => {
    // Cross-tenant isolation is enforced by the selected tenant, not by the
    // lecture's grade: instructor-a (tenant-a) may not bind a lecture to
    // course-b (tenant-b) even though it targets the same grade-a.
    const { router, executed } = makeHarness();
    const response = await invokeRoute(router, {
        method: 'POST', url: '/', token: INSTRUCTOR_A,
        body: validLectureBody({ course_id: 'course-b', grade_id: 'grade-a', group_id: 'group-a' }),
    });
    assert.equal(response.statusCode, 403);
    assert.equal((response.body as { error?: string }).error, 'Course not found in your workspace');
    assertNoWrite(executed);
});

test('multi-tenant instructor may create under a course in their selected (non-owned) tenant', async () => {
    // The old check used `tenants WHERE owner_user_id=? LIMIT 1`, which pinned
    // instructor-a to owned tenant-a and denied course-b (tenant-b) even though
    // instructor-a is an active member there. The selected-tenant check (from
    // the auth middleware) resolves course-b correctly under tenant-b.
    const { router, executed } = makeHarness({ fixtures: makeMultiTenantFixtures() });
    const response = await invokeRoute(router, {
        method: 'POST', url: '/', token: INSTRUCTOR_A_IN_TENANT_B,
        body: validLectureBody({ course_id: 'course-b', grade_id: 'grade-b', group_id: 'group-b' }),
    });
    assert.equal(response.statusCode, 201);
    const body = response.body as LectureRow;
    assert.equal(body.instructor_id, 'instructor-a');
    assert.equal(body.course_id, 'course-b');
    const insert = executed.find((e) => e.sql.includes('INSERT INTO lectures'));
    assert.ok(insert, 'lecture INSERT executed');
    assert.equal(insert!.params[1], 'course-b');
    assert.equal(insert!.params[4], 'instructor-a');
});

test('instructor with multiple memberships but no selected tenant fails closed (no arbitrary owner-tenant pick)', async () => {
    // With two active memberships and no tenant selector, the auth middleware
    // resolves no tenant scope (deny-by-default). The create path must not
    // fall back to an arbitrary first-owned tenant; it fails closed instead.
    const { router, executed } = makeHarness({ fixtures: makeMultiTenantFixtures() });
    const response = await invokeRoute(router, {
        method: 'POST', url: '/', token: INSTRUCTOR_A,
        body: validLectureBody(),
    });
    assert.equal(response.statusCode, 403);
    assert.equal((response.body as { error?: string }).error, 'Course not found in your workspace');
    assertNoWrite(executed);
});

// ---------------------------------------------------------------------------
// PUT/DELETE — mutation isolation and update behavior
// ---------------------------------------------------------------------------

test('instructor B update of instructor A lecture is 404 with no UPDATE executed', async () => {
    const { router, executed } = makeHarness();
    const response = await invokeRoute(router, {
        method: 'PUT', url: '/lecture-a-pub', token: INSTRUCTOR_B,
        body: { title: 'Hijacked' },
    });
    assert.equal(response.statusCode, 404);
    assertNoWrite(executed);
});

test('instructor B delete of instructor A lecture is 404 with no UPDATE executed', async () => {
    const { router, executed } = makeHarness();
    const response = await invokeRoute(router, {
        method: 'DELETE', url: '/lecture-a-pub', token: INSTRUCTOR_B,
    });
    assert.equal(response.statusCode, 404);
    assertNoWrite(executed);
});

test('owner update changes the lecture and preserves unspecified fields', async () => {
    const { router } = makeHarness();
    const response = await invokeRoute(router, {
        method: 'PUT', url: '/lecture-a-pub', token: INSTRUCTOR_A,
        body: { title: 'Renamed' },
    });
    assert.equal(response.statusCode, 200);
    const body = response.body as LectureRow;
    assert.equal(body.title, 'Renamed');
    assert.equal(body.is_published, 1);
    assert.equal(body.video_url, 'video://video-a');
});

test('owner cannot set a non-positive price on update', async () => {
    const { router, executed } = makeHarness();
    const response = await invokeRoute(router, {
        method: 'PUT', url: '/lecture-a-pub', token: INSTRUCTOR_A,
        body: { price: -5 },
    });
    assert.equal(response.statusCode, 400);
    assertNoWrite(executed);
});

test('owner cannot replace the video file after access was sold (409 guard preserved)', async () => {
    const fixtures = makeFixtures();
    fixtures.sharedLectures['lecture-a-pub'] = { id: 'share-1' };
    const { router } = makeHarness({ fixtures });
    const response = await invokeRoute(router, {
        method: 'PUT', url: '/lecture-a-pub', token: INSTRUCTOR_A,
        body: { video_url: 'video://replacement' },
    });
    assert.equal(response.statusCode, 409);
});

test('owner delete unpublishes the lecture', async () => {
    const { router } = makeHarness();
    const response = await invokeRoute(router, {
        method: 'DELETE', url: '/lecture-a-pub', token: INSTRUCTOR_A,
    });
    assert.equal(response.statusCode, 200);
    assert.equal((response.body as { message?: string }).message, 'Lecture deleted successfully');
    const readBack = await invokeRoute(router, { method: 'GET', url: '/lecture-a-pub', token: INSTRUCTOR_A });
    assert.equal((readBack.body as LectureRow).is_published, 0);
});

// ---------------------------------------------------------------------------
// GET / — list scoping (decision-boundary on SQL text + params)
// ---------------------------------------------------------------------------

test('instructor list scopes to its own lectures with the published filter', async () => {
    const { router, executed } = makeHarness();
    const response = await invokeRoute(router, { method: 'GET', url: '/', token: INSTRUCTOR_A });
    assert.equal(response.statusCode, 200);
    const listQuery = executed.find((e) => e.sql.includes('WHERE l.is_published = TRUE'));
    assert.ok(listQuery, 'list query executed');
    assert.ok(listQuery!.sql.includes('AND l.instructor_id = ?'), 'instructor scoping applied in SQL');
    assert.deepEqual(listQuery!.params, ['instructor-a']);
});

test('anonymous list keeps the pre-existing published-only public contract', async () => {
    const { router, executed } = makeHarness();
    const response = await invokeRoute(router, { method: 'GET', url: '/' });
    assert.equal(response.statusCode, 200);
    const body = response.body as LectureRow[];
    assert.deepEqual(body.map((l) => l.id).sort(), ['lecture-a-pub', 'lecture-b-pub']);
    const listQuery = executed.find((e) => e.sql.includes('WHERE l.is_published = TRUE'));
    assert.ok(listQuery);
    assert.ok(!listQuery!.sql.includes('AND l.instructor_id = ?'), 'no instructor scoping for anonymous callers');
});

test('GET / public list uses a minimal safe projection (no l.* source leakage) while remaining allowed', async () => {
    // Decision-boundary: the marketplace discovery list must not select l.*
    // (which would expose the private video source/key to anonymous browsers).
    // The projection is now an explicit public-safe column set and the
    // published-discovery contract is preserved.
    const { router, executed } = makeHarness();
    const response = await invokeRoute(router, { method: 'GET', url: '/' });
    assert.equal(response.statusCode, 200);
    const listQuery = executed.find((e) => e.sql.includes('WHERE l.is_published = TRUE'));
    assert.ok(listQuery, 'list query executed');
    assert.ok(!/l\.\*/.test(listQuery!.sql), 'list projection must not select l.*');
    assert.ok(!/\bl\.video_url\b/.test(listQuery!.sql), 'list projection must not expose l.video_url');
    const body = response.body as LectureRow[];
    assert.deepEqual(body.map((l) => l.id).sort(), ['lecture-a-pub', 'lecture-b-pub']);
});

test('entitled student still receives private lecture metadata (video_url) for their audience', async () => {
    // The minimal public projection does not apply to an entitled student
    // audience: the student workspace route returns the full row (video_url)
    // for lectures the student is entitled to, preserving playback while the
    // open marketplace stays source-free.
    const { router, executed } = makeHarness();
    const response = await invokeRoute(router, { method: 'GET', url: '/student/student-a', token: STUDENT_A });
    assert.equal(response.statusCode, 200);
    const body = response.body as LectureRow[];
    assert.equal(body.length, 1);
    assert.equal(body[0].id, 'lecture-a-pub');
    assert.equal(body[0].video_url, 'video://video-a');
    assert.ok(executed.some((e) => e.sql.includes('sl.lecture_id=l.id')), 'student audience query executed');
});

// ---------------------------------------------------------------------------
// Failure behavior
// ---------------------------------------------------------------------------

test('database failure on single-lecture read surfaces 500 without leaking internals', async () => {
    const { router } = makeHarness({ throwOnSql: (sql) => sql.includes('WHERE l.id = ?') });
    const response = await invokeRoute(router, { method: 'GET', url: '/lecture-a-pub' });
    assert.equal(response.statusCode, 500);
    assert.equal((response.body as { error?: string }).error, 'Failed to fetch lecture');
});

test('database failure on create surfaces 500', async () => {
    const { router } = makeHarness({ throwOnSql: (sql) => sql.includes('INSERT INTO lectures') });
    const response = await invokeRoute(router, {
        method: 'POST', url: '/', token: INSTRUCTOR_A,
        body: validLectureBody({ course_id: 'course-a' }),
    });
    assert.equal(response.statusCode, 500);
    assert.equal((response.body as { error?: string }).error, 'Failed to create lecture');
});
