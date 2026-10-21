/**
 * B2-C-PERSISTENCE — real SQL adapters for the internal ledger contracts.
 *
 * Implements `LedgerStore` / `LedgerTransaction` (billing-ledger.ts) and the
 * reservation contracts (`ReservationStore` / `ReservationTransaction` in
 * billing-reservations.ts) against:
 *   billing_accounts, billing_journals, billing_journal_lines,
 *   billing_reservations, billing_idempotency_keys,
 *   billing_reservation_events
 * from migration `20261021_02_internal_financial_ledger.sql`.
 *
 * SOURCE CODE ONLY. Nothing here executes SQL or opens a connection. Every
 * statement of a unit of work is issued on the caller-injected transaction
 * connection. A missing runner throws at construction; there is no pooled query
 * and no autocommit fallback.
 *
 * MONEY: exact integer minor units only. BIGINT columns may be returned by the
 * driver as `bigint`, decimal `string` or (only when exactly representable) a
 * safe `number`. `normalizeSqlBigInt` rejects every other shape (never
 * `Number()` on money). Required mysql2 options for production binding:
 *   `supportBigNumbers: true`, `bigNumberStrings: true`.
 * Versions are JS counters; anything outside `Number.isSafeInteger` is rejected
 * with a typed error instead of being silently rounded.
 *
 * HK1: journal/reservation replay resolves through `billing_idempotency_keys`
 *      `(tenant_id, scope, idempotency_key)`, and the adapter verifies tenant,
 *      scope and `payload_hash`. A mismatch is a conflict, never a silent reuse.
 * HK2: one normalization path for BIGINT values, safe for number/string/bigint.
 */

import {
    ACCOUNT_KINDS,
    AccountKind,
    AccountBalanceChange,
    InsertJournalInput,
    InsertJournalResult,
    JournalLineRecord,
    JournalRecord,
    LedgerAccount,
    LedgerError,
    LedgerStore,
    LedgerTransaction,
    LineDirection,
    MAX_ACCOUNT_BALANCE_MINOR,
    MAX_AMOUNT_MINOR,
} from './billing-ledger';
import {
    InsertReservationResult,
    ReservationEventInput,
    ReservationRecord,
    ReservationStatus,
    ReservationStore,
    ReservationTransaction,
    UpdateReservationInput,
    UpdateReservationResult,
} from './billing-reservations';

export interface BillingSqlConnection {
    query<T = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<T[]>;
    execute(
        sql: string,
        params?: readonly unknown[],
    ): Promise<{ affectedRows?: number | string; insertId?: number | string }>;
}

export type BillingSqlTransactionRunner = <T>(
    fn: (conn: BillingSqlConnection) => Promise<T>,
) => Promise<T>;

export interface BillingLedgerSqlDeps {
    transaction: BillingSqlTransactionRunner;
}

export type BillingLedgerSqlErrorCode =
    | 'invalid_runner'
    | 'unsafe_integer'
    | 'version_out_of_range'
    | 'invalid_row'
    | 'duplicate_key'
    | 'foreign_key_violation';

export class BillingLedgerSqlError extends Error {
    constructor(public readonly code: BillingLedgerSqlErrorCode, message: string) {
        super(message);
        this.name = 'BillingLedgerSqlError';
    }
}

const INTEGER_TEXT = /^-?\d+$/;

/**
 * HK2: the single BIGINT normalizer. Accepts a bigint, a decimal string, or a
 * number only while it is exactly representable as a safe integer. Money is
 * never coerced through `Number()`.
 */
