import assert from 'node:assert/strict';
import test from 'node:test';
import { createPublicIdentityRouter, parsePublicPagination } from '../src/routes/public-identity';
import { makeFakeDataAccess, invokeRoute } from './helpers/m2-harness';

// ---------------------------------------------------------------------------
// Pure unit: parsePublicPagination (bounded, never throws)
// ---------------------------------------------------------------------------

test('pagination: defaults to limit 24, offset 0', () => {
    const p = parsePublicPagination(undefined);
    assert.equal(p.limit, 24);
    assert.equal(p.offset, 0);
});

test('pagination: hard-caps limit at 100 and clamps negatives', () => {
    assert.equal(parsePublicPagination({ limit: 5000 }).limit, 100);
    const neg = parsePublicPagination({ limit: -3, offset: -10 });
    assert.equal(neg.limit, 1);
    assert.equal(neg.offset, 0);
});

test('pagination: derives offset from page', () => {
    const p = parsePublicPagination({ limit: 10, page: 3 });
    assert.equal(p.limit, 10);
    assert.equal(p.offset, 20);
});

test('pagination: accepts stringified numbers', () => {
    const p = parsePublicPagination({ limit: '5', page: '2' });
    assert.equal(p.limit, 5);
    assert.equal(p.offset, 5);
});

// ---------------------------------------------------------------------------
// C1/C4 public identity + published discovery (safe projection, server-resolved)
// ---------------------------------------------------------------------------

const VALID_UUID = 'aaaaaaaa-1111-2222-3333-444444444444';

const buildPublicRouter = (responder: (sql: string, params: unknown[]) => unknown[] | null) => {
    const db = makeFakeDataAccess(responder);
    return { router: createPublicIdentityRouter({ query: db.query, queryOne: db.queryOne }), executed: db.executed };
};

const isTeacherUserQuery = (sql: string) => sql.includes("u.role IN ('instructor','teacher')");
const isTeacherTenantQuery = (sql: string) => sql.includes('SELECT t.id, t.business_name FROM tenants t');
const isTeacherCoursesQuery = (sql: string) => sql.includes('FROM courses c INNER JOIN tenants ct ON ct.id=c.tenant_id');
const isDiscoveryQuery = (sql: string) => sql.includes('INNER JOIN tenants t ON t.id=c.tenant_id');

const SAFE_COURSE = { id: 'c1', name: 'Math', subject: 'Mathematics', description: 'd', grade: 'G1', price: 10 };

test('public: a non-uuid teacher id is 404 (no enumeration)', async () => {
    const { router } = buildPublicRouter(() => []);
    const response = await invokeRoute(router, { method: 'GET', url: '/teachers/not-a-uuid' });
    assert.equal(response.statusCode, 404);
    assert.equal((response.body as { error?: string }).error, 'Not found');
});

test('public: teacher page returns only non-private fields (no phone/email/secrets)', async () => {
    const { router, executed } = buildPublicRouter((sql) => {
        if (isTeacherUserQuery(sql)) return [{ id: VALID_UUID, name: 'Teacher A' }];
        if (isTeacherTenantQuery(sql)) return [{ id: 'tenant-a', business_name: 'Center A' }];
        if (isTeacherCoursesQuery(sql)) return [SAFE_COURSE];
        return [];
    });
    const response = await invokeRoute(router, { method: 'GET', url: `/teachers/${VALID_UUID}` });
    assert.equal(response.statusCode, 200);
    const body = response.body as Record<string, unknown>;
    assert.equal(body.id, VALID_UUID);
    assert.equal(body.name, 'Teacher A');
    assert.deepEqual(body.center, { id: 'tenant-a', business_name: 'Center A' });
    assert.ok(Array.isArray(body.published_courses));
    assert.equal((body.published_courses as unknown[]).length, 1);
    assert.equal('phone' in body, false);
    assert.equal('email' in body, false);
    assert.equal('secret' in body, false);
    const teacherSql = executed.find((e) => isTeacherUserQuery(e.sql))!;
    assert.ok(!/phone|email|secret|token/i.test(teacherSql.sql), 'teacher lookup projection is private-free');
    const courseSql = executed.find((e) => isTeacherCoursesQuery(e.sql))!;
    assert.ok(courseSql.sql.includes("ct.status='active'"), 'teacher page hides courses from suspended tenants');
    assert.ok(courseSql.sql.includes('(c.instructor_id=? OR ct.owner_user_id=?)'), 'course ownership stays scoped to this teacher or their tenant');
});

test('public: teacher without an active center still resolves with center null', async () => {
    const { router } = buildPublicRouter((sql) => {
        if (isTeacherUserQuery(sql)) return [{ id: VALID_UUID, name: 'Teacher A' }];
        if (isTeacherTenantQuery(sql)) return [];
        if (isTeacherCoursesQuery(sql)) return [];
        return [];
    });
    const response = await invokeRoute(router, { method: 'GET', url: `/teachers/${VALID_UUID}` });
    assert.equal(response.statusCode, 200);
    assert.equal((response.body as { center: unknown }).center, null);
});

