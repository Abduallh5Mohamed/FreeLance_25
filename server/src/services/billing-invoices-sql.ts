/**
 * PATH-B6 (registered expansion X5) — real SQL adapter for `InvoiceStore`.
 *
 * Implements `InvoiceStore` / `InvoiceTransaction` (billing-invoices.ts) and
 * the invoice-issuance audit binding against:
 *   billing_invoices, billing_invoice_lines, billing_price_version_snapshots,
 *   billing_offer_snapshots and the `invoice_id` extension of
 *   billing_idempotency_keys
 * from migration `20261022_02_billing_invoices_collections.sql`. Real table,
 * index and FK constraint names come verbatim from that migration source:
 *   uq_billing_invoice_cycle (tenant_id, org_kind, cycle_start)
 *   uq_billing_invoice_number (tenant_id, invoice_number)
 *   uq_billing_invoice_id_tenant (id, tenant_id)
 *   fk_billing_invoice_tenant / fk_billing_invoice_price_snapshot /
 *   fk_billing_invoice_offer_snapshot / fk_billing_line_invoice
 * and, for HK1, the registry PK (tenant_id, scope, idempotency_key) named
 * 'PRIMARY', the extension 'uq_billing_idem_invoice' and
 * 'fk_billing_idem_invoice'. Whether the live MySQL 8 driver messages carry
 * exactly these names per statement remains a live-run question.
 *
 * SOURCE CODE ONLY. Nothing here executes SQL or opens a connection. Every
 * statement of a unit of work is issued on the caller-injected transaction
 * connection; there is no pooled query and no autocommit fallback. A missing
 * runner or audit writer throws at construction, before any statement.
 *
 * IMMUTABILITY: issued invoice, line and snapshot rows are INSERT-ONLY. The
 * adapter exposes no UPDATE/DELETE path and, as a hard runtime guard, rejects
 * any UPDATE/DELETE/REPLACE/TRUNCATE statement whose target is one of the four
 * issued tables (`assertIssuedRowImmutability`); corrections are new documents.
 *
 * MONEY (HK2): exact integer minor units only. BIGINT columns may arrive as
 * bigint, decimal string or exactly-representable safe number;
 * `normalizeSqlBigInt` (the shared HK2 normalizer exported by
 * billing-ledger-sql.ts; its typed invariant errors are rethrown untranslated)
 * rejects every other shape and never routes money through `Number()`.
 * Required mysql2 options for the production binding:
 * `supportBigNumbers: true`, `bigNumberStrings: true` — the adapter is
 * value-shape safe either way.
 *
 * HK1: idempotent issuance resolves through `billing_idempotency_keys`
 * `(tenant_id, scope, idempotency_key)` (the frozen registry; its scope column
 * is VARCHAR(32) and 'billing.invoice.issue.v1' is 24 chars); the
 * payload-hash replay-vs-conflict comparison and the invoice cross-check are
 * domain work (`issueInvoice` in billing-invoices.ts:764-811); the adapter
 * only serves and writes registry rows honestly with journal_id /
 * reservation_id bound to SQL NULL per chk_billing_idem_invoice.
 *
 * AUDIT: the adapter never writes an audit row itself and has no no-op.
 * `writeAudit` on the transaction handle is the ONLY path and routes to the
 * REQUIRED constructor-injected connection-bound sealed sink. For the domain
 * flow `issueInvoice`, whose per-command `options.audit`
 * (billing-invoices.ts:824-835) cannot reach a transaction handle by itself,
 * `createInvoiceIssueSqlBinder` wires that writer onto the SAME transaction
 * connection; the production binding must be the sealed writer (wiring is not
 * this task's write).
 *
 * HELD CONTRACT QUESTION (recorded, never guessed): the FKs
 * fk_billing_invoice_price_snapshot / fk_billing_invoice_offer_snapshot make
 * the snapshot rows part of the issuing transaction (B3 contract §3.1), but
 * `InvoiceTransaction` (billing-invoices.ts:184-203) has no snapshot
 * persistence seam and `issueInvoice` (billing-invoices.ts:763-838) never
 * forwards `IssueInvoiceCommand.priceSnapshot` / `.offerSnapshot`
 * (billing-invoices.ts:165-167) to the store. The adapter therefore exposes
 * `persistPriceVersionSnapshot` / `persistOfferSnapshot` ON the transaction
 * handle (same conn) and the store-contract extension is an expansion request;
 * refs alone cannot rebuild the captured content, so no snapshot row is ever
 * fabricated here.
 */

import {
    assertInvoice,
    BillingInvoiceError,
    DEFAULT_LIST_LIMIT,
    deriveInvoiceChargeComposition,
    issueInvoice,
    Invoice,
    InvoiceAuditRecord,
    InvoiceIdempotencyRecord,
    type InvoiceObligationInsertResult,
    type InvoiceObligationRecord,
    type InvoiceReceivableLink,
    InvoicePage,
    InvoiceStore,
    InvoiceTransaction,
    MAX_IDEMPOTENCY_KEY_LENGTH,
    MAX_LIST_LIMIT,
    type IssueInvoiceCommand,
    type IssueInvoiceOptions,
    type IssueInvoiceResult,
    verifyInvoiceIssuanceJournal,
} from './billing-invoices';
import {
    postJournalInTransaction,
    type AccountKind,
    type JournalRecord,
    type LedgerAccount,
    type PostJournalInput,
    type PostJournalResult,
} from './billing-ledger';
import { CYCLE_SECONDS } from './billing-periods';
import { BILLING_ORGANIZATIONS, type BillingOrganization } from './billing-pricing';
import {
    MAX_OFFER_PAYLOAD_LENGTH,
    serializeCapturedPriceContent,
    type OfferSnapshot,
    type PriceVersionSnapshot,
} from './billing-snapshots';
import { createBoundBillingLedgerSqlTransaction, normalizeSqlBigInt } from './billing-ledger-sql';
import type { ReservationTransaction } from './billing-reservations';

export interface BillingInvoiceSqlConnection {
    query<T = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<T[]>;
    execute(
        sql: string,
        params?: readonly unknown[],
    ): Promise<{ affectedRows?: number | string; insertId?: number | string }>;
}

export type BillingInvoiceSqlTransactionRunner = <T>(
    fn: (conn: BillingInvoiceSqlConnection) => Promise<T>,
) => Promise<T>;

/**
 * REQUIRED audit sink bound to one open transaction connection. There is no
 * default and no no-op: production MUST inject the sealed writer whose row
 * lands on the same connection/transaction as the issued invoice.
 */
export type BillingInvoiceSqlAuditSink = (
    conn: BillingInvoiceSqlConnection,
    record: InvoiceAuditRecord,
) => Promise<void>;

export interface BillingInvoiceSqlDeps {
    transaction: BillingInvoiceSqlTransactionRunner;
    audit: BillingInvoiceSqlAuditSink;
}

export type BillingInvoiceSqlErrorCode =
    | 'invalid_runner'
    | 'invalid_audit'
    | 'invalid_row'
    | 'store_overrun'
    | 'duplicate_key'
    | 'foreign_key_violation'
    | 'snapshot_hash_conflict'
    | 'journal_not_found'
    | 'immutable_statement';