export function normalizeSqlBigInt(
    value: unknown,
    field: string,
    options: { allowNegative?: boolean; max?: bigint } = {},
): bigint {
    let parsed: bigint;
    if (typeof value === 'bigint') {
        parsed = value;
    } else if (typeof value === 'string') {
        const text = value.trim();
        if (!INTEGER_TEXT.test(text)) {
            throw new BillingLedgerSqlError('unsafe_integer', `${field} is not an exact integer string`);
        }
        parsed = BigInt(text);
    } else if (typeof value === 'number') {
        if (!Number.isSafeInteger(value)) {
            throw new BillingLedgerSqlError('unsafe_integer', `${field} is a number outside the safe integer range`);
        }
        parsed = BigInt(value);
    } else {
        throw new BillingLedgerSqlError('unsafe_integer', `${field} must be a bigint, integer string or safe integer`);
    }
    if (options.allowNegative !== true && parsed < 0n) {
        throw new BillingLedgerSqlError('unsafe_integer', `${field} must not be negative`);
    }
    if (options.max !== undefined && parsed > options.max) {
        throw new BillingLedgerSqlError('unsafe_integer', `${field} exceeds its exact integer bound`);
    }
    return parsed;
}

/** HK2: versions stay JS counters and must be safe non-negative integers. */
export function normalizeSqlVersion(value: unknown, field: string): number {
    let parsed: number;
    if (typeof value === 'number') {
        parsed = value;
    } else if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
        parsed = Number(value.trim());
    } else if (typeof value === 'bigint') {
        if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
            throw new BillingLedgerSqlError('version_out_of_range', `${field} is outside the safe integer range`);
        }
        parsed = Number(value);
    } else {
        throw new BillingLedgerSqlError('version_out_of_range', `${field} is not a safe integer version`);
    }
    if (!Number.isSafeInteger(parsed) || parsed < 0) {
        throw new BillingLedgerSqlError('version_out_of_range', `${field} is outside the safe integer range`);
    }
    return parsed;
}

const affectedRowsOf = (result: { affectedRows?: number | string }): number => {
    const value = typeof result.affectedRows === 'string' ? Number(result.affectedRows) : result.affectedRows;
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
};

const isDuplicateError = (error: unknown): boolean =>
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ER_DUP_ENTRY';

const isForeignKeyError = (error: unknown): boolean => {
    if (typeof error !== 'object' || error === null) return false;
    const code = (error as { code?: unknown }).code;
    return code === 'ER_NO_REFERENCED_ROW_2' || code === 'ER_ROW_IS_REFERENCED_2';
};

const toIso = (value: string | Date): string => {
    const date = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(date.getTime())) {
        throw new BillingLedgerSqlError('invalid_row', 'a ledger timestamp is not parseable');
    }
    return date.toISOString();
};

const asAccountKind = (value: string): AccountKind => {
    if (!(ACCOUNT_KINDS as readonly string[]).includes(value)) {
        throw new BillingLedgerSqlError('invalid_row', 'a ledger account has an unknown kind');
    }
    return value as AccountKind;
};

const asDirection = (value: string): LineDirection => {
    if (value !== 'debit' && value !== 'credit') {
        throw new BillingLedgerSqlError('invalid_row', 'a ledger line has an unknown direction');
    }
    return value;
};

const asReservationStatus = (value: string): ReservationStatus => {
    if (value !== 'reserved' && value !== 'released' && value !== 'consumed') {
        throw new BillingLedgerSqlError('invalid_row', 'a reservation has an unknown status');
    }
    return value;
};

interface AccountRowDb {
    id: string;
    tenant_id: string;
    kind: string;
    normal_side: string;
    currency: string;
    balance_minor: unknown;
    version: unknown;
}

interface JournalRowDb {
    id: string;
    tenant_id: string;
    currency: string;
    journal_type: string;
    reversal_of_journal_id: string | null;
    reference: string | null;
    description: string | null;
    created_at: string | Date;
    idempotency_key?: string | null;
    payload_hash?: string | null;
}

interface LineRowDb {
    line_no: unknown;
    account_id: string;
    account_kind: string;
    direction: string;
    amount_minor: unknown;
}

