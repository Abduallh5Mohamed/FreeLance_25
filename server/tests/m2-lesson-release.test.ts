/**
 * M2-23 — scheduled lesson release and configured prerequisite progression
 * (hermetic, behavioral).
 *
 * Contract under test:
 *   POST  /api/tenants/me/catalog/courses/:courseId/units/:unitId/lessons
 *   PATCH /api/tenants/me/catalog/courses/:courseId/units/:unitId/lessons/:lessonId
 *
 * The accepted M2-B05 lesson metadata contract is EXTENDED with exactly two
 * optional, explicitly nullable fields:
 *
 *   release_at              canonical UTC ISO-8601 instant or null
 *   prerequisite_lesson_id  canonical lesson id or null
 *
 * The suite pins:
 *   * strict payload validation (a local time, an offset, a date-only string,
 *     an epoch number, an impossible calendar date and an out-of-TIMESTAMP-range
 *     instant are all refused BEFORE a connection is taken);
 *   * the canonical UTC projection of a stored instant (epoch -> ISO), and the
 *     fact that a retried request carrying a sub-second remainder is a truthful
 *     no-op rather than a rewrite;
 *   * the prerequisite rule: same course, ACTIVE, and strictly EARLIER under
 *     `(display_order, id)` — so self, forward, foreign, archived and cyclic
 *     configuration is refused;
 *   * that a patch moving the target AND setting its prerequisite is judged
 *     against the target's FINAL position;
 *   * truthful no-ops (no UPDATE, no audit, no commit) and atomic sanitized
 *     audit on a real change;
 *   * the full failure/disposal matrix: failed update, failed audit, failed
 *     read-back, uncertain commit, failed rollback and failed acquisition.
 *
 * The suite is hermetic: it loads the REAL tenant-self mount and the REAL
 * lesson router through the shared sentinel harness, with a fixture-backed
 * transactional connection. No database, network, provider, dotenv file or
 * listener is used, and no migration is applied.
 */
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import {
    AUDIT_SQL, COURSE_A1, COURSE_B1, INSERT_SQL, INSERT_SQL_WITH_RELEASE, LESSON_1, LESSON_2, LESSON_3,
    LESSON_ARCHIVED, LESSON_LATER, LESSON_UNIT_B, OWNER_A, REORDER_UPDATE_SQL, TENANT_A, UNIT_A1,
    UNIT_A1_ARCHIVED, UNIT_A1_LATER, UNIT_SELECT, UPDATE_SQL, UPDATE_SQL_WITH_RELEASE,
    assertLessonDto, buildHarness, createIsolation, createReq, loadAppModules, makeState,
    reorderReq, runChain, sign, squash, stamp, updateReq, withSilencedErrors,
} from './helpers/m2-course-lessons-harness';
import type { State } from './helpers/m2-course-lessons-harness';

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

/** 2026-11-01T09:00:00Z — the canonical instant this suite configures. */
const RELEASE_ISO = '2026-11-01T09:00:00.000Z';
const RELEASE_EPOCH = Math.floor(Date.UTC(2026, 10, 1, 9, 0, 0) / 1000);
const RELEASE_DATE = new Date(RELEASE_EPOCH * 1000);

/** Strip `--` comments so a prose mention of a statement is never mistaken for one. */
const executableSql = (sql: string): string =>
    sql
        .split('\n')
        .map(line => line.replace(/--.*$/, ''))
        .join('\n');

// ---------------------------------------------------------------------------
// Migration file: the collision with the legacy `lesson_completions` table
// ---------------------------------------------------------------------------

const migrationPath = path.join(__dirname, '../migrations/20261023_04_lesson_release_progress.sql');
const legacyMigrationPath = path.join(__dirname, '../migrations/20261018_03_content_release_progress.sql');

