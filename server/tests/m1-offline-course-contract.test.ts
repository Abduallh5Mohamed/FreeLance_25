/**
 * M1 offline-student course-selection contract — hermetic helper tests.
 *
 * Runner: node:test via tsx (`npx tsx --test tests/m1-offline-course-contract.test.ts`).
 * No MySQL, no external network, no .env file, no Docker, no live app boot.
 *
 * Scope of production code exercised: the shared bounded helper
 * `server/src/lib/offline-student-courses.ts` (validation, caller course
 * authority, absent-vs-empty semantics, the added/removed enrollment diff and
 * the production transaction binding), driven with an in-memory seam so the
 * real authorization and diff logic runs without a database. The route
 * wiring in server/src/routes/students.ts is covered by type checking; the
 * transaction commit/rollback structure mirrors the verified POST handler
 * pattern already exercised by m1-sprint-attendance-boundary.test.ts.
 *
 * Contract (supervisor/026, task client-m1-contract-offline-courses-20261016-02):
 * absent course_ids preserves the enrollment, [] clears it, every requested
 * id must exist inside the caller's server-derived authority (never client
 * authority), and the diff is transactional so a failure can never leave an
 * orphan student or a partially replaced enrollment. No schema, migration,
 * billing or entitlement behavior is changed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    MAX_COURSE_ID_LENGTH,
    MAX_COURSE_SELECTION,
    applyOfflineCourseSelection,
    buildCourseAuthoritySql,
    createTransactionEnrollmentSeam,
    lockOfflineCourseTarget,
    normalizeCourseIds,
    runStudentWriteTransaction,
    StudentWriteRefusal,
    type CourseAuthorityCaller,
    type OfflineCourseEnrollmentSeam,
    type WriteTransactionConnection,
} from '../src/lib/offline-student-courses';

const ADMIN: CourseAuthorityCaller = { tenantId: null, isAdmin: true };
const IN_TENANT: CourseAuthorityCaller = { tenantId: 'tenant-a', isAdmin: false };
const NO_TENANT: CourseAuthorityCaller = { tenantId: null, isAdmin: false };

// ---------------------------------------------------------------------------
// In-memory seam: records every call so the diff and authority logic can be
// asserted exactly, including that a refusal performs NO write.
// ---------------------------------------------------------------------------

interface SeamFixture {
    seam: OfflineCourseEnrollmentSeam;
    /** ids the fixture knows to exist, with their owning tenant (null = none). */
    courses: Map<string, string | null>;
    enrolled: Set<string>;
    calls: { existing: string[][]; authorized: string[][]; enrollmentReads: number; writes: { added: string[]; removed: string[] }[] };
}

const makeSeam = (courses: Record<string, string | null>, enrolled: string[] = []): SeamFixture => {
    const calls: SeamFixture['calls'] = { existing: [], authorized: [], enrollmentReads: 0, writes: [] };
    const seam: OfflineCourseEnrollmentSeam = {
        findExistingCourseIds: async (ids) => {
            calls.existing.push([...ids]);
            return ids.filter((id) => courses[id] !== undefined);
        },
        findAuthorizedCourseIds: async (ids, caller) => {
            calls.authorized.push([...ids]);
            return ids.filter((id) => {
                const tenant = courses[id];
                if (tenant === undefined) return false;
                if (caller.isAdmin) return true;
                if (caller.tenantId) return tenant === caller.tenantId;
                return tenant === null;
            });
        },
        readEnrolledCourseIds: async () => {
            calls.enrollmentReads += 1;
            return [...enrolled];
        },
        replaceEnrollment: async (_studentId, added, removed) => {
            calls.writes.push({ added: [...added], removed: [...removed] });
        },
    };
    return { seam, courses: new Map(Object.entries(courses)), enrolled: new Set(enrolled), calls };
};

// ---------------------------------------------------------------------------
// Pure validation
// ---------------------------------------------------------------------------

test('normalizeCourseIds accepts unique bounded id arrays', () => {
    assert.deepEqual(normalizeCourseIds(['c1', 'c2']), { ok: true, courseIds: ['c1', 'c2'] });
    assert.deepEqual(normalizeCourseIds([]), { ok: true, courseIds: [] });
    assert.deepEqual(normalizeCourseIds([' c1 ']), { ok: true, courseIds: ['c1'] }, 'ids are trimmed');
});