interface ReservationRowDb {
    id: string;
    tenant_id: string;
    currency: string;
    amount_minor: unknown;
    available_account_id: string;
    reserved_account_id: string;
    status: string;
    version: unknown;
    reserve_journal_id: string;
    release_journal_id: string | null;
    consume_journal_id: string | null;
    consume_counter_account_id: string | null;
    reference: string | null;
    description: string | null;
    created_at: string | Date;
    updated_at: string | Date;
    reservation_key?: string | null;
    key_payload_hash?: string | null;
}

interface IdempotencyRowDb {
    tenant_id: string;
    scope: string;
    idempotency_key: string;
    payload_hash: string;
    journal_id: string | null;
    reservation_id: string | null;
}

const ACCOUNT_COLUMNS = 'id, tenant_id, kind, normal_side, currency, balance_minor, version';
const JOURNAL_COLUMNS = `j.id, j.tenant_id, j.currency, j.journal_type,
    j.reversal_of_journal_id, j.reference, j.description, j.created_at`;
const RESERVATION_COLUMNS = `r.id, r.tenant_id, r.currency, r.amount_minor,
    r.available_account_id, r.reserved_account_id, r.status, r.version,
    r.reserve_journal_id, r.release_journal_id, r.consume_journal_id,
    r.consume_counter_account_id, r.reference, r.description, r.created_at, r.updated_at`;

const mapAccount = (row: AccountRowDb): LedgerAccount => {
    if (row.normal_side !== 'debit' && row.normal_side !== 'credit') {
        throw new BillingLedgerSqlError('invalid_row', 'a ledger account has an unknown normal side');
    }
    return {
        id: row.id,
        tenantId: row.tenant_id,
        kind: asAccountKind(row.kind),
        normalSide: row.normal_side,
        currency: row.currency,
        balanceMinor: normalizeSqlBigInt(row.balance_minor, 'billing_accounts.balance_minor'),
        version: normalizeSqlVersion(row.version, 'billing_accounts.version'),
    };
};

const mapReservation = (row: ReservationRowDb): ReservationRecord => ({
    id: row.id,
    tenantId: row.tenant_id,
    reservationKey: row.reservation_key ?? '',
    payloadHash: row.key_payload_hash ?? '',
    currency: row.currency,
    amountMinor: normalizeSqlBigInt(row.amount_minor, 'billing_reservations.amount_minor', {
        max: MAX_AMOUNT_MINOR,
    }),
    availableAccountId: row.available_account_id,
    reservedAccountId: row.reserved_account_id,
    status: asReservationStatus(row.status),
    version: normalizeSqlVersion(row.version, 'billing_reservations.version'),
    reserveJournalId: row.reserve_journal_id,
    releaseJournalId: row.release_journal_id,
    consumeJournalId: row.consume_journal_id,
    consumeCounterAccountId: row.consume_counter_account_id,
    reference: row.reference,
    description: row.description,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
});

class AccountCasConflict extends Error {
    constructor(public readonly accountId: string) {
        super('billing account version changed');
        this.name = 'AccountCasConflict';
    }
}

const SAVEPOINT = 'billing_insert_journal';

class BillingLedgerSqlTransaction implements ReservationTransaction {
    constructor(private readonly conn: BillingSqlConnection) {}

    async getAccount(tenantId: string, accountId: string): Promise<LedgerAccount | null> {
        const rows = await this.conn.query<AccountRowDb>(
            `SELECT ${ACCOUNT_COLUMNS} FROM billing_accounts WHERE id = ? AND tenant_id = ? LIMIT 1`,
            [accountId, tenantId],
        );
        const row = rows[0];
        return row ? mapAccount(row) : null;
    }