test('migration: the completion ledger is `course_lesson_completions`, never the legacy `lesson_completions`', () => {
    const sql = fs.readFileSync(migrationPath, 'utf8');
    assert.match(sql, /CREATE TABLE IF NOT EXISTS course_lesson_completions \(/,
        'the new ledger must have its own table name');
    // `lesson_completions` is MENTIONED in the explanatory header (to explain
    // why the name is not reused), so the check runs on the executable
    // statements only.
    assert.equal(
        /(CREATE|ALTER|DROP)\s+TABLE\s+(IF NOT EXISTS\s+)?`?lesson_completions`?\s*\(/i.test(executableSql(sql)),
        false,
        'this batch must never redefine or alter the legacy lesson_completions table',
    );
    assert.match(sql, /student_enrollment_id CHAR\(36\) NOT NULL/,
        'completions are keyed by the enrollment, not by a client-selected student');
    assert.match(sql, /REFERENCES students\(id\)/, 'the enrollment FK points at students(id)');
    assert.match(sql, /REFERENCES course_lessons\(id\)/, 'the lesson FK points at course_lessons(id)');
    assert.match(sql, /UNIQUE KEY uq_course_lesson_completions_enrollment_lesson \(student_enrollment_id, lesson_id\)/,
        'one completion per enrollment and lesson is the idempotency guarantee');
});

test('migration: the legacy content-release file still owns `lesson_completions` and is untouched', () => {
    const legacy = fs.readFileSync(legacyMigrationPath, 'utf8');
    assert.match(legacy, /CREATE TABLE lesson_completions \(/,
        'the 20261018 table is a different feature and must keep its own name');
    assert.match(legacy, /lecture_id CHAR\(36\) NOT NULL/,
        'the legacy ledger is lecture-keyed, which is why the shapes are incompatible');
});

test('migration: the lesson columns are additive, nullable and carry NO backfill', () => {
    const sql = fs.readFileSync(migrationPath, 'utf8');
    assert.match(sql, /ADD COLUMN release_at TIMESTAMP NULL DEFAULT NULL/, 'release_at is nullable with no default instant');
    assert.match(sql, /ADD COLUMN prerequisite_lesson_id CHAR\(36\) NULL DEFAULT NULL/, 'the prerequisite is optional');
    assert.equal(/\bUPDATE\s+course_lessons\b/i.test(sql), false, 'no backfill: an existing row is never rewritten');
    assert.equal(/\bDROP\b/i.test(sql), false, 'nothing is dropped');
});

// ---------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------

test('composition: the real tenant-self mount exposes the extended lesson routes', () => {
    assert.equal(loadError, null, `the production composition must load through the sentinels: ${String(loadError)}`);
});

// ---------------------------------------------------------------------------
// Create: release schedule
// ---------------------------------------------------------------------------

test('create: a release instant is written with FROM_UNIXTIME and projected as canonical UTC', async () => {
    const harness = build();
    const res = await runChain(harness.chain, createReq({ title: 'Scheduled', release_at: RELEASE_ISO }));

    assert.equal(res.status, 201);
    assertLessonDto(res.body.lesson);
    assert.equal(res.body.lesson.release_at, RELEASE_ISO);
    assert.equal(res.body.lesson.prerequisite_lesson_id, null);

    const insert = harness.calls.find(c => squash(c.sql) === INSERT_SQL_WITH_RELEASE);
    assert.ok(insert, 'the scheduled create used the FROM_UNIXTIME form');
    assert.equal(insert!.params[6], RELEASE_EPOCH, 'the bound value is whole epoch seconds, never a driver Date');
    assert.equal(
        harness.calls.filter(c => squash(c.sql) === INSERT_SQL).length,
        0,
        'the NULL form was not used for a scheduled lesson',
    );

    const audit = harness.auditRows[0].params;
    assert.equal(audit[3], 'course.lesson_created');
    const payload = JSON.parse(audit[7]);
    assert.equal(payload.release_at, RELEASE_ISO, 'the audit records the canonical instant');
    assert.equal(payload.prerequisite_lesson_id, null);
});

test('create: an explicit null release means "no schedule" and binds no instant', async () => {
    const harness = build();
    const res = await runChain(harness.chain, createReq({ title: 'Immediate', release_at: null }));

    assert.equal(res.status, 201);
    assert.equal(res.body.lesson.release_at, null);
    const insert = harness.calls.find(c => squash(c.sql) === INSERT_SQL);
    assert.ok(insert, 'the NULL form is used');
    assert.equal(insert!.params.length, 7, 'no epoch parameter is bound for a NULL schedule');
});

test('create: an omitted release is "no schedule", which is exactly what a pre-M2-23 row carries', async () => {
    const harness = build();
    const res = await runChain(harness.chain, createReq({ title: 'Omitted' }));

    assert.equal(res.status, 201);
    assert.equal(res.body.lesson.release_at, null);
    assert.ok(harness.calls.find(c => squash(c.sql) === INSERT_SQL));
});

test('create: sub-second precision is floored to whole seconds, so a retry cannot rewrite the instant', async () => {
    const harness = build();
    const res = await runChain(harness.chain, createReq({
        title: 'Sub-second',
        release_at: '2026-11-01T09:00:00.900Z',
    }));

    assert.equal(res.status, 201);
    assert.equal(res.body.lesson.release_at, RELEASE_ISO, 'the stored instant is the whole second');
    const insert = harness.calls.find(c => squash(c.sql) === INSERT_SQL_WITH_RELEASE);
    assert.equal(insert!.params[6], RELEASE_EPOCH);
});

test('create: every malformed release instant is refused 400 before a connection is taken', async () => {
    const invalid: any[] = [
        '2026-11-01T09:00:00',            // no zone: a local time is not an instant
        '2026-11-01T09:00:00+02:00',      // an offset is not UTC
        '2026-11-01',                     // a date is not an instant
        '2026-11-01 09:00:00',            // space separator
        '',
        '   ',
        RELEASE_EPOCH,                    // a bare epoch number is not a stated instant
        0,
        true,
        [],
        {},
        '2026-02-30T00:00:00Z',           // impossible calendar date
        '2026-13-01T00:00:00Z',           // impossible month
        '1969-12-31T23:59:59Z',           // below the TIMESTAMP range
        '2039-01-01T00:00:00Z',           // above the TIMESTAMP range
    ];
    for (const release_at of invalid) {
        const harness = build();
        const res = await runChain(harness.chain, createReq({ title: 'Bad', release_at }));
        assert.equal(res.status, 400, `release_at ${JSON.stringify(release_at)} must be refused`);
        assert.equal(res.body.error, 'Invalid course lesson release');
        assert.equal(harness.connectionCount(), 0, 'a malformed payload never opens a connection');
        assert.deepEqual(harness.calls, []);
    }
});

// ---------------------------------------------------------------------------
// Create / patch: prerequisite rule
// ---------------------------------------------------------------------------

test('create: an earlier active same-course prerequisite is accepted and audited', async () => {
    const state = makeState();
    const harness = build(state);
    const res = await runChain(harness.chain, createReq({
        title: 'Second step',
        display_order: 9,
        prerequisite_lesson_id: LESSON_1,
    }));

    assert.equal(res.status, 201);
    assert.equal(res.body.lesson.prerequisite_lesson_id, LESSON_1);
    const insert = harness.calls.find(c => squash(c.sql) === INSERT_SQL);
    assert.equal(insert!.params[insert!.params.length - 1], LESSON_1, 'the canonical id is bound');
    const payload = JSON.parse(harness.auditRows[0].params[7]);
    assert.equal(payload.prerequisite_lesson_id, LESSON_1);
});

test('create: a prerequisite is canonicalised, so an uppercase spelling names the same lesson', async () => {
    const harness = build();
    const res = await runChain(harness.chain, createReq({
        title: 'Upper',
        display_order: 9,
        prerequisite_lesson_id: LESSON_1.toUpperCase(),
    }));

    assert.equal(res.status, 201);
    assert.equal(res.body.lesson.prerequisite_lesson_id, LESSON_1, 'the stored identity is lowercase');
});

test('create: a malformed prerequisite is refused 400 before a connection is taken', async () => {
    for (const prerequisite_lesson_id of ['', 'not-a-uuid', '10000000-0000-4000-8000', 42, true, [], {}]) {
        const harness = build();
        const res = await runChain(harness.chain, createReq({ title: 'Bad', prerequisite_lesson_id }));
        assert.equal(res.status, 400, `prerequisite ${JSON.stringify(prerequisite_lesson_id)} must be refused`);
        assert.equal(res.body.error, 'Invalid course lesson prerequisite');
        assert.equal(harness.connectionCount(), 0);
    }
});

test('create: a prerequisite of another course is refused', async () => {
    const harness = build();
    const res = await runChain(harness.chain, createReq({
        title: 'Foreign prerequisite',
        display_order: 9,
        prerequisite_lesson_id: LESSON_UNIT_B,
    }));

    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'Invalid course lesson prerequisite');
    assert.equal(harness.commitCount(), 0, 'nothing is committed');
    assert.deepEqual(harness.auditRows, [], 'nothing is audited');
});

test('create: an archived prerequisite is refused', async () => {
    const state = makeState();
    // Only the STATUS is the reason: move it to the front so the ordering rule
    // would otherwise accept it.
    state.lessons.find(l => l.id === LESSON_ARCHIVED)!.display_order = 0;
    const harness = build(state);
    const res = await runChain(harness.chain, createReq({
        title: 'Archived prerequisite',
        display_order: 9,
        prerequisite_lesson_id: LESSON_ARCHIVED,
    }));

    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'Invalid course lesson prerequisite');
});

test('create: an absent prerequisite id is refused', async () => {
    const harness = build();
    const res = await runChain(harness.chain, createReq({
        title: 'Absent',
        display_order: 9,
        prerequisite_lesson_id: '99999999-0000-4000-8000-000000000000',
    }));
    assert.equal(res.status, 400);
    assert.equal(harness.commitCount(), 0);
});

test('create: a prerequisite that sorts after the new lesson is refused', async () => {
    const harness = build();
    // The new lesson is placed at position 0; LESSON_2 sits at position 1, so it
    // is FORWARD of the target and cannot gate it.
    const res = await runChain(harness.chain, createReq({
        title: 'Forward',
        display_order: 0,
        prerequisite_lesson_id: LESSON_2,
    }));

    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'Invalid course lesson prerequisite');
});

