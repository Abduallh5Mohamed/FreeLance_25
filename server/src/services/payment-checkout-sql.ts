/**
 * FIN8 / X7 — real SQL adapter for `CheckoutStore` / `CheckoutTransaction`.
 *
 * Implements `payment-checkout.ts` (CHECKOUT_STORE_SQL_CONTRACT) against the
 * already-written migration `20261022_03_payments_checkout.sql`:
 *   checkout_orders           PK (tenant_id, order_id)
 *   checkout_provider_events  PK (provider, provider_event_id) — global by design
 *
 * SOURCE CODE ONLY. Nothing here executes SQL or opens a connection. Every
 * statement of a unit of work is issued on the caller-injected transaction
 * connection; there is no pooled query and no autocommit fallback. A missing
 * runner or audit sink throws at construction, before any statement.
 *
 * TENANT / LOCKING
 *  - every order read/update carries `tenant_id = ?`;
 *  - `findOrderForUpdate` is `SELECT ... FOR UPDATE`, so the following version
 *    CAS is a real race guard;
 *  - `updateOrderCas` is one conditional write on
 *    `(tenant_id, order_id, version)` and writes `version = version + 1`;
 *  - provider events are globally deduped by `(provider, provider_event_id)`,
 *    exactly as migration 03 declares. The table read cannot carry a tenant
 *    predicate because the contract's read key has no tenant; a duplicate that
 *    belongs to another tenant is rejected as a typed tenant conflict instead
 *    of being replayed across tenants;
 *  - a duplicate insert is resolved by a `FOR SHARE` re-read (locking current
 *    read), so the winning row is visible even though the transaction's
 *    REPEATABLE READ snapshot predates it. Duplicate key names are matched
 *    against migration 03's real `PRIMARY` keys instead of any duplicate being
 *    treated as a checkout duplicate.
 *
 * MONEY (HK2): exact integer minor units only. BIGINT columns may arrive as
 * `bigint`, decimal `string` or an exactly-representable safe `number`;
 * `normalizeSqlBigInt` (the shared HK2 normalizer exported by
 * billing-ledger-sql.ts; its typed invariant errors are rethrown untranslated)
 * rejects every other shape and never routes money through `Number()`.
 * Required mysql2 options for the production binding:
 *   `supportBigNumbers: true`, `bigNumberStrings: true`.
 *
 * AUDIT: the domain's per-command audit writer cannot reach a transaction
 * handle by itself, so `createCheckoutSqlBinder` binds it onto the SAME
 * connection/transaction as the order or provider-event mutation. Audits for
 * pre-persistence rejects (unverified signature / invalid event) have no
 * mutation to share a transaction with and are written through one standalone
 * transaction on the injected runner. There is no no-op audit path.
 *
 * DUPLICATES (R7): every provider-event duplicate path returns the STORED row
 * (the insert-race loser is re-read with `FOR SHARE`) so the domain compares
 * `rawPayloadHash` and the event identity itself. The adapter never replays a
 * stored event on behalf of the domain. `findProviderEvent` also rejects a
 * cross-tenant row when the domain supplies its expected tenant.
 *
 * CREATION IDEMPOTENCY (R4/HK1): `checkout_order_idempotency_keys` from
 * migration 20261023_01. A duplicate insert is matched by KEY NAME against the
 * table's real `PRIMARY` key, then re-read with `FOR SHARE` (a locking current
 * read) so an insert-race loser sees the winner's committed row. The adapter
 * returns the stored record; the domain compares `payloadHash` and raises the
 * typed conflict. The order row is inserted before the idempotency row because
 * of the tenant/order FK.
 *
 * SETTLEMENT OBLIGATION OUTBOX (R4): `financial_settlement_obligations` from
 * migration 20261023_01. `recordSettlementObligation` writes one `pending`
 * obligation on the SAME transaction after the paid CAS and the verified
 * provider event. It re-reads the provider event under `FOR SHARE` and proves
 * tenant/order/amount/currency equality before inserting, so a cross-tenant or
 * mismatched obligation can never be written. Unknown fee/tax/net stay NULL;
 * duplicate unique keys re-read the stored row so the domain can decide replay
 * versus typed payload conflict.
 *
 * CANONICAL ORDER ID: every caller-supplied order id is compared with
 * `COLLATE utf8mb4_0900_bin` against the stored byte-exact id, so a case or
 * accent variant fails closed instead of matching another order row.
 *
 * INDEX USABILITY (UNPROVEN, confirm with EXPLAIN on a live server): a bare
 * `col <unicode_ci> = ? COLLATE utf8mb4_0900_bin` cannot use the index and
 * would lock every scanned row under REPEATABLE READ. Every such predicate is
 * therefore written as the plain index-usable equality FIRST (narrowing to the
 * case/accent/pad-variant candidates) followed by the binary-exact
 * `col COLLATE utf8mb4_0900_bin = ?` guard that rejects non-exact variants.
 * Only the narrow variant candidate rows can be locked by a rejected variant.
 *
 * PLATFORM TARGETS (20261023_03, contract 14.3/14.8.5): `resolvePlatformTarget`
 * learns the request's invoice with a plain read, locks invoice + allocations
 * through the bound read-only settlement view, then locks the request row
 * `FOR UPDATE`. `insertPlatformTarget` (SAVEPOINT, duplicate by key name
 * `PRIMARY`), `findPlatformTargetByOrder` and `countBlockingPlatformOrders`
 * use `FOR SHARE` current reads after LIMIT. `recordSettlementObligation` is
 * unchanged: the obligation is bound to the target through its immutable
 * (tenant_id, order_id) join.
 *
 * This adapter never writes a ledger journal, a balance or a cash receipt.
 */

import {
    applyProviderEvent,
    CHECKOUT_ORDER_STATUSES,
    createCheckoutOrder,
    DEFAULT_LIST_LIMIT,
    MAX_CHECKOUT_AMOUNT_MINOR,
    MAX_IDEMPOTENCY_KEY_LENGTH,
    MAX_IDEMPOTENCY_SCOPE_LENGTH,
    MAX_LIST_LIMIT,
    MAX_ORDER_ID_LENGTH,
    MAX_PAYLOAD_HASH_LENGTH,
    MAX_PAYER_REFERENCE_LENGTH,
    MAX_PROVIDER_EVENT_ID_LENGTH,
    MAX_PROVIDER_LENGTH,
    MAX_PURPOSE_LENGTH,
    MAX_TENANT_LENGTH,
    PROVIDER_EVENT_OUTCOMES,
    PROVIDER_EVENT_STATUSES,
    SETTLEMENT_OBLIGATION_STATUSES,
    SETTLEMENT_RECONCILIATION_STATUSES,
    type ApplyProviderEventInput,
    type ApplyProviderEventResult,
    type CheckoutApplyDeps,
    type CheckoutAuditRecord,
    type CheckoutAuditWriter,
    type CheckoutEventReason,
    type CheckoutOrder,
    type CheckoutOrderIdempotencyRecord,
    type CheckoutOrderOptions,
    type CheckoutOrderPage,
    type CheckoutOrderPatch,
    type CheckoutOrderStatus,
    type CheckoutStore,
    type CheckoutTransaction,
    type CreateCheckoutOrderInput,
    type CreateCheckoutOrderResult,
    type InsertOrderIdempotencyResult,
    type InsertProviderEventResult,
    type PlatformPaymentTarget,
    type ProviderEventOutcome,
    type ProviderEventRecord,
    type ProviderEventStatus,
    type RecordSettlementObligationResult,
    type ResolvePlatformTargetResult,
    type SettlementObligation,
    type SettlementObligationDraft,
    type SettlementObligationStatus,
    type SettlementReconciliationStatus,
    type UpdateOrderCasResult,
} from './payment-checkout';
import { normalizeSqlBigInt, normalizeSqlVersion } from './billing-ledger-sql';
import { computeInvoiceOutstanding } from './billing-settlement';
import { createBoundBillingSettlementSqlTransaction } from './billing-settlement-sql';

export const CHECKOUT_SQL_ADAPTER_ID = 'payment-checkout-sql:20261022_03+20261023_01+20261023_03';

export const CHECKOUT_INSERT_SAVEPOINT = 'checkout_order_insert';
export const CHECKOUT_EVENT_SAVEPOINT = 'checkout_event_insert';
export const CHECKOUT_IDEMPOTENCY_SAVEPOINT = 'checkout_idempotency_insert';
export const CHECKOUT_OBLIGATION_SAVEPOINT = 'checkout_obligation_insert';
export const CHECKOUT_PLATFORM_TARGET_SAVEPOINT = 'checkout_platform_target_insert';

/** `billing_difference_requests.id` / `invoice_ref_id` are CHAR(36). */
const PLATFORM_REQUEST_ID_LENGTH = 36;
/** Bounded page for the blocking-order probe (only zero vs non-zero matters). */
const PLATFORM_BLOCKING_PAGE = 100;

