/**
 * FIN10 / X7 — vendor-neutral refund and dispute domains.
 *
 * PURE domain module: no SQL, no database driver, no network, no provider SDK,
 * no routes and no migrations. Persistence is the injected `RefundStore` /
 * `DisputeStore`; the in-memory stores live in
 * `server/tests/billing-refunds.test.ts` and are NOT SQL evidence.
 *
 * Refunds (docs/19 lines 80-84, 90, 103, 107):
 *  - the collector decides the request; acceptance is not completion;
 *  - the amount is verified against `merchant_available` and reserved through
 *    the accepted FIN3 domain BEFORE any provider step;
 *  - completion consumes the reservation exactly once as an append-only
 *    compensating journal linked to the canonical original payment reference;
 *    the original journal/record is never edited. Before consumption the locked
 *    refund snapshot and the destination authority are re-checked and the
 *    counter account must be an authorized `platform_cash` account;
 *  - failure/cancellation releases the reservation exactly once (idempotent);
 *  - the sum of live refunds for one original reference can never exceed the
 *    original amount (`bigint` exact arithmetic);
 *  - the only accepted funding source is `merchant_available`. Non-withdrawable
 *    subscription credit and physical cash are structurally excluded.
 *
 * Disputes are modelled SEPARATELY from ordinary refunds/cancellations:
 *  - lifecycle only: opened -> evidence -> won | lost -> closed, with a version
 *    CAS, idempotent transitions and a tenant predicate;
 *  - docs/19 line 84 and line 105 leave chargeback responsibility, reserve and
 *    bank decisions to a contract, so this domain records the case and HOLDS
 *    every financial consequence. It calls no ledger operation by construction.
 *
 * HELD (reported, never guessed):
 *  - refund eligibility windows beyond docs/19: an ordinary refund is for a
 *    future period that has not started and was not used; any exception is an
 *    audited decision. This domain does not invent a window or eligibility rule;
 *  - provider fees/tax/return method (docs/19 line 84);
 *  - chargeback holds/debits/reserve (docs/19 lines 84, 105);
 *  - re-evaluating access after a refund belongs to the access/enrollment
 *    domain, not here;
 *  - original-payment proof (R2/R8) is the paid `student_tuition` order plus its
 *    COMPLETED merchant-liability settlement obligation (journal + net), the
 *    payer, and the remainder = net minus the locking sum of prior refunds.
 *    `subscription_difference` is never merchant-refundable and no alias is
 *    invented. A known but ineligible original is `original_ineligible`, an
 *    unsettled one is `awaiting_funding`, an unprovable one is
 *    `original_funding_unavailable`; none is `original_not_found`.
 *
 * Money is exact `bigint` minor units, bounded, serialized as a decimal string
 * (HK2). Versions are safe integers. No floating point.
 */

import { createHash, randomUUID } from 'node:crypto';
import {
    MAX_AMOUNT_MINOR as LEDGER_MAX_AMOUNT_MINOR,
    type JournalRecord,
} from './billing-ledger';
import { ReservationError, type ReservationTransaction } from './billing-reservations';
import {
    MAX_EVIDENCE_REFERENCE_LENGTH,
    readProviderOutcomeVerdict,
    type DestinationAuthority,
    type DestinationAuthorityRequest,
    type LedgerPort,
    type ProviderClaimedOutcome,
    type ProviderOutcomeVerdict,
    type ProviderOutcomeVerifier,
    type VerifiedProviderOutcome,
} from './billing-payouts';

/* =========================================================================
 * Constants and errors
 * ========================================================================= */

export const REFUND_STATUSES = [
    'requested',
    'funded',
    'processing',
    'completed',
    'failed',
    'cancelled',
] as const;
export type RefundStatus = (typeof REFUND_STATUSES)[number];

export const REFUND_ACTIONS = ['request', 'fund', 'process', 'complete', 'fail', 'cancel'] as const;
export type RefundAction = (typeof REFUND_ACTIONS)[number];

export const REFUND_FUNDING_SOURCES = ['merchant_available'] as const;
export type RefundFundingSource = (typeof REFUND_FUNDING_SOURCES)[number];

export const TERMINAL_REFUND_STATUSES: readonly RefundStatus[] = Object.freeze([
    'completed',
    'failed',
    'cancelled',
]);

export const DISPUTE_STATUSES = ['opened', 'evidence', 'won', 'lost', 'closed'] as const;
export type DisputeStatus = (typeof DISPUTE_STATUSES)[number];

export const MAX_REFUND_AMOUNT_MINOR = LEDGER_MAX_AMOUNT_MINOR;
export const MAX_TENANT_LENGTH = 36;
export const MAX_REFUND_ID_LENGTH = 64;
export const MAX_ORIGINAL_REFERENCE_LENGTH = 128;
export const MAX_DISPUTE_ID_LENGTH = 64;
export const MAX_IDEMPOTENCY_KEY_LENGTH = 128;
export const MAX_ACTOR_LENGTH = 128;
export const MAX_REASON_LENGTH = 500;
export const MAX_ACCOUNT_ID_LENGTH = 36;
export const MAX_LIST_LIMIT = 1_000;
export const DEFAULT_LIST_LIMIT = 200;

/**
 * docs/19 lines 84 and 105 do not settle a chargeback hold/debit/reserve; the
 * provider/bank decision and the contract govern it. Disputes therefore record
 * the case only and hold the money consequence.
 */
export const DISPUTE_FINANCIAL_CONSEQUENCE = 'held' as const;
export const DISPUTE_FINANCIAL_CONSEQUENCE_BASIS =
    'docs/19 lines 84 and 105: chargeback responsibility/reserve and bank decisions require a contract; no financial consequence is settled';

const CURRENCY_PATTERN = /^[A-Z]{3}$/;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/;
const EVIDENCE_REFERENCE_PATTERN = /^[A-Za-z0-9._:/-]+$/;

export type RefundErrorCode =
    | 'invalid_input'
    | 'invalid_tenant'
    | 'invalid_refund_id'
    | 'invalid_reference'
    | 'invalid_currency'
    | 'invalid_amount'
    | 'amount_out_of_range'
    | 'invalid_idempotency_key'
    | 'invalid_status'
    | 'invalid_transition'
    | 'invalid_version'
    | 'invalid_timestamp'
    | 'invalid_reason'
    | 'invalid_actor'
    | 'invalid_funding_source'
    | 'refund_not_found'
    | 'dispute_not_found'
    | 'refund_exists'
    | 'original_not_found'
    | 'original_ineligible'
    | 'awaiting_funding'
    | 'original_funding_unavailable'
    | 'original_snapshot_mismatch'
    | 'refund_exceeds_remainder'
    | 'destination_denied'
    | 'destination_unavailable'
    | 'counter_account_mismatch'
    | 'idempotency_conflict'
    | 'version_conflict'
    | 'account_not_found'
    | 'account_kind_mismatch'
    | 'tenant_mismatch'
    | 'currency_mismatch'
    | 'insufficient_available'
    | 'reservation_not_found'
    | 'reservation_state_invalid'
    | 'already_consumed'
    | 'provider_outcome_unverified'
    | 'store_inconsistent';

export class RefundError extends Error {
    constructor(
        public readonly code: RefundErrorCode,
        message: string,
    ) {
        super(message);
        this.name = 'RefundError';
    }
}

function fail(code: RefundErrorCode, message: string): never {
    throw new RefundError(code, message);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireBoundedString(
    value: unknown,
    field: string,
    maxLength: number,
    code: RefundErrorCode = 'invalid_input',
): string {
    if (typeof value !== 'string') fail(code, `${field} must be a string`);
    const text = value.trim();
    if (text.length === 0 || text.length > maxLength || text !== value) {
        fail(code, `${field} must be a non-empty trimmed string of at most ${maxLength} characters`);
    }
    return text;
}

function optionalBoundedString(
    value: unknown,
    field: string,
    maxLength: number,
    code: RefundErrorCode = 'invalid_input',
): string | null {
    if (value === undefined || value === null) return null;
    if (typeof value !== 'string') fail(code, `${field} must be a string or null`);
    const text = value.trim();
    if (text.length > maxLength) fail(code, `${field} must be at most ${maxLength} characters`);
    return text === '' ? null : text;
}

function requireCurrency(value: unknown): string {
    if (typeof value !== 'string' || !CURRENCY_PATTERN.test(value)) {
        fail('invalid_currency', 'currency must be a three-letter uppercase ISO-4217 code');
    }
    return value;
}

function requirePositiveAmount(value: unknown, field = 'amountMinor'): bigint {
    if (typeof value !== 'bigint') fail('invalid_amount', `${field} must be a bigint of minor units`);
    if (value <= 0n) fail('invalid_amount', `${field} must be positive`);
    if (value > MAX_REFUND_AMOUNT_MINOR) {
        fail('amount_out_of_range', `${field} exceeds ${MAX_REFUND_AMOUNT_MINOR.toString()}`);
    }
    return value;
}

function requireSafeInteger(value: unknown, field: string): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
        fail('invalid_version', `${field} must be a non-negative safe integer`);
    }
    return value;
}

function normalizeCreatedAt(value: unknown): string {
    if (value === undefined) return new Date().toISOString();
    if (typeof value !== 'string' || value.trim() === '' || Number.isNaN(Date.parse(value))) {
        fail('invalid_timestamp', 'createdAt must be a parseable timestamp string');
    }
    return value;
}

function requireRefundStatus(value: unknown): RefundStatus {
    if (typeof value !== 'string' || !(REFUND_STATUSES as readonly string[]).includes(value)) {
        fail('invalid_status', 'unknown refund status');
    }
    return value as RefundStatus;
}

function requireFundingSource(value: unknown): RefundFundingSource {
    if (value !== 'merchant_available') {
        fail('invalid_funding_source', 'refunds may only be funded from merchant_available');
    }
    return value;
}

function requireNonNegativeBigInt(value: unknown, field: string): bigint {
    if (typeof value !== 'bigint' || value < 0n) {
        fail('store_inconsistent', `${field} must be a non-negative bigint of minor units`);
    }
    return value;
}

export function serializeRefundAmountMinor(value: bigint): string {
    if (typeof value !== 'bigint') fail('invalid_amount', 'amount must be a bigint of minor units');
    return value.toString();
}

/* =========================================================================
 * Refund state machine
 * ========================================================================= */

const LEGAL_REFUND_TRANSITIONS: Readonly<Record<RefundStatus, readonly RefundStatus[]>> = Object.freeze({
    requested: ['funded', 'cancelled'],
    funded: ['processing', 'failed', 'cancelled'],
    processing: ['completed', 'failed', 'cancelled'],
    completed: [],
    failed: [],
    cancelled: [],
});