test('public: teacher page database failures return a generic 500 at each lookup', async () => {
    const failedQueries = [
        isTeacherUserQuery,
        isTeacherTenantQuery,
        isTeacherCoursesQuery,
    ];

    for (const shouldFail of failedQueries) {
        const failureMessage = 'private database connection details';
        const db = makeFakeDataAccess((sql) => {
            if (shouldFail(sql)) throw new Error(failureMessage);
            if (isTeacherUserQuery(sql)) return [{ id: VALID_UUID, name: 'Teacher A' }];
            if (isTeacherTenantQuery(sql)) return [{ id: 'tenant-a', business_name: 'Center A' }];
            if (isTeacherCoursesQuery(sql)) return [SAFE_COURSE];
            return [];
        });
        const router = createPublicIdentityRouter({ query: db.query, queryOne: db.queryOne });
        const response = await invokeRoute(router, { method: 'GET', url: `/teachers/${VALID_UUID}` });

        assert.equal(response.statusCode, 500);
        assert.deepEqual(response.body, { error: 'Failed to load teacher page' });
        assert.equal(JSON.stringify(response.body).includes(failureMessage), false);
    }
});

test('public: course discovery returns only a safe projection and never private columns', async () => {
    const { router, executed } = buildPublicRouter((sql) => {
        if (isDiscoveryQuery(sql)) return [SAFE_COURSE, { ...SAFE_COURSE, id: 'c2', name: 'Physics' }];
        return [];
    });
    const response = await invokeRoute(router, { method: 'GET', url: '/courses' });
    assert.equal(response.statusCode, 200);
    const courses = response.body as Array<Record<string, unknown>>;
    assert.equal(courses.length, 2);
    for (const course of courses) {
        assert.equal('video_url' in course, false);
        assert.equal('file_url' in course, false);
        assert.equal('phone' in course, false);
        assert.equal('secret' in course, false);
    }
    const discoverySql = executed.find((e) => isDiscoveryQuery(e.sql))!;
    assert.ok(!/video_url|file_url|phone|email|secret|l\.\*/i.test(discoverySql.sql), 'discovery projection is private-free');
});

test('public: discovery honors grade/subject/search filters in SQL', async () => {
    const { router, executed } = buildPublicRouter((sql) => {
        if (isDiscoveryQuery(sql)) return [SAFE_COURSE];
        return [];
    });
    const response = await invokeRoute(router, { method: 'GET', url: '/courses', query: { grade: 'G1', subject: 'Mathematics', search: 'Math' } });
    assert.equal(response.statusCode, 200);
    const discoverySql = executed.find((e) => isDiscoveryQuery(e.sql))!;
    assert.ok(discoverySql.sql.includes('c.grade=?'), 'grade filter bound');
    assert.ok(discoverySql.sql.includes('c.subject=?'), 'subject filter bound');
    assert.ok(discoverySql.sql.includes('c.name LIKE ? OR c.description LIKE ?'), 'search filter bound');
    assert.deepEqual(discoverySql.params.slice(0, 3), ['G1', 'Mathematics', '%Math%']);
});

test('public: discovery only publishes active tenant courses (drafts hidden by the is_active gate)', async () => {
    // The fixture returns only is_active rows; the gate (c.is_active=1 AND
    // t.status='active') is asserted in the emitted SQL so the hiding is
    // enforced server-side, not just by fixture luck.
    const { router, executed } = buildPublicRouter((sql) => {
        if (isDiscoveryQuery(sql)) return [SAFE_COURSE];
        return [];
    });
    const response = await invokeRoute(router, { method: 'GET', url: '/courses' });
    assert.equal(response.statusCode, 200);
    assert.equal((response.body as unknown[]).length, 1);
    const discoverySql = executed.find((e) => isDiscoveryQuery(e.sql))!;
    assert.ok(discoverySql.sql.includes('c.is_active=1'), 'is_active gate present');
    assert.ok(discoverySql.sql.includes("t.status='active'"), 'active tenant gate present');
});

test('public: discovery sets a public, short-TTL cache header', async () => {
    const { router } = buildPublicRouter((sql) => {
        if (isDiscoveryQuery(sql)) return [SAFE_COURSE];
        return [];
    });
    const response = await invokeRoute(router, { method: 'GET', url: '/courses' });
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers?.['cache-control'], 'public, max-age=60');
});

test('public: discovery pagination is bounded and forwarded to SQL LIMIT/OFFSET', async () => {
    const { router, executed } = buildPublicRouter((sql) => {
        if (isDiscoveryQuery(sql)) return [SAFE_COURSE];
        return [];
    });
    const response = await invokeRoute(router, { method: 'GET', url: '/courses', query: { limit: '7', page: '2' } });
    assert.equal(response.statusCode, 200);
    const discoverySql = executed.find((e) => isDiscoveryQuery(e.sql))!;
    assert.ok(discoverySql.sql.includes('LIMIT ? OFFSET ?'), 'pagination clause present');
    // limit 7, page 2 -> offset 7
    const limitIdx = discoverySql.params.indexOf('7');
    assert.ok(limitIdx >= 0);
    assert.equal(discoverySql.params[limitIdx + 1], '7', 'offset = (page-1)*limit = 7');
});