test('normalizeCourseIds rejects malformed values with 400-level reasons', () => {
    const cases: [unknown, string][] = [
        ['c1', 'a bare string is not an array'],
        [null, 'null is not an array'],
        [{}, 'an object is not an array'],
        [['c1', 'c1'], 'duplicate ids are rejected'],
        [['c1', 2], 'non-string entries are rejected'],
        [[''], 'empty ids are rejected'],
        [['x'.repeat(MAX_COURSE_ID_LENGTH + 1)], 'oversized ids are rejected'],
        [Array.from({ length: MAX_COURSE_SELECTION + 1 }, (_, i) => `c${i}`), 'the selection is bounded'],
    ];
    for (const [value, why] of cases) {
        const result = normalizeCourseIds(value);
        assert.equal(result.ok, false, why);
        assert.match((result as { error: string }).error, /course_ids/);
    }
});

test('course authority mirrors the canonical courseScope rule', () => {
    assert.deepEqual(buildCourseAuthoritySql(ADMIN), { sql: '', params: [] });
    assert.deepEqual(buildCourseAuthoritySql(IN_TENANT), { sql: ' AND tenant_id = ?', params: ['tenant-a'] });
    assert.deepEqual(buildCourseAuthoritySql(NO_TENANT), { sql: ' AND tenant_id IS NULL', params: [] });
});

// ---------------------------------------------------------------------------
// applyOfflineCourseSelection — absent vs empty, authority, diff
// ---------------------------------------------------------------------------

test('an absent course_ids preserves the enrollment without any read or write', async () => {
    const f = makeSeam({ c1: 'tenant-a' }, ['c1']);
    const result = await applyOfflineCourseSelection('s1', undefined, f.seam, IN_TENANT);
    assert.deepEqual(result, { ok: true, added: [], removed: [] });
    assert.equal(f.calls.existing.length, 0);
    assert.equal(f.calls.writes.length, 0, 'no write at all when the field is absent');
});

test('a non-array course_ids is refused 400 before any lookup or write', async () => {
    const f = makeSeam({ c1: 'tenant-a' }, ['c1']);
    const result = await applyOfflineCourseSelection('s1', 'c1', f.seam, IN_TENANT);
    assert.deepEqual(result, { ok: false, status: 400, error: 'course_ids must be an array of course ids' });
    assert.equal(f.calls.existing.length, 0);
    assert.equal(f.calls.writes.length, 0);
});

test('a nonexistent course id is refused 404, never silently dropped', async () => {
    const f = makeSeam({ c1: 'tenant-a' }, []);
    const result = await applyOfflineCourseSelection('s1', ['c1', 'ghost'], f.seam, IN_TENANT);
    assert.equal(result.ok, false);
    assert.equal((result as { status: number }).status, 404);
    assert.equal(f.calls.writes.length, 0, 'no partial write on a nonexistent id');
});

test('a course outside the caller authority is refused 403, never client authority', async () => {
    // c1 belongs to another tenant; the caller's authority is tenant-a.
    const f = makeSeam({ c1: 'tenant-b' }, []);
    const result = await applyOfflineCourseSelection('s1', ['c1'], f.seam, IN_TENANT);
    assert.equal(result.ok, false);
    assert.equal((result as { status: number }).status, 403);
    assert.equal(f.calls.writes.length, 0);
    // an admin platform caller IS authorized for the same course
    const fAdmin = makeSeam({ c1: 'tenant-b' }, []);
    const adminResult = await applyOfflineCourseSelection('s1', ['c1'], fAdmin.seam, ADMIN);
    assert.deepEqual(adminResult, { ok: true, added: ['c1'], removed: [] });
});

test('a missing id is reported 404 even when another id is merely out of scope', async () => {
    const f = makeSeam({ c1: 'tenant-a', c2: 'tenant-b' }, []);
    const result = await applyOfflineCourseSelection('s1', ['c1', 'ghost', 'c2'], f.seam, IN_TENANT);
    assert.equal((result as { status: number }).status, 404, 'existence is checked before authority');
    assert.equal(f.calls.writes.length, 0);
});

