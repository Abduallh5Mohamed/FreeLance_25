/**
 * D1 — SQL adapter for the settlement-obligation contracts in
 * `billing-settlement.ts`.
 *
 * Implements `SettlementTransaction` / `SettlementStore` against the exact
 * tables and keys from `20261023_01_financial_settlement_obligations.sql`:
 *   financial_settlement_obligations
 *     PRIMARY KEY (id)
 *     uq_settlement_obligation_id_tenant (id, tenant_id)
 *     uq_settlement_obligation_payment (tenant_id, provider, provider_event_id)
 *     uq_settlement_obligation_order (tenant_id, order_id, purpose)
 *     uq_settlement_obligation_journal (journal_id)
 *   billing_payment_allocations
 *     PRIMARY KEY (allocation_id)
 *     uq_billing_allocation_id_tenant (allocation_id, tenant_id)
 *     uq_billing_allocation_payment_invoice
 *       (tenant_id, payment_reference, invoice_id, kind)
 *     uq_billing_allocation_reverses (tenant_id, reverses_allocation_id)   [20261023_03]
 *   financial_settlement_obligations additions [20261023_03]
 *     allocatable_minor, platform_receipt_journal_id (+ 4-value status)
 *   checkout_order_platform_targets [20261023_03]
 *     PRIMARY KEY (tenant_id, order_id)
 *   billing_invoice_obligations [20261023_03]
 *     PRIMARY KEY (invoice_id)   (LEFT JOINed for the due terms)
 *   billing_invoice_journals
 *     PRIMARY KEY (invoice_id)
 *     uq_billing_invoice_journal_invoice (invoice_id, tenant_id)
 *   checkout_orders (20261022_03)
 *     PRIMARY KEY (tenant_id, order_id)
 *
 * SOURCE CODE ONLY. Nothing here executes SQL or opens a connection. Every
 * statement of a unit of work is issued on the caller-injected transaction
 * connection. A missing runner or audit sink throws at construction, before any
 * statement; there is no pool, no autocommit fallback and no module-level
 * transaction state.
 *
 * LOCK ORDER (mandatory, CL-B section 14.6; ascending, never a lower step after a higher):
 *   G1 invoice row (LEFT JOIN invoice obligation terms) `FOR UPDATE`;
 *   G2 allocation rows ascending `allocation_id` (locking sum / `FOR SHARE`);
 *   G4 obligation row `FOR UPDATE` / `FOR SHARE`;
 *   G5 checkout order row `FOR UPDATE`;
 *   G6 platform target row `FOR SHARE`;
 *   G10 ledger accounts ascending `id` through the accepted ledger adapter.
 * Every SELECT places the lock clause AFTER `LIMIT`; bind order equals placeholder order.
 * `findAccountByKind` is intentionally a plain read: the ledger adapter owns
 * the account lock and locks touched accounts in ascending `id` order.
 *
 * MONEY (HK2): exact integer minor units only. BIGINT values arrive as
 * bigint, decimal string or exactly representable safe number and pass through
 * `normalizeSqlBigInt`; versions pass through `normalizeSqlVersion`. Required
 * mysql2 options for the production binding: `supportBigNumbers: true`,
 * `bigNumberStrings: true`.
 *
 * AUDIT: `writeAudit` is the ONLY path and routes to the REQUIRED
 * constructor-injected connection-bound sealed sink.
 */

import {
    ACCOUNT_KINDS,
    ACCOUNT_NORMAL_SIDE,
    AccountKind,
    InsertJournalInput,
    JournalRecord,
    LedgerAccount,
    LedgerError,
    MAX_ACCOUNT_BALANCE_MINOR,
    MAX_AMOUNT_MINOR,
    MAX_JOURNAL_ID_LENGTH,
    MAX_TENANT_ID_LENGTH,
    ReservationJournalLink,
} from './billing-ledger';
import {
    ALLOCATION_KINDS,
    AllocationKind,
    AllocationTotalResult,
    CheckoutPaymentProof,
    CompleteObligationReceiptInput,
    FlagObligationReconciliationInput,
    InsertAllocationResult,
    InvoiceDebtRecord,
    InvoiceDebtReader,
    InvoiceDueTerms,
    InvoiceIssuanceLink,
    MAX_ALLOCATION_ID_LENGTH,
    MAX_INVOICE_ID_LENGTH,
    MAX_LIST_LIMIT,
    MAX_OBLIGATION_ID_LENGTH,
    MAX_ORDER_ID_LENGTH,
    MAX_PROVIDER_EVENT_ID_LENGTH,
    MAX_PROVIDER_LENGTH,
    MAX_PROVIDER_REFERENCE_LENGTH,
    MAX_PURPOSE_LENGTH,
    MAX_REFERENCE_LENGTH,
    MarkObligationAllocatedInput,
    MarkObligationAwaitingInput,
    ObligationCasResult,
    PLATFORM_DIFFERENCE_PAYMENT_PURPOSES,
    PaymentAllocationRecord,
    PlatformAllocationReader,
    PlatformPaymentTarget,
    PlatformReadLock,
    RECONCILIATION_STATUSES,
    ReconciliationStatus,
    RecordObligationSettlementInput,
    RecordPlatformReceiptInput,
    SETTLEMENT_OBLIGATION_STATUSES,
    SettlementAuditRecord,
    SettlementObligationRecord,
    SettlementObligationStatus,
    SettlementStore,
    SettlementTransaction,
} from './billing-settlement';
import {
    BillingLedgerSqlError,
    createBoundBillingLedgerSqlTransaction,
    normalizeSqlBigInt,
    normalizeSqlVersion,
    type BillingSqlConnection,
    type BillingSqlTransactionRunner,
} from './billing-ledger-sql';
import type { ReservationTransaction } from './billing-reservations';

export const SETTLEMENT_SQL_ADAPTER_ID = 'billing-settlement-sql:20261023_03';
export const SETTLEMENT_ALLOCATION_INSERT_SAVEPOINT = 'billing_payment_allocation_insert';

export type SettlementSqlConnection = BillingSqlConnection;
export type SettlementSqlTransactionRunner = BillingSqlTransactionRunner;

export type BillingSettlementSqlErrorCode =
    | 'invalid_runner'
    | 'invalid_audit'
    | 'invalid_row'
    | 'store_overrun'
    | 'duplicate_key'
    | 'foreign_key_violation'
    | 'debt_source_unavailable'
    /** The debt source holds a corrupt row (e.g. an unparseable amount); no partial result. */
    | 'debt_source_invalid'
    /** MySQL 1213 ER_LOCK_DEADLOCK: the whole financial unit must roll back. */
    | 'lock_conflict'
    /** MySQL 1205 ER_LOCK_WAIT_TIMEOUT: the whole financial unit must roll back. */
    | 'lock_wait_timeout';

export class BillingSettlementSqlError extends Error {
    constructor(public readonly code: BillingSettlementSqlErrorCode, message: string) {
        super(message);
        this.name = 'BillingSettlementSqlError';
    }
}

/** REQUIRED settlement audit sink bound to one open transaction connection. */
export type SettlementSqlAuditSink = (
    conn: SettlementSqlConnection,
    record: SettlementAuditRecord,
) => Promise<void> | void;

export interface BillingSettlementSqlDeps {
    transaction: SettlementSqlTransactionRunner;
    audit: SettlementSqlAuditSink;
}

const OBLIGATION_COLUMNS = `id, tenant_id, order_id, purpose, amount_minor, currency,
    provider, provider_event_id, payload_hash, status, fee_minor, tax_minor,
    net_minor, journal_id, allocatable_minor, platform_receipt_journal_id,
    provider_receipt_reference,
    provider_settlement_reference, reconciliation_status, version,
    created_at, updated_at`;

const ALLOCATION_COLUMNS = `allocation_id, tenant_id, invoice_id, obligation_id,
    payment_reference, amount_minor, currency, kind, journal_id,
    reverses_allocation_id, created_at`;

const TARGET_COLUMNS = `tenant_id, order_id, purpose, request_id, invoice_id,
    currency, amount_minor`;

/** Joined invoice + due terms (a missing terms row reads as unresolved). */
const INVOICE_DEBT_SELECT = `SELECT i.id AS id, i.tenant_id AS tenant_id, i.currency AS currency,
           i.total_minor AS total_minor, o.due_status AS due_status, o.due_at AS due_at,
           o.due_basis_ref AS due_basis_ref, o.due_basis_version AS due_basis_version
      FROM billing_invoices i
      LEFT JOIN billing_invoice_obligations o
        ON o.invoice_id = i.id AND o.tenant_id = i.tenant_id`;

const MAX_PLATFORM_ALLOCATION_ROWS = 100;

const CURRENCY_PATTERN = /^[A-Z]{3}$/;
const HEX_64_PATTERN = /^[0-9a-f]{64}$/;

const isDuplicateError = (error: unknown): boolean =>
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ER_DUP_ENTRY';

