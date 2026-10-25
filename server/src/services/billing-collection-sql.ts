/**
 * PATH-B6 (registered expansion X5) — real SQL adapter for `CollectionStore`.
 *
 * Implements `CollectionStore` / `CollectionTransaction` (billing-collection.ts)
 * against `billing_difference_requests` from migration
 * `20261022_02_billing_invoices_collections.sql`. Real table, index and
 * constraint names come verbatim from that migration source:
 *   uq_billing_diff_request_key (tenant_id, request_key)
 *   uq_billing_diff_request_basis (tenant_id, basis_key)
 *   uq_billing_diff_request_settlement (tenant_id, settled_payment_id)
 *   uq_billing_diff_request_id_tenant (id, tenant_id)
 *   fk_billing_diff_request_tenant / fk_billing_diff_request_correction_of
 * Whether the live MySQL 8 driver messages carry exactly these names per
 * statement remains a live-run question.
 *
 * GLOBAL LOCK ORDER (CL-B-BILLING 14.6, shared with billing-payouts-sql.ts):
 *   | G1 | billing_invoices (resolveInvoiceForDifference / lockInvoiceForPayment) | FOR UPDATE |
 *   | G2 | billing_payment_allocations of that invoice                            | FOR UPDATE |
 *   | G3 | billing_difference_requests (other-open sum / issuance INSERT / apply)  | FOR SHARE / INSERT / FOR UPDATE |
 *   | G4 | financial_settlement_obligations (proof)                               | FOR SHARE  |
 *   | G5 | checkout_orders (proof)                                                | FOR SHARE  |
 *   | G6 | checkout_order_platform_targets (proof, immutable)                     | FOR SHARE  |
 *   | G7 | platform_payment_request_links (consumption link)                      | INSERT / FOR SHARE re-read |
 * Issuance is invoice-first. applyVerifiedPlatformPayment for a request linked
 * to an invoice first reads the request WITHOUT a lock (`findById`), takes
 * G1-G2 (`lockInvoiceForPayment`), and only then locks the request row FOR
 * UPDATE (G3); only after that does `verifyPlatformPaymentProof` take G4-G6
 * (FOR SHARE), and the allocation rows it reads are the ones G2 already holds.
 * This replaces the pre-existing inversion (obligation/allocations locked after
 * the request row). An unlinked request (invoice_ref_id NULL) never reaches
 * G4-G6 or the allocations: it is `unresolved_reference` before any read.
 * Lock errors 1213/1205 (also when re-raised by the bound settlement view as
 * `lock_conflict` / `lock_wait_timeout`) surface as typed errors; InnoDB has
 * already rolled a deadlock victim back, so there is no retry inside a unit.
 *
 * SOURCE CODE ONLY. Nothing here executes SQL or opens a connection. Every
 * statement of a unit of work is issued on the caller-injected transaction
 * connection; there is no pooled query and no autocommit fallback. A missing
 * runner or audit writer throws at construction, before any statement.
 *
 * MUTABILITY: `deadline_at`, `issued_at`, `amount_minor`, `currency` and every
 * identity column are immutable after insert. After the INSERT the adapter has
 * exactly ONE mutation statement, the CAS
 * `UPDATE ... SET status = ?, paid_at = ?, settled_payment_id = ?, version =
 * version + 1 WHERE tenant_id = ? AND id = ? AND version = ? AND status IN
 * (...)`, which by construction cannot touch `deadline_at`. As a hard runtime
 * guard (`assertDifferenceMutationAllowed`) any DELETE/REPLACE/TRUNCATE on the
 * table fails CLOSED, and any UPDATE whose text is not the exact CAS prefix is
 * rejected, so a future code path can never sneak a deadline change in.
 *
 * UPDATE-CAS CONTRACT: `updateStatusCas` is one conditional write on
 * `(tenant_id, id, version, status-from)`. The `status` predicate encodes the
 * settled domain transitions (billing-collection.ts): `paid` is allowed from
 * `open` or `expired` (docs/19 line 76 keeps debt payment available after the
 * grace), while `expired` and `cancelled` are allowed only from `open`. On a
 * miss the adapter re-reads the row and reports `not_found` |
 * `version_conflict` | `invalid_transition` explicitly; it never guesses.
 *
 * MONEY/TIME (HK2): exact integer minor units and UTC seconds only. BIGINT
 * UNSIGNED columns may arrive as bigint, decimal string or exactly-
 * representable safe number; `normalizeSqlBigInt` (the shared HK2 normalizer
 * exported by billing-ledger-sql.ts; its typed invariant errors are rethrown
 * untranslated) rejects every other shape and never routes money or seconds
 * through `Number()` loss. Required mysql2 options for the production binding:
 * `supportBigNumbers: true`, `bigNumberStrings: true` — the adapter is
 * value-shape safe either way.
 *
 * HK1: issuance idempotency keys (`uq_billing_diff_request_key`) +
 * `payload_hash` are served by the store; the replay-vs-conflict comparison
 * and the basis-key resolution are domain work (`issueDifferenceRequest`
 * billing-collection.ts:698-724); the adapter never decides payload identity.
 *
 * TXN: `insertRequest` wraps the INSERT in a SAVEPOINT
 * (billing_diff_request_insert) and rolls back to it on a mapped duplicate or
 * FK violation so a real transaction runner never sees a poisoned statement;
 * unmapped constraint names rethrow the RAW driver error (never mislabeled,
 * never success). `findByIdForUpdate` locks the row `FOR UPDATE` on the same
 * connection as the following CAS and audit row.
 *
 * AUDIT: `writeAudit` on the transaction handle is the ONLY path and routes to
 * the REQUIRED constructor-injected connection-bound sealed sink; an audit
 * failure fails the unit of work wholesale (runner rollback).
 */