test('a create selection adds every authorized id and removes nothing', async () => {
    const f = makeSeam({ c1: 'tenant-a', c2: 'tenant-a' }, []);
    const result = await applyOfflineCourseSelection('s1', ['c1', 'c2'], f.seam, IN_TENANT);
    assert.deepEqual(result, { ok: true, added: ['c1', 'c2'], removed: [] });
    assert.deepEqual(f.calls.writes, [{ added: ['c1', 'c2'], removed: [] }]);
});

test('an update replaces only the diff — retained enrollments are untouched', async () => {
    const f = makeSeam({ c1: 'tenant-a', c2: 'tenant-a', c3: 'tenant-a' }, ['c1', 'c2']);
    const result = await applyOfflineCourseSelection('s1', ['c2', 'c3'], f.seam, IN_TENANT);
    assert.deepEqual(result, { ok: true, added: ['c3'], removed: ['c1'] });
    assert.deepEqual(f.calls.writes, [{ added: ['c3'], removed: ['c1'] }], 'c2 is retained, never deleted and re-inserted');
});

test('an explicit [] clears the offline enrollment selection', async () => {
    const f = makeSeam({}, ['c1']);
    const result = await applyOfflineCourseSelection('s1', [], f.seam, IN_TENANT);
    assert.deepEqual(result, { ok: true, added: [], removed: ['c1'] });
    assert.deepEqual(f.calls.writes, [{ added: [], removed: ['c1'] }]);
});

test('re-applying the same selection is a no-op diff (retry-safe)', async () => {
    const f = makeSeam({ c1: 'tenant-a', c2: 'tenant-a' }, ['c1', 'c2']);
    const result = await applyOfflineCourseSelection('s1', ['c1', 'c2'], f.seam, IN_TENANT);
    assert.deepEqual(result, { ok: true, added: [], removed: [] });
    assert.deepEqual(f.calls.writes, [{ added: [], removed: [] }]);
});

// ---------------------------------------------------------------------------
// Production transaction binding
// ---------------------------------------------------------------------------

test('the production seam emits bounded SQL: delete the diff, INSERT IGNORE the additions', async () => {
    const executed: { sql: string; params: unknown[] }[] = [];
    const connection = {
        execute: async (sql: string, params: unknown[]) => {
            executed.push({ sql, params });
            if (sql.includes('SELECT id FROM courses WHERE id IN')) return [[{ id: 'c1' }, { id: 'c2' }], []];
            if (sql.includes('SELECT course_id FROM student_courses')) return [[{ course_id: 'c1' }], []];
            return [[], []];
        },
    };
    const seam = createTransactionEnrollmentSeam(connection);

    const existing = await seam.findExistingCourseIds(['c1', 'c2']);
    assert.deepEqual(existing, ['c1', 'c2']);
    assert.match(executed[0].sql, /SELECT id FROM courses WHERE id IN \(\?,\?\)/);

    const authorized = await seam.findAuthorizedCourseIds(['c1', 'c2'], IN_TENANT);
    assert.deepEqual(authorized, ['c1', 'c2']);
    assert.match(executed[1].sql, /AND tenant_id = \?$/, 'the authority predicate is appended');

    const enrolled = await seam.readEnrolledCourseIds('s1');
    assert.deepEqual(enrolled, ['c1']);

    await seam.replaceEnrollment('s1', ['c2'], ['c1']);
    assert.match(executed[3].sql, /DELETE FROM student_courses WHERE student_id = \? AND course_id IN \(\?\)/);
    assert.deepEqual(executed[3].params, ['s1', 'c1']);
    assert.match(executed[4].sql, /INSERT IGNORE INTO student_courses/);
    assert.equal(executed[4].params[1], 's1');
    assert.equal(executed[4].params[2], 'c2');
});

test('the production seam issues no delete or insert for an empty diff', async () => {
    const executed: { sql: string }[] = [];
    const connection = { execute: async (sql: string) => { executed.push({ sql }); return [[], []]; } };
    const seam = createTransactionEnrollmentSeam(connection);

    await seam.replaceEnrollment('s1', [], []);
    assert.equal(executed.length, 0, 'an empty diff must not emit any SQL');
});

// ---------------------------------------------------------------------------
// lockOfflineCourseTarget — the production PUT transaction path (029):
// FOR UPDATE lock, stored offline predicate, in-transaction authority.
// ---------------------------------------------------------------------------