    private async getJournalOn(tenantId: string, journalId: string): Promise<JournalRecord | null> {
        const rows = await this.conn.query<JournalRowDb>(
            `SELECT ${JOURNAL_COLUMNS}, k.idempotency_key, k.payload_hash
               FROM billing_journals j
               LEFT JOIN billing_idempotency_keys k
                 ON k.journal_id = j.id AND k.tenant_id = j.tenant_id AND k.scope = 'journal'
              WHERE j.id = ? AND j.tenant_id = ?
              LIMIT 1`,
            [journalId, tenantId],
        );
        const row = rows[0];
        if (!row) return null;
        if (row.tenant_id !== tenantId) {
            throw new BillingLedgerSqlError('invalid_row', 'journal belongs to another tenant');
        }
        return this.assembleJournal(row);
    }

    private async assembleJournal(row: JournalRowDb): Promise<JournalRecord> {
        if (row.journal_type !== 'standard' && row.journal_type !== 'reversal') {
            throw new BillingLedgerSqlError('invalid_row', 'journal has an unknown type');
        }
        const lines = await this.conn.query<LineRowDb>(
            `SELECT line_no, account_id, account_kind, direction, amount_minor
               FROM billing_journal_lines
              WHERE journal_id = ? AND tenant_id = ?
              ORDER BY line_no ASC`,
            [row.id, row.tenant_id],
        );
        return {
            id: row.id,
            tenantId: row.tenant_id,
            currency: row.currency,
            journalType: row.journal_type,
            reversalOfJournalId: row.reversal_of_journal_id,
            reference: row.reference,
            description: row.description,
            idempotencyKey: row.idempotency_key ?? '',
            payloadHash: row.payload_hash ?? '',
            createdAt: toIso(row.created_at),
            lines: lines.map((line) => ({
                lineNo: normalizeSqlVersion(line.line_no, 'billing_journal_lines.line_no'),
                accountId: line.account_id,
                accountKind: asAccountKind(line.account_kind),
                direction: asDirection(line.direction),
                amountMinor: normalizeSqlBigInt(line.amount_minor, 'billing_journal_lines.amount_minor', {
                    max: MAX_AMOUNT_MINOR,
                }),
            })),
        };
    }

    async getJournal(tenantId: string, journalId: string): Promise<JournalRecord | null> {
        return this.getJournalOn(tenantId, journalId);
    }

    async findReversalOf(tenantId: string, journalId: string): Promise<JournalRecord | null> {
        const rows = await this.conn.query<JournalRowDb>(
            `SELECT ${JOURNAL_COLUMNS}, k.idempotency_key, k.payload_hash
               FROM billing_journals j
               LEFT JOIN billing_idempotency_keys k
                 ON k.journal_id = j.id AND k.tenant_id = j.tenant_id AND k.scope = 'journal'
              WHERE j.tenant_id = ? AND j.reversal_of_journal_id = ?
              LIMIT 1`,
            [tenantId, journalId],
        );
        const row = rows[0];
        return row ? this.assembleJournal(row) : null;
    }

    async findJournalByIdempotencyKey(tenantId: string, idempotencyKey: string): Promise<JournalRecord | null> {
        // HK1: the registry row is the authority for tenant, scope and hash.
        const rows = await this.conn.query<JournalRowDb>(
            `SELECT ${JOURNAL_COLUMNS}, k.idempotency_key, k.payload_hash, k.tenant_id AS key_tenant_id, k.scope
               FROM billing_idempotency_keys k
               INNER JOIN billing_journals j
                 ON j.id = k.journal_id AND j.tenant_id = k.tenant_id
              WHERE k.tenant_id = ? AND k.scope = 'journal' AND k.idempotency_key = ?
              LIMIT 1`,
            [tenantId, idempotencyKey],
        );
        const row = rows[0] as (JournalRowDb & { key_tenant_id?: string; scope?: string }) | undefined;
        if (!row) return null;
        if (row.key_tenant_id !== tenantId || row.scope !== 'journal') {
            throw new BillingLedgerSqlError('invalid_row', 'idempotency registry row is outside the requested tenant/scope');
        }
        return this.assembleJournal(row);
    }