export interface RefundTransitionDecision {
    readonly allowed: boolean;
    readonly idempotent: boolean;
    readonly reason: 'unknown-status' | 'illegal-transition' | null;
}

export function evaluateRefundTransition(from: unknown, to: unknown): RefundTransitionDecision {
    let fromStatus: RefundStatus;
    let toStatus: RefundStatus;
    try {
        fromStatus = requireRefundStatus(from);
        toStatus = requireRefundStatus(to);
    } catch {
        return { allowed: false, idempotent: false, reason: 'unknown-status' };
    }
    if (fromStatus === toStatus) return { allowed: true, idempotent: true, reason: null };
    return LEGAL_REFUND_TRANSITIONS[fromStatus].includes(toStatus)
        ? { allowed: true, idempotent: false, reason: null }
        : { allowed: false, idempotent: false, reason: 'illegal-transition' };
}

export function isTerminalRefundStatus(status: RefundStatus): boolean {
    return TERMINAL_REFUND_STATUSES.includes(status);
}

/* =========================================================================
 * Refund rows
 * ========================================================================= */

export interface RefundableOriginal {
    readonly tenantId: string;
    readonly originalReference: string;
    readonly currency: string;
    /** Net merchant liability (completed obligation `net_minor`), not gross. */
    readonly originalAmountMinor: bigint;
    /** Canonical payer reference proved by the locked payment row. */
    readonly payerReference?: string | null;
    /** Completed merchant-liability obligation that proved the payment. */
    readonly settlementObligationId?: string | null;
}

/**
 * A payment the adapter KNOWS exists but that is not refundable (not paid, or a
 * purpose outside the frozen merchant-refundable allow-list). It is deliberately
 * distinct from `null` (not found) so the domain can fail with
 * `original_ineligible` instead of misreporting a known payment as missing.
 *
 * PENDING EXTENSION (settlement contract): a full refundable-original proof also
 * needs the merchant-liability journal/allocation, the original payer and the
 * remaining amount from the settlement schema. That contract is not published
 * yet, so this type carries only a bounded reason and the adapter continues to
 * rely on the paid checkout order as the canonical payment row.
 */
export interface IneligibleOriginal {
    readonly ineligible: true;
    readonly reason: string;
}

/**
 * A paid merchant payment whose settlement obligation is not completed yet.
 * This is a known payment with no proved net merchant liability; it must be
 * reported as `awaiting_funding`, never as `original_not_found`.
 */
export interface AwaitingFundingOriginal {
    readonly awaitingFunding: true;
    readonly reason: string;
}

/**
 * The payment is known but its completed-settlement proof cannot be read
 * (missing source, inconsistent row). This is `original_funding_unavailable`,
 * never `original_not_found`.
 */
export interface UnavailableOriginal {
    readonly unavailable: true;
    readonly reason: string;
}

export type OriginalLookup =
    | RefundableOriginal
    | IneligibleOriginal
    | AwaitingFundingOriginal
    | UnavailableOriginal;

export function isIneligibleOriginal(value: OriginalLookup): value is IneligibleOriginal {
    return 'ineligible' in value && value.ineligible === true;
}

export function isAwaitingFundingOriginal(value: OriginalLookup): value is AwaitingFundingOriginal {
    return 'awaitingFunding' in value && value.awaitingFunding === true;
}

export function isUnavailableOriginal(value: OriginalLookup): value is UnavailableOriginal {
    return 'unavailable' in value && value.unavailable === true;
}

export interface RefundRequest {
    readonly refundId: string;
    readonly tenantId: string;
    /** Opaque order/payment identity; never a card/PAN. */
    readonly originalReference: string;
    /** Full refundable amount of the original payment, copied for exact checks. */
    readonly originalAmountMinor: bigint;
    readonly amountMinor: bigint;
    readonly currency: string;
    readonly fundingSourceKind: RefundFundingSource;
    readonly status: RefundStatus;
    readonly reservationId: string | null;
    readonly version: number;
    readonly idempotencyKey: string;
    readonly payloadHash: string;
    readonly requestedBy: string | null;
    readonly providerReference: string | null;
    readonly failureReason: string | null;
    readonly cancellationReason: string | null;
    readonly createdAt: string;
    readonly updatedAt: string;
}

export interface RefundTransitionRecord {
    readonly id: string;
    readonly tenantId: string;
    readonly refundId: string;
    readonly action: RefundAction;
    readonly idempotencyKey: string;
    readonly payloadHash: string;
    readonly fromStatus: RefundStatus;
    readonly toStatus: RefundStatus;
    readonly versionAfter: number;
    readonly reservationId: string | null;
    readonly journalId: string | null;
    readonly actorId: string | null;
    readonly reason: string | null;
    readonly createdAt: string;
}

export interface RefundPage {
    readonly refunds: readonly RefundRequest[];
    readonly truncated: boolean;
}

/* =========================================================================
 * Refund store contract
 * ========================================================================= */

/**
 * SQL obligations behind this interface (not implemented here):
 *  - `refund_requests` has UNIQUE (tenant_id, refund_id) and
 *    UNIQUE (tenant_id, idempotency_key); every query carries a tenant
 *    predicate. `findRefundForUpdate` locks the row (`SELECT ... FOR UPDATE`).
 *  - `findOriginalForUpdate` locks the original payment row so the remainder
 *    check and the reservation are serialized against another refund.
 *  - `sumRefundAmountsForOriginal` sums the live refund amounts
 *    (requested/funded/processing/completed) with exact BIGINT arithmetic and
 *    never `Number`. It is read on the same transaction as the original lock.
 *  - `updateStatusCas` is a conditional write on
 *    (tenant_id, refund_id, version, status) incrementing version by one.
 *  - `refund_transitions` is append-only with UNIQUE (tenant_id, idempotency_key)
 *    and a payload hash (HK1).
 *  - amount/remainder columns are BIGINT read with `BigInt()`; version is a
 *    safe integer; currency is CHAR(3).
 *  - the sealed audit row is written on the SAME connection/transaction; an
 *    audit failure rolls everything back.
 *  - `listRefunds` is tenant-scoped, bounded and reports truncation.
 */
export const REFUND_STORE_SQL_CONTRACT: readonly string[] = Object.freeze([
    'refund_requests: UNIQUE (tenant_id, refund_id); every query carries a tenant predicate.',
    'refund_requests: UNIQUE (tenant_id, idempotency_key) with payload_hash implements HK1.',
    'findRefundForUpdate and findOriginalForUpdate use SELECT ... FOR UPDATE on the same transaction/connection.',
    'sumRefundAmountsForOriginal sums live refunds with exact BIGINT arithmetic and never Number.',
    'updateStatusCas is a conditional write on (tenant_id, refund_id, version, status) incrementing version by one.',
    'refund_transitions: append-only, UNIQUE (tenant_id, idempotency_key), payload_hash conflict detection.',
    'amount columns are BIGINT minor units; version is a safe integer; currency is CHAR(3).',
    'the sealed audit row for each mutation is written on the SAME connection/transaction; an audit failure rolls everything back.',
    'findOriginalForUpdate returns a typed ineligible result for a known non-refundable payment, distinct from null (not found); the canonical stored originalReference of a found row is used for persistence and every sum.',
    'complete re-checks the locked refund snapshot and the injected destination authority before consumption; the authorized counter account must be an existing platform_cash account of the same tenant/currency.',
    'listRefunds is tenant-scoped, bounded and reports truncation explicitly.',
]);

export interface UpdateRefundStatusCasInput {
    readonly tenantId: string;
    readonly refundId: string;
    readonly expectedVersion: number;
    readonly fromStatus: RefundStatus;
    readonly toStatus: RefundStatus;
    readonly reservationId: string | null;
    readonly providerReference: string | null;
    readonly failureReason: string | null;
    readonly cancellationReason: string | null;
    readonly updatedAt: string;
}

export type UpdateRefundStatusCasResult =
    | { readonly ok: true; readonly refund: RefundRequest }
    | { readonly ok: false; readonly reason: 'not_found' | 'version_conflict' | 'invalid_transition' };

export type InsertRefundResult = 'inserted' | 'duplicate_key';

export interface RefundTransaction extends ReservationTransaction {
    findByIdempotencyKey(tenantId: string, idempotencyKey: string): Promise<RefundRequest | null>;
    findRefundForUpdate(tenantId: string, refundId: string): Promise<RefundRequest | null>;
    /**
     * OPTIONAL plain NON-LOCKING read of one refund (no FOR UPDATE), used to
     * learn the status BEFORE the locking transaction so the external provider
     * verifier is never called while the refund row is locked. Absent => a
     * processing-refund release fails closed as `provider_outcome_unverified`.
     */
    findRefundSnapshot?(tenantId: string, refundId: string): Promise<RefundRequest | null>;
    insertRefund(refund: RefundRequest): Promise<InsertRefundResult>;
    updateStatusCas(input: UpdateRefundStatusCasInput): Promise<UpdateRefundStatusCasResult>;
    findTransitionByIdempotencyKey(
        tenantId: string,
        idempotencyKey: string,
    ): Promise<RefundTransitionRecord | null>;
    insertTransition(record: RefundTransitionRecord): Promise<'inserted' | 'duplicate_key'>;
    /**
     * Lock the canonical original payment. `null` is genuinely not found; a
     * known-but-ineligible payment returns `IneligibleOriginal`. The canonical
     * `originalReference` of a found row must be used for persistence and sums.
     */
    findOriginalForUpdate(tenantId: string, originalReference: string): Promise<OriginalLookup | null>;
    sumRefundAmountsForOriginal(
        tenantId: string,
        originalReference: string,
        currency: string,
    ): Promise<bigint>;
    listRefunds(
        tenantId: string,
        query?: { readonly limit?: number; readonly status?: RefundStatus },
    ): Promise<RefundPage>;
    writeAudit(record: RefundAuditRecord): Promise<void>;
}

export interface RefundStore<Tx extends RefundTransaction = RefundTransaction> {
    runAtomic<T>(callback: (tx: Tx) => Promise<T>): Promise<T>;
}

/* =========================================================================
 * Refund audit
 * ========================================================================= */

export type RefundAuditAction =
    | 'billing.refund.requested'
    | 'billing.refund.funded'
    | 'billing.refund.processing'
    | 'billing.refund.completed'
    | 'billing.refund.failed'
    | 'billing.refund.cancelled';

