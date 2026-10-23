/**
 * M2-B05 — private course-lesson metadata (hermetic, behavioral).
 *
 * Contract under test:
 *   GET   /api/tenants/me/catalog/courses/:courseId/units/:unitId/lessons
 *   POST  /api/tenants/me/catalog/courses/:courseId/units/:unitId/lessons
 *   PATCH /api/tenants/me/catalog/courses/:courseId/units/:unitId/lessons/:lessonId
 * manage the private lesson metadata of a unit of an ACTIVE course of the
 * tenant the SERVER selected, and only for the VERIFIED owner of that tenant
 * (`tenants.owner_user_id` = caller, tenant active, caller active). A
 * membership role label, a global teacher/admin role and a student never
 * grant lesson visibility or writes. Lesson metadata carries no content,
 * asset, teacher assignment, student entitlement, publication, progression,
 * payment or upload effect: archiving a lesson is metadata only.
 *
 * Composition under test is the real production order (src/index.ts): the real
 * optional-auth middleware, the real tenant-authority and student-workspace
 * boundaries, then the real `createTenantSelfRouter` with the real
 * `createCourseLessonsRouter` mounted under `/catalog`. Only leaf data
 * repositories and the transactional connection are injected fixtures. No
 * express listener, socket, fetch, DB, provider or app startup.
 *
 * Import isolation is proven positively: the `src/db`, `src/services/minio`,
 * `src/services/subscription-renewal` and `dotenv` module bodies are
 * intercepted in the CommonJS loader before any app module loads, stay out of
 * `require.cache`, need no dummy env and are re-checked in `after`.
 *
 * The atomic reorder batch is covered by
 * `tests/m2-course-lessons-reorder.test.ts`.
 *
 * Live MySQL row-level locking, real concurrency, real keyset index usage,
 * real foreign keys and real HTTP transport are explicitly NOT exercised or
 * claimed.
 */
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import Module from 'node:module';
import type { Router } from 'express';
import {
    ABSENT_COURSE, ABSENT_LESSON, ABSENT_UNIT, ADMIN, AUDIT_SQL, BILLING_ONLY, COURSE_A1, COURSE_A2,
    COURSE_B1, COURSE_INACTIVE, COURSE_NULL, COURSE_SELECT, INSERT_SQL, INSTRUCTOR_A, LESSON_1,
    LESSON_2, LESSON_3, LESSON_ARCHIVED, LESSON_DTO_KEYS, LESSON_LOCK_SELECT, LESSON_OTHER_UNIT,
    LESSON_PROJECTION, LESSON_SELECT, LESSON_UNIT_B, LIST_SQL, MULTI, NO_SCOPE, OWNER_A, OWNER_B,
    OWNER_SELECT, ROLE_OWNER_MEMBER, STUDENT, TENANT_A, TENANT_B, UNIT_A1, UNIT_A1_ARCHIVED, UNIT_A2,
    UNIT_B1, UNIT_SELECT, UPDATE_SQL, assertLessonDto, buildHarness, createIsolation, createReq,
    driverDateOf, encodeCursor, epochOf, lessonPath, lessonsPath, listReq, loadAppModules, makeReq,
    makeState, ownerToken, reorderPath, runChain, sign, squash, stamp, updateReq, withSilencedErrors,
} from './helpers/m2-course-lessons-harness';

const isolation = createIsolation();

const originalSecret = process.env.JWT_SECRET;
process.env.JWT_SECRET = 'm2-b05-hermetic-jwt-secret-not-a-real-key';

