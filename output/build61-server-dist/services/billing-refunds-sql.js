"use strict";
/**
 * FIN10 / X7 — real SQL adapter for `RefundStore` / `RefundTransaction` and
 * `DisputeStore` / `DisputeTransaction`.
 *
 * Implements the accepted contracts in `billing-refunds.ts`
 * (REFUND_STORE_SQL_CONTRACT, DISPUTE_STORE_SQL_CONTRACT). The canonical schema
 * is `20261022_04_payouts_refunds_disputes.sql`; this adapter uses that file's
 * exact keys:
 *   refund_requests      PK (tenant_id, refund_id)
 *                        UNIQUE uq_refund_requests_idem (tenant_id, idempotency_key)
 *   refund_transitions   PK (id)
 *                        UNIQUE uq_refund_transitions_idem (tenant_id, idempotency_key)
 *   dispute_cases        PK (tenant_id, dispute_id)
 *                        UNIQUE uq_dispute_cases_idem (tenant_id, idempotency_key)
 *   dispute_transitions  PK (id)
 *                        UNIQUE uq_dispute_transitions_idem (tenant_id, idempotency_key)
 *
 * DUPLICATE-KEY MAPPING: a duplicate on the idempotency unique key is the
 * documented replay signal (`duplicate_key`) and the domain re-reads the winning
 * row. A duplicate on the request PRIMARY KEY means the same entity id was
 * reused; when that row carries a DIFFERENT idempotency key it is a typed
 * `resource_conflict`, never `store_inconsistent`. The post-duplicate by-key
 * re-read is `FOR SHARE` (a locking current read) because a plain SELECT would
 * use the transaction's older REPEATABLE READ snapshot and miss a row committed
 * after that snapshot. The initial by-key lookup stays non-locking so it cannot
 * take a gap lock before the insert. Run refunds/disputes at READ COMMITTED
 * where possible; `sumRefundAmountsForOriginal` locks the matching refund rows
 * and needs an index on `(tenant_id, original_reference, currency, status)` to
 * avoid a broad scan (schema request recorded in CL-B).
 *
 * SOURCE CODE ONLY. Nothing here executes SQL or opens a connection. Every
 * statement of a unit of work is issued on the caller-injected transaction
 * connection; there is no pooled query and no autocommit fallback. A missing
 * runner or audit sink throws at construction, before any statement.
 *
 * HK1: the accepted domain contract puts idempotency on the domain tables
 * itself (`idempotency_key` + `payload_hash`); replay-vs-conflict comparison is
 * domain work in `billing-refunds.ts`.
 *
 * ORIGINAL PAYMENT: `findOriginalForUpdate` locks the neutral checkout order
 * row (`checkout_orders` from migration 03) by `(tenant_id, order_id)` and
 * copies its exact amount/currency. Only `status = 'paid'` orders whose opaque
 * `purpose` is in `MERCHANT_REFUNDABLE_PURPOSES` are returned. An existing but
 * unpaid/non-merchant order returns a typed `IneligibleOriginal`, never
 * `null` (not found), so the domain can distinguish ineligible from missing.
 * The allow-list contains exactly the Codex-defined merchant code
 * `student_tuition`; `subscription_difference` stays excluded and no alias is
 * accepted. Original-payment proof (R2/R8) additionally requires the paid
 * order's COMPLETED `financial_settlement_obligations` row (status completed
 * with journal_id and net_minor, same tenant/order/purpose/currency/amount) and
 * the order payer. The refundable base is the NET merchant liability
 * (`net_minor`); the domain subtracts the locking sum of prior refunds. A paid
 * order with no/incomplete obligation is `awaitingFunding`; an unreadable or
 * inconsistent proof is `unavailable`; neither is `null` (not found). The
 * obligation is locked before the order (settlement lock order).
 *
 * COLLATION EXACTNESS: `checkout_orders.order_id` inherits the table's
 * `utf8mb4_unicode_ci` (PAD SPACE, case-insensitive) collation, while
 * `refund_requests.original_reference` is `utf8mb4_0900_bin`. A plain
 * `order_id = ?` would resolve `ord-1`, `ORD-1` and `ord-1 ` to the SAME order
 * while the remainder sum only matched one spelling, which allowed two
 * full-amount refunds under differently typed references (over-refund). Both
 * the order lookup and every `original_reference` comparison in this adapter
 * therefore use `utf8mb4_0900_bin` (NO PAD) and the canonical `order_id` read
 * from the locked row, never the caller string. Aligning the column collation
 * itself is a schema matter (CONTRACT REQUEST in CL-B).
 *
 * LEDGER: `RefundTransaction extends ReservationTransaction`, so all
 * reservation/journal methods are delegated to the accepted ledger SQL adapter
 * on the SAME connection.
 *
 * MONEY (HK2): exact integer minor units; `normalizeSqlBigInt` /
 * `normalizeSqlVersion` are the single read normalizers. Required mysql2
 * options for the production binding: `supportBigNumbers: true`,
 * `bigNumberStrings: true`.
 *
 * DISPUTE: the financial consequence is recorded as HELD only (docs/19 lines
 * 84 and 105); this adapter never writes a ledger journal or moves money for a
 * dispute.
 *
 * AUDIT: `writeAudit` is the ONLY path and routes to the REQUIRED
 * constructor-injected connection-bound sealed sink.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.createBoundBillingDisputesSqlTransaction = exports.createBillingDisputesSqlStore = exports.createBoundBillingRefundsSqlTransaction = exports.createBillingRefundsSqlStore = exports.MERCHANT_REFUNDABLE_PURPOSES = exports.BillingRefundSqlError = exports.DISPUTE_TRANSITION_SAVEPOINT = exports.DISPUTE_INSERT_SAVEPOINT = exports.REFUND_TRANSITION_SAVEPOINT = exports.REFUND_INSERT_SAVEPOINT = exports.REFUND_SQL_ADAPTER_ID = void 0;
const billing_refunds_1 = require("./billing-refunds");
const billing_ledger_sql_1 = require("./billing-ledger-sql");
exports.REFUND_SQL_ADAPTER_ID = 'billing-refunds-sql:20261022_04';
exports.REFUND_INSERT_SAVEPOINT = 'refund_request_insert';
exports.REFUND_TRANSITION_SAVEPOINT = 'refund_transition_insert';
exports.DISPUTE_INSERT_SAVEPOINT = 'dispute_case_insert';
exports.DISPUTE_TRANSITION_SAVEPOINT = 'dispute_transition_insert';
class BillingRefundSqlError extends Error {
    constructor(code, message) {
        super(message);
        this.code = code;
        this.name = 'BillingRefundSqlError';
    }
}
exports.BillingRefundSqlError = BillingRefundSqlError;
/** A CAS outcome must come from an explicit driver count, never coercion. */
const requireCasAffectedRows = (raw) => {
    // Connection contracts also permit strict decimal-string driver counts.
    const value = typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : raw;
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
        throw new BillingRefundSqlError('invalid_row', 'CAS result has no readable non-negative integer affectedRows; transaction outcome cannot be classified');
    }
    return value;
};
const REFUND_COLUMNS = `refund_id, tenant_id, original_reference, original_amount_minor,
    amount_minor, currency, funding_source_kind, status, reservation_id, version,
    idempotency_key, payload_hash, requested_by, provider_reference,
    failure_reason, cancellation_reason, created_at, updated_at`;
const REFUND_TRANSITION_COLUMNS = `id, tenant_id, refund_id, action,
    idempotency_key, payload_hash, from_status, to_status, version_after,
    reservation_id, journal_id, actor_id, reason, created_at`;
const DISPUTE_COLUMNS = `dispute_id, tenant_id, reference, amount_minor, currency,
    status, version, idempotency_key, payload_hash, opened_by,
    financial_consequence, financial_consequence_basis, created_at, updated_at`;
