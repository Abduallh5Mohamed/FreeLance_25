/**
 * M7 — impersonation approval expiry: write-convention regression.
 *
 * The defect this file pins: `transitionToActive` persisted `expires_at` as a
 * pre-formatted UTC wall-clock STRING while the same column is written by
 * `insertSession` as a `Date` and read back through a pool pinned to
 * `timezone: '+02:00'` (`src/db.ts`). One column, two conventions: on a
 * database whose session time zone is `+02:00` the approved expiry landed two
 * hours in the past and every activated session was refused as `expired`.
 *
 * The assertions below drive the REAL production SQL store
 * (`createSqlImpersonationStore`) and the REAL verifier
 * (`createImpersonationVerifier`) against a capturing `ImpersonationDb`, and
 * convert the captured parameter with the driver's OWN codec — the binary
 * parameter encoder `Packet.writeDate` and the DATETIME decoder
 * `Packet.readDateTime`, the exact pair `pool.execute` uses — so the
 * round-trip is the driver's, not a hand-rolled offset. No connection, no
 * network, no real database.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    createImpersonationVerifier,
    createSqlImpersonationStore,
    signImpersonationToken,
    type ImpersonationDb,
    type ImpersonationSessionRow,
} from '../src/services/impersonation';

/**
 * The offset `src/db.ts` pins on the pool. The guard test at the bottom fails
 * if the production pool offset ever moves, so this constant cannot silently
 * drift away from the application's convention.
 */
const POOL_TIMEZONE = '+02:00';

const requireFromHere = createRequire(import.meta.url);

interface DriverPacket {
    offset: number;
    writeDate(date: Date, timezone: string): void;
    readDateTime(timezone: string): Date;
}

/**
 * mysql2's own packet codec, resolved from the installed package rather than
 * a hardcoded path. `pool.execute` encodes a `Date` parameter with
 * `writeDate(date, config.timezone)` and decodes a DATETIME/TIMESTAMP column
 * with `readDateTime(config.timezone)`; this test calls those two functions
 * directly so the round-trip is the driver's real behaviour.
 */
const loadDriverCodec = (): (new (id: number, buffer: Buffer, start: number, end: number) => DriverPacket) => {
    const entry = requireFromHere.resolve('mysql2');
    const packetPath = path.join(path.dirname(entry), 'lib', 'packets', 'packet.js');
    return requireFromHere(packetPath) as new (id: number, buffer: Buffer, start: number, end: number) => DriverPacket;
};

const Packet = loadDriverCodec();

/** What the driver sends for a `Date` parameter, and what the column yields. */
const driverRoundTrip = (value: Date): Date => {
    const packet = new Packet(0, Buffer.alloc(32), 0, 32);
    packet.offset = 0;
    packet.writeDate(value, POOL_TIMEZONE);
    packet.offset = 0;
    return packet.readDateTime(POOL_TIMEZONE);
};

/**
 * The DATETIME/TIMESTAMP value MySQL stores for a STRING parameter: the text
 * is read as a wall clock in the session time zone, with no conversion of its
 * own. This is how the previous convention lost two hours.
 */
const databaseInterpretationOfString = (wallClock: string): Date =>
    new Date(`${wallClock.replace(' ', 'T')}${POOL_TIMEZONE}`);

interface CapturedStatement {
    sql: string;
    params: readonly unknown[];
}

interface CapturingDb extends ImpersonationDb {
    readonly calls: CapturedStatement[];
}

const createCapturingDb = (
    rows: { session?: ImpersonationSessionRow | null; affectedRows?: number } = {},
): CapturingDb => {
    const calls: CapturedStatement[] = [];
    const record = (sql: string, params?: unknown[]): void => {
        calls.push({ sql, params: params ?? [] });
    };
    return {
        calls,
        query: async <T>(sql: string, params?: unknown[]): Promise<T[]> => {
            record(sql, params);
            return [] as T[];
        },
        queryOne: async <T>(sql: string, params?: unknown[]): Promise<T | null> => {
            record(sql, params);
            return (rows.session ?? null) as T | null;
        },
        execute: async (sql: string, params?: unknown[]): Promise<{ insertId?: number, affectedRows?: number }> => {
            record(sql, params);
            return { insertId: 0, affectedRows: rows.affectedRows ?? 1 };
        },
    };
};

const APPROVER_ID = 'c0000000-0000-4000-8000-000000000002';
const SESSION_ID = 'f0000000-0000-4000-8000-00000000000f';