test('patch: a lesson cannot be its own prerequisite', async () => {
    const harness = build();
    const res = await runChain(harness.chain, updateReq(LESSON_2, { prerequisite_lesson_id: LESSON_2 }));

    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'Invalid course lesson prerequisite');
    assert.equal(harness.commitCount(), 0);
    assert.deepEqual(harness.auditRows, []);
});

test('patch: a case variant of the lesson itself is still the lesson itself', async () => {
    const harness = build();
    const res = await runChain(harness.chain, updateReq(LESSON_2, {
        prerequisite_lesson_id: LESSON_2.toUpperCase(),
    }));
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'Invalid course lesson prerequisite');
});

test('patch: a forward prerequisite (sorts after the target) is refused', async () => {
    const harness = build();
    // LESSON_1 is at position 0; LESSON_2 is at position 1.
    const res = await runChain(harness.chain, updateReq(LESSON_1, { prerequisite_lesson_id: LESSON_2 }));
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'Invalid course lesson prerequisite');
});

test('patch: a tied position is resolved by the id, so only a strictly smaller id qualifies', async () => {
    // LESSON_2 and LESSON_3 both sit at position 1; 002 < 003.
    const accepted = build();
    const ok = await runChain(accepted.chain, updateReq(LESSON_3, { prerequisite_lesson_id: LESSON_2 }));
    assert.equal(ok.status, 200);
    assert.equal(ok.body.lesson.prerequisite_lesson_id, LESSON_2);

    const refused = build();
    const no = await runChain(refused.chain, updateReq(LESSON_2, { prerequisite_lesson_id: LESSON_3 }));
    assert.equal(no.status, 400);
    assert.equal(no.body.error, 'Invalid course lesson prerequisite');
});