const DISPUTE_TRANSITION_COLUMNS = `id, tenant_id, dispute_id, action,
    idempotency_key, payload_hash, from_status, to_status, version_after,
    actor_id, reason, created_at`;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;
const HEX_64_PATTERN = /^[0-9a-f]{64}$/;
const LIVE_REFUND_STATUSES = `'requested', 'funded', 'processing', 'completed'`;
/** Frozen by migration 04: `financial_consequence_basis VARCHAR(500)`. */
const MAX_FINANCIAL_CONSEQUENCE_BASIS_LENGTH = 500;
/** Exact unique keys from migration 04 (MySQL reports `PRIMARY` for PKs). */
const REFUND_REQUEST_DUP_KEYS = new Set(['PRIMARY', 'uq_refund_requests_idem']);
const REFUND_TRANSITION_DUP_KEYS = new Set(['PRIMARY', 'uq_refund_transitions_idem']);
const DISPUTE_DUP_KEYS = new Set(['PRIMARY', 'uq_dispute_cases_idem']);
const DISPUTE_TRANSITION_DUP_KEYS = new Set(['PRIMARY', 'uq_dispute_transitions_idem']);
/**
 * Only these checkout purposes represent a merchant payment that a merchant
 * refund may target. Codex defined exactly one merchant-refundable purpose code,
 * `student_tuition`; platform `subscription_difference` stays excluded and no
 * alias is accepted. Membership is necessary but NOT sufficient: the order must
 * also be `paid`, and the full original-payment proof (merchant-liability
 * journal/allocation, payer and remaining) still awaits the settlement contract.
 * PENDING EXTENSION: replace the checkout-order proxy with the canonical
 * settlement allocation once that contract exists.
 */