const isForeignKeyError = (error: unknown): boolean => {
    if (typeof error !== 'object' || error === null) return false;
    const code = (error as { code?: unknown }).code;
    return code === 'ER_NO_REFERENCED_ROW_2' || code === 'ER_ROW_IS_REFERENCED_2';
};

const errorMessageOf = (error: unknown): string => {
    if (error instanceof Error) return error.message;
    if (typeof error === 'object' && error !== null) {
        const candidate = (error as { message?: unknown }).message ?? (error as { sqlMessage?: unknown }).sqlMessage;
        if (typeof candidate === 'string') return candidate;
    }
    return '';
};

/** mysql2 reports the violated key inside the error message; match REAL names. */
const duplicateKeyNameOf = (error: unknown): string | null => {
    if (!isDuplicateError(error)) return null;
    const match = /for key '?([A-Za-z0-9_.$]+)'?/.exec(errorMessageOf(error));
    if (match === null) return null;
    const value = match[1] as string;
    const lastDot = value.lastIndexOf('.');
    return lastDot < 0 ? value : value.slice(lastDot + 1);
};

/**
 * Missing allocation table/column (1146/1054) or a lock-mode refusal (1792
 * locking read inside a READ ONLY transaction) => the debt source cannot be
 * trusted right now: typed unavailable. Lock wait timeout (1205) and deadlock
 * (1213) are NOT a missing source: they are mapped by `mapDebtLockError` and
 * rethrown so the whole financial unit rolls back (no automatic retry).
 */
const isMissingDebtSourceError = (error: unknown): boolean => {
    if (typeof error !== 'object' || error === null) return false;
    const code = (error as { code?: unknown }).code;
    const errno = (error as { errno?: unknown }).errno;
    return code === 'ER_NO_SUCH_TABLE'
        || code === 'ER_BAD_FIELD_ERROR'
        || code === 'ER_UNKNOWN_TABLE'
        || code === 'ER_CANT_EXECUTE_IN_READ_ONLY_TRANSACTION'
        || errno === 1146
        || errno === 1054
        || errno === 1792;
};

/**
 * Map MySQL 1213 (ER_LOCK_DEADLOCK) / 1205 (ER_LOCK_WAIT_TIMEOUT) to typed
 * errors. Returns null for any other error. The caller must THROW the result:
 * a lock failure is never converted into a debt result.
 */
const mapDebtLockError = (error: unknown): BillingSettlementSqlError | null => {
    if (typeof error !== 'object' || error === null) return null;
    const code = (error as { code?: unknown }).code;
    const errno = (error as { errno?: unknown }).errno;
    if (code === 'ER_LOCK_DEADLOCK' || errno === 1213) {
        return new BillingSettlementSqlError('lock_conflict', 'a deadlock (1213) aborted the debt read; the unit must roll back');
    }
    if (code === 'ER_LOCK_WAIT_TIMEOUT' || errno === 1205) {
        return new BillingSettlementSqlError('lock_wait_timeout', 'a lock wait timeout (1205) aborted the debt read; the unit must roll back');
    }
    return null;
};

const debtSourceUnavailable = (message: string): BillingSettlementSqlError =>
    new BillingSettlementSqlError('debt_source_unavailable', message);

/**
 * Translate a failed financial statement: deadlock/lock-wait become the typed
 * thrown `lock_conflict` / `lock_wait_timeout` (the whole unit rolls back, no
 * retry); a missing table/column or a refused locking read becomes typed
 * `debt_source_unavailable`; anything else is rethrown untouched.
 */
const translateStatementError = (error: unknown, what: string): never => {
    const lockError = mapDebtLockError(error);
    if (lockError !== null) throw lockError;
    if (isMissingDebtSourceError(error)) {
        throw debtSourceUnavailable(`${what} is unavailable (missing schema or lock refused)`);
    }
    throw error;
};

const affectedRowsOf = (result: { affectedRows?: number | string }): number => {
    const raw = result.affectedRows;
    const value = typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : raw;
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
        throw new BillingSettlementSqlError('invalid_row', 'affectedRows is unreadable; a write result cannot be classified');
    }
    return value;
};

const toIso = (value: string | Date, field: string): string => {
    const date = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(date.getTime())) {
        throw new BillingSettlementSqlError('invalid_row', `${field} is not a parseable timestamp`);
    }
    return date.toISOString();
};

const requireBounded = (value: unknown, field: string, maxLength: number): string => {
    if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) {
        throw new BillingSettlementSqlError(
            'invalid_row',
            `${field} must be a non-empty string of at most ${maxLength} characters`,
        );
    }
    return value;
};

const optionalBounded = (value: unknown, field: string, maxLength: number): string | null => {
    if (value === null || value === undefined) return null;
    return requireBounded(value, field, maxLength);
};

const requireCurrency = (value: unknown): string => {
    if (typeof value !== 'string' || !CURRENCY_PATTERN.test(value)) {
        throw new BillingSettlementSqlError('invalid_row', 'currency must be a three-letter uppercase ISO-4217 code');
    }
    return value;
};

const requireHex64 = (value: unknown, field: string): string => {
    if (typeof value !== 'string' || !HEX_64_PATTERN.test(value)) {
        throw new BillingSettlementSqlError('invalid_row', `${field} must be a lowercase SHA-256 hex string`);
    }
    return value;
};

const requirePositiveMinor = (value: unknown, field: string): bigint => {
    const amount = normalizeSqlBigInt(value, field, { max: MAX_AMOUNT_MINOR });
    if (amount <= 0n) {
        throw new BillingSettlementSqlError('invalid_row', `${field} must be positive`);
    }
    return amount;
};

const requireNonNegativeMinor = (value: unknown, field: string): bigint =>
    normalizeSqlBigInt(value, field, { max: MAX_ACCOUNT_BALANCE_MINOR });

const optionalMinor = (value: unknown, field: string): bigint | null => {
    if (value === null || value === undefined) return null;
    return normalizeSqlBigInt(value, field, { max: MAX_AMOUNT_MINOR });
};

const requireObligationStatus = (value: unknown): SettlementObligationStatus => {
    if (typeof value !== 'string' || !(SETTLEMENT_OBLIGATION_STATUSES as readonly string[]).includes(value)) {
        throw new BillingSettlementSqlError('invalid_row', 'obligation has an unknown status');
    }
    return value as SettlementObligationStatus;
};

const requireReconciliationStatus = (value: unknown): ReconciliationStatus => {
    if (typeof value !== 'string' || !(RECONCILIATION_STATUSES as readonly string[]).includes(value)) {
        throw new BillingSettlementSqlError('invalid_row', 'obligation has an unknown reconciliation status');
    }
    return value as ReconciliationStatus;
};

const requireAllocationKind = (value: unknown): AllocationKind => {
    if (typeof value !== 'string' || !(ALLOCATION_KINDS as readonly string[]).includes(value)) {
        throw new BillingSettlementSqlError('invalid_row', 'allocation has an unknown kind');
    }
    return value as AllocationKind;
};

const requireAccountKind = (value: unknown): AccountKind => {
    if (typeof value !== 'string' || !(ACCOUNT_KINDS as readonly string[]).includes(value)) {
        throw new BillingSettlementSqlError('invalid_row', 'account has an unknown kind');
    }
    return value as AccountKind;
};

const requireNormalSide = (value: unknown): 'debit' | 'credit' => {
    if (value !== 'debit' && value !== 'credit') {
        throw new BillingSettlementSqlError('invalid_row', 'account has an unknown normal side');
    }
    return value;
};

const requireStoreLimit = (value: unknown): number => {
    if (
        typeof value !== 'number'
        || !Number.isSafeInteger(value)
        || value < 1
        || value > MAX_LIST_LIMIT + 1
    ) {
        throw new BillingSettlementSqlError(
            'store_overrun',
            `limit must be an integer between 1 and ${MAX_LIST_LIMIT + 1}`,
        );
    }
    return value;
};

interface ObligationRowDb {
    id: string;
    tenant_id: string;
    order_id: string;
    purpose: string;
    amount_minor: unknown;
    currency: string;
    provider: string;
    provider_event_id: string;
    payload_hash: string;
    status: string;
    fee_minor: unknown;
    tax_minor: unknown;
    net_minor: unknown;
    journal_id: string | null;
    allocatable_minor: unknown;
    platform_receipt_journal_id: string | null;
    provider_receipt_reference: string | null;
    provider_settlement_reference: string | null;
    reconciliation_status: string;
    version: unknown;
    created_at: string | Date;
    updated_at: string | Date;
}

interface TargetRowDb {
    tenant_id: string;
    order_id: string;
    purpose: string;
    request_id: string;
    invoice_id: string;
    currency: string;
    amount_minor: unknown;
}

interface CheckoutOrderRowDb {
    tenant_id: string;
    order_id: string;
    purpose: string;
    amount_minor: unknown;
    currency: string;
    status: string;
    confirmed_provider_event_id: string | null;
}

interface AccountRowDb {
    id: string;
    tenant_id: string;
    kind: string;
    normal_side: string;
    currency: string;
    balance_minor: unknown;
    version: unknown;
}