export interface RefundAuditRecord {
    readonly action: RefundAuditAction;
    readonly tenantId: string;
    readonly refundId: string;
    readonly status: RefundStatus;
    readonly version: number;
    readonly amountMinor: string;
    readonly currency: string;
    readonly originalReference: string;
    readonly reservationId: string | null;
    readonly journalId: string | null;
    readonly actorId: string | null;
    readonly reason: string | null;
    /**
     * Present only for a release out of `processing`: the provider verdict and
     * the opaque (bounded, non-secret) evidence reference that authorised it.
     */
    readonly providerVerdict?: ProviderOutcomeVerdict;
    readonly evidenceReference?: string | null;
    /** Success only: attested opaque provider account and success reference. */
    readonly providerAccountRef?: string | null;
    readonly successReference?: string | null;
}

export interface RefundProviderEvidence {
    readonly providerVerdict: ProviderOutcomeVerdict;
    readonly evidenceReference: string | null;
    readonly providerAccountRef?: string | null;
    readonly successReference?: string | null;
}

const REFUND_AUDIT_ACTION_BY_STATUS: Readonly<Record<RefundStatus, RefundAuditAction>> = Object.freeze({
    requested: 'billing.refund.requested',
    funded: 'billing.refund.funded',
    processing: 'billing.refund.processing',
    completed: 'billing.refund.completed',
    failed: 'billing.refund.failed',
    cancelled: 'billing.refund.cancelled',
});

function refundAuditFor(
    refund: RefundRequest,
    journalId: string | null,
    actorId: string | null,
    reason: string | null,
    evidence?: RefundProviderEvidence,
): RefundAuditRecord {
    return Object.freeze({
        ...(evidence === undefined
            ? {}
            : {
                providerVerdict: evidence.providerVerdict,
                evidenceReference: evidence.evidenceReference,
                ...(evidence.successReference === undefined
                    ? {}
                    : {
                        providerAccountRef: evidence.providerAccountRef ?? null,
                        successReference: evidence.successReference,
                    }),
            }),
        action: REFUND_AUDIT_ACTION_BY_STATUS[refund.status],
        tenantId: refund.tenantId,
        refundId: refund.refundId,
        status: refund.status,
        version: refund.version,
        amountMinor: refund.amountMinor.toString(),
        currency: refund.currency,
        originalReference: refund.originalReference,
        reservationId: refund.reservationId,
        journalId,
        actorId,
        reason,
    });
}

/* =========================================================================
 * Hashing (HK1)
 * ========================================================================= */

function hashRefundRequest(input: {
    tenantId: string;
    originalReference: string;
    amountMinor: bigint;
    currency: string;
    fundingSourceKind: RefundFundingSource;
    requestedBy: string | null;
}): string {
    return createHash('sha256')
        .update(JSON.stringify({
            scope: 'refund_request',
            tenantId: input.tenantId,
            originalReference: input.originalReference,
            amountMinor: input.amountMinor.toString(),
            currency: input.currency,
            fundingSourceKind: input.fundingSourceKind,
            requestedBy: input.requestedBy,
        }))
        .digest('hex');
}

function hashRefundTransition(input: {
    tenantId: string;
    refundId: string;
    action: RefundAction;
    toStatus: RefundStatus;
    extra: string;
}): string {
    return createHash('sha256')
        .update(JSON.stringify({
            scope: 'refund_transition',
            tenantId: input.tenantId,
            refundId: input.refundId,
            action: input.action,
            toStatus: input.toStatus,
            extra: input.extra,
        }))
        .digest('hex');
}

/* =========================================================================
 * Read validation
 * ========================================================================= */

function requireSameTenant(refund: RefundRequest, tenantId: string): void {
    if (refund.tenantId !== tenantId) {
        fail('tenant_mismatch', 'the store returned a refund outside the requested tenant');
    }
}

function checkedRefund(value: RefundRequest | null, tenantId: string): RefundRequest | null {
    if (value === null) return null;
    requireSameTenant(value, tenantId);
    if (typeof value.amountMinor !== 'bigint' || value.amountMinor <= 0n) {
        fail('invalid_amount', 'the store returned a refund with an invalid amount');
    }
    if (!Number.isSafeInteger(value.version) || value.version < 1) {
        fail('invalid_version', 'the store returned a refund with an invalid version');
    }
    requireRefundStatus(value.status);
    return value;
}

function requireRefund(value: RefundRequest | null, tenantId: string): RefundRequest {
    const refund = checkedRefund(value, tenantId);
    if (refund === null) fail('refund_not_found', 'refund was not found');
    return refund;
}

function mapReservationError(error: unknown): unknown {
    if (error instanceof ReservationError) {
        if (error.code === 'insufficient_available') {
            return new RefundError('insufficient_available', error.message);
        }
        if (error.code === 'already_consumed') {
            return new RefundError('already_consumed', error.message);
        }
        if (error.code === 'reservation_not_reserved' || error.code === 'reservation_state_invalid') {
            return new RefundError('reservation_state_invalid', error.message);
        }
        if (error.code === 'reservation_not_found') {
            return new RefundError('reservation_not_found', error.message);
        }
        if (error.code === 'version_conflict') {
            return new RefundError('version_conflict', error.message);
        }
    }
    return error;
}

function refundReservationKey(refundId: string): string {
    const key = `refund:${refundId}`;
    if (key.length > 100) fail('invalid_refund_id', 'derived reservation key exceeds 100 characters');
    return key;
}

function refundReservationReference(refundId: string, originalReference: string): string {
    const reference = `refund:${refundId}:original:${originalReference}`;
    if (reference.length > 200) fail('invalid_reference', 'derived refund reference exceeds 200 characters');
    return reference;
}

/**
 * Recompute the sealed request hash from the locked row before completion so a
 * mutated snapshot (amount/currency/purpose/destination) cannot be consumed.
 */
function verifyRefundSnapshot(refund: RefundRequest): void {
    const recomputed = hashRefundRequest({
        tenantId: refund.tenantId,
        originalReference: refund.originalReference,
        amountMinor: refund.amountMinor,
        currency: refund.currency,
        fundingSourceKind: refund.fundingSourceKind,
        requestedBy: refund.requestedBy,
    });
    if (recomputed !== refund.payloadHash) {
        fail(
            'original_snapshot_mismatch',
            'the locked refund original/amount snapshot does not match its sealed request hash',
        );
    }
}

/**
 * Resolve the locked original payment and return ONLY its canonical identity.
 * A known ineligible payment is not "not found"; a case/accent variant is a
 * collision and fails closed.
 */
async function requireRefundableOriginal<Tx extends RefundTransaction>(
    tx: Tx,
    tenantId: string,
    originalReference: string,
    currency: string,
): Promise<RefundableOriginal> {
    const lookup = await tx.findOriginalForUpdate(tenantId, originalReference);
    if (lookup === null) fail('original_not_found', 'the original payment reference was not found');
    if (isIneligibleOriginal(lookup)) {
        fail('original_ineligible', lookup.reason);
    }
    if (isAwaitingFundingOriginal(lookup)) {
        fail('awaiting_funding', lookup.reason);
    }
    if (isUnavailableOriginal(lookup)) {
        fail('original_funding_unavailable', lookup.reason);
    }
    if (lookup.tenantId !== tenantId) fail('tenant_mismatch', 'the original payment is foreign');
    if (lookup.currency !== currency) {
        fail('currency_mismatch', 'the original payment uses another currency');
    }
    const canonical = requireBoundedString(
        lookup.originalReference,
        'originalReference',
        MAX_ORIGINAL_REFERENCE_LENGTH,
        'store_inconsistent',
    );
    if (canonical !== originalReference) {
        fail(
            'original_snapshot_mismatch',
            'the caller original reference is a case/accent variant of the canonical stored payment',
        );
    }
    requirePositiveAmount(lookup.originalAmountMinor, 'originalAmountMinor');
    return { ...lookup, originalReference: canonical };
}

/**
 * The counter account must be authorized by the injected port; a caller value
 * alone is never authority. An absent port/decision is `destination_unavailable`.
 */
async function requireAuthorizedRefundCounterAccount(
    authority: DestinationAuthority | undefined,
    request: DestinationAuthorityRequest,
): Promise<string> {
    if (typeof authority?.authorizeDestination !== 'function') {
        fail('destination_unavailable', 'no destination authority port is available for refund completion');
    }
    const presented = requireBoundedString(
        request.counterAccountId,
        'counterAccountId',
        MAX_ACCOUNT_ID_LENGTH,
        'invalid_input',
    );
    const decision: unknown = await authority.authorizeDestination(request);
    if (!isRecord(decision) || decision['allowed'] !== true) {
        fail('destination_denied', 'the injected destination authority did not allow this destination');
    }
    const authorized = decision['counterAccountId'];
    if (typeof authorized !== 'string' || authorized.trim() === '') {
        fail('destination_unavailable', 'the destination authority did not authorize a counter account');
    }
    const authorizedId = requireBoundedString(
        authorized,
        'authorizedCounterAccountId',
        MAX_ACCOUNT_ID_LENGTH,
        'invalid_input',
    );
    if (authorizedId !== presented) {
        fail('counter_account_mismatch', 'the caller counter account is not the authorized counter account');
    }
    return authorizedId;
}

/** Merchant refunds may only consume reserved liability into platform cash. */
function requirePlatformCashCounterAccount(
    account: { readonly tenantId: string; readonly kind: string; readonly currency: string } | null,
    tenantId: string,
    currency: string,
): void {
    if (account === null) fail('account_not_found', 'platform cash counter account was not found');
    if (account.tenantId !== tenantId) fail('tenant_mismatch', 'platform cash counter account is foreign');
    if (account.kind !== 'platform_cash') {
        fail(
            'account_kind_mismatch',
            'merchant refund consumption may only credit platform_cash; platform_receivable is for subscription debt settlement',
        );
    }
    if (account.currency !== currency) {
        fail('currency_mismatch', 'platform cash counter account uses another currency');
    }
}

/* =========================================================================
 * Refund dependencies and transitions
 * ========================================================================= */

export interface RefundDeps<Tx extends RefundTransaction = RefundTransaction> {
    readonly store: RefundStore<Tx>;
    readonly ledger: LedgerPort<Tx>;
    /**
     * Optional destination-authorization port, shared with the payout domain.
     * Completion requires it to re-authorize the original destination and the
     * platform counter account; when it is absent the result is
     * `destination_unavailable`, never approved.
     */
    readonly destinationAuthority?: DestinationAuthority;
    /**
     * Optional provider-outcome port (R5). Releasing funds from a `processing`
     * refund requires it to answer a definite failure/cancellation; absent or
     * any other answer is `provider_outcome_unverified` and nothing is released.
     */
    readonly providerOutcomeVerifier?: ProviderOutcomeVerifier;
}