    private async getReservationOn(tenantId: string, reservationId: string): Promise<ReservationRecord | null> {
        const rows = await this.conn.query<ReservationRowDb>(
            `SELECT ${RESERVATION_COLUMNS},
                    k.idempotency_key AS reservation_key, k.payload_hash AS key_payload_hash
               FROM billing_reservations r
               LEFT JOIN billing_idempotency_keys k
                 ON k.reservation_id = r.id AND k.tenant_id = r.tenant_id AND k.scope = 'reservation'
              WHERE r.id = ? AND r.tenant_id = ?
              LIMIT 1`,
            [reservationId, tenantId],
        );
        const row = rows[0];
        return row ? mapReservation(row) : null;
    }

    async getReservation(tenantId: string, reservationId: string): Promise<ReservationRecord | null> {
        return this.getReservationOn(tenantId, reservationId);
    }

    async findReservationByKey(tenantId: string, reservationKey: string): Promise<ReservationRecord | null> {
        // HK1: resolution goes through the idempotency registry, not a duplicated
        // reservation-row key.
        const rows = await this.conn.query<ReservationRowDb>(
            `SELECT ${RESERVATION_COLUMNS},
                    k.idempotency_key AS reservation_key, k.payload_hash AS key_payload_hash,
                    k.tenant_id AS key_tenant_id, k.scope
               FROM billing_idempotency_keys k
               INNER JOIN billing_reservations r
                 ON r.id = k.reservation_id AND r.tenant_id = k.tenant_id
              WHERE k.tenant_id = ? AND k.scope = 'reservation' AND k.idempotency_key = ?
              LIMIT 1`,
            [tenantId, reservationKey],
        );
        const row = rows[0] as (ReservationRowDb & { key_tenant_id?: string; scope?: string }) | undefined;
        if (!row) return null;
        if (row.key_tenant_id !== tenantId || row.scope !== 'reservation') {
            throw new BillingLedgerSqlError('invalid_row', 'idempotency registry row is outside the requested tenant/scope');
        }
        return mapReservation(row);
    }