interface LockFixture {
    connection: { execute: (sql: string, params: unknown[]) => Promise<unknown> };
    executed: { sql: string; params: unknown[] }[];
}

const makeLockConnection = (rows: { id: string; is_offline: unknown }[]): LockFixture => {
    const executed: { sql: string; params: unknown[] }[] = [];
    const connection = {
        execute: async (sql: string, params: unknown[]) => {
            executed.push({ sql, params });
            return [rows, []];
        },
    };
    return { connection, executed };
};

test('the lock serializes the target with FOR UPDATE and re-validates instructor authority inside the transaction', async () => {
    const f = makeLockConnection([{ id: 's1', is_offline: 1 }]);
    const result = await lockOfflineCourseTarget(f.connection, 's1', 'instr-1');
    assert.deepEqual(result, { ok: true });
    assert.equal(f.executed.length, 1, 'a single locked read decides the whole path');
    assert.match(f.executed[0].sql, /FOR UPDATE$/, 'the student row is locked, never a snapshot read');
    assert.match(f.executed[0].sql, /s\.instructor_id = \? OR g\.instructor_id = \?/, 'instructor authority is re-validated under the lock');
    assert.deepEqual(f.executed[0].params, ['s1', 'instr-1', 'instr-1']);
});

test('an admin/platform caller locks without the instructor predicate', async () => {
    const f = makeLockConnection([{ id: 's1', is_offline: 1 }]);
    const result = await lockOfflineCourseTarget(f.connection, 's1', null);
    assert.deepEqual(result, { ok: true });
    assert.equal(f.executed[0].sql, 'SELECT id, is_offline FROM students WHERE id = ? FOR UPDATE');
    assert.deepEqual(f.executed[0].params, ['s1']);
});

test('a student that left the caller scope mid-flight is refused 404 under the lock', async () => {
    const f = makeLockConnection([]);
    const result = await lockOfflineCourseTarget(f.connection, 's1', 'instr-1');
    assert.deepEqual(result, { ok: false, status: 404, error: 'Student not found' });
});

test('the stored offline predicate — never a UI flag — decides eligibility (029)', async () => {
    const online = makeLockConnection([{ id: 's1', is_offline: 0 }]);
    const refused = await lockOfflineCourseTarget(online.connection, 's1', null);
    assert.equal(refused.ok, false);
    assert.equal((refused as { status: number }).status, 400);
    assert.match((refused as { error: string }).error, /الأوفلاين/);

    const nullFlag = makeLockConnection([{ id: 's1', is_offline: null }]);
    const refusedNull = await lockOfflineCourseTarget(nullFlag.connection, 's1', null);
    assert.equal((refusedNull as { status: number }).status, 400, 'a NULL flag is not offline eligibility');

    const offline = makeLockConnection([{ id: 's1', is_offline: 1 }]);
    assert.deepEqual(await lockOfflineCourseTarget(offline.connection, 's1', null), { ok: true });
});

test('the production transaction path applies the enrollment diff only after a successful lock', async () => {
    // One in-memory connection emulating both the lock read and the
    // enrollment seam SQL, in the exact order the route issues them:
    // begin -> lock -> (update) -> course diff -> commit.
    const executed: { sql: string; params: unknown[] }[] = [];
    const students: { id: string; is_offline: number }[] = [{ id: 's1', is_offline: 1 }];
    const connection = {
        execute: async (sql: string, params: unknown[]) => {
            executed.push({ sql, params });
            if (sql.includes('FROM students')) return [students.filter((s) => s.id === params[0]), []];
            if (sql.includes('SELECT id FROM courses WHERE id IN')) return [[{ id: 'c1' }, { id: 'c2' }], []];
            if (sql.includes('SELECT course_id FROM student_courses')) return [[{ course_id: 'c1' }], []];
            return [[], []];
        },
    };

    const lock = await lockOfflineCourseTarget(connection, 's1', null);
    assert.deepEqual(lock, { ok: true });
    assert.equal(executed[0].sql.includes('FOR UPDATE'), true, 'the lock is the FIRST statement of the transaction');

    const applied = await applyOfflineCourseSelection('s1', ['c2'], createTransactionEnrollmentSeam(connection), ADMIN);
    assert.deepEqual(applied, { ok: true, added: ['c2'], removed: ['c1'] });
    assert.equal(
        executed.findIndex((e) => e.sql.includes('FOR UPDATE')) <
            executed.findIndex((e) => e.sql.includes('INSERT IGNORE INTO student_courses')),
        true,
        'no enrollment write can precede the lock',
    );
});