function assertRefundDeps<Tx extends RefundTransaction>(deps: RefundDeps<Tx>): void {
    if (typeof deps?.store?.runAtomic !== 'function') fail('invalid_input', 'store must expose runAtomic');
    if (typeof deps?.ledger?.reserve !== 'function' || typeof deps?.ledger?.release !== 'function') {
        fail('invalid_input', 'the accepted ledger port is required');
    }
}

export interface RefundTransitionResult {
    readonly refund: RefundRequest;
    readonly transition: RefundTransitionRecord;
    readonly replayed: boolean;
}

interface RefundEffect {
    readonly reservationId: string | null;
    readonly journalId: string | null;
    readonly providerReference: string | null;
    readonly failureReason: string | null;
    readonly cancellationReason: string | null;
    /** Verdict + evidence reference to record in the single audit write. */
    readonly providerEvidence?: RefundProviderEvidence;
}

interface RefundTransitionOptions<Tx extends RefundTransaction> {
    readonly tenantId: string;
    readonly refundId: string;
    readonly idempotencyKey: string;
    readonly action: RefundAction;
    readonly toStatus: RefundStatus;
    readonly expectedVersion?: number;
    readonly actorId?: string | null;
    readonly reason?: string | null;
    readonly payloadExtra: string;
    readonly createdAt?: string;
    readonly effect: (tx: Tx, refund: RefundRequest) => Promise<RefundEffect>;
}

async function applyRefundTransition<Tx extends RefundTransaction>(
    deps: RefundDeps<Tx>,
    options: RefundTransitionOptions<Tx>,
): Promise<RefundTransitionResult> {
    assertRefundDeps(deps);
    const tenantId = requireBoundedString(options.tenantId, 'tenantId', MAX_TENANT_LENGTH, 'invalid_tenant');
    const refundId = requireBoundedString(options.refundId, 'refundId', MAX_REFUND_ID_LENGTH, 'invalid_refund_id');
    const idempotencyKey = requireBoundedString(
        options.idempotencyKey,
        'idempotencyKey',
        MAX_IDEMPOTENCY_KEY_LENGTH,
        'invalid_idempotency_key',
    );
    const toStatus = requireRefundStatus(options.toStatus);
    const actorId = optionalBoundedString(options.actorId, 'actorId', MAX_ACTOR_LENGTH, 'invalid_actor');
    const reason = optionalBoundedString(options.reason, 'reason', MAX_REASON_LENGTH, 'invalid_reason');
    const createdAt = normalizeCreatedAt(options.createdAt);
    const expectedVersion = options.expectedVersion === undefined
        ? undefined
        : requireSafeInteger(options.expectedVersion, 'expectedVersion');
    const transitionHash = hashRefundTransition({
        tenantId,
        refundId,
        action: options.action,
        toStatus,
        extra: options.payloadExtra,
    });

    return deps.store.runAtomic(async (tx) => {
        const existing = await tx.findTransitionByIdempotencyKey(tenantId, idempotencyKey);
        if (existing !== null) {
            if (existing.tenantId !== tenantId) fail('tenant_mismatch', 'transition belongs to another tenant');
            if (existing.payloadHash !== transitionHash) {
                fail('idempotency_conflict', 'refund transition key was reused with a different payload');
            }
            const refund = requireRefund(await tx.findRefundForUpdate(tenantId, refundId), tenantId);
            return { refund, transition: existing, replayed: true };
        }

        const refund = requireRefund(await tx.findRefundForUpdate(tenantId, refundId), tenantId);
        if (expectedVersion !== undefined && refund.version !== expectedVersion) {
            fail('version_conflict', 'refund version does not match the expected version');
        }

        const decision = evaluateRefundTransition(refund.status, toStatus);
        if (!decision.allowed) {
            fail('invalid_transition', `refund cannot move from ${refund.status} to ${toStatus}`);
        }

        if (decision.idempotent) {
            const noop = refundTransitionRecord({
                refund,
                action: options.action,
                idempotencyKey,
                payloadHash: transitionHash,
                fromStatus: refund.status,
                toStatus,
                versionAfter: refund.version,
                reservationId: refund.reservationId,
                journalId: null,
                actorId,
                reason,
                createdAt,
            });
            const insertedNoop = await tx.insertTransition(noop);
            if (insertedNoop === 'duplicate_key') {
                fail('store_inconsistent', 'refund transition key was created concurrently');
            }
            await tx.writeAudit(refundAuditFor(refund, null, actorId, reason));
            return { refund, transition: noop, replayed: true };
        }

        let effect: RefundEffect;
        try {
            effect = await options.effect(tx, refund);
        } catch (error) {
            throw mapReservationError(error);
        }

        const updated = await tx.updateStatusCas({
            tenantId,
            refundId,
            expectedVersion: refund.version,
            fromStatus: refund.status,
            toStatus,
            reservationId: effect.reservationId ?? refund.reservationId,
            providerReference: effect.providerReference ?? refund.providerReference,
            failureReason: effect.failureReason ?? refund.failureReason,
            cancellationReason: effect.cancellationReason ?? refund.cancellationReason,
            updatedAt: createdAt,
        });
        if (!updated.ok) {
            if (updated.reason === 'not_found') fail('refund_not_found', 'refund was not found');
            if (updated.reason === 'version_conflict') {
                fail('version_conflict', 'refund changed concurrently');
            }
            fail('invalid_transition', 'refund cannot move from its current state');
        }

        const transition = refundTransitionRecord({
            refund: updated.refund,
            action: options.action,
            idempotencyKey,
            payloadHash: transitionHash,
            fromStatus: refund.status,
            toStatus,
            versionAfter: updated.refund.version,
            reservationId: updated.refund.reservationId,
            journalId: effect.journalId,
            actorId,
            reason,
            createdAt,
        });
        const inserted = await tx.insertTransition(transition);
        if (inserted === 'duplicate_key') {
            fail('store_inconsistent', 'refund transition key was created concurrently');
        }

        await tx.writeAudit(refundAuditFor(updated.refund, effect.journalId, actorId, reason, effect.providerEvidence));
        return { refund: updated.refund, transition, replayed: false };
    });
}

function refundTransitionRecord(input: {
    refund: RefundRequest;
    action: RefundAction;
    idempotencyKey: string;
    payloadHash: string;
    fromStatus: RefundStatus;
    toStatus: RefundStatus;
    versionAfter: number;
    reservationId: string | null;
    journalId: string | null;
    actorId: string | null;
    reason: string | null;
    createdAt: string;
}): RefundTransitionRecord {
    return Object.freeze({
        id: randomUUID(),
        tenantId: input.refund.tenantId,
        refundId: input.refund.refundId,
        action: input.action,
        idempotencyKey: input.idempotencyKey,
        payloadHash: input.payloadHash,
        fromStatus: input.fromStatus,
        toStatus: input.toStatus,
        versionAfter: input.versionAfter,
        reservationId: input.reservationId,
        journalId: input.journalId,
        actorId: input.actorId,
        reason: input.reason,
        createdAt: input.createdAt,
    });
}

/* =========================================================================
 * Refund request / funding
 * ========================================================================= */

export interface RequestRefundInput {
    readonly tenantId: string;
    readonly originalReference: string;
    readonly amountMinor: unknown;
    readonly currency: string;
    readonly fundingSourceKind: RefundFundingSource;
    readonly idempotencyKey: string;
    readonly requestedBy?: string | null;
    readonly createdAt?: string;
}

export interface RequestRefundResult {
    readonly refund: RefundRequest;
    readonly replayed: boolean;
}

/**
 * Record a refund request. No money moves here; the remainder is checked with
 * exact BigInt arithmetic against the locked original payment.
 */
export async function requestRefund<Tx extends RefundTransaction>(
    deps: RefundDeps<Tx>,
    input: RequestRefundInput,
): Promise<RequestRefundResult> {
    assertRefundDeps(deps);
    const tenantId = requireBoundedString(input.tenantId, 'tenantId', MAX_TENANT_LENGTH, 'invalid_tenant');
    const originalReference = requireBoundedString(
        input.originalReference,
        'originalReference',
        MAX_ORIGINAL_REFERENCE_LENGTH,
        'invalid_reference',
    );
    const amountMinor = requirePositiveAmount(input.amountMinor);
    const currency = requireCurrency(input.currency);
    const fundingSourceKind = requireFundingSource(input.fundingSourceKind);
    const idempotencyKey = requireBoundedString(
        input.idempotencyKey,
        'idempotencyKey',
        MAX_IDEMPOTENCY_KEY_LENGTH,
        'invalid_idempotency_key',
    );
    const requestedBy = optionalBoundedString(input.requestedBy, 'requestedBy', MAX_ACTOR_LENGTH, 'invalid_actor');
    const createdAt = normalizeCreatedAt(input.createdAt);
    const payloadHash = hashRefundRequest({
        tenantId,
        originalReference,
        amountMinor,
        currency,
        fundingSourceKind,
        requestedBy,
    });

    return deps.store.runAtomic(async (tx) => {
        const existing = checkedRefund(await tx.findByIdempotencyKey(tenantId, idempotencyKey), tenantId);
        if (existing !== null) {
            if (existing.payloadHash !== payloadHash) {
                fail('idempotency_conflict', 'refund idempotency key was reused with a different payload');
            }
            return { refund: existing, replayed: true };
        }

        const original = await requireRefundableOriginal(tx, tenantId, originalReference, currency);
        // Canonical stored identity ONLY: every sum/persist/replay comparison is
        // anchored to the locked original row, never the caller spelling.
        const canonicalReference = original.originalReference;
        const originalAmountMinor = original.originalAmountMinor;

        const committed = requireNonNegativeBigInt(
            await tx.sumRefundAmountsForOriginal(tenantId, canonicalReference, currency),
            'committed refunds',
        );
        const remainder = originalAmountMinor - committed;
        if (amountMinor > remainder) {
            fail(
                'refund_exceeds_remainder',
                `refund ${amountMinor.toString()} exceeds the refundable remainder ${remainder.toString()}`,
            );
        }

        const refund: RefundRequest = Object.freeze({
            refundId: randomUUID(),
            tenantId,
            originalReference: canonicalReference,
            originalAmountMinor,
            amountMinor,
            currency,
            fundingSourceKind,
            status: 'requested' as const,
            reservationId: null,
            version: 1,
            idempotencyKey,
            payloadHash,
            requestedBy,
            providerReference: null,
            failureReason: null,
            cancellationReason: null,
            createdAt,
            updatedAt: createdAt,
        });

        const inserted = await tx.insertRefund(refund);
        if (inserted === 'duplicate_key') {
            const raced = checkedRefund(await tx.findByIdempotencyKey(tenantId, idempotencyKey), tenantId);
            if (raced !== null) {
                if (raced.payloadHash !== payloadHash) {
                    fail('idempotency_conflict', 'refund idempotency key was reused with a different payload');
                }
                if (raced.originalReference !== canonicalReference) {
                    fail(
                        'original_snapshot_mismatch',
                        'the replayed refund is anchored to a different original payment identity',
                    );
                }
                return { refund: raced, replayed: true };
            }
            fail('store_inconsistent', 'insert reported a duplicate that cannot be read inside the transaction');
        }

        await tx.writeAudit(refundAuditFor(refund, null, requestedBy, null));
        return { refund, replayed: false };
    });
}