export type CheckoutSqlErrorCode =
    | 'schema_unavailable'
    | 'invalid_runner'
    | 'invalid_audit'
    | 'invalid_row'
    | 'store_overrun'
    | 'duplicate_key'
    | 'foreign_key_violation'
    | 'tenant_mismatch';

export class PaymentCheckoutSqlError extends Error {
    constructor(public readonly code: CheckoutSqlErrorCode, message: string) {
        super(message);
        this.name = 'PaymentCheckoutSqlError';
    }
}

/** Missing driver counts cannot establish either a CAS conflict or success. */
const requireCasAffectedRows = (raw: unknown): number => {
    // Connection contracts also permit strict decimal-string driver counts.
    const value = typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : raw;
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
        throw new PaymentCheckoutSqlError('invalid_row', 'CAS result has no readable non-negative integer affectedRows');
    }
    return value;
};

export interface CheckoutSqlConnection {
    query<T = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<T[]>;
    execute(
        sql: string,
        params?: readonly unknown[],
    ): Promise<{ affectedRows?: number | string; insertId?: number | string }>;
}

export type CheckoutSqlTransactionRunner = <T>(
    fn: (conn: CheckoutSqlConnection) => Promise<T>,
) => Promise<T>;

/**
 * REQUIRED audit sink bound to one open transaction connection. There is no
 * default and no no-op: production MUST inject the sealed writer whose row
 * lands on the same connection/transaction as the mutation.
 */
export type CheckoutSqlAuditSink = (
    conn: CheckoutSqlConnection,
    record: CheckoutAuditRecord,
) => Promise<void> | void;

export interface PaymentCheckoutSqlDeps {
    transaction: CheckoutSqlTransactionRunner;
    audit: CheckoutSqlAuditSink;
}

const ORDER_COLUMNS = `tenant_id, order_id, payer_reference, purpose, amount_minor,
    currency, status, created_at, expires_at, confirmed_at,
    confirmed_provider_event_id, last_event_at, last_provider_event_id, version`;

const EVENT_COLUMNS = `provider, provider_event_id, tenant_id, order_ref, amount_minor,
    currency, status, outcome, reason, occurred_at, raw_payload_hash, recorded_at`;

const IDEMPOTENCY_COLUMNS = `tenant_id, scope, idempotency_key, payload_hash, order_id, created_at`;

const OBLIGATION_COLUMNS = `id, tenant_id, order_id, purpose, amount_minor, currency,
    provider, provider_event_id, payload_hash, status, fee_minor, tax_minor, net_minor,
    reconciliation_status, version, created_at`;

const CURRENCY_PATTERN = /^[A-Z]{3}$/;
const PAYLOAD_HASH_PATTERN = /^[0-9a-f]{64}$/;
const OBLIGATION_STATUS_SET: ReadonlySet<string> = new Set(SETTLEMENT_OBLIGATION_STATUSES);
const RECONCILIATION_STATUS_SET: ReadonlySet<string> = new Set(SETTLEMENT_RECONCILIATION_STATUSES);

const EVENT_REASONS: ReadonlySet<string> = new Set<CheckoutEventReason>([
    'unverified-signature',
    'invalid-event',
    'order-not-found',
    'amount-mismatch',
    'currency-mismatch',
    'stale-event',
    'late-failed-after-paid',
    'terminal-order',
    'expired-order',
    'status-conflict',
    'payload-conflict',
]);

/** Exact unique keys from migration 03 (MySQL reports `PRIMARY` for PKs). */
const ORDER_DUP_KEYS: ReadonlySet<string> = new Set(['PRIMARY']);
const PROVIDER_EVENT_DUP_KEYS: ReadonlySet<string> = new Set(['PRIMARY']);

/** Exact PK/unique keys from migration 20261023_01. */
const IDEMPOTENCY_DUP_KEYS: ReadonlySet<string> = new Set(['PRIMARY']);
const OBLIGATION_PAYMENT_DUP_KEY = 'uq_settlement_obligation_payment';
const OBLIGATION_ORDER_DUP_KEY = 'uq_settlement_obligation_order';
/** Exact PK of `checkout_order_platform_targets` (migration 20261023_03, 14.8.5). */
const PLATFORM_TARGET_DUP_KEYS: ReadonlySet<string> = new Set(['PRIMARY']);
const OBLIGATION_ID_DUP_KEYS: ReadonlySet<string> = new Set([
    'PRIMARY',
    'uq_settlement_obligation_id_tenant',
]);
const OBLIGATION_DUP_KEYS: ReadonlySet<string> = new Set([
    ...OBLIGATION_ID_DUP_KEYS,
    OBLIGATION_PAYMENT_DUP_KEY,
    OBLIGATION_ORDER_DUP_KEY,
]);

const isDuplicateError = (error: unknown): boolean =>
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ER_DUP_ENTRY';

const isForeignKeyError = (error: unknown): boolean => {
    if (typeof error !== 'object' || error === null) return false;
    const code = (error as { code?: unknown }).code;
    return code === 'ER_NO_REFERENCED_ROW_2' || code === 'ER_ROW_IS_REFERENCED_2';
};

/** Missing table/column (1146 / 1054): the source is unavailable, never empty. */
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
        throw new PaymentCheckoutSqlError('invalid_row', `${field} is not a parseable timestamp`);
    }
    return date.toISOString();
};

const requireTimestamp = (value: unknown, field: string): string => {
    if (typeof value !== 'string' || value.trim() === '' || Number.isNaN(Date.parse(value))) {
        throw new PaymentCheckoutSqlError('invalid_row', `${field} must be a parseable timestamp string`);
    }
    return value;
};

const requireBounded = (value: unknown, field: string, maxLength: number): string => {
    if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) {
        throw new PaymentCheckoutSqlError(
            'invalid_row',
            `${field} must be a non-empty string of at most ${maxLength} characters`,
        );
    }
    return value;
};

const requireNullableBounded = (
    value: unknown,
    field: string,
    maxLength: number,
): string | null => {
    if (value === null) return null;
    return requireBounded(value, field, maxLength);
};

const requireCurrency = (value: unknown): string => {
    if (typeof value !== 'string' || !CURRENCY_PATTERN.test(value)) {
        throw new PaymentCheckoutSqlError('invalid_row', 'currency must be a three-letter uppercase ISO-4217 code');
    }
    return value;
};

const requireStatus = (value: unknown): CheckoutOrderStatus => {
    if (typeof value !== 'string' || !(CHECKOUT_ORDER_STATUSES as readonly string[]).includes(value)) {
        throw new PaymentCheckoutSqlError('invalid_row', 'checkout order has an unknown status');
    }
    return value as CheckoutOrderStatus;
};

const requireProviderStatus = (value: unknown): ProviderEventStatus => {
    if (typeof value !== 'string' || !(PROVIDER_EVENT_STATUSES as readonly string[]).includes(value)) {
        throw new PaymentCheckoutSqlError('invalid_row', 'provider event has an unknown status');
    }
    return value as ProviderEventStatus;
};

const requireOutcome = (value: unknown): ProviderEventOutcome => {
    if (typeof value !== 'string' || !(PROVIDER_EVENT_OUTCOMES as readonly string[]).includes(value)) {
        throw new PaymentCheckoutSqlError('invalid_row', 'provider event has an unknown outcome');
    }
    return value as ProviderEventOutcome;
};

const requireReason = (value: unknown): CheckoutEventReason | null => {
    if (value === null) return null;
    if (typeof value !== 'string' || !EVENT_REASONS.has(value)) {
        throw new PaymentCheckoutSqlError('invalid_row', 'provider event has an unknown reason');
    }
    return value as CheckoutEventReason;
};

const requireListLimit = (value: unknown): number => {
    if (value === undefined) return DEFAULT_LIST_LIMIT;
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > MAX_LIST_LIMIT) {
        throw new PaymentCheckoutSqlError(
            'store_overrun',
            `limit must be an integer between 1 and ${MAX_LIST_LIMIT}`,
        );
    }
    return value;
};

const requireCheckoutAmount = (value: unknown): bigint => {
    const amount = normalizeSqlBigInt(value, 'checkout amount_minor', { max: MAX_CHECKOUT_AMOUNT_MINOR });
    if (amount <= 0n) {
        throw new PaymentCheckoutSqlError('invalid_row', 'checkout amount_minor must be positive');
    }
    return amount;
};

const requirePayloadHash = (value: unknown, field: string): string => {
    const text = requireBounded(value, field, MAX_PAYLOAD_HASH_LENGTH);
    if (!PAYLOAD_HASH_PATTERN.test(text)) {
        throw new PaymentCheckoutSqlError('invalid_row', `${field} must be a lowercase 64-character SHA-256`);
    }
    return text;
};

const requireObligationId = (value: unknown): string => {
    const id = requireBounded(value, 'settlement obligation id', MAX_TENANT_LENGTH);
    if (id.length !== 36) {
        throw new PaymentCheckoutSqlError('invalid_row', 'settlement obligation id must be CHAR(36)');
    }
    return id;
};

