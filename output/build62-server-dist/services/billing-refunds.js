"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.DISPUTE_STORE_SQL_CONTRACT = exports.REFUND_STORE_SQL_CONTRACT = exports.RefundError = exports.DISPUTE_FINANCIAL_CONSEQUENCE_BASIS = exports.DISPUTE_FINANCIAL_CONSEQUENCE = exports.DEFAULT_LIST_LIMIT = exports.MAX_LIST_LIMIT = exports.MAX_ACCOUNT_ID_LENGTH = exports.MAX_REASON_LENGTH = exports.MAX_ACTOR_LENGTH = exports.MAX_IDEMPOTENCY_KEY_LENGTH = exports.MAX_DISPUTE_ID_LENGTH = exports.MAX_ORIGINAL_REFERENCE_LENGTH = exports.MAX_REFUND_ID_LENGTH = exports.MAX_TENANT_LENGTH = exports.MAX_REFUND_AMOUNT_MINOR = exports.DISPUTE_STATUSES = exports.TERMINAL_REFUND_STATUSES = exports.REFUND_FUNDING_SOURCES = exports.REFUND_ACTIONS = exports.REFUND_STATUSES = void 0;
exports.serializeRefundAmountMinor = serializeRefundAmountMinor;
exports.evaluateRefundTransition = evaluateRefundTransition;
exports.isTerminalRefundStatus = isTerminalRefundStatus;
exports.isIneligibleOriginal = isIneligibleOriginal;
exports.isAwaitingFundingOriginal = isAwaitingFundingOriginal;
exports.isUnavailableOriginal = isUnavailableOriginal;
exports.requestRefund = requestRefund;
exports.fundRefund = fundRefund;
exports.startRefundProcessing = startRefundProcessing;
exports.completeRefund = completeRefund;
exports.failRefund = failRefund;
exports.cancelRefund = cancelRefund;
exports.listRefunds = listRefunds;
exports.evaluateDisputeTransition = evaluateDisputeTransition;
exports.openDispute = openDispute;
exports.submitDisputeEvidence = submitDisputeEvidence;
exports.recordDisputeOutcome = recordDisputeOutcome;
exports.closeDispute = closeDispute;
exports.listDisputes = listDisputes;
const node_crypto_1 = require("node:crypto");
const billing_ledger_1 = require("./billing-ledger");
const billing_reservations_1 = require("./billing-reservations");
const billing_payouts_1 = require("./billing-payouts");
/* =========================================================================
 * Constants and errors
 * ========================================================================= */
exports.REFUND_STATUSES = [
    'requested',
    'funded',
    'processing',
    'completed',
    'failed',
    'cancelled',
];
exports.REFUND_ACTIONS = ['request', 'fund', 'process', 'complete', 'fail', 'cancel'];
exports.REFUND_FUNDING_SOURCES = ['merchant_available'];
exports.TERMINAL_REFUND_STATUSES = Object.freeze([
    'completed',
    'failed',
    'cancelled',
]);
exports.DISPUTE_STATUSES = ['opened', 'evidence', 'won', 'lost', 'closed'];
exports.MAX_REFUND_AMOUNT_MINOR = billing_ledger_1.MAX_AMOUNT_MINOR;
exports.MAX_TENANT_LENGTH = 36;
exports.MAX_REFUND_ID_LENGTH = 64;
exports.MAX_ORIGINAL_REFERENCE_LENGTH = 128;
exports.MAX_DISPUTE_ID_LENGTH = 64;
exports.MAX_IDEMPOTENCY_KEY_LENGTH = 128;
exports.MAX_ACTOR_LENGTH = 128;
exports.MAX_REASON_LENGTH = 500;
exports.MAX_ACCOUNT_ID_LENGTH = 36;
exports.MAX_LIST_LIMIT = 1000;
exports.DEFAULT_LIST_LIMIT = 200;
/**
 * docs/19 lines 84 and 105 do not settle a chargeback hold/debit/reserve; the
 * provider/bank decision and the contract govern it. Disputes therefore record
 * the case only and hold the money consequence.
 */