test('patch: a prerequisite of another course is refused', async () => {
    const harness = build();
    const res = await runChain(harness.chain, updateReq(LESSON_3, { prerequisite_lesson_id: LESSON_UNIT_B }));
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'Invalid course lesson prerequisite');
});

test('patch: an archived prerequisite is refused', async () => {
    const state = makeState();
    state.lessons.find(l => l.id === LESSON_ARCHIVED)!.display_order = 0;
    const harness = build(state);
    const res = await runChain(harness.chain, updateReq(LESSON_3, { prerequisite_lesson_id: LESSON_ARCHIVED }));
    assert.equal(res.status, 400);
});

test('patch: an out-of-band cycle is detected by the bounded chain walk and refused', async () => {
    const state = makeState();
    // An out-of-band edit produced the chain LESSON_1 -> LESSON_3 -> LESSON_2.
    // Setting LESSON_2 -> LESSON_1 would close the loop, even though 0 < 1
    // satisfies the ordering rule, so only the stored-chain walk can catch it.
    state.lessons.find(l => l.id === LESSON_1)!.prerequisite_lesson_id = LESSON_3;
    state.lessons.find(l => l.id === LESSON_3)!.prerequisite_lesson_id = LESSON_2;
    const harness = build(state);

    const res = await runChain(harness.chain, updateReq(LESSON_2, { prerequisite_lesson_id: LESSON_1 }));

    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'Invalid course lesson prerequisite');
    assert.equal(harness.commitCount(), 0, 'the cycle is never committed');
    assert.deepEqual(harness.auditRows, []);
    assert.ok(harness.events.includes('prerequisite'), 'the candidate was proved');
    assert.ok(harness.events.includes('chain'), 'the stored chain was actually walked');
});

test('patch: a move and a prerequisite in ONE request are judged against the FINAL position', async () => {
    // Moving LESSON_3 to position 0 makes LESSON_2 (position 1) FORWARD.
    const refused = build();
    const no = await runChain(refused.chain, updateReq(LESSON_3, {
        display_order: 0,
        prerequisite_lesson_id: LESSON_2,
    }));
    assert.equal(no.status, 400);
    assert.equal(no.body.error, 'Invalid course lesson prerequisite');

    // Moving LESSON_1 forward to position 5 makes LESSON_3 (position 1) EARLIER.
    const accepted = build();
    const ok = await runChain(accepted.chain, updateReq(LESSON_1, {
        display_order: 5,
        prerequisite_lesson_id: LESSON_3,
    }));
    assert.equal(ok.status, 200);
    assert.equal(ok.body.lesson.display_order, 5);
    assert.equal(ok.body.lesson.prerequisite_lesson_id, LESSON_3);
});

// ---------------------------------------------------------------------------
// Patch: release schedule transitions
// ---------------------------------------------------------------------------

test('patch: setting, keeping and clearing the release instant', async () => {
    const harness = build();

    const set = await runChain(harness.chain, updateReq(LESSON_1, { release_at: RELEASE_ISO }));
    assert.equal(set.status, 200);
    assert.equal(set.body.lesson.release_at, RELEASE_ISO);
    const scheduled = harness.calls.filter(c => squash(c.sql) === UPDATE_SQL_WITH_RELEASE);
    assert.equal(scheduled.length, 1);
    assert.equal(scheduled[0].params[4], RELEASE_EPOCH);

    const cleared = await runChain(harness.chain, updateReq(LESSON_1, { release_at: null }));
    assert.equal(cleared.status, 200);
    assert.equal(cleared.body.lesson.release_at, null);
    const nulled = harness.calls.filter(c => squash(c.sql) === UPDATE_SQL);
    assert.equal(nulled.length, 1);
});

test('patch: an identical release retry is a truthful no-op — no UPDATE, no audit, no commit', async () => {
    const state = makeState();
    state.lessons.find(l => l.id === LESSON_1)!.release_at = RELEASE_DATE;
    const harness = build(state);

    const res = await runChain(harness.chain, updateReq(LESSON_1, { release_at: RELEASE_ISO }));

    assert.equal(res.status, 200);
    assert.equal(res.body.lesson.release_at, RELEASE_ISO);
    assert.equal(harness.calls.filter(c => squash(c.sql) === UPDATE_SQL).length, 0);
    assert.equal(harness.calls.filter(c => squash(c.sql) === UPDATE_SQL_WITH_RELEASE).length, 0);
    assert.deepEqual(harness.auditRows, [], 'no duplicate audit event');
    assert.equal(harness.commitCount(), 0);
    assert.equal(res.headers['Cache-Control'], 'no-store');
});

test('patch: an identical prerequisite retry is a truthful no-op', async () => {
    const state = makeState();
    state.lessons.find(l => l.id === LESSON_2)!.prerequisite_lesson_id = LESSON_1;
    const harness = build(state);

    const res = await runChain(harness.chain, updateReq(LESSON_2, { prerequisite_lesson_id: LESSON_1 }));

    assert.equal(res.status, 200);
    assert.equal(res.body.lesson.prerequisite_lesson_id, LESSON_1);
    assert.equal(harness.calls.filter(c => squash(c.sql) === UPDATE_SQL).length, 0);
    assert.deepEqual(harness.auditRows, []);
    assert.equal(harness.commitCount(), 0);
});

