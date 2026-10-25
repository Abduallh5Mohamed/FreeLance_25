/**
 * FIN9 / X7 — real SQL adapter for `PayoutStore` / `PayoutTransaction`.
 *
 * Implements `billing-payouts.ts` (PAYOUT_STORE_SQL_CONTRACT). The canonical
 * schema is `20261022_04_payouts_refunds_disputes.sql`; this adapter uses that
 * file's exact keys:
 *   payout_requests     PK (tenant_id, payout_id)
 *                       UNIQUE uq_payout_requests_idem (tenant_id, idempotency_key)
 *   payout_transitions  PK (id)
 *                       UNIQUE uq_payout_transitions_idem (tenant_id, idempotency_key)
 *
 * DUPLICATE-KEY MAPPING: an idempotency unique-key duplicate is the documented
 * replay signal (`duplicate_key`) and the domain re-reads the winning row; that
 * re-read is `FOR SHARE` (locking current read) after a duplicate so it cannot
 * miss a row committed beyond the REPEATABLE READ snapshot. The initial
 * lookup stays non-locking to avoid a pre-insert gap lock. A request PRIMARY
 * duplicate with a DIFFERENT idempotency key is the typed `resource_conflict`,
 * never `store_inconsistent`.
 *
 * DEBT POLICY (R3, fail closed): invoice debt comes ONLY from the shared
 * allocation source in `billing-settlement.ts` (`listInvoiceOutstanding`:
 * issued `total_minor` minus immutable `billing_payment_allocations`, read with
 * locking current reads through the settlement SQL reader). This adapter does
 * not duplicate that formula. Rules, in order:
 *   1. The settlement list is unavailable, truncated, or hits a missing
 *      table/column => `debt_source_unavailable` (no silent truncation).
 *   2. An invoice in the requested currency with outstanding > 0 is decided ONLY
 *      from the stored explicit due_at carried by the shared settlement entry
 *      (`dueStatus`, `dueAt`, `dueBasisRef`, `dueBasisVersion`, contract 14.5.4):
 *      unresolved (or malformed) due => `debt_source_unavailable`; resolved
 *      `dueAt > asOfSeconds` => not a debt now; resolved `dueAt <= asOfSeconds`
 *      => a `cycle_invoice` debt for the invoice outstanding. `asOfSeconds` is
 *      supplied by the payout domain server clock; absent/invalid => unavailable.
 *      A fully allocated invoice (outstanding 0) is not a debt. The 96h
 *      difference grace is never used as an invoice due date.
 *   3. A difference request is the payment request for an invoice's remaining
 *      balance, not an additional debt. When `invoice_ref_id` links it to an
 *      invoice it is skipped (the invoice side decides; rule 2 already refused
 *      if unpaid). An unlinked request (`invoice_ref_id` IS NULL, legacy opaque
 *      reference) keeps its own explicit `deadline_at` and is returned as debt.
 *      A linked request whose invoice is outside the allocation source is
 *      unavailable.
 *
 * GLOBAL LOCK ORDER (deadlock rule, shared with billing-collection-sql.ts):
 *   | step | resource                                   | mode                    |
 *   |  1   | billing_invoices (settlement list/lookup)  | FOR UPDATE              |
 *   |  2   | billing_payment_allocations (per invoice)  | FOR UPDATE (settlement) |
 *   |  3   | billing_difference_requests (debt scan)    | FOR SHARE               |
 * Difference-request issuance takes step 1 and only then inserts at step 3, so
 * both paths acquire invoices before difference requests. Never scan difference
 * requests before the invoice list in `listDueSubscriptionDebts`.
 *
 * SOURCE CODE ONLY. Nothing here executes SQL or opens a connection. Every
 * statement of a unit of work is issued on the caller-injected transaction
 * connection; there is no pooled query and no autocommit fallback. A missing
 * runner or audit sink throws at construction, before any statement.
 *
 * HK1: the accepted domain contract puts idempotency on the domain tables
 * itself (`idempotency_key` + `payload_hash`), exactly like the accepted
 * collection adapter. The adapter serves the by-key reads/writes honestly; the
 * replay-vs-conflict comparison is domain work in `billing-payouts.ts`.
 *
 * LEDGER: `PayoutTransaction extends ReservationTransaction`, so all
 * reservation/journal methods are delegated to the accepted ledger SQL adapter
 * on the SAME connection. No balance or journal arithmetic is reimplemented.
 *
 * MONEY (HK2): exact integer minor units; `normalizeSqlBigInt` /
 * `normalizeSqlVersion` are the single read normalizers. Required mysql2
 * options for the production binding: `supportBigNumbers: true`,
 * `bigNumberStrings: true`.
 *
 * TIMESTAMPS: ISO-8601 `...Z` strings are bound directly to `DATETIME(3)` as the
 * accepted reference adapters do (MySQL parses them in session time zone). This
 * matches the rest of the lane; verifying session TZ is an integration item.
 *
 * AUDIT: `writeAudit` is the ONLY path and routes to the REQUIRED
 * constructor-injected connection-bound sealed sink. An audit failure fails the
 * whole unit of work.
 */

import {
    DEBT_SCAN_LIMIT,
    DEFAULT_LIST_LIMIT,
    MAX_ACTOR_LENGTH,
    MAX_DESTINATION_LENGTH,
    MAX_IDEMPOTENCY_KEY_LENGTH,
    MAX_LIST_LIMIT,
    MAX_PAYOUT_AMOUNT_MINOR,
    MAX_PAYOUT_ID_LENGTH,
    MAX_REASON_LENGTH,
    MAX_TENANT_LENGTH,
    PAYOUT_ACTIONS,
    PAYOUT_STATUSES,
    RESERVATION_SCAN_LIMIT,
    type ActiveReservationPage,
    type InsertPayoutResult,
    type PayoutAction,
    type PayoutAuditRecord,
    type PayoutPage,
    type PayoutRequest,
    type PayoutStatus,
    type PayoutStore,
    type PayoutTransaction,
    type PayoutTransitionRecord,
    type SubscriptionDebtPage,
    type UpdatePayoutStatusCasInput,
    type UpdatePayoutStatusCasResult,
} from './billing-payouts';
import { MAX_AMOUNT_MINOR } from './billing-ledger';
import {
    createBoundBillingLedgerSqlTransaction,
    normalizeSqlBigInt,
    normalizeSqlVersion,
    type BillingSqlConnection,
    type BillingSqlTransactionRunner,
} from './billing-ledger-sql';
import type { SubscriptionDebt } from './billing-collection';
import { listInvoiceOutstanding } from './billing-settlement';
import { createBoundBillingSettlementSqlTransaction } from './billing-settlement-sql';
import type {
    ReservationRecord,
    ReservationStatus,
    ReservationTransaction,
} from './billing-reservations';