const requireNullableAmount = (value: unknown, field: string): bigint | null => {
    if (value === null) return null;
    return normalizeSqlBigInt(value, field, { max: MAX_CHECKOUT_AMOUNT_MINOR });
};

const requireObligationStatus = (value: unknown): SettlementObligationStatus => {
    if (typeof value !== 'string' || !OBLIGATION_STATUS_SET.has(value)) {
        throw new PaymentCheckoutSqlError('invalid_row', 'settlement obligation has an unknown status');
    }
    return value as SettlementObligationStatus;
};

const requireReconciliationStatus = (value: unknown): SettlementReconciliationStatus => {
    if (typeof value !== 'string' || !RECONCILIATION_STATUS_SET.has(value)) {
        throw new PaymentCheckoutSqlError(
            'invalid_row',
            'settlement obligation has an unknown reconciliation status',
        );
    }
    return value as SettlementReconciliationStatus;
};

interface OrderRowDb {
    tenant_id: string;
    order_id: string;
    payer_reference: string;
    purpose: string;
    amount_minor: unknown;
    currency: string;
    status: string;
    created_at: string | Date;
    expires_at: string | Date;
    confirmed_at: string | Date | null;
    confirmed_provider_event_id: string | null;
    last_event_at: string | Date | null;
    last_provider_event_id: string | null;
    version: unknown;
}

interface EventRowDb {
    provider: string;
    provider_event_id: string;
    tenant_id: string;
    order_ref: string;
    amount_minor: unknown;
    currency: string;
    status: string;
    outcome: string;
    reason: string | null;
    occurred_at: string | Date;
    raw_payload_hash: string;
    recorded_at: string | Date;
}

interface IdempotencyRowDb {
    tenant_id: string;
    scope: string;
    idempotency_key: string;
    payload_hash: string;
    order_id: string;
    created_at: string | Date;
}

interface RequestRowDb {
    id: string;
    tenant_id: string;
    invoice_ref_id: string | null;
    amount_minor: unknown;
    currency: string;
    status: string;
}

interface PlatformTargetRowDb {
    tenant_id: string;
    order_id: string;
    purpose: string;
    request_id: string;
    invoice_id: string;
    currency: string;
    amount_minor: unknown;
    order_purpose: string;
    order_currency: string;
    order_amount_minor: unknown;
}

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
    reconciliation_status: string;
    version: unknown;
    created_at: string | Date;
}

const orderOfRow = (row: OrderRowDb, tenantId: string): CheckoutOrder => {
    if (row.tenant_id !== tenantId) {
        throw new PaymentCheckoutSqlError('invalid_row', 'a checkout order row belongs to another tenant');
    }
    return {
        orderId: requireBounded(row.order_id, 'checkout_orders.order_id', MAX_ORDER_ID_LENGTH),
        tenantId: requireBounded(row.tenant_id, 'checkout_orders.tenant_id', MAX_TENANT_LENGTH),
        payerReference: requireBounded(
            row.payer_reference,
            'checkout_orders.payer_reference',
            MAX_PAYER_REFERENCE_LENGTH,
        ),
        purpose: requireBounded(row.purpose, 'checkout_orders.purpose', MAX_PURPOSE_LENGTH),
        amountMinor: requireCheckoutAmount(row.amount_minor),
        currency: requireCurrency(row.currency),
        status: requireStatus(row.status),
        createdAt: toIso(row.created_at, 'checkout_orders.created_at'),
        expiresAt: toIso(row.expires_at, 'checkout_orders.expires_at'),
        version: normalizeSqlVersion(row.version, 'checkout_orders.version'),
        confirmedAt: row.confirmed_at === null
            ? null
            : toIso(row.confirmed_at, 'checkout_orders.confirmed_at'),
        confirmedProviderEventId: requireNullableBounded(
            row.confirmed_provider_event_id,
            'checkout_orders.confirmed_provider_event_id',
            MAX_PROVIDER_EVENT_ID_LENGTH,
        ),
        lastEventAt: row.last_event_at === null ? null : toIso(row.last_event_at, 'checkout_orders.last_event_at'),
        lastProviderEventId: requireNullableBounded(
            row.last_provider_event_id,
            'checkout_orders.last_provider_event_id',
            MAX_PROVIDER_EVENT_ID_LENGTH,
        ),
    };
};

const eventOfRow = (row: EventRowDb): ProviderEventRecord => ({
    provider: requireBounded(row.provider, 'checkout_provider_events.provider', MAX_PROVIDER_LENGTH),
    providerEventId: requireBounded(
        row.provider_event_id,
        'checkout_provider_events.provider_event_id',
        MAX_PROVIDER_EVENT_ID_LENGTH,
    ),
    tenantId: requireBounded(row.tenant_id, 'checkout_provider_events.tenant_id', MAX_TENANT_LENGTH),
    orderRef: requireBounded(row.order_ref, 'checkout_provider_events.order_ref', MAX_ORDER_ID_LENGTH),
    amountMinor: requireCheckoutAmount(row.amount_minor),
    currency: requireCurrency(row.currency),
    status: requireProviderStatus(row.status),
    outcome: requireOutcome(row.outcome),
    reason: requireReason(row.reason),
    occurredAt: toIso(row.occurred_at, 'checkout_provider_events.occurred_at'),
    rawPayloadHash: requireBounded(
        row.raw_payload_hash,
        'checkout_provider_events.raw_payload_hash',
        MAX_PAYLOAD_HASH_LENGTH,
    ),
    recordedAt: toIso(row.recorded_at, 'checkout_provider_events.recorded_at'),
});

const idempotencyOfRow = (
    row: IdempotencyRowDb,
    tenantId: string,
    scope: string,
    idempotencyKey: string,
): CheckoutOrderIdempotencyRecord => {
    const record: CheckoutOrderIdempotencyRecord = {
        tenantId: requireBounded(row.tenant_id, 'checkout_order_idempotency_keys.tenant_id', MAX_TENANT_LENGTH),
        scope: requireBounded(row.scope, 'checkout_order_idempotency_keys.scope', MAX_IDEMPOTENCY_SCOPE_LENGTH),
        idempotencyKey: requireBounded(
            row.idempotency_key,
            'checkout_order_idempotency_keys.idempotency_key',
            MAX_IDEMPOTENCY_KEY_LENGTH,
        ),
        payloadHash: requirePayloadHash(
            row.payload_hash,
            'checkout_order_idempotency_keys.payload_hash',
        ),
        orderId: requireBounded(row.order_id, 'checkout_order_idempotency_keys.order_id', MAX_ORDER_ID_LENGTH),
        createdAt: toIso(row.created_at, 'checkout_order_idempotency_keys.created_at'),
    };
    if (
        record.tenantId !== tenantId
        || record.scope !== scope
        || record.idempotencyKey !== idempotencyKey
    ) {
        throw new PaymentCheckoutSqlError(
            'invalid_row',
            'a checkout idempotency row does not match the exact requested tenant/scope/key',
        );
    }
    return record;
};

const obligationOfRow = (row: ObligationRowDb): SettlementObligation => ({
    id: requireObligationId(row.id),
    tenantId: requireBounded(row.tenant_id, 'financial_settlement_obligations.tenant_id', MAX_TENANT_LENGTH),
    orderId: requireBounded(row.order_id, 'financial_settlement_obligations.order_id', MAX_ORDER_ID_LENGTH),
    purpose: requireBounded(row.purpose, 'financial_settlement_obligations.purpose', MAX_PURPOSE_LENGTH),
    amountMinor: requireCheckoutAmount(row.amount_minor),
    currency: requireCurrency(row.currency),
    provider: requireBounded(row.provider, 'financial_settlement_obligations.provider', MAX_PROVIDER_LENGTH),
    providerEventId: requireBounded(
        row.provider_event_id,
        'financial_settlement_obligations.provider_event_id',
        MAX_PROVIDER_EVENT_ID_LENGTH,
    ),
    payloadHash: requirePayloadHash(row.payload_hash, 'financial_settlement_obligations.payload_hash'),
    status: requireObligationStatus(row.status),
    feeMinor: requireNullableAmount(row.fee_minor, 'financial_settlement_obligations.fee_minor'),
    taxMinor: requireNullableAmount(row.tax_minor, 'financial_settlement_obligations.tax_minor'),
    netMinor: requireNullableAmount(row.net_minor, 'financial_settlement_obligations.net_minor'),
    reconciliationStatus: requireReconciliationStatus(row.reconciliation_status),
    version: normalizeSqlVersion(row.version, 'financial_settlement_obligations.version'),
    createdAt: toIso(row.created_at, 'financial_settlement_obligations.created_at'),
});