export interface FundRefundInput {
    readonly tenantId: string;
    readonly refundId: string;
    readonly idempotencyKey: string;
    readonly availableAccountId: string;
    readonly reservedAccountId: string;
    readonly expectedVersion?: number;
    readonly actorId?: string | null;
    readonly createdAt?: string;
}

/**
 * Verify and reserve the refund amount from merchant_available BEFORE any
 * provider step. The accepted reservation domain enforces available kind,
 * currency and tenancy.
 */
export function fundRefund<Tx extends RefundTransaction>(
    deps: RefundDeps<Tx>,
    input: FundRefundInput,
): Promise<RefundTransitionResult> {
    const tenantId = requireBoundedString(input.tenantId, 'tenantId', MAX_TENANT_LENGTH, 'invalid_tenant');
    const availableAccountId = requireBoundedString(
        input.availableAccountId,
        'availableAccountId',
        MAX_ACCOUNT_ID_LENGTH,
        'invalid_input',
    );
    const reservedAccountId = requireBoundedString(
        input.reservedAccountId,
        'reservedAccountId',
        MAX_ACCOUNT_ID_LENGTH,
        'invalid_input',
    );
    const createdAt = normalizeCreatedAt(input.createdAt);

    return applyRefundTransition(deps, {
        tenantId,
        refundId: input.refundId,
        idempotencyKey: input.idempotencyKey,
        action: 'fund',
        toStatus: 'funded',
        expectedVersion: input.expectedVersion,
        actorId: input.actorId,
        payloadExtra: `${availableAccountId}\u0000${reservedAccountId}`,
        createdAt,
        effect: async (tx, refund) => {
            const original = await requireRefundableOriginal(
                tx,
                tenantId,
                refund.originalReference,
                refund.currency,
            );
            const canonicalReference = original.originalReference;
            if (canonicalReference !== refund.originalReference) {
                fail('original_snapshot_mismatch', 'the refund row is not anchored to the canonical original payment');
            }
            const committed = requireNonNegativeBigInt(
                await tx.sumRefundAmountsForOriginal(tenantId, canonicalReference, refund.currency),
                'committed refunds',
            );
            if (committed < refund.amountMinor) {
                fail('store_inconsistent', 'the committed refund total is below this refund amount');
            }
            const remainderOtherwise = original.originalAmountMinor - (committed - refund.amountMinor);
            if (refund.amountMinor > remainderOtherwise) {
                fail('refund_exceeds_remainder', 'this refund no longer fits in the original remainder');
            }

            const reserved = await deps.ledger.reserve(tx, {
                tenantId,
                reservationKey: refundReservationKey(refund.refundId),
                currency: refund.currency,
                amountMinor: refund.amountMinor,
                availableAccountId,
                reservedAccountId,
                reference: refundReservationReference(refund.refundId, canonicalReference),
                description: 'refund reservation',
                createdAt,
            });
            return {
                reservationId: reserved.reservation.id,
                journalId: reserved.journal.id,
                providerReference: null,
                failureReason: null,
                cancellationReason: null,
            };
        },
    });
}

/* =========================================================================
 * Refund processing / completion / failure / cancellation
 * ========================================================================= */

export interface StartRefundProcessingInput {
    readonly tenantId: string;
    readonly refundId: string;
    readonly idempotencyKey: string;
    readonly expectedVersion?: number;
    readonly actorId?: string | null;
    readonly createdAt?: string;
}

/** Record that the external refund step started. No provider call is made. */
export function startRefundProcessing<Tx extends RefundTransaction>(
    deps: RefundDeps<Tx>,
    input: StartRefundProcessingInput,
): Promise<RefundTransitionResult> {
    return applyRefundTransition(deps, {
        tenantId: input.tenantId,
        refundId: input.refundId,
        idempotencyKey: input.idempotencyKey,
        action: 'process',
        toStatus: 'processing',
        expectedVersion: input.expectedVersion,
        actorId: input.actorId,
        payloadExtra: '',
        createdAt: input.createdAt,
        effect: async () => ({
            reservationId: null,
            journalId: null,
            providerReference: null,
            failureReason: null,
            cancellationReason: null,
        }),
    });
}

export interface CompleteRefundInput {
    readonly tenantId: string;
    readonly refundId: string;
    readonly idempotencyKey: string;
    readonly counterAccountId: string;
    /**
     * Caller-presented provider reference. It is NOT evidence: when present it
     * must equal the success reference attested by the injected verifier.
     */
    readonly providerReference?: string | null;
    /** Opaque reference handed to the verifier; never a free-form reason. */
    readonly evidenceReference?: string | null;
    readonly expectedVersion?: number;
    readonly actorId?: string | null;
    readonly createdAt?: string;
}

interface RefundPreflightInput {
    readonly tenantId: unknown;
    readonly refundId: unknown;
    readonly idempotencyKey: unknown;
    readonly actorId?: unknown;
    readonly reason?: unknown;
    readonly expectedVersion?: unknown;
    readonly evidenceReference?: unknown;
}

/**
 * Validate EVERY input before any store call or external call, so a malformed
 * request can never reach the snapshot read or the verifier. Returns the
 * normalized opaque evidence reference.
 */
function preflightRefundInput(input: RefundPreflightInput): string | null {
    requireBoundedString(input.tenantId, 'tenantId', MAX_TENANT_LENGTH, 'invalid_tenant');
    requireBoundedString(input.refundId, 'refundId', MAX_REFUND_ID_LENGTH, 'invalid_refund_id');
    requireBoundedString(
        input.idempotencyKey,
        'idempotencyKey',
        MAX_IDEMPOTENCY_KEY_LENGTH,
        'invalid_idempotency_key',
    );
    optionalBoundedString(input.actorId, 'actorId', MAX_ACTOR_LENGTH, 'invalid_actor');
    optionalBoundedString(input.reason, 'reason', MAX_REASON_LENGTH, 'invalid_reason');
    if (input.expectedVersion !== undefined) requireSafeInteger(input.expectedVersion, 'expectedVersion');
    const evidenceReference = optionalBoundedString(
        input.evidenceReference,
        'evidenceReference',
        MAX_EVIDENCE_REFERENCE_LENGTH,
        'invalid_input',
    );
    // Conservative opaque-token charset; control characters are rejected.
    if (
        (typeof input.evidenceReference === 'string' && CONTROL_CHARACTERS.test(input.evidenceReference))
        || (evidenceReference !== null && !EVIDENCE_REFERENCE_PATTERN.test(evidenceReference))
    ) {
        fail('invalid_input', 'evidenceReference may contain only letters, digits and . _ : / -');
    }
    return evidenceReference;
}

interface RefundPreOutcome {
    /** Non-locking snapshot the verifier answer is bound to. */
    readonly snapshot: RefundRequest;
    readonly outcome: VerifiedProviderOutcome;
}

/**
 * EXTERNAL CALL OUTSIDE THE TRANSACTION: a plain non-locking snapshot read
 * tells whether the refund is processing; only then the injected verifier is
 * consulted, BEFORE the locking transaction opens. No verifier call is made
 * for any non-processing refund or a stale expected version.
 */
async function verifyProcessingRefundOutcome<Tx extends RefundTransaction>(
    deps: RefundDeps<Tx>,
    input: { readonly tenantId: string; readonly refundId: string; readonly expectedVersion?: number },
    claimedOutcome: ProviderClaimedOutcome,
    evidenceReference: string | null,
    callerProviderReference: string | null,
): Promise<RefundPreOutcome | null> {
    if (typeof deps?.store?.runAtomic !== 'function') return null;
    const snapshot = await deps.store.runAtomic(async (tx) =>
        typeof tx.findRefundSnapshot === 'function'
            ? tx.findRefundSnapshot(input.tenantId, input.refundId)
            : null);
    if (
        snapshot === null
        || snapshot.tenantId !== input.tenantId
        || snapshot.refundId !== input.refundId
        || snapshot.status !== 'processing'
        || (input.expectedVersion !== undefined && snapshot.version !== input.expectedVersion)
    ) {
        return null;
    }
    const outcome = await readProviderOutcomeVerdict(deps.providerOutcomeVerifier, {
        tenantId: snapshot.tenantId,
        requestId: snapshot.refundId,
        kind: 'refund',
        claimedOutcome,
        evidenceReference,
        amountMinor: snapshot.amountMinor,
        currency: snapshot.currency,
        destinationRef: snapshot.originalReference,
        destinationSnapshotHash: snapshot.payloadHash,
        requestVersion: snapshot.version,
        callerProviderReference,
    });
    return { snapshot, outcome };
}

/**
 * Inside the transaction: the locked row must be exactly what the verifier
 * attested (same request, version, amount, currency, destination snapshot) and
 * the attested verdict must be the definite one for this transition.
 */
function requireAttestedRefundOutcome(
    pre: RefundPreOutcome | null,
    refund: RefundRequest,
    verdict: ProviderOutcomeVerdict,
    what: string,
): VerifiedProviderOutcome {
    if (
        pre === null
        || pre.outcome.verdict !== verdict
        || pre.snapshot.tenantId !== refund.tenantId
        || pre.snapshot.refundId !== refund.refundId
        || pre.snapshot.version !== refund.version
        || pre.snapshot.amountMinor !== refund.amountMinor
        || pre.snapshot.currency !== refund.currency
        || pre.snapshot.originalReference !== refund.originalReference
        || pre.snapshot.payloadHash !== refund.payloadHash
    ) {
        fail(
            'provider_outcome_unverified',
            `a processing refund requires ${what}, attested by the injected verifier for this exact unchanged request before the transaction; nothing was consumed or released`,
        );
    }
    return pre.outcome;
}