import {
    assertDifferenceRequest,
    CollectionAuditRecord,
    type CollectionStore,
    type CollectionTransaction,
    DEFAULT_LIST_LIMIT,
    DIFFERENCE_REQUEST_STATUSES,
    type DifferenceInvoiceResolution,
    DifferenceRequest,
    type DifferenceRequestPage,
    type DifferenceRequestStatus,
    type InsertDifferenceRequestResult,
    MAX_ID_LENGTH,
    MAX_INVOICE_REF_LENGTH,
    MAX_LIST_LIMIT,
    MAX_REASON_LENGTH,
    MAX_PAYMENT_ID_LENGTH,
    MAX_REQUEST_ID_LENGTH,
    MAX_TENANT_LENGTH,
    type InsertPaymentRequestLinkResult,
    type PaymentProofContext,
    type PaymentProofResolution,
    type PaymentRequestLink,
    type PlatformPaymentProofRequest,
    type UpdateStatusCasInput,
    type UpdateStatusCasResult,
} from './billing-collection';
import { normalizeSqlBigInt, normalizeSqlVersion } from './billing-ledger-sql';
import {
    asSettlementObligationId,
    computeInvoiceOutstanding,
    type PaymentAllocationRecord,
    PLATFORM_DIFFERENCE_PAYMENT_PURPOSES,
    readPlatformAllocationBalance,
    type SettlementObligationId,
} from './billing-settlement';
import { createBoundBillingSettlementSqlTransaction } from './billing-settlement-sql';

export const COLLECTION_SQL_ADAPTER_ID = 'billing-collection-sql:20261022_02';

/** Bounded listing always reads one row beyond the cap to detect truncation. */
export const COLLECTION_LIST_READ_HEADROOM = 1;

export const COLLECTION_INSERT_SAVEPOINT = 'billing_diff_request_insert';
export const COLLECTION_LINK_INSERT_SAVEPOINT = 'platform_payment_request_link_insert';

export type CollectionSqlErrorCode =
    | 'invalid_runner'
    | 'invalid_audit'
    | 'invalid_row'
    | 'store_overrun'
    | 'duplicate_key'
    | 'foreign_key_violation'
    | 'immutable_statement'
    /** MySQL 1213: InnoDB already rolled the transaction back; RETRYABLE by re-running the whole unit. */
    | 'lock_conflict'
    /** MySQL 1205: lock wait timeout; RETRYABLE by re-running the whole unit. */
    | 'lock_wait_timeout';

export class BillingCollectionSqlError extends Error {
    constructor(public readonly code: CollectionSqlErrorCode, message: string) {
        super(message);
        this.name = 'BillingCollectionSqlError';
    }
}

/** Missing driver counts cannot establish either a CAS conflict or success. */
const requireCasAffectedRows = (raw: unknown): number => {
    // Connection contracts also permit strict decimal-string driver counts.
    const value = typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : raw;
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
        throw new BillingCollectionSqlError('invalid_row', 'CAS result has no readable non-negative integer affectedRows');
    }
    return value;
};

export interface CollectionSqlConnection {
    query<T = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<T[]>;
    execute(
        sql: string,
        params?: readonly unknown[],
    ): Promise<{ affectedRows?: number | string; insertId?: number | string }>;
}

export type CollectionSqlTransactionRunner = <T>(
    fn: (conn: CollectionSqlConnection) => Promise<T>,
) => Promise<T>;

/**
 * REQUIRED audit sink bound to one open transaction connection. There is no
 * default and no no-op: production MUST inject the sealed writer whose row
 * lands on the same connection/transaction as the mutation.
 */
export type CollectionSqlAuditSink = (
    conn: CollectionSqlConnection,
    record: CollectionAuditRecord,
) => Promise<void>;

export interface CollectionSqlDeps {
    transaction: CollectionSqlTransactionRunner;
    audit: CollectionSqlAuditSink;
}

const REQUEST_COLUMNS = `id, tenant_id, org_kind, invoice_id, invoice_ref_id, cycle_start,
    difference_basis, basis_key, amount_minor, currency, issued_at, deadline_at,
    status, version, request_key, payload_hash, paid_at, settled_payment_id,
    correction_of_request_id, correction_reason, corrected_by_actor_id`;

const REQUEST_INSERT_SQL = `INSERT INTO billing_difference_requests (
        id, tenant_id, org_kind, invoice_id, invoice_ref_id, cycle_start, difference_basis,
        basis_key, amount_minor, currency, issued_at, deadline_at, status,
        version, request_key, payload_hash, paid_at, settled_payment_id,
        correction_of_request_id, correction_reason, corrected_by_actor_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

/** The ONLY mutation after insert: the CAS; its exact shape is enforced. */
export const DIFFERENCE_CAS_UPDATE_PREFIX
    = /^UPDATE\s+`?billing_difference_requests`?\s+SET\s+status\s+=\s+\?,\s+paid_at\s+=\s+\?,\s+settled_payment_id\s+=\s+\?,\s+version\s+=\s+version\s+\+\s+1\s+WHERE\b/i;

const DIFFERENCE_DESTRUCTIVE_PATTERN
    = /^(?:DELETE\s+FROM\b|REPLACE\s+INTO\b|TRUNCATE\b)[^;]*billing_difference_requests\b/i;

const DIFFERENCE_OTHER_UPDATE_PATTERN
    = /^UPDATE\b[^;]*billing_difference_requests\b/i;

/**
 * Runtime guard: after the INSERT only the CAS-shaped UPDATE may touch
 * billing_difference_requests, so `deadline_at` and every identity/money
 * column are immutable no matter what a future call path writes.
 */
export const assertDifferenceMutationAllowed = (sql: string): void => {
    const text = `${sql.replace(/^\s+/, '')}`.replace(/\s+$/, '');
    if (DIFFERENCE_DESTRUCTIVE_PATTERN.test(text)) {
        throw new BillingCollectionSqlError(
            'immutable_statement',
            'billing_difference_requests has no DELETE/REPLACE/TRUNCATE path; requests are cancelled by state, never deleted',
        );
    }
    if (DIFFERENCE_OTHER_UPDATE_PATTERN.test(text) && !DIFFERENCE_CAS_UPDATE_PREFIX.test(text)) {
        throw new BillingCollectionSqlError(
            'immutable_statement',
            'only the CAS UPDATE (status, paid_at, settled_payment_id, version = version + 1) may mutate a difference request',
        );
    }
};

const HEX_64 = /^[0-9a-f]{64}$/;

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

/** FK errno messages carry the constraint name; match REAL names. */
const fkConstraintNameOf = (error: unknown): string | null => {
    if (!isForeignKeyError(error)) return null;
    const match = /CONSTRAINT [`"[]?([A-Za-z0-9_]+)/.exec(errorMessageOf(error));
    return match === null ? null : (match[1] as string);
};

const DIFFERENCE_DUP_KEYS = new Set([
    'PRIMARY',
    'uq_billing_diff_request_key',
    'uq_billing_diff_request_basis',
    'uq_billing_diff_request_settlement',
    'uq_billing_diff_request_id_tenant',
    // 20261024_02: composite request -> invoice/currency/amount proof key.
    'uq_billing_diff_request_target',
]);

