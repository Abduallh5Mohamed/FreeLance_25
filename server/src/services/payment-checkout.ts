/**
 * FIN8 / X6 — vendor-neutral checkout and payment-callback domain.
 *
 * This is a PURE domain: no network, no provider SDK, no SQL, no routes, no
 * migrations and no secrets. Signature verification is INJECTED. Persistence is
 * the injected `CheckoutStore`; the in-memory test store lives in the test file.
 *
 * What it owns:
 *  - the `CheckoutOrder` state machine (`created | pending | paid | failed |
 *    expired | cancelled`), with terminal states immutable;
 *  - a verified `ProviderEvent` application path (dedupe by provider event id,
 *    amount/currency/order identity checks, quarantine for expired/cancelled
 *    orders, deterministic out-of-order handling);
 *  - an immutable `PaymentConfirmedIntent` emitted when an order becomes paid.
 *    Converting that intent into ledger/invoice effects is a LATER integration
 *    step; this module never writes journals, balances, access or receipts;
 *  - a pure `reconcileCheckout` report over orders and provider events.
 *
 * What it deliberately does NOT do:
 *  - choose a PSP, define fees/tax/settlement/chargebacks/recurring consent, or
 *    decide which business purposes exist beyond the opaque `purpose` code
 *    (those are HELD: docs19, inventory §7 D2);
 *  - create cash/offline receipts: cash can never create a merchant available balance;
 *  - credit any available balance. There is no such function in this module by
 *    construction, and a structural test asserts it.
 *
 * Money is exact `bigint` minor units. The largest amount is bounded; versions
 * are safe integers. Every externally visible amount is serialized as a decimal
 * string, never as a JS number (HK2).
 */

import { createHash, randomUUID } from 'node:crypto';

/* =========================================================================
 * Constants and errors
 * ========================================================================= */

export const CHECKOUT_ORDER_STATUSES = [
    'created',
    'pending',
    'paid',
    'failed',
    'expired',
    'cancelled',
] as const;
export type CheckoutOrderStatus = (typeof CHECKOUT_ORDER_STATUSES)[number];

export const TERMINAL_ORDER_STATUSES: readonly CheckoutOrderStatus[] = Object.freeze([
    'paid',
    'failed',
    'expired',
    'cancelled',
]);

export const PROVIDER_EVENT_STATUSES = ['paid', 'failed'] as const;
export type ProviderEventStatus = (typeof PROVIDER_EVENT_STATUSES)[number];

export const PROVIDER_EVENT_OUTCOMES = [
    'paid',
    'failed',
    'ignored',
    'rejected',
    'quarantined',
] as const;
export type ProviderEventOutcome = (typeof PROVIDER_EVENT_OUTCOMES)[number];

export const DISCREPANCY_KINDS = [
    'paid-without-order',
    'order-without-event-past-expiry',
    'amount-mismatch',
    'currency-mismatch',
    'duplicate-events',
    'status-conflict',
] as const;
export type DiscrepancyKind = (typeof DISCREPANCY_KINDS)[number];

/** Largest single order/event amount, in minor units (10^15). */
export const MAX_CHECKOUT_AMOUNT_MINOR = 1_000_000_000_000_000n;
export const MAX_TENANT_LENGTH = 36;
export const MAX_ORDER_ID_LENGTH = 64;
export const MAX_PAYER_REFERENCE_LENGTH = 128;
export const MAX_PURPOSE_LENGTH = 64;
export const MAX_PROVIDER_LENGTH = 64;
export const MAX_PROVIDER_EVENT_ID_LENGTH = 128;
export const MAX_PAYLOAD_HASH_LENGTH = 128;
export const MAX_IDEMPOTENCY_SCOPE_LENGTH = 64;
export const MAX_IDEMPOTENCY_KEY_LENGTH = 128;
export const MAX_CALLER_KEY_HASH_LENGTH = 128;
export const MAX_LIST_LIMIT = 1_000;
export const DEFAULT_LIST_LIMIT = 500;

/** Tenant-scoped idempotency namespace for checkout-order creation (HK1). */
export const CHECKOUT_ORDER_IDEMPOTENCY_SCOPE = 'payment.checkout.order_create';

/** Defensive bound on lost-race retries for a single idempotent create call. */
const MAX_CREATE_IDEMPOTENCY_ATTEMPTS = 3;

const CURRENCY_PATTERN = /^[A-Z]{3}$/;
const CODE_PATTERN = /^[A-Za-z0-9_.:-]+$/;

export type CheckoutErrorCode =
    | 'invalid_input'
    | 'invalid_tenant'
    | 'invalid_order_id'
    | 'invalid_payer_reference'
    | 'invalid_purpose'
    | 'invalid_currency'
    | 'invalid_amount'
    | 'amount_out_of_range'
    | 'invalid_status'
    | 'invalid_event'
    | 'invalid_timestamp'
    | 'invalid_version'
    | 'order_not_found'
    | 'order_exists'
    | 'version_conflict'
    | 'invalid_idempotency_key'
    | 'idempotency_conflict'
    | 'payload_conflict'
    | 'schema_unavailable'
    | 'platform_target_required'
    | 'platform_target_forbidden'
    | 'amount_not_exact'
    | 'amount_exceeds_request'
    | 'amount_exceeds_outstanding'
    | 'platform_order_exists'
    | 'unresolved_reference'
    | 'request_not_found'
    | 'request_not_payable'
    | 'debt_source_unavailable';

export class CheckoutError extends Error {
    constructor(public readonly code: CheckoutErrorCode, message: string) {
        super(message);
        this.name = 'CheckoutError';
    }
}

function fail(code: CheckoutErrorCode, message: string): never {
    throw new CheckoutError(code, message);
}

function requireBoundedString(
    value: unknown,
    field: string,
    maxLength: number,
    code: CheckoutErrorCode,
): string {
    if (typeof value !== 'string') fail(code, `${field} must be a string`);
    const text = value.trim();
    if (text.length === 0 || text.length > maxLength || text !== value) {
        fail(code, `${field} must be a non-empty trimmed string of at most ${maxLength} characters`);
    }
    return text;
}

function requireCode(value: unknown, field: string, maxLength: number, code: CheckoutErrorCode): string {
    const text = requireBoundedString(value, field, maxLength, code);
    if (!CODE_PATTERN.test(text)) {
        fail(code, `${field} must be an opaque code of letters, digits, '_', '.', ':' or '-'`);
    }
    return text;
}

function requireCurrency(value: unknown): string {
    if (typeof value !== 'string' || !CURRENCY_PATTERN.test(value)) {
        fail('invalid_currency', 'currency must be a three-letter uppercase ISO-4217 code');
    }
    return value;
}