interface InvoiceDebtRowDb {
    id: string;
    tenant_id: string;
    currency: string;
    total_minor: unknown;
    due_status: string | null;
    due_at: unknown;
    due_basis_ref: string | null;
    due_basis_version: unknown;
}

interface InvoiceIssuanceRowDb {
    invoice_id: string;
    tenant_id: string;
    journal_id: string;
}

interface AllocationRowDb {
    allocation_id: string;
    tenant_id: string;
    invoice_id: string;
    obligation_id: string | null;
    payment_reference: string;
    amount_minor: unknown;
    currency: string;
    kind: string;
    journal_id: string;
    reverses_allocation_id: string | null;
    created_at: string | Date;
}

/**
 * Row rules (20261023_03 chk_settlement_obligation_status / _platform):
 *  - `completed` (merchant receipt): journal_id + net_minor, no platform columns;
 *  - `allocated` (platform only): no journal_id, no net_minor, both platform columns;
 *  - `pending`: no journal_id and both platform columns NULL;
 *  - `awaiting_allocation`: no journal_id; the platform columns are either both NULL
 *    (not proved) or both set, and then purpose is allowlisted, net is NULL, fee and
 *    tax are proved and allocatable + fee + tax = amount, 0 < allocatable <= amount.
 * A platform column on a non-allowlisted purpose is an invalid row.
 */
const mapObligation = (row: ObligationRowDb, tenantId: string): SettlementObligationRecord => {
    if (row.tenant_id !== tenantId) {
        throw new BillingSettlementSqlError('invalid_row', 'an obligation row belongs to another tenant');
    }
    const status = requireObligationStatus(row.status);
    const journalId = optionalBounded(row.journal_id, 'obligations.journal_id', MAX_JOURNAL_ID_LENGTH);
    const netMinor = optionalMinor(row.net_minor, 'obligations.net_minor');
    const feeMinor = optionalMinor(row.fee_minor, 'obligations.fee_minor');
    const taxMinor = optionalMinor(row.tax_minor, 'obligations.tax_minor');
    const amountMinor = requirePositiveMinor(row.amount_minor, 'obligations.amount_minor');
    const allocatableMinor = optionalMinor(row.allocatable_minor, 'obligations.allocatable_minor');
    const platformReceiptJournalId = optionalBounded(
        row.platform_receipt_journal_id,
        'obligations.platform_receipt_journal_id',
        MAX_JOURNAL_ID_LENGTH,
    );
    const purpose = requireBounded(row.purpose, 'obligations.purpose', MAX_PURPOSE_LENGTH);
    if (status === 'completed' && (journalId === null || netMinor === null)) {
        throw new BillingSettlementSqlError(
            'invalid_row',
            'a completed obligation has no journal/net and cannot be trusted',
        );
    }
    if (status !== 'completed' && journalId !== null) {
        throw new BillingSettlementSqlError(
            'invalid_row',
            'an incomplete obligation unexpectedly carries a journal id',
        );
    }
    if ((allocatableMinor === null) !== (platformReceiptJournalId === null)) {
        throw new BillingSettlementSqlError(
            'invalid_row',
            'the platform allocatable amount and the platform receipt journal must be set together',
        );
    }
    const platformProved = allocatableMinor !== null && platformReceiptJournalId !== null;
    if (platformProved) {
        if (!PLATFORM_DIFFERENCE_PAYMENT_PURPOSES.has(purpose)) {
            throw new BillingSettlementSqlError(
                'invalid_row',
                'a platform allocatable amount is only valid for a platform subscription purpose',
            );
        }
        if (status !== 'awaiting_allocation' && status !== 'allocated') {
            throw new BillingSettlementSqlError(
                'invalid_row',
                'a platform allocatable amount is only valid at awaiting_allocation or allocated',
            );
        }
        if (
            netMinor !== null
            || feeMinor === null
            || taxMinor === null
            || allocatableMinor <= 0n
            || allocatableMinor > amountMinor
            || allocatableMinor + feeMinor + taxMinor !== amountMinor
        ) {
            throw new BillingSettlementSqlError(
                'invalid_row',
                'the platform allocatable/fee/tax columns do not add up to the verified gross amount',
            );
        }
    }
    if (status === 'allocated' && !platformProved) {
        throw new BillingSettlementSqlError(
            'invalid_row',
            'an allocated obligation must carry its allocatable amount and platform receipt journal',
        );
    }
    return {
        id: requireBounded(row.id, 'obligations.id', MAX_OBLIGATION_ID_LENGTH),
        tenantId: requireBounded(row.tenant_id, 'obligations.tenant_id', MAX_TENANT_ID_LENGTH),
        orderId: requireBounded(row.order_id, 'obligations.order_id', MAX_ORDER_ID_LENGTH),
        purpose,
        amountMinor,
        currency: requireCurrency(row.currency),
        provider: requireBounded(row.provider, 'obligations.provider', MAX_PROVIDER_LENGTH),
        providerEventId: requireBounded(
            row.provider_event_id,
            'obligations.provider_event_id',
            MAX_PROVIDER_EVENT_ID_LENGTH,
        ),
        payloadHash: requireHex64(row.payload_hash, 'obligations.payload_hash'),
        status,
        feeMinor,
        taxMinor,
        netMinor,
        journalId,
        allocatableMinor,
        platformReceiptJournalId,
        providerReceiptReference: optionalBounded(
            row.provider_receipt_reference,
            'obligations.provider_receipt_reference',
            MAX_PROVIDER_REFERENCE_LENGTH,
        ),
        providerSettlementReference: optionalBounded(
            row.provider_settlement_reference,
            'obligations.provider_settlement_reference',
            MAX_PROVIDER_REFERENCE_LENGTH,
        ),
        reconciliationStatus: requireReconciliationStatus(row.reconciliation_status),
        version: normalizeSqlVersion(row.version, 'obligations.version'),
        createdAt: toIso(row.created_at, 'obligations.created_at'),
        updatedAt: toIso(row.updated_at, 'obligations.updated_at'),
    };
};

const mapCheckoutOrder = (row: CheckoutOrderRowDb, tenantId: string): CheckoutPaymentProof => {
    if (row.tenant_id !== tenantId) {
        throw new BillingSettlementSqlError('invalid_row', 'the locked order belongs to another tenant');
    }
    return {
        tenantId: requireBounded(row.tenant_id, 'checkout_orders.tenant_id', MAX_TENANT_ID_LENGTH),
        orderId: requireBounded(row.order_id, 'checkout_orders.order_id', MAX_ORDER_ID_LENGTH),
        purpose: requireBounded(row.purpose, 'checkout_orders.purpose', MAX_PURPOSE_LENGTH),
        amountMinor: requirePositiveMinor(row.amount_minor, 'checkout_orders.amount_minor'),
        currency: requireCurrency(row.currency),
        status: requireBounded(row.status, 'checkout_orders.status', 16),
        confirmedProviderEventId: optionalBounded(
            row.confirmed_provider_event_id,
            'checkout_orders.confirmed_provider_event_id',
            MAX_PROVIDER_EVENT_ID_LENGTH,
        ),
    };
};

const mapAccount = (row: AccountRowDb, tenantId: string): LedgerAccount => {
    if (row.tenant_id !== tenantId) {
        throw new BillingSettlementSqlError('invalid_row', 'a ledger account belongs to another tenant');
    }
    const kind = requireAccountKind(row.kind);
    const normalSide = requireNormalSide(row.normal_side);
    if (ACCOUNT_NORMAL_SIDE[kind] !== normalSide) {
        throw new BillingSettlementSqlError('invalid_row', 'a ledger account normal side does not match its kind');
    }
    return {
        id: requireBounded(row.id, 'billing_accounts.id', 36),
        tenantId: requireBounded(row.tenant_id, 'billing_accounts.tenant_id', MAX_TENANT_ID_LENGTH),
        kind,
        normalSide,
        currency: requireCurrency(row.currency),
        balanceMinor: normalizeSqlBigInt(row.balance_minor, 'billing_accounts.balance_minor', {
            allowNegative: true,
        }),
        version: normalizeSqlVersion(row.version, 'billing_accounts.version'),
    };
};

/**
 * Due terms from the LEFT JOINed `billing_invoice_obligations` row. A missing
 * row (all four columns NULL) is `unresolved`; a half-filled or contradictory
 * row is a corrupt debt source (typed `debt_source_invalid`, no partial result).
 */