const baseRow: ImpersonationSessionRow = {
    id: SESSION_ID,
    started_by: 'c0000000-0000-4000-8000-000000000001',
    approved_by: APPROVER_ID,
    target_user_id: 'd0000000-0000-4000-8000-000000000001',
    tenant_id: 'a0000000-0000-4000-8000-00000000000a',
    reason: 'hermetic expiry convention regression',
    scope: 'read',
    status: 'active',
    requested_seconds: 600,
    expires_at: null,
    revoked_at: null,
    revoked_by: null,
    created_at: '2026-10-19 20:00:00',
};

const findUpdate = (db: CapturingDb, marker: string): CapturedStatement => {
    const statement = db.calls.find((call) => call.sql.includes(marker));
    assert.ok(statement, `the store must issue a statement containing ${marker}`);
    return statement;
};

// ---------------------------------------------------------------------------
// 1. The approval write binds a Date, and the driver round-trip preserves it.
// ---------------------------------------------------------------------------

test('transitionToActive binds expires_at as a Date the driver round-trips unchanged', async () => {
    const db = createCapturingDb();
    const store = createSqlImpersonationStore(db);
    const intended = new Date(Date.UTC(2026, 9, 19, 23, 30, 12, 0));
    const now = new Date(Date.UTC(2026, 9, 19, 23, 20, 12, 0));

    const moved = await store.transitionToActive(SESSION_ID, APPROVER_ID, intended, now);
    assert.equal(moved, 1, 'the guarded transition must report the single updated row');

    const update = findUpdate(db, 'SET approved_by = ?');
    const bound = update.params[1];
    assert.ok(
        bound instanceof Date,
        `expires_at must be bound as a Date (the driver converts it with the pool offset); received ${typeof bound}`,
    );
    assert.equal(
        bound.getTime(), intended.getTime(),
        'the bound Date must carry the intended instant, not a re-serialized one',
    );

    // The driver encodes the parameter and decodes the column with the SAME
    // offset, so the instant survives the write/read pair exactly.
    const persisted = driverRoundTrip(bound);
    assert.equal(
        persisted.getTime(), intended.getTime(),
        `the driver round-trip must preserve the instant (got ${persisted.toISOString()})`,
    );

    // And the previous convention demonstrably does not: the same instant
    // pre-formatted as a UTC wall clock is read back two hours earlier.
    const previousConvention = databaseInterpretationOfString(
        intended.toISOString().slice(0, 19).replace('T', ' '),
    );
    assert.equal(
        intended.getTime() - previousConvention.getTime(), 7_200_000,
        'the pre-formatted UTC string convention must lose exactly the pool offset',
    );
});

test('insertSession binds the same column with the same Date convention', async () => {
    const db = createCapturingDb();
    const store = createSqlImpersonationStore(db);
    const expires = new Date(Date.UTC(2026, 9, 20, 0, 15, 0, 0));

    await store.insertSession({ ...baseRow, status: 'pending_approval', expires_at: expires });

    const insert = findUpdate(db, 'INSERT INTO impersonation_sessions');
    const bound = insert.params[9];
    assert.ok(bound instanceof Date, 'insertSession must bind expires_at as a Date');
    assert.equal(bound.getTime(), expires.getTime());
    assert.equal(
        driverRoundTrip(bound).getTime(), expires.getTime(),
        'both writers of expires_at must survive the same round-trip',
    );
});

// ---------------------------------------------------------------------------
// 2. Behaviour at the verifier: usable immediately, denied at the boundary.
// ---------------------------------------------------------------------------

const verifierFor = (row: ImpersonationSessionRow, nowMs: () => number) =>
    createImpersonationVerifier({
        store: {
            findSession: async () => row,
            lockSession: async () => row,
            insertSession: async () => undefined,
            transitionToActive: async () => 1,
            transitionToRevoked: async () => 1,
            listRecentForActor: async () => [],
            countActiveForTargetUser: async () => 1,
            lockTargetUser: async () => ({ id: row.target_user_id }),
        },
        tokenKey: () => VERIFIER_KEY,
        now: () => new Date(nowMs()),
    });

const VERIFIER_KEY = Buffer.from('e'.repeat(64), 'utf8');
const issuedToken = (row: ImpersonationSessionRow, atMs: number): string =>
    signImpersonationToken(row, false, VERIFIER_KEY, atMs);

