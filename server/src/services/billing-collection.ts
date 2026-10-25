/**
 * PATH-B3 / FIN5 (X4) — subscription difference requests, collection priority
 * and unpaid protection. docs/19 lines 54, 74-76, 87, 90, 103, 111.
 *
 * This is a PURE DOMAIN module: it performs no I/O, no SQL, no route work, no
 * provider call and no migration. Persistence is the injected `CollectionStore`
 * whose `runAtomic` callback is the only transaction seam. The in-memory store
 * in `server/tests/billing-collection.test.ts` is a test double, NOT SQL
 * evidence.
 *
 * Settled rules implemented here (docs/19):
 *
 *  - a difference request is anchored at its ISSUE instant: `deadlineAt` is
 *    `issuedAt + 345_600` seconds (96 hours), computed once and stored;
 *  - a re-request for the same (tenant, organization, invoice/cycle,
 *    difference basis) returns the existing request and NEVER moves the
 *    deadline, even if the retry happens much later;
 *  - issuance is idempotent by (tenant, request key) with a payload hash; the
 *    same key with a different payload is a typed conflict (HK1 pattern);
 *  - subscription debt has priority over a NEW withdrawal reservation; pending
 *    funds and EXISTING reservations are never used or cancelled here;
 *  - after the grace, unpaid tenants stop accepting new students, student
 *    renewals and new content publishing, while every already-paid student
 *    period (including a future period) and every existing withdrawal
 *    reservation remains protected; debt payment, export and support stay
 *    available and nothing is deleted;
 *  - money is exact `bigint` minor units, amounts are serialized as decimal
 *    strings and versions are safe integers (HK2). There is no floating point
 *    and no `Number` amount conversion.
 *
 * INVOICE-LINKED DIFFERENCE REQUESTS (Codex decisions, not re-decided):
 *
 *  - a caller that supplies `invoiceRefId` declares a REAL
 *    `billing_invoices.id`; the server proves it in the SAME transaction with
 *    a locking read through the shared allocation source
 *    (`computeInvoiceOutstanding`, billing-settlement.ts) before the insert.
 *    The stored `invoiceRefId` is the proven id, never the caller's string; a
 *    missing/mismatching invoice or a currency mismatch fails with nothing
 *    written;
 *  - a difference request is a payment request for the invoice's REMAINING
 *    allocated balance: its amount can never exceed the outstanding returned
 *    by that shared source. An unknown/incomplete source fails closed with
 *    `debt_source_unavailable`, never with an invented zero;
 *  - a legacy opaque `invoiceId` (VARCHAR(128)) with no `invoiceRefId` keeps a
 *    SQL NULL shadow link (`invoice_ref_id`), exactly as the schema defines
 *    ("NULL = opaque legacy invoice_id only"). The writer never copies a free
 *    string into the FK column and never guesses which invoice it might be;
 *  - LOCK ORDER (global, shared with billing-payouts-sql.ts and
 *    billing-collection-sql.ts): invoices (FOR UPDATE) -> allocations ->
 *    difference requests. Issuance proves the invoice first, then reads/inserts
 *    difference requests; it never locks a difference request before an invoice;
 *  - several open requests on one invoice never sum above its outstanding: a
 *    new request is capped at outstanding minus the OTHER open (non-expired)
 *    requests of that invoice, under the invoice lock;
 *  - a request is marked paid only with settlement-obligation proof (see
 *    applyVerifiedPayment); a free payment id is never proof (Codex R4);
 *  - closing a difference request on a verified gateway payment does NOT write
 *    a `billing_payment_allocations` row here. The settlement adapter owns that
 *    allocation and its unique key
 *    `uq_billing_allocation_payment_invoice (tenant_id, payment_reference,
 *    invoice_id, kind)` is the single guard against a second deduction for the
 *    same payment/invoice; this module must not duplicate allocation logic.
 *
 * Deliberately HELD (not guessed):
 *
 *  - partial settlement of a difference request (docs/19 only says a verified
 *    gateway payment closes the debt; see line 74/76);
 *  - allocation of an overpayment / surplus (docs/19 line 90 leaves fees,
 *    tax and settlement details unsettled);
 *  - whether an explicitly authorized correction may EXTEND the 96-hour grace
 *    or replace an expired request at all. `reopenExpiredRequest` FAILS CLOSED
 *    with a typed `policy_held` error before any write until an atomic
 *    collectible-obligation/supersession contract exists;
 *  - any consequence of unpaid beyond the three settled restrictions above.
 */

import { createHash, randomUUID } from 'node:crypto';
import {
    BILLING_ORGANIZATIONS,
    type BillingOrganization,
} from './billing-pricing';
import { NINETY_SIX_HOURS_SECONDS } from './billing-periods';
import { RESERVATION_STATUSES, type ReservationRecord } from './billing-reservations';
import {
    asSettlementObligationId,
    PLATFORM_DIFFERENCE_PAYMENT_PURPOSES,
    type SettlementObligationId,
} from './billing-settlement';

export const COLLECTION_MODEL_VERSION = 1;
export const DIFFERENCE_GRACE_SECONDS = NINETY_SIX_HOURS_SECONDS;

export const DIFFERENCE_REQUEST_STATUSES = ['open', 'paid', 'expired', 'cancelled'] as const;
export type DifferenceRequestStatus = (typeof DIFFERENCE_REQUEST_STATUSES)[number];

export const PERIOD_PROTECTION_STATUSES = ['paid', 'confirmed', 'pending', 'expired', 'cancelled'] as const;
export type PeriodProtectionStatus = (typeof PERIOD_PROTECTION_STATUSES)[number];

export const DEBT_STATUSES = ['due', 'paid', 'cancelled'] as const;
export type DebtStatus = (typeof DEBT_STATUSES)[number];

export const MAX_TENANT_LENGTH = 36;
export const MAX_ID_LENGTH = 128;
/** `billing_difference_requests.request_id`/`correction_of_request_id` are CHAR(36). */
export const MAX_REQUEST_ID_LENGTH = 36;
/** `billing_difference_requests.invoice_ref_id` / `billing_invoices.id` are CHAR(36). */
export const MAX_INVOICE_REF_LENGTH = 36;
/** Legacy opaque `billing_difference_requests.invoice_id` is VARCHAR(128). */
export const MAX_INVOICE_ID_LENGTH = 128;
export const MAX_REQUEST_KEY_LENGTH = 128;
export const MAX_PAYMENT_ID_LENGTH = 128;
export const MAX_DIFFERENCE_BASIS_LENGTH = 64;
export const MAX_REASON_LENGTH = 500;
export const MAX_ACTOR_ID_LENGTH = 128;
export const DEFAULT_LIST_LIMIT = 200;
export const MAX_LIST_LIMIT = 1_000;

/** Same bound as the FIN3 ledger; one difference request cannot exceed it. */
export const MAX_AMOUNT_MINOR = 1_000_000_000_000_000n;
export const MAX_SAFE_SECONDS = Number.MAX_SAFE_INTEGER;

const CURRENCY_PATTERN = /^[A-Z]{3}$/;
const HEX_64_PATTERN = /^[0-9a-f]{64}$/;

export type CollectionErrorCode =
    | 'validation'
    | 'invalid_amount'
    | 'amount_out_of_range'
    | 'invalid_currency'
    | 'invalid_tenant'
    | 'invalid_idempotency_key'
    | 'idempotency_conflict'
    | 'tenant_mismatch'
    | 'currency_mismatch'
    | 'invoice_not_found'
    | 'debt_source_unavailable'
    | 'amount_exceeds_outstanding'
    | 'request_not_found'
    | 'payment_conflict'
    | 'already_paid'
    | 'invalid_transition'
    | 'not_expired'
    | 'version_conflict'
    | 'partial_payment_held'
    | 'overpayment_held'
    | 'policy_held'
    | 'payment_proof_unavailable'
    /** Request has no proven invoice link (invoice_ref_id NULL) or the order has no platform target. */
    | 'unresolved_reference'
    /** Verified money exists but cannot close the request automatically (overpayment, fee/tax, legacy, over-funded, discrepancy). */
    | 'reconciliation_required'
    /** The CURRENT non-reversed allocation proof is not exactly the required value. */
    | 'stale_allocation_proof'
    /** Locked obligation purpose is outside the platform allowlist. */
    | 'purpose_not_allowed'
    /** Durable order target does not match the request / invoice / currency / amount. */
    | 'target_mismatch'
    | 'store_inconsistent';

export class CollectionError extends Error {
    constructor(
        public readonly code: CollectionErrorCode,
        message: string,
    ) {
        super(message);
        this.name = 'CollectionError';
    }
}

function fail(code: CollectionErrorCode, message: string): never {
    throw new CollectionError(code, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasControlCharacter(value: string): boolean {
    for (let index = 0; index < value.length; index += 1) {
        const code = value.charCodeAt(index);
        if (code <= 0x1f || code === 0x7f) return true;
    }
    return false;
}

function requireBoundedString(
    value: unknown,
    field: string,
    maxLength: number,
    code: CollectionErrorCode = 'validation',
): string {
    if (typeof value !== 'string') fail(code, `${field} must be a string`);
    if (value.length === 0 || value.length > maxLength) {
        fail(code, `${field} must be a non-empty string of at most ${maxLength} characters`);
    }
    if (value !== value.trim()) fail(code, `${field} must not have leading or trailing whitespace`);
    if (hasControlCharacter(value)) {
        fail(code, `${field} must not contain control characters`);
    }
    return value;
}

function requireOptionalBoundedString(
    value: unknown,
    field: string,
    maxLength: number,
): string | null {
    if (value === undefined || value === null) return null;
    return requireBoundedString(value, field, maxLength);
}

function requireCurrency(value: unknown): string {
    if (typeof value !== 'string' || !CURRENCY_PATTERN.test(value)) {
        fail('invalid_currency', 'currency must be a three-letter uppercase ISO-4217 code');
    }
    return value;
}

function requireSafeSecond(value: unknown, field: string): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
        fail('validation', `${field} must be a non-negative safe integer UTC second`);
    }
    return value;
}