const mapInvoiceDue = (row: InvoiceDebtRowDb): InvoiceDueTerms => {
    const corrupt = (detail: string): BillingSettlementSqlError =>
        new BillingSettlementSqlError('debt_source_invalid', `invoice due terms are corrupt: ${detail}`);
    if (row.due_status === null || row.due_status === undefined) {
        if (row.due_at !== null && row.due_at !== undefined) throw corrupt('due_at without terms row');
        return { status: 'unresolved' };
    }
    if (row.due_status === 'unresolved') {
        if (
            (row.due_at !== null && row.due_at !== undefined)
            || (row.due_basis_ref !== null && row.due_basis_ref !== undefined)
            || (row.due_basis_version !== null && row.due_basis_version !== undefined)
        ) {
            throw corrupt('an unresolved row carries a due value');
        }
        return { status: 'unresolved' };
    }
    if (row.due_status !== 'resolved') throw corrupt('unknown due_status');
    if (
        row.due_at === null || row.due_at === undefined
        || row.due_basis_ref === null || row.due_basis_ref === undefined
        || row.due_basis_version === null || row.due_basis_version === undefined
    ) {
        throw corrupt('a resolved row misses a due value');
    }
    try {
        const dueAt = normalizeSqlBigInt(row.due_at, 'billing_invoice_obligations.due_at', {
            max: MAX_ACCOUNT_BALANCE_MINOR,
        });
        const basisVersion = normalizeSqlVersion(
            row.due_basis_version,
            'billing_invoice_obligations.due_basis_version',
        );
        const basisRef = requireBounded(row.due_basis_ref, 'billing_invoice_obligations.due_basis_ref', 128);
        if (basisVersion < 1) throw corrupt('due_basis_version must be at least 1');
        return { status: 'resolved', dueAt, basisRef, basisVersion };
    } catch (error) {
        if (error instanceof BillingSettlementSqlError) throw corrupt(error.message);
        if (error instanceof BillingLedgerSqlError) throw corrupt(error.message);
        throw error;
    }
};

const mapInvoiceDebt = (row: InvoiceDebtRowDb, tenantId: string): InvoiceDebtRecord => {
    if (row.tenant_id !== tenantId) {
        throw new BillingSettlementSqlError('invalid_row', 'an invoice row belongs to another tenant');
    }
    return {
        tenantId: requireBounded(row.tenant_id, 'billing_invoices.tenant_id', MAX_TENANT_ID_LENGTH),
        invoiceId: requireBounded(row.id, 'billing_invoices.id', MAX_INVOICE_ID_LENGTH),
        currency: requireCurrency(row.currency),
        totalMinor: requireNonNegativeMinor(row.total_minor, 'billing_invoices.total_minor'),
        due: mapInvoiceDue(row),
    };
};

const mapTarget = (row: TargetRowDb, tenantId: string): PlatformPaymentTarget => {
    if (row.tenant_id !== tenantId) {
        throw new BillingSettlementSqlError('invalid_row', 'a platform target row belongs to another tenant');
    }
    const purpose = requireBounded(row.purpose, 'checkout_order_platform_targets.purpose', MAX_PURPOSE_LENGTH);
    if (!PLATFORM_DIFFERENCE_PAYMENT_PURPOSES.has(purpose)) {
        throw new BillingSettlementSqlError('invalid_row', 'a platform target row carries a non-platform purpose');
    }
    return {
        tenantId: requireBounded(row.tenant_id, 'checkout_order_platform_targets.tenant_id', MAX_TENANT_ID_LENGTH),
        orderId: requireBounded(row.order_id, 'checkout_order_platform_targets.order_id', MAX_ORDER_ID_LENGTH),
        purpose,
        requestId: requireBounded(row.request_id, 'checkout_order_platform_targets.request_id', 36),
        invoiceId: requireBounded(row.invoice_id, 'checkout_order_platform_targets.invoice_id', MAX_INVOICE_ID_LENGTH),
        currency: requireCurrency(row.currency),
        amountMinor: requirePositiveMinor(row.amount_minor, 'checkout_order_platform_targets.amount_minor'),
    };
};

const mapInvoiceIssuance = (row: InvoiceIssuanceRowDb, tenantId: string): InvoiceIssuanceLink => {
    if (row.tenant_id !== tenantId) {
        throw new BillingSettlementSqlError('invalid_row', 'an invoice issuance link belongs to another tenant');
    }
    return {
        tenantId: requireBounded(row.tenant_id, 'billing_invoice_journals.tenant_id', MAX_TENANT_ID_LENGTH),
        invoiceId: requireBounded(row.invoice_id, 'billing_invoice_journals.invoice_id', MAX_INVOICE_ID_LENGTH),
        journalId: requireBounded(row.journal_id, 'billing_invoice_journals.journal_id', MAX_JOURNAL_ID_LENGTH),
    };
};

const mapAllocation = (row: AllocationRowDb, tenantId: string): PaymentAllocationRecord => {
    if (row.tenant_id !== tenantId) {
        throw new BillingSettlementSqlError('invalid_row', 'an allocation row belongs to another tenant');
    }
    const kind = requireAllocationKind(row.kind);
    const obligationId = optionalBounded(
        row.obligation_id,
        'billing_payment_allocations.obligation_id',
        MAX_OBLIGATION_ID_LENGTH,
    );
    if (kind === 'payment' && obligationId === null) {
        throw new BillingSettlementSqlError('invalid_row', 'a payment allocation has no obligation id');
    }
    const reversesAllocationId = optionalBounded(
        row.reverses_allocation_id,
        'billing_payment_allocations.reverses_allocation_id',
        MAX_ALLOCATION_ID_LENGTH,
    );
    if ((kind === 'reversal') !== (reversesAllocationId !== null)) {
        throw new BillingSettlementSqlError(
            'invalid_row',
            'only a reversal allocation carries reverses_allocation_id, and every reversal must carry it',
        );
    }
    return {
        reversesAllocationId,
        allocationId: requireBounded(
            row.allocation_id,
            'billing_payment_allocations.allocation_id',
            MAX_ALLOCATION_ID_LENGTH,
        ),
        tenantId: requireBounded(row.tenant_id, 'billing_payment_allocations.tenant_id', MAX_TENANT_ID_LENGTH),
        invoiceId: requireBounded(row.invoice_id, 'billing_payment_allocations.invoice_id', MAX_INVOICE_ID_LENGTH),
        obligationId,
        paymentReference: requireBounded(
            row.payment_reference,
            'billing_payment_allocations.payment_reference',
            MAX_REFERENCE_LENGTH,
        ),
        amountMinor: requirePositiveMinor(row.amount_minor, 'billing_payment_allocations.amount_minor'),
        currency: requireCurrency(row.currency),
        kind,
        journalId: requireBounded(row.journal_id, 'billing_payment_allocations.journal_id', MAX_JOURNAL_ID_LENGTH),
        createdAt: toIso(row.created_at, 'billing_payment_allocations.created_at'),
    };
};

/** Exact unique keys from migration 20261023_01 (MySQL reports `PRIMARY`). */
const ALLOCATION_DUP_KEYS: ReadonlySet<string> = new Set([
    'PRIMARY',
    'uq_billing_allocation_id_tenant',
    'uq_billing_allocation_payment_invoice',
    // 20261023_03: one reversal row per reversed allocation.
    'uq_billing_allocation_reverses',
]);

/** Mutating the debt-bearing invoice mapping must never leak a half-built record. */
const mapInvoiceDebtGuarded = (row: InvoiceDebtRowDb, tenantId: string): InvoiceDebtRecord => {
    try {
        return mapInvoiceDebt(row, tenantId);
    } catch (error) {
        if (error instanceof BillingLedgerSqlError) {
            throw new BillingSettlementSqlError(
                'debt_source_invalid',
                `an invoice debt row has a corrupt value: ${error.message}`,
            );
        }
        if (error instanceof BillingSettlementSqlError && error.code === 'invalid_row') {
            throw new BillingSettlementSqlError(
                'debt_source_invalid',
                `an invoice debt row is corrupt: ${error.message}`,
            );
        }
        throw error;
    }
};

class BillingSettlementSqlTransactionImpl implements SettlementTransaction, PlatformAllocationReader {
    private readonly ledger: ReservationTransaction;

    constructor(
        private readonly conn: SettlementSqlConnection,
        private readonly audit: SettlementSqlAuditSink,
        runner: SettlementSqlTransactionRunner,
    ) {
        this.ledger = createBoundBillingLedgerSqlTransaction(conn, { transaction: runner });
    }

    async writeAudit(record: SettlementAuditRecord): Promise<void> {
        await this.audit(this.conn, record);
    }

    getAccount(tenantId: string, accountId: string): Promise<LedgerAccount | null> {
        return this.ledger.getAccount(tenantId, accountId);
    }

    findJournalByIdempotencyKey(tenantId: string, idempotencyKey: string): Promise<JournalRecord | null> {
        return this.ledger.findJournalByIdempotencyKey(tenantId, idempotencyKey);
    }

    getJournal(tenantId: string, journalId: string): Promise<JournalRecord | null> {
        return this.ledger.getJournal(tenantId, journalId);
    }

    findReversalOf(tenantId: string, journalId: string): Promise<JournalRecord | null> {
        return this.ledger.findReversalOf(tenantId, journalId);
    }

    insertJournal(input: InsertJournalInput) {
        return this.ledger.insertJournal(input);
    }

