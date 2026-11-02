/**
 * Transaction lifecycle — `withTransaction` cleanup contract (hermetic).
 *
 * Defect under test (audit 2026-10-26, finding B): when `commit()` rejected and
 * the subsequent `rollback()` succeeded, the connection was still `release()`d
 * back to the pool. A rejected COMMIT is an AMBIGUOUS outcome — the write may
 * or may not have landed — and a later successful rollback does not resolve
 * that ambiguity, so the connection must be DESTROYED instead. This suite
 * drives the REAL `server/src/db.ts` with an injected synthetic pool and
 * connection; `dotenv` and `mysql2/promise` are intercepted so no database,
 * pool, socket, environment file or provider is ever touched.
 *
 * Covered outcomes: begin / work / commit / rollback / release / destroy, the
 * original error identity across every path, exactly-once cleanup, and the
 * absence of any automatic retry after an ambiguous commit.
 */
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import path from 'node:path';
import Module from 'node:module';

// ---------------------------------------------------------------------------
// Import interception — dotenv and mysql2/promise never load for real
// ---------------------------------------------------------------------------

const originalLoad = (Module as any)._load;
const dbFile = path.resolve(__dirname, '..', 'src', 'db.ts');
const normalize = (id: string) => path.resolve(id).toLowerCase();

interface FakeConnection {
    events: string[];
    fail: {
        begin?: Error;
        commit?: Error;
        rollback?: Error;
        release?: Error;
    };
    commitCalls: number;
    rollbackCalls: number;
    releaseCalls: number;
    destroyCalls: number;
    beginTransaction(): Promise<void>;
    commit(): Promise<void>;
    rollback(): Promise<void>;
    release(): void;
    destroy(): void;
}

const scenario: { connection: FakeConnection | null } = { connection: null };

/**
 * The synthetic connection the REAL `withTransaction` drives: every lifecycle
 * method records its call and then applies the injected failure. One object
 * carries both the event log and the call counters, so the callback ("work")
 * and the helper share a single observable sequence.
 */
const makeConnection = (fail: FakeConnection['fail'] = {}): FakeConnection => {
    const connection: FakeConnection = {
        events: [],
        fail,
        commitCalls: 0,
        rollbackCalls: 0,
        releaseCalls: 0,
        destroyCalls: 0,
        async beginTransaction() {
            connection.events.push('begin');
            if (connection.fail.begin) throw connection.fail.begin;
        },
        async commit() {
            connection.events.push('commit');
            connection.commitCalls += 1;
            if (connection.fail.commit) throw connection.fail.commit;
        },
        async rollback() {
            connection.events.push('rollback');
            connection.rollbackCalls += 1;
            if (connection.fail.rollback) throw connection.fail.rollback;
        },
        release() {
            connection.events.push('release');
            connection.releaseCalls += 1;
            if (connection.fail.release) throw connection.fail.release;
        },
        destroy() {
            connection.events.push('destroy');
            connection.destroyCalls += 1;
        },
    };
    return connection;
};

const fakeMysql = {
    createPool: () => ({
        getConnection: async () => {
            assert.ok(scenario.connection, 'a connection must be injected before withTransaction runs');
            return scenario.connection as any;
        },
        execute: async () => { throw new Error('HERMETIC_VIOLATION: pool.execute'); },
    }),
    createConnection: async () => { throw new Error('HERMETIC_VIOLATION: createConnection'); },
};

installInterception();
const originalLog = console.log;
const originalError = console.error;
console.log = () => undefined;
console.error = () => undefined;
let dbModule: any;
try {
    dbModule = require('../src/db');
} finally {
    console.log = originalLog;
    console.error = originalError;
    restoreInterception();
}

function installInterception() {
    (Module as any)._load = function (request: string, parent: any, isMain: boolean) {
        if (parent && typeof parent.filename === 'string' && normalize(parent.filename) === normalize(dbFile)) {
            if (request === 'dotenv') return { config: () => undefined };
            if (request === 'mysql2/promise') return fakeMysql;
        }
        return originalLoad.apply(this, [request, parent, isMain]);
    };
}
function restoreInterception() { (Module as any)._load = originalLoad; }

after(() => {
    assert.equal((Module as any)._load, originalLoad, 'the loader hook must be restored after loading');
});

