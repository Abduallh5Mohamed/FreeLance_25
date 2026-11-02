import assert from 'node:assert/strict';
import test from 'node:test';
import type { Router } from 'express';
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
// C1/C4 public identity pages (safe projection, server-resolved)
// ---------------------------------------------------------------------------

const VALID_UUID = 'aaaaaaaa-1111-2222-3333-444444444444';

const buildPublicRouter = (responder: (sql: string, params: unknown[]) => unknown[] | null) => {
    const db = makeFakeDataAccess(responder);
    return { router: createPublicIdentityRouter({ query: db.query, queryOne: db.queryOne }), executed: db.executed };
};

const isTeacherUserQuery = (sql: string) => sql.includes("u.role IN ('instructor','teacher')");
const isTeacherTenantQuery = (sql: string) => sql.includes('SELECT t.id, t.business_name FROM tenants t');
const isTeacherCoursesQuery = (sql: string) => sql.includes('FROM courses c INNER JOIN tenants ct ON ct.id=c.tenant_id');

const SAFE_COURSE = { id: 'c1', name: 'Math', subject: 'Mathematics', description: 'd', grade: 'G1', price: 10 };
const DRAFT_COURSE = { id: 'c2', name: 'Secret Draft', subject: 'Physics', description: 'd', grade: 'G2', price: 99 };

test('routes: the identity router registers ONLY the teacher page, never a course list', () => {
    // The legacy `/courses` discovery handler lived here and shadowed the
    // M2-22 catalog router (array body, is_active-only filter, leaked drafts).
    // It was removed; this pins that the surface can never come back by
    // accident and collide with `public-catalog.ts` again.
    const { router } = buildPublicRouter(() => []);
    const registered = ((router as Router).stack as any[])
        .filter((layer) => layer.route)
        .flatMap((layer) => (layer.route.stack as any[]).map(() => ({
            method: String(Object.keys(layer.route.methods)[0]).toLowerCase(),
            path: String(layer.route.path),
        })));
    assert.deepEqual(
        registered.map((entry) => `${entry.method} ${entry.path}`),
        ['get /teachers/:id'],
        'exactly one public identity route may exist',
    );
});

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

test('public: teacher page requires explicit publication — the draft gate is in the SQL', async () => {
    // `is_active` alone leaked drafts: a course that was never published is
    // still `is_active=1`. The publication gate must be pinned in the emitted
    // statement, exactly like the M2-22 public catalog does.
    const { router, executed } = buildPublicRouter((sql) => {
        if (isTeacherUserQuery(sql)) return [{ id: VALID_UUID, name: 'Teacher A' }];
        if (isTeacherTenantQuery(sql)) return [{ id: 'tenant-a', business_name: 'Center A' }];
        if (isTeacherCoursesQuery(sql)) return [SAFE_COURSE];
        return [];
    });
    const response = await invokeRoute(router, { method: 'GET', url: `/teachers/${VALID_UUID}` });
    assert.equal(response.statusCode, 200);
    const courseSql = executed.find((e) => isTeacherCoursesQuery(e.sql))!;
    assert.ok(
        courseSql.sql.includes("c.publication_state='published'"),
        'the teacher page must pin the explicit publication state, not rely on is_active',
    );
});