const DIFFERENCE_FK_NAMES = new Set([
    'fk_billing_diff_request_tenant',
    'fk_billing_diff_request_correction_of',
    'fk_billing_diff_invoice_ref',
]);

const LINK_DUP_KEYS = new Set([
    'PRIMARY',
    'uq_platform_link_request',
    'uq_platform_link_allocation',
]);

const LINK_FK_NAMES = new Set([
    'fk_platform_link_tenant',
    'fk_platform_link_obligation',
    'fk_platform_link_target',
    'fk_platform_link_allocation',
    'fk_platform_link_request',
]);

const MAX_ORDER_ID_LENGTH = 64;

const requireBounded = (value: unknown, field: string, maxLength: number): string => {
    if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) {
        throw new BillingCollectionSqlError(
            'invalid_row',
            `${field} must be a non-empty string of at most ${maxLength} characters`,
        );
    }
    return value;
};

const requireHex64 = (value: unknown, field: string): string => {
    const text = requireBounded(value, field, 128);
    if (!HEX_64.test(text)) {
        throw new BillingCollectionSqlError('invalid_row', `${field} must be a lowercase SHA-256 hex string`);
    }
    return text;
};

const requireNonNegativeSafeInteger = (value: unknown, field: string): number => {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
        throw new BillingCollectionSqlError('invalid_row', `${field} must be a non-negative safe integer`);
    }
    return value;
};

/** HK2 read path for BIGINT seconds columns: exact integer, safe range. */
const normalizeSqlSeconds = (value: unknown, field: string): number => {
    const normalized = normalizeSqlBigInt(value, field);
    if (normalized > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new BillingCollectionSqlError('invalid_row', `${field} exceeds the safe integer second range`);
    }
    return Number(normalized);
};

const isMissingSourceCode = (error: unknown): boolean => {
    if (typeof error !== 'object' || error === null) return false;
    const code = (error as { code?: unknown }).code;
    const errno = (error as { errno?: unknown }).errno;
    return code === 'ER_NO_SUCH_TABLE'
        || code === 'ER_BAD_FIELD_ERROR'
        || code === 'ER_UNKNOWN_TABLE'
        || errno === 1146
        || errno === 1054;
};

/** Typed RETRYABLE lock failure (1213 / 1205), or null for any other error. */
const lockFailureOf = (error: unknown): BillingCollectionSqlError | null => {
    if (typeof error !== 'object' || error === null) return null;
    const code = (error as { code?: unknown }).code;
    const errno = (error as { errno?: unknown }).errno;
    if (code === 'ER_LOCK_DEADLOCK' || code === 'lock_conflict' || errno === 1213) {
        return new BillingCollectionSqlError(
            'lock_conflict',
            'deadlock detected; the unit of work was rolled back and may be retried',
        );
    }
    if (code === 'ER_LOCK_WAIT_TIMEOUT' || code === 'lock_wait_timeout' || errno === 1205) {
        return new BillingCollectionSqlError('lock_wait_timeout', 'lock wait timeout; the unit of work may be retried');
    }
    return null;
};

/** MySQL 1792: a locking read inside a READ ONLY transaction. */
const isReadOnlyTransactionError = (error: unknown): boolean => {
    if (typeof error !== 'object' || error === null) return false;
    return (error as { code?: unknown }).code === 'ER_CANT_EXECUTE_IN_READ_ONLY_TRANSACTION'
        || (error as { errno?: unknown }).errno === 1792;
};

interface PlatformLinkRowDb {
    tenant_id: string;
    obligation_id: string;
    order_id: string;
    request_id: string;
    invoice_id: string;
    allocation_id: string;
    currency: string;
    amount_minor: unknown;
}

interface ProofOrderRowDb {
    tenant_id: string;
    order_id: string;
    purpose: string;
    amount_minor: unknown;
    currency: string;
    status: string;
}

interface DifferenceRequestRowDb {
    id: string;
    tenant_id: string;
    org_kind: string;
    invoice_id: string;
    invoice_ref_id: string | null;
    cycle_start: unknown;
    difference_basis: string;
    basis_key: string | null;
    amount_minor: unknown;
    currency: string;
    issued_at: unknown;
    deadline_at: unknown;
    status: string;
    version: unknown;
    request_key: string;
    payload_hash: string;
    paid_at: unknown;
    settled_payment_id: string | null;
    correction_of_request_id: string | null;
    correction_reason: string | null;
    corrected_by_actor_id: string | null;
}


class CollectionSqlConn implements CollectionSqlConnection {
    constructor(
        private readonly raw: CollectionSqlConnection,
        private readonly guard: (sql: string) => void,
    ) {}

    query<T = Record<string, unknown>>(sql: string, params: readonly unknown[] = []): Promise<T[]> {
        this.guard(sql);
        return this.raw.query<T>(sql, params);
    }

    execute(
        sql: string,
        params: readonly unknown[] = [],
    ): Promise<{ affectedRows?: number | string; insertId?: number | string }> {
        this.guard(sql);
        return this.raw.execute(sql, params);
    }
}

/**
 * Reassemble one REAL row into the domain shape and re-check it through
 * `assertDifferenceRequest` at the read boundary. `modelVersion` is
 * reconstituted (COLLECTION_MODEL_VERSION is code, not a persisted column).
 */