const assertOrderInvariants = (order: CheckoutOrder): void => {
    if (order.status === 'paid') {
        if (order.confirmedAt === null || order.confirmedProviderEventId === null) {
            throw new PaymentCheckoutSqlError(
                'invalid_row',
                'a paid checkout order requires confirmedAt and confirmedProviderEventId',
            );
        }
    } else if (order.confirmedAt !== null || order.confirmedProviderEventId !== null) {
        throw new PaymentCheckoutSqlError(
            'invalid_row',
            'only a paid checkout order may carry confirmation fields',
        );
    }
    if ((order.lastEventAt === null) !== (order.lastProviderEventId === null)) {
        throw new PaymentCheckoutSqlError(
            'invalid_row',
            'lastEventAt and lastProviderEventId must both be present or both be null',
        );
    }
};

const patchOfInput = (patch: CheckoutOrderPatch, tenantId: string, orderId: string): CheckoutOrder => {
    const status = requireStatus(patch.status);
    const confirmedAt = patch.confirmedAt === null
        ? null
        : requireTimestamp(patch.confirmedAt, 'checkout confirmedAt');
    const confirmedProviderEventId = requireNullableBounded(
        patch.confirmedProviderEventId,
        'checkout confirmedProviderEventId',
        MAX_PROVIDER_EVENT_ID_LENGTH,
    );
    const lastEventAt = patch.lastEventAt === null
        ? null
        : requireTimestamp(patch.lastEventAt, 'checkout lastEventAt');
    const lastProviderEventId = requireNullableBounded(
        patch.lastProviderEventId,
        'checkout lastProviderEventId',
        MAX_PROVIDER_EVENT_ID_LENGTH,
    );
    const probe: CheckoutOrder = {
        orderId,
        tenantId,
        payerReference: '',
        purpose: '',
        amountMinor: 0n,
        currency: 'EGP',
        status,
        createdAt: '',
        expiresAt: '',
        version: 0,
        confirmedAt,
        confirmedProviderEventId,
        lastEventAt,
        lastProviderEventId,
    };
    assertOrderInvariants(probe);
    return probe;
};

export interface PaymentCheckoutSqlTransaction extends CheckoutTransaction {
    /**
     * The ONLY checkout audit path: routes the sealed record through the
     * required constructor sink on THIS transaction's connection.
     */
    writeAudit(record: CheckoutAuditRecord): Promise<void>;
}

class PaymentCheckoutSqlTransactionImpl implements PaymentCheckoutSqlTransaction {
    constructor(
        private readonly conn: CheckoutSqlConnection,
        private readonly audit: CheckoutSqlAuditSink,
    ) {}

    async writeAudit(record: CheckoutAuditRecord): Promise<void> {
        await this.audit(this.conn, record);
    }

    async insertOrder(order: CheckoutOrder): Promise<'inserted' | 'duplicate_key'> {
        const tenant = requireBounded(order.tenantId, 'order.tenantId', MAX_TENANT_LENGTH);
        const orderId = requireBounded(order.orderId, 'order.orderId', MAX_ORDER_ID_LENGTH);
        const payerReference = requireBounded(
            order.payerReference,
            'order.payerReference',
            MAX_PAYER_REFERENCE_LENGTH,
        );
        const purpose = requireBounded(order.purpose, 'order.purpose', MAX_PURPOSE_LENGTH);
        const amount = requireCheckoutAmount(order.amountMinor);
        const currency = requireCurrency(order.currency);
        const status = requireStatus(order.status);
        const createdAt = requireTimestamp(order.createdAt, 'order.createdAt');
        const expiresAt = requireTimestamp(order.expiresAt, 'order.expiresAt');
        assertOrderInvariants({ ...order, status });
        if (Date.parse(expiresAt) <= Date.parse(createdAt)) {
            throw new PaymentCheckoutSqlError('invalid_row', 'expiresAt must be later than createdAt');
        }
        const version = normalizeSqlVersion(order.version, 'order.version');

        await this.conn.execute(`SAVEPOINT ${CHECKOUT_INSERT_SAVEPOINT}`);
        try {
            await this.conn.execute(
                `INSERT INTO checkout_orders
                    (tenant_id, order_id, payer_reference, purpose, amount_minor,
                     currency, status, created_at, expires_at, confirmed_at,
                     confirmed_provider_event_id, last_event_at, last_provider_event_id, version)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    tenant,
                    orderId,
                    payerReference,
                    purpose,
                    amount.toString(),
                    currency,
                    status,
                    createdAt,
                    expiresAt,
                    order.confirmedAt,
                    order.confirmedProviderEventId,
                    order.lastEventAt,
                    order.lastProviderEventId,
                    version,
                ],
            );
            await this.conn.execute(`RELEASE SAVEPOINT ${CHECKOUT_INSERT_SAVEPOINT}`);
        } catch (error) {
            await this.rollbackToSavepoint(CHECKOUT_INSERT_SAVEPOINT);
            if (isDuplicateError(error)) {
                const keyName = duplicateKeyNameOf(error);
                if (keyName === null || !ORDER_DUP_KEYS.has(keyName)) throw error;
                return 'duplicate_key';
            }
            if (isForeignKeyError(error)) {
                throw new PaymentCheckoutSqlError(
                    'foreign_key_violation',
                    'checkout order insert referenced a missing/foreign tenant',
                );
            }
            throw error;
        }
        return 'inserted';
    }

    async findOrderForUpdate(tenantId: string, orderId: string): Promise<CheckoutOrder | null> {
        return this.selectOrder(tenantId, orderId, ' FOR UPDATE');
    }

    private async selectOrder(
        tenantId: string,
        orderId: string,
        lockSuffix: string,
    ): Promise<CheckoutOrder | null> {
        const tenant = requireBounded(tenantId, 'tenantId', MAX_TENANT_LENGTH);
        const id = requireBounded(orderId, 'orderId', MAX_ORDER_ID_LENGTH);
        /*
         * `checkout_orders.order_id` is utf8mb4_unicode_ci. The explicit
         * binary collation on the caller value makes a case/accent variant a
         * miss (null) instead of a silent match to another order. The row is
         * also checked byte-exactly after the read as a belt-and-braces guard.
         */
        const rows = await this.conn.query<OrderRowDb>(
            `SELECT ${ORDER_COLUMNS}
               FROM checkout_orders
              WHERE tenant_id = ? AND order_id = ? AND order_id COLLATE utf8mb4_0900_bin = ?
              LIMIT 1${lockSuffix}`,
            [tenant, id, id],
        );
        const row = rows[0];
        if (row === undefined) return null;
        const order = orderOfRow(row, tenant);
        if (order.orderId !== id) {
            throw new PaymentCheckoutSqlError(
                'invalid_row',
                'the checkout order read did not match the requested canonical order id',
            );
        }
        return order;
    }

    async updateOrderCas(
        tenantId: string,
        orderId: string,
        expectedVersion: number,
        patch: CheckoutOrderPatch,
    ): Promise<UpdateOrderCasResult> {
        const tenant = requireBounded(tenantId, 'tenantId', MAX_TENANT_LENGTH);
        const id = requireBounded(orderId, 'orderId', MAX_ORDER_ID_LENGTH);
        const expected = normalizeSqlVersion(expectedVersion, 'order expectedVersion');
        const checked = patchOfInput(patch, tenant, id);

        const result = await this.conn.execute(
            `UPDATE checkout_orders
                SET status = ?, confirmed_at = ?, confirmed_provider_event_id = ?,
                    last_event_at = ?, last_provider_event_id = ?, version = version + 1
              WHERE tenant_id = ? AND order_id = ? AND order_id COLLATE utf8mb4_0900_bin = ? AND version = ?`,
            [
                checked.status,
                checked.confirmedAt,
                checked.confirmedProviderEventId,
                checked.lastEventAt,
                checked.lastProviderEventId,
                tenant,
                id,
                id,
                expected,
            ],
        );
        const affected = requireCasAffectedRows(result.affectedRows);
        if (affected === 1) {
            const updated = await this.selectOrder(tenant, id, '');
            if (updated === null) {
                throw new PaymentCheckoutSqlError('invalid_row', 'an updated checkout order disappeared');
            }
            return { ok: true, order: updated };
        }
        if (affected !== 0) {
            throw new PaymentCheckoutSqlError(
                'store_overrun',
                `the checkout CAS UPDATE reported ${affected} affected rows where exactly one was possible`,
            );
        }
        const current = await this.selectOrder(tenant, id, '');
        if (current === null) return { ok: false, reason: 'not_found' };
        if (current.version !== expected) return { ok: false, reason: 'version_conflict' };
        throw new PaymentCheckoutSqlError(
            'invalid_row',
            'the checkout CAS matched the version but wrote nothing',
        );
    }

    async insertProviderEvent(record: ProviderEventRecord): Promise<InsertProviderEventResult> {
        const provider = requireBounded(record.provider, 'event.provider', MAX_PROVIDER_LENGTH);
        const providerEventId = requireBounded(
            record.providerEventId,
            'event.providerEventId',
            MAX_PROVIDER_EVENT_ID_LENGTH,
        );
        const tenant = requireBounded(record.tenantId, 'event.tenantId', MAX_TENANT_LENGTH);
        const orderRef = requireBounded(record.orderRef, 'event.orderRef', MAX_ORDER_ID_LENGTH);
        const amount = requireCheckoutAmount(record.amountMinor);
        const currency = requireCurrency(record.currency);
        const status = requireProviderStatus(record.status);
        const outcome = requireOutcome(record.outcome);
        const reason = requireReason(record.reason);
        const occurredAt = requireTimestamp(record.occurredAt, 'event.occurredAt');
        const rawPayloadHash = requireBounded(
            record.rawPayloadHash,
            'event.rawPayloadHash',
            MAX_PAYLOAD_HASH_LENGTH,
        );
        const recordedAt = requireTimestamp(record.recordedAt, 'event.recordedAt');

        await this.conn.execute(`SAVEPOINT ${CHECKOUT_EVENT_SAVEPOINT}`);
        try {
            await this.conn.execute(
                `INSERT INTO checkout_provider_events
                    (provider, provider_event_id, tenant_id, order_ref, amount_minor,
                     currency, status, outcome, reason, occurred_at, raw_payload_hash, recorded_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    provider,
                    providerEventId,
                    tenant,
                    orderRef,
                    amount.toString(),
                    currency,
                    status,
                    outcome,
                    reason,
                    occurredAt,
                    rawPayloadHash,
                    recordedAt,
                ],
            );
            await this.conn.execute(`RELEASE SAVEPOINT ${CHECKOUT_EVENT_SAVEPOINT}`);
        } catch (error) {
            await this.rollbackToSavepoint(CHECKOUT_EVENT_SAVEPOINT);
            if (isDuplicateError(error)) {
                const keyName = duplicateKeyNameOf(error);
                if (keyName === null || !PROVIDER_EVENT_DUP_KEYS.has(keyName)) throw error;
                // Locking CURRENT read: the winning row may have committed after
                // this transaction's snapshot, so a plain SELECT would return null.
                const existing = await this.selectProviderEvent(provider, providerEventId, ' FOR SHARE');
                if (existing === null) {
                    throw new PaymentCheckoutSqlError(
                        'invalid_row',
                        'a duplicate checkout provider event could not be re-read',
                    );
                }
                if (existing.tenantId !== tenant) {
                    throw new PaymentCheckoutSqlError(
                        'tenant_mismatch',
                        'the provider event id already belongs to another tenant',
                    );
                }
                return { inserted: false, duplicate: true, record: existing };
            }
            if (isForeignKeyError(error)) {
                throw new PaymentCheckoutSqlError(
                    'foreign_key_violation',
                    'checkout provider event referenced a missing/foreign tenant',
                );
            }
            throw error;
        }
        return {
            inserted: true,
            record: { ...record, amountMinor: amount, status, outcome, reason },
        };
    }