    async provisionAccountIdempotent(
        tenantId: string,
        kind: AccountKind,
        currency: string,
    ): Promise<LedgerAccount> {
        const provision = this.ledger.provisionAccountIdempotent;
        if (typeof provision !== 'function') {
            throw new LedgerError('invalid_input', 'the ledger adapter does not support account provisioning');
        }
        return provision.call(this.ledger, tenantId, kind, currency);
    }

    findReservationJournalLink(
        tenantId: string,
        journalId: string,
    ): Promise<ReservationJournalLink | null> {
        const lookup = this.ledger.findReservationJournalLink;
        if (typeof lookup !== 'function') return Promise.resolve(null);
        return lookup.call(this.ledger, tenantId, journalId);
    }

    async findObligationForUpdate(
        tenantId: string,
        obligationId: string,
    ): Promise<SettlementObligationRecord | null> {
        const tenant = requireBounded(tenantId, 'tenantId', MAX_TENANT_ID_LENGTH);
        const id = requireBounded(obligationId, 'obligationId', MAX_OBLIGATION_ID_LENGTH);
        const obligation = await this.selectObligation(tenant, id, ' FOR UPDATE');
        if (obligation !== null) await this.assertProviderEventTenant(obligation);
        return obligation;
    }

    /** Plain (non-locking) read: used only to learn immutable ids before the locks are taken. */
    async findObligationForRead(
        tenantId: string,
        obligationId: string,
    ): Promise<SettlementObligationRecord | null> {
        const tenant = requireBounded(tenantId, 'tenantId', MAX_TENANT_ID_LENGTH);
        const id = requireBounded(obligationId, 'obligationId', MAX_OBLIGATION_ID_LENGTH);
        return this.selectObligation(tenant, id, '');
    }

    /** G4 proof read (`FOR SHARE`); the provider-event tenant invariant is re-checked. */
    async findObligationForShare(
        tenantId: string,
        obligationId: string,
    ): Promise<SettlementObligationRecord | null> {
        const tenant = requireBounded(tenantId, 'tenantId', MAX_TENANT_ID_LENGTH);
        const id = requireBounded(obligationId, 'obligationId', MAX_OBLIGATION_ID_LENGTH);
        const obligation = await this.selectObligation(tenant, id, ' FOR SHARE');
        if (obligation !== null) await this.assertProviderEventTenant(obligation);
        return obligation;
    }

    /**
     * The provider-event PK `(provider, provider_event_id)` is global by design
     * (migration 03), so the obligation FK alone does NOT prove that the event
     * belongs to the obligation tenant. Migration 20261023_01 §16.11 makes that
     * equality an adapter invariant; an append-only event row is read here
     * without a lock (the event is immutable), before the order lock.
     */
    private async assertProviderEventTenant(obligation: SettlementObligationRecord): Promise<void> {
        const rows = await this.conn.query<{ tenant_id: string }>(
            `SELECT tenant_id
               FROM checkout_provider_events
              WHERE provider = ? AND provider_event_id = ?
              LIMIT 1`,
            [obligation.provider, obligation.providerEventId],
        );
        const row = rows[0];
        if (row === undefined) {
            throw new BillingSettlementSqlError(
                'invalid_row',
                'the obligation provider event row does not exist despite its foreign key',
            );
        }
        if (row.tenant_id !== obligation.tenantId) {
            throw new BillingSettlementSqlError(
                'invalid_row',
                'the obligation provider event belongs to another tenant',
            );
        }
    }

    private async selectObligation(
        tenantId: string,
        obligationId: string,
        lockSuffix: string,
    ): Promise<SettlementObligationRecord | null> {
        let rows: ObligationRowDb[];
        try {
            rows = await this.conn.query<ObligationRowDb>(
                `SELECT ${OBLIGATION_COLUMNS}
                   FROM financial_settlement_obligations
                  WHERE tenant_id = ? AND id = ?
                  LIMIT 1${lockSuffix}`,
                [tenantId, obligationId],
            );
        } catch (error) {
            return translateStatementError(error, 'the settlement obligation source');
        }
        const row = rows[0];
        return row === undefined ? null : mapObligation(row, tenantId);
    }

    /**
     * Immutable platform target binding of one order. `FOR SHARE` (G6) unless
     * `'none'` is passed (plain read, ids only). The lock clause follows LIMIT.
     */
    async findPlatformTargetByOrder(
        tenantId: string,
        orderId: string,
        lock: PlatformReadLock = 'share',
    ): Promise<PlatformPaymentTarget | null> {
        return this.selectPlatformTarget(tenantId, orderId, lock === 'share' ? ' FOR SHARE' : '');
    }

    private async selectPlatformTarget(
        tenantId: string,
        orderId: string,
        lockSuffix: string,
    ): Promise<PlatformPaymentTarget | null> {
        const tenant = requireBounded(tenantId, 'tenantId', MAX_TENANT_ID_LENGTH);
        const order = requireBounded(orderId, 'orderId', MAX_ORDER_ID_LENGTH);
        let rows: TargetRowDb[];
        try {
            rows = await this.conn.query<TargetRowDb>(
                `SELECT ${TARGET_COLUMNS}
                   FROM checkout_order_platform_targets
                  WHERE tenant_id = ? AND order_id = ?
                  LIMIT 1${lockSuffix}`,
                [tenant, order],
            );
        } catch (error) {
            return translateStatementError(error, 'the platform target source');
        }
        const row = rows[0];
        if (row === undefined) return null;
        const target = mapTarget(row, tenant);
        if (target.orderId !== order) {
            throw new BillingSettlementSqlError('invalid_row', 'the platform target read back with a different order');
        }
        return target;
    }

    /**
     * Every allocation row of one obligation (all kinds, any invoice), ascending
     * `allocation_id`, bounded. `FOR SHARE` unless `'none'`; the lock clause
     * follows ORDER BY and LIMIT; bind order is tenant, obligation, limit.
     */
    async listPlatformAllocationRows(
        tenantId: string,
        obligationId: string,
        lock: PlatformReadLock = 'share',
    ): Promise<readonly PaymentAllocationRecord[]> {
        return this.selectPlatformAllocationRows(tenantId, obligationId, lock === 'share' ? ' FOR SHARE' : '');
    }

    private async selectPlatformAllocationRows(
        tenantId: string,
        obligationId: string,
        lockSuffix: string,
    ): Promise<readonly PaymentAllocationRecord[]> {
        const tenant = requireBounded(tenantId, 'tenantId', MAX_TENANT_ID_LENGTH);
        const id = requireBounded(obligationId, 'obligationId', MAX_OBLIGATION_ID_LENGTH);
        let rows: AllocationRowDb[];
        try {
            rows = await this.conn.query<AllocationRowDb>(
                `SELECT ${ALLOCATION_COLUMNS}
                   FROM billing_payment_allocations
                  WHERE tenant_id = ? AND obligation_id = ?
                  ORDER BY allocation_id ASC
                  LIMIT ?${lockSuffix}`,
                [tenant, id, MAX_PLATFORM_ALLOCATION_ROWS + 1],
            );
        } catch (error) {
            return translateStatementError(error, 'the platform allocation source');
        }
        if (rows.length > MAX_PLATFORM_ALLOCATION_ROWS) {
            throw new BillingSettlementSqlError(
                'store_overrun',
                `an obligation carries more than ${MAX_PLATFORM_ALLOCATION_ROWS} allocation rows`,
            );
        }
        return rows.map((row) => mapAllocation(row, tenant));
    }

    /** Plain (non-locking) read of one allocation row by id (ids only, never a money decision). */
    async findAllocationById(
        tenantId: string,
        allocationId: string,
    ): Promise<PaymentAllocationRecord | null> {
        const tenant = requireBounded(tenantId, 'tenantId', MAX_TENANT_ID_LENGTH);
        const id = requireBounded(allocationId, 'allocationId', MAX_ALLOCATION_ID_LENGTH);
        const rows = await this.conn.query<AllocationRowDb>(
            `SELECT ${ALLOCATION_COLUMNS}
               FROM billing_payment_allocations
              WHERE tenant_id = ? AND allocation_id = ?
              LIMIT 1`,
            [tenant, id],
        );
        const row = rows[0];
        return row === undefined ? null : mapAllocation(row, tenant);
    }

    async findCheckoutOrderForUpdate(
        tenantId: string,
        orderId: string,
    ): Promise<CheckoutPaymentProof | null> {
        const tenant = requireBounded(tenantId, 'tenantId', MAX_TENANT_ID_LENGTH);
        const id = requireBounded(orderId, 'orderId', MAX_ORDER_ID_LENGTH);
        const rows = await this.conn.query<CheckoutOrderRowDb>(
            `SELECT tenant_id, order_id, purpose, amount_minor, currency, status,
                    confirmed_provider_event_id
               FROM checkout_orders
              WHERE tenant_id = ? AND order_id = ?
              LIMIT 1
              FOR UPDATE`,
            [tenant, id],
        );
        const row = rows[0];
        return row === undefined ? null : mapCheckoutOrder(row, tenant);
    }