export const PAYOUT_SQL_ADAPTER_ID = 'billing-payouts-sql:20261022_04';

export const PAYOUT_INSERT_SAVEPOINT = 'payout_request_insert';
export const PAYOUT_TRANSITION_SAVEPOINT = 'payout_transition_insert';

export type PayoutSqlConnection = BillingSqlConnection;
export type PayoutSqlTransactionRunner = BillingSqlTransactionRunner;

export type PayoutSqlErrorCode =
    | 'invalid_runner'
    | 'invalid_audit'
    | 'invalid_row'
    | 'store_overrun'
    | 'duplicate_key'
    | 'store_inconsistent'
    | 'resource_conflict'
    | 'debt_source_unavailable'
    | 'foreign_key_violation'
    /** MySQL 1213: InnoDB already rolled the transaction back; RETRYABLE by re-running the whole unit. */
    | 'lock_conflict'
    /** MySQL 1205: lock wait timeout; RETRYABLE by re-running the whole unit. */
    | 'lock_wait_timeout';

export class BillingPayoutSqlError extends Error {
    constructor(public readonly code: PayoutSqlErrorCode, message: string) {
        super(message);
        this.name = 'BillingPayoutSqlError';
    }
}

/** A CAS outcome must come from an explicit driver count, never coercion. */
const requireCasAffectedRows = (raw: unknown): number => {
    // Connection contracts also permit strict decimal-string driver counts.
    const value = typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : raw;
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
        throw new BillingPayoutSqlError('invalid_row', 'CAS result has no readable non-negative integer affectedRows; transaction outcome cannot be classified');
    }
    return value;
};

/**
 * REQUIRED audit sink bound to one open transaction connection. There is no
 * default and no no-op.
 */
export type PayoutSqlAuditSink = (
    conn: PayoutSqlConnection,
    record: PayoutAuditRecord,
) => Promise<void> | void;

export interface BillingPayoutsSqlDeps {
    transaction: PayoutSqlTransactionRunner;
    audit: PayoutSqlAuditSink;
}

const PAYOUT_COLUMNS = `payout_id, tenant_id, destination_ref, amount_minor, currency,
    status, reservation_id, version, idempotency_key, payload_hash, requested_by,
    provider_reference, failure_reason, cancellation_reason, created_at, updated_at`;

const TRANSITION_COLUMNS = `id, tenant_id, payout_id, action, idempotency_key,
    payload_hash, from_status, to_status, version_after, reservation_id,
    journal_id, actor_id, reason, created_at`;

const RESERVATION_COLUMNS = `r.id, r.tenant_id, r.currency, r.amount_minor,
    r.available_account_id, r.reserved_account_id, r.status, r.version,
    r.reserve_journal_id, r.release_journal_id, r.consume_journal_id,
    r.consume_counter_account_id, r.reference, r.description, r.created_at,
    r.updated_at, k.idempotency_key AS reservation_key,
    k.payload_hash AS key_payload_hash`;

const CURRENCY_PATTERN = /^[A-Z]{3}$/;
const HEX_64_PATTERN = /^[0-9a-f]{64}$/;

/** Exact unique keys from migration 04 (MySQL reports `PRIMARY` for PKs). */
const PAYOUT_REQUEST_DUP_KEYS: ReadonlySet<string> = new Set(['PRIMARY', 'uq_payout_requests_idem']);
const PAYOUT_TRANSITION_DUP_KEYS: ReadonlySet<string> = new Set(['PRIMARY', 'uq_payout_transitions_idem']);

const isDuplicateError = (error: unknown): boolean =>
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ER_DUP_ENTRY';

const isForeignKeyError = (error: unknown): boolean => {
    if (typeof error !== 'object' || error === null) return false;
    const code = (error as { code?: unknown }).code;
    return code === 'ER_NO_REFERENCED_ROW_2' || code === 'ER_ROW_IS_REFERENCED_2';
};

const errorTextOf = (error: unknown): string => {
    if (typeof error !== 'object' || error === null) return '';
    const sqlMessage = (error as { sqlMessage?: unknown }).sqlMessage;
    if (typeof sqlMessage === 'string') return sqlMessage;
    const message = (error as { message?: unknown }).message;
    return typeof message === 'string' ? message : '';
};