    async findOrderIdempotency(
        tenantId: string,
        scope: string,
        idempotencyKey: string,
    ): Promise<CheckoutOrderIdempotencyRecord | null> {
        return this.selectOrderIdempotency(tenantId, scope, idempotencyKey, '');
    }

    async insertOrderIdempotency(
        record: CheckoutOrderIdempotencyRecord,
    ): Promise<InsertOrderIdempotencyResult> {
        const tenant = requireBounded(record.tenantId, 'idempotency.tenantId', MAX_TENANT_LENGTH);
        const scope = requireBounded(record.scope, 'idempotency.scope', MAX_IDEMPOTENCY_SCOPE_LENGTH);
        const idempotencyKey = requireBounded(
            record.idempotencyKey,
            'idempotency.idempotencyKey',
            MAX_IDEMPOTENCY_KEY_LENGTH,
        );
        const payloadHash = requirePayloadHash(record.payloadHash, 'idempotency.payloadHash');
        const orderId = requireBounded(record.orderId, 'idempotency.orderId', MAX_ORDER_ID_LENGTH);
        const createdAt = requireTimestamp(record.createdAt, 'idempotency.createdAt');

        await this.conn.execute(`SAVEPOINT ${CHECKOUT_IDEMPOTENCY_SAVEPOINT}`);
        try {
            await this.conn.execute(
                `INSERT INTO checkout_order_idempotency_keys
                    (tenant_id, scope, idempotency_key, payload_hash, order_id, created_at)
                 VALUES (?, ?, ?, ?, ?, ?)`,
                [tenant, scope, idempotencyKey, payloadHash, orderId, createdAt],
            );
            await this.conn.execute(`RELEASE SAVEPOINT ${CHECKOUT_IDEMPOTENCY_SAVEPOINT}`);
        } catch (error) {
            await this.rollbackToSavepoint(CHECKOUT_IDEMPOTENCY_SAVEPOINT);
            if (isDuplicateError(error)) {
                const keyName = duplicateKeyNameOf(error);
                if (keyName === null || !IDEMPOTENCY_DUP_KEYS.has(keyName)) throw error;
                // Locking CURRENT read: the winning row may have committed after
                // this transaction's snapshot, so a plain SELECT could miss it.
                const existing = await this.selectOrderIdempotency(
                    tenant,
                    scope,
                    idempotencyKey,
                    ' FOR SHARE',
                );
                if (existing === null) {
                    throw new PaymentCheckoutSqlError(
                        'invalid_row',
                        'a duplicate checkout idempotency record could not be re-read',
                    );
                }
                return { inserted: false, duplicate: true, record: existing };
            }
            if (isForeignKeyError(error)) {
                throw new PaymentCheckoutSqlError(
                    'foreign_key_violation',
                    'checkout idempotency record referenced a missing/foreign tenant or order',
                );
            }
            throw error;
        }
        const stored = await this.selectOrderIdempotency(tenant, scope, idempotencyKey, '');
        if (stored === null) {
            throw new PaymentCheckoutSqlError(
                'invalid_row',
                'an inserted checkout idempotency record could not be re-read',
            );
        }
        return { inserted: true, record: stored };
    }

    async recordSettlementObligation(
        draft: SettlementObligationDraft,
    ): Promise<RecordSettlementObligationResult> {
        const id = requireObligationId(draft.id);
        const tenant = requireBounded(draft.tenantId, 'obligation.tenantId', MAX_TENANT_LENGTH);
        const orderId = requireBounded(draft.orderId, 'obligation.orderId', MAX_ORDER_ID_LENGTH);
        const purpose = requireBounded(draft.purpose, 'obligation.purpose', MAX_PURPOSE_LENGTH);
        const amount = requireCheckoutAmount(draft.amountMinor);
        const currency = requireCurrency(draft.currency);
        const provider = requireBounded(draft.provider, 'obligation.provider', MAX_PROVIDER_LENGTH);
        const providerEventId = requireBounded(
            draft.providerEventId,
            'obligation.providerEventId',
            MAX_PROVIDER_EVENT_ID_LENGTH,
        );
        const payloadHash = requirePayloadHash(draft.payloadHash, 'obligation.payloadHash');

        /*
         * The provider-event FK is (provider, provider_event_id) only, so the
         * schema cannot prove tenant equality. This adapter invariant does:
         * the verified event must exist, belong to the same tenant, and carry
         * the same canonical order, amount and currency.
         */
        const storedEvent = await this.selectProviderEvent(provider, providerEventId, ' FOR SHARE');
        if (storedEvent === null) {
            throw new PaymentCheckoutSqlError(
                'invalid_row',
                'a settlement obligation references a missing verified provider event',
            );
        }
        if (storedEvent.tenantId !== tenant) {
            throw new PaymentCheckoutSqlError(
                'tenant_mismatch',
                'the verified provider event belongs to another tenant',
            );
        }
        if (
            storedEvent.orderRef !== orderId
            || storedEvent.amountMinor !== amount
            || storedEvent.currency !== currency
        ) {
            throw new PaymentCheckoutSqlError(
                'invalid_row',
                'the settlement obligation does not match the verified provider event',
            );
        }

        await this.conn.execute(`SAVEPOINT ${CHECKOUT_OBLIGATION_SAVEPOINT}`);
        try {
            await this.conn.execute(
                `INSERT INTO financial_settlement_obligations
                    (id, tenant_id, order_id, purpose, amount_minor, currency,
                     provider, provider_event_id, payload_hash, status,
                     fee_minor, tax_minor, net_minor, reconciliation_status, version)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, NULL, 'unreconciled', 0)`,
                [
                    id,
                    tenant,
                    orderId,
                    purpose,
                    amount.toString(),
                    currency,
                    provider,
                    providerEventId,
                    payloadHash,
                ],
            );
            await this.conn.execute(`RELEASE SAVEPOINT ${CHECKOUT_OBLIGATION_SAVEPOINT}`);
        } catch (error) {
            await this.rollbackToSavepoint(CHECKOUT_OBLIGATION_SAVEPOINT);
            if (isDuplicateError(error)) {
                const keyName = duplicateKeyNameOf(error);
                if (keyName === null || !OBLIGATION_DUP_KEYS.has(keyName)) throw error;
                const existing = await this.selectDuplicateObligation(
                    keyName,
                    id,
                    tenant,
                    orderId,
                    purpose,
                    provider,
                    providerEventId,
                );
                if (existing === null) {
                    throw new PaymentCheckoutSqlError(
                        'invalid_row',
                        'a duplicate settlement obligation could not be re-read',
                    );
                }
                if (existing.tenantId !== tenant) {
                    throw new PaymentCheckoutSqlError(
                        'tenant_mismatch',
                        'the settlement obligation unique key belongs to another tenant',
                    );
                }
                return { inserted: false, duplicate: true, obligation: existing };
            }
            if (isForeignKeyError(error)) {
                throw new PaymentCheckoutSqlError(
                    'foreign_key_violation',
                    'settlement obligation referenced a missing/foreign tenant, order or provider event',
                );
            }
            throw error;
        }
        const stored = await this.selectObligationById(id, tenant);
        if (stored === null) {
            throw new PaymentCheckoutSqlError(
                'invalid_row',
                'an inserted settlement obligation could not be re-read',
            );
        }
        return { inserted: true, obligation: stored };
    }