after(() => {
    if (originalSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = originalSecret;
    assert.equal(isolation.hookRestored(), true, 'the loader hook must be restored after loading');
    assert.deepEqual(isolation.sentinelCalls, [], 'no forbidden default adapter may be called by any test in this suite');
});

// ---------------------------------------------------------------------------
// Positive import interception
// ---------------------------------------------------------------------------

let loadError: unknown = null;
let lessonsModule: any;
let modules: any;
/** The interception log right after the lesson module was loaded on its own. */
let lessonModuleInterception: string[] = [];

try {
    // The new module is loaded FIRST and alone: it must not pull in the
    // database, the provider, the renewal executor or dotenv by itself.
    isolation.install();
    try {
        lessonsModule = require('../src/routes/course-lessons');
        lessonModuleInterception = [...isolation.interceptionLog];
    } finally {
        isolation.restore();
    }
    modules = loadAppModules(isolation, path.join(__dirname, '../src/routes/tenant-self'));
} catch (error) {
    loadError = error;
}

const build = (state = makeState()) => buildHarness(state, modules);

// ---------------------------------------------------------------------------
// Import isolation — positive evidence
// ---------------------------------------------------------------------------

test('import isolation: forbidden module bodies never evaluate, no dummy env, hook restored', () => {
    assert.equal(loadError, null, `application modules must load through the sentinels: ${String(loadError)}`);
    assert.deepEqual(lessonModuleInterception, [], 'the lesson module must not pull in a forbidden module by itself');
    assert.equal(process.env.MINIO_ACCESS_KEY, undefined);
    assert.equal(process.env.MINIO_SECRET_KEY, undefined);
    for (const id of isolation.interceptedIds()) {
        assert.equal(require.cache[id], undefined, `${id} must never enter require.cache`);
    }
    assert.ok(isolation.interceptionLog.length > 0, 'the composition must have been intercepted at least once');
});

test('module: the lesson router factory is standalone, injected and has no default export', () => {
    assert.equal(typeof lessonsModule.createCourseLessonsRouter, 'function');
    assert.equal(lessonsModule.default, undefined, 'the lesson module must have no default export');
    const router: Router = lessonsModule.createCourseLessonsRouter({
        getConnection: async () => {
            throw new Error('HERMETIC_VIOLATION:the standalone factory must not be reached in this check');
        },
    });
    assert.equal(typeof router, 'function', 'the factory returns an express router');
});

test('mount: every lesson route is reachable under the authenticated tenant-self mount', async () => {
    const harness = build();
    const list = await runChain(harness.chain, listReq());
    assert.equal(list.status, 200, 'the lesson list must be reachable through the real tenant-self mount');
    assert.deepEqual(Object.keys(list.body), ['lessons', 'next_cursor']);

    const created = await runChain(harness.chain, createReq({ title: 'Mounted lesson' }));
    assert.equal(created.status, 201);
    assert.deepEqual(Object.keys(created.body), ['lesson']);

    const updated = await runChain(harness.chain, updateReq(LESSON_1, { title: 'Mounted rename' }));
    assert.equal(updated.status, 200);
});

// ---------------------------------------------------------------------------
// GET list — owner-only bounded keyset list
// ---------------------------------------------------------------------------

test('list: the verified owner reads only the lessons of the selected unit, archived included', async () => {
    const harness = build();
    const res = await runChain(harness.chain, listReq());

    assert.equal(res.status, 200);
    assert.deepEqual(Object.keys(res.body), ['lessons', 'next_cursor']);
    assert.deepEqual(res.body.lessons.map((l: any) => l.id), [LESSON_1, LESSON_2, LESSON_3, LESSON_ARCHIVED],
        'the list is (display_order,id) ordered and includes archived metadata');
    for (const lesson of res.body.lessons) assertLessonDto(lesson);
    assert.equal(res.body.next_cursor, null, 'a short page has no successor cursor');
    assert.equal(res.headers['Cache-Control'], 'no-store');

    assert.deepEqual(harness.events, ['begin', 'owner', 'course', 'unit', 'list', 'rollback', 'release']);
    assert.equal(squash(harness.calls[0].sql), OWNER_SELECT, 'the read path verifies the owner without an exclusive lock');
    assert.deepEqual(harness.calls[0].params, [OWNER_A, TENANT_A]);
    assert.equal(squash(harness.calls[1].sql), COURSE_SELECT);
    assert.deepEqual(harness.calls[1].params, [COURSE_A1, TENANT_A], 'the course is qualified by the selected tenant');
    assert.equal(squash(harness.calls[2].sql), UNIT_SELECT);
    assert.deepEqual(harness.calls[2].params, [UNIT_A1, COURSE_A1], 'the unit is qualified by the course of the path');
    assert.equal(squash(harness.calls[3].sql), LIST_SQL);
    assert.deepEqual(harness.calls[3].params, [UNIT_A1, -1, -1, '', 26],
        'the list is unit-qualified, cursor-bounded and reads one extra row');
    assert.ok(!JSON.stringify(res.body).includes(LESSON_OTHER_UNIT), 'a lesson of another unit must never be listed');
    assert.ok(!JSON.stringify(res.body).includes(LESSON_UNIT_B), 'a lesson of another tenant must never be listed');
    assert.ok(!JSON.stringify(res.body).includes('epoch'), 'the epoch projection must never leak into the DTO');
});

test('list: the DTO renders the stored instants as UTC ISO-8601 from the epoch projection', async () => {
    const harness = build();
    const res = await runChain(harness.chain, listReq());
    assert.equal(res.status, 200);
    assert.equal(res.body.lessons[0].created_at, '2026-10-21T08:00:00.000Z');
    assert.equal(res.body.lessons[0].updated_at, '2026-10-21T08:00:00.000Z');
    assert.equal(res.body.lessons[1].created_at, '2026-10-21T08:05:00.000Z');

    // The fixture hands back the raw datetime columns decoded by the installed
    // driver with its `timezone: '+02:00'` interpretation, which is TWO HOURS
    // EARLIER than the stored instant. A handler that serialized that column
    // would answer a shifted instant.
    const shifted = driverDateOf(stamp(8, 0)).toISOString();
    assert.equal(shifted, '2026-10-21T06:00:00.000Z', 'the driver-decoded column is the shifted value');
    assert.notEqual(res.body.lessons[0].created_at, shifted, 'the serialized instant must not be the driver-decoded value');
    assert.equal(res.body.lessons[0].created_at, new Date(epochOf(stamp(8, 0)) * 1000).toISOString(),
        'the serialized instant is the stored instant');
});

test('list: the serialized instant is independent of the driver offset and of a DST transition', async () => {
    const state = makeState();
    // Two instants exactly one hour apart in real time, across the European
    // daylight-saving start (2026-03-29T01:00:00Z): a wall-clock serialization
    // could not render both correctly.
    const before = new Date('2026-03-29T00:30:00.000Z');
    const after = new Date('2026-03-29T01:30:00.000Z');
    state.lessons.push(
        { id: '55550000-0000-4000-8000-000000000001', unit_id: UNIT_A1, title: 'Before DST', description: null, display_order: 20, status: 'active', created_at: before, updated_at: before },
        { id: '55550000-0000-4000-8000-000000000002', unit_id: UNIT_A1, title: 'After DST', description: null, display_order: 21, status: 'active', created_at: after, updated_at: after },
    );
    const res = await runChain(build(state).chain, listReq());
    assert.equal(res.status, 200);

    const beforeDto = res.body.lessons.find((l: any) => l.title === 'Before DST');
    const afterDto = res.body.lessons.find((l: any) => l.title === 'After DST');
    assert.equal(beforeDto.created_at, '2026-03-29T00:30:00.000Z');
    assert.equal(afterDto.created_at, '2026-03-29T01:30:00.000Z');
    assert.equal(
        new Date(afterDto.created_at).getTime() - new Date(beforeDto.created_at).getTime(),
        3600000,
        'the real elapsed time is exactly one hour across the transition',
    );
});

test('list: an unreadable epoch projection fails the page instead of fabricating a date', async () => {
    const variants = ['null', 'zero', 'nan', 'text', 'missing'] as const;
    for (const variant of variants) {
        const state = makeState();
        state.malformedEpoch = variant;
        const harness = build(state);
        const res = await withSilencedErrors(() => runChain(harness.chain, listReq()));
        assert.equal(res.status, 500, `${variant}: an unreadable instant must fail the page`);
        assert.deepEqual(res.body, { error: 'Failed to list course lessons' });
        assert.equal(res.headers['Cache-Control'], 'no-store');
        assert.ok(!JSON.stringify(res.body).includes('1970'), 'no 1970 instant may be fabricated');
        assert.equal(harness.releaseCount(), 1, `${variant}: exactly one release`);
        assert.equal(harness.destroyCount(), 0);
    }
});

test('list: the default page is 25 and the maximum is 100', async () => {
    const state = makeState();
    for (let index = 0; index < 120; index += 1) {
        state.lessons.push({
            id: `60000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
            unit_id: UNIT_A1, title: `Generated ${index}`, description: null,
            display_order: 100 + index, status: 'active', created_at: stamp(12, 0), updated_at: stamp(12, 0),
        });
    }
    const defaultPage = await runChain(build(state).chain, listReq());
    assert.equal(defaultPage.status, 200);
    assert.equal(defaultPage.body.lessons.length, 25, 'the default page size is 25');
    assert.equal(typeof defaultPage.body.next_cursor, 'string');

    const harnessMax = build(state);
    const maxPage = await runChain(harnessMax.chain, listReq({ limit: '100' }));
    assert.equal(maxPage.status, 200);
    assert.equal(maxPage.body.lessons.length, 100, 'the maximum page size is 100');
    const listCall = harnessMax.calls.find(c => squash(c.sql) === LIST_SQL);
    assert.equal(listCall?.params[4], 101, 'the read is bounded to limit+1');
});

test('list: an invalid limit is refused 400 before any connection', async () => {
    const invalid = ['0', '101', '1000', '-1', '1.5', ' 5', 'five', '', ['1'] as any, { limit: 1 } as any, 5 as any];
    for (const limit of invalid) {
        const harness = build();
        const res = await runChain(harness.chain, listReq({ limit }));
        assert.equal(res.status, 400, `limit=${JSON.stringify(limit)} must be refused 400`);
        assert.deepEqual(res.body, { error: 'Invalid course lesson list limit' });
        assert.equal(res.headers['Cache-Control'], 'no-store');
        assert.equal(harness.connectionCount(), 0);
        assert.deepEqual(harness.calls, []);
    }
});

test('list: the cursor resumes strictly after the last returned row', async () => {
    const first = await runChain(build().chain, listReq({ limit: '2' }));
    assert.equal(first.status, 200);
    assert.deepEqual(first.body.lessons.map((l: any) => l.id), [LESSON_1, LESSON_2]);
    assert.equal(first.body.next_cursor, encodeCursor(1, LESSON_2), 'the cursor is the position of the last returned row');

    const harness = build();
    const second = await runChain(harness.chain, listReq({ limit: '2', cursor: first.body.next_cursor }));
    assert.equal(second.status, 200);
    assert.deepEqual(second.body.lessons.map((l: any) => l.id), [LESSON_3, LESSON_ARCHIVED],
        'the tie on display_order 1 is broken by the id and the resume is strict');
    assert.equal(second.body.next_cursor, null);
    const listCall = harness.calls.find(c => squash(c.sql) === LIST_SQL);
    assert.deepEqual(listCall?.params, [UNIT_A1, 1, 1, LESSON_2, 3], 'the keyset predicate resumes after the position');
});

test('list: a malformed, oversized or non-canonical cursor is refused 400 before any connection', async () => {
    const valid = encodeCursor(1, LESSON_2);
    const invalid = [
        'not-a-cursor',
        '!!!',
        Buffer.from('1:not-a-uuid', 'utf8').toString('base64url'),
        Buffer.from(`${1}:${LESSON_2}`, 'utf8').toString('base64'), // padded: not the canonical encoding
        Buffer.from('-1:' + LESSON_2, 'utf8').toString('base64url'),
        Buffer.from('4294967296:' + LESSON_2, 'utf8').toString('base64url'),
        'A'.repeat(300),
    ];
    for (const cursor of invalid) {
        const harness = build();
        const res = await runChain(harness.chain, listReq({ cursor }));
        assert.equal(res.status, 400, `cursor=${String(cursor).slice(0, 24)} must be refused 400`);
        assert.deepEqual(res.body, { error: 'Invalid course lesson list cursor' });
        assert.equal(harness.connectionCount(), 0);
    }
    // The canonical encoding itself is accepted.
    const accepted = await runChain(build().chain, listReq({ cursor: valid }));
    assert.equal(accepted.status, 200);
});

test('list: a cursor is only a position, never authority', async () => {
    // A cursor minted for another unit is still just a position: the page stays
    // qualified by the unit of the path.
    const harness = build();
    const res = await runChain(harness.chain, listReq({ cursor: encodeCursor(0, LESSON_UNIT_B) }));
    assert.equal(res.status, 200);
    const listCall = harness.calls.find(c => squash(c.sql) === LIST_SQL);
    assert.deepEqual(listCall?.params, [UNIT_A1, 0, 0, LESSON_UNIT_B, 26]);
    assert.deepEqual(res.body.lessons.map((l: any) => l.id), [LESSON_2, LESSON_3, LESSON_ARCHIVED]);
});

test('list: an archived unit is still private owner-manageable metadata', async () => {
    const harness = build();
    const res = await runChain(harness.chain, listReq({}, COURSE_A1, UNIT_A1_ARCHIVED));
    assert.equal(res.status, 200, 'an archived unit is not filtered out of its own metadata read');
    assert.deepEqual(res.body.lessons, []);
});

// ---------------------------------------------------------------------------
// POST create
// ---------------------------------------------------------------------------

test('create: the owner creates a lesson under an active unit with one audit event', async () => {
    const state = makeState();
    const harness = build(state);
    const res = await runChain(harness.chain, createReq({ title: '  Adding fractions  ', description: 'Chapter 1', display_order: 3 }));

    assert.equal(res.status, 201);
    assert.deepEqual(Object.keys(res.body), ['lesson']);
    assertLessonDto(res.body.lesson);
    assert.equal(res.body.lesson.unit_id, UNIT_A1, 'the lesson is placed under the unit of the path');
    assert.equal(res.body.lesson.title, 'Adding fractions', 'the title is stored trimmed');
    assert.equal(res.body.lesson.description, 'Chapter 1');
    assert.equal(res.body.lesson.display_order, 3);
    assert.equal(res.body.lesson.status, 'active', 'the create status is always active');
    assert.equal(res.body.lesson.created_at, res.body.lesson.updated_at);
    assert.equal(res.headers['Cache-Control'], 'no-store');

    assert.deepEqual(harness.events,
        ['begin', 'owner', 'course', 'unit', 'insert', 'audit', 'lesson_select', 'commit', 'release'],
        'create locks the owner, the course and the unit, then inserts, audits, reads back and commits');
    assert.equal(squash(harness.calls[0].sql), `${OWNER_SELECT} FOR UPDATE`);
    assert.equal(squash(harness.calls[1].sql), `${COURSE_SELECT} FOR UPDATE`);
    assert.equal(squash(harness.calls[2].sql), `${UNIT_SELECT} FOR UPDATE`);
    assert.deepEqual(harness.calls[2].params, [UNIT_A1, COURSE_A1]);
    const insert = harness.calls.find(c => squash(c.sql) === INSERT_SQL);
    assert.deepEqual(insert?.params.slice(1), [UNIT_A1, 'Adding fractions', 'Chapter 1', 3, 'active', null]);
    assert.equal(harness.auditRows.length, 1, 'exactly one audit event');
    assert.equal(squash(harness.auditRows[0].sql), AUDIT_SQL);
    const audit = harness.auditRows[0].params;
    assert.equal(audit[1], OWNER_A, 'the actor is the verified owner');
    assert.equal(audit[2], TENANT_A, 'the tenant is the derived selected tenant');
    assert.equal(audit[3], 'course.lesson_created');
    assert.equal(audit[4], 'course_lesson');
    assert.equal(audit[5], insert?.params[0], 'the audited resource is the created lesson');
    assert.equal(audit[6], null);
    const payload = JSON.parse(audit[7]);
    assert.deepEqual(payload, {
        course_id: COURSE_A1, unit_id: UNIT_A1, lesson_id: insert?.params[0],
        title: 'Adding fractions', display_order: 3, status: 'active',
        release_at: null, prerequisite_lesson_id: null,
    }, 'the audit payload is the bounded lesson metadata');
    assert.equal(harness.commitCount(), 1);
    assert.equal(harness.releaseCount(), 1);
    assert.equal(state.lessons.length, 7, 'the lesson was persisted');
});

test('create: the defaults are display_order 0, a null description and an active status', async () => {
    const harness = build();
    const res = await runChain(harness.chain, createReq({ title: 'Defaults' }));
    assert.equal(res.status, 201);
    assert.equal(res.body.lesson.display_order, 0);
    assert.equal(res.body.lesson.description, null);
    assert.equal(res.body.lesson.status, 'active');
    const insert = harness.calls.find(c => squash(c.sql) === INSERT_SQL);
    assert.deepEqual(insert?.params.slice(2), ['Defaults', null, 0, 'active', null]);
});

test('create: duplicate titles are allowed and the id is the identity', async () => {
    const harness = build();
    const first = await runChain(harness.chain, createReq({ title: 'Lesson one' }));
    const second = await runChain(harness.chain, createReq({ title: 'Lesson one' }));
    assert.equal(first.status, 201);
    assert.equal(second.status, 201);
    assert.notEqual(first.body.lesson.id, second.body.lesson.id, 'the id, not the title, is the identity');
    assert.equal(first.body.lesson.title, second.body.lesson.title);
});

test('create: the title 255/256 and description 10000/10001 boundaries are exact', async () => {
    const ok = await runChain(build().chain, createReq({ title: 'a'.repeat(255), description: 'b'.repeat(10000) }));
    assert.equal(ok.status, 201, 'a 255-character title and a 10000-character description are accepted');
    assert.equal(ok.body.lesson.title.length, 255);

    const longTitle = await runChain(build().chain, createReq({ title: 'a'.repeat(256) }));
    assert.equal(longTitle.status, 400);
    assert.deepEqual(longTitle.body, { error: 'Invalid course lesson payload' });

    const longDescription = await runChain(build().chain, createReq({ title: 'ok', description: 'b'.repeat(10001) }));
    assert.equal(longDescription.status, 400);

    const emptyTitle = await runChain(build().chain, createReq({ title: '   ' }));
    assert.equal(emptyTitle.status, 400, 'a whitespace-only title trims to empty and is refused');
});

test('create: the display_order bounds are exact and never coerced', async () => {
    const accepted = [0, 1, 2147483647];
    for (const order of accepted) {
        const res = await runChain(build().chain, createReq({ title: 'Bound', display_order: order }));
        assert.equal(res.status, 201, `display_order=${order} must be accepted`);
        assert.equal(res.body.lesson.display_order, order);
    }
    const refused = [-1, 2147483648, 1.5, '3', true, null, Number.NaN];
    for (const order of refused) {
        const harness = build();
        const res = await runChain(harness.chain, createReq({ title: 'Bound', display_order: order }));
        assert.equal(res.status, 400, `display_order=${JSON.stringify(order)} must be refused 400`);
        assert.equal(harness.connectionCount(), 0);
    }
});

test('create: strict payload — unknown, selector, asset and status keys are refused 400 with no connection', async () => {
    const invalid: any[] = [
        {},
        { title: 'x', status: 'archived' },
        { title: 'x', course_id: COURSE_A2 },
        { title: 'x', unit_id: UNIT_A2 },
        { title: 'x', owner_user_id: OWNER_A },
        { title: 'x', id: LESSON_1 },
        { title: 'x', video_url: 'https://example.invalid/v.mp4' },
        { title: 'x', asset_id: 'asset-1' },
        { title: 'x', material_id: 'material-1' },
        { title: 'x', student_id: STUDENT },
        { title: 'x', is_published: true },
        { title: 'x', price: 10 },
        { title: 'x', drip_days: 3 },
        { title: 5 },
        { title: null },
        { title: 'x', description: 5 },
        { title: 'x', description: {} },
        [],
        null,
        'a string',
        42,
    ];
    for (const body of invalid) {
        const harness = build();
        const res = await runChain(harness.chain, makeReq({ token: ownerToken(), method: 'POST', pathName: lessonsPath(COURSE_A1, UNIT_A1), body }));
        assert.equal(res.status, 400, `body=${JSON.stringify(body)} must be refused 400`);
        assert.deepEqual(res.body, { error: 'Invalid course lesson payload' });
        assert.equal(res.headers['Cache-Control'], 'no-store');
        assert.equal(harness.connectionCount(), 0);
        assert.deepEqual(harness.calls, []);
    }
});

test('create: an explicit null description is stored as null', async () => {
    const harness = build();
    const res = await runChain(harness.chain, createReq({ title: 'Null description', description: null }));
    assert.equal(res.status, 201);
    assert.equal(res.body.lesson.description, null);
    const insert = harness.calls.find(c => squash(c.sql) === INSERT_SQL);
    assert.equal(insert?.params[3], null);
});

test('create: an unreadable epoch projection fails the write and never commits', async () => {
    for (const variant of ['null', 'zero', 'nan', 'text', 'missing'] as const) {
        const state = makeState();
        state.malformedEpoch = variant;
        const harness = build(state);
        const res = await withSilencedErrors(() => runChain(harness.chain, createReq({ title: 'Doomed' })));
        assert.equal(res.status, 500, `${variant}: an unreadable instant must fail the create`);
        assert.deepEqual(res.body, { error: 'Failed to create course lesson' });
        assert.equal(harness.commitCount(), 0, `${variant}: nothing may be committed`);
        assert.equal(harness.releaseCount(), 1);
        assert.equal(state.lessons.length, 6, `${variant}: no lesson row may survive the rollback`);
    }
});

// ---------------------------------------------------------------------------
// PATCH update
// ---------------------------------------------------------------------------

test('update: the owner retitles, describes, reorders, archives and reactivates one lesson', async () => {
    const harness = build();
    const renamed = await runChain(harness.chain, updateReq(LESSON_2, { title: '  Renamed  ' }));
    assert.equal(renamed.status, 200);
    assertLessonDto(renamed.body.lesson);
    assert.equal(renamed.body.lesson.title, 'Renamed');
    assert.equal(renamed.body.lesson.description, null, 'an omitted description is preserved');
    assert.deepEqual(harness.events,
        ['begin', 'owner', 'course', 'unit', 'lesson_lock', 'update', 'audit', 'lesson_select', 'commit', 'release']);
    assert.equal(squash(harness.calls[3].sql), LESSON_LOCK_SELECT);
    assert.deepEqual(harness.calls[3].params, [LESSON_2, UNIT_A1], 'the lesson is qualified by the unit of the path');
    const update = harness.calls.find(c => squash(c.sql) === UPDATE_SQL);
    assert.deepEqual(update?.params, ['Renamed', null, 1, 'active', null, LESSON_2, UNIT_A1]);
    const audit = harness.auditRows[0].params;
    assert.equal(audit[3], 'course.lesson_updated');
    assert.equal(audit[4], 'course_lesson');
    assert.equal(audit[5], LESSON_2);
    assert.deepEqual(JSON.parse(audit[6]), {
        course_id: COURSE_A1, unit_id: UNIT_A1, lesson_id: LESSON_2,
        title: 'Lesson two', description: null, display_order: 1, status: 'active',
        release_at: null, prerequisite_lesson_id: null,
    });
    assert.deepEqual(JSON.parse(audit[7]), {
        course_id: COURSE_A1, unit_id: UNIT_A1, lesson_id: LESSON_2,
        title: 'Renamed', description: null, display_order: 1, status: 'active',
        release_at: null, prerequisite_lesson_id: null,
    });

    const archived = await runChain(harness.chain, updateReq(LESSON_2, { status: 'archived' }));
    assert.equal(archived.status, 200);
    assert.equal(archived.body.lesson.status, 'archived');

    const reactivated = await runChain(harness.chain, updateReq(LESSON_2, { status: 'active' }));
    assert.equal(reactivated.status, 200);
    assert.equal(reactivated.body.lesson.status, 'active');

    const reordered = await runChain(harness.chain, updateReq(LESSON_2, { display_order: 9 }));
    assert.equal(reordered.status, 200);
    assert.equal(reordered.body.lesson.display_order, 9);
    // Only the selected lesson moved: the other lessons keep their positions.
    assert.equal(harness.state.lessons.find(l => l.id === LESSON_1)?.display_order, 0);
    assert.equal(harness.state.lessons.find(l => l.id === LESSON_3)?.display_order, 1);
});

test('update: an explicit null description clears the stored description', async () => {
    const harness = build();
    const res = await runChain(harness.chain, updateReq(LESSON_1, { description: null }));
    assert.equal(res.status, 200);
    assert.equal(res.body.lesson.description, null);
    const update = harness.calls.find(c => squash(c.sql) === UPDATE_SQL);
    assert.equal(update?.params[1], null);
});

test('update: an identical update is a truthful no-op — no write, no audit, current DTO', async () => {
    const harness = build();
    const res = await runChain(harness.chain, updateReq(LESSON_1, {
        title: 'Lesson one', description: 'First lesson', display_order: 0, status: 'active',
    }));
    assert.equal(res.status, 200);
    assert.equal(res.body.lesson.id, LESSON_1);
    assert.equal(res.body.lesson.title, 'Lesson one');
    assert.deepEqual(harness.events, ['begin', 'owner', 'course', 'unit', 'lesson_lock', 'rollback', 'release'],
        'a no-op issues no UPDATE, no audit and no commit');
    assert.equal(harness.calls.filter(c => squash(c.sql) === UPDATE_SQL).length, 0);
    assert.deepEqual(harness.auditRows, []);
    assert.equal(harness.commitCount(), 0);
    assert.equal(res.headers['Cache-Control'], 'no-store');
});

test('update: strict payload — empty, unknown, invalid status and invalid values are refused 400', async () => {
    const invalid: any[] = [
        {},
        { name: 'x' },
        { title: 'x', unit_id: UNIT_A2 },
        { title: 'x', status: 'published' },
        { title: 'x', status: 'ACTIVE' },
        { title: 'x', status: 1 },
        { title: '' },
        { title: 7 },
        { display_order: -1 },
        { display_order: '2' },
        { display_order: 1.25 },
        { description: 5 },
        { description: [] },
        [],
        null,
        'text',
    ];
    for (const body of invalid) {
        const harness = build();
        const res = await runChain(harness.chain, updateReq(LESSON_1, body));
        assert.equal(res.status, 400, `body=${JSON.stringify(body)} must be refused 400`);
        assert.deepEqual(res.body, { error: 'Invalid course lesson update payload' });
        assert.equal(harness.connectionCount(), 0);
    }
});

test('update: a malformed lesson id is refused 400 before any connection', async () => {
    for (const lessonId of ['not-a-uuid', '12345', '11110000-0000-4000-8000-00000000000']) {
        const harness = build();
        const res = await runChain(harness.chain, updateReq(lessonId, { title: 'x' }));
        assert.equal(res.status, 400);
        assert.deepEqual(res.body, { error: 'Invalid course lesson id' });
        assert.equal(harness.connectionCount(), 0);
    }
});

test('update: a lesson of another unit or another tenant is the identical 404', async () => {
    for (const lessonId of [LESSON_OTHER_UNIT, LESSON_UNIT_B, ABSENT_LESSON]) {
        const harness = build();
        const res = await runChain(harness.chain, updateReq(lessonId, { title: 'Hijack' }));
        assert.equal(res.status, 404, `lessonId=${lessonId} must be a 404`);
        assert.deepEqual(res.body, { error: 'Course lesson not found' });
        assert.equal(res.headers['Cache-Control'], 'no-store');
        assert.equal(harness.calls.filter(c => squash(c.sql) === UPDATE_SQL).length, 0, 'no foreign row may be written');
        assert.deepEqual(harness.auditRows, []);
        assert.equal(harness.releaseCount(), 1);
    }
});

test('update: a zero-row update is a 409 with nothing audited', async () => {
    const state = makeState();
    state.affectedRowsOverride = 0;
    const harness = build(state);
    const res = await runChain(harness.chain, updateReq(LESSON_1, { title: 'Raced' }));
    assert.equal(res.status, 409);
    assert.deepEqual(res.body, { error: 'Course lesson was modified concurrently' });
    assert.deepEqual(harness.auditRows, []);
    assert.equal(harness.commitCount(), 0);
    assert.equal(harness.releaseCount(), 1);
});

test('update: an unreadable epoch projection fails the write and never commits', async () => {
    for (const variant of ['null', 'zero', 'nan', 'text', 'missing'] as const) {
        const state = makeState();
        state.malformedEpoch = variant;
        const harness = build(state);
        const res = await withSilencedErrors(() => runChain(harness.chain, updateReq(LESSON_1, { title: 'Doomed' })));
        assert.equal(res.status, 500, `${variant}: an unreadable instant must fail the update`);
        assert.deepEqual(res.body, { error: 'Failed to update course lesson' });
        assert.equal(harness.commitCount(), 0);
        assert.equal(harness.releaseCount(), 1);
        assert.equal(state.lessons.find(l => l.id === LESSON_1)?.title, 'Lesson one', `${variant}: the row must be restored`);
    }
});

// ---------------------------------------------------------------------------
// Authority — verified owner only
// ---------------------------------------------------------------------------

test('every route: a billing-only instructor is refused 403 before any database access', async () => {
    const token = sign(BILLING_ONLY, 'instructor');
    const cases: Array<{ label: string; req: any }> = [
        { label: 'list', req: listReq({}, COURSE_A1, UNIT_A1, token) },
        { label: 'create', req: createReq({ title: 'Lesson' }, COURSE_A1, UNIT_A1, token) },
        { label: 'update', req: updateReq(LESSON_1, { title: 'Lesson' }, COURSE_A1, UNIT_A1, token) },
        { label: 'reorder', req: makeReq({ token, method: 'POST', pathName: reorderPath(COURSE_A1, UNIT_A1), body: { items: [{ id: LESSON_1, display_order: 5 }] } }) },
    ];
    for (const entry of cases) {
        const harness = build();
        const res = await runChain(harness.chain, entry.req);
        assert.equal(res.status, 403, `${entry.label}: billing-only must be refused 403`);
        assert.equal(res.body.code, 'BILLING_ONLY');
        assert.match(res.body.error, /lesson management/i, `${entry.label}: the local guard is distinguishable`);
        assert.equal(harness.connectionCount(), 0, `${entry.label}: billing-only must not open a transaction`);
        assert.deepEqual(harness.calls, []);
    }
});

test('every route: a membership instructor and a role label without the owner row are refused 403', async () => {
    const cases: Array<{ label: string; token: string }> = [
        { label: 'membership instructor', token: sign(INSTRUCTOR_A, 'instructor') },
        { label: 'owner role label without the real owner row', token: sign(ROLE_OWNER_MEMBER, 'instructor') },
    ];
    for (const entry of cases) {
        const harness = build();
        const list = await runChain(harness.chain, listReq({}, COURSE_A1, UNIT_A1, entry.token));
        assert.equal(list.status, 403, `${entry.label}: the list must be refused 403`);
        assert.deepEqual(list.body, { error: 'Forbidden' });
        assert.equal(list.headers['Cache-Control'], 'no-store');
        assert.equal(harness.calls.filter(c => squash(c.sql) === LIST_SQL).length, 0, `${entry.label}: no lesson row may be read`);

        const create = await runChain(harness.chain, createReq({ title: 'Lesson' }, COURSE_A1, UNIT_A1, entry.token));
        assert.equal(create.status, 403, `${entry.label}: the create must be refused 403`);
        assert.equal(harness.calls.filter(c => squash(c.sql) === INSERT_SQL).length, 0);
        assert.equal(harness.commitCount(), 0);
    }
});

test('every route: a student, an unscoped admin, no scope and an ambiguous scope are refused', async () => {
    const student = build();
    const studentRes = await runChain(student.chain, listReq({}, COURSE_A1, UNIT_A1, sign(STUDENT, 'student', { student_enrollment_id: 'enrollment-1' })));
    assert.equal(studentRes.status, 403);
    assert.equal(student.calls.filter(c => squash(c.sql) === LIST_SQL).length, 0);

    const admin = build();
    const adminRes = await runChain(admin.chain, listReq({}, COURSE_A1, UNIT_A1, sign(ADMIN, 'admin')));
    assert.equal(adminRes.status, 404);
    assert.deepEqual(adminRes.body, { error: 'Tenant membership not found' });
    assert.equal(admin.connectionCount(), 0);

    const noScope = build();
    const noScopeRes = await runChain(noScope.chain, listReq({}, COURSE_A1, UNIT_A1, sign(NO_SCOPE, 'instructor')));
    assert.equal(noScopeRes.status, 404);
    assert.equal(noScope.connectionCount(), 0);

    const multi = build();
    const multiRes = await runChain(multi.chain, listReq({}, COURSE_A1, UNIT_A1, sign(MULTI, 'instructor')));
    assert.equal(multiRes.status, 404, 'an ambiguous multi-tenant scope without a selection is refused 404');
    assert.equal(multi.connectionCount(), 0);
});

test('every route: an inactive tenant is refused 403 and an inactive caller is revoked 401', async () => {
    const suspendedState = makeState();
    suspendedState.tenants.find(t => t.id === TENANT_A)!.status = 'suspended';
    const suspended = build(suspendedState);
    const suspendedRes = await runChain(suspended.chain, listReq());
    assert.equal(suspendedRes.status, 403);
    assert.deepEqual(suspendedRes.body, { error: 'Forbidden' });
    assert.equal(suspended.calls.filter(c => squash(c.sql) === LIST_SQL).length, 0);

    const revokedState = makeState();
    revokedState.users[OWNER_A].is_active = 0;
    const revoked = build(revokedState);
    const revokedRes = await runChain(revoked.chain, listReq());
    assert.equal(revokedRes.status, 401, 'a revoked identity never reaches the lesson route');
    assert.equal(revoked.connectionCount(), 0);
    assert.deepEqual(revoked.calls, []);
});

test('every route: an owner of another tenant selecting this tenant is refused 403', async () => {
    const state = makeState();
    state.memberships[OWNER_B] = [TENANT_B, TENANT_A];
    const harness = build(state);
    const res = await runChain(harness.chain, listReq({}, COURSE_A1, UNIT_A1, sign(OWNER_B, 'instructor', { tenant_id: TENANT_A })));
    assert.equal(res.status, 403);
    assert.deepEqual(res.body, { error: 'Forbidden' });
    assert.equal(harness.calls.filter(c => squash(c.sql) === LIST_SQL).length, 0);
});

test('every route: an unauthenticated request is refused 401 by the upstream middleware', async () => {
    const harness = build();
    const res = await runChain(harness.chain, listReq({}, COURSE_A1, UNIT_A1, null));
    assert.equal(res.status, 401);
    assert.equal(harness.connectionCount(), 0);
});

test('every route: a client supplied tenant selector is refused 400 by the boundary', async () => {
    const cases: Array<{ label: string; req: any }> = [
        { label: 'list', req: makeReq({ token: ownerToken(), method: 'GET', pathName: lessonsPath(COURSE_A1, UNIT_A1), query: { tenant_id: TENANT_B } }) },
        { label: 'create', req: makeReq({ token: ownerToken(), method: 'POST', pathName: lessonsPath(COURSE_A1, UNIT_A1), body: { title: 'Lesson', tenant_id: TENANT_B } }) },
        { label: 'update', req: makeReq({ token: ownerToken(), method: 'PATCH', pathName: lessonPath(COURSE_A1, UNIT_A1, LESSON_1), body: { title: 'Lesson', tenant_id: TENANT_B } }) },
    ];
    for (const entry of cases) {
        const harness = build();
        const res = await runChain(harness.chain, entry.req);
        assert.equal(res.status, 400, `${entry.label}: a client tenant selector must be refused 400`);
        assert.deepEqual(res.body, { error: 'Tenant context must not be supplied by the client' });
        assert.equal(harness.connectionCount(), 0);
    }
});

test('every route: a malformed course or unit id is refused 400 before any database access', async () => {
    const harness = build();
    const badCourse = await runChain(harness.chain, listReq({}, 'not-a-uuid'));
    assert.equal(badCourse.status, 400);
    assert.deepEqual(badCourse.body, { error: 'Invalid course id' });
    assert.equal(badCourse.headers['Cache-Control'], 'no-store');

    const badUnit = await runChain(harness.chain, listReq({}, COURSE_A1, 'not-a-uuid'));
    assert.equal(badUnit.status, 400);
    assert.deepEqual(badUnit.body, { error: 'Invalid course unit id' });
    assert.equal(harness.connectionCount(), 0);
    assert.deepEqual(harness.calls, []);
});

test('every route: a foreign, an inactive, a tenant-less and an absent course are the identical 404', async () => {
    for (const courseId of [COURSE_B1, COURSE_INACTIVE, COURSE_NULL, ABSENT_COURSE]) {
        const harness = build();
        const res = await runChain(harness.chain, listReq({}, courseId));
        assert.equal(res.status, 404, `courseId=${courseId} must be a 404`);
        assert.deepEqual(res.body, { error: 'Course not found' });
        assert.equal(harness.calls.filter(c => squash(c.sql) === LIST_SQL).length, 0);
    }
});

test('every route: a foreign unit, a unit of another course and an absent unit are the identical 404', async () => {
    const cases: Array<[string, string]> = [
        [COURSE_A1, UNIT_B1],   // another tenant's unit
        [COURSE_A1, UNIT_A2],   // a unit of another course
        [COURSE_A1, ABSENT_UNIT],
    ];
    for (const [courseId, unitId] of cases) {
        const harness = build();
        const list = await runChain(harness.chain, listReq({}, courseId, unitId));
        assert.equal(list.status, 404, `unitId=${unitId} must be a 404`);
        assert.deepEqual(list.body, { error: 'Course unit not found' });
        assert.equal(list.headers['Cache-Control'], 'no-store');

        const create = await runChain(harness.chain, createReq({ title: 'Lesson' }, courseId, unitId));
        assert.equal(create.status, 404, `create unitId=${unitId} must be a 404`);
        assert.deepEqual(create.body, { error: 'Course unit not found' });
        assert.equal(harness.calls.filter(c => squash(c.sql) === INSERT_SQL).length, 0);
        assert.equal(harness.commitCount(), 0);
    }
});

test('every route: an empty path segment never reaches a lesson handler', async () => {
    const harness = build();
    const res = await runChain(harness.chain, makeReq({ token: ownerToken(), method: 'GET', pathName: `/catalog/courses/${COURSE_A1}/units//lessons` }));
    assert.equal(res.status, 0, 'no lesson handler may answer an unroutable path');
    assert.equal(harness.connectionCount(), 0);
});

// ---------------------------------------------------------------------------
// Connection lifecycle and failure modes
// ---------------------------------------------------------------------------

test('lifecycle: a failed connection acquisition reports 500 with no cleanup', async () => {
    const state = makeState();
    state.failAcquire = true;
    const harness = build(state);
    const res = await withSilencedErrors(() => runChain(harness.chain, listReq()));
    assert.equal(res.status, 500);
    assert.deepEqual(res.body, { error: 'Failed to list course lessons' });
    assert.equal(harness.releaseCount(), 0);
    assert.equal(harness.destroyCount(), 0, 'a connection that does not exist is not cleaned up');
});

test('lifecycle: a failed beginTransaction discards the unconfirmed connection', async () => {
    const state = makeState();
    state.failBegin = true;
    const harness = build(state);
    const res = await withSilencedErrors(() => runChain(harness.chain, createReq({ title: 'Lesson' })));
    assert.equal(res.status, 500);
    assert.deepEqual(res.body, { error: 'Failed to create course lesson' });
    assert.equal(harness.releaseCount(), 0, 'an unconfirmed connection is never pooled');
    assert.equal(harness.destroyCount(), 1);
});

test('lifecycle: a failed owner, course, unit or list read rolls back and releases once', async () => {
    const entries: Array<{ flag: 'failOwnerSelect' | 'failCourseSelect' | 'failUnitSelect' | 'failList' }> = [
        { flag: 'failOwnerSelect' },
        { flag: 'failCourseSelect' },
        { flag: 'failUnitSelect' },
        { flag: 'failList' },
    ];
    for (const entry of entries) {
        const state = makeState();
        state[entry.flag] = true;
        const harness = build(state);
        const res = await withSilencedErrors(() => runChain(harness.chain, listReq()));
        assert.equal(res.status, 500, `${entry.flag}: must be a 500`);
        assert.deepEqual(res.body, { error: 'Failed to list course lessons' }, `${entry.flag}: no internal detail may leak`);
        assert.equal(harness.rollbackCount(), 1, `${entry.flag}: exactly one rollback`);
        assert.equal(harness.releaseCount(), 1, `${entry.flag}: exactly one release`);
        assert.equal(harness.destroyCount(), 0);
    }
});

test('lifecycle: a failed insert, audit, read-back or lesson lookup rolls back and releases once', async () => {
    const entries: Array<{ flag: 'failInsert' | 'failAudit' | 'failReadBack' | 'failLessonSelect'; label: string; kind: 'create' | 'update' }> = [
        { flag: 'failInsert', label: 'insert', kind: 'create' },
        { flag: 'failAudit', label: 'audit', kind: 'update' },
        { flag: 'failReadBack', label: 'read-back', kind: 'update' },
        { flag: 'failLessonSelect', label: 'lesson lookup', kind: 'update' },
    ];
    for (const entry of entries) {
        const state = makeState();
        state[entry.flag] = true;
        const harness = build(state);
        const req = entry.kind === 'create' ? createReq({ title: 'Doomed' }) : updateReq(LESSON_1, { title: 'Doomed' });
        const res = await withSilencedErrors(() => runChain(harness.chain, req));
        const expected = entry.kind === 'create' ? { error: 'Failed to create course lesson' } : { error: 'Failed to update course lesson' };
        assert.equal(res.status, 500, `${entry.label}: must be a 500`);
        assert.deepEqual(res.body, expected);
        assert.equal(harness.rollbackCount(), 1, `${entry.label}: exactly one rollback`);
        assert.equal(harness.releaseCount(), 1, `${entry.label}: exactly one release`);
        assert.equal(harness.commitCount(), 0, `${entry.label}: nothing may be committed`);
        assert.equal(harness.destroyCount(), 0);
    }
});

test('lifecycle: a failed rollback destroys the connection and never releases it', async () => {
    const state = makeState();
    state.failRollback = true;
    const harness = build(state);
    // The truthful no-op path rolls back without committing, so the failed
    // rollback is the cleanup under test.
    const res = await withSilencedErrors(() => runChain(harness.chain, updateReq(LESSON_1, { title: 'Lesson one' })));
    assert.equal(res.status, 200, 'the truthful no-op answer is still returned');
    assert.equal(harness.releaseCount(), 0, 'a failed rollback must never release');
    assert.equal(harness.destroyCount(), 1, 'a failed rollback must destroy');
});

test('lifecycle: a lost commit acknowledgement destroys the connection and claims nothing', async () => {
    for (const [label, req] of [
        ['create', createReq({ title: 'Uncertain' })],
        ['update', updateReq(LESSON_1, { title: 'Uncertain' })],
    ] as Array<[string, any]>) {
        const state = makeState();
        state.failCommit = true;
        const harness = build(state);
        const res = await withSilencedErrors(() => runChain(harness.chain, req));
        assert.equal(res.status, 500, `${label}: a lost commit ack is a 500`);
        assert.equal(harness.releaseCount(), 0, `${label}: an uncertain connection is never pooled`);
        assert.equal(harness.destroyCount(), 1, `${label}: an uncertain connection is destroyed`);
        assert.equal(harness.rollbackCount(), 0, `${label}: no rollback may be claimed after a commit attempt`);
        assert.equal(harness.commitCount(), 0, `${label}: the commit did not acknowledge`);
    }
});

test('every response: exactly one response and no-store on the handler answers', async () => {
    const harness = build();
    const results = [
        await runChain(harness.chain, listReq()),
        await runChain(harness.chain, listReq({ limit: '0' })),
        await runChain(harness.chain, createReq({})),
        await runChain(harness.chain, createReq({ title: 'Created' })),
        await runChain(harness.chain, updateReq(LESSON_1, {})),
        await runChain(harness.chain, updateReq(LESSON_1, { title: 'Updated' })),
        await runChain(harness.chain, listReq({}, COURSE_B1)),
        await runChain(harness.chain, listReq({}, COURSE_A1, UNIT_A1, sign(INSTRUCTOR_A, 'instructor'))),
    ];
    for (const res of results) {
        assert.equal(res.responseCount, 1, `exactly one response for status ${res.status}`);
        assert.equal(res.headers['Cache-Control'], 'no-store');
    }
});

test('migration file: additive only, no tenant/course duplication, FK to the unit', () => {
    const file = path.join(__dirname, '../migrations/20261021_01_course_lessons.sql');
    const raw = fs.readFileSync(file, 'utf8');
    const sql = raw.replace(/--[^\n]*/g, '');    assert.match(sql, /CREATE TABLE IF NOT EXISTS course_lessons/);
    assert.match(sql, /id CHAR\(36\) PRIMARY KEY/);
    assert.match(sql, /unit_id CHAR\(36\) NOT NULL/);
    assert.match(sql, /FOREIGN KEY \(unit_id\) REFERENCES course_units\(id\)/);
    assert.match(sql, /INDEX idx_course_lessons_page \(unit_id,display_order,id\)/);
    assert.match(sql, /status ENUM\('active','archived'\)/);
    assert.match(sql, /CHECK \(display_order >= 0\)/);
    assert.match(sql, /ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci/);
    assert.ok(!/\btenant_id\b/.test(sql), 'the tenant is derived, never duplicated');
    assert.ok(!/\bcourse_id\b/.test(sql), 'the course is derived through the unit, never duplicated');
    // `ON UPDATE CURRENT_TIMESTAMP` is the column definition, not a statement.
    const statements = sql.replace(/ON UPDATE CURRENT_TIMESTAMP/g, '');
    assert.ok(!/\b(ALTER|DROP|TRUNCATE|DELETE|INSERT|UPDATE|REPLACE)\b/i.test(statements), 'the file must be additive only');
    assert.ok(!/ON DELETE/i.test(sql), 'a deleting parent must be refused, never cascade or orphan');
    assert.ok(LIST_SQL.includes(LESSON_PROJECTION), 'the list reads the epoch projection, never a raw datetime column');
    assert.ok(LIST_SQL.includes('UNIX_TIMESTAMP(l.created_at) AS created_at_epoch'));
    assert.ok(LIST_SQL.includes('UNIX_TIMESTAMP(l.updated_at) AS updated_at_epoch'));
});
