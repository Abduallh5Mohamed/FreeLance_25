/**
 * M2-B05 — atomic bounded lesson reorder (hermetic, behavioral).
 *
 * Contract under test:
 *   POST /api/tenants/me/catalog/courses/:courseId/units/:unitId/lessons/reorder
 * accepts ONLY `{items:[{id,display_order}]}` (1..100 unique canonical ids,
 * already-integer positions), proves in ONE transaction that the caller is the
 * verified owner of the server-selected tenant, that the course is active and
 * owned by that tenant and that the unit belongs to the course, then locks the
 * selected lesson rows in a deterministic id order and proves that EVERY id
 * belongs to the bound unit BEFORE any update or audit. A foreign or missing
 * id is the identical 404 and the whole batch rolls back — there is no
 * partial success. A selected lesson whose position is unchanged is a
 * truthful no-op (no UPDATE, no audit); every changed row gets one bounded
 * audit event and the batch commits once.
 *
 * The fixture replays the transaction (a snapshot on `beginTransaction` is
 * restored on `rollback`), so a leaked partial batch is observable instead of
 * hidden. Real row locking, real concurrency and a real MySQL transaction are
 * explicitly NOT exercised or claimed.
 *
 * The fixture also emulates the DECLARED collation of the lesson id: the
 * migration declares `course_lessons.id` as `CHAR(36)` in a
 * `utf8mb4_unicode_ci` table, so an uppercase uuid addresses the very same
 * stored row as its lowercase spelling. The suite therefore proves that ONE
 * canonical identity is used for the uniqueness check, the lock order, the SQL
 * binds and the locked-row lookup, and that the STORED identity is what the
 * response and the audit event carry.
 */
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import path from 'node:path';
import {
    ABSENT_COURSE, ABSENT_LESSON, ABSENT_UNIT, ADMIN, BATCH_LOCK_PREFIX, BATCH_LOCK_SUFFIX, BILLING_ONLY, COURSE_A1,
    COURSE_A2, COURSE_B1, COURSE_INACTIVE, COURSE_NULL, COURSE_SELECT, INSTRUCTOR_A, LESSON_1,
    LESSON_2, LESSON_3, LESSON_ARCHIVED, LESSON_OTHER_UNIT, LESSON_UNIT_B, NO_SCOPE, OWNER_A,
    OWNER_B, OWNER_SELECT, REORDER_UPDATE_SQL, ROLE_OWNER_MEMBER, STUDENT, TENANT_A, TENANT_B,
    UNIT_A1, UNIT_A2, UNIT_B1, UNIT_C1, UNIT_SELECT, assertLessonDto, buildHarness, canonicalStoredId,
    createIsolation, loadAppModules, makeReq, makeState, ownerToken, reorderPath, runChain, sameStoredId,
    sign, squash, stamp, withSilencedErrors,
} from './helpers/m2-course-lessons-harness';

const isolation = createIsolation();
const originalSecret = process.env.JWT_SECRET;
process.env.JWT_SECRET = 'm2-b05-hermetic-jwt-secret-not-a-real-key';