const requestOfRow = (row: DifferenceRequestRowDb, requestedTenantId: string): DifferenceRequest => {
    if (row.tenant_id !== requestedTenantId) {
        throw new BillingCollectionSqlError('invalid_row', 'a difference request row belongs to another tenant');
    }
    if (!(DIFFERENCE_REQUEST_STATUSES as readonly string[]).includes(row.status)) {
        throw new BillingCollectionSqlError('invalid_row', 'a difference request row has an unknown status');
    }
    return assertDifferenceRequest({
        modelVersion: 1,
        requestId: requireBounded(row.id, 'billing_difference_requests.id', MAX_REQUEST_ID_LENGTH),
        tenantId: requireBounded(row.tenant_id, 'billing_difference_requests.tenant_id', MAX_TENANT_LENGTH),
        orgKind: requireBounded(row.org_kind, 'billing_difference_requests.org_kind', 7),
        invoiceId: requireBounded(row.invoice_id, 'billing_difference_requests.invoice_id', MAX_ID_LENGTH),
        invoiceRefId: row.invoice_ref_id === null || row.invoice_ref_id === undefined
            ? null
            : requireBounded(
                row.invoice_ref_id,
                'billing_difference_requests.invoice_ref_id',
                MAX_INVOICE_REF_LENGTH,
            ),
        cycleStart: normalizeSqlSeconds(row.cycle_start, 'billing_difference_requests.cycle_start'),
        differenceBasis: requireBounded(
            row.difference_basis,
            'billing_difference_requests.difference_basis',
            64,
        ),
        basisKey: row.basis_key === null ? null : requireHex64(row.basis_key, 'billing_difference_requests.basis_key'),
        amountMinor: normalizeSqlBigInt(row.amount_minor, 'billing_difference_requests.amount_minor'),
        currency: requireBounded(row.currency, 'billing_difference_requests.currency', 3),
        issuedAt: normalizeSqlSeconds(row.issued_at, 'billing_difference_requests.issued_at'),
        deadlineAt: normalizeSqlSeconds(row.deadline_at, 'billing_difference_requests.deadline_at'),
        status: row.status as DifferenceRequestStatus,
        version: normalizeSqlVersion(row.version, 'billing_difference_requests.version'),
        requestKey: requireBounded(row.request_key, 'billing_difference_requests.request_key', MAX_ID_LENGTH),
        payloadHash: requireHex64(row.payload_hash, 'billing_difference_requests.payload_hash'),
        paidAt: row.paid_at === null
            ? null
            : normalizeSqlSeconds(row.paid_at, 'billing_difference_requests.paid_at'),
        settledPaymentId: row.settled_payment_id === null
            ? null
            : requireBounded(
                row.settled_payment_id,
                'billing_difference_requests.settled_payment_id',
                MAX_PAYMENT_ID_LENGTH,
            ),
        correctionOfRequestId: row.correction_of_request_id === null
            ? null
            : requireBounded(
                row.correction_of_request_id,
                'billing_difference_requests.correction_of_request_id',
                MAX_REQUEST_ID_LENGTH,
            ),
        correctionReason: row.correction_reason === null
            ? null
            : requireBounded(row.correction_reason, 'billing_difference_requests.correction_reason', MAX_REASON_LENGTH),
        correctedByActorId: row.corrected_by_actor_id === null
            ? null
            : requireBounded(
                row.corrected_by_actor_id,
                'billing_difference_requests.corrected_by_actor_id',
                MAX_ID_LENGTH,
            ),
    });
};

/**
 * Settled transition graph (billing-collection.ts): a verified payment may
 * land on an `open` OR `expired` request (docs/19 line 76); expiring and
 * cancelling act on `open` rows only.
 */
const CAS_FROM_STATUSES: Record<Exclude<DifferenceRequestStatus, 'open'>, readonly string[]> = {
    paid: ['open', 'expired'],
    expired: ['open'],
    cancelled: ['open'],
};

export interface BillingCollectionSqlTransaction extends CollectionTransaction {
    /**
     * The ONLY collection audit path: routes the sealed record through the
     * required constructor sink on THIS transaction's connection. An audit
     * failure fails the whole unit of work.
     */
    writeAudit(record: CollectionAuditRecord): Promise<void>;
}

class BillingCollectionSqlTransactionImpl implements BillingCollectionSqlTransaction {
    private readonly conn: CollectionSqlConn;

    constructor(
        conn: CollectionSqlConnection,
        private readonly audit: CollectionSqlAuditSink,
        private readonly runner: CollectionSqlTransactionRunner,
    ) {
        this.conn = new CollectionSqlConn(conn, assertDifferenceMutationAllowed);
    }

    async writeAudit(record: CollectionAuditRecord): Promise<void> {
        await this.audit(this.conn, record);
    }

    /**
     * Server-side invoice proof for `invoice_ref_id`: the SHARED allocation
     * source (`computeInvoiceOutstanding`) runs on THIS connection, so the
     * invoice row is read tenant-scoped with `FOR UPDATE` and its allocations
     * with a locking current read inside the issuing transaction. The
     * settlement view is bound per call (no cached state) and is used only
     * for reads: its audit sink always refuses, so it can never write.
     * An unknown/incomplete source is `debt_source_unavailable`, never zero.
     */
    async resolveInvoiceForDifference(
        tenantId: string,
        invoiceRefId: string,
        asOfSeconds: number,
    ): Promise<DifferenceInvoiceResolution> {
        const tenant = requireBounded(tenantId, 'tenantId', MAX_TENANT_LENGTH);
        const id = requireBounded(invoiceRefId, 'invoiceRefId', MAX_INVOICE_REF_LENGTH);
        const reader = createBoundBillingSettlementSqlTransaction(this.conn, {
            transaction: this.runner,
            audit: () => {
                throw new BillingCollectionSqlError(
                    'invalid_audit',
                    'the read-only invoice proof view must never write an audit row',
                );
            },
        });
        // LOCK ORDER step 1-2: invoice FOR UPDATE + allocations (shared source).
        const outcome = await computeInvoiceOutstanding(reader, tenant, id);
        if (!outcome.ok) return { ok: false, reason: outcome.reason };

        // LOCK ORDER step 3 (only AFTER the invoice lock): the other open
        // requests of this invoice. Open = status 'open' and deadline still in
        // the future at the issuing instant; expired/paid/cancelled are not.
        const asOf = requireNonNegativeSafeInteger(asOfSeconds, 'asOfSeconds');
        let otherRows: Array<{ amount_minor: unknown }>;
        try {
            otherRows = await this.conn.query<{ amount_minor: unknown }>(
                `SELECT amount_minor
                   FROM billing_difference_requests
                  WHERE tenant_id = ? AND invoice_ref_id = ? AND currency = ?
                    AND status = 'open' AND deadline_at > ?
                  ORDER BY id ASC
                  LIMIT ? FOR SHARE`,
                [tenant, id, outcome.currency, asOf, MAX_LIST_LIMIT + 1],
            );
        } catch (error) {
            if (isMissingSourceCode(error) || isReadOnlyTransactionError(error)) {
                return { ok: false, reason: 'debt_source_unavailable' };
            }
            throw lockFailureOf(error) ?? error;
        }
        // A bounded page that is not complete is unknown, never a partial sum.
        if (otherRows.length > MAX_LIST_LIMIT) return { ok: false, reason: 'debt_source_unavailable' };
        let otherOpen = 0n;
        for (const row of otherRows) {
            otherOpen += normalizeSqlBigInt(row.amount_minor, 'billing_difference_requests.amount_minor');
        }
        return {
            ok: true,
            invoiceId: outcome.invoiceId,
            currency: outcome.currency,
            outstandingMinor: normalizeSqlBigInt(outcome.outstandingMinor, 'invoice.outstandingMinor'),
            otherOpenRequestedMinor: otherOpen,
        };
    }