test('patch: a real change commits exactly one sanitized audit event in the same transaction', async () => {
    const harness = build();
    const res = await runChain(harness.chain, updateReq(LESSON_2, {
        release_at: RELEASE_ISO,
        prerequisite_lesson_id: LESSON_1,
    }));

    assert.equal(res.status, 200);
    assert.equal(harness.auditRows.length, 1);
    assert.equal(harness.commitCount(), 1);

    const audit = harness.auditRows[0].params;
    assert.equal(squash(harness.auditRows[0].sql), AUDIT_SQL);
    assert.equal(audit[1], OWNER_A);
    assert.equal(audit[2], TENANT_A);
    assert.equal(audit[3], 'course.lesson_updated');

    const before = JSON.parse(audit[6]);
    const after = JSON.parse(audit[7]);
    assert.equal(before.release_at, null);
    assert.equal(before.prerequisite_lesson_id, null);
    assert.equal(after.release_at, RELEASE_ISO);
    assert.equal(after.prerequisite_lesson_id, LESSON_1);
    // Sanitized: the event names ids and state, never contact or private text.
    for (const payload of [before, after]) {
        assert.deepEqual(
            Object.keys(payload).sort(),
            ['course_id', 'description', 'display_order', 'lesson_id', 'prerequisite_lesson_id', 'release_at', 'status', 'title', 'unit_id'],
            'the audit payload is the bounded lesson metadata and nothing else',
        );
    }
});

// ---------------------------------------------------------------------------
// Failure and disposal matrix
// ---------------------------------------------------------------------------

test('failure: a failed UPDATE rolls back and leaves the stored row untouched', async () => {
    const state = makeState();
    const harness = build(state);
    state.failUpdate = true;

    const res = await withSilencedErrors(() =>
        runChain(harness.chain, updateReq(LESSON_2, { release_at: RELEASE_ISO })));

    assert.equal(res.status, 500);
    assert.equal(res.body.error, 'Failed to update course lesson');
    assert.equal(harness.commitCount(), 0);
    assert.equal(harness.rollbackCount(), 1);
    assert.deepEqual(harness.auditRows, []);
    assert.equal(state.lessons.find(l => l.id === LESSON_2)!.release_at ?? null, null);
});

test('failure: a failed audit rolls the whole update back', async () => {
    const state = makeState();
    const harness = build(state);
    state.failAudit = true;

    const res = await withSilencedErrors(() =>
        runChain(harness.chain, updateReq(LESSON_2, { release_at: RELEASE_ISO })));

    assert.equal(res.status, 500);
    assert.equal(harness.commitCount(), 0);
    assert.equal(state.lessons.find(l => l.id === LESSON_2)!.release_at ?? null, null,
        'the release instant did not survive the rollback');
});

test('failure: an unreadable read-back instant fails the write instead of fabricating a date', async () => {
    const state = makeState();
    const harness = build(state);
    state.failReadBack = true;

    const res = await withSilencedErrors(() =>
        runChain(harness.chain, updateReq(LESSON_2, { release_at: RELEASE_ISO })));

    assert.equal(res.status, 500);
    assert.equal(harness.commitCount(), 0);
});

test('failure: an unreadable stored timestamp projection refuses the write rather than inventing one', async () => {
    const state = makeState();
    state.malformedEpoch = 'text';
    const harness = build(state);

    const res = await withSilencedErrors(() =>
        runChain(harness.chain, updateReq(LESSON_1, { title: 'Renamed' })));

    assert.equal(res.status, 500, 'a 1970/NaN instant is never serialized');
    assert.equal(harness.commitCount(), 0, 'a row whose date cannot be read truthfully is never committed');
});

test('failure: a lost commit acknowledgement is uncertain — no success, no release, connection destroyed', async () => {
    const state = makeState();
    const harness = build(state);
    state.failCommit = true;

    const res = await withSilencedErrors(() =>
        runChain(harness.chain, updateReq(LESSON_2, { release_at: RELEASE_ISO })));

    assert.equal(res.status, 500, 'an uncertain commit is never reported as success');
    assert.equal(res.body.error, 'Failed to update course lesson');
    assert.equal(harness.destroyCount(), 1, 'the uncertain connection is destroyed');
    assert.equal(harness.releaseCount(), 0, 'it is never returned to the pool');
});

test('failure: a failed rollback destroys the connection and never releases it', async () => {
    const state = makeState();
    const harness = build(state);
    state.failAudit = true;
    state.failRollback = true;

    const res = await withSilencedErrors(() =>
        runChain(harness.chain, updateReq(LESSON_2, { release_at: RELEASE_ISO })));

    assert.equal(res.status, 500);
    assert.equal(harness.destroyCount(), 1);
    assert.equal(harness.releaseCount(), 0);
});

test('failure: a failed acquisition performs no cleanup at all', async () => {
    const state = makeState();
    const harness = build(state);
    state.failAcquire = true;

    const res = await withSilencedErrors(() =>
        runChain(harness.chain, updateReq(LESSON_2, { release_at: RELEASE_ISO })));

    assert.equal(res.status, 500);
    assert.equal(harness.releaseCount(), 0);
    assert.equal(harness.destroyCount(), 0);
});