    private async selectOrderIdempotency(
        tenantId: string,
        scope: string,
        idempotencyKey: string,
        lockSuffix: string,
    ): Promise<CheckoutOrderIdempotencyRecord | null> {
        const tenant = requireBounded(tenantId, 'tenantId', MAX_TENANT_LENGTH);
        const scopeValue = requireBounded(scope, 'scope', MAX_IDEMPOTENCY_SCOPE_LENGTH);
        const key = requireBounded(
            idempotencyKey,
            'idempotencyKey',
            MAX_IDEMPOTENCY_KEY_LENGTH,
        );
        const rows = await this.conn.query<IdempotencyRowDb>(
            `SELECT ${IDEMPOTENCY_COLUMNS}
               FROM checkout_order_idempotency_keys
              WHERE tenant_id = ? AND scope = ? AND idempotency_key = ?
                AND tenant_id COLLATE utf8mb4_0900_bin = ?
                AND scope COLLATE utf8mb4_0900_bin = ?
                AND idempotency_key COLLATE utf8mb4_0900_bin = ?
              LIMIT 1${lockSuffix}`,
            [tenant, scopeValue, key, tenant, scopeValue, key],
        );
        const row = rows[0];
        return row === undefined ? null : idempotencyOfRow(row, tenant, scopeValue, key);
    }

    private async selectObligationById(
        id: string,
        tenantId: string,
        lockSuffix = '',
    ): Promise<SettlementObligation | null> {
        const obligationId = requireObligationId(id);
        const tenant = requireBounded(tenantId, 'tenantId', MAX_TENANT_LENGTH);
        const rows = await this.conn.query<ObligationRowDb>(
            `SELECT ${OBLIGATION_COLUMNS}
               FROM financial_settlement_obligations
              WHERE id = ? AND tenant_id = ?
                AND id COLLATE utf8mb4_0900_bin = ?
                AND tenant_id COLLATE utf8mb4_0900_bin = ?
              LIMIT 1${lockSuffix}`,
            [obligationId, tenant, obligationId, tenant],
        );
        const row = rows[0];
        return row === undefined ? null : obligationOfRow(row);
    }

    private async selectDuplicateObligation(
        keyName: string,
        id: string,
        tenantId: string,
        orderId: string,
        purpose: string,
        provider: string,
        providerEventId: string,
    ): Promise<SettlementObligation | null> {
        const tenant = requireBounded(tenantId, 'tenantId', MAX_TENANT_LENGTH);
        if (keyName === OBLIGATION_PAYMENT_DUP_KEY) {
            const rows = await this.conn.query<ObligationRowDb>(
                `SELECT ${OBLIGATION_COLUMNS}
                   FROM financial_settlement_obligations
                  WHERE tenant_id = ? AND provider = ? AND provider_event_id = ?
                    AND tenant_id COLLATE utf8mb4_0900_bin = ?
                  LIMIT 1 FOR SHARE`,
                [tenant, requireBounded(provider, 'provider', MAX_PROVIDER_LENGTH),
                    requireBounded(providerEventId, 'providerEventId', MAX_PROVIDER_EVENT_ID_LENGTH), tenant],
            );
            const row = rows[0];
            return row === undefined ? null : obligationOfRow(row);
        }
        if (keyName === OBLIGATION_ORDER_DUP_KEY) {
            const rows = await this.conn.query<ObligationRowDb>(
                `SELECT ${OBLIGATION_COLUMNS}
                   FROM financial_settlement_obligations
                  WHERE tenant_id = ? AND order_id = ? AND purpose = ?
                    AND tenant_id COLLATE utf8mb4_0900_bin = ?
                    AND order_id COLLATE utf8mb4_0900_bin = ?
                    AND purpose COLLATE utf8mb4_0900_bin = ?
                  LIMIT 1 FOR SHARE`,
                [tenant, requireBounded(orderId, 'orderId', MAX_ORDER_ID_LENGTH),
                    requireBounded(purpose, 'purpose', MAX_PURPOSE_LENGTH),
                    tenant, requireBounded(orderId, 'orderId', MAX_ORDER_ID_LENGTH),
                    requireBounded(purpose, 'purpose', MAX_PURPOSE_LENGTH)],
            );
            const row = rows[0];
            return row === undefined ? null : obligationOfRow(row);
        }
        return this.selectObligationById(id, tenant, ' FOR SHARE');
    }

    /**
     * The contract's read key is the GLOBAL `(provider, provider_event_id)` PK,
     * so the SQL predicate cannot carry a tenant. When the caller supplies
     * `expectedTenantId` (the domain always does), a row that belongs to
     * another tenant is rejected as a typed `tenant_mismatch` inside the store
     * method; the row is never returned for a cross-tenant replay. The guarded
     * facade in `createCheckoutSqlBinder.applyEvent` keeps its independent
     * belt-and-braces check.
     */
    async findProviderEvent(
        provider: string,
        providerEventId: string,
        expectedTenantId?: string,
    ): Promise<ProviderEventRecord | null> {
        const record = await this.selectProviderEvent(provider, providerEventId, '');
        if (record !== null && expectedTenantId !== undefined) {
            const expected = requireBounded(expectedTenantId, 'expectedTenantId', MAX_TENANT_LENGTH);
            if (record.tenantId !== expected) {
                throw new PaymentCheckoutSqlError(
                    'tenant_mismatch',
                    'the provider event id belongs to another tenant',
                );
            }
        }
        return record;
    }

    private async selectProviderEvent(
        provider: string,
        providerEventId: string,
        lockSuffix: string,
    ): Promise<ProviderEventRecord | null> {
        const providerCode = requireBounded(provider, 'provider', MAX_PROVIDER_LENGTH);
        const eventId = requireBounded(providerEventId, 'providerEventId', MAX_PROVIDER_EVENT_ID_LENGTH);
        const rows = await this.conn.query<EventRowDb>(
            `SELECT ${EVENT_COLUMNS}
               FROM checkout_provider_events
              WHERE provider = ? AND provider_event_id = ?
              LIMIT 1${lockSuffix}`,
            [providerCode, eventId],
        );
        const row = rows[0];
        return row === undefined ? null : eventOfRow(row);
    }

    async listOrdersForReconciliation(
        tenantId: string,
        query?: { readonly limit?: number },
    ): Promise<CheckoutOrderPage> {
        const tenant = requireBounded(tenantId, 'tenantId', MAX_TENANT_LENGTH);
        const limit = requireListLimit(query?.limit);
        const rows = await this.conn.query<OrderRowDb>(
            `SELECT ${ORDER_COLUMNS}
               FROM checkout_orders
              WHERE tenant_id = ?
              ORDER BY created_at ASC, order_id ASC
              LIMIT ?`,
            [tenant, limit + 1],
        );
        const truncated = rows.length > limit;
        const orders: CheckoutOrder[] = [];
        for (const row of rows.slice(0, limit)) {
            orders.push(orderOfRow(row, tenant));
        }
        return { orders, truncated };
    }