/**
 * Consume the refund reservation exactly once as the compensating journal, but
 * ONLY after the injected verifier attested a definitive provider success bound
 * to this exact request (tenant, refund, provider account, amount, currency,
 * immutable original/destination snapshot and version). Absent, uncertain,
 * unavailable, throwing or non-echoing verifier => typed
 * `provider_outcome_unverified`, no consumption, refund stays `processing`.
 * The original payment journal is never edited. No new debt gate is added to an
 * already reserved refund.
 */
export async function completeRefund<Tx extends RefundTransaction>(
    deps: RefundDeps<Tx>,
    input: CompleteRefundInput,
): Promise<RefundTransitionResult> {
    const counterAccountId = requireBoundedString(
        input.counterAccountId,
        'counterAccountId',
        MAX_ACCOUNT_ID_LENGTH,
        'invalid_input',
    );
    const providerReference = optionalBoundedString(
        input.providerReference,
        'providerReference',
        MAX_ACTOR_LENGTH,
        'invalid_input',
    );
    const createdAt = normalizeCreatedAt(input.createdAt);
    const evidenceReference = preflightRefundInput(input);
    const pre = await verifyProcessingRefundOutcome(
        deps,
        { tenantId: input.tenantId, refundId: input.refundId, expectedVersion: input.expectedVersion },
        'success',
        evidenceReference,
        providerReference,
    );

    return applyRefundTransition(deps, {
        tenantId: input.tenantId,
        refundId: input.refundId,
        idempotencyKey: input.idempotencyKey,
        action: 'complete',
        toStatus: 'completed',
        expectedVersion: input.expectedVersion,
        actorId: input.actorId,
        payloadExtra: `${counterAccountId}\u0000${providerReference ?? ''}`,
        createdAt,
        effect: async (tx, refund) => {
            // Provider success must be attested for this exact unchanged request
            // BEFORE anything is consumed.
            const attested = requireAttestedRefundOutcome(
                pre,
                refund,
                'definite_success',
                'a definitive provider success',
            );
            if (refund.reservationId === null) {
                fail('reservation_not_found', 'refund has no reservation to consume');
            }
            // Re-check the immutable refund snapshot and destination BEFORE any
            // consumption. A caller-selected counter account is never authority.
            verifyRefundSnapshot(refund);
            const authorizedCounterId = await requireAuthorizedRefundCounterAccount(deps.destinationAuthority, {
                tenantId: refund.tenantId,
                payoutId: refund.refundId,
                kind: 'refund',
                destinationRef: refund.originalReference,
                amountMinor: refund.amountMinor,
                currency: refund.currency,
                version: refund.version,
                phase: 'complete',
                counterAccountId,
            });
            requirePlatformCashCounterAccount(
                await tx.getAccount(refund.tenantId, authorizedCounterId),
                refund.tenantId,
                refund.currency,
            );
            const reservation = await tx.getReservation(refund.tenantId, refund.reservationId);
            if (
                reservation === null
                || reservation.tenantId !== refund.tenantId
                || reservation.currency !== refund.currency
                || reservation.amountMinor !== refund.amountMinor
            ) {
                fail('reservation_state_invalid', 'the refund reservation does not match the locked refund snapshot');
            }
            const consumed = await deps.ledger.consume(tx, {
                tenantId: refund.tenantId,
                reservationId: refund.reservationId,
                counterAccountId: authorizedCounterId,
                createdAt,
            });
            return {
                reservationId: refund.reservationId,
                journalId: consumed.journal.id,
                providerReference: attested.successReference,
                failureReason: null,
                cancellationReason: null,
                providerEvidence: {
                    providerVerdict: 'definite_success' as const,
                    evidenceReference,
                    providerAccountRef: attested.providerAccountRef,
                    successReference: attested.successReference,
                },
            };
        },
    });
}

export interface FailRefundInput {
    readonly tenantId: string;
    readonly refundId: string;
    readonly idempotencyKey: string;
    readonly reason?: string | null;
    /**
     * Opaque reference to provider evidence. The reason text is never proof;
     * the injected verifier decides from this reference.
     */
    readonly evidenceReference?: string | null;
    readonly expectedVersion?: number;
    readonly actorId?: string | null;
    readonly createdAt?: string;
}

/**
 * Release a funded hold, or a processing hold only with a definite attested
 * provider failure. Idempotent on replay.
 */
export async function failRefund<Tx extends RefundTransaction>(
    deps: RefundDeps<Tx>,
    input: FailRefundInput,
): Promise<RefundTransitionResult> {
    const createdAt = normalizeCreatedAt(input.createdAt);
    /*
     * EXTERNAL CALL OUTSIDE THE TRANSACTION (see verifyProcessingRefundOutcome).
     * Inside the transaction the locked row is re-read and the attestation is
     * honoured only if it is bound to the exact unchanged request and its
     * verdict is a definite failure.
     */
    const preEvidenceReference = preflightRefundInput(input);
    const pre = await verifyProcessingRefundOutcome(
        deps,
        { tenantId: input.tenantId, refundId: input.refundId, expectedVersion: input.expectedVersion },
        'failed',
        preEvidenceReference,
        null,
    );
    return applyRefundTransition(deps, {
        tenantId: input.tenantId,
        refundId: input.refundId,
        idempotencyKey: input.idempotencyKey,
        action: 'fail',
        toStatus: 'failed',
        expectedVersion: input.expectedVersion,
        actorId: input.actorId,
        reason: input.reason,
        payloadExtra: input.reason ?? '',
        createdAt,
        effect: async (tx, refund) => {
            let providerEvidence: RefundEffect['providerEvidence'];
            if (refund.status === 'processing') {
                requireAttestedRefundOutcome(pre, refund, 'definite_failure', 'a definite provider failure');
                providerEvidence = {
                    providerVerdict: 'definite_failure',
                    evidenceReference: preEvidenceReference,
                };
            }
            if (refund.reservationId === null) {
                return {
                    reservationId: null,
                    journalId: null,
                    providerReference: null,
                    failureReason: optionalBoundedString(input.reason, 'reason', MAX_REASON_LENGTH, 'invalid_reason'),
                    cancellationReason: null,
                    ...(providerEvidence === undefined ? {} : { providerEvidence }),
                };
            }
            const released = await deps.ledger.release(tx, {
                tenantId: refund.tenantId,
                reservationId: refund.reservationId,
                createdAt,
            });
            return {
                reservationId: refund.reservationId,
                journalId: released.journal.id,
                providerReference: null,
                failureReason: optionalBoundedString(input.reason, 'reason', MAX_REASON_LENGTH, 'invalid_reason'),
                cancellationReason: null,
                ...(providerEvidence === undefined ? {} : { providerEvidence }),
            };
        },
    });
}

export interface CancelRefundInput {
    readonly tenantId: string;
    readonly refundId: string;
    readonly idempotencyKey: string;
    readonly reason?: string | null;
    /** Opaque reference handed to the verifier; the reason is never evidence. */
    readonly evidenceReference?: string | null;
    readonly expectedVersion?: number;
    readonly actorId?: string | null;
    readonly createdAt?: string;
}

/**
 * Cancel a requested/funded refund; a funded hold is released exactly once. A
 * `processing` refund may be cancelled only when the injected verifier attests
 * a final non-executed/non-settled provider cancellation bound to this exact
 * request; otherwise it stays `processing` (typed `provider_outcome_unverified`,
 * reconciliation required) and no hold is released.
 */
export async function cancelRefund<Tx extends RefundTransaction>(
    deps: RefundDeps<Tx>,
    input: CancelRefundInput,
): Promise<RefundTransitionResult> {
    const createdAt = normalizeCreatedAt(input.createdAt);
    const evidenceReference = preflightRefundInput(input);
    const pre = await verifyProcessingRefundOutcome(
        deps,
        { tenantId: input.tenantId, refundId: input.refundId, expectedVersion: input.expectedVersion },
        'cancelled',
        evidenceReference,
        null,
    );
    return applyRefundTransition(deps, {
        tenantId: input.tenantId,
        refundId: input.refundId,
        idempotencyKey: input.idempotencyKey,
        action: 'cancel',
        toStatus: 'cancelled',
        expectedVersion: input.expectedVersion,
        actorId: input.actorId,
        reason: input.reason,
        payloadExtra: input.reason ?? '',
        createdAt,
        effect: async (tx, refund) => {
            const cancellationReason = optionalBoundedString(
                input.reason,
                'reason',
                MAX_REASON_LENGTH,
                'invalid_reason',
            );
            let providerEvidence: RefundEffect['providerEvidence'];
            if (refund.status === 'processing') {
                requireAttestedRefundOutcome(
                    pre,
                    refund,
                    'definite_cancellation',
                    'a definitive provider cancellation (final non-executed/non-settled outcome)',
                );
                providerEvidence = { providerVerdict: 'definite_cancellation', evidenceReference };
            }
            if (refund.reservationId === null) {
                return {
                    reservationId: null,
                    journalId: null,
                    providerReference: null,
                    failureReason: null,
                    cancellationReason,
                    ...(providerEvidence === undefined ? {} : { providerEvidence }),
                };
            }
            const released = await deps.ledger.release(tx, {
                tenantId: refund.tenantId,
                reservationId: refund.reservationId,
                createdAt,
            });
            return {
                reservationId: refund.reservationId,
                journalId: released.journal.id,
                providerReference: null,
                failureReason: null,
                cancellationReason,
                ...(providerEvidence === undefined ? {} : { providerEvidence }),
            };
        },
    });
}

/* =========================================================================
 * Refund listing
 * ========================================================================= */

export interface ListRefundsInput {
    readonly tenantId: string;
    readonly limit?: number;
    readonly status?: RefundStatus;
}

export async function listRefunds<Tx extends RefundTransaction>(
    store: RefundStore<Tx>,
    input: ListRefundsInput,
): Promise<RefundPage> {
    if (typeof store?.runAtomic !== 'function') fail('invalid_input', 'store must expose runAtomic');
    const tenantId = requireBoundedString(input.tenantId, 'tenantId', MAX_TENANT_LENGTH, 'invalid_tenant');
    const limit = input.limit === undefined ? DEFAULT_LIST_LIMIT : input.limit;
    if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT) {
        fail('invalid_input', `limit must be a safe integer between 1 and ${MAX_LIST_LIMIT}`);
    }
    const status = input.status === undefined ? undefined : requireRefundStatus(input.status);
    return store.runAtomic((tx) => tx.listRefunds(tenantId, { limit, status }));
}