test('a lock refusal never reaches the enrollment seam (rollback path)', async () => {
    const executed: { sql: string }[] = [];
    const connection = {
        execute: async (sql: string) => {
            executed.push({ sql });
            if (sql.includes('FROM students')) return [[{ id: 's1', is_offline: 0 }], []];
            return [[], []];
        },
    };
    const lock = await lockOfflineCourseTarget(connection, 's1', null);
    assert.equal(lock.ok, false);
    assert.equal(
        executed.some((e) => e.sql.includes('student_courses')),
        false,
        'an ineligible or missing target produces no enrollment SQL at all',
    );
});

// ---------------------------------------------------------------------------
// Real transaction runner (supervisor/035): the SMALLEST production transaction
// runner used by the student write handlers. These tests drive the ACTUAL
// runStudentWriteTransaction with a mocked connection (mocked serialized locks,
// no live DB) so they pin begin -> lock -> student/user/enrollment -> commit ->
// release, and rollback -> release with NO commit and NO partial write on a
// refusal or failure. The route handlers call this runner; the tests do not
// duplicate its flow.
// ---------------------------------------------------------------------------

interface TxnCallLog {
    begin: number;
    commit: number;
    rollback: number;
    release: number;
    sqls: { sql: string; params: unknown[] }[];
}

/** A connection whose enrollment rows live in shared mutable state, so a later
 *  selection reads the prior committed rows (deterministic serialized replacement). */
const makeStatefulConnection = (initialEnrolled: string[] = ['c1']) => {
    const log: TxnCallLog = { begin: 0, commit: 0, rollback: 0, release: 0, sqls: [] };
    let enrolled = [...initialEnrolled];
    const connection: WriteTransactionConnection = {
        beginTransaction: async () => { log.begin += 1; },
        commit: async () => { log.commit += 1; },
        rollback: async () => { log.rollback += 1; },
        release: () => { log.release += 1; },
        execute: async (sql: string, params: unknown[] = []) => {
            log.sqls.push({ sql, params });
            if (sql.includes('FROM students') && sql.includes('FOR UPDATE')) {
                return [[{ id: 's1', is_offline: 1 }], []];
            }
            if (sql.includes('SELECT id FROM courses WHERE id IN')) {
                return [(params as string[]).map((id) => ({ id })), []];
            }
            if (sql.includes('SELECT course_id FROM student_courses')) {
                return [enrolled.map((id) => ({ course_id: id })), []];
            }
            if (sql.includes('DELETE FROM student_courses')) {
                const removed = (params as unknown[]).slice(1) as string[];
                enrolled = enrolled.filter((id) => !removed.includes(id));
                return [[], []];
            }
            if (sql.includes('INSERT IGNORE INTO student_courses')) {
                const courseId = params[2] as string;
                if (!enrolled.includes(courseId)) enrolled.push(courseId);
                return [[], []];
            }
            return [[], []];
        },
    };
    return { connection, log, getEnrolled: () => enrolled };
};

/** A stateless connection with a fixed lock row (or none) and course visibility,
 *  used to prove refusal/failure rollback and the no-partial-write boundary. */
const makeTxnConnection = (
    opts: {
        lockRow?: { id: string; is_offline: number } | null;
        findCourses?: string[];
        failOnSql?: RegExp;
    } = {},
) => {
    const log: TxnCallLog = { begin: 0, commit: 0, rollback: 0, release: 0, sqls: [] };
    const connection: WriteTransactionConnection = {
        beginTransaction: async () => { log.begin += 1; },
        commit: async () => { log.commit += 1; },
        rollback: async () => { log.rollback += 1; },
        release: () => { log.release += 1; },
        execute: async (sql: string, params: unknown[] = []) => {
            log.sqls.push({ sql, params });
            if (opts.failOnSql && opts.failOnSql.test(sql)) throw new Error('Simulated DB failure');
            if (sql.includes('FROM students') && sql.includes('FOR UPDATE')) {
                return [opts.lockRow ? [opts.lockRow] : [], []];
            }
            if (sql.includes('SELECT id FROM courses WHERE id IN')) {
                const present = opts.findCourses ?? ['c1', 'c2'];
                return [(params as string[]).filter((id) => present.includes(id)).map((id) => ({ id })), []];
            }
            if (sql.includes('SELECT course_id FROM student_courses')) {
                return [['c1'].map((id) => ({ course_id: id })), []];
            }
            return [[], []];
        },
    };
    return { connection, log };
};

