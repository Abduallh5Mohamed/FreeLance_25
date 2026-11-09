"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.createBoundBillingLedgerSqlTransaction = exports.createBillingLedgerSqlStore = exports.BillingLedgerSqlError = void 0;
exports.normalizeSqlBigInt = normalizeSqlBigInt;
exports.normalizeSqlVersion = normalizeSqlVersion;
const node_crypto_1 = require("node:crypto");
const billing_ledger_1 = require("./billing-ledger");
class BillingLedgerSqlError extends Error {
    constructor(code, message) {
        super(message);
        this.code = code;
        this.name = 'BillingLedgerSqlError';
    }
}
exports.BillingLedgerSqlError = BillingLedgerSqlError;
const INTEGER_TEXT = /^-?\d+$/;
/**
 * HK2: the single BIGINT normalizer. Accepts a bigint, a decimal string, or a
 * number only while it is exactly representable as a safe integer. Money is
 * never coerced through `Number()`.
 */
function normalizeSqlBigInt(value, field, options = {}) {
    let parsed;
    if (typeof value === 'bigint') {
        parsed = value;
    }
    else if (typeof value === 'string') {
        const text = value.trim();
        if (!INTEGER_TEXT.test(text)) {
            throw new BillingLedgerSqlError('unsafe_integer', `${field} is not an exact integer string`);
        }
        parsed = BigInt(text);
    }
    else if (typeof value === 'number') {
        if (!Number.isSafeInteger(value)) {
            throw new BillingLedgerSqlError('unsafe_integer', `${field} is a number outside the safe integer range`);
        }
        parsed = BigInt(value);
    }
    else {
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
function normalizeSqlVersion(value, field) {
    let parsed;
    if (typeof value === 'number') {
        parsed = value;
    }
    else if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
        parsed = Number(value.trim());
    }
    else if (typeof value === 'bigint') {
        if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
            throw new BillingLedgerSqlError('version_out_of_range', `${field} is outside the safe integer range`);
        }
        parsed = Number(value);
    }
    else {
        throw new BillingLedgerSqlError('version_out_of_range', `${field} is not a safe integer version`);
    }
    if (!Number.isSafeInteger(parsed) || parsed < 0) {
        throw new BillingLedgerSqlError('version_out_of_range', `${field} is outside the safe integer range`);
    }
    return parsed;
}
const affectedRowsOf = (result) => {
    const raw = result.affectedRows;
    const value = typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : raw;
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
        throw new BillingLedgerSqlError('invalid_row', 'affectedRows is unreadable; a write result cannot be classified');
    }
    return value;
};
const isDuplicateError = (error) => typeof error === 'object' && error !== null && error.code === 'ER_DUP_ENTRY';
const isForeignKeyError = (error) => {
    if (typeof error !== 'object' || error === null)
        return false;
    const code = error.code;
    return code === 'ER_NO_REFERENCED_ROW_2' || code === 'ER_ROW_IS_REFERENCED_2';
};
const isDeadlockError = (error) => {
    if (typeof error !== 'object' || error === null)
        return false;
    const code = error.code;
    return code === 'ER_LOCK_DEADLOCK';
};
const isLockWaitTimeoutError = (error) => {
    if (typeof error !== 'object' || error === null)
        return false;
    const code = error.code;
    return code === 'ER_LOCK_WAIT_TIMEOUT';
};
const errorMessageOf = (error) => {
    if (error instanceof Error)
        return error.message;
    if (typeof error === 'object' && error !== null) {
        const candidate = error.message ?? error.sqlMessage;
        if (typeof candidate === 'string')
            return candidate;
    }
    return '';
};
/** mysql2 reports the violated key inside the error message; match REAL names. */
const duplicateKeyNameOf = (error) => {
    if (!isDuplicateError(error))
        return null;
    const match = /for key '?([A-Za-z0-9_.$]+)'?/.exec(errorMessageOf(error));
    if (match === null)
        return null;
    const value = match[1];
    const lastDot = value.lastIndexOf('.');
    return lastDot < 0 ? value : value.slice(lastDot + 1);
};
const toIso = (value) => {
    const date = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(date.getTime())) {
        throw new BillingLedgerSqlError('invalid_row', 'a ledger timestamp is not parseable');
    }
    return date.toISOString();
};
const asAccountKind = (value) => {
    if (!billing_ledger_1.ACCOUNT_KINDS.includes(value)) {
        throw new BillingLedgerSqlError('invalid_row', 'a ledger account has an unknown kind');
    }
    return value;
};
const asDirection = (value) => {
    if (value !== 'debit' && value !== 'credit') {
        throw new BillingLedgerSqlError('invalid_row', 'a ledger line has an unknown direction');
    }
    return value;
};
const asReservationStatus = (value) => {
    if (value !== 'reserved' && value !== 'released' && value !== 'consumed') {
        throw new BillingLedgerSqlError('invalid_row', 'a reservation has an unknown status');
    }
    return value;
};
const asReservationJournalRole = (value) => {
    if (value !== 'reserve' && value !== 'release' && value !== 'consume' && value !== 'reversal') {
        throw new BillingLedgerSqlError('invalid_row', 'a reservation journal link has an unknown role');
    }
    return value;
};
const ACCOUNT_COLUMNS = 'id, tenant_id, kind, normal_side, currency, balance_minor, version';
const JOURNAL_COLUMNS = `j.id, j.tenant_id, j.currency, j.journal_type,
    j.reversal_of_journal_id, j.reference, j.description, j.created_at`;