    async insertJournal(input: InsertJournalInput): Promise<InsertJournalResult> {
        if (!Array.isArray(input.lines) || input.lines.length < 2) {
            throw new LedgerError('invalid_lines', 'a journal needs at least two lines');
        }
        let debits = 0n;
        let credits = 0n;
        for (const line of input.lines) {
            if (line.amountMinor <= 0n || line.amountMinor > MAX_AMOUNT_MINOR) {
                throw new LedgerError('amount_out_of_range', 'a journal line amount is outside the exact bound');
            }
            if (line.direction === 'debit') debits += line.amountMinor;
            else if (line.direction === 'credit') credits += line.amountMinor;
            else throw new LedgerError('invalid_direction', 'a journal line direction is invalid');
        }
        if (debits !== credits) {
            throw new LedgerError('unbalanced_journal', 'journal debits and credits are not equal');
        }
        if (!Array.isArray(input.balanceChanges) || input.balanceChanges.length === 0) {
            throw new LedgerError('invalid_lines', 'a journal must change at least one account');
        }

        const accountIds = Array.from(new Set(input.balanceChanges.map((change) => change.accountId))).sort();
        const placeholders = accountIds.map(() => '?').join(', ');
        // Stable ascending lock order, one tenant predicate, FOR UPDATE.
        const lockedRows = await this.conn.query<AccountRowDb>(
            `SELECT ${ACCOUNT_COLUMNS}
               FROM billing_accounts
              WHERE tenant_id = ? AND id IN (${placeholders})
              ORDER BY id ASC
              FOR UPDATE`,
            [input.journal.tenantId, ...accountIds],
        );
        const locked = new Map<string, LedgerAccount>();
        for (const row of lockedRows) {
            const account = mapAccount(row);
            if (account.tenantId !== input.journal.tenantId) {
                throw new BillingLedgerSqlError('invalid_row', 'a locked account belongs to another tenant');
            }
            locked.set(account.id, account);
        }
        for (const accountId of accountIds) {
            if (!locked.has(accountId)) throw new LedgerError('account_not_found', `account ${accountId} was not found`);
        }

        const changes: AccountBalanceChange[] = [];
        for (const change of input.balanceChanges) {
            const account = locked.get(change.accountId);
            if (!account) throw new LedgerError('account_not_found', `account ${change.accountId} was not found`);
            const expectedVersion = normalizeSqlVersion(change.expectedVersion, 'account expectedVersion');
            if (account.version !== expectedVersion) {
                return { ok: false, reason: 'account_version_conflict', accountId: change.accountId };
            }
            const newBalance = normalizeSqlBigInt(change.newBalanceMinor, 'account newBalanceMinor', {
                max: MAX_ACCOUNT_BALANCE_MINOR,
            });
            const newVersion = normalizeSqlVersion(change.newVersion, 'account newVersion');
            if (newVersion !== expectedVersion + 1) {
                throw new BillingLedgerSqlError('invalid_row', 'a balance change version is not expectedVersion + 1');
            }
            changes.push({ ...change, expectedVersion, newBalanceMinor: newBalance, newVersion });
        }

        await this.conn.execute(`SAVEPOINT ${SAVEPOINT}`);
        try {
            await this.conn.execute(
                `INSERT INTO billing_journals
                    (id, tenant_id, currency, journal_type, reversal_of_journal_id, reference, description, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    input.journal.id,
                    input.journal.tenantId,
                    input.journal.currency,
                    input.journal.journalType,
                    input.journal.reversalOfJournalId,
                    input.journal.reference,
                    input.journal.description,
                    input.journal.createdAt,
                ],
            );
            await this.conn.execute(
                `INSERT INTO billing_idempotency_keys
                    (tenant_id, scope, idempotency_key, payload_hash, journal_id, reservation_id)
                 VALUES (?, 'journal', ?, ?, ?, NULL)`,
                [input.journal.tenantId, input.idempotencyKey, input.payloadHash, input.journal.id],
            );
            for (const line of input.lines) {
                await this.conn.execute(
                    `INSERT INTO billing_journal_lines
                        (journal_id, line_no, tenant_id, account_id, account_kind, direction, amount_minor)
                     VALUES (?, ?, ?, ?, ?, ?, ?)`,
                    [
                        input.journal.id,
                        line.lineNo,
                        input.journal.tenantId,
                        line.accountId,
                        line.accountKind,
                        line.direction,
                        line.amountMinor.toString(),
                    ],
                );
            }
            for (const change of changes) {
                const updated = await this.conn.execute(
                    `UPDATE billing_accounts
                        SET balance_minor = ?, version = version + 1
                      WHERE id = ? AND tenant_id = ? AND version = ?`,
                    [
                        change.newBalanceMinor.toString(),
                        change.accountId,
                        input.journal.tenantId,
                        change.expectedVersion,
                    ],
                );
                if (affectedRowsOf(updated) !== 1) throw new AccountCasConflict(change.accountId);
            }
            await this.conn.execute(`RELEASE SAVEPOINT ${SAVEPOINT}`);
        } catch (error) {
            await this.rollbackToSavepoint();
            if (error instanceof AccountCasConflict) {
                return { ok: false, reason: 'account_version_conflict', accountId: error.accountId };
            }
            if (isDuplicateError(error)) return this.resolveJournalDuplicate(input);
            if (isForeignKeyError(error)) {
                throw new BillingLedgerSqlError(
                    'foreign_key_violation',
                    'journal insert referenced a missing/foreign account, tenant or reversal journal',
                );
            }
            throw error;
        }

        return {
            ok: true,
            journal: {
                id: input.journal.id,
                tenantId: input.journal.tenantId,
                currency: input.journal.currency,
                journalType: input.journal.journalType,
                reversalOfJournalId: input.journal.reversalOfJournalId,
                reference: input.journal.reference,
                description: input.journal.description,
                idempotencyKey: input.idempotencyKey,
                payloadHash: input.payloadHash,
                createdAt: input.journal.createdAt,
                lines: input.lines,
            },
        };
    }

    private async rollbackToSavepoint(): Promise<void> {
        await this.conn.execute(`ROLLBACK TO SAVEPOINT ${SAVEPOINT}`);
        await this.conn.execute(`RELEASE SAVEPOINT ${SAVEPOINT}`);
    }

    private async resolveJournalDuplicate(input: InsertJournalInput): Promise<InsertJournalResult> {
        const rows = await this.conn.query<IdempotencyRowDb>(
            `SELECT tenant_id, scope, idempotency_key, payload_hash, journal_id, reservation_id
               FROM billing_idempotency_keys
              WHERE tenant_id = ? AND scope = 'journal' AND idempotency_key = ?
              LIMIT 1`,
            [input.journal.tenantId, input.idempotencyKey],
        );
        const registry = rows[0];
        if (!registry) {
            throw new BillingLedgerSqlError('duplicate_key', 'journal insert violated a unique key outside the idempotency registry');
        }
        if (registry.tenant_id !== input.journal.tenantId || registry.scope !== 'journal') {
            return { ok: false, reason: 'idempotency_conflict' };
        }
        if (registry.payload_hash !== input.payloadHash) {
            return { ok: false, reason: 'idempotency_conflict' };
        }
        if (registry.journal_id === null) {
            throw new BillingLedgerSqlError('invalid_row', 'journal idempotency registry row has no journal target');
        }
        const journal = await this.getJournalOn(input.journal.tenantId, registry.journal_id);
        if (!journal) {
            throw new BillingLedgerSqlError('invalid_row', 'journal idempotency target does not exist');
        }
        return { ok: false, reason: 'idempotent_replay', journal };
    }

    async insertReservation(reservation: ReservationRecord): Promise<InsertReservationResult> {
        const amount = normalizeSqlBigInt(reservation.amountMinor, 'reservation amount', { max: MAX_AMOUNT_MINOR });
        const version = normalizeSqlVersion(reservation.version, 'reservation version');
        await this.conn.execute(`SAVEPOINT ${SAVEPOINT}`);
        try {
            await this.conn.execute(
                `INSERT INTO billing_reservations
                    (id, tenant_id, currency, amount_minor, available_account_id, reserved_account_id,
                     status, version, reserve_journal_id, release_journal_id, consume_journal_id,
                     consume_counter_account_id, reference, description, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    reservation.id,
                    reservation.tenantId,
                    reservation.currency,
                    amount.toString(),
                    reservation.availableAccountId,
                    reservation.reservedAccountId,
                    reservation.status,
                    version,
                    reservation.reserveJournalId,
                    reservation.releaseJournalId,
                    reservation.consumeJournalId,
                    reservation.consumeCounterAccountId,
                    reservation.reference,
                    reservation.description,
                    reservation.createdAt,
                    reservation.updatedAt,
                ],
            );
            await this.conn.execute(
                `INSERT INTO billing_idempotency_keys
                    (tenant_id, scope, idempotency_key, payload_hash, journal_id, reservation_id)
                 VALUES (?, 'reservation', ?, ?, NULL, ?)`,
                [reservation.tenantId, reservation.reservationKey, reservation.payloadHash, reservation.id],
            );
            await this.conn.execute(`RELEASE SAVEPOINT ${SAVEPOINT}`);
            return { ok: true, reservation };
        } catch (error) {
            await this.rollbackToSavepoint();
            if (isDuplicateError(error)) return { ok: false, reason: 'duplicate_key' };
            if (isForeignKeyError(error)) {
                throw new BillingLedgerSqlError(
                    'foreign_key_violation',
                    'reservation referenced a missing/foreign account, tenant or journal',
                );
            }
            throw error;
        }
    }