const runLockThenApply = (connection: WriteTransactionConnection, courseIds: unknown) =>
    runStudentWriteTransaction(connection, async (conn) => {
        const lock = await lockOfflineCourseTarget(conn, 's1', null);
        if (!lock.ok) throw new StudentWriteRefusal(lock.status, lock.error);
        const courseResult = await applyOfflineCourseSelection('s1', courseIds, createTransactionEnrollmentSeam(conn), ADMIN);
        if (!courseResult.ok) throw new StudentWriteRefusal(courseResult.status, courseResult.error);
        return courseResult;
    });

test('the real transaction runner commits and releases on success, locking before any enrollment write', async () => {
    const { connection, log } = makeTxnConnection({ lockRow: { id: 's1', is_offline: 1 } });
    const result = await runLockThenApply(connection, ['c2']);
    assert.deepEqual(result, { ok: true, added: ['c2'], removed: ['c1'] });
    assert.equal(log.begin, 1, 'begin once');
    assert.equal(log.commit, 1, 'commit once on success');
    assert.equal(log.rollback, 0, 'no rollback on success');
    assert.equal(log.release, 1, 'connection released exactly once');
    const lockIdx = log.sqls.findIndex((s) => s.sql.includes('FOR UPDATE'));
    const writeIdx = log.sqls.findIndex((s) => s.sql.includes('INSERT IGNORE INTO student_courses'));
    assert.ok(lockIdx >= 0 && writeIdx > lockIdx, 'the lock is issued before any enrollment write');
});

test('a lock refusal rolls back and releases with no commit and no enrollment write', async () => {
    const { connection, log } = makeTxnConnection({ lockRow: { id: 's1', is_offline: 0 } });
    let thrown: unknown;
    try {
        await runLockThenApply(connection, ['c1']);
    } catch (e) { thrown = e; }
    assert.ok(thrown instanceof StudentWriteRefusal, 'refusal is a StudentWriteRefusal');
    assert.equal((thrown as StudentWriteRefusal).status, 400);
    assert.equal(log.begin, 1);
    assert.equal(log.rollback, 1, 'rolled back on refusal');
    assert.equal(log.commit, 0, 'never committed a refused transaction');
    assert.equal(log.release, 1);
    assert.equal(log.sqls.some((s) => s.sql.includes('student_courses')), false, 'no enrollment SQL at all');
});

test('a course-selection refusal (404) rolls back with no commit', async () => {
    const { connection, log } = makeTxnConnection({ lockRow: { id: 's1', is_offline: 1 }, findCourses: [] });
    let thrown: unknown;
    try {
        await runLockThenApply(connection, ['ghost']);
    } catch (e) { thrown = e; }
    assert.ok(thrown instanceof StudentWriteRefusal);
    assert.equal((thrown as StudentWriteRefusal).status, 404);
    assert.equal(log.rollback, 1);
    assert.equal(log.commit, 0);
    assert.equal(log.release, 1);
});

test('a DB failure inside the body rolls back, releases and rethrows with no commit', async () => {
    const { connection, log } = makeTxnConnection({
        lockRow: { id: 's1', is_offline: 1 },
        failOnSql: /INSERT IGNORE INTO student_courses/,
    });
    let thrown: unknown;
    try {
        await runLockThenApply(connection, ['c2']);
    } catch (e) { thrown = e; }
    assert.ok(thrown instanceof Error);
    assert.equal((thrown as Error).message, 'Simulated DB failure');
    assert.equal(log.rollback, 1, 'failure rolls back');
    assert.equal(log.commit, 0, 'failure never commits');
    assert.equal(log.release, 1, 'connection released even on failure');
});