function requireTimestamp(value: unknown, field: string): string {
    if (typeof value !== 'string' || value.trim() === '' || Number.isNaN(Date.parse(value))) {
        fail('invalid_timestamp', `${field} must be a parseable timestamp string`);
    }
    return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function normalizeOrderStatus(value: unknown): CheckoutOrderStatus | null {
    if (typeof value !== 'string') return null;
    return (CHECKOUT_ORDER_STATUSES as readonly string[]).includes(value)
        ? (value as CheckoutOrderStatus)
        : null;
}

export function normalizeProviderEventStatus(value: unknown): ProviderEventStatus | null {
    if (typeof value !== 'string') return null;
    return (PROVIDER_EVENT_STATUSES as readonly string[]).includes(value)
        ? (value as ProviderEventStatus)
        : null;
}

/**
 * Validate one exact minor-unit amount. Only `bigint` is accepted; numbers and
 * numeric strings are rejected so no implicitly rounded value can enter
 * checkout. Zero and negative values are rejected.
 */
export function normalizeCheckoutAmountMinor(value: unknown): bigint {
    if (typeof value !== 'bigint') fail('invalid_amount', 'amountMinor must be a bigint of minor units');
    if (value <= 0n) fail('invalid_amount', 'amountMinor must be positive');
    if (value > MAX_CHECKOUT_AMOUNT_MINOR) {
        fail('amount_out_of_range', `amountMinor exceeds ${MAX_CHECKOUT_AMOUNT_MINOR.toString()}`);
    }
    return value;
}

/** Serialize exact minor units as a decimal string (never a JS number). */
export function serializeCheckoutAmountMinor(value: bigint): string {
    if (typeof value !== 'bigint') fail('invalid_amount', 'amountMinor must be a bigint of minor units');
    return value.toString();
}

/* =========================================================================
 * Order state machine
 * ========================================================================= */

/**
 * Legal forward transitions. `paid`, `failed`, `expired` and `cancelled` are
 * terminal: no transition leaves them, so a terminal order is immutable.
 */
const LEGAL_ORDER_TRANSITIONS: Readonly<Record<CheckoutOrderStatus, readonly CheckoutOrderStatus[]>> =
    Object.freeze({
        created: ['pending', 'paid', 'failed', 'expired', 'cancelled'],
        pending: ['paid', 'failed', 'expired', 'cancelled'],
        paid: [],
        failed: [],
        expired: [],
        cancelled: [],
    });

export interface OrderTransitionDecision {
    readonly allowed: boolean;
    readonly idempotent: boolean;
    readonly reason: 'unknown-status' | 'illegal-transition' | null;
}

/**
 * Evaluate one transition. Repeating the same status is an idempotent no-op;
 * any move absent from the table is rejected.
 */
export function evaluateOrderTransition(from: unknown, to: unknown): OrderTransitionDecision {
    const fromStatus = normalizeOrderStatus(from);
    const toStatus = normalizeOrderStatus(to);
    if (fromStatus === null || toStatus === null) {
        return { allowed: false, idempotent: false, reason: 'unknown-status' };
    }
    if (fromStatus === toStatus) return { allowed: true, idempotent: true, reason: null };
    return LEGAL_ORDER_TRANSITIONS[fromStatus].includes(toStatus)
        ? { allowed: true, idempotent: false, reason: null }
        : { allowed: false, idempotent: false, reason: 'illegal-transition' };
}

export function isTerminalOrderStatus(status: CheckoutOrderStatus): boolean {
    return TERMINAL_ORDER_STATUSES.includes(status);
}

/* =========================================================================
 * Public row types
 * ========================================================================= */

export interface CheckoutOrder {
    readonly orderId: string;
    readonly tenantId: string;
    /** Opaque payer reference from the checkout flow; never a card/PAN. */
    readonly payerReference: string;
    /** Opaque business purpose code, e.g. `subscription_difference`. */
    readonly purpose: string;
    readonly amountMinor: bigint;
    readonly currency: string;
    readonly status: CheckoutOrderStatus;
    readonly createdAt: string;
    readonly expiresAt: string;
    readonly version: number;
    /** Set only on the transition to `paid`. */
    readonly confirmedAt: string | null;
    readonly confirmedProviderEventId: string | null;
    /**
     * Last applied provider event, used for deterministic out-of-order
     * handling. A duplicate replay is handled by provider event id first.
     */
    readonly lastEventAt: string | null;
    readonly lastProviderEventId: string | null;
}

export interface ProviderEvent {
    readonly provider: string;
    readonly providerEventId: string;
    readonly tenantId: string;
    /** The order identity this event names, within `tenantId`. */
    readonly orderRef: string;
    readonly amountMinor: bigint;
    readonly currency: string;
    readonly status: ProviderEventStatus;
    readonly occurredAt: string;
    readonly rawPayloadHash: string;
}

export interface ProviderEventRecord extends ProviderEvent {
    readonly outcome: ProviderEventOutcome;
    readonly reason: CheckoutEventReason | null;
    readonly recordedAt: string;
}

export type CheckoutEventReason =
    | 'unverified-signature'
    | 'invalid-event'
    | 'order-not-found'
    | 'amount-mismatch'
    | 'currency-mismatch'
    | 'stale-event'
    | 'late-failed-after-paid'
    | 'terminal-order'
    | 'expired-order'
    | 'status-conflict'
    | 'payload-conflict';

export interface PaymentConfirmedIntent {
    readonly tenantId: string;
    readonly orderId: string;
    readonly amountMinor: bigint;
    readonly currency: string;
    readonly purpose: string;
    readonly confirmedAt: string;
    readonly providerEventId: string;
}

/* =========================================================================
 * Store contract
 * ========================================================================= */

export interface CheckoutOrderPatch {
    readonly status: CheckoutOrderStatus;
    readonly confirmedAt: string | null;
    readonly confirmedProviderEventId: string | null;
    readonly lastEventAt: string | null;
    readonly lastProviderEventId: string | null;
}

export type UpdateOrderCasResult =
    | { readonly ok: true; readonly order: CheckoutOrder }
    | { readonly ok: false; readonly reason: 'not_found' | 'version_conflict' };

export type InsertProviderEventResult =
    | { readonly inserted: true; readonly record: ProviderEventRecord }
    | { readonly inserted: false; readonly duplicate: true; readonly record: ProviderEventRecord };

/**
 * One tenant-scoped checkout-order creation idempotency record (HK1).
 *
 * `payloadHash` is the canonical financial payload hash computed by
 * `computeCheckoutOrderPayloadHash`; the stored `orderId` is the canonical
 * byte-exact one and is returned on every identical retry.
 */
export interface CheckoutOrderIdempotencyRecord {
    readonly tenantId: string;
    readonly scope: string;
    readonly idempotencyKey: string;
    readonly payloadHash: string;
    readonly orderId: string;
    readonly createdAt: string;
}

export type InsertOrderIdempotencyResult =
    | { readonly inserted: true; readonly record: CheckoutOrderIdempotencyRecord }
    | {
        readonly inserted: false;
        readonly duplicate: true;
        readonly record: CheckoutOrderIdempotencyRecord;
    };

export const SETTLEMENT_OBLIGATION_STATUSES = [
    'pending',
    'awaiting_allocation',
    'completed',
    'allocated',
] as const;
export type SettlementObligationStatus = (typeof SETTLEMENT_OBLIGATION_STATUSES)[number];

export const SETTLEMENT_RECONCILIATION_STATUSES = [
    'unreconciled',
    'reconciled',
    'discrepancy',
] as const;
export type SettlementReconciliationStatus = (typeof SETTLEMENT_RECONCILIATION_STATUSES)[number];

/**
 * The immutable identity/financial fields of one settlement-obligation outbox
 * row. The domain mints `id`; the adapter stores `status = 'pending'`,
 * `fee_minor`/`tax_minor`/`net_minor` as NULL (unknown is never zero),
 * `reconciliation_status = 'unreconciled'` and `version = 0`.
 */
export interface SettlementObligationDraft {
    readonly id: string;
    readonly tenantId: string;
    readonly orderId: string;
    readonly purpose: string;
    readonly amountMinor: bigint;
    readonly currency: string;
    readonly provider: string;
    readonly providerEventId: string;
    readonly payloadHash: string;
}

export interface SettlementObligation extends SettlementObligationDraft {
    readonly status: SettlementObligationStatus;
    readonly feeMinor: bigint | null;
    readonly taxMinor: bigint | null;
    readonly netMinor: bigint | null;
    readonly reconciliationStatus: SettlementReconciliationStatus;
    readonly version: number;
    readonly createdAt: string;
}

export type RecordSettlementObligationResult =
    | { readonly inserted: true; readonly obligation: SettlementObligation }
    | {
        readonly inserted: false;
        readonly duplicate: true;
        readonly obligation: SettlementObligation;
    };

/**
 * Purposes that settle a platform subscription difference. Frozen to exactly
 * `subscription_difference` (same content as the settlement domain's
 * `PLATFORM_DIFFERENCE_PAYMENT_PURPOSES`); a platform order is bound
 * server-side to ONE immutable request/invoice/currency/amount at creation.
 */
export const CHECKOUT_PLATFORM_PURPOSES: ReadonlySet<string> = new Set<string>([
    'subscription_difference',
]);

/** Server resolution of a platform target (never caller text). */
export interface ResolvedPlatformTarget {
    readonly requestId: string;
    readonly invoiceId: string;
    readonly currency: string;
    readonly requestAmountMinor: bigint;
    readonly outstandingMinor: bigint;
    readonly requestStatus: 'open' | 'expired';
}

export type ResolvePlatformTargetResult =
    | { readonly ok: true; readonly target: ResolvedPlatformTarget }
    | {
        readonly ok: false;
        readonly reason:
            | 'request_not_found'
            | 'unresolved_reference'
            | 'request_not_payable'
            | 'debt_source_unavailable';
    };

/**
 * Immutable `checkout_order_platform_targets` row (structurally identical to
 * the settlement domain's `PlatformPaymentTarget`).
 */
export interface PlatformPaymentTarget {
    readonly tenantId: string;
    readonly orderId: string;
    readonly purpose: string;
    readonly requestId: string;
    readonly invoiceId: string;
    readonly currency: string;
    readonly amountMinor: bigint;
}

export interface CheckoutOrderPage {
    readonly orders: readonly CheckoutOrder[];
    readonly truncated: boolean;
}

/**
 * Transaction-bound persistence contract.
 *
 * SQL obligations behind this interface:
 *  - `orders` has UNIQUE (tenant_id, order_id) and every read/update carries a
 *    tenant predicate. `findOrderForUpdate` must lock the row
 *    (`SELECT ... FOR UPDATE`) so the version CAS is a real race guard.
 *  - `updateOrderCas` updates only when `version = expectedVersion` and writes
 *    `version = version + 1` in the same statement; a mismatch is a typed
 *    conflict and writes nothing.
 *  - `provider_events` is append-only, has UNIQUE (provider, provider_event_id),
 *    and its insert returns a duplicate flag with the existing row. There is no
 *    UPDATE/DELETE path for provider events.
 *  - Amount columns are BIGINT minor units and are read with BigInt(), never
 *    Number (HK2). `version` is a safe-integer column.
 *  - `currency` is CHAR(3) uppercase ISO-4217.
 *  - The sealed audit row for a mutation is written on the SAME
 *    connection/transaction as that mutation; an audit failure rolls the whole
 *    transaction back.
 *  - `listOrdersForReconciliation` is tenant-scoped and bounded, returning an
 *    explicit truncated flag instead of silently cutting rows.
 *  - This store never writes ledger journals or balances, and never creates a
 *    cash/offline receipt.
 */
export const CHECKOUT_STORE_SQL_CONTRACT: readonly string[] = Object.freeze([
    'orders: UNIQUE (tenant_id, order_id); every query carries a tenant predicate.',
    'orders: findOrderForUpdate uses SELECT ... FOR UPDATE; updateOrderCas is a single-statement version CAS and writes version = version + 1.',
    'provider_events: append-only; UNIQUE (provider, provider_event_id); duplicate inserts return the existing row and never re-apply a transition; every duplicate path compares rawPayloadHash and the event identity before any replay.',
    'order creation idempotency: checkout_order_idempotency_keys UNIQUE (tenant_id, scope, idempotency_key) plus payload_hash (HK1); a duplicate insert is re-read with FOR SHARE and returns the stored row, and the domain compares the canonical payload hash before any replay.',
    'settlement obligation outbox: financial_settlement_obligations UNIQUE (tenant_id, provider, provider_event_id) and UNIQUE (tenant_id, order_id, purpose); the row is inserted in the SAME transaction as the paid order CAS and the verified provider event, with unknown fee/tax/net stored NULL and a duplicate replayed only when the canonical payload identity matches.',
    'platform purposes: checkout_order_platform_targets (PK tenant_id, order_id) binds the order to ONE immutable request/invoice/currency/amount resolved server-side under invoice -> allocations -> request locks; the settlement obligation is bound to it through its (tenant_id, order_id) join, never through caller text.',
    'amount columns are BIGINT minor units, read with BigInt() and never Number; version is a safe integer.',
    'currency is CHAR(3) uppercase ISO-4217.',
    'the sealed audit row for each mutation is written on the SAME connection/transaction; an audit failure rolls back all changes.',
    'listOrdersForReconciliation is tenant-scoped, bounded and reports truncation explicitly.',
    'this domain writes no ledger journal and no balance, and creates no cash/offline receipt.',
]);

export interface CheckoutTransaction {
    insertOrder(order: CheckoutOrder): Promise<'inserted' | 'duplicate_key'>;
    findOrderForUpdate(tenantId: string, orderId: string): Promise<CheckoutOrder | null>;
    updateOrderCas(
        tenantId: string,
        orderId: string,
        expectedVersion: number,
        patch: CheckoutOrderPatch,
    ): Promise<UpdateOrderCasResult>;
    insertProviderEvent(record: ProviderEventRecord): Promise<InsertProviderEventResult>;
    /**
     * Read one provider event by its GLOBAL `(provider, providerEventId)` key.
     * When `expectedTenantId` is supplied the store must reject a row that
     * belongs to another tenant (typed `tenant_mismatch` in the SQL adapter)
     * instead of returning it for a cross-tenant replay.
     */
    findProviderEvent(
        provider: string,
        providerEventId: string,
        expectedTenantId?: string,
    ): Promise<ProviderEventRecord | null>;
    /**
     * HK1. Reads the creation idempotency record under
     * `(tenantId, scope, idempotencyKey)` from
     * `checkout_order_idempotency_keys`. A missing row returns null; a missing
     * table is a real schema failure, never a silent "no record".
     */
    findOrderIdempotency(
        tenantId: string,
        scope: string,
        idempotencyKey: string,
    ): Promise<CheckoutOrderIdempotencyRecord | null>;
    /**
     * HK1. Inserts the creation idempotency record after the order row (the
     * table has a tenant/order FK). A duplicate returns the stored row (re-read
     * is a locking current read) and never writes a second order; the domain
     * compares `payloadHash` before replaying.
     */
    insertOrderIdempotency(
        record: CheckoutOrderIdempotencyRecord,
    ): Promise<InsertOrderIdempotencyResult>;
    /**
     * R4 settlement-obligation outbox. Inserts one `pending` obligation in the
     * SAME transaction as the paid order CAS and the verified provider event.
     * A duplicate unique key returns the stored row so the domain can compare
     * the canonical payload identity before replaying.
     */
    recordSettlementObligation(
        draft: SettlementObligationDraft,
    ): Promise<RecordSettlementObligationResult>;
    listOrdersForReconciliation(
        tenantId: string,
        query?: { readonly limit?: number },
    ): Promise<CheckoutOrderPage>;
    /**
     * Platform purposes only (absent => `schema_unavailable`, fail closed).
     * Runs inside the creation transaction under the global lock order: the
     * invoice `FOR UPDATE` and its allocations (shared debt source through the
     * bound read-only settlement view), then the request row `FOR UPDATE`.
     */
    resolvePlatformTarget?(tenantId: string, requestId: string): Promise<ResolvePlatformTargetResult>;
    /** Inserts the immutable target row after the order row. */
    insertPlatformTarget?(target: PlatformPaymentTarget): Promise<'inserted' | 'duplicate_key'>;
    findPlatformTargetByOrder?(tenantId: string, orderId: string): Promise<PlatformPaymentTarget | null>;
    /** Orders of the request in state created|pending|paid. */
    countBlockingPlatformOrders?(tenantId: string, requestId: string): Promise<number>;
}

export interface CheckoutStore<Tx extends CheckoutTransaction = CheckoutTransaction> {
    runAtomic<T>(callback: (tx: Tx) => Promise<T>): Promise<T>;
}

/* =========================================================================
 * Audit contract
 * ========================================================================= */

export type CheckoutAuditAction =
    | 'payment.checkout.order_created'
    | 'payment.checkout.event_applied'
    | 'payment.checkout.event_ignored'
    | 'payment.checkout.event_rejected'
    | 'payment.checkout.event_quarantined';

export interface CheckoutAuditRecord {
    readonly action: CheckoutAuditAction;
    readonly tenantId: string | null;
    readonly orderId: string | null;
    readonly provider: string | null;
    readonly providerEventId: string | null;
    readonly outcome: ProviderEventOutcome | 'created' | 'unverified';
    readonly reason: CheckoutEventReason | null;
    readonly amountMinor: string | null;
    readonly currency: string | null;
}

export type CheckoutAuditWriter = (record: CheckoutAuditRecord) => Promise<void> | void;

/* =========================================================================
 * Signature verification contract
 * ========================================================================= */

export type CheckoutHeaders = Readonly<Record<string, string | string[] | undefined>>;

/**
 * Injected provider signature verifier. `rawBody` is the exact bytes/string the
 * provider signed; `headers` are the provider headers. Implementations should
 * use a constant-time compare. This module never sees a secret.
 */
export interface CheckoutSignatureVerifier {
    verify(rawBody: string, headers: CheckoutHeaders): boolean | Promise<boolean>;
}

/* =========================================================================
 * Order creation
 * ========================================================================= */

export interface CreateCheckoutOrderInput {
    readonly orderId?: string;
    readonly tenantId: string;
    readonly payerReference: string;
    readonly purpose: string;
    readonly amountMinor: unknown;
    readonly currency: string;
    readonly createdAt?: string;
    readonly expiresAt: string;
    /**
     * OPTIONAL HK1 creation key, scoped by tenant. When present, an identical
     * retry (same key + same canonical financial payload) returns the stored
     * order and writes nothing; the same key with a different payload throws a
     * typed `idempotency_conflict`.
     */
    readonly idempotencyKey?: string;
    /**
     * Platform purposes (`subscription_difference`) REQUIRE this and every
     * other purpose FORBIDS it. Only the request id is accepted: invoice,
     * currency and amount are resolved server-side, never from caller text.
     */
    readonly platformTarget?: { readonly requestId: string };
}

/**
 * Canonical, byte-exact financial payload hash for checkout-order creation.
 *
 * Only financial/identity fields are included; `orderId` (possibly generated),
 * `createdAt`, and transport metadata are excluded so a genuine retry of the
 * same request hashes identically. Each part is length-prefixed to remove
 * delimiter ambiguity. The result is lowercase sha256 hex.
 */
export function computeCheckoutOrderPayloadHash(fields: {
    readonly tenantId: string;
    readonly payerReference: string;
    readonly purpose: string;
    readonly amountMinor: bigint;
    readonly currency: string;
    readonly expiresAt: string;
    /** Appended ONLY when present, so hashes of legacy orders stay byte-identical. */
    readonly platformRequestId?: string | null;
}): string {
    const parts: string[] = [
        'payment.checkout.order_create.v1',
        fields.tenantId,
        fields.payerReference,
        fields.purpose,
        fields.amountMinor.toString(),
        fields.currency,
        fields.expiresAt,
    ];
    if (fields.platformRequestId !== undefined && fields.platformRequestId !== null) {
        parts.push(fields.platformRequestId);
    }
    const canonical = parts.map((part) => `${part.length}:${part}`).join('|');
    return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/**
 * Canonical, byte-exact financial payload hash for one settlement obligation.
 *
 * The provider's `rawPayloadHash` is bounded to 128 characters by the event
 * contract and is not required to be a 64-character lowercase SHA-256, while
 * `financial_settlement_obligations.payload_hash` is `CHAR(64)` with a
 * `^[0-9a-f]{64}$` CHECK. Hashing the verified raw payload identity together
 * with the canonical obligation identity produces the required 64-hex shape
 * without weakening R7: any difference in the event identity, order, purpose,
 * amount, currency or verified raw payload changes this hash.
 */
export function computeSettlementObligationPayloadHash(fields: {
    readonly tenantId: string;
    readonly orderId: string;
    readonly purpose: string;
    readonly amountMinor: bigint;
    readonly currency: string;
    readonly provider: string;
    readonly providerEventId: string;
    readonly rawPayloadHash: string;
}): string {
    const parts: readonly string[] = [
        'payment.settlement.obligation.v1',
        fields.tenantId,
        fields.orderId,
        fields.purpose,
        fields.amountMinor.toString(),
        fields.currency,
        fields.provider,
        fields.providerEventId,
        fields.rawPayloadHash,
    ];
    const canonical = parts.map((part) => `${part.length}:${part}`).join('|');
    return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

export interface CheckoutOrderOptions {
    readonly audit?: CheckoutAuditWriter;
    readonly now?: () => Date;
    readonly idFactory?: () => string;
}

export interface CreateCheckoutOrderResult {
    readonly order: CheckoutOrder;
    readonly replayed: boolean;
}

/**
 * Internal control-flow signal: this transaction lost the idempotency insert
 * race and must be rolled back before the winning record is replayed. It is
 * never returned to a caller and carries no provider/transport meaning.
 */
class CheckoutCreationRace extends Error {
    constructor() {
        super('checkout creation lost the idempotency insert race');
        this.name = 'CheckoutCreationRace';
    }
}

export async function createCheckoutOrder(
    store: CheckoutStore,
    input: CreateCheckoutOrderInput,
    options: CheckoutOrderOptions = {},
): Promise<CreateCheckoutOrderResult> {
    const tenantId = requireBoundedString(input.tenantId, 'tenantId', MAX_TENANT_LENGTH, 'invalid_tenant');
    const payerReference = requireBoundedString(
        input.payerReference,
        'payerReference',
        MAX_PAYER_REFERENCE_LENGTH,
        'invalid_payer_reference',
    );
    const purpose = requireCode(input.purpose, 'purpose', MAX_PURPOSE_LENGTH, 'invalid_purpose');
    const amountMinor = normalizeCheckoutAmountMinor(input.amountMinor);
    const currency = requireCurrency(input.currency);

    const now = (options.now ?? (() => new Date()))();
    if (Number.isNaN(now.getTime())) fail('invalid_timestamp', 'now returned an invalid date');
    const createdAt = input.createdAt === undefined
        ? now.toISOString()
        : requireTimestamp(input.createdAt, 'createdAt');
    const expiresAt = requireTimestamp(input.expiresAt, 'expiresAt');
    if (Date.parse(expiresAt) <= Date.parse(createdAt)) {
        fail('invalid_timestamp', 'expiresAt must be later than createdAt');
    }

    const isPlatformPurpose = CHECKOUT_PLATFORM_PURPOSES.has(purpose);
    let platformRequestId: string | null = null;
    if (input.platformTarget !== undefined) {
        if (!isPlatformPurpose) {
            fail('platform_target_forbidden', 'only a platform purpose may carry a platformTarget');
        }
        if (!isRecord(input.platformTarget)) {
            fail('invalid_input', 'platformTarget must be an object carrying a requestId');
        }
        platformRequestId = requireBoundedString(
            input.platformTarget.requestId,
            'platformTarget.requestId',
            MAX_TENANT_LENGTH,
            'invalid_input',
        );
    } else if (isPlatformPurpose) {
        fail('platform_target_required', `purpose ${purpose} requires a platformTarget`);
    }

    const idempotencyKey = input.idempotencyKey === undefined
        ? null
        : requireBoundedString(
            input.idempotencyKey,
            'idempotencyKey',
            MAX_IDEMPOTENCY_KEY_LENGTH,
            'invalid_idempotency_key',
        );
    const payloadHash = idempotencyKey === null
        ? null
        : computeCheckoutOrderPayloadHash({
            tenantId,
            payerReference,
            purpose,
            amountMinor,
            currency,
            expiresAt,
            platformRequestId,
        });

    const orderId = input.orderId === undefined
        ? requireCode(options.idFactory?.() ?? randomUUID(), 'orderId', MAX_ORDER_ID_LENGTH, 'invalid_order_id')
        : requireCode(input.orderId, 'orderId', MAX_ORDER_ID_LENGTH, 'invalid_order_id');

    const order: CheckoutOrder = Object.freeze({
        orderId,
        tenantId,
        payerReference,
        purpose,
        amountMinor,
        currency,
        status: 'created',
        createdAt,
        expiresAt,
        version: 0,
        confirmedAt: null,
        confirmedProviderEventId: null,
        lastEventAt: null,
        lastProviderEventId: null,
    });

    const createInTransaction = (): Promise<CreateCheckoutOrderResult> =>
        store.runAtomic(async (tx) => {
            if (idempotencyKey !== null && payloadHash !== null) {
                const existing = await tx.findOrderIdempotency(
                    tenantId,
                    CHECKOUT_ORDER_IDEMPOTENCY_SCOPE,
                    idempotencyKey,
                );
                if (existing !== null) {
                    return replayIdempotentOrder(
                        tx,
                        existing,
                        tenantId,
                        idempotencyKey,
                        payloadHash,
                        platformRequestId,
                    );
                }
            }

            /*
             * Platform purposes: resolve and bind the target BEFORE any write,
             * under the invoice -> allocations -> request locks (G1-G3). A
             * store without the capability fails closed.
             */
            let resolved: ResolvedPlatformTarget | null = null;
            if (platformRequestId !== null) {
                resolved = await resolvePlatformTargetForCreation(
                    tx,
                    tenantId,
                    platformRequestId,
                    currency,
                    amountMinor,
                );
            }

            /*
             * checkout_order_idempotency_keys has a tenant/order FK, so the
             * order row must exist before the idempotency insert. If two
             * requests race, the idempotency loser has inserted a speculative
             * order that the winner does not own; aborting this transaction is
             * what rolls that speculative order back. The caller then replays
             * the winner's committed record in a fresh transaction.
             */
            const inserted = await tx.insertOrder(order);
            if (inserted === 'duplicate_key') {
                fail('order_exists', `order ${orderId} already exists in tenant ${tenantId}`);
            }
            if (resolved !== null) {
                const targetInserted = await requirePlatformCapability(tx, 'insertPlatformTarget')({
                    tenantId,
                    orderId,
                    purpose,
                    requestId: resolved.requestId,
                    invoiceId: resolved.invoiceId,
                    currency: resolved.currency,
                    amountMinor: resolved.requestAmountMinor,
                });
                if (targetInserted === 'duplicate_key') {
                    fail('order_exists', `platform target for order ${orderId} already exists in tenant ${tenantId}`);
                }
            }
            if (idempotencyKey !== null && payloadHash !== null) {
                const idempotency = await tx.insertOrderIdempotency({
                    tenantId,
                    scope: CHECKOUT_ORDER_IDEMPOTENCY_SCOPE,
                    idempotencyKey,
                    payloadHash,
                    orderId,
                    createdAt,
                });
                if (!idempotency.inserted) throw new CheckoutCreationRace();
            }
            await writeAudit(options.audit, {
                action: 'payment.checkout.order_created',
                tenantId,
                orderId,
                provider: null,
                providerEventId: null,
                outcome: 'created',
                reason: null,
                amountMinor: serializeCheckoutAmountMinor(amountMinor),
                currency,
            });
            return { order, replayed: false };
        });

    if (idempotencyKey === null || payloadHash === null) return createInTransaction();
    /*
     * A lost insert race aborts its transaction (rolling back the speculative
     * order) and retries in a fresh transaction, where the winner's committed
     * record is either visible in the new snapshot or the insert blocks on the
     * winner's unique key and returns the stored row. The bound is defensive:
     * a store that cannot resolve the race fails closed instead of looping.
     */
    for (let attempt = 0; attempt < MAX_CREATE_IDEMPOTENCY_ATTEMPTS; attempt += 1) {
        try {
            return await createInTransaction();
        } catch (error) {
            if (!(error instanceof CheckoutCreationRace)) throw error;
        }
    }
    fail(
        'idempotency_conflict',
        'concurrent checkout creations could not be resolved against the idempotency record',
    );
}

/**
 * Resolve an existing creation-idempotency record. Identical payload returns
 * the stored order (the canonical order id) and writes nothing; a different
 * payload is a typed conflict and never reuses the stored order.
 */
async function replayIdempotentOrder(
    tx: CheckoutTransaction,
    record: CheckoutOrderIdempotencyRecord,
    tenantId: string,
    idempotencyKey: string,
    payloadHash: string,
    platformRequestId: string | null,
): Promise<CreateCheckoutOrderResult> {
    if (
        record.tenantId !== tenantId
        || record.scope !== CHECKOUT_ORDER_IDEMPOTENCY_SCOPE
        || record.idempotencyKey !== idempotencyKey
    ) {
        fail('idempotency_conflict', 'the idempotency record belongs to another tenant or scope');
    }
    if (record.payloadHash !== payloadHash) {
        fail('idempotency_conflict', 'the idempotency key was used with a different canonical payload');
    }
    const stored = await tx.findOrderForUpdate(record.tenantId, record.orderId);
    if (stored === null) {
        fail('order_not_found', `idempotent order ${record.orderId} is missing in tenant ${record.tenantId}`);
    }
    if (platformRequestId !== null) {
        /*
         * A platform replay re-reads the stored binding and requires the same
         * request; nothing is re-resolved or rewritten on a replay.
         */
        const target = await requirePlatformCapability(tx, 'findPlatformTargetByOrder')(
            record.tenantId,
            record.orderId,
        );
        if (
            target === null
            || target.tenantId !== tenantId
            || target.orderId !== stored.orderId
            || target.requestId !== platformRequestId
            || target.purpose !== stored.purpose
            || target.currency !== stored.currency
            || target.amountMinor !== stored.amountMinor
        ) {
            fail('idempotency_conflict', 'the stored platform target differs from the requested target');
        }
    }
    return { order: stored, replayed: true };
}

type PlatformCapabilityName =
    | 'resolvePlatformTarget'
    | 'insertPlatformTarget'
    | 'findPlatformTargetByOrder'
    | 'countBlockingPlatformOrders';

/** Returns the bound capability or fails closed with `schema_unavailable`. */
function requirePlatformCapability<K extends PlatformCapabilityName>(
    tx: CheckoutTransaction,
    name: K,
): NonNullable<CheckoutTransaction[K]> {
    const candidate = tx[name];
    if (typeof candidate !== 'function') {
        fail('schema_unavailable', `platform checkout capability ${name} is unavailable`);
    }
    return (candidate as (...args: unknown[]) => unknown).bind(tx) as NonNullable<CheckoutTransaction[K]>;
}

/**
 * Server-side target resolution for one platform order. Requires an EXACT
 * amount equal to the request amount: an overpayment (or underpayment) never
 * creates a checkout order. Nothing here trusts caller invoice/currency text.
 */
async function resolvePlatformTargetForCreation(
    tx: CheckoutTransaction,
    tenantId: string,
    requestId: string,
    currency: string,
    amountMinor: bigint,
): Promise<ResolvedPlatformTarget> {
    const outcome = await requirePlatformCapability(tx, 'resolvePlatformTarget')(tenantId, requestId);
    if (!outcome.ok) {
        switch (outcome.reason) {
            case 'unresolved_reference':
                return fail('unresolved_reference', 'the request has no linked invoice');
            case 'request_not_payable':
                return fail('request_not_payable', 'the request is not payable');
            case 'debt_source_unavailable':
                return fail('debt_source_unavailable', 'the invoice outstanding could not be proved');
            default:
                return fail('request_not_found', 'the difference request was not found');
        }
    }
    const target = outcome.target;
    if (target.requestId !== requestId) {
        fail('invalid_input', 'the resolved platform target is not the requested request');
    }
    if (target.requestStatus !== 'open' && target.requestStatus !== 'expired') {
        fail('request_not_payable', 'the request is not payable');
    }
    if (target.currency !== currency) {
        fail('invalid_currency', 'currency differs from the target request currency');
    }
    if (amountMinor > target.requestAmountMinor) {
        fail('amount_exceeds_request', 'amount exceeds the request amount');
    }
    if (amountMinor !== target.requestAmountMinor) {
        fail('amount_not_exact', 'amount must equal the request amount exactly');
    }
    if (amountMinor > target.outstandingMinor) {
        fail('amount_exceeds_outstanding', 'amount exceeds the invoice outstanding');
    }
    const blocking = await requirePlatformCapability(tx, 'countBlockingPlatformOrders')(tenantId, requestId);
    if (!Number.isSafeInteger(blocking) || blocking < 0) {
        fail('schema_unavailable', 'blocking platform order count is invalid');
    }
    if (blocking > 0) {
        fail('platform_order_exists', 'a blocking checkout order already exists for this request');
    }
    return target;
}

/* =========================================================================
 * Provider event application
 * ========================================================================= */

export interface ApplyProviderEventInput {
    readonly rawBody: string;
    readonly headers: CheckoutHeaders;
    readonly event: ProviderEventInput;
    /**
     * Opaque hash of the transport-level caller key (IP/account fingerprint).
     * Never a raw address/secret. Required only when `admit` is injected; a
     * missing/invalid value fails closed as `rate_limited`.
     */
    readonly callerKeyHash?: string;
}

/** Raw event fields. Validation happens after signature verification. */
export interface ProviderEventInput {
    readonly provider: string;
    readonly providerEventId: string;
    readonly tenantId: string;
    readonly orderRef: string;
    readonly amountMinor: unknown;
    readonly currency: string;
    readonly status: unknown;
    readonly occurredAt: string;
    readonly rawPayloadHash: string;
}

/**
 * Optional admission dependency at the service boundary. The Codex mount
 * integration may implement it with real (network) rate limiting. `rejected`
 * produces a typed `rate_limited` result, no audit row and no store access;
 * `absent` preserves the pre-existing behaviour (every caller admitted). A
 * thrown/rejected admission is propagated as a real failure, never disguised
 * as a rate limit.
 */
export type CheckoutAdmissionDecision = 'allowed' | 'rejected';
export type CheckoutAdmission = (
    callerKeyHash: string,
) => CheckoutAdmissionDecision | Promise<CheckoutAdmissionDecision>;

export interface CheckoutApplyDeps {
    readonly verifySignature: CheckoutSignatureVerifier;
    readonly audit?: CheckoutAuditWriter;
    readonly now?: () => Date;
    readonly admit?: CheckoutAdmission;
}

export interface CheckoutAppliedEventResult {
    readonly status: 'applied';
    readonly outcome: 'paid' | 'failed';
    readonly order: CheckoutOrder | null;
    readonly intent: PaymentConfirmedIntent | null;
    readonly replayed: boolean;
}

export interface CheckoutIgnoredEventResult {
    readonly status: 'ignored';
    readonly reason: CheckoutEventReason;
    readonly order: CheckoutOrder | null;
    readonly replayed: boolean;
}

export interface CheckoutRejectedEventResult {
    readonly status: 'rejected';
    readonly reason: CheckoutEventReason;
    readonly order: CheckoutOrder | null;
    readonly discrepancy: ReconciliationDiscrepancy;
    readonly replayed: boolean;
}

export interface CheckoutQuarantinedEventResult {
    readonly status: 'quarantined';
    readonly reason: CheckoutEventReason;
    readonly order: CheckoutOrder | null;
    readonly discrepancy: ReconciliationDiscrepancy;
    readonly replayed: boolean;
}

/**
 * Fail-closed result of the injected admission dependency. It is returned
 * before signature verification and before any audit/store write, so a rate
 * limited caller cannot create an audited callback row.
 */
export interface CheckoutRateLimitedEventResult {
    readonly status: 'rate_limited';
    readonly reason: 'rate_limited';
    readonly order: null;
    readonly replayed: false;
}

export type ApplyProviderEventResult =
    | CheckoutAppliedEventResult
    | CheckoutIgnoredEventResult
    | CheckoutRejectedEventResult
    | CheckoutQuarantinedEventResult
    | CheckoutRateLimitedEventResult;

function normalizeProviderEvent(raw: ProviderEventInput): ProviderEvent {
    if (!isRecord(raw)) fail('invalid_event', 'event must be an object');
    const provider = requireCode(raw.provider, 'provider', MAX_PROVIDER_LENGTH, 'invalid_event');
    const providerEventId = requireCode(
        raw.providerEventId,
        'providerEventId',
        MAX_PROVIDER_EVENT_ID_LENGTH,
        'invalid_event',
    );
    const tenantId = requireBoundedString(raw.tenantId, 'tenantId', MAX_TENANT_LENGTH, 'invalid_tenant');
    const orderRef = requireCode(raw.orderRef, 'orderRef', MAX_ORDER_ID_LENGTH, 'invalid_order_id');
    const amountMinor = normalizeCheckoutAmountMinor(raw.amountMinor);
    const currency = requireCurrency(raw.currency);
    const status = normalizeProviderEventStatus(raw.status);
    if (status === null) fail('invalid_status', 'event status must be paid or failed');
    const occurredAt = requireTimestamp(raw.occurredAt, 'occurredAt');
    const rawPayloadHash = requireBoundedString(
        raw.rawPayloadHash,
        'rawPayloadHash',
        MAX_PAYLOAD_HASH_LENGTH,
        'invalid_event',
    );
    return Object.freeze({
        provider,
        providerEventId,
        tenantId,
        orderRef,
        amountMinor,
        currency,
        status,
        occurredAt,
        rawPayloadHash,
    });
}

function compareEventToOrder(
    event: Pick<ProviderEvent, 'occurredAt' | 'providerEventId'>,
    order: Pick<CheckoutOrder, 'lastEventAt' | 'lastProviderEventId'>,
): number | null {
    if (order.lastEventAt === null) return null;
    const eventMs = Date.parse(event.occurredAt);
    const lastMs = Date.parse(order.lastEventAt);
    if (eventMs !== lastMs) return eventMs < lastMs ? -1 : 1;
    const lastId = order.lastProviderEventId ?? '';
    if (event.providerEventId === lastId) return 0;
    return event.providerEventId < lastId ? -1 : 1;
}

function eventIsAfter(
    event: Pick<ProviderEvent, 'occurredAt' | 'providerEventId'>,
    other: Pick<ProviderEvent, 'occurredAt' | 'providerEventId'>,
): boolean {
    return (compareEventToOrder(event, {
        lastEventAt: other.occurredAt,
        lastProviderEventId: other.providerEventId,
    }) ?? 0) > 0;
}

function makeDiscrepancy(
    kind: DiscrepancyKind,
    event: ProviderEvent,
    order: CheckoutOrder | null,
    detail: string,
): ReconciliationDiscrepancy {
    return Object.freeze({
        kind,
        tenantId: order === null ? event.tenantId : order.tenantId,
        orderId: order === null ? event.orderRef : order.orderId,
        provider: event.provider,
        providerEventId: event.providerEventId,
        detail,
    });
}

function makeIntent(order: CheckoutOrder, providerEventId: string): PaymentConfirmedIntent | null {
    if (order.status !== 'paid' || order.confirmedProviderEventId !== providerEventId) return null;
    return Object.freeze({
        tenantId: order.tenantId,
        orderId: order.orderId,
        amountMinor: order.amountMinor,
        currency: order.currency,
        purpose: order.purpose,
        confirmedAt: order.confirmedAt ?? '',
        providerEventId,
    });
}

interface EventPlan {
    readonly status: 'applied' | 'ignored' | 'rejected' | 'quarantined';
    readonly outcome: ProviderEventOutcome;
    readonly reason: CheckoutEventReason | null;
    readonly transition: 'paid' | 'failed' | null;
    readonly discrepancy: ReconciliationDiscrepancy | null;
}

function planEvent(event: ProviderEvent, order: CheckoutOrder | null, nowMs: number): EventPlan {
    if (order === null) {
        if (event.status === 'paid') {
            return {
                status: 'quarantined',
                outcome: 'quarantined',
                reason: 'order-not-found',
                transition: null,
                discrepancy: makeDiscrepancy(
                    'paid-without-order',
                    event,
                    null,
                    'a verified paid event names no order in its tenant',
                ),
            };
        }
        return {
            status: 'ignored',
            outcome: 'ignored',
            reason: 'order-not-found',
            transition: null,
            discrepancy: null,
        };
    }

    if (!Number.isSafeInteger(order.version) || order.version < 0) {
        fail('invalid_version', `order ${order.orderId} has a non-safe-integer version`);
    }

    if (event.amountMinor !== order.amountMinor) {
        return {
            status: 'rejected',
            outcome: 'rejected',
            reason: 'amount-mismatch',
            transition: null,
            discrepancy: makeDiscrepancy(
                'amount-mismatch',
                event,
                order,
                `event amount ${event.amountMinor.toString()} does not equal order amount ${order.amountMinor.toString()}`,
            ),
        };
    }
    if (event.currency !== order.currency) {
        return {
            status: 'rejected',
            outcome: 'rejected',
            reason: 'currency-mismatch',
            transition: null,
            discrepancy: makeDiscrepancy(
                'currency-mismatch',
                event,
                order,
                `event currency ${event.currency} does not equal order currency ${order.currency}`,
            ),
        };
    }

    const ordering = compareEventToOrder(event, order);
    if (ordering !== null && ordering <= 0) {
        return {
            status: 'ignored',
            outcome: 'ignored',
            reason: 'stale-event',
            transition: null,
            discrepancy: null,
        };
    }

    if (event.status === 'paid') {
        if (order.status === 'paid') {
            return {
                status: 'rejected',
                outcome: 'rejected',
                reason: 'status-conflict',
                transition: null,
                discrepancy: makeDiscrepancy(
                    'status-conflict',
                    event,
                    order,
                    'a second paid event names an order that is already paid by another event',
                ),
            };
        }
        const expired = order.status === 'expired' || nowMs >= Date.parse(order.expiresAt);
        if (expired) {
            return {
                status: 'quarantined',
                outcome: 'quarantined',
                reason: 'expired-order',
                transition: null,
                discrepancy: makeDiscrepancy(
                    'status-conflict',
                    event,
                    order,
                    'a paid event arrived for an expired order and was quarantined',
                ),
            };
        }
        if (order.status === 'cancelled' || order.status === 'failed') {
            return {
                status: 'quarantined',
                outcome: 'quarantined',
                reason: 'terminal-order',
                transition: null,
                discrepancy: makeDiscrepancy(
                    'status-conflict',
                    event,
                    order,
                    `a paid event arrived for a ${order.status} order and was quarantined`,
                ),
            };
        }
        return {
            status: 'applied',
            outcome: 'paid',
            reason: null,
            transition: 'paid',
            discrepancy: null,
        };
    }

    if (order.status === 'paid') {
        return {
            status: 'ignored',
            outcome: 'ignored',
            reason: 'late-failed-after-paid',
            transition: null,
            discrepancy: null,
        };
    }
    if (order.status !== 'created' && order.status !== 'pending') {
        return {
            status: 'ignored',
            outcome: 'ignored',
            reason: 'terminal-order',
            transition: null,
            discrepancy: null,
        };
    }
    return {
        status: 'applied',
        outcome: 'failed',
        reason: null,
        transition: 'failed',
        discrepancy: null,
    };
}

function discrepancyForRecord(
    record: ProviderEventRecord,
    order: CheckoutOrder | null,
): ReconciliationDiscrepancy {
    const kind: DiscrepancyKind =
        record.reason === 'amount-mismatch'
            ? 'amount-mismatch'
            : record.reason === 'currency-mismatch'
                ? 'currency-mismatch'
                : record.reason === 'payload-conflict'
                    ? 'duplicate-events'
                    : record.reason === 'order-not-found'
                        ? 'paid-without-order'
                        : 'status-conflict';
    return makeDiscrepancy(
        kind,
        record,
        order,
        `recorded ${record.outcome}${record.reason === null ? '' : `:${record.reason}`}`,
    );
}

function resultFromRecord(
    record: ProviderEventRecord,
    order: CheckoutOrder | null,
): ApplyProviderEventResult {
    if (record.outcome === 'paid' || record.outcome === 'failed') {
        return {
            status: 'applied',
            outcome: record.outcome,
            order,
            intent: record.outcome === 'paid' ? makeIntent(order ?? emptyOrder(record), record.providerEventId) : null,
            replayed: true,
        };
    }
    if (record.outcome === 'ignored') {
        return {
            status: 'ignored',
            reason: record.reason ?? 'invalid-event',
            order,
            replayed: true,
        };
    }
    if (record.outcome === 'rejected') {
        return {
            status: 'rejected',
            reason: record.reason ?? 'status-conflict',
            order,
            discrepancy: discrepancyForRecord(record, order),
            replayed: true,
        };
    }
    return {
        status: 'quarantined',
        reason: record.reason ?? 'status-conflict',
        order,
        discrepancy: discrepancyForRecord(record, order),
        replayed: true,
    };
}

function emptyOrder(record: ProviderEventRecord): CheckoutOrder {
    return {
        orderId: record.orderRef,
        tenantId: record.tenantId,
        payerReference: '',
        purpose: '',
        amountMinor: record.amountMinor,
        currency: record.currency,
        status: 'paid',
        createdAt: record.recordedAt,
        expiresAt: record.recordedAt,
        version: 0,
        confirmedAt: null,
        confirmedProviderEventId: null,
        lastEventAt: null,
        lastProviderEventId: null,
    };
}

async function writeAudit(
    audit: CheckoutAuditWriter | undefined,
    record: CheckoutAuditRecord,
): Promise<void> {
    if (audit !== undefined) await audit(record);
}

/**
 * Bound one untrusted callback hint for an unverified/invalid-event audit row.
 * The value is only kept when it is already a short opaque code; anything
 * long, empty, non-string or containing arbitrary payload characters is
 * dropped (redacted to null). No tenant claim, raw body, signature or secret
 * can enter the row.
 */
function auditHint(value: unknown, maxLength: number): string | null {
    if (typeof value !== 'string') return null;
    const text = value.trim();
    if (text.length === 0 || text.length > maxLength || text !== value || !CODE_PATTERN.test(text)) {
        return null;
    }
    return text;
}

function readRawEventField(event: unknown, field: string): unknown {
    return isRecord(event) ? event[field] : undefined;
}

function boundedCallerKeyHash(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const text = value.trim();
    if (text.length === 0 || text.length > MAX_CALLER_KEY_HASH_LENGTH || text !== value) return null;
    return text;
}

/**
 * Compare a stored provider event with the incoming event before any replay.
 * `rawPayloadHash` and the event identity (tenant + order reference) must both
 * match; otherwise the duplicate is a typed payload conflict, never a silent
 * replay. The SQL adapter always hands back the stored row for this check.
 */
function duplicateEventConflictDetail(
    stored: ProviderEventRecord,
    incoming: ProviderEvent,
): string | null {
    if (stored.rawPayloadHash !== incoming.rawPayloadHash) {
        return 'the same provider event id was seen with a different raw payload hash';
    }
    if (stored.tenantId !== incoming.tenantId) {
        return 'the same provider event id was seen with a different tenant identity';
    }
    if (stored.orderRef !== incoming.orderRef) {
        return 'the same provider event id was seen with a different order reference';
    }
    return null;
}

async function rejectDuplicateEvent(
    audit: CheckoutAuditWriter | undefined,
    stored: ProviderEventRecord,
    incoming: ProviderEvent,
    order: CheckoutOrder | null,
): Promise<CheckoutRejectedEventResult> {
    const detail = duplicateEventConflictDetail(stored, incoming)
        ?? 'the same provider event id was seen with a conflicting identity';
    const discrepancy = makeDiscrepancy('duplicate-events', incoming, order, detail);
    await writeAudit(audit, {
        action: 'payment.checkout.event_rejected',
        tenantId: incoming.tenantId,
        orderId: incoming.orderRef,
        provider: incoming.provider,
        providerEventId: incoming.providerEventId,
        outcome: 'rejected',
        reason: 'payload-conflict',
        amountMinor: serializeCheckoutAmountMinor(incoming.amountMinor),
        currency: incoming.currency,
    });
    return {
        status: 'rejected',
        reason: 'payload-conflict',
        order,
        discrepancy,
        replayed: false,
    };
}

/**
 * Write the R4 settlement-obligation outbox row for one just-paid order.
 *
 * The row identity/financial fields come from the canonical stored order and
 * the verified provider event; the event was already checked against the
 * order before the paid transition, and the equality is re-asserted here so a
 * mismatch can never create an obligation. `payload_hash` is the canonical
 * settlement payload identity (see `computeSettlementObligationPayloadHash`).
 * A duplicate is replayed only when that identity matches; otherwise it is a
 * typed `payload_conflict` and the transaction rolls back.
 */
async function recordPaidSettlementObligation(
    tx: CheckoutTransaction,
    order: CheckoutOrder,
    event: ProviderEvent,
): Promise<void> {
    if (
        event.tenantId !== order.tenantId
        || event.amountMinor !== order.amountMinor
        || event.currency !== order.currency
    ) {
        fail('invalid_event', 'the verified provider event no longer matches the paid order');
    }
    const payloadHash = computeSettlementObligationPayloadHash({
        tenantId: order.tenantId,
        orderId: order.orderId,
        purpose: order.purpose,
        amountMinor: event.amountMinor,
        currency: event.currency,
        provider: event.provider,
        providerEventId: event.providerEventId,
        rawPayloadHash: event.rawPayloadHash,
    });
    const draft: SettlementObligationDraft = Object.freeze({
        id: randomUUID(),
        tenantId: order.tenantId,
        orderId: order.orderId,
        purpose: order.purpose,
        amountMinor: event.amountMinor,
        currency: event.currency,
        provider: event.provider,
        providerEventId: event.providerEventId,
        payloadHash,
    });
    if (typeof (tx as Partial<CheckoutTransaction>).recordSettlementObligation !== 'function') {
        fail('schema_unavailable', 'settlement obligation outbox unavailable');
    }
    const stored = await tx.recordSettlementObligation(draft);
    if (
        !stored.inserted
        && (
            stored.obligation.payloadHash !== payloadHash
            || stored.obligation.tenantId !== draft.tenantId
            || stored.obligation.orderId !== draft.orderId
            || stored.obligation.purpose !== draft.purpose
            || stored.obligation.provider !== draft.provider
            || stored.obligation.providerEventId !== draft.providerEventId
        )
    ) {
        fail('payload_conflict', 'a settlement obligation with a different payload identity already exists');
    }
}

/**
 * Apply one already-delivered provider event.
 *
 * Order of operations is part of the contract:
 *  1. the optional injected admission runs first; `rejected` (or an absent
 *     caller key hash) returns a typed `rate_limited` result with NO audit and
 *     NO store access; then the injected verifier runs on the raw body BEFORE
 *     any state change; an unverified or throwing verifier produces an ignored
 *     result and one bounded/redacted audit record, with zero store transactions;
 *  2. inside one transaction, dedupe by (provider, providerEventId) happens
 *     before any order mutation; EVERY duplicate path (including an insert-race
 *     loser) compares rawPayloadHash and the event identity: a mismatch is a
 *     typed payload conflict, otherwise the replay returns the recorded outcome;
 *  3. amount, currency and order identity are checked against the stored order;
 *  4. terminal orders are never mutated; paid-for-expired/cancelled is
 *     quarantined for reconciliation;
 *  5. the provider event is inserted, then the order is CAS-updated; if the CAS
 *     loses a race the whole transaction (including the event insert) rolls
 *     back and a typed `version_conflict` is thrown;
 *  6. a `paid` transition also writes the settlement-obligation outbox row on
 *     the same transaction, before the single sealed audit; an obligation
 *     failure rolls the event, the paid CAS and the obligation back together.
 */
export async function applyProviderEvent(
    store: CheckoutStore,
    input: ApplyProviderEventInput,
    deps: CheckoutApplyDeps,
): Promise<ApplyProviderEventResult> {
    if (deps.admit !== undefined) {
        const callerKeyHash = boundedCallerKeyHash(input.callerKeyHash);
        if (callerKeyHash === null) {
            return { status: 'rate_limited', reason: 'rate_limited', order: null, replayed: false };
        }
        const decision = await deps.admit(callerKeyHash);
        if (decision !== 'allowed') {
            return { status: 'rate_limited', reason: 'rate_limited', order: null, replayed: false };
        }
    }

    let verified = false;
    try {
        verified = Boolean(await deps.verifySignature.verify(input.rawBody, input.headers));
    } catch {
        verified = false;
    }
    if (!verified) {
        await writeAudit(deps.audit, {
            action: 'payment.checkout.event_ignored',
            tenantId: null,
            orderId: null,
            provider: auditHint(readRawEventField(input.event, 'provider'), MAX_PROVIDER_LENGTH),
            providerEventId: auditHint(
                readRawEventField(input.event, 'providerEventId'),
                MAX_PROVIDER_EVENT_ID_LENGTH,
            ),
            outcome: 'unverified',
            reason: 'unverified-signature',
            amountMinor: null,
            currency: null,
        });
        return { status: 'ignored', reason: 'unverified-signature', order: null, replayed: false };
    }

    let event: ProviderEvent;
    try {
        event = normalizeProviderEvent(input.event);
    } catch (error) {
        if (!(error instanceof CheckoutError)) throw error;
        await writeAudit(deps.audit, {
            action: 'payment.checkout.event_ignored',
            tenantId: null,
            orderId: null,
            provider: auditHint(readRawEventField(input.event, 'provider'), MAX_PROVIDER_LENGTH),
            providerEventId: auditHint(
                readRawEventField(input.event, 'providerEventId'),
                MAX_PROVIDER_EVENT_ID_LENGTH,
            ),
            outcome: 'unverified',
            reason: 'invalid-event',
            amountMinor: null,
            currency: null,
        });
        return { status: 'ignored', reason: 'invalid-event', order: null, replayed: false };
    }

    const now = (deps.now ?? (() => new Date()))();
    if (Number.isNaN(now.getTime())) fail('invalid_timestamp', 'now returned an invalid date');
    const nowMs = now.getTime();
    const recordedAt = now.toISOString();

    return store.runAtomic(async (tx) => {
        const existing = await tx.findProviderEvent(
            event.provider,
            event.providerEventId,
            event.tenantId,
        );
        if (existing !== null) {
            const currentOrder = await tx.findOrderForUpdate(event.tenantId, event.orderRef);
            if (duplicateEventConflictDetail(existing, event) !== null) {
                return rejectDuplicateEvent(deps.audit, existing, event, currentOrder);
            }
            return resultFromRecord(existing, currentOrder);
        }

        const order = await tx.findOrderForUpdate(event.tenantId, event.orderRef);
        const plan = planEvent(event, order, nowMs);

        if (plan.transition === null || order === null) {
            const record: ProviderEventRecord = Object.freeze({
                ...event,
                outcome: plan.outcome,
                reason: plan.reason,
                recordedAt,
            });
            const inserted = await tx.insertProviderEvent(record);
            if (!inserted.inserted) {
                const currentOrder = await tx.findOrderForUpdate(event.tenantId, event.orderRef);
                if (duplicateEventConflictDetail(inserted.record, event) !== null) {
                    return rejectDuplicateEvent(deps.audit, inserted.record, event, currentOrder);
                }
                return resultFromRecord(inserted.record, currentOrder);
            }
            await writeAudit(deps.audit, {
                action: plan.status === 'ignored'
                    ? 'payment.checkout.event_ignored'
                    : plan.status === 'rejected'
                        ? 'payment.checkout.event_rejected'
                        : 'payment.checkout.event_quarantined',
                tenantId: event.tenantId,
                orderId: event.orderRef,
                provider: event.provider,
                providerEventId: event.providerEventId,
                outcome: plan.outcome,
                reason: plan.reason,
                amountMinor: serializeCheckoutAmountMinor(event.amountMinor),
                currency: event.currency,
            });
            if (plan.status === 'ignored') {
                return {
                    status: 'ignored',
                    reason: plan.reason ?? 'invalid-event',
                    order,
                    replayed: false,
                };
            }
            if (plan.status === 'rejected') {
                return {
                    status: 'rejected',
                    reason: plan.reason ?? 'status-conflict',
                    order,
                    discrepancy: plan.discrepancy ?? makeDiscrepancy(
                        'status-conflict',
                        event,
                        order,
                        'rejected provider event',
                    ),
                    replayed: false,
                };
            }
            return {
                status: 'quarantined',
                reason: plan.reason ?? 'status-conflict',
                order,
                discrepancy: plan.discrepancy ?? makeDiscrepancy(
                    'status-conflict',
                    event,
                    order,
                    'quarantined provider event',
                ),
                replayed: false,
            };
        }

        /*
         * The canonical stored order id, not the caller's `event.orderRef`, is
         * persisted on the applied provider event. The adapter's binary-exact
         * order-id comparison has already proved that the caller's reference
         * is byte-identical to this row, so this only pins the canonical bytes.
         */
        const record: ProviderEventRecord = Object.freeze({
            ...event,
            orderRef: order.orderId,
            outcome: plan.outcome,
            reason: plan.reason,
            recordedAt,
        });
        const inserted = await tx.insertProviderEvent(record);
        if (!inserted.inserted) {
            const currentOrder = await tx.findOrderForUpdate(event.tenantId, order.orderId);
            if (duplicateEventConflictDetail(inserted.record, event) !== null) {
                return rejectDuplicateEvent(deps.audit, inserted.record, event, currentOrder);
            }
            return resultFromRecord(inserted.record, currentOrder);
        }

        const updated = await tx.updateOrderCas(event.tenantId, order.orderId, order.version, {
            status: plan.transition,
            confirmedAt: plan.transition === 'paid' ? event.occurredAt : null,
            confirmedProviderEventId: plan.transition === 'paid' ? event.providerEventId : null,
            lastEventAt: event.occurredAt,
            lastProviderEventId: event.providerEventId,
        });
        if (!updated.ok) {
            if (updated.reason === 'version_conflict') {
                fail('version_conflict', 'order changed concurrently during checkout application');
            }
            fail('order_not_found', 'order disappeared during checkout application');
        }

        /*
         * R4 outbox: the obligation row is written on THIS transaction, after
         * the verified provider-event insert and the order-paid CAS, and before
         * the single sealed audit/commit. A failure here rolls the paid
         * transition back with the event and the obligation.
         */
        if (plan.transition === 'paid') {
            await recordPaidSettlementObligation(tx, updated.order, event);
        }

        await writeAudit(deps.audit, {
            action: 'payment.checkout.event_applied',
            tenantId: event.tenantId,
            orderId: updated.order.orderId,
            provider: event.provider,
            providerEventId: event.providerEventId,
            outcome: plan.outcome,
            reason: null,
            amountMinor: serializeCheckoutAmountMinor(event.amountMinor),
            currency: event.currency,
        });

        return {
            status: 'applied',
            outcome: plan.transition,
            order: updated.order,
            intent: plan.transition === 'paid' ? makeIntent(updated.order, event.providerEventId) : null,
            replayed: false,
        };
    });
}

/* =========================================================================
 * Reconciliation (pure, bounded, never mutating)
 * ========================================================================= */

export interface ReconciliationDiscrepancy {
    readonly kind: DiscrepancyKind;
    readonly tenantId: string | null;
    readonly orderId: string | null;
    readonly provider: string | null;
    readonly providerEventId: string | null;
    readonly detail: string;
}

export interface ReconcileCheckoutOptions {
    readonly now?: string | Date;
    readonly limit?: number;
    /**
     * Caller-provided signal that the supplied page is already a truncated
     * slice of a larger set. It is propagated as `incomplete` even when the
     * arrays themselves are shorter than `limit`.
     */
    readonly inputTruncated?: boolean;
}

export interface ReconciliationReport {
    readonly discrepancies: readonly ReconciliationDiscrepancy[];
    readonly inspectedOrders: number;
    readonly inspectedEvents: number;
    readonly truncated: boolean;
    readonly incomplete: boolean;
}

function normalizeLimit(value: unknown): number {
    if (value === undefined) return DEFAULT_LIST_LIMIT;
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > MAX_LIST_LIMIT) {
        fail('invalid_input', `limit must be an integer between 1 and ${MAX_LIST_LIMIT}`);
    }
    return value;
}

function orderIndexKey(tenantId: string, orderId: string): string {
    return `${tenantId}\u0000${orderId}`;
}

function providerEventKey(provider: string, providerEventId: string): string {
    return `${provider}\u0000${providerEventId}`;
}

function compareDiscrepancies(
    left: ReconciliationDiscrepancy,
    right: ReconciliationDiscrepancy,
): number {
    const fields: readonly (keyof ReconciliationDiscrepancy)[] = [
        'kind',
        'tenantId',
        'orderId',
        'provider',
        'providerEventId',
        'detail',
    ];
    for (const field of fields) {
        const a = left[field] ?? '';
        const b = right[field] ?? '';
        if (a !== b) return a < b ? -1 : 1;
    }
    return 0;
}

/**
 * Compare orders with provider events without touching either input.
 *
 * Reported kinds: paid-without-order, order-without-event-past-expiry,
 * amount-mismatch, currency-mismatch, duplicate-events and status-conflict.
 * The result is sorted for determinism. When either input exceeds `limit`, or
 * the caller marks the input truncated, the report is `incomplete`.
 */
export function reconcileCheckout(
    orders: readonly CheckoutOrder[],
    providerEvents: readonly ProviderEvent[],
    options: ReconcileCheckoutOptions = {},
): ReconciliationReport {
    const limit = normalizeLimit(options.limit);
    const nowMs = options.now === undefined
        ? Date.now()
        : typeof options.now === 'string'
            ? Date.parse(options.now)
            : options.now.getTime();
    if (Number.isNaN(nowMs)) fail('invalid_timestamp', 'now must be a valid date');

    const ordersTruncated = orders.length > limit;
    const eventsTruncated = providerEvents.length > limit;
    const inspectedOrders = orders.slice(0, limit);
    const inspectedEvents = providerEvents.slice(0, limit);

    const orderByKey = new Map<string, CheckoutOrder>();
    for (const order of inspectedOrders) {
        orderByKey.set(orderIndexKey(order.tenantId, order.orderId), order);
    }

    const discrepancies: ReconciliationDiscrepancy[] = [];
    const eventsByOrder = new Map<string, ProviderEvent[]>();
    const seenEventKeys = new Set<string>();
    const reportedDuplicateKeys = new Set<string>();

    for (const event of inspectedEvents) {
        const eventKey = providerEventKey(event.provider, event.providerEventId);
        if (seenEventKeys.has(eventKey)) {
            if (!reportedDuplicateKeys.has(eventKey)) {
                reportedDuplicateKeys.add(eventKey);
                discrepancies.push(Object.freeze({
                    kind: 'duplicate-events',
                    tenantId: event.tenantId,
                    orderId: event.orderRef,
                    provider: event.provider,
                    providerEventId: event.providerEventId,
                    detail: 'the same provider event id appears more than once',
                }));
            }
            continue;
        }
        seenEventKeys.add(eventKey);

        const orderKey = orderIndexKey(event.tenantId, event.orderRef);
        const order = orderByKey.get(orderKey);
        if (order === undefined) {
            if (event.status === 'paid') {
                discrepancies.push(Object.freeze({
                    kind: 'paid-without-order',
                    tenantId: event.tenantId,
                    orderId: event.orderRef,
                    provider: event.provider,
                    providerEventId: event.providerEventId,
                    detail: 'a paid provider event has no matching order in its tenant',
                }));
            }
            continue;
        }

        const list = eventsByOrder.get(orderKey);
        if (list === undefined) eventsByOrder.set(orderKey, [event]);
        else list.push(event);

        if (event.amountMinor !== order.amountMinor) {
            discrepancies.push(Object.freeze({
                kind: 'amount-mismatch',
                tenantId: order.tenantId,
                orderId: order.orderId,
                provider: event.provider,
                providerEventId: event.providerEventId,
                detail: `event amount ${event.amountMinor.toString()} does not equal order amount ${order.amountMinor.toString()}`,
            }));
        }
        if (event.currency !== order.currency) {
            discrepancies.push(Object.freeze({
                kind: 'currency-mismatch',
                tenantId: order.tenantId,
                orderId: order.orderId,
                provider: event.provider,
                providerEventId: event.providerEventId,
                detail: `event currency ${event.currency} does not equal order currency ${order.currency}`,
            }));
        }
    }

    for (const order of inspectedOrders) {
        const orderKey = orderIndexKey(order.tenantId, order.orderId);
        const events = eventsByOrder.get(orderKey) ?? [];
        const paidEvents = events.filter((event) => event.status === 'paid');
        const failedEvents = events.filter((event) => event.status === 'failed');

        if (order.status === 'paid') {
            if (paidEvents.length === 0) {
                discrepancies.push(Object.freeze({
                    kind: 'status-conflict',
                    tenantId: order.tenantId,
                    orderId: order.orderId,
                    provider: null,
                    providerEventId: null,
                    detail: 'order is paid but no paid provider event was recorded',
                }));
            } else {
                const latestPaid = paidEvents.reduce((latest, event) => (
                    eventIsAfter(event, latest) ? event : latest
                ));
                const laterFailed = failedEvents.some((event) => eventIsAfter(event, latestPaid));
                if (laterFailed) {
                    discrepancies.push(Object.freeze({
                        kind: 'status-conflict',
                        tenantId: order.tenantId,
                        orderId: order.orderId,
                        provider: null,
                        providerEventId: null,
                        detail: 'a failed provider event occurred after the paid event',
                    }));
                }
            }
            continue;
        }

        if (order.status === 'failed' || order.status === 'expired' || order.status === 'cancelled') {
            if (paidEvents.length > 0) {
                discrepancies.push(Object.freeze({
                    kind: 'status-conflict',
                    tenantId: order.tenantId,
                    orderId: order.orderId,
                    provider: null,
                    providerEventId: null,
                    detail: `order is ${order.status} but a paid provider event exists`,
                }));
            }
            continue;
        }

        if (events.length === 0 && nowMs >= Date.parse(order.expiresAt)) {
            discrepancies.push(Object.freeze({
                kind: 'order-without-event-past-expiry',
                tenantId: order.tenantId,
                orderId: order.orderId,
                provider: null,
                providerEventId: null,
                detail: 'a non-terminal order passed its expiry with no provider event',
            }));
        }
        if (paidEvents.length > 0) {
            discrepancies.push(Object.freeze({
                kind: 'status-conflict',
                tenantId: order.tenantId,
                orderId: order.orderId,
                provider: null,
                providerEventId: null,
                detail: `order is ${order.status} but a paid provider event was recorded`,
            }));
        }
    }

    discrepancies.sort(compareDiscrepancies);
    return Object.freeze({
        discrepancies: Object.freeze(discrepancies),
        inspectedOrders: inspectedOrders.length,
        inspectedEvents: inspectedEvents.length,
        truncated: ordersTruncated || eventsTruncated,
        incomplete: ordersTruncated || eventsTruncated || options.inputTruncated === true,
    });
}