export class BillingInvoiceSqlError extends Error {
    constructor(public readonly code: BillingInvoiceSqlErrorCode, message: string) {
        super(message);
        this.name = 'BillingInvoiceSqlError';
    }
}

/** Preserve numeric/string connection contracts without permissive coercion. */
const requireInsertAffectedRows = (raw: unknown): number => {
    const value = typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : raw;
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
        throw new BillingInvoiceSqlError('invalid_row', 'INSERT has no readable non-negative integer affectedRows');
    }
    return value;
};

/** Registry `scope` column bound (billing_idempotency_keys.scope VARCHAR(32)). */
export const MAX_IDEMPOTENCY_SCOPE_LENGTH = 32;
/** Bounded listing always reads one row beyond the cap to detect truncation. */
export const INVOICE_LIST_READ_HEADROOM = 1;

const INVOICE_COLUMNS = `id, tenant_id, org_kind, billing_phase, cycle_start,
    total_minor, minor_units_per_major, currency, invoice_number, model_version,
    payload_hash, price_snapshot_id, price_version_id, price_content_hash,
    offer_snapshot_id, offer_version_label, offer_payload_hash,
    offer_effective_from, offer_pricing_effect`;

const LINE_COLUMNS = `line_id, kind, segment_start, segment_end,
    registration_count, numerator_minor_seconds, denominator_seconds`;