exports.DISPUTE_FINANCIAL_CONSEQUENCE = 'held';
exports.DISPUTE_FINANCIAL_CONSEQUENCE_BASIS = 'docs/19 lines 84 and 105: chargeback responsibility/reserve and bank decisions require a contract; no financial consequence is settled';
const CURRENCY_PATTERN = /^[A-Z]{3}$/;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/;
const EVIDENCE_REFERENCE_PATTERN = /^[A-Za-z0-9._:/-]+$/;
class RefundError extends Error {
    constructor(code, message) {
        super(message);
        this.code = code;
        this.name = 'RefundError';
    }
}
exports.RefundError = RefundError;
function fail(code, message) {
    throw new RefundError(code, message);
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function requireBoundedString(value, field, maxLength, code = 'invalid_input') {
    if (typeof value !== 'string')
        fail(code, `${field} must be a string`);
    const text = value.trim();
    if (text.length === 0 || text.length > maxLength || text !== value) {
        fail(code, `${field} must be a non-empty trimmed string of at most ${maxLength} characters`);
    }
    return text;
}
function optionalBoundedString(value, field, maxLength, code = 'invalid_input') {
    if (value === undefined || value === null)
        return null;
    if (typeof value !== 'string')
        fail(code, `${field} must be a string or null`);
    const text = value.trim();
    if (text.length > maxLength)
        fail(code, `${field} must be at most ${maxLength} characters`);
    return text === '' ? null : text;
}
function requireCurrency(value) {
    if (typeof value !== 'string' || !CURRENCY_PATTERN.test(value)) {
        fail('invalid_currency', 'currency must be a three-letter uppercase ISO-4217 code');
    }
    return value;
}
function requirePositiveAmount(value, field = 'amountMinor') {
    if (typeof value !== 'bigint')
        fail('invalid_amount', `${field} must be a bigint of minor units`);
    if (value <= 0n)
        fail('invalid_amount', `${field} must be positive`);
    if (value > exports.MAX_REFUND_AMOUNT_MINOR) {
        fail('amount_out_of_range', `${field} exceeds ${exports.MAX_REFUND_AMOUNT_MINOR.toString()}`);
    }
    return value;
}
function requireSafeInteger(value, field) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
        fail('invalid_version', `${field} must be a non-negative safe integer`);
    }
    return value;
}
function normalizeCreatedAt(value) {
    if (value === undefined)
        return new Date().toISOString();
    if (typeof value !== 'string' || value.trim() === '' || Number.isNaN(Date.parse(value))) {
        fail('invalid_timestamp', 'createdAt must be a parseable timestamp string');
    }
    return value;
}
function requireRefundStatus(value) {
    if (typeof value !== 'string' || !exports.REFUND_STATUSES.includes(value)) {
        fail('invalid_status', 'unknown refund status');
    }
    return value;
}
function requireFundingSource(value) {
    if (value !== 'merchant_available') {
        fail('invalid_funding_source', 'refunds may only be funded from merchant_available');
    }
    return value;
}
function requireNonNegativeBigInt(value, field) {
    if (typeof value !== 'bigint' || value < 0n) {
        fail('store_inconsistent', `${field} must be a non-negative bigint of minor units`);
    }
    return value;
}
function serializeRefundAmountMinor(value) {
    if (typeof value !== 'bigint')
        fail('invalid_amount', 'amount must be a bigint of minor units');
    return value.toString();
}
/* =========================================================================
 * Refund state machine
 * ========================================================================= */