    async findAccountByKind(
        tenantId: string,
        kind: AccountKind,
        currency: string,
    ): Promise<LedgerAccount | null> {
        const tenant = requireBounded(tenantId, 'tenantId', MAX_TENANT_ID_LENGTH);
        const accountKind = requireAccountKind(kind);
        const code = requireCurrency(currency);
        const rows = await this.conn.query<AccountRowDb>(
            `SELECT id, tenant_id, kind, normal_side, currency, balance_minor, version
               FROM billing_accounts
              WHERE tenant_id = ? AND kind = ? AND currency = ?
              LIMIT 1`,
            [tenant, accountKind, code],
        );
        const row = rows[0];
        if (row === undefined) return null;
        const account = mapAccount(row, tenant);
        if (account.kind !== accountKind || account.currency !== code) {
            throw new BillingSettlementSqlError('invalid_row', 'the account read back with a different identity');
        }
        return account;
    }

    async markObligationAwaitingAllocation(
        input: MarkObligationAwaitingInput,
    ): Promise<ObligationCasResult> {
        const tenant = requireBounded(input.tenantId, 'tenantId', MAX_TENANT_ID_LENGTH);
        const id = requireBounded(input.obligationId, 'obligationId', MAX_OBLIGATION_ID_LENGTH);
        const expectedVersion = normalizeSqlVersion(input.expectedVersion, 'obligation expectedVersion');
        const fee = optionalMinor(input.feeMinor, 'obligation.feeMinor');
        const tax = optionalMinor(input.taxMinor, 'obligation.taxMinor');
        const net = optionalMinor(input.netMinor, 'obligation.netMinor');
        const receipt = optionalBounded(
            input.providerReceiptReference,
            'obligation.providerReceiptReference',
            MAX_PROVIDER_REFERENCE_LENGTH,
        );

        const result = await this.conn.execute(
            `UPDATE financial_settlement_obligations
                SET status = 'awaiting_allocation', fee_minor = ?, tax_minor = ?,
                    net_minor = ?, provider_receipt_reference = ?,
                    version = version + 1
              WHERE id = ? AND tenant_id = ? AND version = ?
                AND status IN ('pending', 'awaiting_allocation')`,
            [fee, tax, net, receipt, id, tenant, expectedVersion],
        );
        return this.classifyObligationCas(tenant, id, expectedVersion, affectedRowsOf(result));
    }

    async completeObligationReceipt(
        input: CompleteObligationReceiptInput,
    ): Promise<ObligationCasResult> {
        const tenant = requireBounded(input.tenantId, 'tenantId', MAX_TENANT_ID_LENGTH);
        const id = requireBounded(input.obligationId, 'obligationId', MAX_OBLIGATION_ID_LENGTH);
        const expectedVersion = normalizeSqlVersion(input.expectedVersion, 'obligation expectedVersion');
        const fee = optionalMinor(input.feeMinor, 'obligation.feeMinor');
        const tax = optionalMinor(input.taxMinor, 'obligation.taxMinor');
        const net = optionalMinor(input.netMinor, 'obligation.netMinor');
        const receipt = optionalBounded(
            input.providerReceiptReference,
            'obligation.providerReceiptReference',
            MAX_PROVIDER_REFERENCE_LENGTH,
        );
        const journalId = requireBounded(input.journalId, 'obligation.journalId', MAX_JOURNAL_ID_LENGTH);

        const result = await this.conn.execute(
            `UPDATE financial_settlement_obligations
                SET status = 'completed', fee_minor = ?, tax_minor = ?, net_minor = ?,
                    provider_receipt_reference = ?, journal_id = ?,
                    version = version + 1
              WHERE id = ? AND tenant_id = ? AND version = ?
                AND status IN ('pending', 'awaiting_allocation')`,
            [fee, tax, net, receipt, journalId, id, tenant, expectedVersion],
        );
        return this.classifyObligationCas(tenant, id, expectedVersion, affectedRowsOf(result));
    }

    async recordObligationSettlement(
        input: RecordObligationSettlementInput,
    ): Promise<ObligationCasResult> {
        const tenant = requireBounded(input.tenantId, 'tenantId', MAX_TENANT_ID_LENGTH);
        const id = requireBounded(input.obligationId, 'obligationId', MAX_OBLIGATION_ID_LENGTH);
        const expectedVersion = normalizeSqlVersion(input.expectedVersion, 'obligation expectedVersion');
        const reference = requireBounded(
            input.settlementReference,
            'obligation.settlementReference',
            MAX_REFERENCE_LENGTH,
        );

        const result = await this.conn.execute(
            `UPDATE financial_settlement_obligations
                SET provider_settlement_reference = ?, reconciliation_status = 'reconciled',
                    version = version + 1
              WHERE id = ? AND tenant_id = ? AND version = ?
                AND status = 'completed' AND provider_settlement_reference IS NULL`,
            [reference, id, tenant, expectedVersion],
        );
        return this.classifyObligationCas(tenant, id, expectedVersion, affectedRowsOf(result));
    }

    /**
     * Platform receipt posted: status awaiting_allocation with the proved fee/tax/
     * allocatable amounts and the receipt journal id. net_minor and journal_id stay
     * NULL (the merchant columns are never used). CAS on id + tenant + version +
     * status, and the platform columns must still be NULL.
     */
    async recordPlatformReceipt(input: RecordPlatformReceiptInput): Promise<ObligationCasResult> {
        const tenant = requireBounded(input.tenantId, 'tenantId', MAX_TENANT_ID_LENGTH);
        const id = requireBounded(input.obligationId, 'obligationId', MAX_OBLIGATION_ID_LENGTH);
        const expectedVersion = normalizeSqlVersion(input.expectedVersion, 'obligation expectedVersion');
        const fee = requireNonNegativeMinor(input.feeMinor, 'obligation.feeMinor');
        const tax = requireNonNegativeMinor(input.taxMinor, 'obligation.taxMinor');
        const allocatable = requirePositiveMinor(input.allocatableMinor, 'obligation.allocatableMinor');
        const receiptJournalId = requireBounded(
            input.platformReceiptJournalId,
            'obligation.platformReceiptJournalId',
            MAX_JOURNAL_ID_LENGTH,
        );
        const receipt = optionalBounded(
            input.providerReceiptReference,
            'obligation.providerReceiptReference',
            MAX_PROVIDER_REFERENCE_LENGTH,
        );

        const result = await this.executeCas(
            `UPDATE financial_settlement_obligations
                SET status = 'awaiting_allocation', fee_minor = ?, tax_minor = ?,
                    net_minor = NULL, allocatable_minor = ?, platform_receipt_journal_id = ?,
                    provider_receipt_reference = ?, version = version + 1
              WHERE id = ? AND tenant_id = ? AND version = ?
                AND status IN ('pending', 'awaiting_allocation')
                AND journal_id IS NULL AND allocatable_minor IS NULL
                AND platform_receipt_journal_id IS NULL`,
            [
                fee.toString(),
                tax.toString(),
                allocatable.toString(),
                receiptJournalId,
                receipt,
                id,
                tenant,
                expectedVersion,
            ],
            'uq_settlement_obligation_platform_receipt',
        );
        return this.classifyObligationCas(tenant, id, expectedVersion, affectedRowsOf(result));
    }

    /** awaiting_allocation -> allocated; legal only with the proved platform columns present. */
    async markObligationAllocated(input: MarkObligationAllocatedInput): Promise<ObligationCasResult> {
        const tenant = requireBounded(input.tenantId, 'tenantId', MAX_TENANT_ID_LENGTH);
        const id = requireBounded(input.obligationId, 'obligationId', MAX_OBLIGATION_ID_LENGTH);
        const expectedVersion = normalizeSqlVersion(input.expectedVersion, 'obligation expectedVersion');

        const result = await this.executeCas(
            `UPDATE financial_settlement_obligations
                SET status = 'allocated', version = version + 1
              WHERE id = ? AND tenant_id = ? AND version = ?
                AND status IN ('awaiting_allocation')
                AND journal_id IS NULL AND net_minor IS NULL
                AND allocatable_minor IS NOT NULL
                AND platform_receipt_journal_id IS NOT NULL`,
            [id, tenant, expectedVersion],
            null,
        );
        return this.classifyObligationCas(tenant, id, expectedVersion, affectedRowsOf(result));
    }

    /**
     * Flag an over-funded / reversed platform obligation as a reconciliation case.
     * Only `'discrepancy'` exists; the status is never rewritten.
     */
    async flagObligationReconciliation(
        input: FlagObligationReconciliationInput,
    ): Promise<ObligationCasResult> {
        const tenant = requireBounded(input.tenantId, 'tenantId', MAX_TENANT_ID_LENGTH);
        const id = requireBounded(input.obligationId, 'obligationId', MAX_OBLIGATION_ID_LENGTH);
        const expectedVersion = normalizeSqlVersion(input.expectedVersion, 'obligation expectedVersion');
        if (input.to !== 'discrepancy') {
            throw new BillingSettlementSqlError('invalid_row', 'only the discrepancy reconciliation flag is supported');
        }

        const result = await this.executeCas(
            `UPDATE financial_settlement_obligations
                SET reconciliation_status = 'discrepancy', version = version + 1
              WHERE id = ? AND tenant_id = ? AND version = ?
                AND status IN ('awaiting_allocation', 'allocated')
                AND allocatable_minor IS NOT NULL`,
            [id, tenant, expectedVersion],
            null,
        );
        return this.classifyObligationCas(tenant, id, expectedVersion, affectedRowsOf(result));
    }