test('public: teacher page hides draft courses at row level (fixture models the MySQL gate)', async () => {
    // The fixture models what MySQL does with the emitted WHERE clause: a row
    // is visible only when the statement pins publication, active and an active
    // tenant. If the publication gate is dropped from the route, the draft row
    // becomes visible here and this test fails — the leak cannot pass silently.
    const { router } = buildPublicRouter((sql) => {
        if (isTeacherUserQuery(sql)) return [{ id: VALID_UUID, name: 'Teacher A' }];
        if (isTeacherTenantQuery(sql)) return [{ id: 'tenant-a', business_name: 'Center A' }];
        if (isTeacherCoursesQuery(sql)) {
            const published = sql.includes("c.publication_state='published'");
            const active = sql.includes('c.is_active=1');
            const activeTenant = sql.includes("ct.status='active'");
            const rows = [SAFE_COURSE, DRAFT_COURSE];
            // The draft is `is_active=1` but `publication_state='draft'`; the
            // published row satisfies every gate.
            return published && active && activeTenant
                ? rows.filter((row) => row.id === SAFE_COURSE.id)
                : rows;
        }
        return [];
    });
    const response = await invokeRoute(router, { method: 'GET', url: `/teachers/${VALID_UUID}` });
    assert.equal(response.statusCode, 200);
    const courses = response.body as { published_courses: Array<{ id: string; name: string }> };
    assert.deepEqual(
        courses.published_courses.map((row) => row.id),
        [SAFE_COURSE.id],
        'a never-published draft must never reach the public teacher page',
    );
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

// ---------------------------------------------------------------------------
// Correction A — the public teacher page must NEVER be cached.
//
// Publication can be withdrawn at any time, so a cached page could keep a
// course the owner has since unpublished. Every outcome (200 / 404 / 500) must
// carry `Cache-Control: no-store`, and a subsequent request after withdrawal
// must not serve the stale course.
// ---------------------------------------------------------------------------

test('public: teacher page sets Cache-Control: no-store on success', async () => {
    const { router } = buildPublicRouter((sql) => {
        if (isTeacherUserQuery(sql)) return [{ id: VALID_UUID, name: 'Teacher A' }];
        if (isTeacherTenantQuery(sql)) return [{ id: 'tenant-a', business_name: 'Center A' }];
        if (isTeacherCoursesQuery(sql)) return [SAFE_COURSE];
        return [];
    });
    const response = await invokeRoute(router, { method: 'GET', url: `/teachers/${VALID_UUID}` });
    assert.equal(response.statusCode, 200);
    assert.equal((response.headers as Record<string, string>)['cache-control'], 'no-store');
});

test('public: teacher page sets Cache-Control: no-store on failure (404 / 500)', async () => {
    // A malformed id is refused before any lookup — the refusal must still be
    // no-store so a previously good page can never be served for it.
    const okRouter = buildPublicRouter(() => []).router;
    const notFound = await invokeRoute(okRouter, { method: 'GET', url: '/teachers/not-a-uuid' });
    assert.equal(notFound.statusCode, 404);
    assert.equal((notFound.headers as Record<string, string>)['cache-control'], 'no-store');

    // A database failure returns 500 — also no-store.
    const db = makeFakeDataAccess((sql) => {
        if (isTeacherUserQuery(sql)) throw new Error('private database connection details');
        return [];
    });
    const router = createPublicIdentityRouter({ query: db.query, queryOne: db.queryOne });
    const errorResponse = await invokeRoute(router, { method: 'GET', url: `/teachers/${VALID_UUID}` });
    assert.equal(errorResponse.statusCode, 500);
    assert.equal((errorResponse.headers as Record<string, string>)['cache-control'], 'no-store');
});

test('public: withdrawing publication removes the course from the page (no stale cache)', async () => {
    // A page cached with max-age could keep a withdrawn course visible. With
    // no-store the very next request re-reads the same course row and must now
    // hide it because its publication_state is no longer 'published'.
    let published = true;
    const { router } = buildPublicRouter((sql) => {
        if (isTeacherUserQuery(sql)) return [{ id: VALID_UUID, name: 'Teacher A' }];
        if (isTeacherTenantQuery(sql)) return [{ id: 'tenant-a', business_name: 'Center A' }];
        if (isTeacherCoursesQuery(sql)) return published ? [SAFE_COURSE] : [];
        return [];
    });
    const before = await invokeRoute(router, { method: 'GET', url: `/teachers/${VALID_UUID}` });
    assert.equal(before.statusCode, 200);
    assert.equal(((before.body as { published_courses: unknown[] }).published_courses).length, 1);
    assert.equal((before.headers as Record<string, string>)['cache-control'], 'no-store');

    published = false; // owner withdraws publication
    const after = await invokeRoute(router, { method: 'GET', url: `/teachers/${VALID_UUID}` });
    assert.equal(after.statusCode, 200);
    assert.equal(
        ((after.body as { published_courses: unknown[] }).published_courses).length,
        0,
        'a withdrawn course must immediately disappear from the public page',
    );
    assert.equal((after.headers as Record<string, string>)['cache-control'], 'no-store');
});