    /**
     * Platform target resolution (global lock order G1 -> G2 -> G3). The
     * request's `invoice_ref_id` is learned with a PLAIN read (an immutable id
     * only), the invoice row and its allocations are then locked through the
     * bound read-only settlement view (`computeInvoiceOutstanding`, shared debt
     * source; its audit sink always refuses so it can never write), and ONLY
     * AFTER that the request row is locked `FOR UPDATE` and re-checked. Nothing
     * here trusts caller text: invoice, currency and amount come from the
     * locked rows. An unknown/incomplete debt source is
     * `debt_source_unavailable`, never zero. A legacy request without
     * `invoice_ref_id` is `unresolved_reference` BEFORE any invoice read.
     */
    async resolvePlatformTarget(
        tenantId: string,
        requestId: string,
    ): Promise<ResolvePlatformTargetResult> {
        const tenant = requireBounded(tenantId, 'tenantId', MAX_TENANT_LENGTH);
        const id = requireBounded(requestId, 'requestId', PLATFORM_REQUEST_ID_LENGTH);

        let plain: RequestRowDb | undefined;
        try {
            plain = (await this.selectRequestRow(tenant, id, '')) ?? undefined;
        } catch (error) {
            if (isMissingSourceError(error)) return { ok: false, reason: 'debt_source_unavailable' };
            throw error;
        }
        if (plain === undefined) return { ok: false, reason: 'request_not_found' };
        if (plain.invoice_ref_id === null) return { ok: false, reason: 'unresolved_reference' };
        const invoiceRef = requireBounded(plain.invoice_ref_id, 'request.invoice_ref_id', PLATFORM_REQUEST_ID_LENGTH);

        const reader = createBoundBillingSettlementSqlTransaction(this.conn, {
            transaction: () => {
                throw new PaymentCheckoutSqlError(
                    'invalid_runner',
                    'the read-only settlement view must never open a transaction',
                );
            },
            audit: () => {
                throw new PaymentCheckoutSqlError(
                    'invalid_audit',
                    'the read-only settlement view must never write an audit row',
                );
            },
        });
        // G1-G2: invoice FOR UPDATE + allocations (locking current read).
        const outstanding = await computeInvoiceOutstanding(reader, tenant, invoiceRef);
        if (!outstanding.ok) {
            return {
                ok: false,
                reason: outstanding.reason === 'invoice_not_found'
                    ? 'debt_source_unavailable'
                    : outstanding.reason,
            };
        }

        // G3: the request row, only after G1-G2.
        let locked: RequestRowDb | null;
        try {
            locked = await this.selectRequestRow(tenant, id, ' FOR UPDATE');
        } catch (error) {
            if (isMissingSourceError(error)) return { ok: false, reason: 'debt_source_unavailable' };
            throw error;
        }
        if (locked === null) return { ok: false, reason: 'request_not_found' };
        if (locked.invoice_ref_id === null) return { ok: false, reason: 'unresolved_reference' };
        if (locked.invoice_ref_id !== invoiceRef) {
            // The link changed between the plain read and the lock: unprovable.
            return { ok: false, reason: 'debt_source_unavailable' };
        }
        if (locked.status !== 'open' && locked.status !== 'expired') {
            return { ok: false, reason: 'request_not_payable' };
        }
        const currency = requireCurrency(locked.currency);
        if (outstanding.invoiceId !== invoiceRef || outstanding.currency !== currency) {
            return { ok: false, reason: 'debt_source_unavailable' };
        }
        const requestAmountMinor = requireCheckoutAmount(locked.amount_minor);
        const outstandingMinor = normalizeSqlBigInt(outstanding.outstandingMinor, 'invoice.outstandingMinor');
        if (outstandingMinor < 0n) return { ok: false, reason: 'debt_source_unavailable' };
        return {
            ok: true,
            target: {
                requestId: requireBounded(locked.id, 'request.id', PLATFORM_REQUEST_ID_LENGTH),
                invoiceId: invoiceRef,
                currency,
                requestAmountMinor,
                outstandingMinor,
                requestStatus: locked.status,
            },
        };
    }

    private async selectRequestRow(
        tenantId: string,
        requestId: string,
        lockSuffix: string,
    ): Promise<RequestRowDb | null> {
        // Plain index-usable equality first, the binary-exact guard second,
        // the lock clause strictly after LIMIT.
        const rows = await this.conn.query<RequestRowDb>(
            `SELECT id, tenant_id, invoice_ref_id, amount_minor, currency, status
               FROM billing_difference_requests
              WHERE tenant_id = ? AND id = ?
                AND tenant_id COLLATE utf8mb4_0900_bin = ?
                AND id COLLATE utf8mb4_0900_bin = ?
              LIMIT 1${lockSuffix}`,
            [tenantId, requestId, tenantId, requestId],
        );
        const row = rows[0];
        if (row === undefined) return null;
        if (row.tenant_id !== tenantId || row.id !== requestId) {
            throw new PaymentCheckoutSqlError(
                'invalid_row',
                'the difference request read did not match the requested tenant/request id',
            );
        }
        return row;
    }

    async insertPlatformTarget(target: PlatformPaymentTarget): Promise<'inserted' | 'duplicate_key'> {
        const tenant = requireBounded(target.tenantId, 'target.tenantId', MAX_TENANT_LENGTH);
        const orderId = requireBounded(target.orderId, 'target.orderId', MAX_ORDER_ID_LENGTH);
        const purpose = requireBounded(target.purpose, 'target.purpose', MAX_PURPOSE_LENGTH);
        const requestId = requireBounded(target.requestId, 'target.requestId', PLATFORM_REQUEST_ID_LENGTH);
        const invoiceId = requireBounded(target.invoiceId, 'target.invoiceId', PLATFORM_REQUEST_ID_LENGTH);
        const currency = requireCurrency(target.currency);
        const amount = requireCheckoutAmount(target.amountMinor);

        await this.conn.execute(`SAVEPOINT ${CHECKOUT_PLATFORM_TARGET_SAVEPOINT}`);
        try {
            await this.conn.execute(
                `INSERT INTO checkout_order_platform_targets
                    (tenant_id, order_id, purpose, request_id, invoice_id, currency, amount_minor)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`,
                [tenant, orderId, purpose, requestId, invoiceId, currency, amount.toString()],
            );
            await this.conn.execute(`RELEASE SAVEPOINT ${CHECKOUT_PLATFORM_TARGET_SAVEPOINT}`);
        } catch (error) {
            await this.rollbackToSavepoint(CHECKOUT_PLATFORM_TARGET_SAVEPOINT);
            if (isDuplicateError(error)) {
                const keyName = duplicateKeyNameOf(error);
                if (keyName === null || !PLATFORM_TARGET_DUP_KEYS.has(keyName)) throw error;
                // Locking CURRENT read of the winning row (proof only; the
                // domain refuses the creation on a duplicate).
                const existing = await this.selectPlatformTarget(tenant, orderId, ' FOR SHARE');
                if (existing === null) {
                    throw new PaymentCheckoutSqlError(
                        'invalid_row',
                        'a duplicate platform target could not be re-read',
                    );
                }
                return 'duplicate_key';
            }
            if (isForeignKeyError(error)) {
                throw new PaymentCheckoutSqlError(
                    'foreign_key_violation',
                    'platform target referenced a missing/foreign tenant, order, request or invoice',
                );
            }
            if (isMissingSourceError(error)) {
                throw new PaymentCheckoutSqlError(
                    'schema_unavailable',
                    'checkout_order_platform_targets is unavailable',
                );
            }
            throw error;
        }
        const stored = await this.selectPlatformTarget(tenant, orderId, ' FOR SHARE');
        if (
            stored === null
            || stored.purpose !== purpose
            || stored.requestId !== requestId
            || stored.invoiceId !== invoiceId
            || stored.currency !== currency
            || stored.amountMinor !== amount
        ) {
            throw new PaymentCheckoutSqlError(
                'invalid_row',
                'an inserted platform target could not be re-read identically',
            );
        }
        return 'inserted';
    }

    /**
     * The ONLY reader of an order's immutable binding. The target row is read
     * `FOR SHARE` (G6) joined to its order, and the order's own purpose,
     * currency and amount must agree with the binding or the row is invalid.
     */
    async findPlatformTargetByOrder(
        tenantId: string,
        orderId: string,
    ): Promise<PlatformPaymentTarget | null> {
        const tenant = requireBounded(tenantId, 'tenantId', MAX_TENANT_LENGTH);
        const id = requireBounded(orderId, 'orderId', MAX_ORDER_ID_LENGTH);
        return this.selectPlatformTarget(tenant, id, ' FOR SHARE');
    }

    private async selectPlatformTarget(
        tenant: string,
        orderId: string,
        lockSuffix: string,
    ): Promise<PlatformPaymentTarget | null> {
        let rows: PlatformTargetRowDb[];
        try {
            rows = await this.conn.query<PlatformTargetRowDb>(
                `SELECT t.tenant_id, t.order_id, t.purpose, t.request_id, t.invoice_id,
                        t.currency, t.amount_minor,
                        o.purpose AS order_purpose, o.currency AS order_currency,
                        o.amount_minor AS order_amount_minor
                   FROM checkout_order_platform_targets t
                   JOIN checkout_orders o
                     ON o.tenant_id = t.tenant_id AND o.order_id = t.order_id
                  WHERE t.tenant_id = ? AND t.order_id = ?
                    AND t.order_id COLLATE utf8mb4_0900_bin = ?
                  LIMIT 1${lockSuffix}`,
                [tenant, orderId, orderId],
            );
        } catch (error) {
            if (isMissingSourceError(error)) {
                throw new PaymentCheckoutSqlError(
                    'schema_unavailable',
                    'checkout_order_platform_targets is unavailable',
                );
            }
            throw error;
        }
        const row = rows[0];
        if (row === undefined) return null;
        const target: PlatformPaymentTarget = {
            tenantId: requireBounded(row.tenant_id, 'checkout_order_platform_targets.tenant_id', MAX_TENANT_LENGTH),
            orderId: requireBounded(row.order_id, 'checkout_order_platform_targets.order_id', MAX_ORDER_ID_LENGTH),
            purpose: requireBounded(row.purpose, 'checkout_order_platform_targets.purpose', MAX_PURPOSE_LENGTH),
            requestId: requireBounded(
                row.request_id,
                'checkout_order_platform_targets.request_id',
                PLATFORM_REQUEST_ID_LENGTH,
            ),
            invoiceId: requireBounded(
                row.invoice_id,
                'checkout_order_platform_targets.invoice_id',
                PLATFORM_REQUEST_ID_LENGTH,
            ),
            currency: requireCurrency(row.currency),
            amountMinor: requireCheckoutAmount(row.amount_minor),
        };
        if (target.tenantId !== tenant || target.orderId !== orderId) {
            throw new PaymentCheckoutSqlError(
                'invalid_row',
                'the platform target read did not match the requested canonical tenant/order id',
            );
        }
        if (
            row.order_purpose !== target.purpose
            || row.order_currency !== target.currency
            || requireCheckoutAmount(row.order_amount_minor) !== target.amountMinor
        ) {
            throw new PaymentCheckoutSqlError(
                'invalid_row',
                'the platform target disagrees with its checkout order',
            );
        }
        return target;
    }