test('failure: the connection is disposed exactly once on every outcome', async () => {
    const cases: Array<{ label: string; mutate: (state: any) => void }> = [
        { label: 'success', mutate: () => {} },
        { label: 'no-op', mutate: (s) => { s.lessons.find((l: any) => l.id === LESSON_2)!.release_at = RELEASE_DATE; } },
        { label: 'failed audit', mutate: (s) => { s.failAudit = true; } },
        { label: 'uncertain commit', mutate: (s) => { s.failCommit = true; } },
    ];
    for (const entry of cases) {
        const state = makeState();
        entry.mutate(state);
        const harness = build(state);
        await withSilencedErrors(() => runChain(harness.chain, updateReq(LESSON_2, { release_at: RELEASE_ISO })));
        assert.equal(
            harness.releaseCount() + harness.destroyCount(),
            1,
            `${entry.label}: exactly one disposal`,
        );
    }
});

// ---------------------------------------------------------------------------
// Boundaries
// ---------------------------------------------------------------------------

test('boundary: a non-owner cannot configure a release instant', async () => {
    const state = makeState();
    const harness = build(state);
    // An instructor is a member, never the owner: the M2-B05 rule is unchanged.
    const token = sign('instructor-a', 'instructor');
    const res = await runChain(harness.chain, updateReq(LESSON_2, { release_at: RELEASE_ISO }, COURSE_A1, UNIT_A1, token));
    assert.equal(res.status, 403);
    assert.equal(harness.commitCount(), 0);
});

test('boundary: a foreign course is the same 404 and never a release write', async () => {
    const harness = build();
    const res = await runChain(harness.chain, updateReq(LESSON_2, { release_at: RELEASE_ISO }, COURSE_B1, UNIT_A1));
    assert.equal(res.status, 404);
    assert.equal(harness.commitCount(), 0);
});

test('boundary: the release update statement writes only the two new columns alongside the accepted metadata', async () => {
    const harness = build();
    await runChain(harness.chain, updateReq(LESSON_2, { release_at: RELEASE_ISO }));

    const update = harness.calls.find(c => squash(c.sql) === UPDATE_SQL_WITH_RELEASE);
    assert.ok(update, 'the scheduled update ran');
    const sql = squash(update!.sql);
    const setClause = sql.slice(sql.indexOf('SET ') + 4, sql.indexOf(' WHERE '));
    const written = setClause.split(',').map(part => part.split('=')[0].trim());
    assert.deepEqual(
        written.sort(),
        ['description', 'display_order', 'prerequisite_lesson_id', 'release_at', 'status', 'title'],
        'the SET clause touches only the documented lesson columns',
    );
    // The qualifier is what scopes the row, so it is asserted separately from
    // the written columns.
    const whereClause = sql.slice(sql.indexOf(' WHERE ') + 7);
    assert.equal(whereClause, 'id=? AND unit_id=?', 'the row is qualified by the id AND the unit of the path');
});

test('boundary: the lesson DTO never carries a tenant, owner or private contact field', async () => {
    const harness = build();
    const res = await runChain(harness.chain, updateReq(LESSON_2, { release_at: RELEASE_ISO }));
    assert.equal(res.status, 200);
    const serialized = JSON.stringify(res.body);
    for (const forbidden of ['tenant_id', 'owner_user_id', 'instructor_id', 'email', 'phone', 'price', 'subscription']) {
        assert.equal(serialized.includes(forbidden), false, `the DTO must not expose "${forbidden}"`);
    }
});

// ---------------------------------------------------------------------------
// M2-23 batch 5 — ONE learning-path order, the final-state invariant and the
// archival policy (audit E)
// ---------------------------------------------------------------------------
//
// The three defects this block pins:
//
//   1. the prerequisite proof compared only `(lesson.display_order, lesson.id)`,
//      while the student path reads `(unit.display_order, unit.id,
//      lesson.display_order, lesson.id)` — so a cross-unit edge could be accepted
//      that the student path then read in the OPPOSITE order;
//   2. the proof only ran when `prerequisite_lesson_id` itself was sent, so a
//      `display_order`-only PATCH or a reorder batch could invert an existing
//      edge and commit it;
//   3. the proof did not require the prerequisite's UNIT to be active, and
//      archiving a lesson or a unit could strand a dependent behind a
//      prerequisite the student path no longer reads.

/** A lesson that lives in `UNIT_A1_ARCHIVED`, used only by the archived-unit test. */
const LESSON_IN_ARCHIVED_UNIT = '11110000-0000-4000-8000-000000000006';

/** A state with a SECOND ACTIVE unit of COURSE_A1 that sorts AFTER `UNIT_A1`. */
const withLaterUnit = (state: State = makeState()): State => {
    state.units.push({
        id: UNIT_A1_LATER, course_id: COURSE_A1, name: 'Unit A1 later',
        display_order: 2, status: 'active',
    });
    state.lessons.push({
        id: LESSON_LATER, unit_id: UNIT_A1_LATER, title: 'Later lesson', description: null,
        display_order: 0, status: 'active', created_at: stamp(8, 30), updated_at: stamp(8, 30),
    });
    return state;
};