    async updateReservation(input: UpdateReservationInput): Promise<UpdateReservationResult> {
        const expectedVersion = normalizeSqlVersion(input.expectedVersion, 'reservation expectedVersion');
        const updated = await this.conn.execute(
            `UPDATE billing_reservations
                SET status = ?, version = version + 1, release_journal_id = ?,
                    consume_journal_id = ?, consume_counter_account_id = ?, updated_at = ?
              WHERE id = ? AND tenant_id = ? AND version = ? AND status = 'reserved'`,
            [
                input.status,
                input.releaseJournalId,
                input.consumeJournalId,
                input.consumeCounterAccountId,
                input.updatedAt,
                input.reservationId,
                input.tenantId,
                expectedVersion,
            ],
        );
        if (affectedRowsOf(updated) === 1) {
            const reservation = await this.getReservationOn(input.tenantId, input.reservationId);
            if (!reservation) {
                throw new BillingLedgerSqlError('invalid_row', 'updated reservation disappeared');
            }
            return { ok: true, reservation };
        }
        const current = await this.getReservationOn(input.tenantId, input.reservationId);
        if (!current) return { ok: false, reason: 'not_found' };
        if (current.status !== 'reserved') return { ok: false, reason: 'invalid_status' };
        return { ok: false, reason: 'version_conflict' };
    }