/** Mirrors the accepted billing-collection-sql duplicate-key extraction. */
const duplicateKeyNameOf = (error: unknown): string | null => {
    const text = errorTextOf(error);
    const match = /for key\s+['"`]([^'"`]+)['"`]/i.exec(text)
        ?? /Duplicate entry\s+'[^']*'\s+for key\s+([A-Za-z0-9_.]+)/i.exec(text);
    if (match?.[1] === undefined) return null;
    const parts = match[1].split('.');
    return parts[parts.length - 1] ?? null;
};

const toIso = (value: string | Date, field: string): string => {
    const date = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(date.getTime())) {
        throw new BillingPayoutSqlError('invalid_row', `${field} is not a parseable timestamp`);
    }
    return date.toISOString();
};

const requireTimestamp = (value: unknown, field: string): string => {
    if (typeof value !== 'string' || value.trim() === '' || Number.isNaN(Date.parse(value))) {
        throw new BillingPayoutSqlError('invalid_row', `${field} must be a parseable timestamp string`);
    }
    return value;
};

const requireBounded = (value: unknown, field: string, maxLength: number): string => {
    if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) {
        throw new BillingPayoutSqlError(
            'invalid_row',
            `${field} must be a non-empty string of at most ${maxLength} characters`,
        );
    }
    return value;
};

const requireNullableBounded = (value: unknown, field: string, maxLength: number): string | null => {
    if (value === null) return null;
    return requireBounded(value, field, maxLength);
};

const requireCurrency = (value: unknown): string => {
    if (typeof value !== 'string' || !CURRENCY_PATTERN.test(value)) {
        throw new BillingPayoutSqlError('invalid_row', 'currency must be a three-letter uppercase ISO-4217 code');
    }
    return value;
};

const requireHex64 = (value: unknown, field: string): string => {
    const text = requireBounded(value, field, 128);
    if (!HEX_64_PATTERN.test(text)) {
        throw new BillingPayoutSqlError('invalid_row', `${field} must be a lowercase SHA-256 hex string`);
    }
    return text;
};

const requirePayoutStatus = (value: unknown): PayoutStatus => {
    if (typeof value !== 'string' || !(PAYOUT_STATUSES as readonly string[]).includes(value)) {
        throw new BillingPayoutSqlError('invalid_row', 'payout has an unknown status');
    }
    return value as PayoutStatus;
};

const requirePayoutAction = (value: unknown): PayoutAction => {
    if (typeof value !== 'string' || !(PAYOUT_ACTIONS as readonly string[]).includes(value)) {
        throw new BillingPayoutSqlError('invalid_row', 'payout transition has an unknown action');
    }
    return value as PayoutAction;
};

const requirePayoutAmount = (value: unknown): bigint => {
    const amount = normalizeSqlBigInt(value, 'payout amount_minor', { max: MAX_PAYOUT_AMOUNT_MINOR });
    if (amount <= 0n) {
        throw new BillingPayoutSqlError('invalid_row', 'payout amount_minor must be positive');
    }
    return amount;
};

const requireReservationStatus = (value: unknown): ReservationStatus => {
    if (value !== 'reserved' && value !== 'released' && value !== 'consumed') {
        throw new BillingPayoutSqlError('invalid_row', 'a reservation has an unknown status');
    }
    return value;
};

interface PayoutRowDb {
    payout_id: string;
    tenant_id: string;
    destination_ref: string;
    amount_minor: unknown;
    currency: string;
    status: string;
    reservation_id: string | null;
    version: unknown;
    idempotency_key: string;
    payload_hash: string;
    requested_by: string | null;
    provider_reference: string | null;
    failure_reason: string | null;
    cancellation_reason: string | null;
    created_at: string | Date;
    updated_at: string | Date;
}

interface PayoutTransitionRowDb {
    id: string;
    tenant_id: string;
    payout_id: string;
    action: string;
    idempotency_key: string;
    payload_hash: string;
    from_status: string;
    to_status: string;
    version_after: unknown;
    reservation_id: string | null;
    journal_id: string | null;
    actor_id: string | null;
    reason: string | null;
    created_at: string | Date;
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
    reservation_key: string | null;
    key_payload_hash: string | null;
}

const payoutOfRow = (row: PayoutRowDb, tenantId: string): PayoutRequest => {
    if (row.tenant_id !== tenantId) {
        throw new BillingPayoutSqlError('invalid_row', 'a payout row belongs to another tenant');
    }
    return {
        payoutId: requireBounded(row.payout_id, 'payout_requests.payout_id', MAX_PAYOUT_ID_LENGTH),
        tenantId: requireBounded(row.tenant_id, 'payout_requests.tenant_id', MAX_TENANT_LENGTH),
        destinationRef: requireBounded(
            row.destination_ref,
            'payout_requests.destination_ref',
            MAX_DESTINATION_LENGTH,
        ),
        amountMinor: requirePayoutAmount(row.amount_minor),
        currency: requireCurrency(row.currency),
        status: requirePayoutStatus(row.status),
        reservationId: requireNullableBounded(row.reservation_id, 'payout_requests.reservation_id', 64),
        version: normalizeSqlVersion(row.version, 'payout_requests.version'),
        idempotencyKey: requireBounded(
            row.idempotency_key,
            'payout_requests.idempotency_key',
            MAX_IDEMPOTENCY_KEY_LENGTH,
        ),
        payloadHash: requireHex64(row.payload_hash, 'payout_requests.payload_hash'),
        requestedBy: requireNullableBounded(row.requested_by, 'payout_requests.requested_by', MAX_ACTOR_LENGTH),
        providerReference: requireNullableBounded(
            row.provider_reference,
            'payout_requests.provider_reference',
            128,
        ),
        failureReason: requireNullableBounded(row.failure_reason, 'payout_requests.failure_reason', MAX_REASON_LENGTH),
        cancellationReason: requireNullableBounded(
            row.cancellation_reason,
            'payout_requests.cancellation_reason',
            MAX_REASON_LENGTH,
        ),
        createdAt: toIso(row.created_at, 'payout_requests.created_at'),
        updatedAt: toIso(row.updated_at, 'payout_requests.updated_at'),
    };
};

const transitionOfRow = (row: PayoutTransitionRowDb, tenantId: string): PayoutTransitionRecord => {
    if (row.tenant_id !== tenantId) {
        throw new BillingPayoutSqlError('invalid_row', 'a payout transition row belongs to another tenant');
    }
    return {
        id: requireBounded(row.id, 'payout_transitions.id', 64),
        tenantId: requireBounded(row.tenant_id, 'payout_transitions.tenant_id', MAX_TENANT_LENGTH),
        payoutId: requireBounded(row.payout_id, 'payout_transitions.payout_id', MAX_PAYOUT_ID_LENGTH),
        action: requirePayoutAction(row.action),
        idempotencyKey: requireBounded(
            row.idempotency_key,
            'payout_transitions.idempotency_key',
            MAX_IDEMPOTENCY_KEY_LENGTH,
        ),
        payloadHash: requireHex64(row.payload_hash, 'payout_transitions.payload_hash'),
        fromStatus: requirePayoutStatus(row.from_status),
        toStatus: requirePayoutStatus(row.to_status),
        versionAfter: normalizeSqlVersion(row.version_after, 'payout_transitions.version_after'),
        reservationId: requireNullableBounded(row.reservation_id, 'payout_transitions.reservation_id', 64),
        journalId: requireNullableBounded(row.journal_id, 'payout_transitions.journal_id', 64),
        actorId: requireNullableBounded(row.actor_id, 'payout_transitions.actor_id', MAX_ACTOR_LENGTH),
        reason: requireNullableBounded(row.reason, 'payout_transitions.reason', MAX_REASON_LENGTH),
        createdAt: toIso(row.created_at, 'payout_transitions.created_at'),
    };
};

const reservationOfRow = (row: ReservationRowDb, tenantId: string): ReservationRecord => {
    if (row.tenant_id !== tenantId) {
        throw new BillingPayoutSqlError('invalid_row', 'a reservation row belongs to another tenant');
    }
    return {
        id: row.id,
        tenantId: row.tenant_id,
        reservationKey: row.reservation_key ?? '',
        payloadHash: row.key_payload_hash ?? '',
        currency: requireCurrency(row.currency),
        amountMinor: normalizeSqlBigInt(row.amount_minor, 'billing_reservations.amount_minor', {
            max: MAX_AMOUNT_MINOR,
        }),
        availableAccountId: row.available_account_id,
        reservedAccountId: row.reserved_account_id,
        status: requireReservationStatus(row.status),
        version: normalizeSqlVersion(row.version, 'billing_reservations.version'),
        reserveJournalId: row.reserve_journal_id,
        releaseJournalId: row.release_journal_id,
        consumeJournalId: row.consume_journal_id,
        consumeCounterAccountId: row.consume_counter_account_id,
        reference: row.reference,
        description: row.description,
        createdAt: toIso(row.created_at, 'billing_reservations.created_at'),
        updatedAt: toIso(row.updated_at, 'billing_reservations.updated_at'),
    };
};

const requireListLimit = (value: unknown, fallback: number): number => {
    if (value === undefined) return fallback;
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > MAX_LIST_LIMIT) {
        throw new BillingPayoutSqlError(
            'store_overrun',
            `limit must be an integer between 1 and ${MAX_LIST_LIMIT}`,
        );
    }
    return value;
};

interface MergedDebt {
    readonly debt: SubscriptionDebt;
    readonly dueAt: bigint;
}

interface DebtRowDb {
    reference_id: string;
    tenant_id: string;
    currency: string;
    outstanding_minor: unknown;
    deadline_at: unknown;
    invoice_ref_id: string | null;
}

const isMissingSourceError = (error: unknown): boolean => {
    if (typeof error !== 'object' || error === null) return false;
    const code = (error as { code?: unknown }).code;
    const errno = (error as { errno?: unknown }).errno;
    return code === 'ER_NO_SUCH_TABLE'
        || code === 'ER_BAD_FIELD_ERROR'
        || code === 'ER_UNKNOWN_TABLE'
        || errno === 1146
        || errno === 1054;
};

/** MySQL 1792: a locking read inside a READ ONLY transaction => unavailable form. */
const isReadOnlyTransactionError = (error: unknown): boolean => {
    if (typeof error !== 'object' || error === null) return false;
    return (error as { code?: unknown }).code === 'ER_CANT_EXECUTE_IN_READ_ONLY_TRANSACTION'
        || (error as { errno?: unknown }).errno === 1792;
};

/** Typed RETRYABLE lock failure (1213 / 1205), or null for any other error. */
const lockFailureOf = (error: unknown): BillingPayoutSqlError | null => {
    if (typeof error !== 'object' || error === null) return null;
    const code = (error as { code?: unknown }).code;
    const errno = (error as { errno?: unknown }).errno;
    if (code === 'ER_LOCK_DEADLOCK' || errno === 1213) {
        return new BillingPayoutSqlError(
            'lock_conflict',
            'deadlock detected; the unit of work was rolled back and may be retried',
        );
    }
    if (code === 'ER_LOCK_WAIT_TIMEOUT' || errno === 1205) {
        return new BillingPayoutSqlError('lock_wait_timeout', 'lock wait timeout; the unit of work may be retried');
    }
    return null;
};

/** Stored due_at arrives as a decimal epoch-second string; anything else is malformed. */
const parseStoredDueAt = (value: unknown): bigint | null => {
    if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,18})$/.test(value)) return null;
    return BigInt(value);
};

const unavailableDebtSource = (message: string): BillingPayoutSqlError =>
    new BillingPayoutSqlError('debt_source_unavailable', message);

/** The settlement reader never writes; any audit attempt through it is a bug. */
const readerOnlyAudit = (): never => {
    throw unavailableDebtSource('the debt reader has no audit path');
};

export interface BillingPayoutsSqlTransaction extends PayoutTransaction {
    /** The ONLY payout audit path; bound to THIS transaction's connection. */
    writeAudit(record: PayoutAuditRecord): Promise<void>;
}

class BillingPayoutsSqlTransactionImpl implements BillingPayoutsSqlTransaction {
    private readonly ledger: ReservationTransaction;
    private readonly runner: PayoutSqlTransactionRunner;
    /** Set only by a duplicate insert so the domain's by-key re-read is current. */
    private payoutDuplicatePending = false;

    constructor(
        private readonly conn: PayoutSqlConnection,
        private readonly audit: PayoutSqlAuditSink,
        runner: PayoutSqlTransactionRunner,
    ) {
        this.ledger = createBoundBillingLedgerSqlTransaction(conn, { transaction: runner });
        this.runner = runner;
    }

    async writeAudit(record: PayoutAuditRecord): Promise<void> {
        await this.audit(this.conn, record);
    }

    getAccount(tenantId: string, accountId: string) {
        return this.ledger.getAccount(tenantId, accountId);
    }

    findJournalByIdempotencyKey(tenantId: string, idempotencyKey: string) {
        return this.ledger.findJournalByIdempotencyKey(tenantId, idempotencyKey);
    }

    getJournal(tenantId: string, journalId: string) {
        return this.ledger.getJournal(tenantId, journalId);
    }

    findReversalOf(tenantId: string, journalId: string) {
        return this.ledger.findReversalOf(tenantId, journalId);
    }

    insertJournal(input: Parameters<PayoutTransaction['insertJournal']>[0]) {
        return this.ledger.insertJournal(input);
    }

    /** Same reservation/journal guard authority as the wrapped ledger transaction. */
    findReservationJournalLink(tenantId: string, journalId: string) {
        const delegate = this.ledger.findReservationJournalLink;
        if (typeof delegate !== 'function') {
            throw new BillingPayoutSqlError(
                'invalid_row',
                'the wrapped ledger transaction does not provide findReservationJournalLink',
            );
        }
        return delegate.call(this.ledger, tenantId, journalId);
    }

    /** Same idempotent zero-balance provisioning as the wrapped ledger transaction. */
    provisionAccountIdempotent(
        tenantId: string,
        kind: Parameters<NonNullable<ReservationTransaction['provisionAccountIdempotent']>>[1],
        currency: string,
    ) {
        const delegate = this.ledger.provisionAccountIdempotent;
        if (typeof delegate !== 'function') {
            throw new BillingPayoutSqlError(
                'invalid_row',
                'the wrapped ledger transaction does not provide provisionAccountIdempotent',
            );
        }
        return delegate.call(this.ledger, tenantId, kind, currency);
    }

    findReservationByKey(tenantId: string, reservationKey: string) {
        return this.ledger.findReservationByKey(tenantId, reservationKey);
    }

    getReservation(tenantId: string, reservationId: string) {
        return this.ledger.getReservation(tenantId, reservationId);
    }

    insertReservation(reservation: Parameters<PayoutTransaction['insertReservation']>[0]) {
        return this.ledger.insertReservation(reservation);
    }

    updateReservation(input: Parameters<PayoutTransaction['updateReservation']>[0]) {
        return this.ledger.updateReservation(input);
    }

    insertReservationEvent(event: Parameters<PayoutTransaction['insertReservationEvent']>[0]) {
        return this.ledger.insertReservationEvent(event);
    }

    async findByIdempotencyKey(tenantId: string, idempotencyKey: string): Promise<PayoutRequest | null> {
        const lockSuffix = this.payoutDuplicatePending ? ' FOR SHARE' : '';
        this.payoutDuplicatePending = false;
        return this.selectPayoutByIdempotencyKey(tenantId, idempotencyKey, lockSuffix);
    }

    private async selectPayoutByIdempotencyKey(
        tenantId: string,
        idempotencyKey: string,
        lockSuffix: string,
    ): Promise<PayoutRequest | null> {
        const tenant = requireBounded(tenantId, 'tenantId', MAX_TENANT_LENGTH);
        const key = requireBounded(idempotencyKey, 'idempotencyKey', MAX_IDEMPOTENCY_KEY_LENGTH);
        const rows = await this.conn.query<PayoutRowDb>(
            `SELECT ${PAYOUT_COLUMNS}
               FROM payout_requests
              WHERE tenant_id = ? AND idempotency_key = ?
              LIMIT 1${lockSuffix}`,
            [tenant, key],
        );
        const row = rows[0];
        return row === undefined ? null : payoutOfRow(row, tenant);
    }

    async findPayoutForUpdate(tenantId: string, payoutId: string): Promise<PayoutRequest | null> {
        return this.selectPayout(tenantId, payoutId, ' FOR UPDATE');
    }

    /** Plain non-locking tenant-scoped read (no FOR UPDATE/SHARE, no writes, no audit). */
    async findPayoutSnapshot(tenantId: string, payoutId: string): Promise<PayoutRequest | null> {
        return this.selectPayout(tenantId, payoutId, '');
    }

    private async selectPayout(
        tenantId: string,
        payoutId: string,
        lockSuffix: string,
    ): Promise<PayoutRequest | null> {
        const tenant = requireBounded(tenantId, 'tenantId', MAX_TENANT_LENGTH);
        const id = requireBounded(payoutId, 'payoutId', MAX_PAYOUT_ID_LENGTH);
        const rows = await this.conn.query<PayoutRowDb>(
            `SELECT ${PAYOUT_COLUMNS}
               FROM payout_requests
              WHERE tenant_id = ? AND payout_id = ?
              LIMIT 1${lockSuffix}`,
            [tenant, id],
        );
        const row = rows[0];
        return row === undefined ? null : payoutOfRow(row, tenant);
    }

    async insertPayout(payout: PayoutRequest): Promise<InsertPayoutResult> {
        const tenant = requireBounded(payout.tenantId, 'payout.tenantId', MAX_TENANT_LENGTH);
        const payoutId = requireBounded(payout.payoutId, 'payout.payoutId', MAX_PAYOUT_ID_LENGTH);
        const destinationRef = requireBounded(
            payout.destinationRef,
            'payout.destinationRef',
            MAX_DESTINATION_LENGTH,
        );
        const amount = requirePayoutAmount(payout.amountMinor);
        const currency = requireCurrency(payout.currency);
        const status = requirePayoutStatus(payout.status);
        const reservationId = requireNullableBounded(payout.reservationId, 'payout.reservationId', 64);
        const version = normalizeSqlVersion(payout.version, 'payout.version');
        const idempotencyKey = requireBounded(
            payout.idempotencyKey,
            'payout.idempotencyKey',
            MAX_IDEMPOTENCY_KEY_LENGTH,
        );
        const payloadHash = requireHex64(payout.payloadHash, 'payout.payloadHash');
        const requestedBy = requireNullableBounded(payout.requestedBy, 'payout.requestedBy', MAX_ACTOR_LENGTH);
        const providerReference = requireNullableBounded(
            payout.providerReference,
            'payout.providerReference',
            128,
        );
        const failureReason = requireNullableBounded(
            payout.failureReason,
            'payout.failureReason',
            MAX_REASON_LENGTH,
        );
        const cancellationReason = requireNullableBounded(
            payout.cancellationReason,
            'payout.cancellationReason',
            MAX_REASON_LENGTH,
        );
        const createdAt = requireTimestamp(payout.createdAt, 'payout.createdAt');
        const updatedAt = requireTimestamp(payout.updatedAt, 'payout.updatedAt');

        await this.conn.execute(`SAVEPOINT ${PAYOUT_INSERT_SAVEPOINT}`);
        try {
            await this.conn.execute(
                `INSERT INTO payout_requests
                    (payout_id, tenant_id, destination_ref, amount_minor, currency,
                     status, reservation_id, version, idempotency_key, payload_hash,
                     requested_by, provider_reference, failure_reason,
                     cancellation_reason, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    payoutId,
                    tenant,
                    destinationRef,
                    amount.toString(),
                    currency,
                    status,
                    reservationId,
                    version,
                    idempotencyKey,
                    payloadHash,
                    requestedBy,
                    providerReference,
                    failureReason,
                    cancellationReason,
                    createdAt,
                    updatedAt,
                ],
            );
            await this.conn.execute(`RELEASE SAVEPOINT ${PAYOUT_INSERT_SAVEPOINT}`);
        } catch (error) {
            await this.rollbackToSavepoint(PAYOUT_INSERT_SAVEPOINT);
            if (isDuplicateError(error)) {
                const keyName = duplicateKeyNameOf(error);
                if (keyName === null || !PAYOUT_REQUEST_DUP_KEYS.has(keyName)) throw error;
                if (keyName === 'PRIMARY') {
                    const existing = await this.selectPayout(tenant, payoutId, ' FOR SHARE');
                    if (existing === null) {
                        throw new BillingPayoutSqlError(
                            'store_inconsistent',
                            'a payout PRIMARY duplicate could not be re-read inside the transaction',
                        );
                    }
                    if (existing.idempotencyKey !== idempotencyKey) {
                        throw new BillingPayoutSqlError(
                            'resource_conflict',
                            'payoutId was reused with a different idempotency key',
                        );
                    }
                }
                this.payoutDuplicatePending = true;
                return 'duplicate_key';
            }
            if (isForeignKeyError(error)) {
                throw new BillingPayoutSqlError(
                    'foreign_key_violation',
                    'payout insert referenced a missing/foreign tenant or reservation',
                );
            }
            throw error;
        }
        return 'inserted';
    }

    async updateStatusCas(input: UpdatePayoutStatusCasInput): Promise<UpdatePayoutStatusCasResult> {
        const tenant = requireBounded(input.tenantId, 'tenantId', MAX_TENANT_LENGTH);
        const payoutId = requireBounded(input.payoutId, 'payoutId', MAX_PAYOUT_ID_LENGTH);
        const expectedVersion = normalizeSqlVersion(input.expectedVersion, 'payout expectedVersion');
        const fromStatus = requirePayoutStatus(input.fromStatus);
        const toStatus = requirePayoutStatus(input.toStatus);
        const reservationId = requireNullableBounded(input.reservationId, 'reservationId', 64);
        const providerReference = requireNullableBounded(input.providerReference, 'providerReference', 128);
        const failureReason = requireNullableBounded(input.failureReason, 'failureReason', MAX_REASON_LENGTH);
        const cancellationReason = requireNullableBounded(
            input.cancellationReason,
            'cancellationReason',
            MAX_REASON_LENGTH,
        );
        const updatedAt = requireTimestamp(input.updatedAt, 'updatedAt');

        const result = await this.conn.execute(
            `UPDATE payout_requests
                SET status = ?, reservation_id = ?, provider_reference = ?,
                    failure_reason = ?, cancellation_reason = ?, updated_at = ?,
                    version = version + 1
              WHERE tenant_id = ? AND payout_id = ? AND version = ? AND status = ?`,
            [
                toStatus,
                reservationId,
                providerReference,
                failureReason,
                cancellationReason,
                updatedAt,
                tenant,
                payoutId,
                expectedVersion,
                fromStatus,
            ],
        );
        const affected = requireCasAffectedRows(result.affectedRows);
        if (affected === 1) {
            const updated = await this.selectPayout(tenant, payoutId, '');
            if (updated === null) {
                throw new BillingPayoutSqlError('invalid_row', 'an updated payout disappeared');
            }
            return { ok: true, payout: updated };
        }
        if (affected !== 0) {
            throw new BillingPayoutSqlError(
                'store_overrun',
                `the payout CAS UPDATE reported ${affected} affected rows where exactly one was possible`,
            );
        }
        const current = await this.selectPayout(tenant, payoutId, '');
        if (current === null) return { ok: false, reason: 'not_found' };
        if (current.version !== expectedVersion) return { ok: false, reason: 'version_conflict' };
        return { ok: false, reason: 'invalid_transition' };
    }

    async findTransitionByIdempotencyKey(
        tenantId: string,
        idempotencyKey: string,
    ): Promise<PayoutTransitionRecord | null> {
        const tenant = requireBounded(tenantId, 'tenantId', MAX_TENANT_LENGTH);
        const key = requireBounded(idempotencyKey, 'idempotencyKey', MAX_IDEMPOTENCY_KEY_LENGTH);
        const rows = await this.conn.query<PayoutTransitionRowDb>(
            `SELECT ${TRANSITION_COLUMNS}
               FROM payout_transitions
              WHERE tenant_id = ? AND idempotency_key = ?
              LIMIT 1`,
            [tenant, key],
        );
        const row = rows[0];
        return row === undefined ? null : transitionOfRow(row, tenant);
    }

    private async selectTransitionById(
        tenantId: string,
        id: string,
        lockSuffix: string,
    ): Promise<PayoutTransitionRecord | null> {
        const tenant = requireBounded(tenantId, 'tenantId', MAX_TENANT_LENGTH);
        const transitionId = requireBounded(id, 'transition.id', 64);
        const rows = await this.conn.query<PayoutTransitionRowDb>(
            `SELECT ${TRANSITION_COLUMNS}
               FROM payout_transitions
              WHERE tenant_id = ? AND id = ?
              LIMIT 1${lockSuffix}`,
            [tenant, transitionId],
        );
        const row = rows[0];
        return row === undefined ? null : transitionOfRow(row, tenant);
    }

    async insertTransition(record: PayoutTransitionRecord): Promise<'inserted' | 'duplicate_key'> {
        const id = requireBounded(record.id, 'transition.id', 64);
        const tenant = requireBounded(record.tenantId, 'transition.tenantId', MAX_TENANT_LENGTH);
        const payoutId = requireBounded(record.payoutId, 'transition.payoutId', MAX_PAYOUT_ID_LENGTH);
        const action = requirePayoutAction(record.action);
        const idempotencyKey = requireBounded(
            record.idempotencyKey,
            'transition.idempotencyKey',
            MAX_IDEMPOTENCY_KEY_LENGTH,
        );
        const payloadHash = requireHex64(record.payloadHash, 'transition.payloadHash');
        const fromStatus = requirePayoutStatus(record.fromStatus);
        const toStatus = requirePayoutStatus(record.toStatus);
        const versionAfter = normalizeSqlVersion(record.versionAfter, 'transition.versionAfter');
        const reservationId = requireNullableBounded(record.reservationId, 'transition.reservationId', 64);
        const journalId = requireNullableBounded(record.journalId, 'transition.journalId', 64);
        const actorId = requireNullableBounded(record.actorId, 'transition.actorId', MAX_ACTOR_LENGTH);
        const reason = requireNullableBounded(record.reason, 'transition.reason', MAX_REASON_LENGTH);
        const createdAt = requireTimestamp(record.createdAt, 'transition.createdAt');

        await this.conn.execute(`SAVEPOINT ${PAYOUT_TRANSITION_SAVEPOINT}`);
        try {
            await this.conn.execute(
                `INSERT INTO payout_transitions
                    (id, tenant_id, payout_id, action, idempotency_key, payload_hash,
                     from_status, to_status, version_after, reservation_id, journal_id,
                     actor_id, reason, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    id,
                    tenant,
                    payoutId,
                    action,
                    idempotencyKey,
                    payloadHash,
                    fromStatus,
                    toStatus,
                    versionAfter,
                    reservationId,
                    journalId,
                    actorId,
                    reason,
                    createdAt,
                ],
            );
            await this.conn.execute(`RELEASE SAVEPOINT ${PAYOUT_TRANSITION_SAVEPOINT}`);
        } catch (error) {
            await this.rollbackToSavepoint(PAYOUT_TRANSITION_SAVEPOINT);
            if (isDuplicateError(error)) {
                const keyName = duplicateKeyNameOf(error);
                if (keyName === null || !PAYOUT_TRANSITION_DUP_KEYS.has(keyName)) throw error;
                if (keyName === 'PRIMARY') {
                    const existing = await this.selectTransitionById(tenant, id, ' FOR SHARE');
                    if (existing === null) {
                        throw new BillingPayoutSqlError(
                            'store_inconsistent',
                            'a payout transition duplicate could not be re-read inside the transaction',
                        );
                    }
                    if (existing.idempotencyKey !== idempotencyKey) {
                        throw new BillingPayoutSqlError(
                            'resource_conflict',
                            'payout transition id was reused with a different idempotency key',
                        );
                    }
                }
                return 'duplicate_key';
            }
            if (isForeignKeyError(error)) {
                throw new BillingPayoutSqlError(
                    'foreign_key_violation',
                    'payout transition referenced a missing/foreign payout or reservation',
                );
            }
            throw error;
        }
        return 'inserted';
    }

    async listDueSubscriptionDebts(
        tenantId: string,
        currency: string,
        query?: { readonly limit?: number; readonly asOfSeconds: number },
    ): Promise<SubscriptionDebtPage> {
        const tenant = requireBounded(tenantId, 'tenantId', MAX_TENANT_LENGTH);
        const code = requireCurrency(currency);
        const limit = requireListLimit(query?.limit ?? undefined, DEBT_SCAN_LIMIT);
        // The server clock is supplied by the payout domain. An absent or
        // invalid instant can never be defaulted here (no invented time
        // source): due cannot be decided, so the debt source is unavailable.
        const asOfRaw: unknown = query?.asOfSeconds;
        if (typeof asOfRaw !== 'number' || !Number.isSafeInteger(asOfRaw) || asOfRaw < 0) {
            throw unavailableDebtSource(
                'the payout server clock (asOfSeconds) is absent or invalid; due cannot be decided',
            );
        }
        const asOf = BigInt(asOfRaw);

        // Invoice debt: the SHARED allocation source (billing-settlement.ts),
        // never re-implemented here. Any incompleteness is unavailable, and a
        // bounded page that does not cover every invoice is unavailable too.
        const reader = createBoundBillingSettlementSqlTransaction(this.conn, {
            transaction: this.runner,
            audit: readerOnlyAudit,
        });
        let outstanding: Awaited<ReturnType<typeof listInvoiceOutstanding>>;
        try {
            outstanding = await listInvoiceOutstanding(reader, tenant, { limit: MAX_LIST_LIMIT });
        } catch (error) {
            if (isMissingSourceError(error) || isReadOnlyTransactionError(error)) {
                throw unavailableDebtSource('the invoice allocation source is not available');
            }
            throw lockFailureOf(error) ?? error;
        }
        if (!outstanding.ok) {
            throw unavailableDebtSource('the invoice allocation source is unavailable or incomplete');
        }
        if (outstanding.truncated) {
            throw unavailableDebtSource('the invoice allocation scan was truncated; refusing to guess the debt');
        }
        const knownInvoiceIds = new Set<string>();
        const merged: MergedDebt[] = [];
        for (const entry of outstanding.invoices) {
            knownInvoiceIds.add(entry.invoiceId);
            if (entry.currency !== code) continue;
            const open = normalizeSqlBigInt(entry.outstandingMinor, 'invoice outstanding_minor');
            if (open <= 0n) continue;
            // 14.5.4: due is decided ONLY from the stored explicit due_at that
            // the shared settlement list returns. Unresolved => unavailable
            // (neither due nor not due); resolved in the future => not a debt.
            if (entry.dueStatus !== 'resolved') {
                throw unavailableDebtSource(
                    'an invoice has an outstanding balance but its stored due instant is unresolved; due status cannot be decided',
                );
            }
            const dueAt = parseStoredDueAt(entry.dueAt);
            const basisVersion: unknown = entry.dueBasisVersion;
            if (
                dueAt === null
                || typeof entry.dueBasisRef !== 'string'
                || entry.dueBasisRef === ''
                || typeof basisVersion !== 'number'
                || !Number.isSafeInteger(basisVersion)
                || basisVersion < 1
            ) {
                throw unavailableDebtSource(
                    'an invoice due record is incomplete or malformed; due status cannot be decided',
                );
            }
            if (dueAt > asOf) continue;
            // The amount counted is ALWAYS the invoice outstanding, never a
            // linked request amount and never a sum of both.
            merged.push({
                debt: {
                    source: 'cycle_invoice',
                    referenceId: requireBounded(entry.invoiceId, 'invoice id', 64),
                    tenantId: tenant,
                    currency: code,
                    outstandingMinor: open,
                    status: 'due',
                },
                dueAt,
            });
        }

        // GLOBAL LOCK ORDER (header table): invoices/allocations (FOR UPDATE,
        // above) BEFORE difference requests. Difference requests: `open` and
        // `expired` are unpaid (docs/19 keeps payment available after the 96h
        // grace); `paid`/`cancelled` are not. An UNLINKED open request inside
        // the 96h grace is intentionally treated as DUE here: that is the
        // settled docs/19 behaviour (subscription debt has priority over a NEW
        // withdrawal); do not change it. A locking CURRENT read so a concurrent
        // settle/cancel committed beyond this snapshot cannot slip past the gate.
        let differenceRows: DebtRowDb[];
        try {
            differenceRows = await this.conn.query<DebtRowDb>(
                `SELECT id AS reference_id, tenant_id, currency,
                        amount_minor AS outstanding_minor, deadline_at, invoice_ref_id
                   FROM billing_difference_requests
                  WHERE tenant_id = ? AND currency = ? AND status IN ('open', 'expired')
                  ORDER BY deadline_at ASC, id ASC
                  LIMIT ? FOR SHARE`,
                [tenant, code, limit + 1],
            );
        } catch (error) {
            if (isMissingSourceError(error) || isReadOnlyTransactionError(error)) {
                throw unavailableDebtSource('the difference-request debt source is not available');
            }
            throw lockFailureOf(error) ?? error;
        }

        for (const row of differenceRows) {
            const linked = row.invoice_ref_id;
            if (linked !== null && linked !== undefined) {
                // The request is the payment request for that invoice's remaining
                // balance, not extra debt; the invoice side already decided.
                if (!knownInvoiceIds.has(linked)) {
                    throw unavailableDebtSource(
                        'a difference request points at an invoice outside the allocation source',
                    );
                }
                continue;
            }
            const amount = normalizeSqlBigInt(
                row.outstanding_minor,
                'billing_difference_requests.amount_minor',
            );
            if (amount <= 0n) continue;
            merged.push({
                debt: {
                    source: 'difference_request',
                    referenceId: requireBounded(row.reference_id, 'difference request id', 64),
                    tenantId: tenant,
                    currency: code,
                    outstandingMinor: amount,
                    status: 'due',
                },
                dueAt: normalizeSqlBigInt(row.deadline_at, 'billing_difference_requests.deadline_at'),
            });
        }

        merged.sort((left, right) => {
            if (left.dueAt !== right.dueAt) return left.dueAt < right.dueAt ? -1 : 1;
            return left.debt.referenceId < right.debt.referenceId ? -1 : 1;
        });
        // No silent truncation: either source overflowing the page is reported.
        const truncated = differenceRows.length > limit || merged.length > limit;
        return { debts: merged.slice(0, limit).map((entry) => entry.debt), truncated };
    }

    async listActiveReservations(
        tenantId: string,
        currency: string,
        query?: { readonly limit?: number },
    ): Promise<ActiveReservationPage> {
        const tenant = requireBounded(tenantId, 'tenantId', MAX_TENANT_LENGTH);
        const code = requireCurrency(currency);
        const limit = requireListLimit(query?.limit ?? undefined, RESERVATION_SCAN_LIMIT);
        // Locking current read: the reservation gate must see a release/consume
        // committed after this transaction's snapshot, otherwise available funds
        // are overstated and two payouts can reserve the same money.
        const rows = await this.conn.query<ReservationRowDb>(
            `SELECT ${RESERVATION_COLUMNS}
               FROM billing_reservations r
               LEFT JOIN billing_idempotency_keys k
                 ON k.reservation_id = r.id AND k.tenant_id = r.tenant_id
                AND k.scope = 'reservation'
              WHERE r.tenant_id = ? AND r.currency = ? AND r.status = 'reserved'
              ORDER BY r.created_at ASC, r.id ASC
              LIMIT ? FOR SHARE`,
            [tenant, code, limit + 1],
        );
        const truncated = rows.length > limit;
        return {
            reservations: rows.slice(0, limit).map((row) => reservationOfRow(row, tenant)),
            truncated,
        };
    }

    async listPayouts(
        tenantId: string,
        query?: { readonly limit?: number; readonly status?: PayoutStatus },
    ): Promise<PayoutPage> {
        const tenant = requireBounded(tenantId, 'tenantId', MAX_TENANT_LENGTH);
        const limit = requireListLimit(query?.limit ?? undefined, DEFAULT_LIST_LIMIT);
        const status = query?.status === undefined ? undefined : requirePayoutStatus(query.status);
        const statusClause = status === undefined ? '' : ' AND status = ?';
        const params: unknown[] = status === undefined ? [tenant, limit + 1] : [tenant, status, limit + 1];
        const rows = await this.conn.query<PayoutRowDb>(
            `SELECT ${PAYOUT_COLUMNS}
               FROM payout_requests
              WHERE tenant_id = ?${statusClause}
              ORDER BY created_at DESC, payout_id DESC
              LIMIT ?`,
            params,
        );
        const truncated = rows.length > limit;
        return {
            payouts: rows.slice(0, limit).map((row) => payoutOfRow(row, tenant)),
            truncated,
        };
    }

    private async rollbackToSavepoint(name: string): Promise<void> {
        await this.conn.execute(`ROLLBACK TO SAVEPOINT ${name}`);
        await this.conn.execute(`RELEASE SAVEPOINT ${name}`);
    }
}

export interface BillingPayoutsSqlStore extends PayoutStore<BillingPayoutsSqlTransaction> {
    inTransaction(conn: PayoutSqlConnection): BillingPayoutsSqlTransaction;
    runAtomic<T>(callback: (tx: BillingPayoutsSqlTransaction) => Promise<T>): Promise<T>;
}

class BillingPayoutsSqlStoreImpl implements BillingPayoutsSqlStore {
    private readonly audit: PayoutSqlAuditSink;

    constructor(private readonly deps: BillingPayoutsSqlDeps) {
        if (!deps || typeof deps.transaction !== 'function') {
            throw new BillingPayoutSqlError(
                'invalid_runner',
                'BillingPayoutsSqlStore requires a connection-bound transaction runner',
            );
        }
        if (typeof deps.audit !== 'function') {
            throw new BillingPayoutSqlError(
                'invalid_audit',
                'BillingPayoutsSqlStore requires the sealed connection-bound audit writer',
            );
        }
        this.audit = deps.audit;
    }

    inTransaction(conn: PayoutSqlConnection): BillingPayoutsSqlTransaction {
        return new BillingPayoutsSqlTransactionImpl(conn, this.audit, this.deps.transaction);
    }

    runAtomic<T>(callback: (tx: BillingPayoutsSqlTransaction) => Promise<T>): Promise<T> {
        return this.deps.transaction((conn) => callback(this.inTransaction(conn)));
    }
}

export const createBillingPayoutsSqlStore = (deps: BillingPayoutsSqlDeps): BillingPayoutsSqlStore =>
    new BillingPayoutsSqlStoreImpl(deps);

export const createBoundBillingPayoutsSqlTransaction = (
    conn: PayoutSqlConnection,
    deps: BillingPayoutsSqlDeps,
): BillingPayoutsSqlTransaction => new BillingPayoutsSqlStoreImpl(deps).inTransaction(conn);