    /**
     * One CAS UPDATE with typed error translation. A duplicate on `duplicateKey`
     * (by constraint name) is a corrupt-state duplicate, never a silent success.
     */
    private async executeCas(
        sql: string,
        params: readonly unknown[],
        duplicateKey: string | null,
    ): Promise<{ affectedRows?: number | string }> {
        try {
            return await this.conn.execute(sql, params);
        } catch (error) {
            if (duplicateKey !== null && duplicateKeyNameOf(error) === duplicateKey) {
                throw new BillingSettlementSqlError(
                    'duplicate_key',
                    `the obligation update violated ${duplicateKey}: the journal is already bound to another obligation`,
                );
            }
            return translateStatementError(error, 'the settlement obligation source');
        }
    }

    private async classifyObligationCas(
        tenantId: string,
        obligationId: string,
        expectedVersion: number,
        affected: number,
    ): Promise<ObligationCasResult> {
        if (affected === 1) {
            const obligation = await this.selectObligation(tenantId, obligationId, '');
            if (obligation === null) {
                throw new BillingSettlementSqlError(
                    'invalid_row',
                    'an updated obligation disappeared inside the transaction',
                );
            }
            return { ok: true, obligation };
        }
        if (affected !== 0) {
            throw new BillingSettlementSqlError(
                'store_overrun',
                `the obligation CAS UPDATE reported ${affected} affected rows where at most one was possible`,
            );
        }
        const current = await this.selectObligation(tenantId, obligationId, '');
        if (current === null) return { ok: false, reason: 'not_found' };
        if (current.version !== expectedVersion) return { ok: false, reason: 'version_conflict' };
        return { ok: false, reason: 'status_conflict' };
    }

    async findInvoiceForDebtUpdate(
        tenantId: string,
        invoiceId: string,
    ): Promise<InvoiceDebtRecord | null> {
        return this.selectInvoiceForDebt(tenantId, invoiceId, ' FOR UPDATE');
    }

    private async selectInvoiceForDebt(
        tenantId: string,
        invoiceId: string,
        lockSuffix: string,
    ): Promise<InvoiceDebtRecord | null> {
        const tenant = requireBounded(tenantId, 'tenantId', MAX_TENANT_ID_LENGTH);
        const id = requireBounded(invoiceId, 'invoiceId', MAX_INVOICE_ID_LENGTH);
        let rows: InvoiceDebtRowDb[];
        try {
            rows = await this.conn.query<InvoiceDebtRowDb>(
                `${INVOICE_DEBT_SELECT}
                  WHERE i.tenant_id = ? AND i.id = ?
                  LIMIT 1${lockSuffix}`,
                [tenant, id],
            );
        } catch (error) {
            const lockError = mapDebtLockError(error);
            if (lockError !== null) throw lockError;
            if (isMissingDebtSourceError(error)) {
                throw debtSourceUnavailable('the invoice debt source is unavailable (missing table or lock refused)');
            }
            throw error;
        }
        const row = rows[0];
        return row === undefined ? null : mapInvoiceDebtGuarded(row, tenant);
    }

    /**
     * NON-LOCKING debt reader for display only (admin read model). It uses plain
     * consistent reads, so it is valid inside START TRANSACTION READ ONLY (no
     * error 1792) and takes no lock on tenant invoices/allocations. The result
     * is a snapshot and MUST NEVER gate money (payout gate, collection and
     * allocation use the locking reader of this transaction).
     */
    asSnapshotDebtReader(): InvoiceDebtReader {
        return {
            findInvoiceForDebtUpdate: (tenantId, invoiceId) => this.selectInvoiceForDebt(tenantId, invoiceId, ''),
            findInvoiceIssuance: (tenantId, invoiceId) => this.findInvoiceIssuance(tenantId, invoiceId),
            readInvoiceAllocationTotal: (tenantId, invoiceId, currency) =>
                this.selectInvoiceAllocationTotal(tenantId, invoiceId, currency, ''),
            listInvoicesForDebt: (tenantId, limit) => this.selectInvoicesForDebt(tenantId, limit, ''),
        };
    }

    /**
     * NON-LOCKING platform proof reader for display/reconciliation only (plain
     * consistent reads, valid in a READ ONLY transaction). Never gates money.
     */
    asSnapshotPlatformReader(): PlatformAllocationReader {
        return {
            findObligationForShare: (tenantId, obligationId) => this.findObligationForRead(tenantId, obligationId),
            findPlatformTargetByOrder: (tenantId, orderId) => this.selectPlatformTarget(tenantId, orderId, ''),
            listPlatformAllocationRows: (tenantId, obligationId) =>
                this.selectPlatformAllocationRows(tenantId, obligationId, ''),
            getJournal: (tenantId, journalId) => this.getJournal(tenantId, journalId),
        };
    }

    async findInvoiceIssuance(
        tenantId: string,
        invoiceId: string,
    ): Promise<InvoiceIssuanceLink | null> {
        const tenant = requireBounded(tenantId, 'tenantId', MAX_TENANT_ID_LENGTH);
        const id = requireBounded(invoiceId, 'invoiceId', MAX_INVOICE_ID_LENGTH);
        const rows = await this.conn.query<InvoiceIssuanceRowDb>(
            `SELECT invoice_id, tenant_id, journal_id
               FROM billing_invoice_journals
              WHERE tenant_id = ? AND invoice_id = ?
              LIMIT 1`,
            [tenant, id],
        );
        const row = rows[0];
        return row === undefined ? null : mapInvoiceIssuance(row, tenant);
    }

    async readInvoiceAllocationTotal(
        tenantId: string,
        invoiceId: string,
        currency: string,
    ): Promise<AllocationTotalResult> {
        return this.selectInvoiceAllocationTotal(tenantId, invoiceId, currency, ' FOR UPDATE');
    }

    /**
     * Debt reduction = SUM(payment) + SUM(credit) - SUM(reversal). A reversal
     * restores debt. A negative net sum (or an unknown kind) is an inconsistent
     * source => `debt_source_unavailable`; it is never clamped to zero.
     */
    private async selectInvoiceAllocationTotal(
        tenantId: string,
        invoiceId: string,
        currency: string,
        lockSuffix: string,
    ): Promise<AllocationTotalResult> {
        const tenant = requireBounded(tenantId, 'tenantId', MAX_TENANT_ID_LENGTH);
        const id = requireBounded(invoiceId, 'invoiceId', MAX_INVOICE_ID_LENGTH);
        const code = requireCurrency(currency);
        let rows: Array<{ kind: unknown; amount_minor: unknown }>;
        try {
            rows = await this.conn.query<{ kind: unknown; amount_minor: unknown }>(
                `SELECT kind, amount_minor
                   FROM billing_payment_allocations
                  WHERE tenant_id = ? AND invoice_id = ? AND currency = ?
                  ORDER BY allocation_id ASC${lockSuffix}`,
                [tenant, id, code],
            );
        } catch (error) {
            const lockError = mapDebtLockError(error);
            if (lockError !== null) throw lockError;
            if (isMissingDebtSourceError(error)) {
                return { ok: false, reason: 'debt_source_unavailable' };
            }
            throw error;
        }
        let total = 0n;
        for (const row of rows) {
            let amount: bigint;
            try {
                amount = requirePositiveMinor(row.amount_minor, 'billing_payment_allocations.amount_minor');
            } catch (error) {
                if (
                    (error instanceof BillingSettlementSqlError && error.code === 'invalid_row')
                    || error instanceof BillingLedgerSqlError
                ) {
                    // Corrupt amount row (unparseable, negative, zero or over the bound):
                    // typed invalid source, no partial total.
                    throw new BillingSettlementSqlError(
                        'debt_source_invalid',
                        'a payment allocation row has a corrupt amount_minor; no debt total was produced',
                    );
                }
                throw error;
            }
            if (row.kind === 'payment' || row.kind === 'credit') {
                total += amount;
            } else if (row.kind === 'reversal') {
                total -= amount;
            } else {
                return { ok: false, reason: 'debt_source_unavailable' };
            }
        }
        if (total < 0n) return { ok: false, reason: 'debt_source_unavailable' };
        return { ok: true, totalMinor: total };
    }

    async listInvoicesForDebt(tenantId: string, limit: number): Promise<readonly InvoiceDebtRecord[]> {
        return this.selectInvoicesForDebt(tenantId, limit, ' FOR UPDATE');
    }