function requireSafeVersion(value: unknown, field: string): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
        fail('validation', `${field} must be a positive safe integer version`);
    }
    return value;
}

function requirePositiveAmount(value: unknown, field: string): bigint {
    if (typeof value !== 'bigint') fail('invalid_amount', `${field} must be a bigint of exact minor units`);
    if (value <= 0n) fail('invalid_amount', `${field} must be positive`);
    if (value > MAX_AMOUNT_MINOR) {
        fail('amount_out_of_range', `${field} exceeds ${MAX_AMOUNT_MINOR.toString()} minor units`);
    }
    return value;
}

function requireNonNegativeAmount(value: unknown, field: string): bigint {
    if (typeof value !== 'bigint') fail('invalid_amount', `${field} must be a bigint of exact minor units`);
    if (value < 0n) fail('invalid_amount', `${field} must not be negative`);
    if (value > MAX_AMOUNT_MINOR) {
        fail('amount_out_of_range', `${field} exceeds ${MAX_AMOUNT_MINOR.toString()} minor units`);
    }
    return value;
}

function requireOrgKind(value: unknown): BillingOrganization {
    if (typeof value !== 'string' || !(BILLING_ORGANIZATIONS as readonly string[]).includes(value)) {
        fail('validation', 'orgKind must be teacher or center');
    }
    return value as BillingOrganization;
}

function requireStatus(value: unknown): DifferenceRequestStatus {
    if (typeof value !== 'string' || !(DIFFERENCE_REQUEST_STATUSES as readonly string[]).includes(value)) {
        fail('validation', 'status must be open, paid, expired or cancelled');
    }
    return value as DifferenceRequestStatus;
}

function requirePeriodStatus(value: unknown): PeriodProtectionStatus {
    if (typeof value !== 'string' || !(PERIOD_PROTECTION_STATUSES as readonly string[]).includes(value)) {
        fail('validation', 'period status is not a known protection status');
    }
    return value as PeriodProtectionStatus;
}

function requireDebtStatus(value: unknown): DebtStatus {
    if (typeof value !== 'string' || !(DEBT_STATUSES as readonly string[]).includes(value)) {
        fail('validation', 'debt status must be due, paid or cancelled');
    }
    return value as DebtStatus;
}

function requireListLimit(value: unknown): number {
    if (value === undefined) return DEFAULT_LIST_LIMIT;
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > MAX_LIST_LIMIT) {
        fail('validation', `limit must be an integer between 1 and ${MAX_LIST_LIMIT}`);
    }
    return value;
}

function requireHex64(value: unknown, field: string): string {
    const text = requireBoundedString(value, field, 128);
    if (!HEX_64_PATTERN.test(text)) {
        fail('validation', `${field} must be a lowercase SHA-256 hex string`);
    }
    return text;
}

export interface DifferenceRequestBasis {
    readonly orgKind: BillingOrganization;
    readonly invoiceId: string;
    /** Proven `billing_invoices.id`, or null for the legacy opaque invoice only. */
    readonly invoiceRefId?: string | null;
    readonly cycleStart: number;
    readonly differenceBasis: string;
}

/**
 * One subscription difference-payment request.
 *
 * `deadlineAt` is the first instant at which the grace is over: the open
 * window is the half-open second interval `[issuedAt, deadlineAt)`. Ordinary
 * requests always satisfy `deadlineAt = issuedAt + 345_600`. Authorized
 * correction records carry `basisKey = null`, `correctionOfRequestId` and an
 * explicitly supplied deadline (see `reopenExpiredRequest`).
 */
export interface DifferenceRequest {
    readonly modelVersion: number;
    readonly requestId: string;
    readonly tenantId: string;
    readonly orgKind: BillingOrganization;
    readonly invoiceId: string;
    /**
     * Guarded shadow link to `billing_invoices.id`; null only for a legacy
     * opaque `invoiceId` (schema: "NULL = opaque legacy invoice_id only").
     */
    readonly invoiceRefId: string | null;
    readonly cycleStart: number;
    readonly differenceBasis: string;
    readonly basisKey: string | null;
    readonly amountMinor: bigint;
    readonly currency: string;
    readonly issuedAt: number;
    readonly deadlineAt: number;
    readonly status: DifferenceRequestStatus;
    readonly version: number;
    readonly requestKey: string;
    readonly payloadHash: string;
    readonly paidAt: number | null;
    readonly settledPaymentId: string | null;
    readonly correctionOfRequestId: string | null;
    readonly correctionReason: string | null;
    readonly correctedByActorId: string | null;
}

const REQUEST_KEYS = [
    'modelVersion', 'requestId', 'tenantId', 'orgKind', 'invoiceId', 'invoiceRefId',
    'cycleStart', 'differenceBasis', 'basisKey', 'amountMinor', 'currency', 'issuedAt',
    'deadlineAt', 'status', 'version', 'requestKey', 'payloadHash', 'paidAt',
    'settledPaymentId', 'correctionOfRequestId', 'correctionReason',
    'correctedByActorId',
];

/**
 * `invoiceRefId` was added after the first rows existed: an object that omits
 * it is the documented legacy/opaque shape (`invoice_ref_id` SQL NULL), while
 * any other missing or foreign key is still rejected.
 */
const REQUEST_OPTIONAL_KEYS: ReadonlySet<string> = new Set(['invoiceRefId']);