exports.MERCHANT_REFUNDABLE_PURPOSES = new Set(['student_tuition']);
const isDuplicateError = (error) => typeof error === 'object' && error !== null && error.code === 'ER_DUP_ENTRY';
const isForeignKeyError = (error) => {
    if (typeof error !== 'object' || error === null)
        return false;
    const code = error.code;
    return code === 'ER_NO_REFERENCED_ROW_2' || code === 'ER_ROW_IS_REFERENCED_2';
};
const errorTextOf = (error) => {
    if (typeof error !== 'object' || error === null)
        return '';
    const sqlMessage = error.sqlMessage;
    if (typeof sqlMessage === 'string')
        return sqlMessage;
    const message = error.message;
    return typeof message === 'string' ? message : '';
};
/** Mirrors the accepted billing-collection-sql duplicate-key extraction. */
const duplicateKeyNameOf = (error) => {
    const text = errorTextOf(error);
    const match = /for key\s+['"`]([^'"`]+)['"`]/i.exec(text)
        ?? /Duplicate entry\s+'[^']*'\s+for key\s+([A-Za-z0-9_.]+)/i.exec(text);
    if (match?.[1] === undefined)
        return null;
    const parts = match[1].split('.');
    return parts[parts.length - 1] ?? null;
};
const toIso = (value, field) => {
    const date = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(date.getTime())) {
        throw new BillingRefundSqlError('invalid_row', `${field} is not a parseable timestamp`);
    }
    return date.toISOString();
};
const requireTimestamp = (value, field) => {
    if (typeof value !== 'string' || value.trim() === '' || Number.isNaN(Date.parse(value))) {
        throw new BillingRefundSqlError('invalid_row', `${field} must be a parseable timestamp string`);
    }
    return value;
};
const requireBounded = (value, field, maxLength) => {
    if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) {
        throw new BillingRefundSqlError('invalid_row', `${field} must be a non-empty string of at most ${maxLength} characters`);
    }
    return value;
};
const requireNullableBounded = (value, field, maxLength) => {
    if (value === null)
        return null;
    return requireBounded(value, field, maxLength);
};
const requireCurrency = (value) => {
    if (typeof value !== 'string' || !CURRENCY_PATTERN.test(value)) {
        throw new BillingRefundSqlError('invalid_row', 'currency must be a three-letter uppercase ISO-4217 code');
    }
    return value;
};
const requireHex64 = (value, field) => {
    const text = requireBounded(value, field, 128);
    if (!HEX_64_PATTERN.test(text)) {
        throw new BillingRefundSqlError('invalid_row', `${field} must be a lowercase SHA-256 hex string`);
    }
    return text;
};
const requireRefundStatus = (value) => {
    if (typeof value !== 'string' || !billing_refunds_1.REFUND_STATUSES.includes(value)) {
        throw new BillingRefundSqlError('invalid_row', 'refund has an unknown status');
    }
    return value;
};
const requireRefundAction = (value) => {
    if (value !== 'request' && value !== 'fund' && value !== 'process' && value !== 'complete'
        && value !== 'fail' && value !== 'cancel') {
        throw new BillingRefundSqlError('invalid_row', 'refund transition has an unknown action');
    }
    return value;
};
const requireFundingSource = (value) => {
    if (typeof value !== 'string' || !billing_refunds_1.REFUND_FUNDING_SOURCES.includes(value)) {
        throw new BillingRefundSqlError('invalid_row', 'refund has an unknown funding source');
    }
    return value;
};
const requireDisputeStatus = (value) => {
    if (typeof value !== 'string' || !billing_refunds_1.DISPUTE_STATUSES.includes(value)) {
        throw new BillingRefundSqlError('invalid_row', 'dispute has an unknown status');
    }
    return value;
};
const requireDisputeAction = (value) => {
    if (value === 'open')
        return 'open';
    return requireDisputeStatus(value);
};
const requireRefundAmount = (value) => {
    const amount = (0, billing_ledger_sql_1.normalizeSqlBigInt)(value, 'refund amount_minor', { max: billing_refunds_1.MAX_REFUND_AMOUNT_MINOR });
    if (amount <= 0n) {
        throw new BillingRefundSqlError('invalid_row', 'refund amount_minor must be positive');
    }
    return amount;
};
const requireListLimit = (value) => {
    if (value === undefined)
        return billing_refunds_1.DEFAULT_LIST_LIMIT;
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > billing_refunds_1.MAX_LIST_LIMIT) {
        throw new BillingRefundSqlError('store_overrun', `limit must be an integer between 1 and ${billing_refunds_1.MAX_LIST_LIMIT}`);
    }
    return value;
};
const STUDENT_TUITION_PURPOSE = 'student_tuition';
const isMissingSourceError = (error) => {
    if (typeof error !== 'object' || error === null)
        return false;
    const code = error.code;
    const errno = error.errno;
    return code === 'ER_NO_SUCH_TABLE'
        || code === 'ER_BAD_FIELD_ERROR'
        || code === 'ER_UNKNOWN_TABLE'
        || errno === 1146
        || errno === 1054;
};
/** MySQL 1792: a locking read inside a READ ONLY transaction => unavailable form. */
const isReadOnlyTransactionError = (error) => {
    if (typeof error !== 'object' || error === null)
        return false;
    return error.code === 'ER_CANT_EXECUTE_IN_READ_ONLY_TRANSACTION'
        || error.errno === 1792;
};
/** Typed RETRYABLE lock failure (1213 / 1205), or null for any other error. */
const lockFailureOf = (error) => {
    if (typeof error !== 'object' || error === null)
        return null;
    const code = error.code;
    const errno = error.errno;
    if (code === 'ER_LOCK_DEADLOCK' || errno === 1213) {
        return new BillingRefundSqlError('lock_conflict', 'deadlock detected; the unit of work was rolled back and may be retried');
    }
    if (code === 'ER_LOCK_WAIT_TIMEOUT' || errno === 1205) {
        return new BillingRefundSqlError('lock_wait_timeout', 'lock wait timeout; the unit of work may be retried');
    }
    return null;
};
const refundOfRow = (row, tenantId) => {
    if (row.tenant_id !== tenantId) {
        throw new BillingRefundSqlError('invalid_row', 'a refund row belongs to another tenant');
    }
    return {
        refundId: requireBounded(row.refund_id, 'refund_requests.refund_id', billing_refunds_1.MAX_REFUND_ID_LENGTH),
        tenantId: requireBounded(row.tenant_id, 'refund_requests.tenant_id', billing_refunds_1.MAX_TENANT_LENGTH),
        originalReference: requireBounded(row.original_reference, 'refund_requests.original_reference', billing_refunds_1.MAX_ORIGINAL_REFERENCE_LENGTH),
        originalAmountMinor: requireRefundAmount(row.original_amount_minor),
        amountMinor: requireRefundAmount(row.amount_minor),
        currency: requireCurrency(row.currency),
        fundingSourceKind: requireFundingSource(row.funding_source_kind),
        status: requireRefundStatus(row.status),
        reservationId: requireNullableBounded(row.reservation_id, 'refund_requests.reservation_id', 64),
        version: (0, billing_ledger_sql_1.normalizeSqlVersion)(row.version, 'refund_requests.version'),
        idempotencyKey: requireBounded(row.idempotency_key, 'refund_requests.idempotency_key', billing_refunds_1.MAX_IDEMPOTENCY_KEY_LENGTH),
        payloadHash: requireHex64(row.payload_hash, 'refund_requests.payload_hash'),
        requestedBy: requireNullableBounded(row.requested_by, 'refund_requests.requested_by', billing_refunds_1.MAX_ACTOR_LENGTH),
        providerReference: requireNullableBounded(row.provider_reference, 'refund_requests.provider_reference', 128),
        failureReason: requireNullableBounded(row.failure_reason, 'refund_requests.failure_reason', billing_refunds_1.MAX_REASON_LENGTH),
        cancellationReason: requireNullableBounded(row.cancellation_reason, 'refund_requests.cancellation_reason', billing_refunds_1.MAX_REASON_LENGTH),
        createdAt: toIso(row.created_at, 'refund_requests.created_at'),
        updatedAt: toIso(row.updated_at, 'refund_requests.updated_at'),
    };
};
const refundTransitionOfRow = (row, tenantId) => {
    if (row.tenant_id !== tenantId) {
        throw new BillingRefundSqlError('invalid_row', 'a refund transition row belongs to another tenant');
    }
    return {
        id: requireBounded(row.id, 'refund_transitions.id', 64),
        tenantId: requireBounded(row.tenant_id, 'refund_transitions.tenant_id', billing_refunds_1.MAX_TENANT_LENGTH),
        refundId: requireBounded(row.refund_id, 'refund_transitions.refund_id', billing_refunds_1.MAX_REFUND_ID_LENGTH),
        action: requireRefundAction(row.action),
        idempotencyKey: requireBounded(row.idempotency_key, 'refund_transitions.idempotency_key', billing_refunds_1.MAX_IDEMPOTENCY_KEY_LENGTH),
        payloadHash: requireHex64(row.payload_hash, 'refund_transitions.payload_hash'),
        fromStatus: requireRefundStatus(row.from_status),
        toStatus: requireRefundStatus(row.to_status),
        versionAfter: (0, billing_ledger_sql_1.normalizeSqlVersion)(row.version_after, 'refund_transitions.version_after'),
        reservationId: requireNullableBounded(row.reservation_id, 'refund_transitions.reservation_id', 64),
        journalId: requireNullableBounded(row.journal_id, 'refund_transitions.journal_id', 64),
        actorId: requireNullableBounded(row.actor_id, 'refund_transitions.actor_id', billing_refunds_1.MAX_ACTOR_LENGTH),
        reason: requireNullableBounded(row.reason, 'refund_transitions.reason', billing_refunds_1.MAX_REASON_LENGTH),
        createdAt: toIso(row.created_at, 'refund_transitions.created_at'),
    };
};
const disputeOfRow = (row, tenantId) => {
    if (row.tenant_id !== tenantId) {
        throw new BillingRefundSqlError('invalid_row', 'a dispute row belongs to another tenant');
    }
    if (row.financial_consequence !== 'held') {
        throw new BillingRefundSqlError('invalid_row', 'a dispute row has an unsupported financial consequence');
    }
    return {
        disputeId: requireBounded(row.dispute_id, 'dispute_cases.dispute_id', billing_refunds_1.MAX_DISPUTE_ID_LENGTH),
        tenantId: requireBounded(row.tenant_id, 'dispute_cases.tenant_id', billing_refunds_1.MAX_TENANT_LENGTH),
        reference: requireBounded(row.reference, 'dispute_cases.reference', 128),
        amountMinor: requireRefundAmount(row.amount_minor),
        currency: requireCurrency(row.currency),
        status: requireDisputeStatus(row.status),
        version: (0, billing_ledger_sql_1.normalizeSqlVersion)(row.version, 'dispute_cases.version'),
        idempotencyKey: requireBounded(row.idempotency_key, 'dispute_cases.idempotency_key', billing_refunds_1.MAX_IDEMPOTENCY_KEY_LENGTH),
        payloadHash: requireHex64(row.payload_hash, 'dispute_cases.payload_hash'),
        openedBy: requireNullableBounded(row.opened_by, 'dispute_cases.opened_by', billing_refunds_1.MAX_ACTOR_LENGTH),
        financialConsequence: 'held',
        financialConsequenceBasis: requireBounded(row.financial_consequence_basis, 'dispute_cases.financial_consequence_basis', MAX_FINANCIAL_CONSEQUENCE_BASIS_LENGTH),
        createdAt: toIso(row.created_at, 'dispute_cases.created_at'),
        updatedAt: toIso(row.updated_at, 'dispute_cases.updated_at'),
    };
};
const disputeTransitionOfRow = (row, tenantId) => {
    if (row.tenant_id !== tenantId) {
        throw new BillingRefundSqlError('invalid_row', 'a dispute transition row belongs to another tenant');
    }
    return {
        id: requireBounded(row.id, 'dispute_transitions.id', 64),
        tenantId: requireBounded(row.tenant_id, 'dispute_transitions.tenant_id', billing_refunds_1.MAX_TENANT_LENGTH),
        disputeId: requireBounded(row.dispute_id, 'dispute_transitions.dispute_id', billing_refunds_1.MAX_DISPUTE_ID_LENGTH),
        action: requireDisputeAction(row.action),
        idempotencyKey: requireBounded(row.idempotency_key, 'dispute_transitions.idempotency_key', billing_refunds_1.MAX_IDEMPOTENCY_KEY_LENGTH),
        payloadHash: requireHex64(row.payload_hash, 'dispute_transitions.payload_hash'),
        fromStatus: row.from_status === null ? null : requireDisputeStatus(row.from_status),
        toStatus: requireDisputeStatus(row.to_status),
        versionAfter: (0, billing_ledger_sql_1.normalizeSqlVersion)(row.version_after, 'dispute_transitions.version_after'),
        actorId: requireNullableBounded(row.actor_id, 'dispute_transitions.actor_id', billing_refunds_1.MAX_ACTOR_LENGTH),
        reason: requireNullableBounded(row.reason, 'dispute_transitions.reason', billing_refunds_1.MAX_REASON_LENGTH),
        createdAt: toIso(row.created_at, 'dispute_transitions.created_at'),
    };
};
class BillingRefundsSqlTransactionImpl {
    constructor(conn, audit, runner) {
        this.conn = conn;
        this.audit = audit;
        /** Set only by a duplicate insert so the domain's by-key re-read is current. */
        this.refundDuplicatePending = false;
        this.ledger = (0, billing_ledger_sql_1.createBoundBillingLedgerSqlTransaction)(conn, { transaction: runner });
    }
    async writeAudit(record) {
        await this.audit(this.conn, record);
    }
    getAccount(tenantId, accountId) {
        return this.ledger.getAccount(tenantId, accountId);
    }
    findJournalByIdempotencyKey(tenantId, idempotencyKey) {
        return this.ledger.findJournalByIdempotencyKey(tenantId, idempotencyKey);
    }
    getJournal(tenantId, journalId) {
        return this.ledger.getJournal(tenantId, journalId);
    }
    findReversalOf(tenantId, journalId) {
        return this.ledger.findReversalOf(tenantId, journalId);
    }
    insertJournal(input) {
        return this.ledger.insertJournal(input);
    }
    /** Same reservation/journal guard authority as the wrapped ledger transaction. */
    findReservationJournalLink(tenantId, journalId) {
        const delegate = this.ledger.findReservationJournalLink;
        if (typeof delegate !== 'function') {
            throw new BillingRefundSqlError('invalid_row', 'the wrapped ledger transaction does not provide findReservationJournalLink');
        }
        return delegate.call(this.ledger, tenantId, journalId);
    }
    /** Same idempotent zero-balance provisioning as the wrapped ledger transaction. */
    provisionAccountIdempotent(tenantId, kind, currency) {
        const delegate = this.ledger.provisionAccountIdempotent;
        if (typeof delegate !== 'function') {
            throw new BillingRefundSqlError('invalid_row', 'the wrapped ledger transaction does not provide provisionAccountIdempotent');
        }
        return delegate.call(this.ledger, tenantId, kind, currency);
    }
    findReservationByKey(tenantId, reservationKey) {
        return this.ledger.findReservationByKey(tenantId, reservationKey);
    }
    getReservation(tenantId, reservationId) {
        return this.ledger.getReservation(tenantId, reservationId);
    }
    insertReservation(reservation) {
        return this.ledger.insertReservation(reservation);
    }
    updateReservation(input) {
        return this.ledger.updateReservation(input);
    }
    insertReservationEvent(event) {
        return this.ledger.insertReservationEvent(event);
    }
    async findByIdempotencyKey(tenantId, idempotencyKey) {
        const lockSuffix = this.refundDuplicatePending ? ' FOR SHARE' : '';
        this.refundDuplicatePending = false;
        return this.selectRefundByIdempotencyKey(tenantId, idempotencyKey, lockSuffix);
    }
    async selectRefundByIdempotencyKey(tenantId, idempotencyKey, lockSuffix) {
        const tenant = requireBounded(tenantId, 'tenantId', billing_refunds_1.MAX_TENANT_LENGTH);
        const key = requireBounded(idempotencyKey, 'idempotencyKey', billing_refunds_1.MAX_IDEMPOTENCY_KEY_LENGTH);
        const rows = await this.conn.query(`SELECT ${REFUND_COLUMNS}
               FROM refund_requests
              WHERE tenant_id = ? AND idempotency_key = ?
              LIMIT 1${lockSuffix}`, [tenant, key]);
        const row = rows[0];
        return row === undefined ? null : refundOfRow(row, tenant);
    }
    async findRefundForUpdate(tenantId, refundId) {
        return this.selectRefund(tenantId, refundId, ' FOR UPDATE');
    }
    /** Plain non-locking tenant-scoped read (no FOR UPDATE/SHARE, no writes, no audit). */
    async findRefundSnapshot(tenantId, refundId) {
        return this.selectRefund(tenantId, refundId, '');
    }
    async selectRefund(tenantId, refundId, lockSuffix) {
        const tenant = requireBounded(tenantId, 'tenantId', billing_refunds_1.MAX_TENANT_LENGTH);
        const id = requireBounded(refundId, 'refundId', billing_refunds_1.MAX_REFUND_ID_LENGTH);
        const rows = await this.conn.query(`SELECT ${REFUND_COLUMNS}
               FROM refund_requests
              WHERE tenant_id = ? AND refund_id = ?
              LIMIT 1${lockSuffix}`, [tenant, id]);
        const row = rows[0];
        return row === undefined ? null : refundOfRow(row, tenant);
    }
    async insertRefund(refund) {
        const refundId = requireBounded(refund.refundId, 'refund.refundId', billing_refunds_1.MAX_REFUND_ID_LENGTH);
        const tenant = requireBounded(refund.tenantId, 'refund.tenantId', billing_refunds_1.MAX_TENANT_LENGTH);
        const originalReference = requireBounded(refund.originalReference, 'refund.originalReference', billing_refunds_1.MAX_ORIGINAL_REFERENCE_LENGTH);
        const originalAmount = requireRefundAmount(refund.originalAmountMinor);
        const amount = requireRefundAmount(refund.amountMinor);
        const currency = requireCurrency(refund.currency);
        const fundingSource = requireFundingSource(refund.fundingSourceKind);
        const status = requireRefundStatus(refund.status);
        const reservationId = requireNullableBounded(refund.reservationId, 'refund.reservationId', 64);
        const version = (0, billing_ledger_sql_1.normalizeSqlVersion)(refund.version, 'refund.version');
        const idempotencyKey = requireBounded(refund.idempotencyKey, 'refund.idempotencyKey', billing_refunds_1.MAX_IDEMPOTENCY_KEY_LENGTH);
        const payloadHash = requireHex64(refund.payloadHash, 'refund.payloadHash');
        const requestedBy = requireNullableBounded(refund.requestedBy, 'refund.requestedBy', billing_refunds_1.MAX_ACTOR_LENGTH);
        const providerReference = requireNullableBounded(refund.providerReference, 'refund.providerReference', 128);
        const failureReason = requireNullableBounded(refund.failureReason, 'refund.failureReason', billing_refunds_1.MAX_REASON_LENGTH);
        const cancellationReason = requireNullableBounded(refund.cancellationReason, 'refund.cancellationReason', billing_refunds_1.MAX_REASON_LENGTH);
        const createdAt = requireTimestamp(refund.createdAt, 'refund.createdAt');
        const updatedAt = requireTimestamp(refund.updatedAt, 'refund.updatedAt');
        await this.conn.execute(`SAVEPOINT ${exports.REFUND_INSERT_SAVEPOINT}`);
        try {
            await this.conn.execute(`INSERT INTO refund_requests
                    (refund_id, tenant_id, original_reference, original_amount_minor,
                     amount_minor, currency, funding_source_kind, status,
                     reservation_id, version, idempotency_key, payload_hash,
                     requested_by, provider_reference, failure_reason,
                     cancellation_reason, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
                refundId,
                tenant,
                originalReference,
                originalAmount.toString(),
                amount.toString(),
                currency,
                fundingSource,
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
            ]);
            await this.conn.execute(`RELEASE SAVEPOINT ${exports.REFUND_INSERT_SAVEPOINT}`);
        }
        catch (error) {
            await this.rollbackToSavepoint(exports.REFUND_INSERT_SAVEPOINT);
            if (isDuplicateError(error)) {
                const keyName = duplicateKeyNameOf(error);
                if (keyName === null || !REFUND_REQUEST_DUP_KEYS.has(keyName))
                    throw error;
                if (keyName === 'PRIMARY') {
                    const existing = await this.selectRefund(tenant, refundId, ' FOR SHARE');
                    if (existing === null) {
                        throw new BillingRefundSqlError('store_inconsistent', 'a refund PRIMARY duplicate could not be re-read inside the transaction');
                    }
                    if (existing.idempotencyKey !== idempotencyKey) {
                        throw new BillingRefundSqlError('resource_conflict', 'refundId was reused with a different idempotency key');
                    }
                }
                this.refundDuplicatePending = true;
                return 'duplicate_key';
            }
            if (isForeignKeyError(error)) {
                throw new BillingRefundSqlError('foreign_key_violation', 'refund insert referenced a missing/foreign tenant or reservation');
            }
            throw error;
        }
        return 'inserted';
    }
    async updateStatusCas(input) {
        const tenant = requireBounded(input.tenantId, 'tenantId', billing_refunds_1.MAX_TENANT_LENGTH);
        const refundId = requireBounded(input.refundId, 'refundId', billing_refunds_1.MAX_REFUND_ID_LENGTH);
        const expectedVersion = (0, billing_ledger_sql_1.normalizeSqlVersion)(input.expectedVersion, 'refund expectedVersion');
        const fromStatus = requireRefundStatus(input.fromStatus);
        const toStatus = requireRefundStatus(input.toStatus);
        const reservationId = requireNullableBounded(input.reservationId, 'reservationId', 64);
        const providerReference = requireNullableBounded(input.providerReference, 'providerReference', 128);
        const failureReason = requireNullableBounded(input.failureReason, 'failureReason', billing_refunds_1.MAX_REASON_LENGTH);
        const cancellationReason = requireNullableBounded(input.cancellationReason, 'cancellationReason', billing_refunds_1.MAX_REASON_LENGTH);
        const updatedAt = requireTimestamp(input.updatedAt, 'updatedAt');
        const result = await this.conn.execute(`UPDATE refund_requests
                SET status = ?, reservation_id = ?, provider_reference = ?,
                    failure_reason = ?, cancellation_reason = ?, updated_at = ?,
                    version = version + 1
              WHERE tenant_id = ? AND refund_id = ? AND version = ? AND status = ?`, [
            toStatus,
            reservationId,
            providerReference,
            failureReason,
            cancellationReason,
            updatedAt,
            tenant,
            refundId,
            expectedVersion,
            fromStatus,
        ]);
        const affected = requireCasAffectedRows(result.affectedRows);
        if (affected === 1) {
            const updated = await this.selectRefund(tenant, refundId, '');
            if (updated === null) {
                throw new BillingRefundSqlError('invalid_row', 'an updated refund disappeared');
            }
            return { ok: true, refund: updated };
        }
        if (affected !== 0) {
            throw new BillingRefundSqlError('store_overrun', `the refund CAS UPDATE reported ${affected} affected rows where exactly one was possible`);
        }
        const current = await this.selectRefund(tenant, refundId, '');
        if (current === null)
            return { ok: false, reason: 'not_found' };
        if (current.version !== expectedVersion)
            return { ok: false, reason: 'version_conflict' };
        return { ok: false, reason: 'invalid_transition' };
    }
    async findTransitionByIdempotencyKey(tenantId, idempotencyKey) {
        const tenant = requireBounded(tenantId, 'tenantId', billing_refunds_1.MAX_TENANT_LENGTH);
        const key = requireBounded(idempotencyKey, 'idempotencyKey', billing_refunds_1.MAX_IDEMPOTENCY_KEY_LENGTH);
        const rows = await this.conn.query(`SELECT ${REFUND_TRANSITION_COLUMNS}
               FROM refund_transitions
              WHERE tenant_id = ? AND idempotency_key = ?
              LIMIT 1`, [tenant, key]);
        const row = rows[0];
        return row === undefined ? null : refundTransitionOfRow(row, tenant);
    }
    async selectRefundTransition(tenantId, id, lockSuffix) {
        const tenant = requireBounded(tenantId, 'tenantId', billing_refunds_1.MAX_TENANT_LENGTH);
        const transitionId = requireBounded(id, 'transition.id', 64);
        const rows = await this.conn.query(`SELECT ${REFUND_TRANSITION_COLUMNS}
               FROM refund_transitions
              WHERE tenant_id = ? AND id = ?
              LIMIT 1${lockSuffix}`, [tenant, transitionId]);
        const row = rows[0];
        return row === undefined ? null : refundTransitionOfRow(row, tenant);
    }
    async insertTransition(record) {
        const id = requireBounded(record.id, 'transition.id', 64);
        const tenant = requireBounded(record.tenantId, 'transition.tenantId', billing_refunds_1.MAX_TENANT_LENGTH);
        const refundId = requireBounded(record.refundId, 'transition.refundId', billing_refunds_1.MAX_REFUND_ID_LENGTH);
        const action = requireRefundAction(record.action);
        const idempotencyKey = requireBounded(record.idempotencyKey, 'transition.idempotencyKey', billing_refunds_1.MAX_IDEMPOTENCY_KEY_LENGTH);
        const payloadHash = requireHex64(record.payloadHash, 'transition.payloadHash');
        const fromStatus = requireRefundStatus(record.fromStatus);
        const toStatus = requireRefundStatus(record.toStatus);
        const versionAfter = (0, billing_ledger_sql_1.normalizeSqlVersion)(record.versionAfter, 'transition.versionAfter');
        const reservationId = requireNullableBounded(record.reservationId, 'transition.reservationId', 64);
        const journalId = requireNullableBounded(record.journalId, 'transition.journalId', 64);
        const actorId = requireNullableBounded(record.actorId, 'transition.actorId', billing_refunds_1.MAX_ACTOR_LENGTH);
        const reason = requireNullableBounded(record.reason, 'transition.reason', billing_refunds_1.MAX_REASON_LENGTH);
        const createdAt = requireTimestamp(record.createdAt, 'transition.createdAt');
        await this.conn.execute(`SAVEPOINT ${exports.REFUND_TRANSITION_SAVEPOINT}`);
        try {
            await this.conn.execute(`INSERT INTO refund_transitions
                    (id, tenant_id, refund_id, action, idempotency_key, payload_hash,
                     from_status, to_status, version_after, reservation_id, journal_id,
                     actor_id, reason, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
                id,
                tenant,
                refundId,
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
            ]);
            await this.conn.execute(`RELEASE SAVEPOINT ${exports.REFUND_TRANSITION_SAVEPOINT}`);
        }
        catch (error) {
            await this.rollbackToSavepoint(exports.REFUND_TRANSITION_SAVEPOINT);
            if (isDuplicateError(error)) {
                const keyName = duplicateKeyNameOf(error);
                if (keyName === null || !REFUND_TRANSITION_DUP_KEYS.has(keyName))
                    throw error;
                if (keyName === 'PRIMARY') {
                    const existing = await this.selectRefundTransition(tenant, id, ' FOR SHARE');
                    if (existing === null) {
                        throw new BillingRefundSqlError('store_inconsistent', 'a refund transition duplicate could not be re-read inside the transaction');
                    }
                    if (existing.idempotencyKey !== idempotencyKey) {
                        throw new BillingRefundSqlError('resource_conflict', 'refund transition id was reused with a different idempotency key');
                    }
                }
                return 'duplicate_key';
            }
            if (isForeignKeyError(error)) {
                throw new BillingRefundSqlError('foreign_key_violation', 'refund transition referenced a missing/foreign refund or reservation');
            }
            throw error;
        }
        return 'inserted';
    }
    async findOriginalForUpdate(tenantId, originalReference) {
        const tenant = requireBounded(tenantId, 'tenantId', billing_refunds_1.MAX_TENANT_LENGTH);
        const reference = requireBounded(originalReference, 'originalReference', billing_refunds_1.MAX_ORIGINAL_REFERENCE_LENGTH);
        // INDEX USABILITY (UNPROVEN, confirm with EXPLAIN on a live server): each
        // binary-exact collated predicate below is preceded by the plain
        // index-usable equality so the FOR UPDATE lock set is the narrow
        // case/accent/pad-variant candidate set, never a tenant-wide scan.
        // Lock order matches the settlement domain (obligation, then checkout
        // order) so a refund and a settlement of the same payment cannot
        // deadlock. The obligation lookup is binary-exact on the caller string
        // and only for the merchant tuition purpose; its absence is decided
        // AFTER the order is resolved so a known payment is never "not found".
        let obligationRow;
        try {
            const obligations = await this.conn.query(`SELECT id, tenant_id, order_id, purpose, amount_minor, currency,
                        status, net_minor, journal_id
                   FROM financial_settlement_obligations
                  WHERE tenant_id = ? AND order_id = ?
                    AND order_id COLLATE utf8mb4_0900_bin = ?
                    AND purpose = ?
                  LIMIT 1
                  FOR UPDATE`, [tenant, reference, reference, STUDENT_TUITION_PURPOSE]);
            obligationRow = obligations[0];
        }
        catch (error) {
            if (isMissingSourceError(error) || isReadOnlyTransactionError(error)) {
                return {
                    unavailable: true,
                    reason: 'the settlement obligation source is not available; refundable funding cannot be proved',
                };
            }
            throw lockFailureOf(error) ?? error;
        }
        // The neutral checkout order is the canonical minor-unit payment row in
        // the registered schema; locked so the remainder check and reservation
        // serialize against another refund of the same original. The order
        // column is `utf8mb4_unicode_ci` (case- and PAD-SPACE-insensitive), so
        // the predicate is forced to the binary NO PAD collation of
        // `refund_requests.original_reference`: only the exact stored id may
        // resolve, and `ORD-1` / `ord-1 ` fail closed as a missing original.
        const rows = await this.conn.query(`SELECT tenant_id, order_id, payer_reference, amount_minor, currency, status, purpose
               FROM checkout_orders
              WHERE tenant_id = ? AND order_id = ?
                AND order_id COLLATE utf8mb4_0900_bin = ?
              FOR UPDATE`, [tenant, reference, reference]);
        const row = rows[0];
        if (row === undefined)
            return null;
        if (row.tenant_id !== tenant) {
            throw new BillingRefundSqlError('invalid_row', 'the locked original belongs to another tenant');
        }
        // Fail closed: only a PAID merchant payment can be refunded. A created/
        // pending/failed/expired/cancelled order, or a purpose not in the frozen
        // merchant allow-list, is a KNOWN but ineligible original. Returning a
        // typed ineligible result keeps it distinct from `null` (not found).
        const status = requireBounded(row.status, 'checkout_orders.status', 16);
        if (status !== 'paid') {
            return {
                ineligible: true,
                reason: `the original payment exists but its order status '${status}' is not paid`,
            };
        }
        const purpose = requireBounded(row.purpose, 'checkout_orders.purpose', 64);
        if (!exports.MERCHANT_REFUNDABLE_PURPOSES.has(purpose)) {
            return {
                ineligible: true,
                reason: `the original payment exists but its purpose is not merchant-refundable`,
            };
        }
        const canonicalOrderId = requireBounded(row.order_id, 'checkout_orders.order_id', 64);
        const currency = requireCurrency(row.currency);
        const orderAmount = requireRefundAmount(row.amount_minor);
        const payer = requireBounded(row.payer_reference, 'checkout_orders.payer_reference', 128);
        // Funding proof (R2/R8): a paid order alone is not refundable funding.
        // The COMPLETED merchant-liability obligation (journal + net) is. A known
        // payment without it is awaiting_funding, never "not found". Pending-only
        // funds still pass through the merchant_available reservation gate.
        if (obligationRow === undefined) {
            return {
                awaitingFunding: true,
                reason: 'the payment is paid but has no merchant-liability settlement obligation yet',
            };
        }
        if (obligationRow.tenant_id !== tenant
            || obligationRow.order_id !== canonicalOrderId
            || obligationRow.purpose !== STUDENT_TUITION_PURPOSE) {
            return {
                unavailable: true,
                reason: 'the settlement obligation does not match the canonical paid order identity',
            };
        }
        if (obligationRow.status !== 'completed') {
            return {
                awaitingFunding: true,
                reason: `the merchant-liability settlement obligation is '${String(obligationRow.status)}', not completed`,
            };
        }
        if (obligationRow.journal_id === null
            || obligationRow.journal_id === undefined
            || obligationRow.net_minor === null
            || obligationRow.net_minor === undefined) {
            return {
                unavailable: true,
                reason: 'a completed settlement obligation lacks its journal or net amount',
            };
        }
        const netMinor = requireRefundAmount(obligationRow.net_minor);
        if (obligationRow.currency !== currency
            || (0, billing_ledger_sql_1.normalizeSqlBigInt)(obligationRow.amount_minor, 'obligation amount_minor', {
                max: billing_refunds_1.MAX_REFUND_AMOUNT_MINOR,
            }) !== orderAmount
            || netMinor > orderAmount) {
            return {
                unavailable: true,
                reason: 'the completed settlement obligation disagrees with the paid order amount/currency',
            };
        }
        return {
            tenantId: tenant,
            // Canonical stored id, not the caller string: the binary-exact
            // predicate above already guarantees they are identical, but every
            // downstream comparison is anchored to the locked row's value.
            originalReference: canonicalOrderId,
            currency,
            // NET merchant liability (not gross); the domain subtracts prior
            // refunds from the locking sum.
            originalAmountMinor: netMinor,
            payerReference: payer,
            settlementObligationId: requireBounded(obligationRow.id, 'obligation id', 36),
        };
    }
    async sumRefundAmountsForOriginal(tenantId, originalReference, currency) {
        const tenant = requireBounded(tenantId, 'tenantId', billing_refunds_1.MAX_TENANT_LENGTH);
        const reference = requireBounded(originalReference, 'originalReference', billing_refunds_1.MAX_ORIGINAL_REFERENCE_LENGTH);
        const code = requireCurrency(currency);
        // Anchor the sum to the canonical stored order id from the locked order
        // row, never the caller string. Re-reading the already-locked row with
        // the same binary-exact predicate keeps this comparison identical to
        // `findOriginalForUpdate`; a non-canonical caller string is an
        // inconsistent call and fails closed instead of summing a subset.
        const originals = await this.conn.query(`SELECT order_id
               FROM checkout_orders
              WHERE tenant_id = ? AND order_id = ?
                AND order_id COLLATE utf8mb4_0900_bin = ?
              FOR UPDATE`, [tenant, reference, reference]);
        const canonicalRow = originals[0];
        if (canonicalRow === undefined) {
            throw new BillingRefundSqlError('store_inconsistent', 'the refund remainder cannot be summed for a non-canonical original reference');
        }
        const canonicalReference = requireBounded(canonicalRow.order_id, 'checkout_orders.order_id', 64);
        // A locking CURRENT read, not a plain aggregate: the transaction's
        // snapshot may predate a concurrent refund that committed while this
        // transaction was waiting on the original-row lock, and a plain SELECT
        // would miss it and allow an over-refund. `ORDER BY refund_id` keeps the
        // lock order stable. The original row is already `FOR UPDATE`-locked by
        // the caller, so this is the per-original serialization point. The
        // binary-exact predicate matches the column's own NO PAD collation so no
        // case/trailing-space variant can sit outside the summed set.
        const rows = await this.conn.query(`SELECT amount_minor
               FROM refund_requests
              WHERE tenant_id = ? AND original_reference = ?
                AND original_reference COLLATE utf8mb4_0900_bin = ? AND currency = ?
                AND status IN (${LIVE_REFUND_STATUSES})
              ORDER BY refund_id ASC
              FOR UPDATE`, [tenant, canonicalReference, canonicalReference, code]);
        let total = 0n;
        for (const row of rows) {
            total += (0, billing_ledger_sql_1.normalizeSqlBigInt)(row.amount_minor, 'refund amount_minor');
        }
        return total;
    }
    async listRefunds(tenantId, query) {
        const tenant = requireBounded(tenantId, 'tenantId', billing_refunds_1.MAX_TENANT_LENGTH);
        const limit = requireListLimit(query?.limit ?? undefined);
        const status = query?.status === undefined ? undefined : requireRefundStatus(query.status);
        const statusClause = status === undefined ? '' : ' AND status = ?';
        const params = status === undefined ? [tenant, limit + 1] : [tenant, status, limit + 1];
        const rows = await this.conn.query(`SELECT ${REFUND_COLUMNS}
               FROM refund_requests
              WHERE tenant_id = ?${statusClause}
              ORDER BY created_at DESC, refund_id DESC
              LIMIT ?`, params);
        const truncated = rows.length > limit;
        return {
            refunds: rows.slice(0, limit).map((row) => refundOfRow(row, tenant)),
            truncated,
        };
    }
    async rollbackToSavepoint(name) {
        await this.conn.execute(`ROLLBACK TO SAVEPOINT ${name}`);
        await this.conn.execute(`RELEASE SAVEPOINT ${name}`);
    }
}
class BillingRefundsSqlStoreImpl {
    constructor(deps) {
        this.deps = deps;
        if (!deps || typeof deps.transaction !== 'function') {
            throw new BillingRefundSqlError('invalid_runner', 'BillingRefundsSqlStore requires a connection-bound transaction runner');
        }
        if (typeof deps.audit !== 'function') {
            throw new BillingRefundSqlError('invalid_audit', 'BillingRefundsSqlStore requires the sealed connection-bound audit writer');
        }
        this.audit = deps.audit;
    }
    inTransaction(conn) {
        return new BillingRefundsSqlTransactionImpl(conn, this.audit, this.deps.transaction);
    }
    runAtomic(callback) {
        return this.deps.transaction((conn) => callback(this.inTransaction(conn)));
    }
}
const createBillingRefundsSqlStore = (deps) => new BillingRefundsSqlStoreImpl(deps);
exports.createBillingRefundsSqlStore = createBillingRefundsSqlStore;
const createBoundBillingRefundsSqlTransaction = (conn, deps) => new BillingRefundsSqlStoreImpl(deps).inTransaction(conn);
exports.createBoundBillingRefundsSqlTransaction = createBoundBillingRefundsSqlTransaction;
class BillingDisputesSqlTransactionImpl {
    constructor(conn, audit) {
        this.conn = conn;
        this.audit = audit;
        /** Set only by a duplicate insert so the domain's by-key re-read is current. */
        this.disputeDuplicatePending = false;
    }
    async writeAudit(record) {
        await this.audit(this.conn, record);
    }
    async findByIdempotencyKey(tenantId, idempotencyKey) {
        const lockSuffix = this.disputeDuplicatePending ? ' FOR SHARE' : '';
        this.disputeDuplicatePending = false;
        return this.selectDisputeByIdempotencyKey(tenantId, idempotencyKey, lockSuffix);
    }
    async selectDisputeByIdempotencyKey(tenantId, idempotencyKey, lockSuffix) {
        const tenant = requireBounded(tenantId, 'tenantId', billing_refunds_1.MAX_TENANT_LENGTH);
        const key = requireBounded(idempotencyKey, 'idempotencyKey', billing_refunds_1.MAX_IDEMPOTENCY_KEY_LENGTH);
        const rows = await this.conn.query(`SELECT ${DISPUTE_COLUMNS}
               FROM dispute_cases
              WHERE tenant_id = ? AND idempotency_key = ?
              LIMIT 1${lockSuffix}`, [tenant, key]);
        const row = rows[0];
        return row === undefined ? null : disputeOfRow(row, tenant);
    }
    async findDisputeForUpdate(tenantId, disputeId) {
        return this.selectDispute(tenantId, disputeId, ' FOR UPDATE');
    }
    async selectDispute(tenantId, disputeId, lockSuffix) {
        const tenant = requireBounded(tenantId, 'tenantId', billing_refunds_1.MAX_TENANT_LENGTH);
        const id = requireBounded(disputeId, 'disputeId', billing_refunds_1.MAX_DISPUTE_ID_LENGTH);
        const rows = await this.conn.query(`SELECT ${DISPUTE_COLUMNS}
               FROM dispute_cases
              WHERE tenant_id = ? AND dispute_id = ?
              LIMIT 1${lockSuffix}`, [tenant, id]);
        const row = rows[0];
        return row === undefined ? null : disputeOfRow(row, tenant);
    }
    async insertDispute(dispute) {
        const disputeId = requireBounded(dispute.disputeId, 'dispute.disputeId', billing_refunds_1.MAX_DISPUTE_ID_LENGTH);
        const tenant = requireBounded(dispute.tenantId, 'dispute.tenantId', billing_refunds_1.MAX_TENANT_LENGTH);
        const reference = requireBounded(dispute.reference, 'dispute.reference', 128);
        const amount = requireRefundAmount(dispute.amountMinor);
        const currency = requireCurrency(dispute.currency);
        const status = requireDisputeStatus(dispute.status);
        const version = (0, billing_ledger_sql_1.normalizeSqlVersion)(dispute.version, 'dispute.version');
        const idempotencyKey = requireBounded(dispute.idempotencyKey, 'dispute.idempotencyKey', billing_refunds_1.MAX_IDEMPOTENCY_KEY_LENGTH);
        const payloadHash = requireHex64(dispute.payloadHash, 'dispute.payloadHash');
        const openedBy = requireNullableBounded(dispute.openedBy, 'dispute.openedBy', billing_refunds_1.MAX_ACTOR_LENGTH);
        if (dispute.financialConsequence !== 'held') {
            throw new BillingRefundSqlError('invalid_row', 'a dispute may only record the HELD financial consequence');
        }
        const basis = requireBounded(dispute.financialConsequenceBasis, 'dispute.financialConsequenceBasis', MAX_FINANCIAL_CONSEQUENCE_BASIS_LENGTH);
        const createdAt = requireTimestamp(dispute.createdAt, 'dispute.createdAt');
        const updatedAt = requireTimestamp(dispute.updatedAt, 'dispute.updatedAt');
        await this.conn.execute(`SAVEPOINT ${exports.DISPUTE_INSERT_SAVEPOINT}`);
        try {
            await this.conn.execute(`INSERT INTO dispute_cases
                    (dispute_id, tenant_id, reference, amount_minor, currency, status,
                     version, idempotency_key, payload_hash, opened_by,
                     financial_consequence, financial_consequence_basis,
                     created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'held', ?, ?, ?)`, [
                disputeId,
                tenant,
                reference,
                amount.toString(),
                currency,
                status,
                version,
                idempotencyKey,
                payloadHash,
                openedBy,
                basis,
                createdAt,
                updatedAt,
            ]);
            await this.conn.execute(`RELEASE SAVEPOINT ${exports.DISPUTE_INSERT_SAVEPOINT}`);
        }
        catch (error) {
            await this.rollbackToSavepoint(exports.DISPUTE_INSERT_SAVEPOINT);
            if (isDuplicateError(error)) {
                const keyName = duplicateKeyNameOf(error);
                if (keyName === null || !DISPUTE_DUP_KEYS.has(keyName))
                    throw error;
                if (keyName === 'PRIMARY') {
                    const existing = await this.selectDispute(tenant, disputeId, ' FOR SHARE');
                    if (existing === null) {
                        throw new BillingRefundSqlError('store_inconsistent', 'a dispute PRIMARY duplicate could not be re-read inside the transaction');
                    }
                    if (existing.idempotencyKey !== idempotencyKey) {
                        throw new BillingRefundSqlError('resource_conflict', 'disputeId was reused with a different idempotency key');
                    }
                }
                this.disputeDuplicatePending = true;
                return 'duplicate_key';
            }
            if (isForeignKeyError(error)) {
                throw new BillingRefundSqlError('foreign_key_violation', 'dispute insert referenced a missing/foreign tenant');
            }
            throw error;
        }
        return 'inserted';
    }
    async updateStatusCas(input) {
        const tenant = requireBounded(input.tenantId, 'tenantId', billing_refunds_1.MAX_TENANT_LENGTH);
        const disputeId = requireBounded(input.disputeId, 'disputeId', billing_refunds_1.MAX_DISPUTE_ID_LENGTH);
        const expectedVersion = (0, billing_ledger_sql_1.normalizeSqlVersion)(input.expectedVersion, 'dispute expectedVersion');
        const fromStatus = requireDisputeStatus(input.fromStatus);
        const toStatus = requireDisputeStatus(input.toStatus);
        const updatedAt = requireTimestamp(input.updatedAt, 'updatedAt');
        const result = await this.conn.execute(`UPDATE dispute_cases
                SET status = ?, updated_at = ?, version = version + 1
              WHERE tenant_id = ? AND dispute_id = ? AND version = ? AND status = ?`, [toStatus, updatedAt, tenant, disputeId, expectedVersion, fromStatus]);
        const affected = requireCasAffectedRows(result.affectedRows);
        if (affected === 1) {
            const updated = await this.selectDispute(tenant, disputeId, '');
            if (updated === null) {
                throw new BillingRefundSqlError('invalid_row', 'an updated dispute disappeared');
            }
            return { ok: true, dispute: updated };
        }
        if (affected !== 0) {
            throw new BillingRefundSqlError('store_overrun', `the dispute CAS UPDATE reported ${affected} affected rows where exactly one was possible`);
        }
        const current = await this.selectDispute(tenant, disputeId, '');
        if (current === null)
            return { ok: false, reason: 'not_found' };
        if (current.version !== expectedVersion)
            return { ok: false, reason: 'version_conflict' };
        return { ok: false, reason: 'invalid_transition' };
    }
    async findTransitionByIdempotencyKey(tenantId, idempotencyKey) {
        const tenant = requireBounded(tenantId, 'tenantId', billing_refunds_1.MAX_TENANT_LENGTH);
        const key = requireBounded(idempotencyKey, 'idempotencyKey', billing_refunds_1.MAX_IDEMPOTENCY_KEY_LENGTH);
        const rows = await this.conn.query(`SELECT ${DISPUTE_TRANSITION_COLUMNS}
               FROM dispute_transitions
              WHERE tenant_id = ? AND idempotency_key = ?
              LIMIT 1`, [tenant, key]);
        const row = rows[0];
        return row === undefined ? null : disputeTransitionOfRow(row, tenant);
    }
    async selectDisputeTransition(tenantId, id, lockSuffix) {
        const tenant = requireBounded(tenantId, 'tenantId', billing_refunds_1.MAX_TENANT_LENGTH);
        const transitionId = requireBounded(id, 'transition.id', 64);
        const rows = await this.conn.query(`SELECT ${DISPUTE_TRANSITION_COLUMNS}
               FROM dispute_transitions
              WHERE tenant_id = ? AND id = ?
              LIMIT 1${lockSuffix}`, [tenant, transitionId]);
        const row = rows[0];
        return row === undefined ? null : disputeTransitionOfRow(row, tenant);
    }
    async insertTransition(record) {
        const id = requireBounded(record.id, 'transition.id', 64);
        const tenant = requireBounded(record.tenantId, 'transition.tenantId', billing_refunds_1.MAX_TENANT_LENGTH);
        const disputeId = requireBounded(record.disputeId, 'transition.disputeId', billing_refunds_1.MAX_DISPUTE_ID_LENGTH);
        const action = requireDisputeAction(record.action);
        const idempotencyKey = requireBounded(record.idempotencyKey, 'transition.idempotencyKey', billing_refunds_1.MAX_IDEMPOTENCY_KEY_LENGTH);
        const payloadHash = requireHex64(record.payloadHash, 'transition.payloadHash');
        const fromStatus = record.fromStatus === null ? null : requireDisputeStatus(record.fromStatus);
        const toStatus = requireDisputeStatus(record.toStatus);
        const versionAfter = (0, billing_ledger_sql_1.normalizeSqlVersion)(record.versionAfter, 'transition.versionAfter');
        const actorId = requireNullableBounded(record.actorId, 'transition.actorId', billing_refunds_1.MAX_ACTOR_LENGTH);
        const reason = requireNullableBounded(record.reason, 'transition.reason', billing_refunds_1.MAX_REASON_LENGTH);
        const createdAt = requireTimestamp(record.createdAt, 'transition.createdAt');
        await this.conn.execute(`SAVEPOINT ${exports.DISPUTE_TRANSITION_SAVEPOINT}`);
        try {
            await this.conn.execute(`INSERT INTO dispute_transitions
                    (id, tenant_id, dispute_id, action, idempotency_key, payload_hash,
                     from_status, to_status, version_after, actor_id, reason, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
                id,
                tenant,
                disputeId,
                action,
                idempotencyKey,
                payloadHash,
                fromStatus,
                toStatus,
                versionAfter,
                actorId,
                reason,
                createdAt,
            ]);
            await this.conn.execute(`RELEASE SAVEPOINT ${exports.DISPUTE_TRANSITION_SAVEPOINT}`);
        }
        catch (error) {
            await this.rollbackToSavepoint(exports.DISPUTE_TRANSITION_SAVEPOINT);
            if (isDuplicateError(error)) {
                const keyName = duplicateKeyNameOf(error);
                if (keyName === null || !DISPUTE_TRANSITION_DUP_KEYS.has(keyName))
                    throw error;
                if (keyName === 'PRIMARY') {
                    const existing = await this.selectDisputeTransition(tenant, id, ' FOR SHARE');
                    if (existing === null) {
                        throw new BillingRefundSqlError('store_inconsistent', 'a dispute transition duplicate could not be re-read inside the transaction');
                    }
                    if (existing.idempotencyKey !== idempotencyKey) {
                        throw new BillingRefundSqlError('resource_conflict', 'dispute transition id was reused with a different idempotency key');
                    }
                }
                return 'duplicate_key';
            }
            if (isForeignKeyError(error)) {
                throw new BillingRefundSqlError('foreign_key_violation', 'dispute transition referenced a missing/foreign dispute');
            }
            throw error;
        }
        return 'inserted';
    }
    async listDisputes(tenantId, query) {
        const tenant = requireBounded(tenantId, 'tenantId', billing_refunds_1.MAX_TENANT_LENGTH);
        const limit = requireListLimit(query?.limit ?? undefined);
        const status = query?.status === undefined ? undefined : requireDisputeStatus(query.status);
        const statusClause = status === undefined ? '' : ' AND status = ?';
        const params = status === undefined ? [tenant, limit + 1] : [tenant, status, limit + 1];
        const rows = await this.conn.query(`SELECT ${DISPUTE_COLUMNS}
               FROM dispute_cases
              WHERE tenant_id = ?${statusClause}
              ORDER BY created_at DESC, dispute_id DESC
              LIMIT ?`, params);
        const truncated = rows.length > limit;
        return {
            disputes: rows.slice(0, limit).map((row) => disputeOfRow(row, tenant)),
            truncated,
        };
    }
    async rollbackToSavepoint(name) {
        await this.conn.execute(`ROLLBACK TO SAVEPOINT ${name}`);
        await this.conn.execute(`RELEASE SAVEPOINT ${name}`);
    }
}
class BillingDisputesSqlStoreImpl {
    constructor(deps) {
        this.deps = deps;
        if (!deps || typeof deps.transaction !== 'function') {
            throw new BillingRefundSqlError('invalid_runner', 'BillingDisputesSqlStore requires a connection-bound transaction runner');
        }
        if (typeof deps.audit !== 'function') {
            throw new BillingRefundSqlError('invalid_audit', 'BillingDisputesSqlStore requires the sealed connection-bound audit writer');
        }
        this.audit = deps.audit;
    }
    inTransaction(conn) {
        return new BillingDisputesSqlTransactionImpl(conn, this.audit);
    }
    runAtomic(callback) {
        return this.deps.transaction((conn) => callback(this.inTransaction(conn)));
    }
}
const createBillingDisputesSqlStore = (deps) => new BillingDisputesSqlStoreImpl(deps);
exports.createBillingDisputesSqlStore = createBillingDisputesSqlStore;
const createBoundBillingDisputesSqlTransaction = (conn, deps) => new BillingDisputesSqlStoreImpl(deps).inTransaction(conn);
exports.createBoundBillingDisputesSqlTransaction = createBoundBillingDisputesSqlTransaction;