    /** Read-only view of the shared settlement SQL transaction; its audit sink always refuses. */
    private settlementReader(): ReturnType<typeof createBoundBillingSettlementSqlTransaction> {
        return createBoundBillingSettlementSqlTransaction(this.conn, {
            transaction: this.runner,
            audit: () => {
                throw new BillingCollectionSqlError(
                    'invalid_audit',
                    'the read-only platform payment proof view must never write an audit row',
                );
            },
        });
    }

    /**
     * Legacy optional capability, kept for callers of the old interface. The
     * payment id is the settlement OBLIGATION id. The proof is the same strict
     * 14.3.6 proof as `verifyPlatformPaymentProof`; since this signature does
     * not name the request, the request id is taken from the immutable target
     * row of the obligation's order. `invoiceRefId === null` (unlinked legacy
     * request) is `unresolved_reference` BEFORE any read. `purposeContext` is
     * only a consistency assertion against the LOCKED obligation purpose.
     */
    async verifyPaymentProof(
        tenantId: string,
        paymentId: string,
        amountMinor: bigint,
        currency: string,
        purposeContext: PaymentProofContext,
    ): Promise<PaymentProofResolution> {
        const tenant = requireBounded(tenantId, 'tenantId', MAX_TENANT_LENGTH);
        if (purposeContext.invoiceRefId === null) return { ok: false, reason: 'unresolved_reference' };
        const obligationId = asSettlementObligationId(paymentId);
        const purpose = requireBounded(purposeContext.purpose, 'purpose', 64);
        const invoiceRef = requireBounded(purposeContext.invoiceRefId, 'invoiceRefId', MAX_INVOICE_REF_LENGTH);
        if (typeof amountMinor !== 'bigint' || amountMinor <= 0n) {
            return { ok: false, reason: 'payment_proof_unavailable' };
        }
        return this.provePlatformPayment(tenant, obligationId, {
            requestId: null,
            invoiceRefId: invoiceRef,
            amountMinor,
            currency,
            purpose,
        });
    }

    /**
     * Strict platform payment proof (CL-B-BILLING 14.3.5-14.3.6). Reads, all
     * tenant-scoped and byte-exact, in lock order G4 -> G5 -> G6 (FOR SHARE);
     * the allocation rows come from the bound settlement view
     * (`readPlatformAllocationBalance`) and are already held by the G2 lock
     * the caller took through `lockInvoiceForPayment`. Nothing is written.
     * There is no status gate on `completed`: the purpose (from the LOCKED
     * row) must be in the platform allowlist and the CURRENT non-reversed
     * allocation proof is recomputed on every call, even when the obligation
     * status is already `allocated`.
     */
    async verifyPlatformPaymentProof(
        tenantId: string,
        obligationId: SettlementObligationId,
        request: PlatformPaymentProofRequest,
    ): Promise<PaymentProofResolution> {
        const tenant = requireBounded(tenantId, 'tenantId', MAX_TENANT_LENGTH);
        // Unlinked legacy request: typed outcome BEFORE any read.
        if (typeof request.invoiceRefId !== 'string' || request.invoiceRefId.length === 0) {
            return { ok: false, reason: 'unresolved_reference' };
        }
        const obligation = asSettlementObligationId(obligationId);
        const requestId = requireBounded(request.requestId, 'requestId', MAX_REQUEST_ID_LENGTH);
        const invoiceRef = requireBounded(request.invoiceRefId, 'invoiceRefId', MAX_INVOICE_REF_LENGTH);
        if (typeof request.amountMinor !== 'bigint' || request.amountMinor <= 0n) {
            return { ok: false, reason: 'payment_proof_unavailable' };
        }
        return this.provePlatformPayment(tenant, obligation, {
            requestId,
            invoiceRefId: invoiceRef,
            amountMinor: request.amountMinor,
            currency: request.currency,
            purpose: null,
        });
    }