/** `LESSON_2` depends on `LESSON_1`; `LESSON_1` sits at `prerequisiteOrder`. */
const withStoredEdge = (
    prerequisiteOrder = 0,
    targetOrder = 1,
    state: State = makeState(),
): State => {
    state.lessons.find(l => l.id === LESSON_1)!.display_order = prerequisiteOrder;
    const target = state.lessons.find(l => l.id === LESSON_2)!;
    target.display_order = targetOrder;
    target.prerequisite_lesson_id = LESSON_1;
    return state;
};

test('order: a prerequisite of an EARLIER unit is accepted and one of a LATER unit is refused', async () => {
    // `UNIT_A1` (order 0) is read before `UNIT_A1_LATER` (order 2) on the student
    // path, so a lesson of the earlier unit really does come first.
    const accepted = build(withLaterUnit());
    const ok = await runChain(accepted.chain, createReq(
        { title: 'After unit A1', display_order: 0, prerequisite_lesson_id: LESSON_1 },
        COURSE_A1, UNIT_A1_LATER,
    ));
    assert.equal(ok.status, 201);
    assert.equal(ok.body.lesson.prerequisite_lesson_id, LESSON_1);

    // The reverse edge is read BACKWARDS by the student path: a lesson of the
    // later unit is never earlier than one of the earlier unit, however their
    // in-unit positions compare. The old in-unit-only rule accepted this because
    // `LESSON_LATER.display_order (0) < 99`.
    const refused = build(withLaterUnit());
    const no = await runChain(refused.chain, createReq(
        { title: 'Before unit A1', display_order: 99, prerequisite_lesson_id: LESSON_LATER },
        COURSE_A1, UNIT_A1,
    ));
    assert.equal(no.status, 400);
    assert.equal(no.body.error, 'Invalid course lesson prerequisite');
    assert.equal(refused.commitCount(), 0, 'nothing is committed');
});

test('order: a prerequisite whose UNIT is archived is refused, because the path never reads it', async () => {
    // The archived unit is placed FIRST in the order, and the target lives in a
    // unit that sorts AFTER it, so the ORDER rule alone would accept this edge.
    // Only the "the prerequisite's unit must be active" rule refuses it — and
    // without that rule the target would wait forever for a lesson that never
    // appears on any student path.
    const state = withLaterUnit();
    state.units.find(u => u.id === UNIT_A1_ARCHIVED)!.display_order = 0;
    state.lessons.push({
        id: LESSON_IN_ARCHIVED_UNIT, unit_id: UNIT_A1_ARCHIVED, title: 'Hidden', description: null,
        display_order: 0, status: 'active', created_at: stamp(8, 40), updated_at: stamp(8, 40),
    });
    const harness = build(state);
    const res = await runChain(harness.chain, createReq(
        { title: 'Gated behind a hidden unit', display_order: 0, prerequisite_lesson_id: LESSON_IN_ARCHIVED_UNIT },
        COURSE_A1, UNIT_A1_LATER,
    ));
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'Invalid course lesson prerequisite');
    assert.equal(harness.commitCount(), 0, 'nothing is committed');
    assert.deepEqual(harness.auditRows, [], 'nothing is audited');
});

test('patch: a position-only change that would invert the stored prerequisite is refused and writes nothing', async () => {
    const state = withStoredEdge(5, 9);
    const harness = build(state);
    // No `prerequisite_lesson_id` is sent at all: only the POSITION moves, which
    // is exactly the case the old handler never re-validated.
    const res = await runChain(harness.chain, updateReq(LESSON_2, { display_order: 2 }));

    assert.equal(res.status, 409);
    assert.equal(res.body.error, 'Course lesson prerequisite order would be invalidated');
    assert.equal(harness.calls.filter(c => squash(c.sql) === UPDATE_SQL).length, 0, 'no UPDATE ran');
    assert.deepEqual(harness.auditRows, [], 'nothing was audited');
    assert.equal(harness.commitCount(), 0);
    assert.equal(state.lessons.find(l => l.id === LESSON_2)!.display_order, 9, 'the stored position is unchanged');
    assert.equal(
        harness.events.includes('path_position'),
        true,
        'the stored edge is re-proved against the FINAL position before any write',
    );
});

test('patch: a position-only change that keeps the edge ordered still succeeds', async () => {
    const state = withStoredEdge(0, 9);
    const harness = build(state);
    const res = await runChain(harness.chain, updateReq(LESSON_2, { display_order: 5 }));

    assert.equal(res.status, 200);
    assert.equal(res.body.lesson.display_order, 5);
    assert.equal(res.body.lesson.prerequisite_lesson_id, LESSON_1);
    assert.equal(harness.commitCount(), 1);
});

test('patch: moving a lesson that another ACTIVE lesson depends on is refused when the dependent would end up first', async () => {
    const state = withStoredEdge(0, 1);
    const harness = build(state);
    // The prerequisite moves PAST its dependent: the dependent's edge would point
    // forwards afterwards.
    const res = await runChain(harness.chain, updateReq(LESSON_1, { display_order: 5 }));

    assert.equal(res.status, 409);
    assert.equal(res.body.error, 'Course lesson prerequisite order would be invalidated');
    assert.equal(harness.calls.filter(c => squash(c.sql) === REORDER_UPDATE_SQL).length, 0);
    assert.equal(harness.calls.filter(c => squash(c.sql) === UPDATE_SQL).length, 0, 'no UPDATE ran');
    assert.deepEqual(harness.auditRows, []);
    assert.equal(state.lessons.find(l => l.id === LESSON_1)!.display_order, 0);
});