    /**
     * Orders of one request that block a new platform order: status
     * created|pending|paid (failed|expired|cancelled siblings do not block).
     * Read as a locking current read so a concurrently committed order is
     * visible; the request row is already held `FOR UPDATE` by
     * `resolvePlatformTarget`, which serializes creators. The page is bounded;
     * only "zero versus more than zero" matters to the domain.
     */
    async countBlockingPlatformOrders(tenantId: string, requestId: string): Promise<number> {
        const tenant = requireBounded(tenantId, 'tenantId', MAX_TENANT_LENGTH);
        const request = requireBounded(requestId, 'requestId', PLATFORM_REQUEST_ID_LENGTH);
        let rows: Array<{ order_id: string }>;
        try {
            rows = await this.conn.query<{ order_id: string }>(
                `SELECT t.order_id
                   FROM checkout_order_platform_targets t
                   JOIN checkout_orders o
                     ON o.tenant_id = t.tenant_id AND o.order_id = t.order_id
                  WHERE t.tenant_id = ? AND t.request_id = ?
                    AND t.request_id COLLATE utf8mb4_0900_bin = ?
                    AND o.status IN ('created', 'pending', 'paid')
                  ORDER BY t.order_id ASC
                  LIMIT ? FOR SHARE`,
                [tenant, request, request, PLATFORM_BLOCKING_PAGE],
            );
        } catch (error) {
            if (isMissingSourceError(error)) {
                throw new PaymentCheckoutSqlError(
                    'schema_unavailable',
                    'checkout_order_platform_targets is unavailable',
                );
            }
            throw error;
        }
        return rows.length;
    }

    private async rollbackToSavepoint(name: string): Promise<void> {
        await this.conn.execute(`ROLLBACK TO SAVEPOINT ${name}`);
        await this.conn.execute(`RELEASE SAVEPOINT ${name}`);
    }
}

export interface PaymentCheckoutSqlStore extends CheckoutStore<PaymentCheckoutSqlTransaction> {
    /** Bind the transaction handle (and its audit writer) to one open connection. */
    inTransaction(conn: CheckoutSqlConnection): PaymentCheckoutSqlTransaction;
    runAtomic<T>(callback: (tx: PaymentCheckoutSqlTransaction) => Promise<T>): Promise<T>;
}

class PaymentCheckoutSqlStoreImpl implements PaymentCheckoutSqlStore {
    private readonly audit: CheckoutSqlAuditSink;

    constructor(private readonly deps: PaymentCheckoutSqlDeps) {
        if (!deps || typeof deps.transaction !== 'function') {
            throw new PaymentCheckoutSqlError(
                'invalid_runner',
                'PaymentCheckoutSqlStore requires a connection-bound transaction runner',
            );
        }
        if (typeof deps.audit !== 'function') {
            throw new PaymentCheckoutSqlError(
                'invalid_audit',
                'PaymentCheckoutSqlStore requires the sealed connection-bound audit writer',
            );
        }
        this.audit = deps.audit;
    }

    inTransaction(conn: CheckoutSqlConnection): PaymentCheckoutSqlTransaction {
        return new PaymentCheckoutSqlTransactionImpl(conn, this.audit);
    }

    runAtomic<T>(callback: (tx: PaymentCheckoutSqlTransaction) => Promise<T>): Promise<T> {
        return this.deps.transaction((conn) => callback(this.inTransaction(conn)));
    }
}

export const createPaymentCheckoutSqlStore = (deps: PaymentCheckoutSqlDeps): PaymentCheckoutSqlStore =>
    new PaymentCheckoutSqlStoreImpl(deps);

export const createBoundPaymentCheckoutSqlTransaction = (
    conn: CheckoutSqlConnection,
    deps: PaymentCheckoutSqlDeps,
): PaymentCheckoutSqlTransaction => new PaymentCheckoutSqlStoreImpl(deps).inTransaction(conn);

/**
 * Binds the domain's per-command audit writer to the transaction that carries
 * the mutation. One active slot per invocation (never shared across calls);
 * the audit writer refuses to run outside its invitation when a mutation is
 * expected.
 */
export interface CheckoutSqlBinder {
    createOrder(
        input: CreateCheckoutOrderInput,
        options?: Omit<CheckoutOrderOptions, 'audit'>,
    ): Promise<CreateCheckoutOrderResult>;
    applyEvent(
        input: ApplyProviderEventInput,
        deps: Omit<CheckoutApplyDeps, 'audit'>,
    ): Promise<ApplyProviderEventResult>;
}

export const createCheckoutSqlBinder = (store: PaymentCheckoutSqlStore): CheckoutSqlBinder => {
    const auditWriter = (
        active: () => PaymentCheckoutSqlTransaction | null,
        runStandalone: (record: CheckoutAuditRecord) => Promise<void>,
    ): CheckoutAuditWriter => (record) => {
        const tx = active();
        return tx === null ? runStandalone(record) : tx.writeAudit(record);
    };

    return {
        createOrder: (input, options = {}) => {
            let active: PaymentCheckoutSqlTransaction | null = null;
            const storeFacade: CheckoutStore<CheckoutTransaction> = {
                runAtomic: (callback) =>
                    store.runAtomic(async (tx) => {
                        if (active !== null) {
                            throw new PaymentCheckoutSqlError(
                                'invalid_audit',
                                'one checkout order creation cannot open two transactions',
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
            const audit = auditWriter(
                () => active,
                (record) => store.runAtomic((tx) => tx.writeAudit(record)),
            );
            return createCheckoutOrder(storeFacade, input, { ...options, audit });
        },

        applyEvent: (input, deps) => {
            let active: PaymentCheckoutSqlTransaction | null = null;
            const expectedTenant = input.event.tenantId;
            const storeFacade: CheckoutStore<CheckoutTransaction> = {
                runAtomic: (callback) =>
                    store.runAtomic(async (tx) => {
                        if (active !== null) {
                            throw new PaymentCheckoutSqlError(
                                'invalid_audit',
                                'one checkout event application cannot open two transactions',
                            );
                        }
                        active = tx;
                        const guarded: CheckoutTransaction = {
                            insertOrder: (order) => tx.insertOrder(order),
                            findOrderForUpdate: (tenantId, orderId) => tx.findOrderForUpdate(tenantId, orderId),
                            updateOrderCas: (tenantId, orderId, version, patch) =>
                                tx.updateOrderCas(tenantId, orderId, version, patch),
                            insertProviderEvent: (record) => tx.insertProviderEvent(record),
                            findProviderEvent: async (provider, providerEventId, expectedTenantId) => {
                                const expected = expectedTenantId ?? expectedTenant;
                                const record = await tx.findProviderEvent(
                                    provider,
                                    providerEventId,
                                    expected,
                                );
                                if (record !== null && record.tenantId !== expected) {
                                    throw new PaymentCheckoutSqlError(
                                        'tenant_mismatch',
                                        'the provider event id belongs to another tenant',
                                    );
                                }
                                return record;
                            },
                            findOrderIdempotency: (tenantId, scope, idempotencyKey) =>
                                tx.findOrderIdempotency(tenantId, scope, idempotencyKey),
                            insertOrderIdempotency: (record) => tx.insertOrderIdempotency(record),
                            recordSettlementObligation: (draft) =>
                                tx.recordSettlementObligation(draft),
                            listOrdersForReconciliation: (tenantId, query) =>
                                tx.listOrdersForReconciliation(tenantId, query),
                        };
                        try {
                            return await callback(guarded);
                        } finally {
                            active = null;
                        }
                    }),
            };
            const audit = auditWriter(
                () => active,
                (record) => store.runAtomic((tx) => tx.writeAudit(record)),
            );
            return applyProviderEvent(storeFacade, input, { ...deps, audit });
        },
    };
};