    private async provePlatformPayment(
        tenant: string,
        obligationId: SettlementObligationId,
        expected: {
            readonly requestId: string | null;
            readonly invoiceRefId: string;
            readonly amountMinor: bigint;
            readonly currency: string;
            readonly purpose: string | null;
        },
    ): Promise<PaymentProofResolution> {
        const unavailable: PaymentProofResolution = { ok: false, reason: 'payment_proof_unavailable' };
        try {
            const reader = this.settlementReader();

            // G4: obligation FOR SHARE (through the bound view). The purpose
            // comes from THIS locked row, never from the caller.
            const ob = await reader.findObligationForShare(tenant, obligationId);
            if (ob === null || ob.tenantId !== tenant || ob.id !== obligationId) return unavailable;
            if (!PLATFORM_DIFFERENCE_PAYMENT_PURPOSES.has(ob.purpose)) {
                return { ok: false, reason: 'purpose_not_allowed' };
            }
            if (expected.purpose !== null && expected.purpose !== ob.purpose) {
                return { ok: false, reason: 'purpose_not_allowed' };
            }
            if (ob.amountMinor !== expected.amountMinor) return unavailable;
            if (ob.currency !== expected.currency) return { ok: false, reason: 'target_mismatch' };

            // G5: order FOR SHARE.
            const orders = await this.conn.query<ProofOrderRowDb>(
                `SELECT tenant_id, order_id, purpose, amount_minor, currency, status
                   FROM checkout_orders
                  WHERE tenant_id = ? AND order_id = ?
                  LIMIT 1 FOR SHARE`,
                [tenant, ob.orderId],
            );
            const order = orders[0];
            if (order === undefined) return unavailable;
            if (
                order.tenant_id !== tenant
                || order.status !== 'paid'
                || order.order_id !== ob.orderId
                || order.purpose !== ob.purpose
                || order.currency !== ob.currency
                || normalizeSqlBigInt(order.amount_minor, 'checkout_orders.amount_minor') !== ob.amountMinor
            ) {
                return unavailable;
            }

            // G6: immutable platform target FOR SHARE.
            const target = await reader.findPlatformTargetByOrder(tenant, ob.orderId);
            if (target === null) return { ok: false, reason: 'unresolved_reference' };
            if (
                target.tenantId !== tenant
                || target.orderId !== ob.orderId
                || target.purpose !== ob.purpose
                || target.invoiceId !== expected.invoiceRefId
                || target.currency !== expected.currency
                || target.amountMinor !== expected.amountMinor
                || (expected.requestId !== null && target.requestId !== expected.requestId)
            ) {
                return { ok: false, reason: 'target_mismatch' };
            }
            const requestId = target.requestId;

            // A legacy direct allocation has no proved allocatable and no
            // receipt journal: reconciliation case, never an automatic closure.
            if (ob.allocatableMinor === null || ob.platformReceiptJournalId === null) {
                const legacyRows = await reader.listPlatformAllocationRows(tenant, obligationId);
                return legacyRows.length > 0
                    ? { ok: false, reason: 'reconciliation_required' }
                    : unavailable;
            }

            // Current, non-reversed, kind-aware allocation proof (recomputed
            // on every call, even when the status is already `allocated`).
            const balance = await readPlatformAllocationBalance(reader, tenant, obligationId);
            if (!balance.ok) {
                if (balance.reason === 'unresolved_reference') return { ok: false, reason: 'unresolved_reference' };
                if (balance.reason === 'purpose_not_allowed') return { ok: false, reason: 'purpose_not_allowed' };
                return unavailable;
            }
            if (
                balance.obligationId !== obligationId
                || balance.requestId !== requestId
                || balance.invoiceId !== expected.invoiceRefId
                || balance.currency !== expected.currency
            ) {
                return { ok: false, reason: 'target_mismatch' };
            }
            if (balance.state === 'reversed_after_allocation') return { ok: false, reason: 'stale_allocation_proof' };
            if (balance.state === 'over_funded') return { ok: false, reason: 'reconciliation_required' };
            if (balance.state !== 'allocated' || ob.status !== 'allocated') return unavailable;
            if (balance.reconciliationStatus === 'discrepancy') return { ok: false, reason: 'reconciliation_required' };

            // 14.3.6 item 4: gross == allocatable == request amount == net allocation.
            if (
                balance.allocatableMinor !== ob.allocatableMinor
                || ob.allocatableMinor !== ob.amountMinor
                || balance.allocatedGrossMinor > expected.amountMinor
                || balance.netAllocatedMinor > expected.amountMinor
            ) {
                return { ok: false, reason: 'reconciliation_required' };
            }
            if (balance.netAllocatedMinor !== expected.amountMinor) {
                return { ok: false, reason: 'stale_allocation_proof' };
            }

            const rows = await reader.listPlatformAllocationRows(tenant, obligationId);
            const payments = rows.filter(
                (row: PaymentAllocationRecord) => row.kind === 'payment'
                    && row.tenantId === tenant
                    && row.obligationId === obligationId
                    && row.invoiceId === expected.invoiceRefId
                    && row.currency === expected.currency,
            );
            const funding = payments[0];
            if (payments.length !== 1 || funding === undefined) return unavailable;
            if (funding.amountMinor !== balance.allocatedGrossMinor) {
                return { ok: false, reason: 'stale_allocation_proof' };
            }

            return {
                ok: true,
                paymentId: obligationId,
                orderId: ob.orderId,
                amountMinor: ob.amountMinor,
                allocatableMinor: ob.allocatableMinor,
                currency: ob.currency,
                purpose: ob.purpose,
                requestId,
                invoiceId: expected.invoiceRefId,
                netAllocatedMinor: balance.netAllocatedMinor,
                allocationId: funding.allocationId,
            };
        } catch (error) {
            if (isMissingSourceCode(error) || isReadOnlyTransactionError(error)) return unavailable;
            if ((error as { code?: unknown } | null)?.code === 'debt_source_unavailable') return unavailable;
            throw lockFailureOf(error) ?? error;
        }
    }