    private async selectInvoicesForDebt(
        tenantId: string,
        limit: number,
        lockSuffix: string,
    ): Promise<readonly InvoiceDebtRecord[]> {
        const tenant = requireBounded(tenantId, 'tenantId', MAX_TENANT_ID_LENGTH);
        const bounded = requireStoreLimit(limit);
        let rows: InvoiceDebtRowDb[];
        try {
            rows = await this.conn.query<InvoiceDebtRowDb>(
                `${INVOICE_DEBT_SELECT}
                  WHERE i.tenant_id = ?
                  ORDER BY i.id ASC
                  LIMIT ?${lockSuffix}`,
                [tenant, bounded],
            );
        } catch (error) {
            const lockError = mapDebtLockError(error);
            if (lockError !== null) throw lockError;
            if (isMissingDebtSourceError(error)) {
                throw debtSourceUnavailable('the invoice list debt source is unavailable (missing table or lock refused)');
            }
            throw error;
        }
        return rows.map((row) => mapInvoiceDebtGuarded(row, tenant));
    }

    async findAllocationByPaymentInvoice(
        tenantId: string,
        paymentReference: string,
        invoiceId: string,
        kind: AllocationKind,
    ): Promise<PaymentAllocationRecord | null> {
        return this.selectAllocationByPaymentInvoice(tenantId, paymentReference, invoiceId, kind, '');
    }

    async findAllocationByPaymentInvoiceForShare(
        tenantId: string,
        paymentReference: string,
        invoiceId: string,
        kind: AllocationKind,
    ): Promise<PaymentAllocationRecord | null> {
        return this.selectAllocationByPaymentInvoice(tenantId, paymentReference, invoiceId, kind, ' FOR SHARE');
    }

    private async selectAllocationByPaymentInvoice(
        tenantId: string,
        paymentReference: string,
        invoiceId: string,
        kind: AllocationKind,
        lockSuffix: string,
    ): Promise<PaymentAllocationRecord | null> {
        const tenant = requireBounded(tenantId, 'tenantId', MAX_TENANT_ID_LENGTH);
        const reference = requireBounded(paymentReference, 'paymentReference', MAX_REFERENCE_LENGTH);
        const invoice = requireBounded(invoiceId, 'invoiceId', MAX_INVOICE_ID_LENGTH);
        const allocationKind = requireAllocationKind(kind);
        const rows = await this.conn.query<AllocationRowDb>(
            `SELECT ${ALLOCATION_COLUMNS}
               FROM billing_payment_allocations
              WHERE tenant_id = ? AND payment_reference = ? AND invoice_id = ? AND kind = ?
              LIMIT 1${lockSuffix}`,
            [tenant, reference, invoice, allocationKind],
        );
        const row = rows[0];
        return row === undefined ? null : mapAllocation(row, tenant);
    }

    async findAllocationByObligation(
        tenantId: string,
        obligationId: string,
    ): Promise<PaymentAllocationRecord | null> {
        const tenant = requireBounded(tenantId, 'tenantId', MAX_TENANT_ID_LENGTH);
        const id = requireBounded(obligationId, 'obligationId', MAX_OBLIGATION_ID_LENGTH);
        const rows = await this.conn.query<AllocationRowDb>(
            `SELECT ${ALLOCATION_COLUMNS}
               FROM billing_payment_allocations
              WHERE tenant_id = ? AND obligation_id = ?
              ORDER BY allocation_id ASC
              LIMIT 1`,
            [tenant, id],
        );
        const row = rows[0];
        return row === undefined ? null : mapAllocation(row, tenant);
    }

    async insertPaymentAllocation(record: PaymentAllocationRecord): Promise<InsertAllocationResult> {
        const allocationId = requireBounded(
            record.allocationId,
            'allocation.allocationId',
            MAX_ALLOCATION_ID_LENGTH,
        );
        const tenant = requireBounded(record.tenantId, 'allocation.tenantId', MAX_TENANT_ID_LENGTH);
        const invoiceId = requireBounded(record.invoiceId, 'allocation.invoiceId', MAX_INVOICE_ID_LENGTH);
        const obligationId = optionalBounded(
            record.obligationId,
            'allocation.obligationId',
            MAX_OBLIGATION_ID_LENGTH,
        );
        const paymentReference = requireBounded(
            record.paymentReference,
            'allocation.paymentReference',
            MAX_REFERENCE_LENGTH,
        );
        const amount = requirePositiveMinor(record.amountMinor, 'allocation.amountMinor');
        const currency = requireCurrency(record.currency);
        const kind = requireAllocationKind(record.kind);
        if (kind === 'payment' && obligationId === null) {
            throw new BillingSettlementSqlError('invalid_row', 'a payment allocation requires an obligation id');
        }
        const reversesAllocationId = optionalBounded(
            record.reversesAllocationId,
            'allocation.reversesAllocationId',
            MAX_ALLOCATION_ID_LENGTH,
        );
        if ((kind === 'reversal') !== (reversesAllocationId !== null)) {
            throw new BillingSettlementSqlError(
                'invalid_row',
                'only a reversal allocation carries reversesAllocationId, and every reversal must carry it',
            );
        }
        const journalId = requireBounded(record.journalId, 'allocation.journalId', MAX_JOURNAL_ID_LENGTH);
        const createdAt = toIso(record.createdAt, 'allocation.createdAt');

        await this.conn.execute(`SAVEPOINT ${SETTLEMENT_ALLOCATION_INSERT_SAVEPOINT}`);
        try {
            await this.conn.execute(
                `INSERT INTO billing_payment_allocations
                    (allocation_id, tenant_id, invoice_id, obligation_id, payment_reference,
                     amount_minor, currency, kind, journal_id, reverses_allocation_id, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    allocationId,
                    tenant,
                    invoiceId,
                    obligationId,
                    paymentReference,
                    amount.toString(),
                    currency,
                    kind,
                    journalId,
                    reversesAllocationId,
                    createdAt,
                ],
            );
            await this.conn.execute(`RELEASE SAVEPOINT ${SETTLEMENT_ALLOCATION_INSERT_SAVEPOINT}`);
        } catch (error) {
            await this.rollbackToSavepoint(SETTLEMENT_ALLOCATION_INSERT_SAVEPOINT);
            if (isDuplicateError(error)) {
                const keyName = duplicateKeyNameOf(error);
                if (keyName === null || !ALLOCATION_DUP_KEYS.has(keyName)) {
                    throw new BillingSettlementSqlError(
                        'duplicate_key',
                        'allocation insert violated a unique key outside the allocation identity/payment keys',
                    );
                }
                return 'duplicate_key';
            }
            if (isForeignKeyError(error)) {
                throw new BillingSettlementSqlError(
                    'foreign_key_violation',
                    'allocation insert referenced a missing/foreign tenant, invoice, obligation or journal',
                );
            }
            throw error;
        }
        return 'inserted';
    }

    private async rollbackToSavepoint(name: string): Promise<void> {
        await this.conn.execute(`ROLLBACK TO SAVEPOINT ${name}`);
        await this.conn.execute(`RELEASE SAVEPOINT ${name}`);
    }
}

export interface BillingSettlementSqlStore extends SettlementStore<BillingSettlementSqlTransaction> {
    inTransaction(conn: SettlementSqlConnection): BillingSettlementSqlTransaction;
    runAtomic<T>(callback: (tx: BillingSettlementSqlTransaction) => Promise<T>): Promise<T>;
}

export type BillingSettlementSqlTransaction = BillingSettlementSqlTransactionImpl;

class BillingSettlementSqlStoreImpl implements BillingSettlementSqlStore {
    private readonly audit: SettlementSqlAuditSink;

    constructor(private readonly deps: BillingSettlementSqlDeps) {
        if (!deps || typeof deps.transaction !== 'function') {
            throw new BillingSettlementSqlError(
                'invalid_runner',
                'BillingSettlementSqlStore requires a connection-bound transaction runner',
            );
        }
        if (typeof deps.audit !== 'function') {
            throw new BillingSettlementSqlError(
                'invalid_audit',
                'BillingSettlementSqlStore requires the sealed connection-bound audit writer',
            );
        }
        this.audit = deps.audit;
    }

    inTransaction(conn: SettlementSqlConnection): BillingSettlementSqlTransaction {
        return new BillingSettlementSqlTransactionImpl(conn, this.audit, this.deps.transaction);
    }

    runAtomic<T>(callback: (tx: BillingSettlementSqlTransaction) => Promise<T>): Promise<T> {
        return this.deps.transaction((conn) => callback(this.inTransaction(conn)));
    }
}

export const createBillingSettlementSqlStore = (
    deps: BillingSettlementSqlDeps,
): BillingSettlementSqlStore => new BillingSettlementSqlStoreImpl(deps);

export const createBoundBillingSettlementSqlTransaction = (
    conn: SettlementSqlConnection,
    deps: BillingSettlementSqlDeps,
): BillingSettlementSqlTransaction => new BillingSettlementSqlStoreImpl(deps).inTransaction(conn);