const INVOICE_INSERT_SQL = `INSERT INTO billing_invoices (
        id, tenant_id, org_kind, billing_phase, cycle_start, total_minor,
        minor_units_per_major, currency, invoice_number, model_version,
        payload_hash, price_snapshot_id, price_version_id, price_content_hash,
        offer_snapshot_id, offer_version_label, offer_payload_hash,
        offer_effective_from, offer_pricing_effect
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

const LINE_INSERT_SQL = `INSERT INTO billing_invoice_lines (
        tenant_id, invoice_id, line_id, kind, segment_start, segment_end,
        registration_count, numerator_minor_seconds, denominator_seconds
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;

export const INVOICE_INSERT_SAVEPOINT = 'billing_invoice_insert';

export const ISSUED_IMMUTABLE_TABLES =
    'billing_invoices | billing_invoice_lines | billing_price_version_snapshots | billing_offer_snapshots | billing_invoice_obligations';

const IMMUTABLE_TABLE_PATTERN
    = /^(?:UPDATE\b|DELETE\s+FROM\b|REPLACE\s+INTO\b|TRUNCATE\b)[^;]*(?:billing_invoices|billing_invoice_lines|billing_price_version_snapshots|billing_offer_snapshots|billing_invoice_obligations)\b/i;

/**
 * Runtime guard: issued rows are immutable; statements writing them fail
 * CLOSED even if a future code path tried to add one.
 */
export const assertIssuedRowImmutability = (sql: string): void => {
    const text = `${sql.replace(/^\s+/, '')}`.replace(/\s+$/, '');
    if (IMMUTABLE_TABLE_PATTERN.test(text)) {
        throw new BillingInvoiceSqlError(
            'immutable_statement',
            `issued invoice, line and snapshot rows are INSERT-only (${ISSUED_IMMUTABLE_TABLES}); corrections are new documents`,
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

const requireBounded = (value: unknown, field: string, maxLength: number): string => {
    if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) {
        throw new BillingInvoiceSqlError(
            'invalid_row',
            `${field} must be a non-empty string of at most ${maxLength} characters`,
        );
    }
    return value;
};

const requireHex64 = (value: unknown, field: string): string => {
    const text = requireBounded(value, field, 128);
    if (!HEX_64.test(text)) {
        throw new BillingInvoiceSqlError('invalid_row', `${field} must be a lowercase SHA-256 hex string`);
    }
    return text;
};

const requireNonNegativeSafeInteger = (value: unknown, field: string): number => {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
        throw new BillingInvoiceSqlError('invalid_row', `${field} must be a non-negative safe integer`);
    }
    return value;
};

const requirePositiveSafeInteger = (value: unknown, field: string): number => {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
        throw new BillingInvoiceSqlError('invalid_row', `${field} must be a positive safe integer`);
    }
    return value;
};

/** HK2 read path for BIGINT seconds columns: exact integer, safe range. */
const normalizeSqlSeconds = (value: unknown, field: string): number => {
    const normalized = normalizeSqlBigInt(value, field);
    if (normalized > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new BillingInvoiceSqlError('invalid_row', `${field} exceeds the safe integer second range`);
    }
    return Number(normalized);
};

const requireOrgKind = (value: string): BillingOrganization => {
    if (!(BILLING_ORGANIZATIONS as readonly string[]).includes(value)) {
        throw new BillingInvoiceSqlError('invalid_row', 'an invoice row has an unknown organization kind');
    }
    return value as BillingOrganization;
};

interface InvoiceRowDb {
    id: string;
    tenant_id: string;
    org_kind: string;
    billing_phase: string;
    cycle_start: unknown;
    total_minor: unknown;
    minor_units_per_major: unknown;
    currency: string;
    invoice_number: string;
    model_version: unknown;
    payload_hash: string;
    price_snapshot_id: string;
    price_version_id: string;
    price_content_hash: string;
    offer_snapshot_id: string | null;
    offer_version_label: string | null;
    offer_payload_hash: string | null;
    offer_effective_from: unknown;
    offer_pricing_effect: string | null;
}

interface LineRowDb {
    line_id: string;
    kind: string;
    segment_start: unknown;
    segment_end: unknown;
    registration_count: unknown;
    numerator_minor_seconds: unknown;
    denominator_seconds: unknown;
}

interface IdempotencyRowDb {
    tenant_id: string;
    scope: string;
    idempotency_key: string;
    payload_hash: string;
    invoice_id: string | null;
}

const INVOICE_DUP_KEYS = new Set([
    'uq_billing_invoice_cycle',
    'uq_billing_invoice_number',
    'uq_billing_invoice_id_tenant',
]);

const INVOICE_FK_NAMES = new Set([
    'fk_billing_invoice_tenant',
    'fk_billing_invoice_price_snapshot',
    'fk_billing_invoice_offer_snapshot',
    'fk_billing_line_invoice',
]);

const REGISTRY_DUP_KEYS = new Set(['PRIMARY', 'uq_billing_idem_invoice']);

const REGISTRY_FK_NAMES = new Set(['fk_billing_idem_tenant', 'fk_billing_idem_invoice']);

const SNAPSHOT_FK_NAMES = new Set(['fk_price_snapshot_tenant', 'fk_offer_snapshot_tenant']);

/** billing_invoice_journals (20261023_01 step 8): PK invoice_id + two tenant-scoped uniques. */
const INVOICE_JOURNAL_DUP_KEYS = new Set([
    'PRIMARY',
    'uq_billing_invoice_journal_invoice',
    'uq_billing_invoice_journal_journal',
]);

const INVOICE_JOURNAL_FK_NAMES = new Set([
    'fk_billing_invoice_journal_tenant',
    'fk_billing_invoice_journal_invoice',
    'fk_billing_invoice_journal_journal',
]);

/** billing_invoice_obligations (20261023_03, contract 14.8.7): PK invoice_id + (invoice_id, tenant_id) unique. */
const INVOICE_OBLIGATION_DUP_KEYS = new Set(['PRIMARY', 'uq_billing_invoice_obligation_invoice']);

const INVOICE_OBLIGATION_FK_NAMES = new Set([
    'fk_billing_invoice_obligation_tenant',
    'fk_billing_invoice_obligation_invoice',
]);

const OBLIGATION_COLUMNS = `invoice_id, tenant_id, currency, new_charge_minor,
    carried_debt_reference_minor, composition_version, issued_at, due_status,
    due_at, due_basis_ref, due_basis_version`;

interface ObligationRowDb {
    invoice_id: string;
    tenant_id: string;
    currency: string;
    new_charge_minor: unknown;
    carried_debt_reference_minor: unknown;
    composition_version: unknown;
    issued_at: unknown;
    due_status: unknown;
    due_at: unknown;
    due_basis_ref: unknown;
    due_basis_version: unknown;
}

const MAX_OBLIGATION_AMOUNT_MINOR = 1_000_000_000_000_000n;

const safeIntegerOf = (value: unknown, field: string): number => {
    const parsed = normalizeSqlBigInt(value, field, { max: BigInt(Number.MAX_SAFE_INTEGER) });
    return Number(parsed);
};

const toObligationRecord = (row: ObligationRowDb): InvoiceObligationRecord => {
    if (row.due_status !== 'resolved' && row.due_status !== 'unresolved') {
        throw new BillingInvoiceSqlError('invalid_row', 'an invoice obligation row has an unknown due status');
    }
    const resolved = row.due_status === 'resolved';
    const dueAt = row.due_at === null || row.due_at === undefined ? null : safeIntegerOf(row.due_at, 'due_at');
    const dueBasisVersion = row.due_basis_version === null || row.due_basis_version === undefined
        ? null
        : safeIntegerOf(row.due_basis_version, 'due_basis_version');
    const dueBasisRef = row.due_basis_ref === null || row.due_basis_ref === undefined
        ? null
        : requireBounded(row.due_basis_ref, 'due_basis_ref', 128);
    if (resolved !== (dueAt !== null && dueBasisRef !== null && dueBasisVersion !== null)
        || (!resolved && (dueAt !== null || dueBasisRef !== null || dueBasisVersion !== null))) {
        throw new BillingInvoiceSqlError('invalid_row', 'an invoice obligation row has inconsistent due columns');
    }
    return {
        tenantId: requireBounded(row.tenant_id, 'billing_invoice_obligations.tenant_id', 36),
        invoiceId: requireBounded(row.invoice_id, 'billing_invoice_obligations.invoice_id', 36),
        currency: requireBounded(row.currency, 'billing_invoice_obligations.currency', 3),
        newChargeMinor: normalizeSqlBigInt(row.new_charge_minor, 'new_charge_minor', { max: MAX_OBLIGATION_AMOUNT_MINOR }),
        carriedDebtReferenceMinor: normalizeSqlBigInt(
            row.carried_debt_reference_minor,
            'carried_debt_reference_minor',
            { max: MAX_OBLIGATION_AMOUNT_MINOR },
        ),
        compositionVersion: safeIntegerOf(row.composition_version, 'composition_version'),
        issuedAt: safeIntegerOf(row.issued_at, 'issued_at'),
        dueStatus: row.due_status,
        dueAt,
        dueBasisRef,
        dueBasisVersion,
    };
};

export interface PriceSnapshotRowInput {
    readonly snapshotId: string;
    readonly modelVersion: number;
    readonly versionLabel: string;
    readonly effectiveFrom: number;
    readonly contentHash: string;
    /** Frozen canonical JSON content (BIGINT amounts already decimal strings). */
    readonly content: string;
}

/**
 * The adapter accepts either the persistence row shape (used by the low-level
 * binder tests) or the domain snapshot object passed by `issueInvoice`.
 */
export type PriceSnapshotPersistInput = PriceSnapshotRowInput | PriceVersionSnapshot;

function toPriceSnapshotRow(
    tenantId: string,
    input: PriceSnapshotPersistInput,
): PriceSnapshotRowInput {
    const record = input as unknown as Record<string, unknown>;
    if (typeof record['snapshotId'] === 'string') {
        return input as PriceSnapshotRowInput;
    }
    const domain = input as PriceVersionSnapshot;
    return {
        snapshotId: domain.id,
        modelVersion: domain.modelVersion,
        versionLabel: domain.versionLabel,
        effectiveFrom: domain.effectiveFrom,
        contentHash: domain.contentHash,
        content: serializeCapturedPriceContent(domain.content),
    };
}

export interface OfferSnapshotRowInput {
    readonly snapshotId: string;
    readonly modelVersion: number;
    readonly versionLabel: string | null;
    readonly effectiveFrom: number;
    readonly effectiveUntil: number | null;
    /** Frozen canonical JSON payload, at most MAX_OFFER_PAYLOAD_LENGTH chars. */
    readonly payload: string;
    readonly payloadHash: string;
}

export type OfferSnapshotPersistInput = OfferSnapshotRowInput | OfferSnapshot;

function toOfferSnapshotRow(input: OfferSnapshotPersistInput): OfferSnapshotRowInput {
    const record = input as unknown as Record<string, unknown>;
    if (typeof record['snapshotId'] === 'string') {
        return input as OfferSnapshotRowInput;
    }
    const domain = input as OfferSnapshot;
    return {
        snapshotId: domain.id,
        modelVersion: domain.modelVersion,
        versionLabel: domain.versionLabel,
        effectiveFrom: domain.effectiveFrom,
        effectiveUntil: domain.effectiveUntil,
        payload: domain.payload,
        payloadHash: domain.payloadHash,
    };
}

export interface BillingInvoiceSqlTransaction extends InvoiceTransaction {
    /**
     * The ONLY invoice-issuance audit path: routes the sealed record through
     * the required constructor sink on THIS transaction's connection.
     */
    writeAudit(record: InvoiceAuditRecord): Promise<void>;
    /**
     * Persist one immutable captured price-version snapshot (FK target of
     * `fk_billing_invoice_price_snapshot`) on the same connection. A duplicate
     * PK with the SAME content hash is idempotent; a different hash is a typed
     * `snapshot_hash_conflict` (value mismatch on an immutable row).
     */
    persistPriceVersionSnapshot(tenantId: string, snapshot: PriceSnapshotPersistInput): Promise<void>;
    /** Persist one immutable offer snapshot (FK target of fk_billing_invoice_offer_snapshot). */
    persistOfferSnapshot(tenantId: string, snapshot: OfferSnapshotPersistInput): Promise<void>;
}

class BillingInvoiceSqlConn implements BillingInvoiceSqlConnection {
    constructor(
        private readonly raw: BillingInvoiceSqlConnection,
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

const billingPhaseOf = (row: InvoiceRowDb): 'first' | 'recurring' => {
    if (row.billing_phase !== 'first' && row.billing_phase !== 'recurring') {
        throw new BillingInvoiceSqlError('invalid_row', 'an invoice row has an unknown billing phase');
    }
    return row.billing_phase;
};

class BillingInvoiceSqlTransactionImpl implements BillingInvoiceSqlTransaction {
    private readonly conn: BillingInvoiceSqlConn;
    /** The accepted ledger adapter bound to THIS connection (same transaction). */
    private readonly ledger: ReservationTransaction;

    constructor(
        conn: BillingInvoiceSqlConnection,
        private readonly audit: BillingInvoiceSqlAuditSink,
        runner: BillingInvoiceSqlTransactionRunner,
    ) {
        this.conn = new BillingInvoiceSqlConn(conn, assertIssuedRowImmutability);
        this.ledger = createBoundBillingLedgerSqlTransaction(this.conn, { transaction: runner });
    }

    getJournal(tenantId: string, journalId: string): Promise<JournalRecord | null> {
        return this.ledger.getJournal(tenantId, journalId);
    }

    findJournalByIdempotencyKey(tenantId: string, idempotencyKey: string): Promise<JournalRecord | null> {
        return this.ledger.findJournalByIdempotencyKey(tenantId, idempotencyKey);
    }

    provisionAccountIdempotent(tenantId: string, kind: AccountKind, currency: string): Promise<LedgerAccount> {
        const delegate = this.ledger.provisionAccountIdempotent;
        if (typeof delegate !== 'function') {
            throw new BillingInvoiceSqlError(
                'invalid_row',
                'the wrapped ledger transaction does not provide provisionAccountIdempotent',
            );
        }
        return delegate.call(this.ledger, tenantId, kind, currency);
    }

    /** The accepted ledger posting (idempotent by key) on the invoice connection. */
    postJournal(input: PostJournalInput): Promise<PostJournalResult> {
        return postJournalInTransaction(this.ledger, input);
    }

    /**
     * Insert-only composition/due terms. A duplicate (PRIMARY or the
     * (invoice_id, tenant_id) unique) is never an overwrite: the stored row is
     * re-read `FOR SHARE` and returned so the domain can compare.
     */
    async insertInvoiceObligation(record: InvoiceObligationRecord): Promise<InvoiceObligationInsertResult> {
        const tenantId = requireBounded(record.tenantId, 'obligation.tenantId', 36);
        const invoiceId = requireBounded(record.invoiceId, 'obligation.invoiceId', 36);
        const currency = requireBounded(record.currency, 'obligation.currency', 3);
        if (typeof record.newChargeMinor !== 'bigint' || record.newChargeMinor <= 0n
            || record.newChargeMinor > MAX_OBLIGATION_AMOUNT_MINOR) {
            throw new BillingInvoiceSqlError('invalid_row', 'obligation.newChargeMinor must be a positive bigint within 10^15');
        }
        if (typeof record.carriedDebtReferenceMinor !== 'bigint' || record.carriedDebtReferenceMinor < 0n
            || record.carriedDebtReferenceMinor > MAX_OBLIGATION_AMOUNT_MINOR) {
            throw new BillingInvoiceSqlError('invalid_row', 'obligation.carriedDebtReferenceMinor must be a bigint within 0..10^15');
        }
        const compositionVersion = requirePositiveSafeInteger(record.compositionVersion, 'obligation.compositionVersion');
        const issuedAt = requireNonNegativeSafeInteger(record.issuedAt, 'obligation.issuedAt');
        let dueAt: number | null = null;
        let dueBasisRef: string | null = null;
        let dueBasisVersion: number | null = null;
        if (record.dueStatus === 'resolved') {
            dueAt = requireNonNegativeSafeInteger(record.dueAt, 'obligation.dueAt');
            dueBasisRef = requireBounded(record.dueBasisRef, 'obligation.dueBasisRef', 128);
            dueBasisVersion = requirePositiveSafeInteger(record.dueBasisVersion, 'obligation.dueBasisVersion');
        } else if (record.dueStatus === 'unresolved') {
            if (record.dueAt !== null || record.dueBasisRef !== null || record.dueBasisVersion !== null) {
                throw new BillingInvoiceSqlError('invalid_row', 'unresolved obligation terms must not carry due values');
            }
        } else {
            throw new BillingInvoiceSqlError('invalid_row', 'obligation.dueStatus must be resolved or unresolved');
        }
        const checked: InvoiceObligationRecord = {
            tenantId,
            invoiceId,
            currency,
            newChargeMinor: record.newChargeMinor,
            carriedDebtReferenceMinor: record.carriedDebtReferenceMinor,
            compositionVersion,
            issuedAt,
            dueStatus: record.dueStatus,
            dueAt,
            dueBasisRef,
            dueBasisVersion,
        };
        try {
            const result = await this.conn.execute(
                `INSERT INTO billing_invoice_obligations (
                    invoice_id, tenant_id, currency, new_charge_minor,
                    carried_debt_reference_minor, composition_version, issued_at,
                    due_status, due_at, due_basis_ref, due_basis_version
                 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    invoiceId,
                    tenantId,
                    currency,
                    checked.newChargeMinor.toString(),
                    checked.carriedDebtReferenceMinor.toString(),
                    compositionVersion,
                    issuedAt,
                    checked.dueStatus,
                    dueAt,
                    dueBasisRef,
                    dueBasisVersion,
                ],
            );
            if (requireInsertAffectedRows(result.affectedRows) !== 1) {
                throw new BillingInvoiceSqlError(
                    'store_overrun',
                    'the invoice obligation INSERT did not affect exactly one row',
                );
            }
        } catch (error) {
            if (isForeignKeyError(error)) {
                const fkName = fkConstraintNameOf(error);
                if (fkName !== null && INVOICE_OBLIGATION_FK_NAMES.has(fkName)) {
                    throw new BillingInvoiceSqlError(
                        'foreign_key_violation',
                        `the invoice obligation insert violated ${fkName}`,
                    );
                }
                throw error;
            }
            if (isDuplicateError(error)) {
                const keyName = duplicateKeyNameOf(error);
                if (keyName !== null && INVOICE_OBLIGATION_DUP_KEYS.has(keyName)) {
                    const stored = await this.readObligation(tenantId, invoiceId, true);
                    if (stored === null) {
                        throw new BillingInvoiceSqlError(
                            'invalid_row',
                            'a duplicate invoice obligation cannot be read back inside the transaction',
                        );
                    }
                    return { outcome: 'duplicate', stored };
                }
                throw error;
            }
            throw error;
        }
        return { outcome: 'inserted', stored: checked };
    }

    async findInvoiceObligation(tenantId: string, invoiceId: string): Promise<InvoiceObligationRecord | null> {
        return this.readObligation(
            requireBounded(tenantId, 'tenantId', 36),
            requireBounded(invoiceId, 'invoiceId', 36),
            false,
        );
    }

    private async readObligation(
        tenantId: string,
        invoiceId: string,
        lockShared: boolean,
    ): Promise<InvoiceObligationRecord | null> {
        const rows = await this.conn.query<ObligationRowDb>(
            `SELECT ${OBLIGATION_COLUMNS}
               FROM billing_invoice_obligations
              WHERE tenant_id = ? AND invoice_id = ?
              LIMIT 1${lockShared ? '\n              FOR SHARE' : ''}`,
            [tenantId, invoiceId],
        );
        const row = rows[0];
        if (row === undefined) return null;
        if (row.tenant_id !== tenantId || row.invoice_id !== invoiceId) {
            throw new BillingInvoiceSqlError('invalid_row', 'an invoice obligation row is outside the requested key');
        }
        return toObligationRecord(row);
    }

    async writeAudit(record: InvoiceAuditRecord): Promise<void> {
        await this.audit(this.conn, record);
    }

    async persistPriceVersionSnapshot(tenantId: string, input: PriceSnapshotPersistInput): Promise<void> {
        const snapshot = toPriceSnapshotRow(tenantId, input);
        const tenant = requireBounded(tenantId, 'tenantId', 36);
        const snapshotId = requireBounded(snapshot.snapshotId, 'snapshot.snapshotId', 128);
        const modelVersion = requirePositiveSafeInteger(snapshot.modelVersion, 'snapshot.modelVersion');
        const versionLabel = requireBounded(snapshot.versionLabel, 'snapshot.versionLabel', 128);
        const effectiveFrom = requireNonNegativeSafeInteger(snapshot.effectiveFrom, 'snapshot.effectiveFrom');
        const contentHash = requireHex64(snapshot.contentHash, 'snapshot.contentHash');
        if (typeof snapshot.content !== 'string' || snapshot.content.length === 0) {
            throw new BillingInvoiceSqlError('invalid_row', 'snapshot.content must be the frozen canonical JSON text');
        }
        try {
            await this.conn.execute(
                `INSERT INTO billing_price_version_snapshots
                    (tenant_id, snapshot_id, model_version, version_label, effective_from, content_hash, content)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`,
                [tenant, snapshotId, modelVersion, versionLabel, effectiveFrom, contentHash, snapshot.content],
            );
        } catch (error) {
            const fkName = fkConstraintNameOf(error);
            if (fkName !== null) {
                if (SNAPSHOT_FK_NAMES.has(fkName)) {
                    throw new BillingInvoiceSqlError('foreign_key_violation', `price snapshot insert violated ${fkName}`);
                }
                throw error;
            }
            if (isDuplicateError(error)) {
                const rows = await this.conn.query<{ content_hash: string }>(
                    `SELECT content_hash FROM billing_price_version_snapshots
                      WHERE tenant_id = ? AND snapshot_id = ? LIMIT 1`,
                    [tenant, snapshotId],
                );
                const stored = rows[0];
                if (stored === undefined) {
                    throw new BillingInvoiceSqlError('invalid_row', 'a price snapshot duplicate could not be read back');
                }
                if (stored.content_hash !== contentHash) {
                    throw new BillingInvoiceSqlError(
                        'snapshot_hash_conflict',
                        'the price snapshot id is immutable and stores another content hash',
                    );
                }
                return;
            }
            throw error;
        }
    }

    async persistOfferSnapshot(tenantId: string, input: OfferSnapshotPersistInput): Promise<void> {
        const snapshot = toOfferSnapshotRow(input);
        const tenant = requireBounded(tenantId, 'tenantId', 36);
        const snapshotId = requireBounded(snapshot.snapshotId, 'snapshot.snapshotId', 128);
        const modelVersion = requirePositiveSafeInteger(snapshot.modelVersion, 'snapshot.modelVersion');
        const effectiveFrom = requireNonNegativeSafeInteger(snapshot.effectiveFrom, 'snapshot.effectiveFrom');
        const effectiveUntil = snapshot.effectiveUntil === null
            ? null
            : requireNonNegativeSafeInteger(snapshot.effectiveUntil, 'snapshot.effectiveUntil');
        if (effectiveUntil !== null && effectiveUntil < effectiveFrom) {
            throw new BillingInvoiceSqlError(
                'invalid_row',
                'snapshot.effectiveUntil must not precede effectiveFrom (chk_offer_snapshot_window)',
            );
        }
        const versionLabel = snapshot.versionLabel === null
            ? null
            : requireBounded(snapshot.versionLabel, 'snapshot.versionLabel', 128);
        if (
            typeof snapshot.payload !== 'string'
            || snapshot.payload.length === 0
            || snapshot.payload.length > MAX_OFFER_PAYLOAD_LENGTH
        ) {
            throw new BillingInvoiceSqlError(
                'invalid_row',
                `snapshot.payload must be a non-empty JSON text of at most ${MAX_OFFER_PAYLOAD_LENGTH} characters`,
            );
        }
        const payloadHash = requireHex64(snapshot.payloadHash, 'snapshot.payloadHash');
        try {
            await this.conn.execute(
                `INSERT INTO billing_offer_snapshots
                    (tenant_id, snapshot_id, model_version, version_label, effective_from,
                     effective_until, payload, payload_hash, pricing_effect)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'held_not_settled')`,
                [tenant, snapshotId, modelVersion, versionLabel, effectiveFrom, effectiveUntil, snapshot.payload, payloadHash],
            );
        } catch (error) {
            const fkName = fkConstraintNameOf(error);
            if (fkName !== null) {
                if (SNAPSHOT_FK_NAMES.has(fkName)) {
                    throw new BillingInvoiceSqlError('foreign_key_violation', `offer snapshot insert violated ${fkName}`);
                }
                throw error;
            }
            if (isDuplicateError(error)) {
                const rows = await this.conn.query<{ payload_hash: string }>(
                    `SELECT payload_hash FROM billing_offer_snapshots
                      WHERE tenant_id = ? AND snapshot_id = ? LIMIT 1`,
                    [tenant, snapshotId],
                );
                const stored = rows[0];
                if (stored === undefined) {
                    throw new BillingInvoiceSqlError('invalid_row', 'an offer snapshot duplicate could not be read back');
                }
                if (stored.payload_hash !== payloadHash) {
                    throw new BillingInvoiceSqlError(
                        'snapshot_hash_conflict',
                        'the offer snapshot id is immutable and stores another payload hash',
                    );
                }
                return;
            }
            throw error;
        }
    }

    async findInvoiceByKey(
        tenantId: string,
        orgKind: BillingOrganization,
        cycleStart: number,
    ): Promise<Invoice | null> {
        requireBounded(tenantId, 'tenantId', 36);
        requireOrgKind(orgKind);
        const start = normalizeSqlSeconds(cycleStart, 'cycleStart');
        const rows = await this.conn.query<InvoiceRowDb>(
            `SELECT ${INVOICE_COLUMNS}
               FROM billing_invoices
              WHERE tenant_id = ? AND org_kind = ? AND cycle_start = ?
              LIMIT 1`,
            [tenantId, orgKind, start],
        );
        const row = rows[0];
        if (row === undefined) return null;
        return this.assembleInvoice(row, tenantId);
    }

    private async linesOf(tenantId: string, invoiceId: string): Promise<LineRowDb[]> {
        return this.conn.query<LineRowDb>(
            `SELECT ${LINE_COLUMNS}
               FROM billing_invoice_lines
              WHERE tenant_id = ? AND invoice_id = ?
              ORDER BY line_id ASC`,
            [tenantId, invoiceId],
        );
    }

    private async assembleInvoice(row: InvoiceRowDb, requestedTenantId: string): Promise<Invoice> {
        if (row.tenant_id !== requestedTenantId) {
            throw new BillingInvoiceSqlError('invalid_row', 'an invoice row belongs to another tenant');
        }
        const cycleStart = normalizeSqlSeconds(row.cycle_start, 'billing_invoices.cycle_start');
        const modelVersion = requirePositiveSafeInteger(row.model_version, 'billing_invoices.model_version');
        const rawOffer = row.offer_snapshot_id === null
            ? null
            : (() => {
                if (row.offer_pricing_effect !== 'held_not_settled') {
                    throw new BillingInvoiceSqlError(
                        'invalid_row',
                        'an invoice offer ref must keep pricing_effect held_not_settled',
                    );
                }
                return {
                    snapshotId: requireBounded(row.offer_snapshot_id, 'billing_invoices.offer_snapshot_id', 128),
                    versionLabel: row.offer_version_label === null
                        ? null
                        : requireBounded(row.offer_version_label, 'billing_invoices.offer_version_label', 128),
                    payloadHash: requireHex64(row.offer_payload_hash, 'billing_invoices.offer_payload_hash'),
                    effectiveFrom: normalizeSqlSeconds(
                        row.offer_effective_from,
                        'billing_invoices.offer_effective_from',
                    ),
                    pricingEffect: 'held_not_settled' as const,
                };
            })();
        const lines = await this.linesOf(row.tenant_id, requireBounded(row.id, 'billing_invoices.id', 36));
        return assertInvoice({
            modelVersion,
            invoiceId: row.id,
            invoiceNumber: requireBounded(row.invoice_number, 'billing_invoices.invoice_number', 128),
            tenantId: row.tenant_id,
            orgKind: requireOrgKind(row.org_kind),
            billingPhase: billingPhaseOf(row),
            window: { start: cycleStart, end: cycleStart + CYCLE_SECONDS },
            currency: requireBounded(row.currency, 'billing_invoices.currency', 3),
            minorUnitsPerMajor: normalizeSqlBigInt(
                row.minor_units_per_major,
                'billing_invoices.minor_units_per_major',
            ),
            priceSnapshotRef: {
                snapshotId: requireBounded(row.price_snapshot_id, 'billing_invoices.price_snapshot_id', 128),
                priceVersionId: requireBounded(row.price_version_id, 'billing_invoices.price_version_id', 128),
                contentHash: requireHex64(row.price_content_hash, 'billing_invoices.price_content_hash'),
            },
            offerSnapshotRef: rawOffer,
            lines: lines.map((line) => ({
                lineId: requireBounded(line.line_id, 'billing_invoice_lines.line_id', 128),
                kind: line.kind,
                segmentStart: line.segment_start === null
                    ? null
                    : normalizeSqlSeconds(line.segment_start, 'billing_invoice_lines.segment_start'),
                segmentEnd: line.segment_end === null
                    ? null
                    : normalizeSqlSeconds(line.segment_end, 'billing_invoice_lines.segment_end'),
                registrationCount: line.registration_count === null
                    ? null
                    : requireNonNegativeSafeInteger(
                        line.registration_count,
                        'billing_invoice_lines.registration_count',
                    ),
                numeratorMinorSeconds: normalizeSqlBigInt(
                    line.numerator_minor_seconds,
                    'billing_invoice_lines.numerator_minor_seconds',
                ),
                denominatorSeconds: normalizeSqlBigInt(
                    line.denominator_seconds,
                    'billing_invoice_lines.denominator_seconds',
                ),
            })),
            totalMinor: normalizeSqlBigInt(row.total_minor, 'billing_invoices.total_minor'),
            payloadHash: requireHex64(row.payload_hash, 'billing_invoices.payload_hash'),
        });
    }

    async insertInvoice(invoice: Invoice): Promise<'inserted' | 'duplicate_key'> {
        const checked = assertInvoice(invoice);
        await this.conn.execute(`SAVEPOINT ${INVOICE_INSERT_SAVEPOINT}`);
        try {
            await this.conn.execute(INVOICE_INSERT_SQL, [
                checked.invoiceId,
                checked.tenantId,
                checked.orgKind,
                checked.billingPhase,
                checked.window.start,
                checked.totalMinor.toString(),
                checked.minorUnitsPerMajor.toString(),
                checked.currency,
                checked.invoiceNumber,
                checked.modelVersion,
                checked.payloadHash,
                checked.priceSnapshotRef.snapshotId,
                checked.priceSnapshotRef.priceVersionId,
                checked.priceSnapshotRef.contentHash,
                checked.offerSnapshotRef === null ? null : checked.offerSnapshotRef.snapshotId,
                checked.offerSnapshotRef === null ? null : checked.offerSnapshotRef.versionLabel,
                checked.offerSnapshotRef === null ? null : checked.offerSnapshotRef.payloadHash,
                checked.offerSnapshotRef === null ? null : checked.offerSnapshotRef.effectiveFrom,
                checked.offerSnapshotRef === null ? null : checked.offerSnapshotRef.pricingEffect,
            ]);
            for (const line of [...checked.lines].sort((a, b) => (a.lineId < b.lineId ? -1 : a.lineId > b.lineId ? 1 : 0))) {
                await this.conn.execute(LINE_INSERT_SQL, [
                    checked.tenantId,
                    checked.invoiceId,
                    line.lineId,
                    line.kind,
                    line.segmentStart,
                    line.segmentEnd,
                    line.registrationCount,
                    line.numeratorMinorSeconds.toString(),
                    line.denominatorSeconds.toString(),
                ]);
            }
            await this.conn.execute(`RELEASE SAVEPOINT ${INVOICE_INSERT_SAVEPOINT}`);
        } catch (error) {
            await this.rollbackToSavepoint();
            if (isDuplicateError(error)) {
                const keyName = duplicateKeyNameOf(error);
                if (keyName !== null && INVOICE_DUP_KEYS.has(keyName)) {
                    return 'duplicate_key';
                }
                throw error;
            }
            const fkName = fkConstraintNameOf(error);
            if (fkName !== null) {
                if (INVOICE_FK_NAMES.has(fkName)) {
                    throw new BillingInvoiceSqlError('foreign_key_violation', `invoice insert violated ${fkName}`);
                }
                throw error;
            }
            throw error;
        }
        return 'inserted';
    }

    private async rollbackToSavepoint(): Promise<void> {
        await this.conn.execute(`ROLLBACK TO SAVEPOINT ${INVOICE_INSERT_SAVEPOINT}`);
        await this.conn.execute(`RELEASE SAVEPOINT ${INVOICE_INSERT_SAVEPOINT}`);
    }

    async findIdempotencyRecord(
        tenantId: string,
        scope: string,
        key: string,
    ): Promise<InvoiceIdempotencyRecord | null> {
        requireBounded(tenantId, 'tenantId', 36);
        requireBounded(scope, 'scope', MAX_IDEMPOTENCY_SCOPE_LENGTH);
        requireBounded(key, 'key', MAX_IDEMPOTENCY_KEY_LENGTH);
        const rows = await this.conn.query<IdempotencyRowDb>(
            `SELECT tenant_id, scope, idempotency_key, payload_hash, invoice_id
               FROM billing_idempotency_keys
              WHERE tenant_id = ? AND scope = ? AND idempotency_key = ?
              LIMIT 1`,
            [tenantId, scope, key],
        );
        const row = rows[0];
        if (row === undefined) return null;
        if (row.tenant_id !== tenantId || row.scope !== scope) {
            throw new BillingInvoiceSqlError('invalid_row', 'an idempotency registry row is outside the requested tenant/scope');
        }
        if (row.invoice_id === null) {
            throw new BillingInvoiceSqlError('invalid_row', 'an invoice-scope idempotency registry row has no invoice target');
        }
        return {
            tenantId: row.tenant_id,
            scope: row.scope,
            key: row.idempotency_key,
            payloadHash: requireHex64(row.payload_hash, 'billing_idempotency_keys.payload_hash'),
            invoiceId: row.invoice_id,
        };
    }

    async insertIdempotencyRecord(record: InvoiceIdempotencyRecord): Promise<'inserted' | 'duplicate_key'> {
        const tenantId = requireBounded(record.tenantId, 'record.tenantId', 36);
        const scope = requireBounded(record.scope, 'record.scope', MAX_IDEMPOTENCY_SCOPE_LENGTH);
        const key = requireBounded(record.key, 'record.key', MAX_IDEMPOTENCY_KEY_LENGTH);
        const payloadHash = requireHex64(record.payloadHash, 'record.payloadHash');
        const invoiceId = requireBounded(record.invoiceId, 'record.invoiceId', 36);
        try {
            await this.conn.execute(
                `INSERT INTO billing_idempotency_keys
                    (tenant_id, scope, idempotency_key, payload_hash, journal_id, reservation_id, invoice_id)
                 VALUES (?, ?, ?, ?, NULL, NULL, ?)`,
                [tenantId, scope, key, payloadHash, invoiceId],
            );
        } catch (error) {
            if (isForeignKeyError(error)) {
                const fkName = fkConstraintNameOf(error);
                if (fkName !== null && REGISTRY_FK_NAMES.has(fkName)) {
                    throw new BillingInvoiceSqlError(
                        'foreign_key_violation',
                        `the idempotency registry insert violated ${fkName}`,
                    );
                }
                throw error;
            }
            if (isDuplicateError(error)) {
                const keyName = duplicateKeyNameOf(error);
                if (keyName !== null && REGISTRY_DUP_KEYS.has(keyName)) {
                    return 'duplicate_key';
                }
                throw error;
            }
            throw error;
        }
        return 'inserted';
    }

    /**
     * Link an ALREADY POSTED receivable journal to the invoice just inserted on
     * this connection. The journal is proven first with a tenant-scoped
     * locking read (a foreign-tenant or unknown id never reaches the insert);
     * the composite FKs and the two unique keys are the storage-level guard.
     * This method creates no journal, no line and no account.
     */
    async linkReceivableJournal(link: InvoiceReceivableLink): Promise<'linked' | 'duplicate_key'> {
        const tenantId = requireBounded(link.tenantId, 'link.tenantId', 36);
        const invoiceId = requireBounded(link.invoiceId, 'link.invoiceId', 36);
        const journalId = requireBounded(link.journalId, 'link.journalId', 36);
        const journals = await this.conn.query<{ id: string }>(
            `SELECT id
               FROM billing_journals
              WHERE tenant_id = ? AND id = ?
              LIMIT 1
              FOR SHARE`,
            [tenantId, journalId],
        );
        if (journals[0] === undefined) {
            throw new BillingInvoiceSqlError(
                'journal_not_found',
                'the receivable journal does not exist for this tenant',
            );
        }
        await this.verifyIssuanceJournalBeforeLink(tenantId, invoiceId, journalId);
        try {
            const result = await this.conn.execute(
                `INSERT INTO billing_invoice_journals (invoice_id, tenant_id, journal_id)
                 VALUES (?, ?, ?)`,
                [invoiceId, tenantId, journalId],
            );
            if (requireInsertAffectedRows(result.affectedRows) !== 1) {
                throw new BillingInvoiceSqlError(
                    'store_overrun',
                    'the invoice journal link INSERT did not affect exactly one row',
                );
            }
        } catch (error) {
            if (isForeignKeyError(error)) {
                const fkName = fkConstraintNameOf(error);
                if (fkName !== null && INVOICE_JOURNAL_FK_NAMES.has(fkName)) {
                    throw new BillingInvoiceSqlError(
                        'foreign_key_violation',
                        `the invoice journal link violated ${fkName}`,
                    );
                }
                throw error;
            }
            if (isDuplicateError(error)) {
                const keyName = duplicateKeyNameOf(error);
                if (keyName !== null && INVOICE_JOURNAL_DUP_KEYS.has(keyName)) {
                    return 'duplicate_key';
                }
                throw error;
            }
            throw error;
        }
        return 'linked';
    }

    /**
     * Mandatory gate BEFORE the link insert. The expected new charge is derived
     * from the STORED invoice of this tenant (never from the caller); the
     * journal must be exactly that invoice's issuance journal and the ACTUAL
     * account rows behind its two lines must have the required kinds, tenant and
     * currency. Journal existence or a pooled receivable balance is not proof.
     */
    private async verifyIssuanceJournalBeforeLink(
        tenantId: string,
        invoiceId: string,
        journalId: string,
    ): Promise<void> {
        const invoiceRows = await this.conn.query<InvoiceRowDb>(
            `SELECT ${INVOICE_COLUMNS}
               FROM billing_invoices
              WHERE tenant_id = ? AND id = ?
              LIMIT 1
              FOR SHARE`,
            [tenantId, invoiceId],
        );
        const invoiceRow = invoiceRows[0];
        if (invoiceRow === undefined) {
            throw new BillingInvoiceSqlError('invalid_row', 'the invoice to link does not exist for this tenant');
        }
        const invoice = await this.assembleInvoice(invoiceRow, tenantId);
        const composition = deriveInvoiceChargeComposition(invoice);
        const journal = await this.ledger.getJournal(tenantId, journalId);
        if (journal === null) {
            throw new BillingInvoiceSqlError(
                'journal_not_found',
                'the receivable journal does not exist for this tenant',
            );
        }
        const verdict = verifyInvoiceIssuanceJournal(journal, {
            tenantId,
            invoiceId,
            currency: invoice.currency,
            newChargeMinor: composition.newChargeMinor,
        });
        if (!verdict.ok) {
            throw new BillingInvoiceError(
                'journal_link_conflict',
                `the receivable journal is not this invoice's issuance journal: ${verdict.reason}`,
            );
        }
        const accountIds = journal.lines.map((line) => line.accountId);
        const accounts = await this.conn.query<{ id: string; tenant_id: string; kind: string; currency: string }>(
            `SELECT id, tenant_id, kind, currency
               FROM billing_accounts
              WHERE tenant_id = ? AND id IN (?, ?)
              ORDER BY id ASC
              LIMIT 2`,
            [tenantId, accountIds[0], accountIds[1]],
        );
        const byId = new Map(accounts.map((account) => [account.id, account]));
        for (const line of journal.lines) {
            const account = byId.get(line.accountId);
            if (
                account === undefined
                || account.tenant_id !== tenantId
                || account.kind !== line.accountKind
                || account.currency !== invoice.currency
            ) {
                throw new BillingInvoiceError(
                    'journal_link_conflict',
                    'a journal line account differs from the required issuance account kind, tenant or currency',
                );
            }
        }
    }

    async findReceivableJournalId(tenantId: string, invoiceId: string): Promise<string | null> {
        const tenant = requireBounded(tenantId, 'tenantId', 36);
        const invoice = requireBounded(invoiceId, 'invoiceId', 36);
        const rows = await this.conn.query<{ journal_id: string }>(
            `SELECT journal_id
               FROM billing_invoice_journals
              WHERE tenant_id = ? AND invoice_id = ?
              LIMIT 1`,
            [tenant, invoice],
        );
        const row = rows[0];
        return row === undefined ? null : requireBounded(row.journal_id, 'billing_invoice_journals.journal_id', 36);
    }

    async listInvoicesForTenant(tenantId: string, query?: { readonly limit?: number }): Promise<InvoicePage> {
        requireBounded(tenantId, 'tenantId', 36);
        const limit = query?.limit === undefined ? DEFAULT_LIST_LIMIT : query.limit;
        if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT) {
            throw new BillingInvoiceSqlError(
                'store_overrun',
                `limit must be an integer between 1 and ${MAX_LIST_LIMIT}`,
            );
        }
        const rows = await this.conn.query<InvoiceRowDb>(
            `SELECT ${INVOICE_COLUMNS}
               FROM billing_invoices
              WHERE tenant_id = ?
              ORDER BY cycle_start ASC, id ASC
              LIMIT ?`,
            [tenantId, limit + INVOICE_LIST_READ_HEADROOM],
        );
        const truncated = rows.length > limit;
        const invoices: Invoice[] = [];
        for (const row of rows.slice(0, limit)) {
            invoices.push(await this.assembleInvoice(row, tenantId));
        }
        return { invoices, truncated };
    }
}

export interface BillingInvoiceSqlStore extends InvoiceStore {
    /** Bind the transaction handle (and its audit writer) to one open connection. */
    inTransaction(conn: BillingInvoiceSqlConnection): BillingInvoiceSqlTransaction;
    runAtomic<T>(callback: (tx: BillingInvoiceSqlTransaction) => Promise<T>): Promise<T>;
}

export const INVOICE_SQL_ADAPTER_ID = 'billing-invoices-sql:20261022_02';

class BillingInvoiceSqlStoreImpl implements BillingInvoiceSqlStore {
    private readonly audit: BillingInvoiceSqlAuditSink;

    constructor(private readonly deps: BillingInvoiceSqlDeps) {
        if (!deps || typeof deps.transaction !== 'function') {
            throw new BillingInvoiceSqlError(
                'invalid_runner',
                'BillingInvoiceSqlStore requires a connection-bound transaction runner',
            );
        }
        if (typeof deps.audit !== 'function') {
            throw new BillingInvoiceSqlError(
                'invalid_audit',
                'BillingInvoiceSqlStore requires the sealed connection-bound audit writer',
            );
        }
        this.audit = deps.audit;
    }

    inTransaction(conn: BillingInvoiceSqlConnection): BillingInvoiceSqlTransaction {
        return new BillingInvoiceSqlTransactionImpl(conn, this.audit, this.deps.transaction);
    }

    runAtomic<T>(callback: (tx: BillingInvoiceSqlTransaction) => Promise<T>): Promise<T> {
        return this.deps.transaction((conn) => callback(this.inTransaction(conn)));
    }
}

export const createBillingInvoiceSqlStore = (deps: BillingInvoiceSqlDeps): BillingInvoiceSqlStore =>
    new BillingInvoiceSqlStoreImpl(deps);

export const createBoundBillingInvoiceSqlTransaction = (
    conn: BillingInvoiceSqlConnection,
    deps: BillingInvoiceSqlDeps,
): BillingInvoiceSqlTransaction => new BillingInvoiceSqlStoreImpl(deps).inTransaction(conn);

export interface InvoiceIssueSqlBinder {
    /** Domain-driven issuance; its audit writer runs on the SAME transaction conn. */
    issue(
        command: IssueInvoiceCommand,
        options?: Pick<IssueInvoiceOptions, 'now' | 'dueRule'>,
    ): Promise<IssueInvoiceResult>;
}

/**
 * Wire `issueInvoice`'s per-command audit writer onto the adapter's
 * transaction-bound `writeAudit` so the sealed audit row shares the exact
 * connection of the invoice/line/registry inserts.
 *
 * The transaction handle is bound PER `issue` INVOCATION: every call creates
 * its own `active` slot and its own wrapper store, so concurrent issuances
 * (even for unrelated tenants) never share mutable state, never take over
 * another invocation's connection and cannot route an audit row elsewhere.
 * Snapshot, invoice and audit writes of one issuance still run in the single
 * unit of work opened by `store.runAtomic`.
 */
export const createInvoiceIssueSqlBinder = (store: BillingInvoiceSqlStore): InvoiceIssueSqlBinder => ({
    issue: (
        command: IssueInvoiceCommand,
        issueOptions: Pick<IssueInvoiceOptions, 'now' | 'dueRule'> = {},
    ): Promise<IssueInvoiceResult> => {
        let active: BillingInvoiceSqlTransaction | null = null;
        const auditedStore: InvoiceStore = {
            runAtomic: <T>(callback: (tx: InvoiceTransaction) => Promise<T>): Promise<T> =>
                store.runAtomic(async (tx) => {
                    if (active !== null) {
                        throw new BillingInvoiceSqlError(
                            'invalid_audit',
                            'one invoice issue invocation cannot open two transactions',
                        );
                    }
                    active = tx;
                    try {
                        return await callback(tx);
                    } finally {
                        active = null;
                    }
                }),
        };
        return issueInvoice(auditedStore, command, {
            ...(issueOptions.now === undefined ? {} : { now: issueOptions.now }),
            ...(issueOptions.dueRule === undefined ? {} : { dueRule: issueOptions.dueRule }),
            audit: (record) => {
                const tx = active;
                if (tx === null) {
                    throw new BillingInvoiceSqlError(
                        'invalid_audit',
                        'the invoice audit writer was invoked outside its issue transaction',
                    );
                }
                return tx.writeAudit(record);
            },
        });
    },
});