const runScenario = async <T>(
    fail: FakeConnection['fail'],
    fn: (connection: FakeConnection) => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> => {
    scenario.connection = makeConnection(fail);
    try {
        const value = await (dbModule.withTransaction as (fn: (c: FakeConnection) => Promise<T>) => Promise<T>)(fn);
        return { ok: true, value };
    } catch (error) {
        return { ok: false, error };
    }
};

const WORK_ERROR = new Error('synthetic work failure');
const COMMIT_ERROR = new Error('synthetic lost COMMIT acknowledgement');
const ROLLBACK_ERROR = new Error('synthetic rollback failure');
const BEGIN_ERROR = new Error('synthetic BEGIN failure');

// ---------------------------------------------------------------------------
// The happy path — release is correct only when the outcome is certain
// ---------------------------------------------------------------------------

test('commit success: the connection is released exactly once and the result is returned', async () => {
    const outcome = await runScenario({}, async (connection) => {
        connection.events.push('work');
        return 'unit-result';
    });

    assert.deepEqual(outcome, { ok: true, value: 'unit-result' });
    const connection = scenario.connection!;
    assert.deepEqual(connection.events, ['begin', 'work', 'commit', 'release']);
    assert.equal(connection.destroyCalls, 0, 'a committed connection is clean and may be recycled');
    assert.equal(connection.releaseCalls, 1, 'exactly one release');
});

// ---------------------------------------------------------------------------
// The regression — an ambiguous COMMIT destroys the connection
// ---------------------------------------------------------------------------

test('commit failure with successful rollback: the connection is DESTROYED, never released', async () => {
    // This is the exact defect sequence from audit finding B and the synthetic
    // probe: begin → work → commit(reject) → rollback(success) must NOT end in
    // release. A rollback after a lost COMMIT acknowledgement is not evidence
    // that the write did not land.
    const outcome = await runScenario({ commit: COMMIT_ERROR }, async (connection) => {
        connection.events.push('work');
        return 'never-returned';
    });

    assert.equal(outcome.ok, false, 'no success is reported for an ambiguous commit');
    if (!outcome.ok) assert.equal(outcome.error, COMMIT_ERROR, 'the ORIGINAL commit error is rethrown, not a cleanup error');

    const connection = scenario.connection!;
    assert.deepEqual(connection.events, ['begin', 'work', 'commit', 'rollback', 'destroy']);
    assert.equal(connection.releaseCalls, 0, 'an ambiguous connection must never re-enter the pool');
    assert.equal(connection.destroyCalls, 1, 'exactly one destroy');
    assert.equal(connection.commitCalls, 1, 'no automatic retry of the COMMIT');
});

test('commit failure with rollback failure: destroyed once, the COMMIT error is preserved', async () => {
    const outcome = await runScenario(
        { commit: COMMIT_ERROR, rollback: ROLLBACK_ERROR },
        async (connection) => { connection.events.push('work'); return 'never-returned'; },
    );

    assert.equal(outcome.ok, false);
    if (!outcome.ok) assert.equal(outcome.error, COMMIT_ERROR, 'the commit error survives the rollback failure');
    const connection = scenario.connection!;
    assert.deepEqual(connection.events, ['begin', 'work', 'commit', 'rollback', 'destroy']);
    assert.equal(connection.releaseCalls, 0);
    assert.equal(connection.destroyCalls, 1);
});

// ---------------------------------------------------------------------------
// Work and admission failures — release is correct when the outcome is certain
// ---------------------------------------------------------------------------

test('work failure: rollback succeeds, the connection is released, the original error is rethrown', async () => {
    const outcome = await runScenario({}, async () => { throw WORK_ERROR; });

    assert.equal(outcome.ok, false);
    if (!outcome.ok) assert.equal(outcome.error, WORK_ERROR);
    const connection = scenario.connection!;
    assert.deepEqual(connection.events, ['begin', 'rollback', 'release']);
    assert.equal(connection.destroyCalls, 0, 'no commit was attempted, so the state is known');
    assert.equal(connection.releaseCalls, 1);
});

test('work failure with rollback failure: destroyed once, the WORK error is preserved', async () => {
    const outcome = await runScenario({ rollback: ROLLBACK_ERROR }, async () => { throw WORK_ERROR; });

    assert.equal(outcome.ok, false);
    if (!outcome.ok) assert.equal(outcome.error, WORK_ERROR, 'the original work error survives the cleanup failure');
    const connection = scenario.connection!;
    assert.deepEqual(connection.events, ['begin', 'rollback', 'destroy']);
    assert.equal(connection.releaseCalls, 0);
    assert.equal(connection.destroyCalls, 1);
});

test('begin failure: the connection is not released with unknown state', async () => {
    // BEGIN rejecting leaves admission incomplete: the rollback that follows
    // has no transaction to undo, so the connection state is unknown and it is
    // destroyed rather than recycled.
    const outcome = await runScenario(
        { begin: BEGIN_ERROR, rollback: ROLLBACK_ERROR },
        async () => 'never-runs',
    );

    assert.equal(outcome.ok, false);
    if (!outcome.ok) assert.equal(outcome.error, BEGIN_ERROR);
    const connection = scenario.connection!;
    assert.deepEqual(connection.events, ['begin', 'rollback', 'destroy']);
    assert.equal(connection.commitCalls, 0, 'no commit is attempted when admission failed');
    assert.equal(connection.releaseCalls, 0);
    assert.equal(connection.destroyCalls, 1);
});

// ---------------------------------------------------------------------------
// Cleanup exactly once, and no retry semantics
// ---------------------------------------------------------------------------

test('cleanup runs exactly once on every path (release XOR destroy)', async () => {
    const cases: Array<[string, FakeConnection['fail']]> = [
        ['success', {}],
        ['work failure', {}],
        ['work + rollback failure', { rollback: ROLLBACK_ERROR }],
        ['commit failure', { commit: COMMIT_ERROR }],
        ['commit + rollback failure', { commit: COMMIT_ERROR, rollback: ROLLBACK_ERROR }],
        ['begin failure', { begin: BEGIN_ERROR, rollback: ROLLBACK_ERROR }],
    ];
    for (const [name, fail] of cases) {
        await runScenario(fail, async (connection) => { connection.events.push('work'); return name; });
        const connection = scenario.connection!;
        const cleanups = connection.releaseCalls + connection.destroyCalls;
        assert.equal(cleanups, 1, `${name}: exactly one terminal cleanup (release or destroy)`);
    }
});

test('a failed release on the success path destroys the connection and the result still stands', async () => {
    const outcome = await runScenario({ release: new Error('synthetic release failure') }, async (connection) => {
        connection.events.push('work');
        return 'committed';
    });

    assert.deepEqual(outcome, { ok: true, value: 'committed' }, 'cleanup has no authority to fail the unit');
    const connection = scenario.connection!;
    assert.deepEqual(connection.events, ['begin', 'work', 'commit', 'release', 'destroy']);
    assert.equal(connection.releaseCalls, 1);
    assert.equal(connection.destroyCalls, 1, 'a connection that cannot be released is destroyed instead');
});