    /**
     * Persist the unique consumption link of one obligation to one request /
     * invoice / allocation in the SAME transaction as the request closing.
     * SAVEPOINT + duplicate-key mapping by REAL constraint name (PRIMARY,
     * uq_platform_link_request, uq_platform_link_allocation); on a mapped
     * duplicate the row of this obligation is re-read FOR SHARE: identical
     * payload => `duplicate_same` (replay), anything else, or no row for this
     * obligation (the request or allocation is already consumed by another
     * obligation) => `duplicate_conflict`. Unmapped errors rethrow raw.
     */
    async insertPaymentRequestLink(link: PaymentRequestLink): Promise<InsertPaymentRequestLinkResult> {
        const tenant = requireBounded(link.tenantId, 'tenantId', MAX_TENANT_LENGTH);
        const obligation = asSettlementObligationId(link.obligationId);
        const orderId = requireBounded(link.orderId, 'orderId', MAX_ORDER_ID_LENGTH);
        const requestId = requireBounded(link.requestId, 'requestId', MAX_REQUEST_ID_LENGTH);
        const invoiceId = requireBounded(link.invoiceId, 'invoiceId', MAX_INVOICE_REF_LENGTH);
        const allocationId = requireBounded(link.allocationId, 'allocationId', MAX_ID_LENGTH);
        const currency = requireBounded(link.currency, 'currency', 3);
        if (typeof link.amountMinor !== 'bigint' || link.amountMinor <= 0n) {
            throw new BillingCollectionSqlError('invalid_row', 'link amountMinor must be a positive bigint');
        }
        await this.conn.execute(`SAVEPOINT ${COLLECTION_LINK_INSERT_SAVEPOINT}`);
        try {
            await this.conn.execute(
                `INSERT INTO platform_payment_request_links (
                        tenant_id, obligation_id, order_id, request_id, invoice_id,
                        allocation_id, currency, amount_minor
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                [tenant, obligation, orderId, requestId, invoiceId, allocationId, currency, link.amountMinor.toString()],
            );
            await this.conn.execute(`RELEASE SAVEPOINT ${COLLECTION_LINK_INSERT_SAVEPOINT}`);
            return 'inserted';
        } catch (error) {
            await this.rollbackToSavepoint(COLLECTION_LINK_INSERT_SAVEPOINT);
            if (isDuplicateError(error)) {
                const keyName = duplicateKeyNameOf(error);
                if (keyName === null || !LINK_DUP_KEYS.has(keyName)) throw error;
            } else {
                const fkName = fkConstraintNameOf(error);
                if (fkName !== null && LINK_FK_NAMES.has(fkName)) {
                    throw new BillingCollectionSqlError(
                        'foreign_key_violation',
                        `platform payment request link insert violated ${fkName}`,
                    );
                }
                throw error;
            }
        }
        // Mapped duplicate: re-read this obligation's link under FOR SHARE (G7).
        const rows = await this.conn.query<PlatformLinkRowDb>(
            `SELECT tenant_id, obligation_id, order_id, request_id, invoice_id,
                    allocation_id, currency, amount_minor
               FROM platform_payment_request_links
              WHERE tenant_id = ? AND obligation_id = ?
              LIMIT 1 FOR SHARE`,
            [tenant, obligation],
        );
        const row = rows[0];
        if (row === undefined) return 'duplicate_conflict';
        const same = row.tenant_id === tenant
            && row.obligation_id === obligation
            && row.order_id === orderId
            && row.request_id === requestId
            && row.invoice_id === invoiceId
            && row.allocation_id === allocationId
            && row.currency === currency
            && normalizeSqlBigInt(row.amount_minor, 'platform_payment_request_links.amount_minor') === link.amountMinor;
        return same ? 'duplicate_same' : 'duplicate_conflict';
    }

    async findByKey(tenantId: string, requestKey: string): Promise<DifferenceRequest | null> {
        const tenant = requireBounded(tenantId, 'tenantId', MAX_TENANT_LENGTH);
        const key = requireBounded(requestKey, 'requestKey', MAX_ID_LENGTH);
        const rows = await this.conn.query<DifferenceRequestRowDb>(
            `SELECT ${REQUEST_COLUMNS}
               FROM billing_difference_requests
              WHERE tenant_id = ? AND request_key = ?
              LIMIT 1`,
            [tenant, key],
        );
        const row = rows[0];
        return row === undefined ? null : requestOfRow(row, tenant);
    }

    async findByBasisKey(tenantId: string, basisKey: string): Promise<DifferenceRequest | null> {
        const tenant = requireBounded(tenantId, 'tenantId', MAX_TENANT_LENGTH);
        const basis = requireHex64(basisKey, 'basisKey');
        const rows = await this.conn.query<DifferenceRequestRowDb>(
            `SELECT ${REQUEST_COLUMNS}
               FROM billing_difference_requests
              WHERE tenant_id = ? AND basis_key = ?
              LIMIT 1`,
            [tenant, basis],
        );
        const row = rows[0];
        return row === undefined ? null : requestOfRow(row, tenant);
    }

    async findByIdForUpdate(tenantId: string, requestId: string): Promise<DifferenceRequest | null> {
        return this.selectByIdForUpdate(tenantId, requestId, ' FOR UPDATE');
    }

    /** Plain NON-locking read (lock-order pre-read for applyVerifiedPayment). */
    async findById(tenantId: string, requestId: string): Promise<DifferenceRequest | null> {
        return this.selectByIdForUpdate(tenantId, requestId, '');
    }

    /**
     * LOCK ORDER steps 1-2 for a payment on a linked request: invoice FOR UPDATE
     * plus its allocations (shared settlement source) BEFORE the request row is
     * locked. Nothing is written.
     */
    async lockInvoiceForPayment(tenantId: string, invoiceRefId: string): Promise<{ readonly ok: boolean }> {
        const tenant = requireBounded(tenantId, 'tenantId', MAX_TENANT_LENGTH);
        const id = requireBounded(invoiceRefId, 'invoiceRefId', MAX_INVOICE_REF_LENGTH);
        const reader = createBoundBillingSettlementSqlTransaction(this.conn, {
            transaction: this.runner,
            audit: () => {
                throw new BillingCollectionSqlError(
                    'invalid_audit',
                    'the read-only invoice lock view must never write an audit row',
                );
            },
        });
        try {
            const outcome = await computeInvoiceOutstanding(reader, tenant, id);
            return { ok: outcome.ok };
        } catch (error) {
            throw lockFailureOf(error) ?? error;
        }
    }

    private async selectByIdForUpdate(
        tenantId: string,
        requestId: string,
        lockSuffix: string,
    ): Promise<DifferenceRequest | null> {
        const tenant = requireBounded(tenantId, 'tenantId', MAX_TENANT_LENGTH);
        const id = requireBounded(requestId, 'requestId', MAX_REQUEST_ID_LENGTH);
        const rows = await this.conn.query<DifferenceRequestRowDb>(
            `SELECT ${REQUEST_COLUMNS}
               FROM billing_difference_requests
              WHERE tenant_id = ? AND id = ?
              LIMIT 1${lockSuffix}`,
            [tenant, id],
        );
        const row = rows[0];
        return row === undefined ? null : requestOfRow(row, tenant);
    }

    async findBySettlementPaymentId(tenantId: string, paymentId: string): Promise<DifferenceRequest | null> {
        const tenant = requireBounded(tenantId, 'tenantId', MAX_TENANT_LENGTH);
        const payment = requireBounded(paymentId, 'paymentId', MAX_PAYMENT_ID_LENGTH);
        const rows = await this.conn.query<DifferenceRequestRowDb>(
            `SELECT ${REQUEST_COLUMNS}
               FROM billing_difference_requests
              WHERE tenant_id = ? AND settled_payment_id = ?
              LIMIT 1`,
            [tenant, payment],
        );
        const row = rows[0];
        return row === undefined ? null : requestOfRow(row, tenant);
    }

    async insertRequest(request: DifferenceRequest): Promise<InsertDifferenceRequestResult> {
        const checked = assertDifferenceRequest(request);
        await this.conn.execute(`SAVEPOINT ${COLLECTION_INSERT_SAVEPOINT}`);
        try {
            await this.conn.execute(REQUEST_INSERT_SQL, [
                checked.requestId,
                checked.tenantId,
                checked.orgKind,
                checked.invoiceId,
                checked.invoiceRefId,
                checked.cycleStart,
                checked.differenceBasis,
                checked.basisKey,
                checked.amountMinor.toString(),
                checked.currency,
                checked.issuedAt,
                checked.deadlineAt,
                checked.status,
                checked.version,
                checked.requestKey,
                checked.payloadHash,
                checked.paidAt,
                checked.settledPaymentId,
                checked.correctionOfRequestId,
                checked.correctionReason,
                checked.correctedByActorId,
            ]);
            await this.conn.execute(`RELEASE SAVEPOINT ${COLLECTION_INSERT_SAVEPOINT}`);
        } catch (error) {
            await this.rollbackToSavepoint();
            if (isDuplicateError(error)) {
                const keyName = duplicateKeyNameOf(error);
                if (keyName !== null && DIFFERENCE_DUP_KEYS.has(keyName)) {
                    return 'duplicate_key';
                }
                throw error;
            }
            const fkName = fkConstraintNameOf(error);
            if (fkName !== null) {
                if (DIFFERENCE_FK_NAMES.has(fkName)) {
                    throw new BillingCollectionSqlError(
                        'foreign_key_violation',
                        `difference request insert violated ${fkName}`,
                    );
                }
                throw error;
            }
            throw error;
        }
        return 'inserted';
    }

    private async rollbackToSavepoint(name: string = COLLECTION_INSERT_SAVEPOINT): Promise<void> {
        await this.conn.execute(`ROLLBACK TO SAVEPOINT ${name}`);
        await this.conn.execute(`RELEASE SAVEPOINT ${name}`);
    }

    async updateStatusCas(input: UpdateStatusCasInput): Promise<UpdateStatusCasResult> {
        const tenant = requireBounded(input.tenantId, 'tenantId', MAX_TENANT_LENGTH);
        const requestId = requireBounded(input.requestId, 'requestId', MAX_REQUEST_ID_LENGTH);
        const expectedVersion = requireNonNegativeSafeInteger(input.expectedVersion, 'expectedVersion');
        if (expectedVersion < 1) {
            throw new BillingCollectionSqlError('invalid_row', 'expectedVersion must be a positive safe integer');
        }
        const toStatus = input.toStatus;
        if (toStatus !== 'paid' && toStatus !== 'expired' && toStatus !== 'cancelled') {
            throw new BillingCollectionSqlError('invalid_row', 'toStatus must be paid, expired or cancelled');
        }
        const paidAt = input.paidAt === null ? null : requireNonNegativeSafeInteger(input.paidAt, 'paidAt');
        const settledPaymentId = input.settledPaymentId === null
            ? null
            : requireBounded(input.settledPaymentId, 'settledPaymentId', MAX_PAYMENT_ID_LENGTH);
        if (toStatus === 'paid') {
            if (paidAt === null || settledPaymentId === null) {
                throw new BillingCollectionSqlError(
                    'invalid_row',
                    'a CAS transition to paid requires paidAt and settledPaymentId',
                );
            }
        } else if (paidAt !== null || settledPaymentId !== null) {
            throw new BillingCollectionSqlError(
                'invalid_row',
                'only a CAS transition to paid may carry settlement fields',
            );
        }

        const fromStatuses = CAS_FROM_STATUSES[toStatus];
        const statusPredicate = fromStatuses.length === 1
            ? 'status = ?'
            : `status IN (${fromStatuses.map(() => '?').join(', ')})`;
        const result = await this.conn.execute(
            `UPDATE billing_difference_requests
                SET status = ?, paid_at = ?, settled_payment_id = ?, version = version + 1
              WHERE tenant_id = ? AND id = ? AND version = ? AND ${statusPredicate}`,
            [toStatus, paidAt, settledPaymentId, tenant, requestId, expectedVersion, ...fromStatuses],
        );
        const affected = requireCasAffectedRows(result.affectedRows);
        if (affected === 1) {
            const updated = await this.selectByIdForUpdate(tenant, requestId, '');
            if (updated === null) {
                throw new BillingCollectionSqlError('invalid_row', 'a successfully updated difference request disappeared before readback');
            }
            return { ok: true, request: updated };
        }
        if (affected !== 0) {
            throw new BillingCollectionSqlError(
                'store_overrun',
                `the CAS UPDATE reported ${affected} affected rows where exactly one was possible`,
            );
        }
        const current = await this.selectByIdForUpdate(tenant, requestId, '');
        if (current === null) return { ok: false, reason: 'not_found' };
        if (current.version !== expectedVersion) return { ok: false, reason: 'version_conflict' };
        return { ok: false, reason: 'invalid_transition' };
    }

    async listOpenForTenant(tenantId: string, query?: { readonly limit?: number }): Promise<DifferenceRequestPage> {
        const tenant = requireBounded(tenantId, 'tenantId', MAX_TENANT_LENGTH);
        const limit = query?.limit === undefined ? DEFAULT_LIST_LIMIT : query.limit;
        if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT) {
            throw new BillingCollectionSqlError(
                'store_overrun',
                `limit must be an integer between 1 and ${MAX_LIST_LIMIT}`,
            );
        }
        const rows = await this.conn.query<DifferenceRequestRowDb>(
            `SELECT ${REQUEST_COLUMNS}
               FROM billing_difference_requests
              WHERE tenant_id = ? AND status = 'open'
              ORDER BY deadline_at ASC, id ASC
              LIMIT ?`,
            [tenant, limit + COLLECTION_LIST_READ_HEADROOM],
        );
        const truncated = rows.length > limit;
        const requests: DifferenceRequest[] = [];
        for (const row of rows.slice(0, limit)) {
            requests.push(requestOfRow(row, tenant));
        }
        return { requests, truncated };
    }
}

export interface BillingCollectionSqlStore extends CollectionStore {
    /** Bind the transaction handle (and its audit writer) to one open connection. */
    inTransaction(conn: CollectionSqlConnection): BillingCollectionSqlTransaction;
    runAtomic<T>(callback: (tx: BillingCollectionSqlTransaction) => Promise<T>): Promise<T>;
}

class BillingCollectionSqlStoreImpl implements BillingCollectionSqlStore {
    private readonly audit: CollectionSqlAuditSink;

    constructor(
        private readonly deps: CollectionSqlDeps,
    ) {
        if (!deps || typeof deps.transaction !== 'function') {
            throw new BillingCollectionSqlError(
                'invalid_runner',
                'BillingCollectionSqlStore requires a connection-bound transaction runner',
            );
        }
        if (typeof deps.audit !== 'function') {
            throw new BillingCollectionSqlError(
                'invalid_audit',
                'BillingCollectionSqlStore requires the sealed connection-bound audit writer',
            );
        }
        this.audit = deps.audit;
    }

    inTransaction(conn: CollectionSqlConnection): BillingCollectionSqlTransaction {
        return new BillingCollectionSqlTransactionImpl(conn, this.audit, this.deps.transaction);
    }

    runAtomic<T>(callback: (tx: BillingCollectionSqlTransaction) => Promise<T>): Promise<T> {
        return this.deps.transaction((conn) => callback(this.inTransaction(conn)));
    }
}

export const createBillingCollectionSqlStore = (deps: CollectionSqlDeps): BillingCollectionSqlStore =>
    new BillingCollectionSqlStoreImpl(deps);

export const createBoundCollectionSqlTransaction = (
    conn: CollectionSqlConnection,
    deps: CollectionSqlDeps,
): BillingCollectionSqlTransaction => new BillingCollectionSqlStoreImpl(deps).inTransaction(conn);
