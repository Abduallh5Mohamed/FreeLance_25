/**
 * B2-C-PERSISTENCE adapter tests for `billing-ledger-sql.ts`.
 *
 * HONEST LIMIT: the recording connection verifies SQL text, bindings, savepoint
 * and CAS discipline. It is NOT MySQL and does not prove InnoDB locking,
 * FK/CHECK enforcement, collation or the 8.0.16+ prerequisite.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import {
    BillingLedgerSqlError,
    createBillingLedgerSqlStore,
    normalizeSqlBigInt,
    normalizeSqlVersion,
    type BillingSqlConnection,
} from '../src/services/billing-ledger-sql';
import { LedgerError, type InsertJournalInput } from '../src/services/billing-ledger';
import type { ReservationRecord } from '../src/services/billing-reservations';

interface RecordedStatement {
    readonly connId: number;
    readonly kind: 'query' | 'execute';
    readonly sql: string;
    readonly params: readonly unknown[];
}

interface HandlerResult {
    readonly rows?: readonly unknown[];
    readonly affectedRows?: number;
}

type Handler = (statement: RecordedStatement, db: RecordingDb) => Promise<HandlerResult>;

class RecordingConnection implements BillingSqlConnection {
    constructor(private readonly id: number, private readonly db: RecordingDb) {}

    query<T = Record<string, unknown>>(sql: string, params: readonly unknown[] = []): Promise<T[]> {
        return this.db.dispatch('query', this.id, sql, params) as Promise<T[]>;
    }

    execute(sql: string, params: readonly unknown[] = []): Promise<{ affectedRows?: number }> {
        return this.db.dispatch('execute', this.id, sql, params) as Promise<{ affectedRows?: number }>;
    }
}

class RecordingDb {
    readonly statements: RecordedStatement[] = [];
    commits = 0;
    rollbacks = 0;
    state: Record<string, unknown> = {};
    private connectionSeq = 0;

    constructor(public handler: Handler) {}

    async dispatch(
        kind: 'query' | 'execute',
        connId: number,
        sql: string,
        params: readonly unknown[],
    ): Promise<unknown> {
        const statement: RecordedStatement = { connId, kind, sql: String(sql), params: [...params] };
        this.statements.push(statement);
        const result = await this.handler(statement, this);
        return kind === 'query' ? (result.rows ?? []) : result;
    }

    readonly runner = async <T>(fn: (conn: BillingSqlConnection) => Promise<T>): Promise<T> => {
        const snapshot = JSON.stringify(this.state);
        const conn = new RecordingConnection(++this.connectionSeq, this);
        try {
            const result = await fn(conn);
            this.commits += 1;
            return result;
        } catch (error) {
            this.state = JSON.parse(snapshot) as Record<string, unknown>;
            this.rollbacks += 1;
            throw error;
        }
    };

    all(kind: 'query' | 'execute', fragment: string): RecordedStatement[] {
        return this.statements.filter((statement) => statement.kind === kind && statement.sql.includes(fragment));
    }

    indexOf(fragment: string): number {
        return this.statements.findIndex((statement) => statement.sql.includes(fragment));
    }

    get connIds(): Set<number> {
        return new Set(this.statements.map((statement) => statement.connId));
    }
}

const accountRow = (id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    id,
    tenant_id: 'tenant-1',
    kind: 'merchant_available',
    normal_side: 'credit',
    currency: 'USD',
    balance_minor: '1000',
    version: 2,
    ...overrides,
});

const journalRow = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: 'journal-1',
    tenant_id: 'tenant-1',
    currency: 'USD',
    journal_type: 'standard',
    reversal_of_journal_id: null,
    reference: null,
    description: null,
    created_at: '2026-10-21T10:00:00.000Z',
    idempotency_key: 'key-1',
    payload_hash: 'hash-1',
    ...overrides,
});

const journalInput = (overrides: Partial<InsertJournalInput> = {}): InsertJournalInput => ({
    journal: {
        id: 'journal-1',
        tenantId: 'tenant-1',
        currency: 'USD',
        journalType: 'standard',
        reversalOfJournalId: null,
        reference: null,
        description: null,
        createdAt: '2026-10-21T10:00:00.000Z',
    },
    lines: [
        { lineNo: 1, accountId: 'account-a', accountKind: 'merchant_available', direction: 'debit', amountMinor: 100n },
        { lineNo: 2, accountId: 'account-b', accountKind: 'merchant_reserved', direction: 'credit', amountMinor: 100n },
    ],
    balanceChanges: [
        { accountId: 'account-a', expectedVersion: 2, newBalanceMinor: 1100n, newVersion: 3 },
        { accountId: 'account-b', expectedVersion: 2, newBalanceMinor: 900n, newVersion: 3 },
    ],
    idempotencyKey: 'key-1',
    payloadHash: 'hash-1',
    ...overrides,
});

const preserveMutation = (statement: RecordedStatement, db: RecordingDb): HandlerResult => {
    if (statement.sql.startsWith('SAVEPOINT') || statement.sql.startsWith('RELEASE SAVEPOINT')
        || statement.sql.startsWith('ROLLBACK TO SAVEPOINT')) {
        return {};
    }
    if (statement.sql.includes('INSERT INTO billing_journals')) return { affectedRows: 1 };
    if (statement.sql.includes('INSERT INTO billing_idempotency_keys')) return { affectedRows: 1 };
    if (statement.sql.includes('INSERT INTO billing_journal_lines')) return { affectedRows: 1 };
    if (statement.sql.includes('UPDATE billing_accounts')) return { affectedRows: 1 };
    throw new Error(`unexpected SQL: ${statement.sql}`);
};

const reservation = (overrides: Partial<ReservationRecord> = {}): ReservationRecord => ({
    id: 'reservation-1',
    tenantId: 'tenant-1',
    reservationKey: 'reservation-key-1',
    payloadHash: 'reservation-hash-1',
    currency: 'USD',
    amountMinor: 250n,
    availableAccountId: 'account-a',
    reservedAccountId: 'account-b',
    status: 'reserved',
    version: 1,
    reserveJournalId: 'journal-1',
    releaseJournalId: null,
    consumeJournalId: null,
    consumeCounterAccountId: null,
    reference: null,
    description: null,
    createdAt: '2026-10-21T10:00:00.000Z',
    updatedAt: '2026-10-21T10:00:00.000Z',
    ...overrides,
});

const reservationRow = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: 'reservation-1',
    tenant_id: 'tenant-1',
    currency: 'USD',
    amount_minor: '250',
    available_account_id: 'account-a',
    reserved_account_id: 'account-b',
    status: 'reserved',
    version: 1,
    reserve_journal_id: 'journal-1',
    release_journal_id: null,
    consume_journal_id: null,
    consume_counter_account_id: null,
    reference: null,
    description: null,
    created_at: '2026-10-21T10:00:00.000Z',
    updated_at: '2026-10-21T10:00:00.000Z',
    ...overrides,
});

test('construction fails fast without a transaction runner', () => {
    assert.throws(() => createBillingLedgerSqlStore({} as never), /transaction runner/);
});

test('HK2 normalizes bigint, exact string and safe number, and rejects rounding', () => {
    assert.equal(normalizeSqlBigInt(10n, 'x'), 10n);
    assert.equal(normalizeSqlBigInt('10', 'x'), 10n);
    assert.equal(normalizeSqlBigInt(10, 'x'), 10n);
    assert.throws(() => normalizeSqlBigInt(Number.MAX_SAFE_INTEGER + 1, 'x'), BillingLedgerSqlError);
    assert.throws(() => normalizeSqlBigInt('1.5', 'x'), BillingLedgerSqlError);
    assert.throws(() => normalizeSqlBigInt('-1', 'x'), BillingLedgerSqlError);
    assert.throws(() => normalizeSqlBigInt(11n, 'x', { max: 10n }), BillingLedgerSqlError);
});

test('HK2 rejects versions outside the safe integer range', () => {
    assert.equal(normalizeSqlVersion('5', 'v'), 5);
    assert.equal(normalizeSqlVersion(5n, 'v'), 5);
    assert.throws(() => normalizeSqlVersion('9007199254740992', 'v'), BillingLedgerSqlError);
    assert.throws(() => normalizeSqlVersion(Number.MAX_SAFE_INTEGER + 2, 'v'), BillingLedgerSqlError);
    assert.throws(() => normalizeSqlVersion(-1, 'v'), BillingLedgerSqlError);
});

test('journal insert locks accounts in ascending id order and writes on one connection', async () => {
    const db = new RecordingDb(async (statement) => {
        if (statement.sql.includes('FROM billing_accounts') && statement.sql.includes('FOR UPDATE')) {
            return { rows: [accountRow('account-b'), accountRow('account-a')] };
        }
        return preserveMutation(statement, db);
    });
    const store = createBillingLedgerSqlStore({ transaction: db.runner });

    const result = await store.runAtomic((tx) => tx.insertJournal(journalInput()));

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.journal.id, 'journal-1');
    const lock = db.all('query', 'FOR UPDATE')[0];
    assert.ok(lock);
    assert.match(lock.sql, /ORDER BY id ASC/);
    assert.deepEqual(lock.params, ['tenant-1', 'account-a', 'account-b']);
    const savepoint = db.indexOf('SAVEPOINT billing_insert_journal');
    const journalInsert = db.indexOf('INSERT INTO billing_journals');
    const registryInsert = db.indexOf('INSERT INTO billing_idempotency_keys');
    const lineInsert = db.indexOf('INSERT INTO billing_journal_lines');
    const accountUpdate = db.indexOf('UPDATE billing_accounts');
    const release = db.indexOf('RELEASE SAVEPOINT billing_insert_journal');
    assert.ok(savepoint >= 0 && savepoint < journalInsert && journalInsert < registryInsert
        && registryInsert < lineInsert && lineInsert < accountUpdate && accountUpdate < release);
    const line = db.all('execute', 'INSERT INTO billing_journal_lines')[0];
    assert.ok(line);
    assert.equal(line.params[6], '100');
    const update = db.all('execute', 'UPDATE billing_accounts')[0];
    assert.ok(update);
    assert.match(update.sql, /WHERE id = \? AND tenant_id = \? AND version = \?/);
    assert.deepEqual(update.params, ['1100', 'account-a', 'tenant-1', 2]);
    assert.equal(db.connIds.size, 1);
    assert.equal(db.commits, 1);
});

test('unbalanced journal is rejected before any SQL', async () => {
    const db = new RecordingDb(async () => {
        throw new Error('no SQL expected');
    });
    const store = createBillingLedgerSqlStore({ transaction: db.runner });
    const unbalanced = journalInput({
        lines: [
            { lineNo: 1, accountId: 'account-a', accountKind: 'merchant_available', direction: 'debit', amountMinor: 100n },
            { lineNo: 2, accountId: 'account-b', accountKind: 'merchant_reserved', direction: 'credit', amountMinor: 99n },
        ],
    });

    await assert.rejects(
        store.runAtomic((tx) => tx.insertJournal(unbalanced)),
        (error: unknown) => error instanceof LedgerError && error.code === 'unbalanced_journal',
    );
    assert.equal(db.statements.length, 0);
});

test('an account CAS loss rolls back the journal savepoint and reports the account', async () => {
    const db = new RecordingDb(async (statement) => {
        if (statement.sql.includes('FROM billing_accounts') && statement.sql.includes('FOR UPDATE')) {
            return { rows: [accountRow('account-a'), accountRow('account-b')] };
        }
        if (statement.sql.includes('UPDATE billing_accounts')) return { affectedRows: 0 };
        return preserveMutation(statement, db);
    });
    const store = createBillingLedgerSqlStore({ transaction: db.runner });

    const result = await store.runAtomic((tx) => tx.insertJournal(journalInput()));

    assert.deepEqual(result, { ok: false, reason: 'account_version_conflict', accountId: 'account-a' });
    assert.equal(db.all('execute', 'INSERT INTO billing_journal_lines').length, 2);
    assert.equal(db.all('execute', 'ROLLBACK TO SAVEPOINT billing_insert_journal').length, 1);
    assert.equal(db.all('execute', 'RELEASE SAVEPOINT billing_insert_journal').length, 1);
});

test('an interleaving ledger write loses the version CAS against the locked snapshot', async () => {
    const state: Record<string, number> = { 'account-a': 2, 'account-b': 2 };
    const db = new RecordingDb(async (statement) => {
        if (statement.sql.includes('FROM billing_accounts') && statement.sql.includes('FOR UPDATE')) {
            return { rows: [accountRow('account-a', { version: state['account-a'] }), accountRow('account-b', { version: state['account-b'] })] };
        }
        if (statement.sql.includes('UPDATE billing_accounts')) {
            const accountId = String(statement.params[1]);
            const expected = Number(statement.params[3]);
            if (state[accountId] !== expected) return { affectedRows: 0 };
            state[accountId] = expected + 1;
            return { affectedRows: 1 };
        }
        return preserveMutation(statement, db);
    });
    const store = createBillingLedgerSqlStore({ transaction: db.runner });

    const first = await store.runAtomic((tx) => tx.insertJournal(journalInput()));
    const second = await store.runAtomic((tx) => tx.insertJournal(journalInput()));

    assert.equal(first.ok, true);
    assert.deepEqual(second, { ok: false, reason: 'account_version_conflict', accountId: 'account-a' });
    assert.equal(state['account-a'], 3);
    assert.equal(state['account-b'], 3);
});

test('a duplicate idempotency key with the same hash resolves as an HK1 replay', async () => {
    const db = new RecordingDb(async (statement) => {
        if (statement.sql.includes('FROM billing_accounts') && statement.sql.includes('FOR UPDATE')) {
            return { rows: [accountRow('account-a'), accountRow('account-b')] };
        }
        if (statement.sql.startsWith('INSERT INTO billing_idempotency_keys')) {
            const error = new Error('duplicate') as Error & { code: string };
            error.code = 'ER_DUP_ENTRY';
            throw error;
        }
        if (statement.sql.includes('FROM billing_idempotency_keys') && statement.sql.includes('scope = \'journal\'')) {
            return {
                rows: [{
                    tenant_id: 'tenant-1',
                    scope: 'journal',
                    idempotency_key: 'key-1',
                    payload_hash: 'hash-1',
                    journal_id: 'journal-1',
                    reservation_id: null,
                }],
            };
        }
        if (statement.sql.includes('FROM billing_journals j')) return { rows: [journalRow()] };
        if (statement.sql.includes('FROM billing_journal_lines')) {
            return {
                rows: [
                    { line_no: 1, account_id: 'account-a', account_kind: 'merchant_available', direction: 'debit', amount_minor: '100' },
                    { line_no: 2, account_id: 'account-b', account_kind: 'merchant_reserved', direction: 'credit', amount_minor: '100' },
                ],
            };
        }
        return preserveMutation(statement, db);
    });
    const store = createBillingLedgerSqlStore({ transaction: db.runner });

    const result = await store.runAtomic((tx) => tx.insertJournal(journalInput()));

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, 'idempotent_replay');
    if (result.reason !== 'idempotent_replay') return;
    assert.equal(result.journal.idempotencyKey, 'key-1');
    assert.equal(result.journal.lines.length, 2);
    assert.equal(db.all('execute', 'ROLLBACK TO SAVEPOINT billing_insert_journal').length, 1);
});

test('a duplicate idempotency key with another hash is an HK1 conflict', async () => {
    const db = new RecordingDb(async (statement) => {
        if (statement.sql.includes('FROM billing_accounts') && statement.sql.includes('FOR UPDATE')) {
            return { rows: [accountRow('account-a'), accountRow('account-b')] };
        }
        if (statement.sql.startsWith('INSERT INTO billing_idempotency_keys')) {
            const error = new Error('duplicate') as Error & { code: string };
            error.code = 'ER_DUP_ENTRY';
            throw error;
        }
        if (statement.sql.includes('FROM billing_idempotency_keys')) {
            return {
                rows: [{
                    tenant_id: 'tenant-1',
                    scope: 'journal',
                    idempotency_key: 'key-1',
                    payload_hash: 'different-hash',
                    journal_id: 'journal-1',
                    reservation_id: null,
                }],
            };
        }
        return preserveMutation(statement, db);
    });
    const store = createBillingLedgerSqlStore({ transaction: db.runner });

    const result = await store.runAtomic((tx) => tx.insertJournal(journalInput()));

    assert.deepEqual(result, { ok: false, reason: 'idempotency_conflict' });
    assert.equal(db.all('query', 'FROM billing_journals j').length, 0);
});

test('a journal foreign-key failure is typed, never a silent retry', async () => {
    const db = new RecordingDb(async (statement) => {
        if (statement.sql.includes('FROM billing_accounts') && statement.sql.includes('FOR UPDATE')) {
            return { rows: [accountRow('account-a'), accountRow('account-b')] };
        }
        if (statement.sql.includes('INSERT INTO billing_journal_lines')) {
            const error = new Error('fk') as Error & { code: string };
            error.code = 'ER_NO_REFERENCED_ROW_2';
            throw error;
        }
        return preserveMutation(statement, db);
    });
    const store = createBillingLedgerSqlStore({ transaction: db.runner });

    await assert.rejects(
        store.runAtomic((tx) => tx.insertJournal(journalInput())),
        (error: unknown) => error instanceof BillingLedgerSqlError && error.code === 'foreign_key_violation',
    );
    assert.equal(db.all('execute', 'ROLLBACK TO SAVEPOINT billing_insert_journal').length, 1);
});

test('journal replay lookup resolves through the tenant/scope registry', async () => {
    const db = new RecordingDb(async (statement) => {
        if (statement.sql.includes('FROM billing_idempotency_keys k')) {
            return { rows: [journalRow({ key_tenant_id: 'tenant-1', scope: 'journal' })] };
        }
        if (statement.sql.includes('FROM billing_journal_lines')) {
            return { rows: [{ line_no: 1, account_id: 'account-a', account_kind: 'merchant_available', direction: 'debit', amount_minor: '100' }] };
        }
        throw new Error(`unexpected SQL: ${statement.sql}`);
    });
    const store = createBillingLedgerSqlStore({ transaction: db.runner });

    const journal = await store.runAtomic((tx) => tx.findJournalByIdempotencyKey('tenant-1', 'key-1'));

    assert.ok(journal);
    assert.equal(journal.idempotencyKey, 'key-1');
    const query = db.all('query', 'FROM billing_idempotency_keys k')[0];
    assert.ok(query);
    assert.match(query.sql, /k\.scope = 'journal'/);
    assert.match(query.sql, /k\.tenant_id = \?/);
    assert.deepEqual(query.params, ['tenant-1', 'key-1']);
});

test('reservation insert serializes money as a string and maps duplicate to duplicate_key', async () => {
    const db = new RecordingDb(async (statement) => {
        if (statement.sql.startsWith('SAVEPOINT') || statement.sql.startsWith('ROLLBACK TO SAVEPOINT')
            || statement.sql.startsWith('RELEASE SAVEPOINT')) return {};
        if (statement.sql.includes('INSERT INTO billing_reservations')) {
            const error = new Error('duplicate') as Error & { code: string };
            error.code = 'ER_DUP_ENTRY';
            throw error;
        }
        throw new Error(`unexpected SQL: ${statement.sql}`);
    });
    const store = createBillingLedgerSqlStore({ transaction: db.runner });

    const result = await store.runAtomic((tx) => tx.insertReservation(reservation()));

    assert.deepEqual(result, { ok: false, reason: 'duplicate_key' });
    const insert = db.all('execute', 'INSERT INTO billing_reservations')[0];
    assert.ok(insert);
    assert.equal(insert.params[3], '250');
    assert.equal(insert.params[0], 'reservation-1');
    assert.equal(db.all('execute', 'ROLLBACK TO SAVEPOINT billing_insert_journal').length, 1);
});

test('reservation update CASes exactly once and returns the reserved row', async () => {
    const db = new RecordingDb(async (statement) => {
        if (statement.sql.includes('UPDATE billing_reservations')) return { affectedRows: 1 };
        if (statement.sql.includes('FROM billing_reservations r')) {
            return { rows: [reservationRow({ status: 'released', version: 2, release_journal_id: 'journal-2' })] };
        }
        throw new Error(`unexpected SQL: ${statement.sql}`);
    });
    const store = createBillingLedgerSqlStore({ transaction: db.runner });

    const result = await store.runAtomic((tx) => tx.updateReservation({
        tenantId: 'tenant-1',
        reservationId: 'reservation-1',
        expectedVersion: 1,
        status: 'released',
        releaseJournalId: 'journal-2',
        consumeJournalId: null,
        consumeCounterAccountId: null,
        updatedAt: '2026-10-21T11:00:00.000Z',
    }));

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.reservation.status, 'released');
    assert.equal(result.reservation.version, 2);
    const update = db.all('execute', 'UPDATE billing_reservations');
    assert.equal(update.length, 1);
    assert.ok(update[0]);
    assert.match(update[0].sql, /WHERE id = \? AND tenant_id = \? AND version = \? AND status = 'reserved'/);
    assert.deepEqual(update[0].params, [
        'released',
        'journal-2',
        null,
        null,
        '2026-10-21T11:00:00.000Z',
        'reservation-1',
        'tenant-1',
        1,
    ]);
});

test('a second release finds invalid_status instead of updating twice', async () => {
    const db = new RecordingDb(async (statement) => {
        if (statement.sql.includes('UPDATE billing_reservations')) return { affectedRows: 0 };
        if (statement.sql.includes('FROM billing_reservations r')) {
            return { rows: [reservationRow({ status: 'consumed', version: 2 })] };
        }
        throw new Error(`unexpected SQL: ${statement.sql}`);
    });
    const store = createBillingLedgerSqlStore({ transaction: db.runner });

    const result = await store.runAtomic((tx) => tx.updateReservation({
        tenantId: 'tenant-1',
        reservationId: 'reservation-1',
        expectedVersion: 2,
        status: 'released',
        releaseJournalId: null,
        consumeJournalId: null,
        consumeCounterAccountId: null,
        updatedAt: '2026-10-21T11:00:00.000Z',
    }));

    assert.deepEqual(result, { ok: false, reason: 'invalid_status' });
    assert.equal(db.all('execute', 'UPDATE billing_reservations').length, 1);
});

test('reservation event duplicate is a typed duplicate_key', async () => {
    const db = new RecordingDb(async (statement) => {
        if (statement.sql.includes('INSERT INTO billing_reservation_events')) {
            const error = new Error('duplicate') as Error & { code: string };
            error.code = 'ER_DUP_ENTRY';
            throw error;
        }
        throw new Error(`unexpected SQL: ${statement.sql}`);
    });
    const store = createBillingLedgerSqlStore({ transaction: db.runner });

    await assert.rejects(
        store.runAtomic((tx) => tx.insertReservationEvent({
            id: 'event-1',
            tenantId: 'tenant-1',
            reservationId: 'reservation-1',
            eventType: 'reserved',
            amountMinor: 250n,
            journalId: 'journal-1',
            versionAfter: 1,
            idempotencyKey: 'event-key-1',
            createdAt: '2026-10-21T10:00:00.000Z',
        })),
        (error: unknown) => error instanceof BillingLedgerSqlError && error.code === 'duplicate_key',
    );
    const insert = db.all('execute', 'INSERT INTO billing_reservation_events')[0];
    assert.ok(insert);
    assert.equal(insert.params[4], '250');
});