after(() => {
    if (originalSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = originalSecret;
    assert.equal(isolation.hookRestored(), true, 'the loader hook must be restored after loading');
    assert.deepEqual(isolation.sentinelCalls, [], 'no forbidden default adapter may be called by this suite');
});

let loadError: unknown = null;
let modules: any;
try {
    modules = loadAppModules(isolation, path.join(__dirname, '../src/routes/tenant-self'));
} catch (error) {
    loadError = error;
}

const build = (state = makeState()) => buildHarness(state, modules);
const orderOf = (harness: any, lessonId: string) =>
    harness.state.lessons.find((l: any) => l.id === lessonId)?.display_order;

// ---------------------------------------------------------------------------
// Composition and success paths
// ---------------------------------------------------------------------------

test('reorder: the real tenant-self mount exposes the batch route', () => {
    assert.equal(loadError, null, `the production composition must load through the sentinels: ${String(loadError)}`);
});

test('reorder: the owner atomically sets the positions of the selected lessons', async () => {
    const state = makeState();
    const harness = build(state);
    const res = await runChain(harness.chain, makeReq({
        token: ownerToken(),
        method: 'POST',
        pathName: reorderPath(COURSE_A1, UNIT_A1),
        body: { items: [{ id: LESSON_1, display_order: 10 }, { id: LESSON_2, display_order: 5 }] },
    }));

    assert.equal(res.status, 200);
    assert.deepEqual(Object.keys(res.body), ['lessons']);
    for (const lesson of res.body.lessons) assertLessonDto(lesson);
    // The response is the selection in the RESULTING (display_order,id) order.
    assert.deepEqual(res.body.lessons.map((l: any) => l.id), [LESSON_2, LESSON_1]);
    assert.deepEqual(res.body.lessons.map((l: any) => l.display_order), [5, 10]);
    assert.equal(res.headers['Cache-Control'], 'no-store');

    assert.deepEqual(harness.events,
        ['begin', 'owner', 'course', 'unit', 'batch_lock', 'reorder_update', 'audit', 'reorder_update', 'audit', 'batch_read', 'commit', 'release'],
        'one transaction: lock parents, lock the selection in id order, write and audit each change, read back, commit');
    assert.equal(squash(harness.calls[0].sql), `${OWNER_SELECT} FOR UPDATE`);
    assert.equal(squash(harness.calls[1].sql), `${COURSE_SELECT} FOR UPDATE`);
    assert.equal(squash(harness.calls[2].sql), `${UNIT_SELECT} FOR UPDATE`);
    assert.deepEqual(harness.calls[2].params, [UNIT_A1, COURSE_A1]);
    // The selection is locked in ascending id order, not in payload order.
    const lockCall = harness.calls[3];
    assert.ok(squash(lockCall.sql).startsWith(BATCH_LOCK_PREFIX), 'the selection is locked with one bounded statement');
    assert.ok(squash(lockCall.sql).endsWith('ORDER BY l.id ASC FOR UPDATE'));
    assert.deepEqual(lockCall.params, [UNIT_A1, LESSON_1, LESSON_2], 'the ids are bound in ascending order');
    assert.equal(harness.commitCount(), 1, 'the batch commits exactly once');
    assert.equal(harness.releaseCount(), 1);
    assert.equal(harness.destroyCount(), 0);

    assert.equal(orderOf(harness, LESSON_1), 10);
    assert.equal(orderOf(harness, LESSON_2), 5);
    // Only the selected rows moved.
    assert.equal(orderOf(harness, LESSON_3), 1);
    assert.equal(orderOf(harness, LESSON_ARCHIVED), 2);
});

test('reorder: each changed row gets one bounded audit event with the derived scope', async () => {
    const harness = build();
    await runChain(harness.chain, makeReq({
        token: ownerToken(),
        method: 'POST',
        pathName: reorderPath(COURSE_A1, UNIT_A1),
        body: { items: [{ id: LESSON_1, display_order: 7 }] },
    }));

    assert.equal(harness.auditRows.length, 1, 'exactly one audit event for one changed row');
    const audit = harness.auditRows[0].params;
    assert.equal(audit[1], OWNER_A, 'the actor is the verified owner');
    assert.equal(audit[2], TENANT_A, 'the tenant is the DERIVED selected tenant');
    assert.equal(audit[3], 'course.lesson_reordered');
    assert.equal(audit[4], 'course_lesson');
    assert.equal(audit[5], LESSON_1);
    assert.deepEqual(JSON.parse(audit[6]), {
        course_id: COURSE_A1, unit_id: UNIT_A1, lesson_id: LESSON_1, display_order: 0,
    }, 'the old position is the locked value');
    assert.deepEqual(JSON.parse(audit[7]), {
        course_id: COURSE_A1, unit_id: UNIT_A1, lesson_id: LESSON_1, display_order: 7,
    }, 'the new position is the requested value');
});

test('reorder: a no-op row writes and audits nothing, and a pure no-op batch commits nothing', async () => {
    const state = makeState();
    const harness = build(state);
    const res = await runChain(harness.chain, makeReq({
        token: ownerToken(),
        method: 'POST',
        pathName: reorderPath(COURSE_A1, UNIT_A1),
        body: { items: [{ id: LESSON_1, display_order: 0 }, { id: LESSON_2, display_order: 1 }] },
    }));
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.lessons.map((l: any) => l.id), [LESSON_1, LESSON_2],
        'the unchanged selection is returned in its current order');
    assert.equal(harness.calls.filter(c => squash(c.sql) === REORDER_UPDATE_SQL).length, 0, 'no UPDATE for an unchanged row');
    assert.deepEqual(harness.auditRows, [], 'no audit event for an unchanged row');
    assert.equal(harness.commitCount(), 0, 'a pure no-op batch commits nothing');
    assert.deepEqual(harness.events,
        ['begin', 'owner', 'course', 'unit', 'batch_lock', 'batch_read', 'rollback', 'release']);
});

test('reorder: a no-op and a changed row in one batch writes and audits only the changed one', async () => {
    const harness = build();
    const res = await runChain(harness.chain, makeReq({
        token: ownerToken(),
        method: 'POST',
        pathName: reorderPath(COURSE_A1, UNIT_A1),
        body: { items: [{ id: LESSON_1, display_order: 0 }, { id: LESSON_2, display_order: 4 }] },
    }));
    assert.equal(res.status, 200);
    assert.equal(harness.calls.filter(c => squash(c.sql) === REORDER_UPDATE_SQL).length, 1, 'exactly one write');
    assert.equal(harness.auditRows.length, 1, 'exactly one audit event');
    assert.equal(harness.auditRows[0].params[5], LESSON_2);
    assert.equal(harness.commitCount(), 1);
    assert.equal(orderOf(harness, LESSON_1), 0, 'the no-op row keeps its position');
    assert.equal(orderOf(harness, LESSON_2), 4);
});

test('reorder: tied numeric positions are allowed and the id stays the tie-breaker', async () => {
    const harness = build();
    const res = await runChain(harness.chain, makeReq({
        token: ownerToken(),
        method: 'POST',
        pathName: reorderPath(COURSE_A1, UNIT_A1),
        body: { items: [{ id: LESSON_1, display_order: 3 }, { id: LESSON_2, display_order: 3 }] },
    }));
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.lessons.map((l: any) => l.id), [LESSON_1, LESSON_2], 'the id breaks the tie');
    assert.deepEqual(res.body.lessons.map((l: any) => l.display_order), [3, 3]);
    // No mass renumbering: no other lesson was touched.
    assert.equal(orderOf(harness, LESSON_3), 1);
    assert.equal(orderOf(harness, LESSON_ARCHIVED), 2);
});