test('patch: moving a prerequisite to a position that stays before its dependent still succeeds', async () => {
    const state = withStoredEdge(0, 9);
    const harness = build(state);
    const res = await runChain(harness.chain, updateReq(LESSON_1, { display_order: 5 }));

    assert.equal(res.status, 200);
    assert.equal(res.body.lesson.display_order, 5);
    assert.equal(state.lessons.find(l => l.id === LESSON_2)!.prerequisite_lesson_id, LESSON_1);
});

test('archive: a lesson an ACTIVE lesson depends on cannot be archived, and the edge is never erased', async () => {
    const state = withStoredEdge(0, 1);
    const harness = build(state);
    const res = await runChain(harness.chain, updateReq(LESSON_1, { status: 'archived' }));

    assert.equal(res.status, 409);
    assert.equal(res.body.error, 'Course lesson is a prerequisite of an active lesson');
    assert.equal(harness.calls.filter(c => squash(c.sql) === UPDATE_SQL).length, 0, 'no UPDATE ran');
    assert.deepEqual(harness.auditRows, [], 'nothing was audited');
    assert.equal(harness.commitCount(), 0);
    assert.equal(state.lessons.find(l => l.id === LESSON_1)!.status, 'active', 'the lesson stays active');
    assert.equal(
        state.lessons.find(l => l.id === LESSON_2)!.prerequisite_lesson_id,
        LESSON_1,
        'the edge is preserved, never silently cleared',
    );
});

test('archive: a lesson with no active dependent is still archivable', async () => {
    const state = withStoredEdge(0, 1);
    // The dependent is already archived, so nothing is stranded by archiving the
    // prerequisite.
    state.lessons.find(l => l.id === LESSON_2)!.status = 'archived';
    const harness = build(state);
    const res = await runChain(harness.chain, updateReq(LESSON_1, { status: 'archived' }));

    assert.equal(res.status, 200);
    assert.equal(res.body.lesson.status, 'archived');
    assert.equal(harness.commitCount(), 1);
});

test('reorder: a batch that would invert a stored prerequisite is refused before the first UPDATE', async () => {
    const state = withStoredEdge(5, 9);
    const harness = build(state);
    const res = await runChain(harness.chain, reorderReq({ items: [{ id: LESSON_2, display_order: 1 }] }));

    assert.equal(res.status, 409);
    assert.equal(res.body.error, 'Course lesson prerequisite order would be invalidated');
    assert.equal(harness.events.includes('reorder_update'), false, 'nothing is written');
    assert.deepEqual(harness.auditRows, []);
    assert.equal(harness.commitCount(), 0);
    assert.equal(state.lessons.find(l => l.id === LESSON_2)!.display_order, 9);
});

test('reorder: a batch that would leave a dependent BEFORE its prerequisite is refused', async () => {
    const state = withStoredEdge(0, 1);
    const harness = build(state);
    // Only the PREREQUISITE moves; the dependent's own row is not in the batch.
    const res = await runChain(harness.chain, reorderReq({ items: [{ id: LESSON_1, display_order: 5 }] }));

    assert.equal(res.status, 409);
    assert.equal(res.body.error, 'Course lesson prerequisite order would be invalidated');
    assert.equal(harness.events.includes('reorder_update'), false);
    assert.equal(state.lessons.find(l => l.id === LESSON_1)!.display_order, 0);
});

test('reorder: a batch that keeps every edge ordered still commits', async () => {
    const state = withStoredEdge(0, 1);
    const harness = build(state);
    const res = await runChain(harness.chain, reorderReq({
        items: [{ id: LESSON_1, display_order: 0 }, { id: LESSON_2, display_order: 9 }],
    }));

    assert.equal(res.status, 200);
    assert.equal(harness.commitCount(), 1);
    assert.equal(state.lessons.find(l => l.id === LESSON_1)!.display_order, 0);
    assert.equal(state.lessons.find(l => l.id === LESSON_2)!.display_order, 9);
});

test('reorder: a dependent set larger than the provable bound refuses the whole batch', async () => {
    const state = withStoredEdge(0, 1);
    state.dependentsOverflow = true;
    const harness = build(state);
    const res = await runChain(harness.chain, reorderReq({ items: [{ id: LESSON_1, display_order: 5 }] }));

    assert.equal(res.status, 409);
    assert.equal(res.body.error, 'Course lesson prerequisite order would be invalidated');
    assert.equal(harness.events.includes('reorder_update'), false, 'an unprovable order is never written');
});

test('order: the proof reads the unit position, so the comparison is never lesson-only', async () => {
    const state = withStoredEdge(5, 9);
    const harness = build(state);
    await runChain(harness.chain, updateReq(LESSON_2, { display_order: 2 }));

    // The unit lookup carries the unit's own position: without it the handler
    // could only compare lessons inside one unit.
    const unitCall = harness.calls.find(c => squash(c.sql) === `${UNIT_SELECT} FOR UPDATE`);
    assert.ok(unitCall, 'the parent unit is resolved with its position');
});