function ownsExactly(value: object, keys: readonly string[]): boolean {
    const own = Object.keys(value);
    if (own.length !== keys.length) return false;
    return keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function ownsAtMostWithRequired(value: object, keys: readonly string[], optional: ReadonlySet<string>): boolean {
    const own = Object.keys(value);
    if (own.some((key) => !keys.includes(key))) return false;
    return keys.every((key) => optional.has(key) || Object.prototype.hasOwnProperty.call(value, key));
}

/**
 * Validate and deep-freeze a request shape at every boundary. A store can never
 * hand the domain a malformed row: identity fields, exact amounts, statuses,
 * safe-integer versions and the deadline invariant are all re-checked.
 */
export function assertDifferenceRequest(input: unknown): DifferenceRequest {
    if (!isRecord(input) || !ownsAtMostWithRequired(input, REQUEST_KEYS, REQUEST_OPTIONAL_KEYS)) {
        fail('validation', `difference request must have exactly ${REQUEST_KEYS.join(', ')}`);
    }
    if (input['modelVersion'] !== COLLECTION_MODEL_VERSION) {
        fail('validation', `difference request modelVersion must be ${COLLECTION_MODEL_VERSION}`);
    }
    const orgKind = requireOrgKind(input['orgKind']);
    const cycleStart = requireSafeSecond(input['cycleStart'], 'cycleStart');
    const amountMinor = requirePositiveAmount(input['amountMinor'], 'amountMinor');
    const currency = requireCurrency(input['currency']);
    const issuedAt = requireSafeSecond(input['issuedAt'], 'issuedAt');
    const deadlineAt = requireSafeSecond(input['deadlineAt'], 'deadlineAt');
    if (deadlineAt < issuedAt) fail('validation', 'deadlineAt must not be before issuedAt');

    const status = requireStatus(input['status']);
    const version = requireSafeVersion(input['version'], 'version');
    const requestId = requireBoundedString(input['requestId'], 'requestId', MAX_REQUEST_ID_LENGTH);
    const tenantId = requireBoundedString(input['tenantId'], 'tenantId', MAX_TENANT_LENGTH, 'invalid_tenant');
    const correctionOfRequestId = requireOptionalBoundedString(
        input['correctionOfRequestId'],
        'correctionOfRequestId',
        MAX_REQUEST_ID_LENGTH,
    );
    const correctionReason = requireOptionalBoundedString(input['correctionReason'], 'correctionReason', MAX_REASON_LENGTH);
    const correctedByActorId = requireOptionalBoundedString(
        input['correctedByActorId'],
        'correctedByActorId',
        MAX_ACTOR_ID_LENGTH,
    );

    const rawBasisKey = input['basisKey'];
    let basisKey: string | null;
    if (rawBasisKey === null) {
        basisKey = null;
    } else {
        basisKey = requireHex64(rawBasisKey, 'basisKey');
    }

    if (correctionOfRequestId === null) {
        if (basisKey === null) fail('validation', 'an ordinary difference request requires a basisKey');
        if (deadlineAt - issuedAt !== DIFFERENCE_GRACE_SECONDS) {
            fail('validation', `an ordinary difference request deadline must be issuedAt + ${DIFFERENCE_GRACE_SECONDS} seconds`);
        }
        if (correctionReason !== null || correctedByActorId !== null) {
            fail('validation', 'an ordinary difference request must not carry correction metadata');
        }
    } else {
        if (basisKey !== null) fail('validation', 'an authorized correction must not reuse the basis unique key');
        if (correctionReason === null) fail('validation', 'an authorized correction requires a reason');
        if (correctedByActorId === null) fail('validation', 'an authorized correction requires an authorized actor');
        if (correctionOfRequestId === requestId) fail('validation', 'a correction cannot reference itself');
    }

    const paidAtRaw = input['paidAt'];
    const paidAt = paidAtRaw === null ? null : requireSafeSecond(paidAtRaw, 'paidAt');
    const settledPaymentId = requireOptionalBoundedString(
        input['settledPaymentId'],
        'settledPaymentId',
        MAX_PAYMENT_ID_LENGTH,
    );
    if (status === 'paid') {
        if (paidAt === null || settledPaymentId === null) {
            fail('validation', 'a paid difference request requires paidAt and settledPaymentId');
        }
        if (paidAt < issuedAt) fail('validation', 'paidAt must not be before issuedAt');
    } else if (paidAt !== null || settledPaymentId !== null) {
        fail('validation', 'only a paid difference request may carry settlement fields');
    }

    const rawInvoiceRefId = input['invoiceRefId'];
    const invoiceRefId = rawInvoiceRefId === undefined || rawInvoiceRefId === null
        ? null
        : requireBoundedString(rawInvoiceRefId, 'invoiceRefId', MAX_INVOICE_REF_LENGTH);

    return Object.freeze({
        modelVersion: COLLECTION_MODEL_VERSION,
        requestId,
        tenantId,
        orgKind,
        invoiceId: requireBoundedString(input['invoiceId'], 'invoiceId', MAX_INVOICE_ID_LENGTH),
        invoiceRefId,
        cycleStart,
        differenceBasis: requireBoundedString(
            input['differenceBasis'],
            'differenceBasis',
            MAX_DIFFERENCE_BASIS_LENGTH,
        ),
        basisKey,
        amountMinor,
        currency,
        issuedAt,
        deadlineAt,
        status,
        version,
        requestKey: requireBoundedString(input['requestKey'], 'requestKey', MAX_REQUEST_KEY_LENGTH, 'invalid_idempotency_key'),
        payloadHash: requireHex64(input['payloadHash'], 'payloadHash'),
        paidAt,
        settledPaymentId,
        correctionOfRequestId,
        correctionReason,
        correctedByActorId,
    });
}

function hashBasisKey(basis: DifferenceRequestBasis & { readonly tenantId: string }): string {
    return createHash('sha256')
        .update(JSON.stringify({
            modelVersion: COLLECTION_MODEL_VERSION,
            tenantId: basis.tenantId,
            orgKind: basis.orgKind,
            invoiceId: basis.invoiceId,
            // Legacy (null) identities keep the original hash input byte-for-byte.
            ...(basis.invoiceRefId === undefined || basis.invoiceRefId === null
                ? {}
                : { invoiceRefId: basis.invoiceRefId }),
            cycleStart: basis.cycleStart,
            differenceBasis: basis.differenceBasis,
        }))
        .digest('hex');
}

function hashIssuePayload(input: {
    readonly tenantId: string;
    readonly orgKind: BillingOrganization;
    readonly invoiceId: string;
    readonly invoiceRefId: string | null;
    readonly cycleStart: number;
    readonly differenceBasis: string;
    readonly amountMinor: bigint;
    readonly currency: string;
    readonly issuedAt: number;
}): string {
    return createHash('sha256')
        .update(JSON.stringify({
            modelVersion: COLLECTION_MODEL_VERSION,
            tenantId: input.tenantId,
            orgKind: input.orgKind,
            invoiceId: input.invoiceId,
            ...(input.invoiceRefId === null ? {} : { invoiceRefId: input.invoiceRefId }),
            cycleStart: input.cycleStart,
            differenceBasis: input.differenceBasis,
            amountMinor: input.amountMinor.toString(),
            currency: input.currency,
            issuedAt: input.issuedAt,
        }))
        .digest('hex');
}

/**
 * HK1 basis-key replay must compare the canonical financial identity, amount
 * and currency, not only the basis hash: a basis hit with a different amount or
 * currency is a typed conflict with NO write, while a true replay returns the
 * stored row unchanged (so its original `issued_at`/`deadline_at` never move).
 */
function requireSameBasisReplay(
    request: DifferenceRequest,
    expected: {
        readonly orgKind: BillingOrganization;
        readonly invoiceId: string;
        readonly invoiceRefId: string | null;
        readonly cycleStart: number;
        readonly differenceBasis: string;
        readonly amountMinor: bigint;
        readonly currency: string;
    },
): void {
    if (
        request.orgKind !== expected.orgKind
        || request.invoiceId !== expected.invoiceId
        || request.invoiceRefId !== expected.invoiceRefId
        || request.cycleStart !== expected.cycleStart
        || request.differenceBasis !== expected.differenceBasis
        || request.amountMinor !== expected.amountMinor
        || request.currency !== expected.currency
    ) {
        fail(
            'idempotency_conflict',
            'the same difference basis exists with a different canonical financial identity, amount or currency',
        );
    }
}

/**
 * Transaction-bound persistence contract for collection.
 *
 * A SQL adapter MUST enforce (the pure domain cannot enforce these itself):
 *
 *  - `UNIQUE (tenant_id, request_key)` and a payload hash column, so issuance
 *    idempotency follows the HK1 pattern `(tenant, scope, key, payloadHash)`;
 *    an adapter may instead register the same tuple in
 *    `billing_idempotency_keys` with a collection scope.
 *  - `UNIQUE (tenant_id, basis_key)` where `basis_key` is a 64-char SHA-256
 *    value for ordinary requests and SQL NULL for authorized corrections, so
 *    MySQL allows many corrections while still allowing only one live basis.
 *  - `UNIQUE (tenant_id, settled_payment_id)` where the column is not NULL, so
 *    one verified payment can never settle two requests.
 *  - a tenant predicate on EVERY read and write; no global query is possible.
 *  - `amount_minor`, `issued_at`, `deadline_at` and `cycle_start` are BIGINT;
 *    reads are converted with `BigInt()` and never pass through `Number`.
 *  - `currency` is `CHAR(3)` uppercase ISO-4217 and `version` is a safe integer.
 *  - `deadline_at` (and every identity/money column) is immutable after
 *    insert: no UPDATE grant, trigger or adapter method may change it. Only
 *    `status`, `paid_at`, `settled_payment_id` and `version` move.
 *  - `updateStatusCas` is one conditional write:
 *    `... WHERE tenant_id = ? AND request_id = ? AND version = ? AND status = ?`
 *    and must increment `version` by exactly one.
 *  - `findByIdForUpdate` takes a row lock (`FOR UPDATE`) in the same
 *    transaction/connection as the following CAS and audit.
 *  - `listOpenForTenant` is bounded, ordered by `(deadline_at, request_id)` and
 *    reads `limit + 1` rows to report `truncated` explicitly instead of
 *    silently cutting the batch.
 *  - `resolveInvoiceForDifference` (when the adapter supports the guarded
 *    invoice link) performs a locking read of `billing_invoices` through the
 *    shared allocation source (`computeInvoiceOutstanding`) on the SAME
 *    connection as the insert. It returns the proven invoice id, its currency
 *    and the remaining allocated balance; an unknown/incomplete source is
 *    `debt_source_unavailable` and nothing is written.
 *  - `writeAudit` writes ONE sealed audit row on the SAME connection and
 *    transaction as the mutation. An audit failure rolls the mutation back.
 */
export const COLLECTION_STORE_SQL_CONTRACT: readonly string[] = Object.freeze([
    'UNIQUE (tenant_id, request_key) with payload_hash implements HK1 issuance idempotency; the same key with another payload is a conflict.',
    'invoice_ref_id is written only from a server-proven billing_invoices.id (locking read, same tenant, same currency); NULL means legacy opaque invoice_id only and is never derived from a caller string.',
    'UNIQUE (tenant_id, basis_key) where basis_key is NULL for authorized corrections enforces one ordinary request per tenant/organization/invoice/cycle/difference basis.',
    'UNIQUE (tenant_id, settled_payment_id) where settled_payment_id is not NULL prevents one verified payment from settling two requests.',
    'Every read and write carries a tenant predicate; no method may run a global query.',
    'amount_minor, issued_at, deadline_at and cycle_start are BIGINT; adapters convert with BigInt() and never with Number (HK2).',
    'currency is CHAR(3) uppercase ISO-4217 and version is a safe integer.',
    'deadline_at, issued_at, amount_minor, currency and identity columns are immutable after insert; only status, paid_at, settled_payment_id and version may change.',
    'updateStatusCas is a conditional write on (tenant_id, request_id, version, status) that increments version by exactly one.',
    'findByIdForUpdate locks the row FOR UPDATE on the same connection as the following CAS and audit.',
    'listOpenForTenant is bounded, ordered by (deadline_at, request_id) and reports an explicit truncated flag.',
    'writeAudit writes exactly one sealed audit row on the same connection/transaction as the mutation; an audit failure rolls the mutation back.',
]);

export interface UpdateStatusCasInput {
    readonly tenantId: string;
    readonly requestId: string;
    readonly expectedVersion: number;
    readonly toStatus: Exclude<DifferenceRequestStatus, 'open'>;
    readonly paidAt: number | null;
    readonly settledPaymentId: string | null;
}

export type UpdateStatusCasResult =
    | { readonly ok: true; readonly request: DifferenceRequest }
    | { readonly ok: false; readonly reason: 'not_found' | 'version_conflict' | 'invalid_transition' };

export interface DifferenceRequestPage {
    readonly requests: readonly DifferenceRequest[];
    readonly truncated: boolean;
}

export type InsertDifferenceRequestResult = 'inserted' | 'duplicate_key';

/**
 * Server-side proof of an invoice reference, computed in the same transaction
 * from the single allocation source. `outstandingMinor` is exact minor units.
 */
export type DifferenceInvoiceResolution =
    | {
        readonly ok: true;
        readonly invoiceId: string;
        readonly currency: string;
        readonly outstandingMinor: bigint;
        /**
         * Exact sum of the OTHER open (status 'open' and not past its deadline
         * at the issuing instant) difference requests already linked to this
         * invoice, read after the invoice lock. A store that cannot report it
         * omits it and the issuer fails closed (unknown is never zero).
         */
        readonly otherOpenRequestedMinor?: bigint;
    }
    | {
        readonly ok: false;
        readonly reason: 'invoice_not_found' | 'debt_source_unavailable';
    };

/**
 * What a verified payment must prove for a request to be closed. The purpose is
 * the caller's platform-subscription purpose code (byte-exact; this module
 * never invents the code). `invoiceRefId` is the locked request's proven
 * invoice link (null for an unlinked/legacy request).
 */
export interface PaymentProofContext {
    readonly purpose: string;
    readonly invoiceRefId: string | null;
}

/**
 * Platform payment proof (CL-B-BILLING 14.3 / 14.7), re-read under lock by the
 * store. `paymentId` is the settlement OBLIGATION id. `netAllocatedMinor` is
 * the CURRENT sum of non-reversed 'payment' allocations of THIS obligation on
 * the request's invoice; `allocationId` is that funding payment allocation.
 *
 * DEVIATION from the frozen 14.7 union: `orderId` (the paid checkout order of
 * the obligation, proven under lock) is added because the consumption link
 * `platform_payment_request_links` carries `order_id` (14.8.6) and no other
 * input can supply it to `insertPaymentRequestLink`.
 */
export type PaymentProofResolution =
    | {
        readonly ok: true;
        readonly paymentId: string;
        readonly orderId: string;
        readonly amountMinor: bigint;
        readonly allocatableMinor: bigint;
        readonly currency: string;
        readonly purpose: string;
        readonly requestId: string;
        readonly invoiceId: string;
        readonly netAllocatedMinor: bigint;
        readonly allocationId: string;
    }
    | {
        readonly ok: false;
        readonly reason:
            | 'payment_proof_unavailable'
            | 'unresolved_reference'
            | 'reconciliation_required'
            | 'stale_allocation_proof'
            | 'purpose_not_allowed'
            | 'target_mismatch';
    };

/** What the strict proof must match: the LOCKED request, never caller text. */
export interface PlatformPaymentProofRequest {
    readonly requestId: string;
    readonly invoiceRefId: string;
    readonly amountMinor: bigint;
    readonly currency: string;
}

/** One-time consumption of an obligation/allocation by one request (14.3.5). */
export interface PaymentRequestLink {
    readonly tenantId: string;
    readonly obligationId: SettlementObligationId;
    readonly orderId: string;
    readonly requestId: string;
    readonly invoiceId: string;
    readonly allocationId: string;
    readonly currency: string;
    readonly amountMinor: bigint;
}

export type InsertPaymentRequestLinkResult = 'inserted' | 'duplicate_same' | 'duplicate_conflict';

export interface CollectionTransaction {
    findByKey(tenantId: string, requestKey: string): Promise<DifferenceRequest | null>;
    findByBasisKey(tenantId: string, basisKey: string): Promise<DifferenceRequest | null>;
    findByIdForUpdate(tenantId: string, requestId: string): Promise<DifferenceRequest | null>;
    /**
     * OPTIONAL plain NON-locking read by id. Together with
     * `lockInvoiceForPayment` it lets applyVerifiedPayment honour the global
     * lock order (invoices -> allocations -> difference requests).
     */
    findById?(tenantId: string, requestId: string): Promise<DifferenceRequest | null>;
    /**
     * OPTIONAL lock-order capability: take the invoice row and allocation
     * locks (steps 1-2) before the request row is locked. `ok: false` means the
     * invoice/allocation source could not be locked or trusted.
     */
    lockInvoiceForPayment?(tenantId: string, invoiceRefId: string): Promise<{ readonly ok: boolean }>;
    findBySettlementPaymentId(tenantId: string, paymentId: string): Promise<DifferenceRequest | null>;
    insertRequest(request: DifferenceRequest): Promise<InsertDifferenceRequestResult>;
    /**
     * OPTIONAL guarded-link capability. When present and the caller supplies
     * `invoiceRefId`, the invoice must resolve on this connection (locking
     * read) with the same tenant and currency and enough outstanding balance.
     * Absent => a request that names an `invoiceRefId` fails closed.
     */
    resolveInvoiceForDifference?(
        tenantId: string,
        invoiceRefId: string,
        asOfSeconds: number,
    ): Promise<DifferenceInvoiceResolution>;
    /**
     * OPTIONAL financial-proof capability (Codex R4: a free payment string is
     * never proof). Returns the settlement obligation re-read under lock that
     * proves a verified, completed, paid order for exactly this tenant, payment,
     * amount, currency and purpose. Absent method => applyVerifiedPayment fails
     * closed with `payment_proof_unavailable` and writes nothing.
     */
    verifyPaymentProof?(
        tenantId: string,
        paymentId: string,
        amountMinor: bigint,
        currency: string,
        purposeContext: PaymentProofContext,
    ): Promise<PaymentProofResolution>;
    /**
     * OPTIONAL strict platform proof used by `applyVerifiedPlatformPayment`
     * (absent => `payment_proof_unavailable`, nothing written). Takes FOR SHARE
     * locks G4-G6 (obligation, order, target) only after the request row lock.
     */
    verifyPlatformPaymentProof?(
        tenantId: string,
        obligationId: SettlementObligationId,
        request: PlatformPaymentProofRequest,
    ): Promise<PaymentProofResolution>;
    /**
     * OPTIONAL one-time consumption link (G7), written in the same transaction
     * as the request closing (absent => `payment_proof_unavailable`).
     */
    insertPaymentRequestLink?(link: PaymentRequestLink): Promise<InsertPaymentRequestLinkResult>;
    updateStatusCas(input: UpdateStatusCasInput): Promise<UpdateStatusCasResult>;
    listOpenForTenant(
        tenantId: string,
        query?: { readonly limit?: number },
    ): Promise<DifferenceRequestPage>;
    writeAudit(record: CollectionAuditRecord): Promise<void>;
}

export interface CollectionStore {
    runAtomic<T>(callback: (tx: CollectionTransaction) => Promise<T>): Promise<T>;
}

export type CollectionAuditAction =
    | 'billing.difference_request.issued'
    | 'billing.difference_request.paid'
    | 'billing.difference_request.expired'
    | 'billing.difference_request.cancelled'
    | 'billing.difference_request.reopened';

export interface CollectionAuditRecord {
    readonly action: CollectionAuditAction;
    readonly tenantId: string;
    readonly requestId: string;
    readonly status: DifferenceRequestStatus;
    readonly version: number;
    readonly amountMinor: string;
    readonly currency: string;
    readonly invoiceId: string;
    readonly cycleStart: number;
    readonly deadlineAt: number;
    readonly reason: string | null;
    readonly actorId: string | null;
}

function auditFor(
    action: CollectionAuditAction,
    request: DifferenceRequest,
    reason: string | null,
    actorId: string | null,
): CollectionAuditRecord {
    return Object.freeze({
        action,
        tenantId: request.tenantId,
        requestId: request.requestId,
        status: request.status,
        version: request.version,
        amountMinor: request.amountMinor.toString(),
        currency: request.currency,
        invoiceId: request.invoiceId,
        cycleStart: request.cycleStart,
        deadlineAt: request.deadlineAt,
        reason,
        actorId,
    });
}

function requireSameTenant(request: DifferenceRequest, tenantId: string): void {
    if (request.tenantId !== tenantId) {
        fail('tenant_mismatch', 'the store returned a difference request outside the requested tenant');
    }
}

function requireSamePayload(request: DifferenceRequest, payloadHash: string): void {
    if (request.payloadHash !== payloadHash) {
        fail('idempotency_conflict', 'the same request key exists with a different payload');
    }
}

/**
 * Re-validate every store read through `assertDifferenceRequest` and enforce the
 * tenant predicate. This is the HK2 read boundary: an adapter cannot leak a
 * foreign row, a `Number` amount or a malformed status into the domain.
 */
function checkedRequest(value: DifferenceRequest | null, tenantId: string): DifferenceRequest | null {
    if (value === null) return null;
    const parsed = assertDifferenceRequest(value);
    requireSameTenant(parsed, tenantId);
    return parsed;
}

export interface IssueDifferenceRequestInput {
    readonly tenantId: string;
    readonly orgKind: BillingOrganization;
    /** Legacy opaque invoice key (VARCHAR(128)); never trusted as an FK value. */
    readonly invoiceId: string;
    /**
     * Optional REAL `billing_invoices.id` (CHAR(36)). When supplied it is
     * proven by the store in the same transaction and becomes the persisted
     * `invoice_ref_id`; the amount is capped at the invoice's outstanding.
     */
    readonly invoiceRefId?: string | null;
    readonly cycleStart: number;
    readonly differenceBasis: string;
    readonly amountMinor: unknown;
    readonly currency: string;
    readonly issuedAt: number;
    readonly requestKey: string;
}

export interface IssueDifferenceRequestResult {
    readonly request: DifferenceRequest;
    readonly replayed: boolean;
}

/**
 * Issue one difference request, atomically.
 *
 * The deadline is computed ONCE here and then stored. A later re-request with
 * another key but the same basis returns the stored request and leaves
 * `deadlineAt` untouched. Same key + different payload is a typed conflict.
 */
export async function issueDifferenceRequest(
    store: CollectionStore,
    input: IssueDifferenceRequestInput,
): Promise<IssueDifferenceRequestResult> {
    if (typeof store?.runAtomic !== 'function') fail('validation', 'store must expose runAtomic');
    const tenantId = requireBoundedString(input.tenantId, 'tenantId', MAX_TENANT_LENGTH, 'invalid_tenant');
    const orgKind = requireOrgKind(input.orgKind);
    const invoiceId = requireBoundedString(input.invoiceId, 'invoiceId', MAX_INVOICE_ID_LENGTH);
    const invoiceRefId = input.invoiceRefId === undefined || input.invoiceRefId === null
        ? null
        : requireBoundedString(input.invoiceRefId, 'invoiceRefId', MAX_INVOICE_REF_LENGTH);
    const cycleStart = requireSafeSecond(input.cycleStart, 'cycleStart');
    const differenceBasis = requireBoundedString(
        input.differenceBasis,
        'differenceBasis',
        MAX_DIFFERENCE_BASIS_LENGTH,
    );
    const amountMinor = requirePositiveAmount(input.amountMinor, 'amountMinor');
    const currency = requireCurrency(input.currency);
    const issuedAt = requireSafeSecond(input.issuedAt, 'issuedAt');
    if (issuedAt > MAX_SAFE_SECONDS - DIFFERENCE_GRACE_SECONDS) {
        fail('validation', 'issuedAt + 96 hours exceeds the safe integer second range');
    }
    const deadlineAt = issuedAt + DIFFERENCE_GRACE_SECONDS;
    const requestKey = requireBoundedString(
        input.requestKey,
        'requestKey',
        MAX_REQUEST_KEY_LENGTH,
        'invalid_idempotency_key',
    );
    const basisKey = hashBasisKey({ tenantId, orgKind, invoiceId, invoiceRefId, cycleStart, differenceBasis });
    const payloadHash = hashIssuePayload({
        tenantId,
        orgKind,
        invoiceId,
        invoiceRefId,
        cycleStart,
        differenceBasis,
        amountMinor,
        currency,
        issuedAt,
    });

    const request = assertDifferenceRequest({
        modelVersion: COLLECTION_MODEL_VERSION,
        requestId: randomUUID(),
        tenantId,
        orgKind,
        invoiceId,
        invoiceRefId,
        cycleStart,
        differenceBasis,
        basisKey,
        amountMinor,
        currency,
        issuedAt,
        deadlineAt,
        status: 'open',
        version: 1,
        requestKey,
        payloadHash,
        paidAt: null,
        settledPaymentId: null,
        correctionOfRequestId: null,
        correctionReason: null,
        correctedByActorId: null,
    });

    return store.runAtomic(async (tx) => {
        const existingByKey = checkedRequest(await tx.findByKey(tenantId, requestKey), tenantId);
        if (existingByKey !== null) {
            requireSamePayload(existingByKey, payloadHash);
            return { request: existingByKey, replayed: true };
        }

        const existingByBasis = checkedRequest(await tx.findByBasisKey(tenantId, basisKey), tenantId);
        if (existingByBasis !== null) {
            requireSameBasisReplay(existingByBasis, {
                orgKind,
                invoiceId,
                invoiceRefId,
                cycleStart,
                differenceBasis,
                amountMinor,
                currency,
            });
            return { request: existingByBasis, replayed: true };
        }

        if (invoiceRefId !== null) {
            // Server-side proof under the invoice lock, same transaction, before any write.
            if (typeof tx.resolveInvoiceForDifference !== 'function') {
                fail('debt_source_unavailable', 'the store cannot prove an invoice reference; nothing was written');
            }
            const proof = await tx.resolveInvoiceForDifference(tenantId, invoiceRefId, issuedAt);
            if (!proof.ok) {
                fail(
                    proof.reason,
                    proof.reason === 'invoice_not_found'
                        ? 'invoiceRefId does not resolve to an invoice of this tenant'
                        : 'the shared allocation source is unavailable or incomplete for this invoice',
                );
            }
            if (proof.invoiceId !== invoiceRefId) {
                fail('invoice_not_found', 'the store resolved a different invoice than the one requested');
            }
            if (proof.currency !== currency) {
                fail('currency_mismatch', 'the difference request currency differs from the invoice currency');
            }
            // Several open requests on one invoice must never sum above the
            // outstanding: cap against outstanding minus the OTHER open requests.
            if (typeof proof.otherOpenRequestedMinor !== 'bigint' || proof.otherOpenRequestedMinor < 0n) {
                fail('debt_source_unavailable', 'the store did not report the other open requests of this invoice');
            }
            if (amountMinor > proof.outstandingMinor - proof.otherOpenRequestedMinor) {
                fail(
                    'amount_exceeds_outstanding',
                    'a difference request is a payment request for the remaining balance (minus other open requests) and cannot exceed it',
                );
            }
        }

        const inserted = await tx.insertRequest(request);
        if (inserted === 'duplicate_key') {
            const racedByKey = checkedRequest(await tx.findByKey(tenantId, requestKey), tenantId);
            if (racedByKey !== null) {
                requireSamePayload(racedByKey, payloadHash);
                return { request: racedByKey, replayed: true };
            }
            const racedByBasis = checkedRequest(await tx.findByBasisKey(tenantId, basisKey), tenantId);
            if (racedByBasis !== null) {
                requireSameBasisReplay(racedByBasis, {
                    orgKind,
                    invoiceId,
                    invoiceRefId,
                    cycleStart,
                    differenceBasis,
                    amountMinor,
                    currency,
                });
                return { request: racedByBasis, replayed: true };
            }
            fail('store_inconsistent', 'insert reported a duplicate that cannot be read inside the transaction');
        }

        await tx.writeAudit(auditFor('billing.difference_request.issued', request, null, null));
        return { request, replayed: false };
    });
}

export interface ApplyVerifiedPaymentInput {
    readonly tenantId: string;
    readonly requestId: string;
    /**
     * INTENTIONAL ADAPTER (CL-B-BILLING 14.3.1): `paymentId` IS the settlement
     * obligation id (`financial_settlement_obligations.id`), never a provider
     * reference, browser token, order id or request id. New callers use
     * `applyVerifiedPlatformPayment` with `obligationId`.
     */
    readonly paymentId: string;
    readonly amountMinor: unknown;
    readonly currency: string;
    readonly paidAt: number;
    /**
     * Platform-subscription purpose code, used ONLY as a consistency assertion
     * (the purpose is always taken from the LOCKED obligation row). It must be
     * in the platform allowlist and equal the locked purpose. Absent =>
     * `payment_proof_unavailable` (nothing is written).
     */
    readonly purposeContext?: { readonly purpose: string };
}

export interface ApplyVerifiedPaymentResult {
    readonly request: DifferenceRequest;
    readonly replayed: boolean;
}

export interface ApplyVerifiedPlatformPaymentInput {
    readonly tenantId: string;
    readonly requestId: string;
    readonly obligationId: SettlementObligationId;
    readonly amountMinor: unknown;
    readonly currency: string;
    readonly paidAt: number;
}

/**
 * Thin intentional adapter (14.3.1): maps the legacy `paymentId` to the
 * settlement obligation id, rejects a `purposeContext.purpose` outside the
 * platform allowlist BEFORE any store call, and delegates to the strict path.
 * The locked obligation purpose must also equal the asserted purpose.
 */
export async function applyVerifiedPayment(
    store: CollectionStore,
    input: ApplyVerifiedPaymentInput,
): Promise<ApplyVerifiedPaymentResult> {
    if (typeof store?.runAtomic !== 'function') fail('validation', 'store must expose runAtomic');
    const obligationId = toObligationId(input.paymentId);
    const purpose = input.purposeContext?.purpose;
    if (typeof purpose !== 'string' || purpose.length === 0 || purpose.length > 64) {
        fail('payment_proof_unavailable', 'a platform-subscription purpose is required to prove the payment');
    }
    if (!PLATFORM_DIFFERENCE_PAYMENT_PURPOSES.has(purpose)) {
        fail('purpose_not_allowed', 'the payment purpose is outside the platform allowlist');
    }
    return applyPlatformPaymentInternal(
        store,
        {
            tenantId: input.tenantId,
            requestId: input.requestId,
            obligationId,
            amountMinor: input.amountMinor,
            currency: input.currency,
            paidAt: input.paidAt,
        },
        purpose,
    );
}

function toObligationId(value: unknown): SettlementObligationId {
    try {
        return asSettlementObligationId(value);
    } catch (error) {
        if (error instanceof CollectionError) throw error;
        return fail('invalid_idempotency_key', 'paymentId must be a valid settlement obligation id');
    }
}

/**
 * Apply one verified gateway payment (a settlement OBLIGATION) to a request.
 *
 * STRICT closure rule (14.3.6), evaluated under the locks of 14.6: the request
 * must be linked (`invoice_ref_id` not NULL: an unlinked legacy request is
 * `unresolved_reference` BEFORE any obligation/order/allocation read), the
 * LOCKED obligation purpose must be in the platform allowlist (only
 * `subscription_difference`; `student_tuition` fails regardless of amount,
 * currency or status), the immutable order target must match the request, and
 * the store recomputes the CURRENT non-reversed allocation proof EVERY time
 * (even when the obligation status is `allocated`; a reversal makes it
 * `stale_allocation_proof`). Only an exact full payment closes the request:
 * obligation gross == allocatable == request amount == net allocation of THIS
 * obligation to the request invoice. Partial funds stay recorded allocations
 * with the request open (`partial_payment_held`); an overpayment is a
 * reconciliation case (`overpayment_held` / `reconciliation_required`), never
 * discarded and never "fully allocated".
 *
 * ONE allocation cannot close two requests: the unique consumption link
 * `platform_payment_request_links` is persisted in the SAME transaction as the
 * request CAS (same payload replay => no second mutation/audit; changed
 * payload or already-consumed request/allocation => `payment_conflict`).
 *
 * LOCK ORDER: replay lookup (plain), request pre-read (plain), G1-G2 invoice +
 * allocations, G3 request FOR UPDATE, G4-G6 proof (FOR SHARE), G7 link INSERT,
 * request CAS, one sealed audit. This function creates NO allocation and NO
 * journal: the settlement domain owns both.
 */
export async function applyVerifiedPlatformPayment(
    store: CollectionStore,
    input: ApplyVerifiedPlatformPaymentInput,
): Promise<ApplyVerifiedPaymentResult> {
    return applyPlatformPaymentInternal(store, input, undefined);
}

function proofFailureMessage(reason: string): string {
    switch (reason) {
        case 'unresolved_reference':
            return 'the request or the order has no proven invoice/target link; reconciliation is required';
        case 'reconciliation_required':
            return 'the verified payment cannot close the request automatically; reconciliation is required';
        case 'stale_allocation_proof':
            return 'the current non-reversed allocation proof is not exactly the required amount';
        case 'purpose_not_allowed':
            return 'the locked obligation purpose is outside the platform allowlist';
        case 'target_mismatch':
            return 'the durable order target does not match the request, invoice, currency or amount';
        default:
            return 'no verified settlement obligation proves this payment for this request';
    }
}

async function applyPlatformPaymentInternal(
    store: CollectionStore,
    input: ApplyVerifiedPlatformPaymentInput,
    assertedPurpose: string | undefined,
): Promise<ApplyVerifiedPaymentResult> {
    if (typeof store?.runAtomic !== 'function') fail('validation', 'store must expose runAtomic');
    const tenantId = requireBoundedString(input.tenantId, 'tenantId', MAX_TENANT_LENGTH, 'invalid_tenant');
    const requestId = requireBoundedString(input.requestId, 'requestId', MAX_REQUEST_ID_LENGTH);
    const obligationId = toObligationId(input.obligationId);
    const amountMinor = requirePositiveAmount(input.amountMinor, 'amountMinor');
    const currency = requireCurrency(input.currency);
    const paidAt = requireSafeSecond(input.paidAt, 'paidAt');

    return store.runAtomic(async (tx) => {
        // Same-key replay vs changed-payload conflict (plain read).
        const paidByThisPayment = checkedRequest(await tx.findBySettlementPaymentId(tenantId, obligationId), tenantId);
        if (paidByThisPayment !== null) {
            if (paidByThisPayment.requestId === requestId) {
                if (paidByThisPayment.amountMinor !== amountMinor || paidByThisPayment.currency !== currency) {
                    fail('payment_conflict', 'the same verified payment id was replayed with a different payload');
                }
                return { request: paidByThisPayment, replayed: true };
            }
            fail('payment_conflict', 'the same verified payment id already settled another request');
        }

        // LOCK ORDER (14.6): the strict path REQUIRES the pre-read and the
        // invoice/allocation lock capability; without them G1-G2 could not
        // precede the request row lock, so it fails closed.
        if (
            typeof tx.findById !== 'function'
            || typeof tx.lockInvoiceForPayment !== 'function'
            || typeof tx.verifyPlatformPaymentProof !== 'function'
            || typeof tx.insertPaymentRequestLink !== 'function'
        ) {
            fail('payment_proof_unavailable', 'the store cannot prove a platform payment under the global lock order');
        }
        const preRead = checkedRequest(await tx.findById(tenantId, requestId), tenantId);
        if (preRead === null) fail('request_not_found', 'difference request was not found');
        if (preRead.invoiceRefId === null) {
            // Unlinked legacy request: never closed automatically; no read of
            // an obligation, order or allocation has happened.
            fail('unresolved_reference', 'the request has no proven invoice link (invoice_ref_id is NULL)');
        }
        const locked = await tx.lockInvoiceForPayment(tenantId, preRead.invoiceRefId);
        if (!locked.ok) {
            fail('payment_proof_unavailable', 'the request invoice and its allocations could not be locked');
        }

        const request = checkedRequest(await tx.findByIdForUpdate(tenantId, requestId), tenantId);
        if (request === null) fail('request_not_found', 'difference request was not found');
        if (
            preRead.requestId !== request.requestId
            || preRead.invoiceRefId !== request.invoiceRefId
            || preRead.invoiceId !== request.invoiceId
            || preRead.amountMinor !== request.amountMinor
            || preRead.currency !== request.currency
        ) {
            fail('version_conflict', 'difference request changed concurrently');
        }
        if (request.invoiceRefId === null) {
            fail('unresolved_reference', 'the request has no proven invoice link (invoice_ref_id is NULL)');
        }

        if (request.status === 'paid') {
            fail('already_paid', 'difference request was already paid by another verified payment');
        }
        if (request.status === 'cancelled') {
            fail('invalid_transition', 'a cancelled difference request cannot be paid');
        }
        if (request.currency !== currency) fail('currency_mismatch', 'payment currency does not match the request');
        if (paidAt < request.issuedAt) fail('validation', 'paidAt must not be before the request issue instant');
        if (amountMinor < request.amountMinor) {
            fail(
                'partial_payment_held',
                'partial funds stay recorded allocations: the request stays open with its explicit outstanding',
            );
        }
        if (amountMinor > request.amountMinor) {
            fail(
                'overpayment_held',
                'overpayment is a reconciliation case: it is never discarded and never closes the request',
            );
        }

        const proof = await tx.verifyPlatformPaymentProof(tenantId, obligationId, {
            requestId: request.requestId,
            invoiceRefId: request.invoiceRefId,
            amountMinor: request.amountMinor,
            currency: request.currency,
        });
        if (!proof.ok) fail(proof.reason, proofFailureMessage(proof.reason));

        // Defense in depth: the domain re-checks every proven field.
        if (!PLATFORM_DIFFERENCE_PAYMENT_PURPOSES.has(proof.purpose)) {
            fail('purpose_not_allowed', proofFailureMessage('purpose_not_allowed'));
        }
        if (assertedPurpose !== undefined && proof.purpose !== assertedPurpose) {
            fail('purpose_not_allowed', 'the asserted purpose differs from the locked obligation purpose');
        }
        if (
            proof.paymentId !== obligationId
            || proof.requestId !== request.requestId
            || proof.invoiceId !== request.invoiceRefId
            || typeof proof.orderId !== 'string'
            || proof.orderId.length === 0
            || typeof proof.allocationId !== 'string'
            || proof.allocationId.length === 0
        ) {
            fail('target_mismatch', proofFailureMessage('target_mismatch'));
        }
        if (proof.amountMinor !== amountMinor || proof.currency !== currency) {
            fail('payment_proof_unavailable', proofFailureMessage('payment_proof_unavailable'));
        }
        if (proof.allocatableMinor !== proof.amountMinor || proof.allocatableMinor > request.amountMinor) {
            fail('reconciliation_required', proofFailureMessage('reconciliation_required'));
        }
        if (proof.netAllocatedMinor > request.amountMinor) {
            fail('reconciliation_required', proofFailureMessage('reconciliation_required'));
        }
        if (proof.netAllocatedMinor !== request.amountMinor) {
            fail('stale_allocation_proof', proofFailureMessage('stale_allocation_proof'));
        }

        // G7: persist the unique consumption link BEFORE the CAS, same transaction.
        const linked = await tx.insertPaymentRequestLink({
            tenantId,
            obligationId,
            orderId: proof.orderId,
            requestId: request.requestId,
            invoiceId: proof.invoiceId,
            allocationId: proof.allocationId,
            currency: request.currency,
            amountMinor: request.amountMinor,
        });
        if (linked === 'duplicate_conflict') {
            fail(
                'payment_conflict',
                'this obligation, request or allocation is already consumed by a different payment link',
            );
        }
        if (linked === 'duplicate_same') {
            fail('store_inconsistent', 'the consumption link already exists but the request is not closed');
        }

        const updated = await tx.updateStatusCas({
            tenantId,
            requestId: request.requestId,
            expectedVersion: request.version,
            toStatus: 'paid',
            paidAt,
            settledPaymentId: obligationId,
        });
        if (!updated.ok) {
            if (updated.reason === 'version_conflict') fail('version_conflict', 'difference request changed concurrently');
            if (updated.reason === 'not_found') fail('request_not_found', 'difference request was not found');
            fail('invalid_transition', 'difference request cannot be paid from its current state');
        }

        const settled = assertDifferenceRequest(updated.request);
        requireSameTenant(settled, tenantId);
        await tx.writeAudit(auditFor('billing.difference_request.paid', settled, null, null));
        return { request: settled, replayed: false };
    });
}

export interface CancelDifferenceRequestInput {
    readonly tenantId: string;
    readonly requestId: string;
    readonly expectedVersion: number;
    readonly reason: string;
    readonly actorId: string;
    readonly cancelledAt: number;
}

/**
 * Cancel an OPEN request. Expired requests are not cancellable here: docs/19
 * does not settle that consequence, so it stays HELD instead of guessed.
 */
export async function cancelDifferenceRequest(
    store: CollectionStore,
    input: CancelDifferenceRequestInput,
): Promise<DifferenceRequest> {
    if (typeof store?.runAtomic !== 'function') fail('validation', 'store must expose runAtomic');
    const tenantId = requireBoundedString(input.tenantId, 'tenantId', MAX_TENANT_LENGTH, 'invalid_tenant');
    const requestId = requireBoundedString(input.requestId, 'requestId', MAX_REQUEST_ID_LENGTH);
    const expectedVersion = requireSafeVersion(input.expectedVersion, 'expectedVersion');
    const reason = requireBoundedString(input.reason, 'reason', MAX_REASON_LENGTH);
    const actorId = requireBoundedString(input.actorId, 'actorId', MAX_ACTOR_ID_LENGTH);
    requireSafeSecond(input.cancelledAt, 'cancelledAt');

    return store.runAtomic(async (tx) => {
        const request = checkedRequest(await tx.findByIdForUpdate(tenantId, requestId), tenantId);
        if (request === null) fail('request_not_found', 'difference request was not found');
        if (request.status !== 'open') {
            fail('invalid_transition', 'only an open difference request can be cancelled');
        }
        const updated = await tx.updateStatusCas({
            tenantId,
            requestId,
            expectedVersion,
            toStatus: 'cancelled',
            paidAt: null,
            settledPaymentId: null,
        });
        if (!updated.ok) {
            if (updated.reason === 'version_conflict') fail('version_conflict', 'difference request changed concurrently');
            if (updated.reason === 'not_found') fail('request_not_found', 'difference request was not found');
            fail('invalid_transition', 'difference request cannot be cancelled from its current state');
        }
        const cancelled = assertDifferenceRequest(updated.request);
        requireSameTenant(cancelled, tenantId);
        await tx.writeAudit(auditFor('billing.difference_request.cancelled', cancelled, reason, actorId));
        return cancelled;
    });
}

export interface ReopenExpiredRequestInput {
    readonly tenantId: string;
    readonly requestId: string;
    readonly requestKey: string;
    readonly issuedAt: number;
    readonly deadlineAt: number;
    readonly reason: string;
    readonly authorizedBy: string;
}

/**
 * HELD POLICY — FAIL CLOSED. Authorized correction of an expired request is
 * refused before the first mutation (only a tenant-scoped locking read runs): docs/19 settles the 96-hour grace
 * only for the ISSUE of a difference request and does not define an extension,
 * supersession or replacement contract, nor who may authorize a second
 * collectible obligation for the same debt. Creating a replacement while the
 * expired original remains payable by `applyVerifiedPayment` could collect the
 * same debt twice, so this path refuses with a typed `policy_held` error. The
 * signature/export stays so callers keep compiling.
 */
export async function reopenExpiredRequest(
    store: CollectionStore,
    input: ReopenExpiredRequestInput,
): Promise<IssueDifferenceRequestResult> {
    if (typeof store?.runAtomic !== 'function') fail('validation', 'store must expose runAtomic');
    const tenantId = requireBoundedString(input.tenantId, 'tenantId', MAX_TENANT_LENGTH, 'invalid_tenant');
    const requestId = requireBoundedString(input.requestId, 'requestId', MAX_REQUEST_ID_LENGTH);
    requireBoundedString(input.requestKey, 'requestKey', MAX_REQUEST_KEY_LENGTH, 'invalid_idempotency_key');
    requireSafeSecond(input.issuedAt, 'issuedAt');
    requireSafeSecond(input.deadlineAt, 'deadlineAt');
    requireBoundedString(input.reason, 'reason', MAX_REASON_LENGTH);
    requireBoundedString(input.authorizedBy, 'authorizedBy', MAX_ACTOR_ID_LENGTH);

    // Read-only pre-check preserves the tenant/status contracts; the refusal
    // below happens BEFORE the first mutation, so nothing is written.
    return store.runAtomic(async (tx) => {
        const original = checkedRequest(await tx.findByIdForUpdate(tenantId, requestId), tenantId);
        if (original === null) fail('request_not_found', 'difference request was not found');
        if (original.status !== 'expired') {
            fail('not_expired', 'only an expired difference request can be reopened by an authorized correction');
        }

        fail(
            'policy_held',
            'reopening an expired difference request is HELD: no atomic collectible-obligation/supersession contract or authority exists; the expired request remains the single collectible obligation',
        );
    });
}

/**
 * Pure expiry evaluation. The grace window is `[issuedAt, deadlineAt)`, so
 * `now === deadlineAt` is already `expired` and `now === deadlineAt - 1` is
 * still `open`. Terminal statuses are returned unchanged; nothing is mutated.
 */
export function evaluateExpiry(request: unknown, now: unknown): DifferenceRequestStatus {
    const parsed = assertDifferenceRequest(request);
    const instant = requireSafeSecond(now, 'now');
    if (parsed.status !== 'open') return parsed.status;
    return instant >= parsed.deadlineAt ? 'expired' : 'open';
}

export interface ExpirySweepPlan {
    readonly toExpire: readonly DifferenceRequest[];
    readonly truncated: boolean;
}

/**
 * Pure bounded selection for an expiry sweep. `truncated` means more expired
 * rows exist than the supplied limit and another bounded batch is required.
 */
export function planExpirySweep(
    requests: readonly DifferenceRequest[],
    now: unknown,
    limit: unknown = DEFAULT_LIST_LIMIT,
): ExpirySweepPlan {
    const boundedLimit = requireListLimit(limit);
    const instant = requireSafeSecond(now, 'now');
    if (!Array.isArray(requests)) fail('validation', 'requests must be an array');
    const expired: DifferenceRequest[] = [];
    for (const request of requests) {
        if (evaluateExpiry(request, instant) === 'expired') expired.push(request);
    }
    return Object.freeze({
        toExpire: Object.freeze(expired.slice(0, boundedLimit)),
        truncated: expired.length > boundedLimit,
    });
}

export interface SweepExpiredRequestsInput {
    readonly tenantId: string;
    readonly now: number;
    readonly limit?: number;
}

export interface SweepExpiredRequestsResult {
    readonly expired: readonly DifferenceRequest[];
    readonly scanned: number;
    readonly truncated: boolean;
    readonly skippedConcurrentTransitions: number;
}

/**
 * Persist expiry for one bounded batch, all in one transaction. Concurrent
 * settlement/cancellation wins: its CAS is skipped and reported, never
 * overwritten. A store/audit failure rolls the whole batch back.
 */
export async function sweepExpiredRequests(
    store: CollectionStore,
    input: SweepExpiredRequestsInput,
): Promise<SweepExpiredRequestsResult> {
    if (typeof store?.runAtomic !== 'function') fail('validation', 'store must expose runAtomic');
    const tenantId = requireBoundedString(input.tenantId, 'tenantId', MAX_TENANT_LENGTH, 'invalid_tenant');
    const now = requireSafeSecond(input.now, 'now');
    const limit = requireListLimit(input.limit);

    return store.runAtomic(async (tx) => {
        const page = await tx.listOpenForTenant(tenantId, { limit });
        const plan = planExpirySweep(page.requests, now, limit);
        const expired: DifferenceRequest[] = [];
        let skipped = 0;

        for (const request of plan.toExpire) {
            const checked = assertDifferenceRequest(request);
            requireSameTenant(checked, tenantId);
            const updated = await tx.updateStatusCas({
                tenantId,
                requestId: checked.requestId,
                expectedVersion: checked.version,
                toStatus: 'expired',
                paidAt: null,
                settledPaymentId: null,
            });
            if (!updated.ok) {
                if (updated.reason === 'version_conflict'
                    || updated.reason === 'not_found'
                    || updated.reason === 'invalid_transition') {
                    skipped += 1;
                    continue;
                }
                fail('store_inconsistent', 'an expiry CAS failed for an unknown reason');
            }
            const expiredRequest = assertDifferenceRequest(updated.request);
            requireSameTenant(expiredRequest, tenantId);
            await tx.writeAudit(auditFor('billing.difference_request.expired', expiredRequest, null, null));
            expired.push(expiredRequest);
        }

        return Object.freeze({
            expired: Object.freeze(expired),
            scanned: page.requests.length,
            truncated: page.truncated || plan.truncated,
            skippedConcurrentTransitions: skipped,
        });
    });
}

export interface SubscriptionDebt {
    readonly source: 'difference_request' | 'cycle_invoice';
    readonly referenceId: string;
    readonly tenantId: string;
    readonly currency: string;
    readonly outstandingMinor: bigint;
    readonly status: DebtStatus;
}

export interface WithdrawalPriorityInput {
    readonly tenantId: string;
    readonly currency: string;
    readonly requestedAmountMinor: unknown;
    readonly merchantAvailableMinor: unknown;
    readonly debts: readonly SubscriptionDebt[];
    readonly existingReservations: readonly ReservationRecord[];
    readonly now: number;
}

export interface WithdrawalPriorityDecision {
    readonly allowed: boolean;
    readonly reason: 'allowed' | 'subscription_debt_due' | 'insufficient_available';
    readonly blockingDebtIds: readonly string[];
    readonly requestedAmountMinor: bigint;
    readonly availableMinor: bigint;
    readonly existingReservationsPreserved: true;
}

function assertDebt(item: unknown, tenantId: string, currency: string): SubscriptionDebt {
    if (!isRecord(item)) fail('validation', 'each debt must be an object');
    const source = item['source'];
    if (source !== 'difference_request' && source !== 'cycle_invoice') {
        fail('validation', 'debt source must be difference_request or cycle_invoice');
    }
    const debtTenant = requireBoundedString(item['tenantId'], 'debt.tenantId', MAX_TENANT_LENGTH, 'invalid_tenant');
    if (debtTenant !== tenantId) fail('tenant_mismatch', 'a debt belongs to another tenant');
    const debtCurrency = requireCurrency(item['currency']);
    if (debtCurrency !== currency) fail('currency_mismatch', 'a debt uses another currency');
    return Object.freeze({
        source,
        referenceId: requireBoundedString(item['referenceId'], 'debt.referenceId', MAX_ID_LENGTH),
        tenantId: debtTenant,
        currency: debtCurrency,
        outstandingMinor: requireNonNegativeAmount(item['outstandingMinor'], 'debt.outstandingMinor'),
        status: requireDebtStatus(item['status']),
    });
}

function assertOwnedReservation(
    item: unknown,
    tenantId: string,
    currency: string | null,
): ReservationRecord {
    if (!isRecord(item)) fail('validation', 'each existing reservation must be an object');
    const reservationTenant = requireBoundedString(
        item['tenantId'],
        'reservation.tenantId',
        MAX_TENANT_LENGTH,
        'invalid_tenant',
    );
    if (reservationTenant !== tenantId) fail('tenant_mismatch', 'a reservation belongs to another tenant');
    const reservationCurrency = requireCurrency(item['currency']);
    if (currency !== null && reservationCurrency !== currency) {
        fail('currency_mismatch', 'a reservation uses another currency');
    }
    const status = item['status'];
    if (typeof status !== 'string' || !(RESERVATION_STATUSES as readonly string[]).includes(status)) {
        fail('validation', 'a reservation has an unknown status');
    }
    const amountMinor = item['amountMinor'];
    if (typeof amountMinor !== 'bigint' || amountMinor < 0n) {
        fail('invalid_amount', 'a reservation amount must be a non-negative bigint of minor units');
    }
    return item as unknown as ReservationRecord;
}

/**
 * Priority decision for a NEW withdrawal reservation.
 *
 * docs/19 line 74 and line 103: at due time the subscription is reserved
 * before a new withdrawal is approved, and a new withdrawal waits until every
 * due receivable is processed. Therefore any due subscription debt refuses a
 * new reservation. Existing reservations are only inspected (tenant/currency
 * validated) and are never cancelled, reused or mutated by this function.
 */
export function decideWithdrawalPriority(input: WithdrawalPriorityInput): WithdrawalPriorityDecision {
    const tenantId = requireBoundedString(input.tenantId, 'tenantId', MAX_TENANT_LENGTH, 'invalid_tenant');
    const currency = requireCurrency(input.currency);
    const requestedAmountMinor = requirePositiveAmount(input.requestedAmountMinor, 'requestedAmountMinor');
    const availableMinor = requireNonNegativeAmount(input.merchantAvailableMinor, 'merchantAvailableMinor');
    requireSafeSecond(input.now, 'now');
    if (!Array.isArray(input.debts)) fail('validation', 'debts must be an array');
    if (!Array.isArray(input.existingReservations)) fail('validation', 'existingReservations must be an array');

    const debts = input.debts.map((item) => assertDebt(item, tenantId, currency));
    for (const reservation of input.existingReservations) {
        assertOwnedReservation(reservation, tenantId, currency);
    }

    const dueDebts = debts.filter((debt) => debt.status === 'due' && debt.outstandingMinor > 0n);
    if (dueDebts.length > 0) {
        return Object.freeze({
            allowed: false,
            reason: 'subscription_debt_due',
            blockingDebtIds: Object.freeze(dueDebts.map((debt) => debt.referenceId)),
            requestedAmountMinor,
            availableMinor,
            existingReservationsPreserved: true,
        });
    }

    if (requestedAmountMinor > availableMinor) {
        return Object.freeze({
            allowed: false,
            reason: 'insufficient_available',
            blockingDebtIds: Object.freeze([]),
            requestedAmountMinor,
            availableMinor,
            existingReservationsPreserved: true,
        });
    }

    return Object.freeze({
        allowed: true,
        reason: 'allowed',
        blockingDebtIds: Object.freeze([]),
        requestedAmountMinor,
        availableMinor,
        existingReservationsPreserved: true,
    });
}

export interface PaidStudentPeriod {
    readonly periodId: string;
    readonly tenantId: string;
    readonly status: PeriodProtectionStatus;
    readonly start: number;
    readonly end: number;
}

export interface UnpaidProtectionInput {
    readonly tenantId: string;
    readonly unpaidAfterGrace: boolean;
    readonly now: number;
    readonly paidStudentPeriods: readonly PaidStudentPeriod[];
    readonly existingWithdrawalReservations: readonly ReservationRecord[];
}

export interface UnpaidProtectionDecision {
    readonly unpaidAfterGrace: boolean;
    readonly restrictNewStudentAcceptance: boolean;
    readonly restrictStudentRenewals: boolean;
    readonly restrictNewContentPublishing: boolean;
    readonly protectedStudentPeriodIds: readonly string[];
    readonly protectedStudentPeriods: readonly PaidStudentPeriod[];
    readonly protectedWithdrawalReservationIds: readonly string[];
    readonly protectedWithdrawalReservations: readonly ReservationRecord[];
    readonly allowDebtPayment: true;
    readonly allowDataExport: true;
    readonly allowSupport: true;
    readonly deleteContentOrData: false;
    readonly blanketDisable: false;
}

function assertPaidStudentPeriod(item: unknown, tenantId: string, now: number): PaidStudentPeriod {
    if (!isRecord(item)) fail('validation', 'each student period must be an object');
    const periodTenant = requireBoundedString(
        item['tenantId'],
        'period.tenantId',
        MAX_TENANT_LENGTH,
        'invalid_tenant',
    );
    if (periodTenant !== tenantId) fail('tenant_mismatch', 'a student period belongs to another tenant');
    const start = requireSafeSecond(item['start'], 'period.start');
    const end = requireSafeSecond(item['end'], 'period.end');
    if (end < start) fail('validation', 'a student period end must not be before its start');
    if (now > MAX_SAFE_SECONDS) fail('validation', 'now exceeds the safe integer second range');
    return Object.freeze({
        periodId: requireBoundedString(item['periodId'], 'period.periodId', MAX_ID_LENGTH),
        tenantId: periodTenant,
        status: requirePeriodStatus(item['status']),
        start,
        end,
    });
}

/**
 * Protection after the grace. Only the consequences settled by docs/19 line 76
 * are expressed: stop NEW student acceptance, student renewals and NEW content
 * publishing; keep every already-paid period (including a future one) and
 * every existing withdrawal reservation; keep debt payment, export and support
 * available; never delete content or data. There is no blanket disable.
 */
export function computeUnpaidProtection(input: UnpaidProtectionInput): UnpaidProtectionDecision {
    const tenantId = requireBoundedString(input.tenantId, 'tenantId', MAX_TENANT_LENGTH, 'invalid_tenant');
    const now = requireSafeSecond(input.now, 'now');
    if (typeof input.unpaidAfterGrace !== 'boolean') {
        fail('validation', 'unpaidAfterGrace must be a boolean');
    }
    if (!Array.isArray(input.paidStudentPeriods)) fail('validation', 'paidStudentPeriods must be an array');
    if (!Array.isArray(input.existingWithdrawalReservations)) {
        fail('validation', 'existingWithdrawalReservations must be an array');
    }

    const periods = input.paidStudentPeriods.map((item) => assertPaidStudentPeriod(item, tenantId, now));
    const protectedPeriods = periods.filter((period) => (
        (period.status === 'paid' || period.status === 'confirmed') && period.end > now
    ));

    const reservations: ReservationRecord[] = [];
    for (const reservation of input.existingWithdrawalReservations) {
        const owned = assertOwnedReservation(reservation, tenantId, null);
        if (owned.status === 'reserved') reservations.push(owned);
    }

    return Object.freeze({
        unpaidAfterGrace: input.unpaidAfterGrace,
        restrictNewStudentAcceptance: input.unpaidAfterGrace,
        restrictStudentRenewals: input.unpaidAfterGrace,
        restrictNewContentPublishing: input.unpaidAfterGrace,
        protectedStudentPeriodIds: Object.freeze(protectedPeriods.map((period) => period.periodId)),
        protectedStudentPeriods: Object.freeze(protectedPeriods),
        protectedWithdrawalReservationIds: Object.freeze(reservations.map((reservation) => reservation.id)),
        protectedWithdrawalReservations: Object.freeze(reservations),
        allowDebtPayment: true,
        allowDataExport: true,
        allowSupport: true,
        deleteContentOrData: false,
        blanketDisable: false,
    });
}

/** Serialize exact non-negative minor units as a decimal string (never a JS number). */
export function serializeAmountMinor(value: unknown): string {
    if (typeof value !== 'bigint') fail('invalid_amount', 'amount must be a bigint of minor units');
    if (value < 0n) fail('invalid_amount', 'amount must not be negative');
    return value.toString();
}

export interface SerializedDifferenceRequest {
    readonly modelVersion: number;
    readonly requestId: string;
    readonly tenantId: string;
    readonly orgKind: BillingOrganization;
    readonly invoiceId: string;
    readonly cycleStart: number;
    readonly differenceBasis: string;
    readonly basisKey: string | null;
    readonly amountMinor: string;
    readonly currency: string;
    readonly issuedAt: number;
    readonly deadlineAt: number;
    readonly status: DifferenceRequestStatus;
    readonly version: number;
    readonly requestKey: string;
    readonly payloadHash: string;
    readonly paidAt: number | null;
    readonly settledPaymentId: string | null;
    readonly correctionOfRequestId: string | null;
    readonly correctionReason: string | null;
    readonly correctedByActorId: string | null;
}

/** Wire-safe view: exact `bigint` money becomes a decimal string, no precision loss. */
export function serializeDifferenceRequest(input: unknown): SerializedDifferenceRequest {
    const request = assertDifferenceRequest(input);
    return Object.freeze({
        modelVersion: request.modelVersion,
        requestId: request.requestId,
        tenantId: request.tenantId,
        orgKind: request.orgKind,
        invoiceId: request.invoiceId,
        cycleStart: request.cycleStart,
        differenceBasis: request.differenceBasis,
        basisKey: request.basisKey,
        amountMinor: request.amountMinor.toString(),
        currency: request.currency,
        issuedAt: request.issuedAt,
        deadlineAt: request.deadlineAt,
        status: request.status,
        version: request.version,
        requestKey: request.requestKey,
        payloadHash: request.payloadHash,
        paidAt: request.paidAt,
        settledPaymentId: request.settledPaymentId,
        correctionOfRequestId: request.correctionOfRequestId,
        correctionReason: request.correctionReason,
        correctedByActorId: request.correctedByActorId,
    });
}