test('reorder: exactly 100 items are accepted and 101 are refused before any connection', async () => {
    const state = makeState();
    // 100 synthetic lessons of the unit, all at order 500.
    for (let index = 0; index < 100; index += 1) {
        state.lessons.push({
            id: `70000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
            unit_id: UNIT_A1, title: `Batch ${index}`, description: null,
            display_order: 500, status: 'active', created_at: new Date(Date.UTC(2026, 9, 21, 9, 0, 0)),
            updated_at: new Date(Date.UTC(2026, 9, 21, 9, 0, 0)),
        });
    }
    const hundred = state.lessons.filter(l => l.unit_id === UNIT_A1).slice(-100)
        .map((l, index) => ({ id: l.id, display_order: 600 + index }));

    const accepted = build(state);
    const ok = await runChain(accepted.chain, makeReq({
        token: ownerToken(), method: 'POST', pathName: reorderPath(COURSE_A1, UNIT_A1), body: { items: hundred },
    }));
    assert.equal(ok.status, 200, 'a batch of exactly 100 selected lessons is accepted');
    assert.equal(ok.body.lessons.length, 100, 'the response is bounded to the selection');
    assert.equal(accepted.auditRows.length, 100, 'one audit event per changed row');

    const refused = build(state);
    const tooMany = await runChain(refused.chain, makeReq({
        token: ownerToken(), method: 'POST', pathName: reorderPath(COURSE_A1, UNIT_A1),
        body: { items: [...hundred, { id: LESSON_1, display_order: 1 }] },
    }));
    assert.equal(tooMany.status, 400, '101 items are refused');
    assert.deepEqual(tooMany.body, { error: 'Invalid course lesson reorder payload' });
    assert.equal(refused.connectionCount(), 0);
});

// ---------------------------------------------------------------------------
// Strict payload
// ---------------------------------------------------------------------------

test('reorder: strict payload — shape, keys, ids, duplicates and positions', async () => {
    const invalid: any[] = [
        undefined,
        null,
        [],
        {},
        { items: [] },
        { items: {} },
        { items: 'x' },
        { items: [{ id: LESSON_1, display_order: 1 }], extra: true },
        { items: [{ id: LESSON_1 }] },
        { items: [{ display_order: 1 }] },
        { items: [{ id: 'not-a-uuid', display_order: 1 }] },
        { items: [{ id: LESSON_1, display_order: -1 }] },
        { items: [{ id: LESSON_1, display_order: 2147483648 }] },
        { items: [{ id: LESSON_1, display_order: 1.5 }] },
        { items: [{ id: LESSON_1, display_order: '1' }] },
        { items: [{ id: LESSON_1, display_order: null }] },
        { items: [{ id: LESSON_1, display_order: 1, status: 'archived' }] },
        { items: [{ id: LESSON_1, display_order: 1 }, { id: LESSON_1, display_order: 2 }] },
        { items: [LESSON_1] },
        { items: [null] },
    ];
    for (const body of invalid) {
        const harness = build();
        const res = await runChain(harness.chain, makeReq({
            token: ownerToken(), method: 'POST', pathName: reorderPath(COURSE_A1, UNIT_A1), body,
        }));
        assert.equal(res.status, 400, `body=${JSON.stringify(body)} must be refused 400`);
        assert.deepEqual(res.body, { error: 'Invalid course lesson reorder payload' });
        assert.equal(res.headers['Cache-Control'], 'no-store');
        assert.equal(harness.connectionCount(), 0, 'a malformed batch must not open a transaction');
        assert.deepEqual(harness.calls, []);
    }
});

test('reorder: a malformed course, unit or client tenant selector is refused before any connection', async () => {
    const cases: Array<{ label: string; req: any; status: number; body: any }> = [
        {
            label: 'course', status: 400, body: { error: 'Invalid course id' },
            req: makeReq({ token: ownerToken(), method: 'POST', pathName: reorderPath('not-a-uuid', UNIT_A1), body: { items: [{ id: LESSON_1, display_order: 1 }] } }),
        },
        {
            label: 'unit', status: 400, body: { error: 'Invalid course unit id' },
            req: makeReq({ token: ownerToken(), method: 'POST', pathName: reorderPath(COURSE_A1, 'not-a-uuid'), body: { items: [{ id: LESSON_1, display_order: 1 }] } }),
        },
        {
            label: 'selector', status: 400, body: { error: 'Tenant context must not be supplied by the client' },
            req: makeReq({ token: ownerToken(), method: 'POST', pathName: reorderPath(COURSE_A1, UNIT_A1), body: { items: [{ id: LESSON_1, display_order: 1 }], tenant_id: TENANT_B } }),
        },
    ];
    for (const entry of cases) {
        const harness = build();
        const res = await runChain(harness.chain, entry.req);
        assert.equal(res.status, entry.status, `${entry.label}: unexpected status`);
        assert.deepEqual(res.body, entry.body, `${entry.label}: unexpected body`);
        assert.equal(harness.connectionCount(), 0, `${entry.label}: no transaction may be opened`);
    }
});

// ---------------------------------------------------------------------------
// Authority and parent scope
// ---------------------------------------------------------------------------

test('reorder: a billing-only instructor is refused 403 before any database access', async () => {
    const harness = build();
    const res = await runChain(harness.chain, makeReq({
        token: sign(BILLING_ONLY, 'instructor'), method: 'POST',
        pathName: reorderPath(COURSE_A1, UNIT_A1), body: { items: [{ id: LESSON_1, display_order: 1 }] },
    }));
    assert.equal(res.status, 403);
    assert.equal(res.body.code, 'BILLING_ONLY');
    assert.equal(harness.connectionCount(), 0);
});

test('reorder: a non-owner, a role label, a student and an unscoped admin are refused', async () => {
    const cases: Array<{ label: string; token: string; status: number }> = [
        { label: 'membership instructor', token: sign(INSTRUCTOR_A, 'instructor'), status: 403 },
        { label: 'owner role label', token: sign(ROLE_OWNER_MEMBER, 'instructor'), status: 403 },
        { label: 'student', token: sign(STUDENT, 'student', { student_enrollment_id: 'enrollment-1' }), status: 403 },
        { label: 'unscoped admin', token: sign(ADMIN, 'admin'), status: 404 },
        { label: 'no scope', token: sign(NO_SCOPE, 'instructor'), status: 404 },
    ];
    for (const entry of cases) {
        const state = makeState();
        const harness = build(state);
        const res = await runChain(harness.chain, makeReq({
            token: entry.token, method: 'POST', pathName: reorderPath(COURSE_A1, UNIT_A1),
            body: { items: [{ id: LESSON_1, display_order: 99 }] },
        }));
        assert.equal(res.status, entry.status, `${entry.label}: unexpected status`);
        assert.equal(harness.calls.filter(c => squash(c.sql) === REORDER_UPDATE_SQL).length, 0, `${entry.label}: no row may be written`);
        assert.equal(orderOf(harness, LESSON_1), 0, `${entry.label}: no position may change`);
        assert.equal(harness.commitCount(), 0);
    }
});

test('reorder: a foreign, an inactive, a tenant-less and an absent course are the identical 404', async () => {
    for (const courseId of [COURSE_B1, COURSE_INACTIVE, COURSE_NULL, ABSENT_COURSE]) {
        const state = makeState();
        const harness = build(state);
        const res = await runChain(harness.chain, makeReq({
            token: ownerToken(), method: 'POST', pathName: reorderPath(courseId, UNIT_A1),
            body: { items: [{ id: LESSON_1, display_order: 9 }] },
        }));
        assert.equal(res.status, 404, `courseId=${courseId} must be a 404`);
        assert.deepEqual(res.body, { error: 'Course not found' });
        assert.equal(harness.calls.filter(c => squash(c.sql) === REORDER_UPDATE_SQL).length, 0);
        assert.equal(orderOf(harness, LESSON_1), 0);
    }
});

test('reorder: an owner of another tenant selecting this tenant is refused 403', async () => {
    const state = makeState();
    state.memberships[OWNER_B] = [TENANT_B, TENANT_A];
    const harness = build(state);
    const res = await runChain(harness.chain, makeReq({
        token: sign(OWNER_B, 'instructor', { tenant_id: TENANT_A }), method: 'POST',
        pathName: reorderPath(COURSE_A1, UNIT_A1), body: { items: [{ id: LESSON_1, display_order: 9 }] },
    }));
    assert.equal(res.status, 403);
    assert.deepEqual(res.body, { error: 'Forbidden' });
    assert.equal(harness.calls.filter(c => squash(c.sql) === REORDER_UPDATE_SQL).length, 0);
    assert.equal(orderOf(harness, LESSON_1), 0);
});

test('reorder: a foreign unit, a unit of another course and an absent unit are the identical 404', async () => {
    const cases: Array<[string, string]> = [
        [COURSE_A1, UNIT_B1],
        [COURSE_A1, UNIT_A2],
        [COURSE_A1, ABSENT_UNIT],
        [COURSE_A1, UNIT_C1],
    ];
    for (const [courseId, unitId] of cases) {
        const harness = build();
        const res = await runChain(harness.chain, makeReq({
            token: ownerToken(), method: 'POST', pathName: reorderPath(courseId, unitId),
            body: { items: [{ id: LESSON_OTHER_UNIT, display_order: 9 }] },
        }));
        assert.equal(res.status, 404, `unitId=${unitId} must be a 404`);
        assert.deepEqual(res.body, { error: 'Course unit not found' });
        assert.equal(harness.calls.filter(c => squash(c.sql) === REORDER_UPDATE_SQL).length, 0);
        assert.equal(harness.commitCount(), 0);
    }
});

// ---------------------------------------------------------------------------
// Full prevalidation — no partial success
// ---------------------------------------------------------------------------

test('reorder: one foreign or missing id in the batch is the identical 404 and rolls the whole batch back', async () => {
    const cases: Array<{ label: string; id: string }> = [
        { label: 'absent', id: ABSENT_LESSON },
        { label: 'lesson of another unit of the same course', id: LESSON_OTHER_UNIT },
        { label: 'lesson of another tenant', id: LESSON_UNIT_B },
    ];
    for (const entry of cases) {
        const state = makeState();
        const harness = build(state);
        const res = await runChain(harness.chain, makeReq({
            token: ownerToken(), method: 'POST', pathName: reorderPath(COURSE_A1, UNIT_A1),
            body: { items: [{ id: LESSON_1, display_order: 50 }, { id: entry.id, display_order: 51 }] },
        }));
        assert.equal(res.status, 404, `${entry.label}: a mixed batch must be a 404`);
        assert.deepEqual(res.body, { error: 'Course lesson not found' }, `${entry.label}: no ownership is disclosed`);
        assert.equal(harness.calls.filter(c => squash(c.sql) === REORDER_UPDATE_SQL).length, 0,
            `${entry.label}: NO row may be updated before every id is proven`);
        assert.deepEqual(harness.auditRows, [], `${entry.label}: nothing may be audited`);
        assert.equal(harness.commitCount(), 0, `${entry.label}: nothing may be committed`);
        assert.equal(harness.rollbackCount(), 1, `${entry.label}: exactly one rollback`);
        assert.equal(harness.releaseCount(), 1);
        assert.equal(orderOf(harness, LESSON_1), 0, `${entry.label}: the valid row must be restored`);
        assert.equal(harness.state.lessons.find((l: any) => l.id === LESSON_UNIT_B)?.display_order, 0);
    }
});

test('reorder: the scope proof precedes every write and every audit', async () => {
    const harness = build();
    await runChain(harness.chain, makeReq({
        token: ownerToken(), method: 'POST', pathName: reorderPath(COURSE_A1, UNIT_A1),
        body: { items: [{ id: LESSON_1, display_order: 8 }, { id: LESSON_2, display_order: 9 }] },
    }));
    const events = harness.events;
    const lockIndex = events.indexOf('batch_lock');
    assert.ok(lockIndex > 0, 'the selection is locked');
    const firstWrite = events.indexOf('reorder_update');
    const firstAudit = events.indexOf('audit');
    assert.ok(lockIndex < firstWrite, 'the batch lock precedes every write');
    assert.ok(lockIndex < firstAudit, 'the batch lock precedes every audit');
    // One lock statement covers the whole selection: no per-row lock read.
    assert.equal(harness.calls.filter(c => squash(c.sql).startsWith(BATCH_LOCK_PREFIX) && squash(c.sql).endsWith(BATCH_LOCK_SUFFIX)).length, 1);
});

test('reorder: a failed batch-lock read rolls back with no write and no audit', async () => {
    const state = makeState();
    state.failBatchLock = true;
    const harness = build(state);
    const res = await withSilencedErrors(() => runChain(harness.chain, makeReq({
        token: ownerToken(), method: 'POST', pathName: reorderPath(COURSE_A1, UNIT_A1),
        body: { items: [{ id: LESSON_1, display_order: 5 }] },
    })));
    assert.equal(res.status, 500);
    assert.deepEqual(res.body, { error: 'Failed to reorder course lessons' });
    assert.equal(harness.calls.filter(c => squash(c.sql) === REORDER_UPDATE_SQL).length, 0);
    assert.deepEqual(harness.auditRows, []);
    assert.equal(harness.releaseCount(), 1);
    assert.equal(orderOf(harness, LESSON_1), 0);
});

// ---------------------------------------------------------------------------
// Failure mid-batch — atomicity and honest uncertainty
// ---------------------------------------------------------------------------

test('reorder: a failure on the second update restores every row and audits nothing', async () => {
    const state = makeState();
    state.failReorderUpdateAt = 2;
    const harness = build(state);
    const res = await withSilencedErrors(() => runChain(harness.chain, makeReq({
        token: ownerToken(), method: 'POST', pathName: reorderPath(COURSE_A1, UNIT_A1),
        body: { items: [{ id: LESSON_1, display_order: 40 }, { id: LESSON_2, display_order: 41 }] },
    })));
    assert.equal(res.status, 500);
    assert.deepEqual(res.body, { error: 'Failed to reorder course lessons' });
    assert.equal(harness.calls.filter(c => squash(c.sql) === REORDER_UPDATE_SQL).length, 2, 'the first write happened before the failure');
    assert.equal(harness.events.filter(e => e === 'audit').length, 1, 'the first audit insert happened before the failure');
    assert.deepEqual(harness.auditRows, [], 'the audit of the first write was rolled back with it');
    assert.equal(harness.commitCount(), 0, 'nothing may be committed');
    assert.equal(harness.rollbackCount(), 1);
    assert.equal(harness.releaseCount(), 1);
    assert.equal(harness.destroyCount(), 0);
    // The transactional fixture restores the snapshot: no partial batch leaks.
    assert.equal(orderOf(harness, LESSON_1), 0, 'the first write must be rolled back');
    assert.equal(orderOf(harness, LESSON_2), 1);
});

test('reorder: a failure on the second audit restores every row', async () => {
    const state = makeState();
    state.failAuditAt = 2;
    const harness = build(state);
    const res = await withSilencedErrors(() => runChain(harness.chain, makeReq({
        token: ownerToken(), method: 'POST', pathName: reorderPath(COURSE_A1, UNIT_A1),
        body: { items: [{ id: LESSON_1, display_order: 40 }, { id: LESSON_2, display_order: 41 }] },
    })));
    assert.equal(res.status, 500);
    assert.equal(harness.calls.filter(c => squash(c.sql) === REORDER_UPDATE_SQL).length, 2);
    assert.equal(harness.events.filter(e => e === 'audit').length, 2, 'the first audit insert succeeded before the second failed');
    assert.deepEqual(harness.auditRows, [], 'no audit event may survive the rollback');
    assert.equal(harness.commitCount(), 0);
    assert.equal(harness.rollbackCount(), 1);
    assert.equal(orderOf(harness, LESSON_1), 0, 'the batch is atomic: no partial position survives');
    assert.equal(orderOf(harness, LESSON_2), 1);
});

test('reorder: an incomplete read-back fails the batch and commits nothing', async () => {
    const state = makeState();
    state.failBatchRead = true;
    const harness = build(state);
    const res = await withSilencedErrors(() => runChain(harness.chain, makeReq({
        token: ownerToken(), method: 'POST', pathName: reorderPath(COURSE_A1, UNIT_A1),
        body: { items: [{ id: LESSON_1, display_order: 6 }] },
    })));
    assert.equal(res.status, 500);
    assert.deepEqual(res.body, { error: 'Failed to reorder course lessons' });
    assert.equal(harness.commitCount(), 0, 'the DTOs are materialized before the commit');
    assert.equal(harness.rollbackCount(), 1);
    assert.equal(orderOf(harness, LESSON_1), 0);
});

test('reorder: a zero-row update is a 409 that rolls the batch back', async () => {
    const state = makeState();
    state.affectedRowsOverride = 0;
    const harness = build(state);
    const res = await runChain(harness.chain, makeReq({
        token: ownerToken(), method: 'POST', pathName: reorderPath(COURSE_A1, UNIT_A1),
        body: { items: [{ id: LESSON_1, display_order: 6 }] },
    }));
    assert.equal(res.status, 409);
    assert.deepEqual(res.body, { error: 'Course lesson was modified concurrently' });
    assert.deepEqual(harness.auditRows, []);
    assert.equal(harness.commitCount(), 0);
    assert.equal(harness.rollbackCount(), 1);
    assert.equal(harness.releaseCount(), 1);
});

test('reorder: an unreadable epoch projection fails the batch and never commits', async () => {
    for (const variant of ['null', 'zero', 'nan', 'text', 'missing'] as const) {
        const state = makeState();
        state.malformedEpoch = variant;
        const harness = build(state);
        const res = await withSilencedErrors(() => runChain(harness.chain, makeReq({
            token: ownerToken(), method: 'POST', pathName: reorderPath(COURSE_A1, UNIT_A1),
            body: { items: [{ id: LESSON_1, display_order: 6 }] },
        })));
        assert.equal(res.status, 500, `${variant}: an unreadable instant must fail the batch`);
        assert.deepEqual(res.body, { error: 'Failed to reorder course lessons' });
        assert.equal(harness.commitCount(), 0, `${variant}: nothing may be committed`);
        assert.equal(orderOf(harness, LESSON_1), 0, `${variant}: the position must be restored`);
    }
});

test('reorder: a lost commit acknowledgement destroys the connection and claims nothing', async () => {
    const state = makeState();
    state.failCommit = true;
    const harness = build(state);
    const res = await withSilencedErrors(() => runChain(harness.chain, makeReq({
        token: ownerToken(), method: 'POST', pathName: reorderPath(COURSE_A1, UNIT_A1),
        body: { items: [{ id: LESSON_1, display_order: 6 }] },
    })));
    assert.equal(res.status, 500);
    assert.equal(harness.releaseCount(), 0, 'an uncertain connection is never pooled');
    assert.equal(harness.destroyCount(), 1, 'an uncertain connection is destroyed');
    assert.equal(harness.rollbackCount(), 0, 'no rollback may be claimed after a commit attempt');
});

test('reorder: a failed rollback destroys the connection and never releases it', async () => {
    const state = makeState();
    state.failRollback = true;
    const harness = build(state);
    const res = await withSilencedErrors(() => runChain(harness.chain, makeReq({
        token: ownerToken(), method: 'POST', pathName: reorderPath(COURSE_A1, UNIT_A1),
        body: { items: [{ id: ABSENT_LESSON, display_order: 6 }] },
    })));
    assert.equal(res.status, 404, 'the denial answer itself is unchanged');
    assert.equal(harness.releaseCount(), 0);
    assert.equal(harness.destroyCount(), 1);
});

test('reorder: a failed acquisition or begin performs the honest cleanup', async () => {
    const acquireState = makeState();
    acquireState.failAcquire = true;
    const acquireHarness = build(acquireState);
    const acquireRes = await withSilencedErrors(() => runChain(acquireHarness.chain, makeReq({
        token: ownerToken(), method: 'POST', pathName: reorderPath(COURSE_A1, UNIT_A1),
        body: { items: [{ id: LESSON_1, display_order: 6 }] },
    })));
    assert.equal(acquireRes.status, 500);
    assert.equal(acquireHarness.releaseCount(), 0);
    assert.equal(acquireHarness.destroyCount(), 0, 'a connection that does not exist is not cleaned up');

    const beginState = makeState();
    beginState.failBegin = true;
    const beginHarness = build(beginState);
    const beginRes = await withSilencedErrors(() => runChain(beginHarness.chain, makeReq({
        token: ownerToken(), method: 'POST', pathName: reorderPath(COURSE_A1, UNIT_A1),
        body: { items: [{ id: LESSON_1, display_order: 6 }] },
    })));
    assert.equal(beginRes.status, 500);
    assert.equal(beginHarness.releaseCount(), 0);
    assert.equal(beginHarness.destroyCount(), 1, 'an unconfirmed connection is discarded');
});

test('reorder: exactly one response is produced on every outcome', async () => {
    const cases: any[] = [
        makeReq({ token: ownerToken(), method: 'POST', pathName: reorderPath(COURSE_A1, UNIT_A1), body: { items: [{ id: LESSON_1, display_order: 6 }] } }),
        makeReq({ token: ownerToken(), method: 'POST', pathName: reorderPath(COURSE_A1, UNIT_A1), body: { items: [] } }),
        makeReq({ token: ownerToken(), method: 'POST', pathName: reorderPath(COURSE_A1, UNIT_A1), body: { items: [{ id: ABSENT_LESSON, display_order: 1 }] } }),
        makeReq({ token: null, method: 'POST', pathName: reorderPath(COURSE_A1, UNIT_A1), body: { items: [{ id: LESSON_1, display_order: 6 }] } }),
    ];
    for (const req of cases) {
        const res = await runChain(build().chain, req);
        assert.equal(res.responseCount, 1, `exactly one response for status ${res.status}`);
    }
});

// ---------------------------------------------------------------------------
// UUID identity — the declared case-insensitive collation
// ---------------------------------------------------------------------------

/** A lesson id that contains hex LETTERS, so its case variants are real. */
const LESSON_HEX = 'a1100000-0000-4000-8000-00000000000b';
/** A lesson id of ANOTHER unit that contains hex letters. */
const LESSON_HEX_FOREIGN = 'a2200000-0000-4000-8000-00000000000c';
/** A stored id whose spelling is NOT lowercase. */
const LESSON_MIXED_STORED = 'a3300000-0000-4000-8000-00000000000D';

const withHexLesson = (unitId = UNIT_A1, id = LESSON_HEX, displayOrder = 3) => {
    const state = makeState();
    state.lessons.push({
        id, unit_id: unitId, title: 'Hex lesson', description: null,
        display_order: displayOrder, status: 'active', created_at: stamp(8, 30), updated_at: stamp(8, 30),
    });
    return state;
};

const lockCallOf = (harness: any) =>
    harness.calls.find((c: any) => squash(c.sql).startsWith(BATCH_LOCK_PREFIX));

test('reorder: the fixture emulates the declared case-insensitive id collation', () => {
    assert.equal(sameStoredId(LESSON_HEX, LESSON_HEX.toUpperCase()), true,
        'the declared utf8mb4_unicode_ci collation compares the id case-insensitively');
    assert.equal(sameStoredId(LESSON_HEX, LESSON_HEX_FOREIGN), false,
        'two different ids never match');
    assert.equal(canonicalStoredId(LESSON_HEX.toUpperCase()), LESSON_HEX,
        'one id has exactly one canonical identity');
});

test('reorder: an uppercase uuid addresses the same stored lesson', async () => {
    const state = withHexLesson();
    const harness = build(state);
    const res = await runChain(harness.chain, makeReq({
        token: ownerToken(), method: 'POST', pathName: reorderPath(COURSE_A1, UNIT_A1),
        body: { items: [{ id: LESSON_HEX.toUpperCase(), display_order: 12 }] },
    }));

    assert.equal(res.status, 200, 'an uppercase uuid names the same row under the declared collation');
    assert.equal(res.body.lessons.length, 1);
    assertLessonDto(res.body.lessons[0]);
    assert.equal(res.body.lessons[0].id, LESSON_HEX, 'the DTO carries the STORED identity');
    assert.equal(res.body.lessons[0].display_order, 12);
    assert.equal(state.lessons.find(l => l.id === LESSON_HEX)?.display_order, 12, 'the addressed row really moved');
    // The batch binds the CANONICAL identity of the requested id.
    assert.deepEqual(lockCallOf(harness).params, [UNIT_A1, LESSON_HEX.toLowerCase()]);
    assert.equal(harness.auditRows.length, 1, 'one changed row, one audit event');
    assert.equal(harness.auditRows[0].params[5], LESSON_HEX, 'the audit names the STORED identity');
    assert.equal(harness.commitCount(), 1);
    assert.equal(harness.releaseCount(), 1);
    assert.equal(harness.destroyCount(), 0);
});

test('reorder: the case variants of one uuid are one identity and are refused before any connection', async () => {
    const mixed = 'A1100000-0000-4000-8000-00000000000b';
    const variants: Array<[string, string]> = [
        [LESSON_HEX, LESSON_HEX.toUpperCase()],
        [LESSON_HEX.toUpperCase(), LESSON_HEX],
        [LESSON_HEX.toUpperCase(), mixed],
        [mixed, LESSON_HEX],
    ];
    for (const [first, second] of variants) {
        const harness = build();
        const res = await runChain(harness.chain, makeReq({
            token: ownerToken(), method: 'POST', pathName: reorderPath(COURSE_A1, UNIT_A1),
            body: { items: [{ id: first, display_order: 1 }, { id: second, display_order: 2 }] },
        }));
        assert.equal(res.status, 400, `${first}/${second} must be refused`);
        assert.deepEqual(res.body, { error: 'Invalid course lesson reorder payload' });
        assert.equal(harness.connectionCount(), 0, 'a duplicate identity must not open a transaction');
        assert.deepEqual(harness.calls, [], 'no statement may be issued');
        assert.deepEqual(harness.events, [], 'not even a transaction may be started');
    }
});

test('reorder: a mixed-case selection writes and audits every selected row exactly once', async () => {
    const state = withHexLesson();
    const harness = build(state);
    const res = await runChain(harness.chain, makeReq({
        token: ownerToken(), method: 'POST', pathName: reorderPath(COURSE_A1, UNIT_A1),
        body: { items: [
            { id: LESSON_HEX.toUpperCase(), display_order: 30 },
            { id: LESSON_1, display_order: 31 },
        ] },
    }));

    assert.equal(res.status, 200);
    assert.equal(res.body.lessons.length, 2);
    assert.equal(harness.calls.filter((c: any) => squash(c.sql) === REORDER_UPDATE_SQL).length, 2, 'one write per changed row');
    assert.equal(harness.auditRows.length, 2, 'one audit event per changed row');
    assert.equal(harness.commitCount(), 1);
    // The ids are bound in ascending CANONICAL order, not in payload order.
    assert.deepEqual(lockCallOf(harness).params, [UNIT_A1, LESSON_1, LESSON_HEX.toLowerCase()]);
    assert.equal(harness.auditRows[0].params[5], LESSON_1);
    assert.equal(harness.auditRows[1].params[5], LESSON_HEX);
    assert.equal(state.lessons.find(l => l.id === LESSON_1)?.display_order, 31);
    assert.equal(state.lessons.find(l => l.id === LESSON_HEX)?.display_order, 30);
});

test('reorder: a mixed-case selection that contains a foreign id is the identical 404 with no write', async () => {
    const state = withHexLesson();
    state.lessons.push({
        id: LESSON_HEX_FOREIGN, unit_id: UNIT_A2, title: 'Foreign hex lesson', description: null,
        display_order: 0, status: 'active', created_at: stamp(8, 35), updated_at: stamp(8, 35),
    });
    const harness = build(state);
    const res = await runChain(harness.chain, makeReq({
        token: ownerToken(), method: 'POST', pathName: reorderPath(COURSE_A1, UNIT_A1),
        body: { items: [
            { id: LESSON_HEX.toUpperCase(), display_order: 30 },
            { id: LESSON_HEX_FOREIGN.toUpperCase(), display_order: 31 },
        ] },
    }));

    assert.equal(res.status, 404, 'a foreign id is the identical not-found answer');
    assert.deepEqual(res.body, { error: 'Course lesson not found' });
    assert.equal(harness.calls.filter((c: any) => squash(c.sql) === REORDER_UPDATE_SQL).length, 0,
        'NO row may be updated before every id is proven');
    assert.deepEqual(harness.auditRows, [], 'nothing may be audited');
    assert.equal(harness.commitCount(), 0);
    assert.equal(harness.rollbackCount(), 1);
    assert.equal(harness.releaseCount(), 1);
    assert.equal(state.lessons.find(l => l.id === LESSON_HEX)?.display_order, 3, 'the valid row must be restored');
});

test('reorder: an unknown uuid is the identical 404 and never a crash', async () => {
    const state = withHexLesson();
    const harness = build(state);
    const res = await runChain(harness.chain, makeReq({
        token: ownerToken(), method: 'POST', pathName: reorderPath(COURSE_A1, UNIT_A1),
        body: { items: [{ id: 'a1100000-0000-4000-8000-0000000000ff'.toUpperCase(), display_order: 4 }] },
    }));

    assert.equal(res.status, 404);
    assert.deepEqual(res.body, { error: 'Course lesson not found' });
    assert.equal(harness.calls.filter((c: any) => squash(c.sql) === REORDER_UPDATE_SQL).length, 0);
    assert.deepEqual(harness.auditRows, []);
    assert.equal(harness.commitCount(), 0);
    assert.equal(harness.rollbackCount(), 1);
    assert.equal(harness.releaseCount(), 1);
});

test('reorder: a stored id that is not lowercase is answered with the stored identity', async () => {
    const state = withHexLesson(UNIT_A1, LESSON_MIXED_STORED, 4);
    const harness = build(state);
    const res = await runChain(harness.chain, makeReq({
        token: ownerToken(), method: 'POST', pathName: reorderPath(COURSE_A1, UNIT_A1),
        body: { items: [{ id: LESSON_MIXED_STORED.toLowerCase(), display_order: 9 }] },
    }));

    assert.equal(res.status, 200);
    assert.equal(res.body.lessons.length, 1);
    assert.equal(res.body.lessons[0].id, LESSON_MIXED_STORED, 'the STORED spelling is preserved in the DTO');
    assert.equal(res.body.lessons[0].display_order, 9);
    assert.equal(state.lessons.find(l => l.id === LESSON_MIXED_STORED)?.display_order, 9);
    assert.equal(harness.auditRows.length, 1);
    assert.equal(harness.auditRows[0].params[5], LESSON_MIXED_STORED, 'the audit names the STORED identity');
    assert.equal(harness.commitCount(), 1);
});