/* =========================================================================
 * Disputes (separate lifecycle, financial consequence HELD)
 * ========================================================================= */

const LEGAL_DISPUTE_TRANSITIONS: Readonly<Record<DisputeStatus, readonly DisputeStatus[]>> = Object.freeze({
    opened: ['evidence', 'won', 'lost', 'closed'],
    evidence: ['won', 'lost', 'closed'],
    won: ['closed'],
    lost: ['closed'],
    closed: [],
});

export interface DisputeTransitionDecision {
    readonly allowed: boolean;
    readonly idempotent: boolean;
    readonly reason: 'unknown-status' | 'illegal-transition' | null;
}

export function evaluateDisputeTransition(from: unknown, to: unknown): DisputeTransitionDecision {
    const fromStatus = normalizeDisputeStatus(from);
    const toStatus = normalizeDisputeStatus(to);
    if (fromStatus === null || toStatus === null) {
        return { allowed: false, idempotent: false, reason: 'unknown-status' };
    }
    if (fromStatus === toStatus) return { allowed: true, idempotent: true, reason: null };
    return LEGAL_DISPUTE_TRANSITIONS[fromStatus].includes(toStatus)
        ? { allowed: true, idempotent: false, reason: null }
        : { allowed: false, idempotent: false, reason: 'illegal-transition' };
}

function normalizeDisputeStatus(value: unknown): DisputeStatus | null {
    if (typeof value !== 'string' || !(DISPUTE_STATUSES as readonly string[]).includes(value)) return null;
    return value as DisputeStatus;
}

function requireDisputeStatus(value: unknown): DisputeStatus {
    const status = normalizeDisputeStatus(value);
    if (status === null) fail('invalid_status', 'unknown dispute status');
    return status;
}

export interface DisputeCase {
    readonly disputeId: string;
    readonly tenantId: string;
    /** Opaque order/payment/provider reference; never a card/PAN. */
    readonly reference: string;
    readonly amountMinor: bigint;
    readonly currency: string;
    readonly status: DisputeStatus;
    readonly version: number;
    readonly idempotencyKey: string;
    readonly payloadHash: string;
    readonly openedBy: string | null;
    readonly financialConsequence: typeof DISPUTE_FINANCIAL_CONSEQUENCE;
    readonly financialConsequenceBasis: string;
    readonly createdAt: string;
    readonly updatedAt: string;
}

export interface DisputeTransitionRecord {
    readonly id: string;
    readonly tenantId: string;
    readonly disputeId: string;
    readonly action: DisputeStatus | 'open';
    readonly idempotencyKey: string;
    readonly payloadHash: string;
    readonly fromStatus: DisputeStatus | null;
    readonly toStatus: DisputeStatus;
    readonly versionAfter: number;
    readonly actorId: string | null;
    readonly reason: string | null;
    readonly createdAt: string;
}

export interface DisputePage {
    readonly disputes: readonly DisputeCase[];
    readonly truncated: boolean;
}

/**
 * `dispute_cases` has UNIQUE (tenant_id, dispute_id) and
 * UNIQUE (tenant_id, idempotency_key); `findDisputeForUpdate` locks the row;
 * `updateStatusCas` is a conditional write on (tenant_id, dispute_id, version,
 * status); `dispute_transitions` is append-only with a payload hash; the sealed
 * audit row is written on the same connection/transaction. This domain never
 * writes a ledger journal and never moves money.
 */
export const DISPUTE_STORE_SQL_CONTRACT: readonly string[] = Object.freeze([
    'dispute_cases: UNIQUE (tenant_id, dispute_id); every query carries a tenant predicate.',
    'dispute_cases: UNIQUE (tenant_id, idempotency_key) with payload_hash implements HK1.',
    'findDisputeForUpdate uses SELECT ... FOR UPDATE; updateStatusCas is a conditional write on (tenant_id, dispute_id, version, status).',
    'dispute_transitions: append-only, UNIQUE (tenant_id, idempotency_key), payload_hash conflict detection.',
    'amount columns are BIGINT minor units; version is a safe integer; currency is CHAR(3).',
    'the sealed audit row for each mutation is written on the SAME connection/transaction; an audit failure rolls everything back.',
    'this domain writes no ledger journal and no balance; the financial consequence is recorded as HELD.',
    'listDisputes is tenant-scoped, bounded and reports truncation explicitly.',
]);

export interface UpdateDisputeStatusCasInput {
    readonly tenantId: string;
    readonly disputeId: string;
    readonly expectedVersion: number;
    readonly fromStatus: DisputeStatus;
    readonly toStatus: DisputeStatus;
    readonly updatedAt: string;
}

export type UpdateDisputeStatusCasResult =
    | { readonly ok: true; readonly dispute: DisputeCase }
    | { readonly ok: false; readonly reason: 'not_found' | 'version_conflict' | 'invalid_transition' };

export type InsertDisputeResult = 'inserted' | 'duplicate_key';

export type DisputeAuditAction =
    | 'billing.dispute.opened'
    | 'billing.dispute.evidence'
    | 'billing.dispute.won'
    | 'billing.dispute.lost'
    | 'billing.dispute.closed';

export interface DisputeAuditRecord {
    readonly action: DisputeAuditAction;
    readonly tenantId: string;
    readonly disputeId: string;
    readonly status: DisputeStatus;
    readonly version: number;
    readonly amountMinor: string;
    readonly currency: string;
    readonly reference: string;
    readonly financialConsequence: typeof DISPUTE_FINANCIAL_CONSEQUENCE;
    readonly actorId: string | null;
    readonly reason: string | null;
}

const DISPUTE_AUDIT_ACTION_BY_STATUS: Readonly<Record<DisputeStatus, DisputeAuditAction>> = Object.freeze({
    opened: 'billing.dispute.opened',
    evidence: 'billing.dispute.evidence',
    won: 'billing.dispute.won',
    lost: 'billing.dispute.lost',
    closed: 'billing.dispute.closed',
});

function disputeAuditFor(
    dispute: DisputeCase,
    actorId: string | null,
    reason: string | null,
): DisputeAuditRecord {
    return Object.freeze({
        action: DISPUTE_AUDIT_ACTION_BY_STATUS[dispute.status],
        tenantId: dispute.tenantId,
        disputeId: dispute.disputeId,
        status: dispute.status,
        version: dispute.version,
        amountMinor: dispute.amountMinor.toString(),
        currency: dispute.currency,
        reference: dispute.reference,
        financialConsequence: DISPUTE_FINANCIAL_CONSEQUENCE,
        actorId,
        reason,
    });
}

export interface DisputeTransaction {
    findByIdempotencyKey(tenantId: string, idempotencyKey: string): Promise<DisputeCase | null>;
    findDisputeForUpdate(tenantId: string, disputeId: string): Promise<DisputeCase | null>;
    insertDispute(dispute: DisputeCase): Promise<InsertDisputeResult>;
    updateStatusCas(input: UpdateDisputeStatusCasInput): Promise<UpdateDisputeStatusCasResult>;
    findTransitionByIdempotencyKey(
        tenantId: string,
        idempotencyKey: string,
    ): Promise<DisputeTransitionRecord | null>;
    insertTransition(record: DisputeTransitionRecord): Promise<'inserted' | 'duplicate_key'>;
    listDisputes(
        tenantId: string,
        query?: { readonly limit?: number; readonly status?: DisputeStatus },
    ): Promise<DisputePage>;
    writeAudit(record: DisputeAuditRecord): Promise<void>;
}

export interface DisputeStore<Tx extends DisputeTransaction = DisputeTransaction> {
    runAtomic<T>(callback: (tx: Tx) => Promise<T>): Promise<T>;
}

export interface DisputeDeps<Tx extends DisputeTransaction = DisputeTransaction> {
    readonly store: DisputeStore<Tx>;
}

function hashDisputeTransition(input: {
    tenantId: string;
    disputeId: string;
    toStatus: DisputeStatus;
    extra: string;
}): string {
    return createHash('sha256')
        .update(JSON.stringify({
            scope: 'dispute_transition',
            tenantId: input.tenantId,
            disputeId: input.disputeId,
            toStatus: input.toStatus,
            extra: input.extra,
        }))
        .digest('hex');
}

function hashDisputeRequest(input: {
    tenantId: string;
    reference: string;
    amountMinor: bigint;
    currency: string;
    openedBy: string | null;
}): string {
    return createHash('sha256')
        .update(JSON.stringify({
            scope: 'dispute_request',
            tenantId: input.tenantId,
            reference: input.reference,
            amountMinor: input.amountMinor.toString(),
            currency: input.currency,
            openedBy: input.openedBy,
        }))
        .digest('hex');
}

function checkedDispute(value: DisputeCase | null, tenantId: string): DisputeCase | null {
    if (value === null) return null;
    if (value.tenantId !== tenantId) fail('tenant_mismatch', 'the store returned a dispute outside the tenant');
    if (typeof value.amountMinor !== 'bigint' || value.amountMinor <= 0n) {
        fail('invalid_amount', 'the store returned a dispute with an invalid amount');
    }
    if (!Number.isSafeInteger(value.version) || value.version < 1) {
        fail('invalid_version', 'the store returned a dispute with an invalid version');
    }
    requireDisputeStatus(value.status);
    return value;
}

function requireDispute(value: DisputeCase | null, tenantId: string): DisputeCase {
    const dispute = checkedDispute(value, tenantId);
    if (dispute === null) fail('dispute_not_found', 'dispute was not found');
    return dispute;
}

export interface OpenDisputeInput {
    readonly tenantId: string;
    readonly reference: string;
    readonly amountMinor: unknown;
    readonly currency: string;
    readonly idempotencyKey: string;
    readonly openedBy?: string | null;
    readonly createdAt?: string;
}

export interface OpenDisputeResult {
    readonly dispute: DisputeCase;
    readonly replayed: boolean;
}