    async insertReservationEvent(event: ReservationEventInput): Promise<void> {
        try {
            await this.conn.execute(
                `INSERT INTO billing_reservation_events
                    (id, tenant_id, reservation_id, event_type, amount_minor, journal_id,
                     version_after, idempotency_key, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    event.id,
                    event.tenantId,
                    event.reservationId,
                    event.eventType,
                    normalizeSqlBigInt(event.amountMinor, 'reservation event amount', { max: MAX_AMOUNT_MINOR }).toString(),
                    event.journalId,
                    normalizeSqlVersion(event.versionAfter, 'reservation event versionAfter'),
                    event.idempotencyKey,
                    event.createdAt,
                ],
            );
        } catch (error) {
            if (isDuplicateError(error)) {
                throw new BillingLedgerSqlError('duplicate_key', 'reservation event already exists');
            }
            if (isForeignKeyError(error)) {
                throw new BillingLedgerSqlError(
                    'foreign_key_violation',
                    'reservation event referenced a missing/foreign reservation or journal',
                );
            }
            throw error;
        }
    }
}

export interface BillingLedgerSqlStore extends ReservationStore {
    inTransaction(conn: BillingSqlConnection): ReservationTransaction;
}

class BillingLedgerSqlStoreImpl implements BillingLedgerSqlStore {
    constructor(private readonly deps: BillingLedgerSqlDeps) {
        if (!deps || typeof deps.transaction !== 'function') {
            throw new BillingLedgerSqlError(
                'invalid_runner',
                'BillingLedgerSqlStore requires a connection-bound transaction runner',
            );
        }
    }

    inTransaction(conn: BillingSqlConnection): ReservationTransaction {
        return new BillingLedgerSqlTransaction(conn);
    }

    runAtomic<T>(callback: (tx: ReservationTransaction) => Promise<T>): Promise<T> {
        return this.deps.transaction((conn) => callback(this.inTransaction(conn)));
    }
}

/**
 * Build the ledger/reservation SQL store. Throws before any statement when the
 * transaction runner is missing; the adapter never owns a pool.
 */
export const createBillingLedgerSqlStore = (deps: BillingLedgerSqlDeps): BillingLedgerSqlStore =>
    new BillingLedgerSqlStoreImpl(deps);

export const createBoundBillingLedgerSqlTransaction = (
    conn: BillingSqlConnection,
    deps: BillingLedgerSqlDeps,
): ReservationTransaction => new BillingLedgerSqlStoreImpl(deps).inTransaction(conn);

/** Convenience alias kept explicit so callers can type a plain ledger store. */
export type BillingLedgerOnlySqlStore = LedgerStore<LedgerTransaction>;