test('POST creation failure cannot leave a student/user orphan: rollback with no commit', async () => {
    // POST-like body: insert user + student first, then the course selection
    // (which fails because 'ghost' does not exist). The runner must roll back so
    // the student insert is never committed (no orphan).
    const { connection, log } = makeTxnConnection({ lockRow: { id: 's1', is_offline: 1 }, findCourses: [] });
    let thrown: unknown;
    try {
        await runStudentWriteTransaction(connection, async (conn) => {
            await conn.execute('INSERT INTO users (id) VALUES (?)', ['u1']);
            await conn.execute('INSERT INTO students (id) VALUES (?)', ['s1']);
            const courseResult = await applyOfflineCourseSelection('s1', ['ghost'], createTransactionEnrollmentSeam(conn), ADMIN);
            if (!courseResult.ok) throw new StudentWriteRefusal(courseResult.status, courseResult.error);
        });
    } catch (e) { thrown = e; }
    assert.ok(thrown instanceof StudentWriteRefusal);
    assert.equal((thrown as StudentWriteRefusal).status, 404);
    const inserts = log.sqls.filter((s) => s.sql.includes('INSERT INTO students') || s.sql.includes('INSERT INTO users'));
    assert.ok(inserts.length >= 2, 'the student/user inserts were issued');
    assert.equal(log.commit, 0, 'orphan prevented: the inserts are rolled back, never committed');
    assert.equal(log.rollback, 1);
    assert.equal(log.release, 1);
});

test('serialized replacements: each transaction re-locks first and the next reads the prior committed selection', async () => {
    const first = makeStatefulConnection(['c1']);
    const r1 = await runLockThenApply(first.connection, []);
    assert.deepEqual(r1, { ok: true, added: [], removed: ['c1'] });
    assert.deepEqual(first.getEnrolled(), [], 'after the first committed selection, c1 is removed');

    const second = makeStatefulConnection(first.getEnrolled());
    const r2 = await runLockThenApply(second.connection, ['c2']);
    assert.deepEqual(r2, { ok: true, added: ['c2'], removed: [] });
    assert.deepEqual(second.getEnrolled(), ['c2'], 'the next selection sees the prior committed rows and adds c2');

    for (const { log } of [first, second]) {
        const lockIdx = log.sqls.findIndex((s) => s.sql.includes('FOR UPDATE'));
        const writeIdx = log.sqls.findIndex((s) => s.sql.includes('student_courses'));
        assert.ok(lockIdx >= 0 && writeIdx > lockIdx, 'every transaction locks before any enrollment write');
        assert.equal(log.begin, 1, 'each transaction opens its own transaction');
        assert.equal(log.commit, 1, 'each transaction commits');
        assert.equal(log.release, 1, 'each transaction releases the connection');
    }
});

test('through the runner an absent course_ids preserves and an explicit [] clears inside the transaction', async () => {
    const absent = makeStatefulConnection(['c1']);
    const rA = await runLockThenApply(absent.connection, undefined);
    assert.deepEqual(rA, { ok: true, added: [], removed: [] });
    assert.equal(absent.log.commit, 1);
    assert.equal(absent.log.release, 1);
    assert.deepEqual(absent.getEnrolled(), ['c1'], 'absent selection left the enrollment unchanged');

    const clear = makeStatefulConnection(['c1']);
    const rB = await runLockThenApply(clear.connection, []);
    assert.deepEqual(rB, { ok: true, added: [], removed: ['c1'] });
    assert.deepEqual(clear.getEnrolled(), [], 'explicit [] cleared the enrollment');
    assert.equal(clear.log.commit, 1);
    assert.equal(clear.log.release, 1);
});

// ---------------------------------------------------------------------------
// Connection-release boundary (supervisor/036, 037): the SMALLEST production
// runner must release the connection exactly once on EVERY failure site —
// including a rejected beginTransaction, which previously leaked the pooled
// connection because begin ran outside the try/finally. These tests drive the
// ACTUAL runStudentWriteTransaction with a controllable connection and pin the
// exact call order/count and original-error propagation for each failure.
// ---------------------------------------------------------------------------

interface BoundaryConnectionOpts {
    beginError?: Error;
    commitError?: Error;
    rollbackError?: Error;
}

/** A connection that records the exact order of lifecycle calls and can be
 *  made to reject at begin/commit/rollback. `release` is always a no-op count
 *  so the boundary tests can assert it runs exactly once. */