/** Record a dispute case. No hold, debit or ledger journal is created. */
export async function openDispute<Tx extends DisputeTransaction>(
    deps: DisputeDeps<Tx>,
    input: OpenDisputeInput,
): Promise<OpenDisputeResult> {
    if (typeof deps?.store?.runAtomic !== 'function') fail('invalid_input', 'store must expose runAtomic');
    const tenantId = requireBoundedString(input.tenantId, 'tenantId', MAX_TENANT_LENGTH, 'invalid_tenant');
    const reference = requireBoundedString(
        input.reference,
        'reference',
        MAX_ORIGINAL_REFERENCE_LENGTH,
        'invalid_reference',
    );
    const amountMinor = requirePositiveAmount(input.amountMinor);
    const currency = requireCurrency(input.currency);
    const idempotencyKey = requireBoundedString(
        input.idempotencyKey,
        'idempotencyKey',
        MAX_IDEMPOTENCY_KEY_LENGTH,
        'invalid_idempotency_key',
    );
    const openedBy = optionalBoundedString(input.openedBy, 'openedBy', MAX_ACTOR_LENGTH, 'invalid_actor');
    const createdAt = normalizeCreatedAt(input.createdAt);
    const payloadHash = hashDisputeRequest({ tenantId, reference, amountMinor, currency, openedBy });

    return deps.store.runAtomic(async (tx) => {
        const existing = checkedDispute(await tx.findByIdempotencyKey(tenantId, idempotencyKey), tenantId);
        if (existing !== null) {
            if (existing.payloadHash !== payloadHash) {
                fail('idempotency_conflict', 'dispute idempotency key was reused with a different payload');
            }
            return { dispute: existing, replayed: true };
        }

        const dispute: DisputeCase = Object.freeze({
            disputeId: randomUUID(),
            tenantId,
            reference,
            amountMinor,
            currency,
            status: 'opened' as const,
            version: 1,
            idempotencyKey,
            payloadHash,
            openedBy,
            financialConsequence: DISPUTE_FINANCIAL_CONSEQUENCE,
            financialConsequenceBasis: DISPUTE_FINANCIAL_CONSEQUENCE_BASIS,
            createdAt,
            updatedAt: createdAt,
        });

        const inserted = await tx.insertDispute(dispute);
        if (inserted === 'duplicate_key') {
            const raced = checkedDispute(await tx.findByIdempotencyKey(tenantId, idempotencyKey), tenantId);
            if (raced !== null) {
                if (raced.payloadHash !== payloadHash) {
                    fail('idempotency_conflict', 'dispute idempotency key was reused with a different payload');
                }
                return { dispute: raced, replayed: true };
            }
            fail('store_inconsistent', 'insert reported a duplicate that cannot be read inside the transaction');
        }

        await tx.writeAudit(disputeAuditFor(dispute, openedBy, null));
        return { dispute, replayed: false };
    });
}

export interface DisputeTransitionResult {
    readonly dispute: DisputeCase;
    readonly transition: DisputeTransitionRecord;
    readonly replayed: boolean;
}

interface DisputeTransitionOptions<Tx extends DisputeTransaction> {
    readonly tenantId: string;
    readonly disputeId: string;
    readonly idempotencyKey: string;
    readonly toStatus: DisputeStatus;
    readonly expectedVersion?: number;
    readonly actorId?: string | null;
    readonly reason?: string | null;
    readonly createdAt?: string;
}

async function applyDisputeTransition<Tx extends DisputeTransaction>(
    deps: DisputeDeps<Tx>,
    options: DisputeTransitionOptions<Tx>,
): Promise<DisputeTransitionResult> {
    if (typeof deps?.store?.runAtomic !== 'function') fail('invalid_input', 'store must expose runAtomic');
    const tenantId = requireBoundedString(options.tenantId, 'tenantId', MAX_TENANT_LENGTH, 'invalid_tenant');
    const disputeId = requireBoundedString(options.disputeId, 'disputeId', MAX_DISPUTE_ID_LENGTH, 'invalid_input');
    const idempotencyKey = requireBoundedString(
        options.idempotencyKey,
        'idempotencyKey',
        MAX_IDEMPOTENCY_KEY_LENGTH,
        'invalid_idempotency_key',
    );
    const toStatus = requireDisputeStatus(options.toStatus);
    const actorId = optionalBoundedString(options.actorId, 'actorId', MAX_ACTOR_LENGTH, 'invalid_actor');
    const reason = optionalBoundedString(options.reason, 'reason', MAX_REASON_LENGTH, 'invalid_reason');
    const createdAt = normalizeCreatedAt(options.createdAt);
    const expectedVersion = options.expectedVersion === undefined
        ? undefined
        : requireSafeInteger(options.expectedVersion, 'expectedVersion');
    const transitionHash = hashDisputeTransition({
        tenantId,
        disputeId,
        toStatus,
        extra: reason ?? '',
    });

    return deps.store.runAtomic(async (tx) => {
        const existing = await tx.findTransitionByIdempotencyKey(tenantId, idempotencyKey);
        if (existing !== null) {
            if (existing.tenantId !== tenantId) fail('tenant_mismatch', 'transition belongs to another tenant');
            if (existing.payloadHash !== transitionHash) {
                fail('idempotency_conflict', 'dispute transition key was reused with a different payload');
            }
            const dispute = requireDispute(await tx.findDisputeForUpdate(tenantId, disputeId), tenantId);
            return { dispute, transition: existing, replayed: true };
        }

        const dispute = requireDispute(await tx.findDisputeForUpdate(tenantId, disputeId), tenantId);
        if (expectedVersion !== undefined && dispute.version !== expectedVersion) {
            fail('version_conflict', 'dispute version does not match the expected version');
        }

        const decision = evaluateDisputeTransition(dispute.status, toStatus);
        if (!decision.allowed) {
            fail('invalid_transition', `dispute cannot move from ${dispute.status} to ${toStatus}`);
        }

        const fromStatus = dispute.status;
        const versionAfter = decision.idempotent ? dispute.version : dispute.version + 1;

        if (!decision.idempotent) {
            const updated = await tx.updateStatusCas({
                tenantId,
                disputeId,
                expectedVersion: dispute.version,
                fromStatus,
                toStatus,
                updatedAt: createdAt,
            });
            if (!updated.ok) {
                if (updated.reason === 'not_found') fail('dispute_not_found', 'dispute was not found');
                if (updated.reason === 'version_conflict') {
                    fail('version_conflict', 'dispute changed concurrently');
                }
                fail('invalid_transition', 'dispute cannot move from its current state');
            }
        }

        const current = decision.idempotent
            ? dispute
            : { ...dispute, status: toStatus, version: versionAfter, updatedAt: createdAt };
        const transition: DisputeTransitionRecord = Object.freeze({
            id: randomUUID(),
            tenantId,
            disputeId,
            action: toStatus,
            idempotencyKey,
            payloadHash: transitionHash,
            fromStatus,
            toStatus,
            versionAfter,
            actorId,
            reason,
            createdAt,
        });
        const inserted = await tx.insertTransition(transition);
        if (inserted === 'duplicate_key') {
            fail('store_inconsistent', 'dispute transition key was created concurrently');
        }

        await tx.writeAudit(disputeAuditFor(current, actorId, reason));
        return { dispute: current, transition, replayed: decision.idempotent };
    });
}

export interface SubmitDisputeEvidenceInput {
    readonly tenantId: string;
    readonly disputeId: string;
    readonly idempotencyKey: string;
    readonly expectedVersion?: number;
    readonly actorId?: string | null;
    readonly reason?: string | null;
    readonly createdAt?: string;
}

export function submitDisputeEvidence<Tx extends DisputeTransaction>(
    deps: DisputeDeps<Tx>,
    input: SubmitDisputeEvidenceInput,
): Promise<DisputeTransitionResult> {
    return applyDisputeTransition(deps, {
        tenantId: input.tenantId,
        disputeId: input.disputeId,
        idempotencyKey: input.idempotencyKey,
        toStatus: 'evidence',
        expectedVersion: input.expectedVersion,
        actorId: input.actorId,
        reason: input.reason,
        createdAt: input.createdAt,
    });
}

export interface RecordDisputeOutcomeInput {
    readonly tenantId: string;
    readonly disputeId: string;
    readonly idempotencyKey: string;
    readonly outcome: 'won' | 'lost';
    readonly expectedVersion?: number;
    readonly actorId?: string | null;
    readonly reason?: string | null;
    readonly createdAt?: string;
}

/** Record the provider/bank outcome only; no money moves. */
export function recordDisputeOutcome<Tx extends DisputeTransaction>(
    deps: DisputeDeps<Tx>,
    input: RecordDisputeOutcomeInput,
): Promise<DisputeTransitionResult> {
    if (input.outcome !== 'won' && input.outcome !== 'lost') {
        fail('invalid_status', 'dispute outcome must be won or lost');
    }
    return applyDisputeTransition(deps, {
        tenantId: input.tenantId,
        disputeId: input.disputeId,
        idempotencyKey: input.idempotencyKey,
        toStatus: input.outcome,
        expectedVersion: input.expectedVersion,
        actorId: input.actorId,
        reason: input.reason,
        createdAt: input.createdAt,
    });
}

export interface CloseDisputeInput {
    readonly tenantId: string;
    readonly disputeId: string;
    readonly idempotencyKey: string;
    readonly expectedVersion?: number;
    readonly actorId?: string | null;
    readonly reason?: string | null;
    readonly createdAt?: string;
}

export function closeDispute<Tx extends DisputeTransaction>(
    deps: DisputeDeps<Tx>,
    input: CloseDisputeInput,
): Promise<DisputeTransitionResult> {
    return applyDisputeTransition(deps, {
        tenantId: input.tenantId,
        disputeId: input.disputeId,
        idempotencyKey: input.idempotencyKey,
        toStatus: 'closed',
        expectedVersion: input.expectedVersion,
        actorId: input.actorId,
        reason: input.reason,
        createdAt: input.createdAt,
    });
}

export interface ListDisputesInput {
    readonly tenantId: string;
    readonly limit?: number;
    readonly status?: DisputeStatus;
}

export async function listDisputes<Tx extends DisputeTransaction>(
    store: DisputeStore<Tx>,
    input: ListDisputesInput,
): Promise<DisputePage> {
    if (typeof store?.runAtomic !== 'function') fail('invalid_input', 'store must expose runAtomic');
    const tenantId = requireBoundedString(input.tenantId, 'tenantId', MAX_TENANT_LENGTH, 'invalid_tenant');
    const limit = input.limit === undefined ? DEFAULT_LIST_LIMIT : input.limit;
    if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT) {
        fail('invalid_input', `limit must be a safe integer between 1 and ${MAX_LIST_LIMIT}`);
    }
    const status = input.status === undefined ? undefined : requireDisputeStatus(input.status);
    return store.runAtomic((tx) => tx.listDisputes(tenantId, { limit, status }));
}

/** Re-exported for callers that need the accepted journal shape. */
export type { JournalRecord };