const RESERVATION_COLUMNS = `r.id, r.tenant_id, r.currency, r.amount_minor,
    r.available_account_id, r.reserved_account_id, r.status, r.version,
    r.reserve_journal_id, r.release_journal_id, r.consume_journal_id,
    r.consume_counter_account_id, r.reference, r.description, r.created_at, r.updated_at`;
const mapAccount = (row) => {
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
const mapReservation = (row) => ({
    id: row.id,
    tenantId: row.tenant_id,
    reservationKey: row.reservation_key ?? '',
    payloadHash: row.key_payload_hash ?? '',
    currency: row.currency,
    amountMinor: normalizeSqlBigInt(row.amount_minor, 'billing_reservations.amount_minor', {
        max: billing_ledger_1.MAX_AMOUNT_MINOR,
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
    constructor(accountId) {
        super('billing account version changed');
        this.accountId = accountId;
        this.name = 'AccountCasConflict';
    }
}
const SAVEPOINT = 'billing_insert_journal';
class BillingLedgerSqlTransaction {
    constructor(conn) {
        this.conn = conn;
    }
    async getAccount(tenantId, accountId) {
        const rows = await this.conn.query(`SELECT ${ACCOUNT_COLUMNS} FROM billing_accounts WHERE id = ? AND tenant_id = ? LIMIT 1`, [accountId, tenantId]);
        const row = rows[0];
        return row ? mapAccount(row) : null;
    }
    async provisionAccountIdempotent(tenantId, kind, currency) {
        if (typeof tenantId !== 'string' || tenantId.length === 0 || tenantId.length > billing_ledger_1.MAX_TENANT_ID_LENGTH) {
            throw new billing_ledger_1.LedgerError('invalid_tenant', 'tenantId is outside the CHAR(36) contract bound');
        }
        if (!billing_ledger_1.ACCOUNT_KINDS.includes(kind)) {
            throw new billing_ledger_1.LedgerError('account_kind_mismatch', 'account kind is unknown');
        }
        if (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)) {
            throw new billing_ledger_1.LedgerError('invalid_currency', 'currency must be a three-letter uppercase ISO-4217 code');
        }
        const normalSide = billing_ledger_1.ACCOUNT_NORMAL_SIDE[kind];
        // Locking read first to avoid holding shared locks that can deadlock with
        // concurrent insert attempts (error 1213). Only INSERT when no row exists.
        const existingRows = await this.conn.query(`SELECT ${ACCOUNT_COLUMNS}
               FROM billing_accounts
              WHERE tenant_id = ? AND kind = ? AND currency = ?
              LIMIT 1
              FOR UPDATE`, [tenantId, kind, currency]);
        const existing = existingRows[0];
        if (existing !== undefined) {
            const account = mapAccount(existing);
            if (account.tenantId !== tenantId || account.kind !== kind || account.currency !== currency) {
                throw new BillingLedgerSqlError('invalid_row', 'provisioned account read back with a different identity');
            }
            return account;
        }
        const id = (0, node_crypto_1.randomUUID)();
        await this.conn.execute(`SAVEPOINT ${SAVEPOINT}`);
        try {
            await this.conn.execute(`INSERT INTO billing_accounts
                    (id, tenant_id, kind, normal_side, currency, balance_minor, version)
                 VALUES (?, ?, ?, ?, ?, 0, 1)`, [id, tenantId, kind, normalSide, currency]);
            await this.conn.execute(`RELEASE SAVEPOINT ${SAVEPOINT}`);
        }
        catch (error) {
            await this.rollbackToSavepoint();
            if (isDeadlockError(error)) {
                throw new BillingLedgerSqlError('lock_deadlock', 'account provisioning hit a deadlock');
            }
            if (isLockWaitTimeoutError(error)) {
                throw new BillingLedgerSqlError('lock_wait_timeout', 'account provisioning hit a lock wait timeout');
            }
            if (!isDuplicateError(error)) {
                if (isForeignKeyError(error)) {
                    throw new BillingLedgerSqlError('foreign_key_violation', 'provisioned account referenced a missing tenant');
                }
                throw error;
            }
            const keyName = duplicateKeyNameOf(error);
            if (keyName !== null && keyName !== 'uq_billing_account_tenant_kind_currency') {
                throw new BillingLedgerSqlError('duplicate_key', 'account provisioning violated a unique key outside tenant/kind/currency');
            }
            // Fallback: re-read with a locking read after a duplicate (race between select and insert).
            // Never alter its balance or version.
            const rows = await this.conn.query(`SELECT ${ACCOUNT_COLUMNS}
                   FROM billing_accounts
                  WHERE tenant_id = ? AND kind = ? AND currency = ?
                  LIMIT 1
                  FOR UPDATE`, [tenantId, kind, currency]);
            const row = rows[0];
            if (row === undefined) {
                throw new BillingLedgerSqlError('invalid_row', 'provisioned account duplicate could not be read back');
            }
            const account = mapAccount(row);
            if (account.tenantId !== tenantId || account.kind !== kind || account.currency !== currency) {
                throw new BillingLedgerSqlError('invalid_row', 'provisioned account read back with a different identity');
            }
            return account;
        }
        return { id, tenantId, kind, normalSide, currency, balanceMinor: 0n, version: 1 };
    }
    async getJournalOn(tenantId, journalId) {
        const rows = await this.conn.query(`SELECT ${JOURNAL_COLUMNS}, k.idempotency_key, k.payload_hash
               FROM billing_journals j
               LEFT JOIN billing_idempotency_keys k
                 ON k.journal_id = j.id AND k.tenant_id = j.tenant_id AND k.scope = 'journal'
              WHERE j.id = ? AND j.tenant_id = ?
              LIMIT 1`, [journalId, tenantId]);
        const row = rows[0];
        if (!row)
            return null;
        if (row.tenant_id !== tenantId) {
            throw new BillingLedgerSqlError('invalid_row', 'journal belongs to another tenant');
        }
        return this.assembleJournal(row);
    }
    async assembleJournal(row) {
        if (row.journal_type !== 'standard' && row.journal_type !== 'reversal') {
            throw new BillingLedgerSqlError('invalid_row', 'journal has an unknown type');
        }
        const lines = await this.conn.query(`SELECT line_no, account_id, account_kind, direction, amount_minor
               FROM billing_journal_lines
              WHERE journal_id = ? AND tenant_id = ?
              ORDER BY line_no ASC`, [row.id, row.tenant_id]);
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
                    max: billing_ledger_1.MAX_AMOUNT_MINOR,
                }),
            })),
        };
    }
    async getJournal(tenantId, journalId) {
        return this.getJournalOn(tenantId, journalId);
    }
    async findReversalOf(tenantId, journalId) {
        const rows = await this.conn.query(`SELECT ${JOURNAL_COLUMNS}, k.idempotency_key, k.payload_hash
               FROM billing_journals j
               LEFT JOIN billing_idempotency_keys k
                 ON k.journal_id = j.id AND k.tenant_id = j.tenant_id AND k.scope = 'journal'
              WHERE j.tenant_id = ? AND j.reversal_of_journal_id = ?
              LIMIT 1`, [tenantId, journalId]);
        const row = rows[0];
        return row ? this.assembleJournal(row) : null;
    }
    async findJournalByIdempotencyKey(tenantId, idempotencyKey) {
        // HK1: the registry row is the authority for tenant, scope and hash.
        const rows = await this.conn.query(`SELECT ${JOURNAL_COLUMNS}, k.idempotency_key, k.payload_hash, k.tenant_id AS key_tenant_id, k.scope
               FROM billing_idempotency_keys k
               INNER JOIN billing_journals j
                 ON j.id = k.journal_id AND j.tenant_id = k.tenant_id
              WHERE k.tenant_id = ? AND k.scope = 'journal' AND k.idempotency_key = ?
              LIMIT 1`, [tenantId, idempotencyKey]);
        const row = rows[0];
        if (!row)
            return null;
        if (row.key_tenant_id !== tenantId || row.scope !== 'journal') {
            throw new BillingLedgerSqlError('invalid_row', 'idempotency registry row is outside the requested tenant/scope');
        }
        return this.assembleJournal(row);
    }
    async findReservationJournalLink(tenantId, journalId) {
        // Persisted link, tenant-scoped, plain consistent read inside the unit.
        const reservationRows = await this.conn.query(`SELECT r.id AS reservation_id,
                    CASE
                        WHEN r.reserve_journal_id = ? THEN 'reserve'
                        WHEN r.release_journal_id = ? THEN 'release'
                        WHEN r.consume_journal_id = ? THEN 'consume'
                        ELSE 'reserve'
                    END AS journal_role
               FROM billing_reservations r
              WHERE r.tenant_id = ?
                AND (r.reserve_journal_id = ? OR r.release_journal_id = ? OR r.consume_journal_id = ?)
              LIMIT 1`, [journalId, journalId, journalId, tenantId, journalId, journalId, journalId]);
        const reservation = reservationRows[0];
        if (reservation !== undefined) {
            return {
                tenantId,
                reservationId: reservation.reservation_id,
                journalRole: asReservationJournalRole(reservation.journal_role),
            };
        }
        const eventRows = await this.conn.query(`SELECT e.reservation_id AS reservation_id, e.event_type AS journal_role
               FROM billing_reservation_events e
              WHERE e.tenant_id = ? AND e.journal_id = ?
              LIMIT 1`, [tenantId, journalId]);
        const event = eventRows[0];
        if (event === undefined)
            return null;
        return {
            tenantId,
            reservationId: event.reservation_id,
            journalRole: asReservationJournalRole(event.journal_role),
        };
    }
    async getReservationOn(tenantId, reservationId) {
        const rows = await this.conn.query(`SELECT ${RESERVATION_COLUMNS},
                    k.idempotency_key AS reservation_key, k.payload_hash AS key_payload_hash
               FROM billing_reservations r
               LEFT JOIN billing_idempotency_keys k
                 ON k.reservation_id = r.id AND k.tenant_id = r.tenant_id AND k.scope = 'reservation'
              WHERE r.id = ? AND r.tenant_id = ?
              LIMIT 1`, [reservationId, tenantId]);
        const row = rows[0];
        return row ? mapReservation(row) : null;
    }
    async getReservation(tenantId, reservationId) {
        return this.getReservationOn(tenantId, reservationId);
    }
    async findReservationByKey(tenantId, reservationKey) {
        // HK1: resolution goes through the idempotency registry, not a duplicated
        // reservation-row key.
        const rows = await this.conn.query(`SELECT ${RESERVATION_COLUMNS},
                    k.idempotency_key AS reservation_key, k.payload_hash AS key_payload_hash,
                    k.tenant_id AS key_tenant_id, k.scope
               FROM billing_idempotency_keys k
               INNER JOIN billing_reservations r
                 ON r.id = k.reservation_id AND r.tenant_id = k.tenant_id
              WHERE k.tenant_id = ? AND k.scope = 'reservation' AND k.idempotency_key = ?
              LIMIT 1`, [tenantId, reservationKey]);
        const row = rows[0];
        if (!row)
            return null;
        if (row.key_tenant_id !== tenantId || row.scope !== 'reservation') {
            throw new BillingLedgerSqlError('invalid_row', 'idempotency registry row is outside the requested tenant/scope');
        }
        return mapReservation(row);
    }
    async insertJournal(input) {
        if (!Array.isArray(input.lines) || input.lines.length < 2) {
            throw new billing_ledger_1.LedgerError('invalid_lines', 'a journal needs at least two lines');
        }
        let debits = 0n;
        let credits = 0n;
        for (const line of input.lines) {
            if (line.amountMinor <= 0n || line.amountMinor > billing_ledger_1.MAX_AMOUNT_MINOR) {
                throw new billing_ledger_1.LedgerError('amount_out_of_range', 'a journal line amount is outside the exact bound');
            }
            if (line.direction === 'debit')
                debits += line.amountMinor;
            else if (line.direction === 'credit')
                credits += line.amountMinor;
            else
                throw new billing_ledger_1.LedgerError('invalid_direction', 'a journal line direction is invalid');
        }
        if (debits !== credits) {
            throw new billing_ledger_1.LedgerError('unbalanced_journal', 'journal debits and credits are not equal');
        }
        if (!Array.isArray(input.balanceChanges) || input.balanceChanges.length === 0) {
            throw new billing_ledger_1.LedgerError('invalid_lines', 'a journal must change at least one account');
        }
        const accountIds = Array.from(new Set(input.balanceChanges.map((change) => change.accountId))).sort();
        const placeholders = accountIds.map(() => '?').join(', ');
        // Stable ascending lock order, one tenant predicate, FOR UPDATE.
        const lockedRows = await this.conn.query(`SELECT ${ACCOUNT_COLUMNS}
               FROM billing_accounts
              WHERE tenant_id = ? AND id IN (${placeholders})
              ORDER BY id ASC
              FOR UPDATE`, [input.journal.tenantId, ...accountIds]);
        const locked = new Map();
        for (const row of lockedRows) {
            const account = mapAccount(row);
            if (account.tenantId !== input.journal.tenantId) {
                throw new BillingLedgerSqlError('invalid_row', 'a locked account belongs to another tenant');
            }
            locked.set(account.id, account);
        }
        for (const accountId of accountIds) {
            if (!locked.has(accountId))
                throw new billing_ledger_1.LedgerError('account_not_found', `account ${accountId} was not found`);
        }
        const changes = [];
        for (const change of input.balanceChanges) {
            const account = locked.get(change.accountId);
            if (!account)
                throw new billing_ledger_1.LedgerError('account_not_found', `account ${change.accountId} was not found`);
            const expectedVersion = normalizeSqlVersion(change.expectedVersion, 'account expectedVersion');
            if (account.version !== expectedVersion) {
                return { ok: false, reason: 'account_version_conflict', accountId: change.accountId };
            }
            const newBalance = normalizeSqlBigInt(change.newBalanceMinor, 'account newBalanceMinor', {
                max: billing_ledger_1.MAX_ACCOUNT_BALANCE_MINOR,
            });
            const newVersion = normalizeSqlVersion(change.newVersion, 'account newVersion');
            if (newVersion !== expectedVersion + 1) {
                throw new BillingLedgerSqlError('invalid_row', 'a balance change version is not expectedVersion + 1');
            }
            changes.push({ ...change, expectedVersion, newBalanceMinor: newBalance, newVersion });
        }
        await this.conn.execute(`SAVEPOINT ${SAVEPOINT}`);
        try {
            await this.conn.execute(`INSERT INTO billing_journals
                    (id, tenant_id, currency, journal_type, reversal_of_journal_id, reference, description, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [
                input.journal.id,
                input.journal.tenantId,
                input.journal.currency,
                input.journal.journalType,
                input.journal.reversalOfJournalId,
                input.journal.reference,
                input.journal.description,
                input.journal.createdAt,
            ]);
            await this.conn.execute(`INSERT INTO billing_idempotency_keys
                    (tenant_id, scope, idempotency_key, payload_hash, journal_id, reservation_id)
                 VALUES (?, 'journal', ?, ?, ?, NULL)`, [input.journal.tenantId, input.idempotencyKey, input.payloadHash, input.journal.id]);
            for (const line of input.lines) {
                await this.conn.execute(`INSERT INTO billing_journal_lines
                        (journal_id, line_no, tenant_id, account_id, account_kind, direction, amount_minor)
                     VALUES (?, ?, ?, ?, ?, ?, ?)`, [
                    input.journal.id,
                    line.lineNo,
                    input.journal.tenantId,
                    line.accountId,
                    line.accountKind,
                    line.direction,
                    line.amountMinor.toString(),
                ]);
            }
            for (const change of changes) {
                const updated = await this.conn.execute(`UPDATE billing_accounts
                        SET balance_minor = ?, version = version + 1
                      WHERE id = ? AND tenant_id = ? AND version = ?`, [
                    change.newBalanceMinor.toString(),
                    change.accountId,
                    input.journal.tenantId,
                    change.expectedVersion,
                ]);
                if (affectedRowsOf(updated) !== 1)
                    throw new AccountCasConflict(change.accountId);
            }
            await this.conn.execute(`RELEASE SAVEPOINT ${SAVEPOINT}`);
        }
        catch (error) {
            await this.rollbackToSavepoint();
            if (error instanceof AccountCasConflict) {
                return { ok: false, reason: 'account_version_conflict', accountId: error.accountId };
            }
            if (isDuplicateError(error))
                return this.resolveJournalDuplicate(input, error);
            if (isForeignKeyError(error)) {
                throw new BillingLedgerSqlError('foreign_key_violation', 'journal insert referenced a missing/foreign account, tenant or reversal journal');
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
    async rollbackToSavepoint() {
        await this.conn.execute(`ROLLBACK TO SAVEPOINT ${SAVEPOINT}`);
        await this.conn.execute(`RELEASE SAVEPOINT ${SAVEPOINT}`);
    }
    async resolveJournalDuplicate(input, error) {
        const rows = await this.conn.query(`SELECT tenant_id, scope, idempotency_key, payload_hash, journal_id, reservation_id
               FROM billing_idempotency_keys
              WHERE tenant_id = ? AND scope = 'journal' AND idempotency_key = ?
              LIMIT 1`, [input.journal.tenantId, input.idempotencyKey]);
        const registry = rows[0];
        if (!registry) {
            // Two different keys racing to reverse the same journal collide on
            // (tenant, reversal_of_journal_id); surface the domain's own code.
            if (duplicateKeyNameOf(error) === 'uq_billing_journal_reversal') {
                return { ok: false, reason: 'already_reversed' };
            }
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
    async insertReservation(reservation) {
        const amount = normalizeSqlBigInt(reservation.amountMinor, 'reservation amount', { max: billing_ledger_1.MAX_AMOUNT_MINOR });
        const version = normalizeSqlVersion(reservation.version, 'reservation version');
        await this.conn.execute(`SAVEPOINT ${SAVEPOINT}`);
        try {
            await this.conn.execute(`INSERT INTO billing_reservations
                    (id, tenant_id, currency, amount_minor, available_account_id, reserved_account_id,
                     status, version, reserve_journal_id, release_journal_id, consume_journal_id,
                     consume_counter_account_id, reference, description, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
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
            ]);
            await this.conn.execute(`INSERT INTO billing_idempotency_keys
                    (tenant_id, scope, idempotency_key, payload_hash, journal_id, reservation_id)
                 VALUES (?, 'reservation', ?, ?, NULL, ?)`, [reservation.tenantId, reservation.reservationKey, reservation.payloadHash, reservation.id]);
            await this.conn.execute(`RELEASE SAVEPOINT ${SAVEPOINT}`);
            return { ok: true, reservation };
        }
        catch (error) {
            await this.rollbackToSavepoint();
            if (isDuplicateError(error))
                return { ok: false, reason: 'duplicate_key' };
            if (isForeignKeyError(error)) {
                throw new BillingLedgerSqlError('foreign_key_violation', 'reservation referenced a missing/foreign account, tenant or journal');
            }
            throw error;
        }
    }
    async updateReservation(input) {
        const expectedVersion = normalizeSqlVersion(input.expectedVersion, 'reservation expectedVersion');
        const updated = await this.conn.execute(`UPDATE billing_reservations
                SET status = ?, version = version + 1, release_journal_id = ?,
                    consume_journal_id = ?, consume_counter_account_id = ?, updated_at = ?
              WHERE id = ? AND tenant_id = ? AND version = ? AND status = 'reserved'`, [
            input.status,
            input.releaseJournalId,
            input.consumeJournalId,
            input.consumeCounterAccountId,
            input.updatedAt,
            input.reservationId,
            input.tenantId,
            expectedVersion,
        ]);
        if (affectedRowsOf(updated) === 1) {
            const reservation = await this.getReservationOn(input.tenantId, input.reservationId);
            if (!reservation) {
                throw new BillingLedgerSqlError('invalid_row', 'updated reservation disappeared');
            }
            return { ok: true, reservation };
        }
        const current = await this.getReservationOn(input.tenantId, input.reservationId);
        if (!current)
            return { ok: false, reason: 'not_found' };
        if (current.status !== 'reserved')
            return { ok: false, reason: 'invalid_status' };
        return { ok: false, reason: 'version_conflict' };
    }
    async insertReservationEvent(event) {
        try {
            await this.conn.execute(`INSERT INTO billing_reservation_events
                    (id, tenant_id, reservation_id, event_type, amount_minor, journal_id,
                     version_after, idempotency_key, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
                event.id,
                event.tenantId,
                event.reservationId,
                event.eventType,
                normalizeSqlBigInt(event.amountMinor, 'reservation event amount', { max: billing_ledger_1.MAX_AMOUNT_MINOR }).toString(),
                event.journalId,
                normalizeSqlVersion(event.versionAfter, 'reservation event versionAfter'),
                event.idempotencyKey,
                event.createdAt,
            ]);
        }
        catch (error) {
            if (isDuplicateError(error)) {
                throw new BillingLedgerSqlError('duplicate_key', 'reservation event already exists');
            }
            if (isForeignKeyError(error)) {
                throw new BillingLedgerSqlError('foreign_key_violation', 'reservation event referenced a missing/foreign reservation or journal');
            }
            throw error;
        }
    }
}
class BillingLedgerSqlStoreImpl {
    constructor(deps) {
        this.deps = deps;
        if (!deps || typeof deps.transaction !== 'function') {
            throw new BillingLedgerSqlError('invalid_runner', 'BillingLedgerSqlStore requires a connection-bound transaction runner');
        }
    }
    inTransaction(conn) {
        return new BillingLedgerSqlTransaction(conn);
    }
    runAtomic(callback) {
        return this.deps.transaction((conn) => callback(this.inTransaction(conn)));
    }
}
/**
 * Build the ledger/reservation SQL store. Throws before any statement when the
 * transaction runner is missing; the adapter never owns a pool.
 */
const createBillingLedgerSqlStore = (deps) => new BillingLedgerSqlStoreImpl(deps);
exports.createBillingLedgerSqlStore = createBillingLedgerSqlStore;
const createBoundBillingLedgerSqlTransaction = (conn, deps) => new BillingLedgerSqlStoreImpl(deps).inTransaction(conn);
exports.createBoundBillingLedgerSqlTransaction = createBoundBillingLedgerSqlTransaction;