const LEGAL_REFUND_TRANSITIONS = Object.freeze({
    requested: ['funded', 'cancelled'],
    funded: ['processing', 'failed', 'cancelled'],
    processing: ['completed', 'failed', 'cancelled'],
    completed: [],
    failed: [],
    cancelled: [],
});
function evaluateRefundTransition(from, to) {
    let fromStatus;
    let toStatus;
    try {
        fromStatus = requireRefundStatus(from);
        toStatus = requireRefundStatus(to);
    }
    catch {
        return { allowed: false, idempotent: false, reason: 'unknown-status' };
    }
    if (fromStatus === toStatus)
        return { allowed: true, idempotent: true, reason: null };
    return LEGAL_REFUND_TRANSITIONS[fromStatus].includes(toStatus)
        ? { allowed: true, idempotent: false, reason: null }
        : { allowed: false, idempotent: false, reason: 'illegal-transition' };
}
function isTerminalRefundStatus(status) {
    return exports.TERMINAL_REFUND_STATUSES.includes(status);
}
function isIneligibleOriginal(value) {
    return 'ineligible' in value && value.ineligible === true;
}
function isAwaitingFundingOriginal(value) {
    return 'awaitingFunding' in value && value.awaitingFunding === true;
}
function isUnavailableOriginal(value) {
    return 'unavailable' in value && value.unavailable === true;
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
exports.REFUND_STORE_SQL_CONTRACT = Object.freeze([
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
const REFUND_AUDIT_ACTION_BY_STATUS = Object.freeze({
    requested: 'billing.refund.requested',
    funded: 'billing.refund.funded',
    processing: 'billing.refund.processing',
    completed: 'billing.refund.completed',
    failed: 'billing.refund.failed',
    cancelled: 'billing.refund.cancelled',
});
function refundAuditFor(refund, journalId, actorId, reason, evidence) {
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
function hashRefundRequest(input) {
    return (0, node_crypto_1.createHash)('sha256')
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
function hashRefundTransition(input) {
    return (0, node_crypto_1.createHash)('sha256')
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
function requireSameTenant(refund, tenantId) {
    if (refund.tenantId !== tenantId) {
        fail('tenant_mismatch', 'the store returned a refund outside the requested tenant');
    }
}
function checkedRefund(value, tenantId) {
    if (value === null)
        return null;
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
function requireRefund(value, tenantId) {
    const refund = checkedRefund(value, tenantId);
    if (refund === null)
        fail('refund_not_found', 'refund was not found');
    return refund;
}
function mapReservationError(error) {
    if (error instanceof billing_reservations_1.ReservationError) {
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
function refundReservationKey(refundId) {
    const key = `refund:${refundId}`;
    if (key.length > 100)
        fail('invalid_refund_id', 'derived reservation key exceeds 100 characters');
    return key;
}
function refundReservationReference(refundId, originalReference) {
    const reference = `refund:${refundId}:original:${originalReference}`;
    if (reference.length > 200)
        fail('invalid_reference', 'derived refund reference exceeds 200 characters');
    return reference;
}
/**
 * Recompute the sealed request hash from the locked row before completion so a
 * mutated snapshot (amount/currency/purpose/destination) cannot be consumed.
 */
function verifyRefundSnapshot(refund) {
    const recomputed = hashRefundRequest({
        tenantId: refund.tenantId,
        originalReference: refund.originalReference,
        amountMinor: refund.amountMinor,
        currency: refund.currency,
        fundingSourceKind: refund.fundingSourceKind,
        requestedBy: refund.requestedBy,
    });
    if (recomputed !== refund.payloadHash) {
        fail('original_snapshot_mismatch', 'the locked refund original/amount snapshot does not match its sealed request hash');
    }
}
/**
 * Resolve the locked original payment and return ONLY its canonical identity.
 * A known ineligible payment is not "not found"; a case/accent variant is a
 * collision and fails closed.
 */
async function requireRefundableOriginal(tx, tenantId, originalReference, currency) {
    const lookup = await tx.findOriginalForUpdate(tenantId, originalReference);
    if (lookup === null)
        fail('original_not_found', 'the original payment reference was not found');
    if (isIneligibleOriginal(lookup)) {
        fail('original_ineligible', lookup.reason);
    }
    if (isAwaitingFundingOriginal(lookup)) {
        fail('awaiting_funding', lookup.reason);
    }
    if (isUnavailableOriginal(lookup)) {
        fail('original_funding_unavailable', lookup.reason);
    }
    if (lookup.tenantId !== tenantId)
        fail('tenant_mismatch', 'the original payment is foreign');
    if (lookup.currency !== currency) {
        fail('currency_mismatch', 'the original payment uses another currency');
    }
    const canonical = requireBoundedString(lookup.originalReference, 'originalReference', exports.MAX_ORIGINAL_REFERENCE_LENGTH, 'store_inconsistent');
    if (canonical !== originalReference) {
        fail('original_snapshot_mismatch', 'the caller original reference is a case/accent variant of the canonical stored payment');
    }
    requirePositiveAmount(lookup.originalAmountMinor, 'originalAmountMinor');
    return { ...lookup, originalReference: canonical };
}
/**
 * The counter account must be authorized by the injected port; a caller value
 * alone is never authority. An absent port/decision is `destination_unavailable`.
 */
async function requireAuthorizedRefundCounterAccount(authority, request) {
    if (typeof authority?.authorizeDestination !== 'function') {
        fail('destination_unavailable', 'no destination authority port is available for refund completion');
    }
    const presented = requireBoundedString(request.counterAccountId, 'counterAccountId', exports.MAX_ACCOUNT_ID_LENGTH, 'invalid_input');
    const decision = await authority.authorizeDestination(request);
    if (!isRecord(decision) || decision['allowed'] !== true) {
        fail('destination_denied', 'the injected destination authority did not allow this destination');
    }
    const authorized = decision['counterAccountId'];
    if (typeof authorized !== 'string' || authorized.trim() === '') {
        fail('destination_unavailable', 'the destination authority did not authorize a counter account');
    }
    const authorizedId = requireBoundedString(authorized, 'authorizedCounterAccountId', exports.MAX_ACCOUNT_ID_LENGTH, 'invalid_input');
    if (authorizedId !== presented) {
        fail('counter_account_mismatch', 'the caller counter account is not the authorized counter account');
    }
    return authorizedId;
}
/** Merchant refunds may only consume reserved liability into platform cash. */
function requirePlatformCashCounterAccount(account, tenantId, currency) {
    if (account === null)
        fail('account_not_found', 'platform cash counter account was not found');
    if (account.tenantId !== tenantId)
        fail('tenant_mismatch', 'platform cash counter account is foreign');
    if (account.kind !== 'platform_cash') {
        fail('account_kind_mismatch', 'merchant refund consumption may only credit platform_cash; platform_receivable is for subscription debt settlement');
    }
    if (account.currency !== currency) {
        fail('currency_mismatch', 'platform cash counter account uses another currency');
    }
}
function assertRefundDeps(deps) {
    if (typeof deps?.store?.runAtomic !== 'function')
        fail('invalid_input', 'store must expose runAtomic');
    if (typeof deps?.ledger?.reserve !== 'function' || typeof deps?.ledger?.release !== 'function') {
        fail('invalid_input', 'the accepted ledger port is required');
    }
}
async function applyRefundTransition(deps, options) {
    assertRefundDeps(deps);
    const tenantId = requireBoundedString(options.tenantId, 'tenantId', exports.MAX_TENANT_LENGTH, 'invalid_tenant');
    const refundId = requireBoundedString(options.refundId, 'refundId', exports.MAX_REFUND_ID_LENGTH, 'invalid_refund_id');
    const idempotencyKey = requireBoundedString(options.idempotencyKey, 'idempotencyKey', exports.MAX_IDEMPOTENCY_KEY_LENGTH, 'invalid_idempotency_key');
    const toStatus = requireRefundStatus(options.toStatus);
    const actorId = optionalBoundedString(options.actorId, 'actorId', exports.MAX_ACTOR_LENGTH, 'invalid_actor');
    const reason = optionalBoundedString(options.reason, 'reason', exports.MAX_REASON_LENGTH, 'invalid_reason');
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
            if (existing.tenantId !== tenantId)
                fail('tenant_mismatch', 'transition belongs to another tenant');
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
        let effect;
        try {
            effect = await options.effect(tx, refund);
        }
        catch (error) {
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
            if (updated.reason === 'not_found')
                fail('refund_not_found', 'refund was not found');
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
function refundTransitionRecord(input) {
    return Object.freeze({
        id: (0, node_crypto_1.randomUUID)(),
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
/**
 * Record a refund request. No money moves here; the remainder is checked with
 * exact BigInt arithmetic against the locked original payment.
 */
async function requestRefund(deps, input) {
    assertRefundDeps(deps);
    const tenantId = requireBoundedString(input.tenantId, 'tenantId', exports.MAX_TENANT_LENGTH, 'invalid_tenant');
    const originalReference = requireBoundedString(input.originalReference, 'originalReference', exports.MAX_ORIGINAL_REFERENCE_LENGTH, 'invalid_reference');
    const amountMinor = requirePositiveAmount(input.amountMinor);
    const currency = requireCurrency(input.currency);
    const fundingSourceKind = requireFundingSource(input.fundingSourceKind);
    const idempotencyKey = requireBoundedString(input.idempotencyKey, 'idempotencyKey', exports.MAX_IDEMPOTENCY_KEY_LENGTH, 'invalid_idempotency_key');
    const requestedBy = optionalBoundedString(input.requestedBy, 'requestedBy', exports.MAX_ACTOR_LENGTH, 'invalid_actor');
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
        const committed = requireNonNegativeBigInt(await tx.sumRefundAmountsForOriginal(tenantId, canonicalReference, currency), 'committed refunds');
        const remainder = originalAmountMinor - committed;
        if (amountMinor > remainder) {
            fail('refund_exceeds_remainder', `refund ${amountMinor.toString()} exceeds the refundable remainder ${remainder.toString()}`);
        }
        const refund = Object.freeze({
            refundId: (0, node_crypto_1.randomUUID)(),
            tenantId,
            originalReference: canonicalReference,
            originalAmountMinor,
            amountMinor,
            currency,
            fundingSourceKind,
            status: 'requested',
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
                    fail('original_snapshot_mismatch', 'the replayed refund is anchored to a different original payment identity');
                }
                return { refund: raced, replayed: true };
            }
            fail('store_inconsistent', 'insert reported a duplicate that cannot be read inside the transaction');
        }
        await tx.writeAudit(refundAuditFor(refund, null, requestedBy, null));
        return { refund, replayed: false };
    });
}
/**
 * Verify and reserve the refund amount from merchant_available BEFORE any
 * provider step. The accepted reservation domain enforces available kind,
 * currency and tenancy.
 */
function fundRefund(deps, input) {
    const tenantId = requireBoundedString(input.tenantId, 'tenantId', exports.MAX_TENANT_LENGTH, 'invalid_tenant');
    const availableAccountId = requireBoundedString(input.availableAccountId, 'availableAccountId', exports.MAX_ACCOUNT_ID_LENGTH, 'invalid_input');
    const reservedAccountId = requireBoundedString(input.reservedAccountId, 'reservedAccountId', exports.MAX_ACCOUNT_ID_LENGTH, 'invalid_input');
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
            const original = await requireRefundableOriginal(tx, tenantId, refund.originalReference, refund.currency);
            const canonicalReference = original.originalReference;
            if (canonicalReference !== refund.originalReference) {
                fail('original_snapshot_mismatch', 'the refund row is not anchored to the canonical original payment');
            }
            const committed = requireNonNegativeBigInt(await tx.sumRefundAmountsForOriginal(tenantId, canonicalReference, refund.currency), 'committed refunds');
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
/** Record that the external refund step started. No provider call is made. */
function startRefundProcessing(deps, input) {
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
/**
 * Validate EVERY input before any store call or external call, so a malformed
 * request can never reach the snapshot read or the verifier. Returns the
 * normalized opaque evidence reference.
 */
function preflightRefundInput(input) {
    requireBoundedString(input.tenantId, 'tenantId', exports.MAX_TENANT_LENGTH, 'invalid_tenant');
    requireBoundedString(input.refundId, 'refundId', exports.MAX_REFUND_ID_LENGTH, 'invalid_refund_id');
    requireBoundedString(input.idempotencyKey, 'idempotencyKey', exports.MAX_IDEMPOTENCY_KEY_LENGTH, 'invalid_idempotency_key');
    optionalBoundedString(input.actorId, 'actorId', exports.MAX_ACTOR_LENGTH, 'invalid_actor');
    optionalBoundedString(input.reason, 'reason', exports.MAX_REASON_LENGTH, 'invalid_reason');
    if (input.expectedVersion !== undefined)
        requireSafeInteger(input.expectedVersion, 'expectedVersion');
    const evidenceReference = optionalBoundedString(input.evidenceReference, 'evidenceReference', billing_payouts_1.MAX_EVIDENCE_REFERENCE_LENGTH, 'invalid_input');
    // Conservative opaque-token charset; control characters are rejected.
    if ((typeof input.evidenceReference === 'string' && CONTROL_CHARACTERS.test(input.evidenceReference))
        || (evidenceReference !== null && !EVIDENCE_REFERENCE_PATTERN.test(evidenceReference))) {
        fail('invalid_input', 'evidenceReference may contain only letters, digits and . _ : / -');
    }
    return evidenceReference;
}
/**
 * EXTERNAL CALL OUTSIDE THE TRANSACTION: a plain non-locking snapshot read
 * tells whether the refund is processing; only then the injected verifier is
 * consulted, BEFORE the locking transaction opens. No verifier call is made
 * for any non-processing refund or a stale expected version.
 */
async function verifyProcessingRefundOutcome(deps, input, claimedOutcome, evidenceReference, callerProviderReference) {
    if (typeof deps?.store?.runAtomic !== 'function')
        return null;
    const snapshot = await deps.store.runAtomic(async (tx) => typeof tx.findRefundSnapshot === 'function'
        ? tx.findRefundSnapshot(input.tenantId, input.refundId)
        : null);
    if (snapshot === null
        || snapshot.tenantId !== input.tenantId
        || snapshot.refundId !== input.refundId
        || snapshot.status !== 'processing'
        || (input.expectedVersion !== undefined && snapshot.version !== input.expectedVersion)) {
        return null;
    }
    const outcome = await (0, billing_payouts_1.readProviderOutcomeVerdict)(deps.providerOutcomeVerifier, {
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
function requireAttestedRefundOutcome(pre, refund, verdict, what) {
    if (pre === null
        || pre.outcome.verdict !== verdict
        || pre.snapshot.tenantId !== refund.tenantId
        || pre.snapshot.refundId !== refund.refundId
        || pre.snapshot.version !== refund.version
        || pre.snapshot.amountMinor !== refund.amountMinor
        || pre.snapshot.currency !== refund.currency
        || pre.snapshot.originalReference !== refund.originalReference
        || pre.snapshot.payloadHash !== refund.payloadHash) {
        fail('provider_outcome_unverified', `a processing refund requires ${what}, attested by the injected verifier for this exact unchanged request before the transaction; nothing was consumed or released`);
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
async function completeRefund(deps, input) {
    const counterAccountId = requireBoundedString(input.counterAccountId, 'counterAccountId', exports.MAX_ACCOUNT_ID_LENGTH, 'invalid_input');
    const providerReference = optionalBoundedString(input.providerReference, 'providerReference', exports.MAX_ACTOR_LENGTH, 'invalid_input');
    const createdAt = normalizeCreatedAt(input.createdAt);
    const evidenceReference = preflightRefundInput(input);
    const pre = await verifyProcessingRefundOutcome(deps, { tenantId: input.tenantId, refundId: input.refundId, expectedVersion: input.expectedVersion }, 'success', evidenceReference, providerReference);
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
            const attested = requireAttestedRefundOutcome(pre, refund, 'definite_success', 'a definitive provider success');
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
            requirePlatformCashCounterAccount(await tx.getAccount(refund.tenantId, authorizedCounterId), refund.tenantId, refund.currency);
            const reservation = await tx.getReservation(refund.tenantId, refund.reservationId);
            if (reservation === null
                || reservation.tenantId !== refund.tenantId
                || reservation.currency !== refund.currency
                || reservation.amountMinor !== refund.amountMinor) {
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
                    providerVerdict: 'definite_success',
                    evidenceReference,
                    providerAccountRef: attested.providerAccountRef,
                    successReference: attested.successReference,
                },
            };
        },
    });
}
/**
 * Release a funded hold, or a processing hold only with a definite attested
 * provider failure. Idempotent on replay.
 */
async function failRefund(deps, input) {
    const createdAt = normalizeCreatedAt(input.createdAt);
    /*
     * EXTERNAL CALL OUTSIDE THE TRANSACTION (see verifyProcessingRefundOutcome).
     * Inside the transaction the locked row is re-read and the attestation is
     * honoured only if it is bound to the exact unchanged request and its
     * verdict is a definite failure.
     */
    const preEvidenceReference = preflightRefundInput(input);
    const pre = await verifyProcessingRefundOutcome(deps, { tenantId: input.tenantId, refundId: input.refundId, expectedVersion: input.expectedVersion }, 'failed', preEvidenceReference, null);
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
            let providerEvidence;
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
                    failureReason: optionalBoundedString(input.reason, 'reason', exports.MAX_REASON_LENGTH, 'invalid_reason'),
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
                failureReason: optionalBoundedString(input.reason, 'reason', exports.MAX_REASON_LENGTH, 'invalid_reason'),
                cancellationReason: null,
                ...(providerEvidence === undefined ? {} : { providerEvidence }),
            };
        },
    });
}
/**
 * Cancel a requested/funded refund; a funded hold is released exactly once. A
 * `processing` refund may be cancelled only when the injected verifier attests
 * a final non-executed/non-settled provider cancellation bound to this exact
 * request; otherwise it stays `processing` (typed `provider_outcome_unverified`,
 * reconciliation required) and no hold is released.
 */
async function cancelRefund(deps, input) {
    const createdAt = normalizeCreatedAt(input.createdAt);
    const evidenceReference = preflightRefundInput(input);
    const pre = await verifyProcessingRefundOutcome(deps, { tenantId: input.tenantId, refundId: input.refundId, expectedVersion: input.expectedVersion }, 'cancelled', evidenceReference, null);
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
            const cancellationReason = optionalBoundedString(input.reason, 'reason', exports.MAX_REASON_LENGTH, 'invalid_reason');
            let providerEvidence;
            if (refund.status === 'processing') {
                requireAttestedRefundOutcome(pre, refund, 'definite_cancellation', 'a definitive provider cancellation (final non-executed/non-settled outcome)');
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
async function listRefunds(store, input) {
    if (typeof store?.runAtomic !== 'function')
        fail('invalid_input', 'store must expose runAtomic');
    const tenantId = requireBoundedString(input.tenantId, 'tenantId', exports.MAX_TENANT_LENGTH, 'invalid_tenant');
    const limit = input.limit === undefined ? exports.DEFAULT_LIST_LIMIT : input.limit;
    if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1 || limit > exports.MAX_LIST_LIMIT) {
        fail('invalid_input', `limit must be a safe integer between 1 and ${exports.MAX_LIST_LIMIT}`);
    }
    const status = input.status === undefined ? undefined : requireRefundStatus(input.status);
    return store.runAtomic((tx) => tx.listRefunds(tenantId, { limit, status }));
}
/* =========================================================================
 * Disputes (separate lifecycle, financial consequence HELD)
 * ========================================================================= */
const LEGAL_DISPUTE_TRANSITIONS = Object.freeze({
    opened: ['evidence', 'won', 'lost', 'closed'],
    evidence: ['won', 'lost', 'closed'],
    won: ['closed'],
    lost: ['closed'],
    closed: [],
});
function evaluateDisputeTransition(from, to) {
    const fromStatus = normalizeDisputeStatus(from);
    const toStatus = normalizeDisputeStatus(to);
    if (fromStatus === null || toStatus === null) {
        return { allowed: false, idempotent: false, reason: 'unknown-status' };
    }
    if (fromStatus === toStatus)
        return { allowed: true, idempotent: true, reason: null };
    return LEGAL_DISPUTE_TRANSITIONS[fromStatus].includes(toStatus)
        ? { allowed: true, idempotent: false, reason: null }
        : { allowed: false, idempotent: false, reason: 'illegal-transition' };
}
function normalizeDisputeStatus(value) {
    if (typeof value !== 'string' || !exports.DISPUTE_STATUSES.includes(value))
        return null;
    return value;
}
function requireDisputeStatus(value) {
    const status = normalizeDisputeStatus(value);
    if (status === null)
        fail('invalid_status', 'unknown dispute status');
    return status;
}
/**
 * `dispute_cases` has UNIQUE (tenant_id, dispute_id) and
 * UNIQUE (tenant_id, idempotency_key); `findDisputeForUpdate` locks the row;
 * `updateStatusCas` is a conditional write on (tenant_id, dispute_id, version,
 * status); `dispute_transitions` is append-only with a payload hash; the sealed
 * audit row is written on the same connection/transaction. This domain never
 * writes a ledger journal and never moves money.
 */
exports.DISPUTE_STORE_SQL_CONTRACT = Object.freeze([
    'dispute_cases: UNIQUE (tenant_id, dispute_id); every query carries a tenant predicate.',
    'dispute_cases: UNIQUE (tenant_id, idempotency_key) with payload_hash implements HK1.',
    'findDisputeForUpdate uses SELECT ... FOR UPDATE; updateStatusCas is a conditional write on (tenant_id, dispute_id, version, status).',
    'dispute_transitions: append-only, UNIQUE (tenant_id, idempotency_key), payload_hash conflict detection.',
    'amount columns are BIGINT minor units; version is a safe integer; currency is CHAR(3).',
    'the sealed audit row for each mutation is written on the SAME connection/transaction; an audit failure rolls everything back.',
    'this domain writes no ledger journal and no balance; the financial consequence is recorded as HELD.',
    'listDisputes is tenant-scoped, bounded and reports truncation explicitly.',
]);
const DISPUTE_AUDIT_ACTION_BY_STATUS = Object.freeze({
    opened: 'billing.dispute.opened',
    evidence: 'billing.dispute.evidence',
    won: 'billing.dispute.won',
    lost: 'billing.dispute.lost',
    closed: 'billing.dispute.closed',
});
function disputeAuditFor(dispute, actorId, reason) {
    return Object.freeze({
        action: DISPUTE_AUDIT_ACTION_BY_STATUS[dispute.status],
        tenantId: dispute.tenantId,
        disputeId: dispute.disputeId,
        status: dispute.status,
        version: dispute.version,
        amountMinor: dispute.amountMinor.toString(),
        currency: dispute.currency,
        reference: dispute.reference,
        financialConsequence: exports.DISPUTE_FINANCIAL_CONSEQUENCE,
        actorId,
        reason,
    });
}
function hashDisputeTransition(input) {
    return (0, node_crypto_1.createHash)('sha256')
        .update(JSON.stringify({
        scope: 'dispute_transition',
        tenantId: input.tenantId,
        disputeId: input.disputeId,
        toStatus: input.toStatus,
        extra: input.extra,
    }))
        .digest('hex');
}
function hashDisputeRequest(input) {
    return (0, node_crypto_1.createHash)('sha256')
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
function checkedDispute(value, tenantId) {
    if (value === null)
        return null;
    if (value.tenantId !== tenantId)
        fail('tenant_mismatch', 'the store returned a dispute outside the tenant');
    if (typeof value.amountMinor !== 'bigint' || value.amountMinor <= 0n) {
        fail('invalid_amount', 'the store returned a dispute with an invalid amount');
    }
    if (!Number.isSafeInteger(value.version) || value.version < 1) {
        fail('invalid_version', 'the store returned a dispute with an invalid version');
    }
    requireDisputeStatus(value.status);
    return value;
}
function requireDispute(value, tenantId) {
    const dispute = checkedDispute(value, tenantId);
    if (dispute === null)
        fail('dispute_not_found', 'dispute was not found');
    return dispute;
}
/** Record a dispute case. No hold, debit or ledger journal is created. */
async function openDispute(deps, input) {
    if (typeof deps?.store?.runAtomic !== 'function')
        fail('invalid_input', 'store must expose runAtomic');
    const tenantId = requireBoundedString(input.tenantId, 'tenantId', exports.MAX_TENANT_LENGTH, 'invalid_tenant');
    const reference = requireBoundedString(input.reference, 'reference', exports.MAX_ORIGINAL_REFERENCE_LENGTH, 'invalid_reference');
    const amountMinor = requirePositiveAmount(input.amountMinor);
    const currency = requireCurrency(input.currency);
    const idempotencyKey = requireBoundedString(input.idempotencyKey, 'idempotencyKey', exports.MAX_IDEMPOTENCY_KEY_LENGTH, 'invalid_idempotency_key');
    const openedBy = optionalBoundedString(input.openedBy, 'openedBy', exports.MAX_ACTOR_LENGTH, 'invalid_actor');
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
        const dispute = Object.freeze({
            disputeId: (0, node_crypto_1.randomUUID)(),
            tenantId,
            reference,
            amountMinor,
            currency,
            status: 'opened',
            version: 1,
            idempotencyKey,
            payloadHash,
            openedBy,
            financialConsequence: exports.DISPUTE_FINANCIAL_CONSEQUENCE,
            financialConsequenceBasis: exports.DISPUTE_FINANCIAL_CONSEQUENCE_BASIS,
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
async function applyDisputeTransition(deps, options) {
    if (typeof deps?.store?.runAtomic !== 'function')
        fail('invalid_input', 'store must expose runAtomic');
    const tenantId = requireBoundedString(options.tenantId, 'tenantId', exports.MAX_TENANT_LENGTH, 'invalid_tenant');
    const disputeId = requireBoundedString(options.disputeId, 'disputeId', exports.MAX_DISPUTE_ID_LENGTH, 'invalid_input');
    const idempotencyKey = requireBoundedString(options.idempotencyKey, 'idempotencyKey', exports.MAX_IDEMPOTENCY_KEY_LENGTH, 'invalid_idempotency_key');
    const toStatus = requireDisputeStatus(options.toStatus);
    const actorId = optionalBoundedString(options.actorId, 'actorId', exports.MAX_ACTOR_LENGTH, 'invalid_actor');
    const reason = optionalBoundedString(options.reason, 'reason', exports.MAX_REASON_LENGTH, 'invalid_reason');
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
            if (existing.tenantId !== tenantId)
                fail('tenant_mismatch', 'transition belongs to another tenant');
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
                if (updated.reason === 'not_found')
                    fail('dispute_not_found', 'dispute was not found');
                if (updated.reason === 'version_conflict') {
                    fail('version_conflict', 'dispute changed concurrently');
                }
                fail('invalid_transition', 'dispute cannot move from its current state');
            }
        }
        const current = decision.idempotent
            ? dispute
            : { ...dispute, status: toStatus, version: versionAfter, updatedAt: createdAt };
        const transition = Object.freeze({
            id: (0, node_crypto_1.randomUUID)(),
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
function submitDisputeEvidence(deps, input) {
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
/** Record the provider/bank outcome only; no money moves. */
function recordDisputeOutcome(deps, input) {
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
function closeDispute(deps, input) {
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
async function listDisputes(store, input) {
    if (typeof store?.runAtomic !== 'function')
        fail('invalid_input', 'store must expose runAtomic');
    const tenantId = requireBoundedString(input.tenantId, 'tenantId', exports.MAX_TENANT_LENGTH, 'invalid_tenant');
    const limit = input.limit === undefined ? exports.DEFAULT_LIST_LIMIT : input.limit;
    if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1 || limit > exports.MAX_LIST_LIMIT) {
        fail('invalid_input', `limit must be a safe integer between 1 and ${exports.MAX_LIST_LIMIT}`);
    }
    const status = input.status === undefined ? undefined : requireDisputeStatus(input.status);
    return store.runAtomic((tx) => tx.listDisputes(tenantId, { limit, status }));
}