const makeBoundaryConnection = (order: string[], opts: BoundaryConnectionOpts = {}) => {
    const connection: WriteTransactionConnection = {
        beginTransaction: async () => { order.push('begin'); if (opts.beginError) throw opts.beginError; },
        commit: async () => { order.push('commit'); if (opts.commitError) throw opts.commitError; },
        rollback: async () => { order.push('rollback'); if (opts.rollbackError) throw opts.rollbackError; },
        release: () => { order.push('release'); },
        execute: async () => { order.push('execute'); return [[], []]; },
    };
    return connection;
};

test('a rejected beginTransaction releases exactly once with no body and no rollback (037)', async () => {
    const order: string[] = [];
    const beginError = new Error('begin rejected');
    const connection = makeBoundaryConnection(order, { beginError });
    let thrown: unknown;
    try {
        await runStudentWriteTransaction(connection, async () => 'value');
    } catch (e) { thrown = e; }
    assert.equal(thrown, beginError, 'the original begin error is preserved (no swap)');
    assert.deepEqual(order, ['begin', 'release'], 'begin, then release — body never ran, no rollback');
    assert.equal(order.filter((o) => o === 'release').length, 1, 'the connection is released exactly once');
    assert.equal(order.includes('rollback'), false, 'no rollback on a transaction that never began');
});

test('a body rejection rolls back then releases with no commit, preserving the body error (037)', async () => {
    const order: string[] = [];
    const bodyError = new Error('body failed');
    const connection = makeBoundaryConnection(order);
    let thrown: unknown;
    try {
        await runStudentWriteTransaction(connection, async () => { order.push('body'); throw bodyError; });
    } catch (e) { thrown = e; }
    assert.equal(thrown, bodyError, 'the body error is preserved');
    assert.deepEqual(order, ['begin', 'body', 'rollback', 'release'], 'order: begin, body, rollback, release');
    assert.equal(order.filter((o) => o === 'commit').length, 0, 'no commit on failure');
    assert.equal(order.filter((o) => o === 'release').length, 1, 'released exactly once');
});

test('a commit rejection rolls back then releases, preserving the commit error (037)', async () => {
    const order: string[] = [];
    const commitError = new Error('commit rejected');
    const connection = makeBoundaryConnection(order, { commitError });
    let thrown: unknown;
    try {
        await runStudentWriteTransaction(connection, async () => { order.push('body'); return 'value'; });
    } catch (e) { thrown = e; }
    assert.equal(thrown, commitError, 'the commit error is preserved');
    assert.deepEqual(order, ['begin', 'body', 'commit', 'rollback', 'release'], 'the commit ran before the rollback');
    assert.equal(order.filter((o) => o === 'release').length, 1);
});

test('a rollback rejection still releases and preserves the primary body error as its cause (037)', async () => {
    const order: string[] = [];
    const bodyError = new Error('body failed');
    const rollbackError = new Error('rollback rejected');
    const connection = makeBoundaryConnection(order, { rollbackError });
    let thrown: unknown;
    try {
        await runStudentWriteTransaction(connection, async () => { order.push('body'); throw bodyError; });
    } catch (e) { thrown = e; }
    assert.equal(thrown, bodyError, 'the primary body error is still thrown, not the rollback error');
    assert.equal((thrown as Error).cause, rollbackError, 'the failed rollback is recorded as the cause');
    assert.deepEqual(order, ['begin', 'body', 'rollback', 'release'], 'release still runs after a failed rollback');
    assert.equal(order.filter((o) => o === 'release').length, 1, 'the connection is released despite the rollback failure');
});

test('a successful body commits and releases exactly once, returning the body value (037)', async () => {
    const order: string[] = [];
    const connection = makeBoundaryConnection(order);
    const result = await runStudentWriteTransaction(connection, async () => { order.push('body'); return 'value'; });
    assert.equal(result, 'value', 'the body return value is passed through');
    assert.deepEqual(order, ['begin', 'body', 'commit', 'release'], 'order: begin, body, commit, release');
    assert.equal(order.filter((o) => o === 'commit').length, 1, 'committed exactly once');
    assert.equal(order.filter((o) => o === 'rollback').length, 0, 'no rollback on success');
    assert.equal(order.filter((o) => o === 'release').length, 1, 'released exactly once');
});