test('an approval whose expiry is in the future is usable on the very next request', async () => {
    const db = createCapturingDb();
    const store = createSqlImpersonationStore(db);
    const approvedAt = Date.UTC(2026, 9, 19, 23, 20, 12, 0);
    const intended = new Date(approvedAt + 600_000);

    await store.transitionToActive(SESSION_ID, APPROVER_ID, intended, new Date(approvedAt));
    const bound = findUpdate(db, 'SET approved_by = ?').params[1];
    assert.ok(bound instanceof Date);

    // The row the application reads back, built from the captured parameter
    // through the driver's own codec.
    const row: ImpersonationSessionRow = { ...baseRow, expires_at: driverRoundTrip(bound) };
    const token = issuedToken(row, approvedAt);
    const verdict = await verifierFor(row, () => approvedAt + 1_000)(token);

    assert.equal(verdict.ok, true, `a future expiry must be accepted: ${JSON.stringify(verdict)}`);
    assert.ok(verdict.ok && verdict.context);
    assert.equal(verdict.ok ? verdict.context.sessionId : '', SESSION_ID);
    assert.equal(verdict.ok ? verdict.context.actorUserId : '', baseRow.started_by);
    assert.equal(verdict.ok ? verdict.context.targetUserId : '', baseRow.target_user_id);
});

test('the exact expiry instant is denied and one millisecond earlier is allowed', async () => {
    const db = createCapturingDb();
    const store = createSqlImpersonationStore(db);
    const approvedAt = Date.UTC(2026, 9, 19, 23, 20, 12, 0);
    const intended = new Date(approvedAt + 600_000);

    await store.transitionToActive(SESSION_ID, APPROVER_ID, intended, new Date(approvedAt));
    const bound = findUpdate(db, 'SET approved_by = ?').params[1];
    assert.ok(bound instanceof Date);
    const row: ImpersonationSessionRow = { ...baseRow, expires_at: driverRoundTrip(bound) };
    const token = issuedToken(row, approvedAt);

    const justBefore = await verifierFor(row, () => intended.getTime() - 1)(token);
    assert.equal(justBefore.ok, true, 'one millisecond before the boundary must still be accepted');

    const atBoundary = await verifierFor(row, () => intended.getTime())(token);
    assert.equal(atBoundary.ok, false, 'the exact expiry instant must be refused');
    assert.equal(atBoundary.ok ? '' : atBoundary.reason, 'expired');

    const afterBoundary = await verifierFor(row, () => intended.getTime() + 1)(token);
    assert.equal(afterBoundary.ok, false);
    assert.equal(afterBoundary.ok ? '' : afterBoundary.reason, 'expired');
});

test('the previous string convention is refused as expired the moment it is approved', async () => {
    const approvedAt = Date.UTC(2026, 9, 19, 23, 20, 12, 0);
    const intended = new Date(approvedAt + 600_000);

    // Exactly what the defect persisted, and exactly how the pool read it.
    const legacyWallClock = intended.toISOString().slice(0, 19).replace('T', ' ');
    const legacyRow: ImpersonationSessionRow = {
        ...baseRow,
        expires_at: databaseInterpretationOfString(legacyWallClock),
    };
    const token = issuedToken(legacyRow, approvedAt);
    const verdict = await verifierFor(legacyRow, () => approvedAt + 1_000)(token);

    assert.equal(verdict.ok, false, 'the defect must make the approved session unusable');
    assert.equal(verdict.ok ? '' : verdict.reason, 'expired');
});

// ---------------------------------------------------------------------------
// 3. The repaired write does not disturb the guarded transition.
// ---------------------------------------------------------------------------

test('the guarded transition keeps its predicates and still reports a lost race', async () => {
    const db = createCapturingDb({ affectedRows: 0 });
    const store = createSqlImpersonationStore(db);
    const intended = new Date(Date.UTC(2026, 9, 19, 23, 30, 12, 0));

    const moved = await store.transitionToActive(SESSION_ID, APPROVER_ID, intended, new Date());
    assert.equal(moved, 0, 'a transition that matched no row must report zero');

    const update = findUpdate(db, 'SET approved_by = ?');
    assert.match(update.sql, /status = 'pending_approval'/);
    assert.match(update.sql, /started_by <> \?/, 'self-approval must stay impossible in SQL');
    assert.equal(update.params[3], SESSION_ID);
    assert.equal(update.params[4], APPROVER_ID);
});

test('the pool offset this test models is still the one src/db.ts pins', () => {
    const source = readFileSync(
        fileURLToPath(new URL('../src/db.ts', import.meta.url)),
        'utf8',
    );
    assert.ok(
        source.includes(`timezone: '${POOL_TIMEZONE}'`),
        `src/db.ts must still pin the pool to ${POOL_TIMEZONE}; this test models that offset`,
    );
});
