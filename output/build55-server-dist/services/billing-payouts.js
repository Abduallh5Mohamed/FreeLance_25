"use strict";
/**
 * FIN9 / X7 — vendor-neutral payout request domain.
 *
 * This is a PURE domain module: no SQL, no database driver, no network, no
 * provider SDK, no routes, no migrations and no secrets. Persistence is the
 * injected `PayoutStore`; the in-memory store lives in
 * `server/tests/billing-payouts.test.ts` and is NOT SQL evidence.
 *
 * All money movement is delegated to the accepted FIN3 domain:
 *  - reserve: `reserveFunds` from `billing-reservations.ts`;
 *  - confirm: `consumeReservation` (consumes the reservation exactly once);
 *  - fail/cancel: `releaseReservation` (releases exactly once, idempotent).
 * The domain never edits a ledger journal or a balance directly.
 *
 * Subscription debt has priority over a NEW withdrawal reservation. The
 * priority decision reuses `decideWithdrawalPriority` from
 * `billing-collection.ts`; existing reservations are only inspected and are
 * never cancelled, reused or mutated here (docs/19 lines 74, 103, 111).
 *
 * Settled rules implemented here:
 *  - request -> reserve -> processing -> confirmed | failed; a `requested` or
 *    `reserved` payout may also be cancelled;
 *  - a reservation is created only when no subscription debt is due and the
 *    exact requested amount fits in `merchant_available`;
 *  - confirm consumes the reservation exactly once into `platform_cash`, fail/
 *    cancel releases it exactly once;
 *  - every mutation is idempotent per (tenant, key) with a payload hash;
 *  - status transitions are guarded by a version CAS; a lost race writes
 *    nothing;
 *  - every store read/write carries a tenant predicate.
 *
 * Deliberately HELD (not guessed) and reported, never invented:
 *  - withdrawal limits, fees, cooling periods and KYC (docs/19 line 78 and
 *    line 90; inventory §7 D2) — this module has no such knobs;
 *  - who is authorized to set/change a payout destination. Only the injected
 *    `DestinationAuthority` decides; there is no default-allow path;
 *  - provider behavior after `processing` (docs/19 line 78: no transfer is
 *    claimed before it is proven). It never calls a provider. Every exit from
 *    `processing` (confirmed / failed / cancelled) requires the injected
 *    `ProviderOutcomeVerifier` to attest a definitive, request-bound outcome
 *    (success / failure / cancellation) BEFORE the transaction; absent,
 *    uncertain, unavailable or non-echoing answers keep the payout
 *    `processing` with a typed `provider_outcome_unverified` error.
 *
 * Money is exact `bigint` minor units, bounded, and serialized as a decimal
 * string (HK2). Versions are safe integers. No floating point.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.PAYOUT_STORE_SQL_CONTRACT = exports.PayoutError = exports.RESERVATION_SCAN_LIMIT = exports.DEBT_SCAN_LIMIT = exports.DEFAULT_LIST_LIMIT = exports.MAX_LIST_LIMIT = exports.MAX_ACCOUNT_ID_LENGTH = exports.MAX_EVIDENCE_REFERENCE_LENGTH = exports.MAX_REASON_LENGTH = exports.MAX_ACTOR_LENGTH = exports.MAX_IDEMPOTENCY_KEY_LENGTH = exports.MAX_DESTINATION_LENGTH = exports.MAX_PAYOUT_ID_LENGTH = exports.MAX_TENANT_LENGTH = exports.MAX_PAYOUT_AMOUNT_MINOR = exports.TERMINAL_PAYOUT_STATUSES = exports.PAYOUT_ACTIONS = exports.PAYOUT_STATUSES = void 0;
exports.serializePayoutAmountMinor = serializePayoutAmountMinor;
exports.evaluatePayoutTransition = evaluatePayoutTransition;
exports.isTerminalPayoutStatus = isTerminalPayoutStatus;
exports.acceptedLedgerPort = acceptedLedgerPort;
exports.readProviderOutcomeVerdict = readProviderOutcomeVerdict;
exports.isDefiniteProviderOutcome = isDefiniteProviderOutcome;
exports.requestPayout = requestPayout;
exports.reservePayout = reservePayout;
exports.startPayoutProcessing = startPayoutProcessing;
exports.confirmPayout = confirmPayout;
exports.failPayout = failPayout;
exports.cancelPayout = cancelPayout;
exports.listPayouts = listPayouts;
const node_crypto_1 = require("node:crypto");
const billing_ledger_1 = require("./billing-ledger");
const billing_reservations_1 = require("./billing-reservations");
const billing_collection_1 = require("./billing-collection");
/* =========================================================================
 * Constants and errors
 * ========================================================================= */
exports.PAYOUT_STATUSES = [
    'requested',
    'reserved',
    'processing',
    'confirmed',
    'failed',
    'cancelled',
];
exports.PAYOUT_ACTIONS = ['request', 'reserve', 'process', 'confirm', 'fail', 'cancel'];
exports.TERMINAL_PAYOUT_STATUSES = Object.freeze([
    'confirmed',
    'failed',
    'cancelled',
]);
exports.MAX_PAYOUT_AMOUNT_MINOR = billing_ledger_1.MAX_AMOUNT_MINOR;
exports.MAX_TENANT_LENGTH = 36;
exports.MAX_PAYOUT_ID_LENGTH = 64;
exports.MAX_DESTINATION_LENGTH = 200;
exports.MAX_IDEMPOTENCY_KEY_LENGTH = 128;
exports.MAX_ACTOR_LENGTH = 128;
exports.MAX_REASON_LENGTH = 500;
/** Opaque caller reference to provider evidence; never a free-form reason. */
exports.MAX_EVIDENCE_REFERENCE_LENGTH = 200;
exports.MAX_ACCOUNT_ID_LENGTH = 36;
exports.MAX_LIST_LIMIT = 1000;
exports.DEFAULT_LIST_LIMIT = 200;
exports.DEBT_SCAN_LIMIT = 500;
exports.RESERVATION_SCAN_LIMIT = 500;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/;
const EVIDENCE_REFERENCE_PATTERN = /^[A-Za-z0-9._:/-]+$/;
class PayoutError extends Error {
    constructor(code, message) {
        super(message);
        this.code = code;
        this.name = 'PayoutError';
    }
}
exports.PayoutError = PayoutError;
function fail(code, message) {
    throw new PayoutError(code, message);
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
    if (value > exports.MAX_PAYOUT_AMOUNT_MINOR) {
        fail('amount_out_of_range', `${field} exceeds ${exports.MAX_PAYOUT_AMOUNT_MINOR.toString()}`);
    }
    return value;
}
function requireSafeInteger(value, field) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
        fail('invalid_version', `${field} must be a non-negative safe integer`);
    }
    return value;
}
function requireSafeSecond(value, field) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
        fail('invalid_timestamp', `${field} must be a non-negative safe integer second`);
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
function requireStatus(value) {
    if (typeof value !== 'string' || !exports.PAYOUT_STATUSES.includes(value)) {
        fail('invalid_status', 'unknown payout status');
    }
    return value;
}
function serializePayoutAmountMinor(value) {
    if (typeof value !== 'bigint')
        fail('invalid_amount', 'amount must be a bigint of minor units');
    return value.toString();
}
/* =========================================================================
 * State machine
 * ========================================================================= */
const LEGAL_PAYOUT_TRANSITIONS = Object.freeze({
    requested: ['reserved', 'cancelled'],
    reserved: ['processing', 'failed', 'cancelled'],
    processing: ['confirmed', 'failed', 'cancelled'],
    confirmed: [],
    failed: [],
    cancelled: [],
});
/** Repeating the current status is an idempotent no-op; anything else must be legal. */
function evaluatePayoutTransition(from, to) {
    let fromStatus;
    let toStatus;
    try {
        fromStatus = requireStatus(from);
        toStatus = requireStatus(to);
    }
    catch {
        return { allowed: false, idempotent: false, reason: 'unknown-status' };
    }
    if (fromStatus === toStatus)
        return { allowed: true, idempotent: true, reason: null };
    return LEGAL_PAYOUT_TRANSITIONS[fromStatus].includes(toStatus)
        ? { allowed: true, idempotent: false, reason: null }
        : { allowed: false, idempotent: false, reason: 'illegal-transition' };
}
function isTerminalPayoutStatus(status) {
    return exports.TERMINAL_PAYOUT_STATUSES.includes(status);
}
/**
 * Production wiring for the port: it calls the accepted FIN3 functions with a
 * one-hop store whose `runAtomic` reuses the caller's open transaction. This
 * keeps every reservation/journal write on the SAME transaction as the payout
 * row and its sealed audit.
 */
function acceptedLedgerPort() {
    const reservationStore = (tx) => ({
        runAtomic: (callback) => callback(tx),
    });
    const ledgerStore = (tx) => ({
        runAtomic: (callback) => callback(tx),
    });
    return {
        reserve: (tx, input) => (0, billing_reservations_1.reserveFunds)(reservationStore(tx), input),
        release: (tx, input) => (0, billing_reservations_1.releaseReservation)(reservationStore(tx), input),
        consume: (tx, input) => (0, billing_reservations_1.consumeReservation)(reservationStore(tx), input),
        postJournal: (tx, input) => (0, billing_ledger_1.postJournalInTransaction)(tx, input),
        reverseJournal: (tx, input) => (0, billing_ledger_1.reverseJournal)(ledgerStore(tx), input),
    };
}
const VERDICT_BY_CLAIM = Object.freeze({
    success: 'definite_success',
    failed: 'definite_failure',
    cancelled: 'definite_cancellation',
});
const UNAVAILABLE_OUTCOME = Object.freeze({
    verdict: 'unavailable',
    providerAccountRef: null,
    successReference: null,
});
const UNKNOWN_OUTCOME = Object.freeze({
    verdict: 'unknown',
    providerAccountRef: null,
    successReference: null,
});
function boundedOpaqueToken(value) {
    if (typeof value !== 'string'
        || value.length === 0
        || value.length > exports.MAX_EVIDENCE_REFERENCE_LENGTH
        || !EVIDENCE_REFERENCE_PATTERN.test(value)) {
        return null;
    }
    return value;
}
/**
 * Normalize any verifier behaviour into a closed, request-bound result. The
 * verdict source is ONLY the port's return value; it must echo the request.
 */
async function readProviderOutcomeVerdict(verifier, request) {
    if (verifier === undefined || typeof verifier?.verifyProviderOutcome !== 'function') {
        return UNAVAILABLE_OUTCOME;
    }
    let answer;
    try {
        answer = await verifier.verifyProviderOutcome(request);
    }
    catch {
        return UNAVAILABLE_OUTCOME;
    }
    if (!isRecord(answer))
        return UNKNOWN_OUTCOME;
    const verdict = answer['verdict'];
    if (verdict === 'unavailable')
        return UNAVAILABLE_OUTCOME;
    if (verdict !== VERDICT_BY_CLAIM[request.claimedOutcome])
        return UNKNOWN_OUTCOME;
    if (answer['tenantId'] !== request.tenantId
        || answer['requestId'] !== request.requestId
        || answer['kind'] !== request.kind
        || answer['claimedOutcome'] !== request.claimedOutcome
        || answer['amountMinor'] !== request.amountMinor
        || answer['currency'] !== request.currency
        || answer['destinationSnapshotHash'] !== request.destinationSnapshotHash
        || answer['requestVersion'] !== request.requestVersion) {
        return UNKNOWN_OUTCOME;
    }
    if (request.claimedOutcome !== 'success') {
        return Object.freeze({ verdict: verdict, providerAccountRef: null, successReference: null });
    }
    const providerAccountRef = boundedOpaqueToken(answer['providerAccountRef']);
    const successReference = boundedOpaqueToken(answer['successReference']);
    if (providerAccountRef === null || successReference === null)
        return UNKNOWN_OUTCOME;
    if (request.callerProviderReference !== null && request.callerProviderReference !== successReference) {
        return UNKNOWN_OUTCOME;
    }
    return Object.freeze({ verdict: 'definite_success', providerAccountRef, successReference });
}
function isDefiniteProviderOutcome(verdict) {
    return verdict === 'definite_success' || verdict === 'definite_failure' || verdict === 'definite_cancellation';
}
async function requireDestinationApproval(authority, request) {
    const decision = await authority.authorizeDestination(request);
    if (!isRecord(decision) || decision['allowed'] !== true) {
        fail('destination_denied', 'the injected destination authority did not allow this destination');
    }
}
/**
 * Re-check the immutable payout snapshot and the authorized counter account
 * immediately before consumption. A caller-supplied counter account is never
 * authority: the decision must explicitly authorize the same `platform_cash`
 * account. Absent that contract the result is `destination_unavailable`.
 */
async function requireAuthorizedCounterAccount(authority, request) {
    if (typeof authority?.authorizeDestination !== 'function') {
        fail('destination_unavailable', 'no destination authority port is available for counter-account confirmation');
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
/** Merchant payouts/refunds may only consume reserved liability into platform cash. */
function requirePlatformCashCounterAccount(account, tenantId, currency) {
    if (account === null)
        fail('account_not_found', 'platform cash counter account was not found');
    if (account.tenantId !== tenantId)
        fail('tenant_mismatch', 'platform cash counter account is foreign');
    if (account.kind !== 'platform_cash') {
        fail('account_kind_mismatch', 'merchant payout/refund consumption may only credit platform_cash; platform_receivable is for subscription debt settlement');
    }
    if (account.currency !== currency) {
        fail('currency_mismatch', 'platform cash counter account uses another currency');
    }
}
/* =========================================================================
 * Store contract
 * ========================================================================= */
/**
 * SQL obligations behind this interface (not implemented here):
 *  - `payout_requests` has UNIQUE (tenant_id, payout_id) and
 *    UNIQUE (tenant_id, idempotency_key); every query carries a tenant
 *    predicate. `findPayoutForUpdate` locks the row (`SELECT ... FOR UPDATE`).
 *  - `updateStatusCas` is a single conditional write on
 *    (tenant_id, payout_id, version, status) that increments `version` by one;
 *    a mismatch writes nothing.
 *  - `payout_transitions` is append-only with UNIQUE (tenant_id, idempotency_key)
 *    and stores the payload hash so a replay with another payload is a typed
 *    conflict (HK1).
 *  - amount columns are BIGINT minor units read with `BigInt()` and never
 *    `Number`; `version` is a safe integer; `currency` is CHAR(3).
 *  - the sealed audit row is written on the SAME connection/transaction as the
 *    mutation; an audit failure rolls the whole transaction back.
 *  - `listDueSubscriptionDebts` and `listActiveReservations` are bounded and
 *    report truncation explicitly. A truncated debt scan fails closed because a
 *    missed due debt would break subscription priority.
 *  - listing payouts is tenant-scoped and bounded with an explicit `truncated`
 *    flag, never a silent cut.
 *  - this store never writes a ledger journal or balance itself, and never
 *    creates a cash receipt.
 */
exports.PAYOUT_STORE_SQL_CONTRACT = Object.freeze([
    'payout_requests: UNIQUE (tenant_id, payout_id); every query carries a tenant predicate.',
    'payout_requests: UNIQUE (tenant_id, idempotency_key) implements HK1 with the stored payload_hash.',
    'payout_requests: findPayoutForUpdate uses SELECT ... FOR UPDATE; updateStatusCas is a conditional write on (tenant_id, payout_id, version, status) that increments version by one.',
    'payout_transitions: append-only, UNIQUE (tenant_id, idempotency_key), payload_hash conflict detection.',
    'amount columns are BIGINT minor units read with BigInt() and never Number; version is a safe integer; currency is CHAR(3).',
    'the sealed audit row for each mutation is written on the SAME connection/transaction; an audit failure rolls everything back.',
    'listDueSubscriptionDebts and listActiveReservations are bounded and report truncation explicitly.',
    'listPayouts is tenant-scoped, bounded and reports truncation explicitly.',
    'confirm re-checks the locked request snapshot and the injected destination authority before consumption; the authorized counter account must be an existing platform_cash account of the same tenant/currency.',
    'a processing payout is never cancelled with a release; only definite provider failure evidence (a reason) may release it, otherwise it stays processing for reconciliation.',
    'a debt-source adapter failure is surfaced as typed debt_source_unavailable, never as a not-found or a successful gate.',
    'this domain writes no ledger journal and no balance directly, and creates no cash receipt.',
]);
const AUDIT_ACTION_BY_STATUS = Object.freeze({
    requested: 'billing.payout.requested',
    reserved: 'billing.payout.reserved',
    processing: 'billing.payout.processing',
    confirmed: 'billing.payout.confirmed',
    failed: 'billing.payout.failed',
    cancelled: 'billing.payout.cancelled',
});
function auditFor(payout, journalId, actorId, reason, evidence) {
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
        action: AUDIT_ACTION_BY_STATUS[payout.status],
        tenantId: payout.tenantId,
        payoutId: payout.payoutId,
        status: payout.status,
        version: payout.version,
        amountMinor: payout.amountMinor.toString(),
        currency: payout.currency,
        reservationId: payout.reservationId,
        journalId,
        actorId,
        reason,
    });
}
/* =========================================================================
 * Hashing (HK1)
 * ========================================================================= */
function hashRequestPayload(input) {
    return (0, node_crypto_1.createHash)('sha256')
        .update(JSON.stringify({
        scope: 'payout_request',
        tenantId: input.tenantId,
        payoutId: input.payoutId,
        destinationRef: input.destinationRef,
        amountMinor: input.amountMinor.toString(),
        currency: input.currency,
        requestedBy: input.requestedBy,
    }))
        .digest('hex');
}
/** Recompute the sealed request hash from the locked row before confirmation. */
function verifyPayoutSnapshot(payout) {
    const recomputed = hashRequestPayload({
        tenantId: payout.tenantId,
        payoutId: payout.payoutId,
        destinationRef: payout.destinationRef,
        amountMinor: payout.amountMinor,
        currency: payout.currency,
        requestedBy: payout.requestedBy,
    });
    if (recomputed !== payout.payloadHash) {
        fail('destination_snapshot_mismatch', 'the locked payout destination/amount snapshot does not match its sealed request hash');
    }
}
function hashTransitionPayload(input) {
    return (0, node_crypto_1.createHash)('sha256')
        .update(JSON.stringify({
        scope: 'payout_transition',
        tenantId: input.tenantId,
        payoutId: input.payoutId,
        action: input.action,
        toStatus: input.toStatus,
        extra: input.extra,
    }))
        .digest('hex');
}
/* =========================================================================
 * Read validation helpers
 * ========================================================================= */
function requireSameTenant(payout, tenantId) {
    if (payout.tenantId !== tenantId) {
        fail('tenant_mismatch', 'the store returned a payout outside the requested tenant');
    }
}
function checkedPayout(value, tenantId) {
    if (value === null)
        return null;
    requireSameTenant(value, tenantId);
    if (typeof value.amountMinor !== 'bigint' || value.amountMinor <= 0n) {
        fail('invalid_amount', 'the store returned a payout with an invalid amount');
    }
    if (!Number.isSafeInteger(value.version) || value.version < 1) {
        fail('invalid_version', 'the store returned a payout with an invalid version');
    }
    requireStatus(value.status);
    return value;
}
function requirePayout(value, tenantId) {
    const payout = checkedPayout(value, tenantId);
    if (payout === null)
        fail('payout_not_found', 'payout was not found');
    return payout;
}
/**
 * The debt-source adapter failure is a typed domain gate: a payout cannot
 * proceed, but it is not a not-found and must not be swallowed. The adapter
 * (`billing-payouts-sql.ts`) is not imported here, so the error is recognized by
 * its stable adapter name/code and narrowed without `any`.
 */
function isAdapterError(error, code) {
    if (!isRecord(error))
        return false;
    return error['name'] === 'BillingPayoutSqlError' && error['code'] === code;
}
function mapReservationError(error) {
    if (isAdapterError(error, 'debt_source_unavailable')) {
        return new PayoutError('debt_source_unavailable', 'the subscription debt source is unavailable; refusing to create or move a payout hold');
    }
    if (error instanceof billing_reservations_1.ReservationError) {
        if (error.code === 'insufficient_available') {
            return new PayoutError('insufficient_available', error.message);
        }
        if (error.code === 'already_consumed') {
            return new PayoutError('already_consumed', error.message);
        }
        if (error.code === 'reservation_not_reserved' || error.code === 'reservation_state_invalid') {
            return new PayoutError('reservation_state_invalid', error.message);
        }
        if (error.code === 'reservation_not_found') {
            return new PayoutError('reservation_not_found', error.message);
        }
        if (error.code === 'version_conflict') {
            return new PayoutError('version_conflict', error.message);
        }
    }
    return error;
}
function requireMerchantAvailableAccount(account, tenantId, currency) {
    if (account === null)
        fail('account_not_found', 'merchant available account was not found');
    if (account.tenantId !== tenantId)
        fail('tenant_mismatch', 'merchant available account is foreign');
    if (account.kind !== 'merchant_available') {
        fail('account_kind_mismatch', 'payout funding must come from merchant_available only');
    }
    if (account.currency !== currency) {
        fail('currency_mismatch', 'merchant available account uses another currency');
    }
    return account;
}
function payoutReservationKey(payoutId) {
    const key = `payout:${payoutId}`;
    if (key.length > 100)
        fail('invalid_payout_id', 'derived reservation key exceeds 100 characters');
    return key;
}
function assertDeps(deps) {
    if (typeof deps?.store?.runAtomic !== 'function')
        fail('invalid_input', 'store must expose runAtomic');
    if (typeof deps?.ledger?.reserve !== 'function' || typeof deps?.ledger?.release !== 'function') {
        fail('invalid_input', 'the accepted ledger port is required');
    }
    if (typeof deps?.destinationAuthority?.authorizeDestination !== 'function') {
        fail('invalid_destination_authority', 'an injected destination authority is required');
    }
}
/**
 * Create a payout request. No money moves here: the reservation is created by
 * `reservePayout` after the debt-priority decision.
 */
async function requestPayout(deps, input) {
    assertDeps(deps);
    const tenantId = requireBoundedString(input.tenantId, 'tenantId', exports.MAX_TENANT_LENGTH, 'invalid_tenant');
    const payoutId = requireBoundedString(input.payoutId, 'payoutId', exports.MAX_PAYOUT_ID_LENGTH, 'invalid_payout_id');
    const destinationRef = requireBoundedString(input.destinationRef, 'destinationRef', exports.MAX_DESTINATION_LENGTH, 'invalid_destination');
    const amountMinor = requirePositiveAmount(input.amountMinor);
    const currency = requireCurrency(input.currency);
    const idempotencyKey = requireBoundedString(input.idempotencyKey, 'idempotencyKey', exports.MAX_IDEMPOTENCY_KEY_LENGTH, 'invalid_idempotency_key');
    const requestedBy = optionalBoundedString(input.requestedBy, 'requestedBy', exports.MAX_ACTOR_LENGTH, 'invalid_actor');
    const createdAt = normalizeCreatedAt(input.createdAt);
    const payloadHash = hashRequestPayload({
        tenantId,
        payoutId,
        destinationRef,
        amountMinor,
        currency,
        requestedBy,
    });
    return deps.store.runAtomic(async (tx) => {
        const existing = checkedPayout(await tx.findByIdempotencyKey(tenantId, idempotencyKey), tenantId);
        if (existing !== null) {
            if (existing.payloadHash !== payloadHash) {
                fail('idempotency_conflict', 'payout idempotency key was reused with a different payload');
            }
            return { payout: existing, replayed: true };
        }
        await requireDestinationApproval(deps.destinationAuthority, {
            tenantId,
            payoutId,
            kind: 'payout',
            destinationRef,
            amountMinor,
            currency,
            version: 1,
            phase: 'request',
        });
        const payout = Object.freeze({
            payoutId,
            tenantId,
            destinationRef,
            amountMinor,
            currency,
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
        const inserted = await tx.insertPayout(payout);
        if (inserted === 'duplicate_key') {
            const raced = checkedPayout(await tx.findByIdempotencyKey(tenantId, idempotencyKey), tenantId);
            if (raced !== null) {
                if (raced.payloadHash !== payloadHash) {
                    fail('idempotency_conflict', 'payout idempotency key was reused with a different payload');
                }
                return { payout: raced, replayed: true };
            }
            fail('store_inconsistent', 'insert reported a duplicate that cannot be read inside the transaction');
        }
        await tx.writeAudit(auditFor(payout, null, requestedBy, null));
        return { payout, replayed: false };
    });
}
async function applyPayoutTransition(deps, options) {
    assertDeps(deps);
    const tenantId = requireBoundedString(options.tenantId, 'tenantId', exports.MAX_TENANT_LENGTH, 'invalid_tenant');
    const payoutId = requireBoundedString(options.payoutId, 'payoutId', exports.MAX_PAYOUT_ID_LENGTH, 'invalid_payout_id');
    const idempotencyKey = requireBoundedString(options.idempotencyKey, 'idempotencyKey', exports.MAX_IDEMPOTENCY_KEY_LENGTH, 'invalid_idempotency_key');
    const toStatus = requireStatus(options.toStatus);
    const actorId = optionalBoundedString(options.actorId, 'actorId', exports.MAX_ACTOR_LENGTH, 'invalid_actor');
    const reason = optionalBoundedString(options.reason, 'reason', exports.MAX_REASON_LENGTH, 'invalid_reason');
    const createdAt = normalizeCreatedAt(options.createdAt);
    const expectedVersion = options.expectedVersion === undefined
        ? undefined
        : requireSafeInteger(options.expectedVersion, 'expectedVersion');
    const transitionHash = hashTransitionPayload({
        tenantId,
        payoutId,
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
                fail('idempotency_conflict', 'payout transition key was reused with a different payload');
            }
            const payout = requirePayout(await tx.findPayoutForUpdate(tenantId, payoutId), tenantId);
            return { payout, transition: existing, replayed: true };
        }
        const payout = requirePayout(await tx.findPayoutForUpdate(tenantId, payoutId), tenantId);
        if (expectedVersion !== undefined && payout.version !== expectedVersion) {
            fail('version_conflict', 'payout version does not match the expected version');
        }
        const decision = evaluatePayoutTransition(payout.status, toStatus);
        if (!decision.allowed) {
            if (options.action === 'cancel' && payout.status === 'processing') {
                fail('payout_in_flight', 'a processing payout may still be in flight; it stays processing pending reconciliation and no hold is released');
            }
            fail('invalid_transition', `payout cannot move from ${payout.status} to ${toStatus}`);
        }
        if (decision.idempotent) {
            const noop = transitionRecord({
                payout,
                action: options.action,
                idempotencyKey,
                payloadHash: transitionHash,
                fromStatus: payout.status,
                toStatus,
                versionAfter: payout.version,
                reservationId: payout.reservationId,
                journalId: null,
                actorId,
                reason,
                createdAt,
            });
            const insertedNoop = await tx.insertTransition(noop);
            if (insertedNoop === 'duplicate_key') {
                fail('store_inconsistent', 'transition idempotency key was created concurrently');
            }
            await tx.writeAudit(auditFor(payout, null, actorId, reason));
            return { payout, transition: noop, replayed: true };
        }
        let effect;
        try {
            effect = await options.effect(tx, payout);
        }
        catch (error) {
            throw mapReservationError(error);
        }
        const updated = await tx.updateStatusCas({
            tenantId,
            payoutId,
            expectedVersion: payout.version,
            fromStatus: payout.status,
            toStatus,
            reservationId: effect.reservationId ?? payout.reservationId,
            providerReference: effect.providerReference ?? payout.providerReference,
            failureReason: effect.failureReason ?? payout.failureReason,
            cancellationReason: effect.cancellationReason ?? payout.cancellationReason,
            updatedAt: createdAt,
        });
        if (!updated.ok) {
            if (updated.reason === 'not_found')
                fail('payout_not_found', 'payout was not found');
            if (updated.reason === 'version_conflict') {
                fail('version_conflict', 'payout changed concurrently');
            }
            fail('invalid_transition', 'payout cannot move from its current state');
        }
        const transition = transitionRecord({
            payout: updated.payout,
            action: options.action,
            idempotencyKey,
            payloadHash: transitionHash,
            fromStatus: payout.status,
            toStatus,
            versionAfter: updated.payout.version,
            reservationId: updated.payout.reservationId,
            journalId: effect.journalId,
            actorId,
            reason,
            createdAt,
        });
        const inserted = await tx.insertTransition(transition);
        if (inserted === 'duplicate_key') {
            fail('store_inconsistent', 'transition idempotency key was created concurrently');
        }
        await tx.writeAudit(auditFor(updated.payout, effect.journalId, actorId, reason, effect.providerEvidence));
        return { payout: updated.payout, transition, replayed: false };
    });
}
function transitionRecord(input) {
    return Object.freeze({
        id: (0, node_crypto_1.randomUUID)(),
        tenantId: input.payout.tenantId,
        payoutId: input.payout.payoutId,
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
 * Move the requested amount from available to reserved, but only after the
 * accepted debt-priority decision. Existing reservations are never touched.
 */
function reservePayout(deps, input) {
    const tenantId = requireBoundedString(input.tenantId, 'tenantId', exports.MAX_TENANT_LENGTH, 'invalid_tenant');
    const availableAccountId = requireBoundedString(input.availableAccountId, 'availableAccountId', exports.MAX_ACCOUNT_ID_LENGTH, 'invalid_input');
    const reservedAccountId = requireBoundedString(input.reservedAccountId, 'reservedAccountId', exports.MAX_ACCOUNT_ID_LENGTH, 'invalid_input');
    // Server clock in UTC epoch SECONDS (the unit of every stored due_at and of
    // `now` in decideWithdrawalPriority). The domain's pre-existing default
    // source (`Date.now()`) is kept, converted from milliseconds to seconds.
    const now = input.now === undefined ? Math.floor(Date.now() / 1000) : requireSafeSecond(input.now, 'now');
    return applyPayoutTransition(deps, {
        tenantId,
        payoutId: input.payoutId,
        idempotencyKey: input.idempotencyKey,
        action: 'reserve',
        toStatus: 'reserved',
        expectedVersion: input.expectedVersion,
        actorId: input.actorId,
        payloadExtra: `${availableAccountId}\u0000${reservedAccountId}`,
        createdAt: input.createdAt,
        effect: async (tx, payout) => {
            await requireDestinationApproval(deps.destinationAuthority, {
                tenantId,
                payoutId: payout.payoutId,
                kind: 'payout',
                destinationRef: payout.destinationRef,
                amountMinor: payout.amountMinor,
                currency: payout.currency,
                version: payout.version,
                phase: 'reserve',
            });
            const available = requireMerchantAvailableAccount(await tx.getAccount(tenantId, availableAccountId), tenantId, payout.currency);
            const debts = await tx.listDueSubscriptionDebts(tenantId, payout.currency, {
                limit: exports.DEBT_SCAN_LIMIT,
                asOfSeconds: now,
            });
            if (debts.truncated) {
                fail('priority_scan_truncated', 'due subscription debt scan was truncated; refusing a new reservation');
            }
            const existing = await tx.listActiveReservations(tenantId, payout.currency, {
                limit: exports.RESERVATION_SCAN_LIMIT,
            });
            const priority = (0, billing_collection_1.decideWithdrawalPriority)({
                tenantId,
                currency: payout.currency,
                requestedAmountMinor: payout.amountMinor,
                merchantAvailableMinor: available.balanceMinor,
                debts: debts.debts,
                existingReservations: existing.reservations,
                now,
            });
            if (!priority.allowed) {
                if (priority.reason === 'subscription_debt_due') {
                    fail('subscription_debt_due', 'a subscription debt is due; a new withdrawal waits');
                }
                fail('insufficient_available', 'merchant_available is below the requested payout amount');
            }
            const reserved = await deps.ledger.reserve(tx, {
                tenantId,
                reservationKey: payoutReservationKey(payout.payoutId),
                currency: payout.currency,
                amountMinor: payout.amountMinor,
                availableAccountId,
                reservedAccountId,
                reference: `payout:${payout.payoutId}`,
                description: 'payout reservation',
                createdAt: normalizeCreatedAt(input.createdAt),
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
/** Record that the external transfer step started. No provider call is made. */
function startPayoutProcessing(deps, input) {
    return applyPayoutTransition(deps, {
        tenantId: input.tenantId,
        payoutId: input.payoutId,
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
function preflightPayoutInput(input) {
    requireBoundedString(input.tenantId, 'tenantId', exports.MAX_TENANT_LENGTH, 'invalid_tenant');
    requireBoundedString(input.payoutId, 'payoutId', exports.MAX_PAYOUT_ID_LENGTH, 'invalid_payout_id');
    requireBoundedString(input.idempotencyKey, 'idempotencyKey', exports.MAX_IDEMPOTENCY_KEY_LENGTH, 'invalid_idempotency_key');
    optionalBoundedString(input.actorId, 'actorId', exports.MAX_ACTOR_LENGTH, 'invalid_actor');
    optionalBoundedString(input.reason, 'reason', exports.MAX_REASON_LENGTH, 'invalid_reason');
    normalizeCreatedAt(input.createdAt);
    if (input.expectedVersion !== undefined)
        requireSafeInteger(input.expectedVersion, 'expectedVersion');
    const evidenceReference = optionalBoundedString(input.evidenceReference, 'evidenceReference', exports.MAX_EVIDENCE_REFERENCE_LENGTH, 'invalid_input');
    // Conservative opaque-token charset; control characters are rejected.
    if ((typeof input.evidenceReference === 'string' && CONTROL_CHARACTERS.test(input.evidenceReference))
        || (evidenceReference !== null && !EVIDENCE_REFERENCE_PATTERN.test(evidenceReference))) {
        fail('invalid_input', 'evidenceReference may contain only letters, digits and . _ : / -');
    }
    return evidenceReference;
}
/**
 * EXTERNAL CALL OUTSIDE THE TRANSACTION: a plain non-locking snapshot read
 * tells whether the payout is processing; only then the injected verifier is
 * consulted, BEFORE the locking transaction opens. No verifier call is made
 * for any non-processing payout or a stale expected version.
 */
async function verifyProcessingPayoutOutcome(deps, input, claimedOutcome, evidenceReference, callerProviderReference) {
    const snapshot = await deps.store.runAtomic(async (tx) => typeof tx.findPayoutSnapshot === 'function'
        ? tx.findPayoutSnapshot(input.tenantId, input.payoutId)
        : null);
    if (snapshot === null
        || snapshot.tenantId !== input.tenantId
        || snapshot.payoutId !== input.payoutId
        || snapshot.status !== 'processing'
        || (input.expectedVersion !== undefined && snapshot.version !== input.expectedVersion)) {
        return null;
    }
    const outcome = await readProviderOutcomeVerdict(deps.providerOutcomeVerifier, {
        tenantId: snapshot.tenantId,
        requestId: snapshot.payoutId,
        kind: 'payout',
        claimedOutcome,
        evidenceReference,
        amountMinor: snapshot.amountMinor,
        currency: snapshot.currency,
        destinationRef: snapshot.destinationRef,
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
function requireAttestedPayoutOutcome(pre, payout, verdict, what) {
    if (pre === null
        || pre.outcome.verdict !== verdict
        || pre.snapshot.tenantId !== payout.tenantId
        || pre.snapshot.payoutId !== payout.payoutId
        || pre.snapshot.version !== payout.version
        || pre.snapshot.amountMinor !== payout.amountMinor
        || pre.snapshot.currency !== payout.currency
        || pre.snapshot.destinationRef !== payout.destinationRef
        || pre.snapshot.payloadHash !== payout.payloadHash) {
        fail('provider_outcome_unverified', `a processing payout requires ${what}, attested by the injected verifier for this exact unchanged request before the transaction; nothing was consumed or released`);
    }
    return pre.outcome;
}
/**
 * Consume the payout reservation exactly once into a platform-side counter
 * account, but ONLY after the injected verifier attested a definitive provider
 * success bound to this exact request (tenant, payout, provider account,
 * amount, currency, immutable destination snapshot/version). Absent,
 * uncertain, unavailable, throwing or non-echoing verifier => typed
 * `provider_outcome_unverified`, no consumption, payout stays `processing`.
 * The accepted `consumeReservation` refuses a merchant-side target.
 */
async function confirmPayout(deps, input) {
    assertDeps(deps);
    const counterAccountId = requireBoundedString(input.counterAccountId, 'counterAccountId', exports.MAX_ACCOUNT_ID_LENGTH, 'invalid_input');
    const providerReference = optionalBoundedString(input.providerReference, 'providerReference', exports.MAX_ACTOR_LENGTH, 'invalid_input');
    const evidenceReference = preflightPayoutInput(input);
    const pre = await verifyProcessingPayoutOutcome(deps, { tenantId: input.tenantId, payoutId: input.payoutId, expectedVersion: input.expectedVersion }, 'success', evidenceReference, providerReference);
    return applyPayoutTransition(deps, {
        tenantId: input.tenantId,
        payoutId: input.payoutId,
        idempotencyKey: input.idempotencyKey,
        action: 'confirm',
        toStatus: 'confirmed',
        expectedVersion: input.expectedVersion,
        actorId: input.actorId,
        payloadExtra: `${counterAccountId}\u0000${providerReference ?? ''}`,
        createdAt: input.createdAt,
        effect: async (tx, payout) => {
            // Provider success must be attested for this exact unchanged request
            // BEFORE anything is consumed.
            const attested = requireAttestedPayoutOutcome(pre, payout, 'definite_success', 'a definitive provider success');
            if (payout.reservationId === null) {
                fail('reservation_not_found', 'payout has no reservation to consume');
            }
            // Re-check the immutable request snapshot and destination BEFORE any
            // consumption. An unknown/in-flight outcome never reaches here.
            verifyPayoutSnapshot(payout);
            const authorizedCounterId = await requireAuthorizedCounterAccount(deps.destinationAuthority, {
                tenantId: payout.tenantId,
                payoutId: payout.payoutId,
                kind: 'payout',
                destinationRef: payout.destinationRef,
                amountMinor: payout.amountMinor,
                currency: payout.currency,
                version: payout.version,
                phase: 'confirm',
                counterAccountId,
            });
            requirePlatformCashCounterAccount(await tx.getAccount(payout.tenantId, authorizedCounterId), payout.tenantId, payout.currency);
            const reservation = await tx.getReservation(payout.tenantId, payout.reservationId);
            if (reservation === null
                || reservation.tenantId !== payout.tenantId
                || reservation.currency !== payout.currency
                || reservation.amountMinor !== payout.amountMinor) {
                fail('reservation_state_invalid', 'the payout reservation does not match the locked payout snapshot');
            }
            const consumed = await deps.ledger.consume(tx, {
                tenantId: payout.tenantId,
                reservationId: payout.reservationId,
                counterAccountId: authorizedCounterId,
                createdAt: normalizeCreatedAt(input.createdAt),
            });
            return {
                reservationId: payout.reservationId,
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
/** Release a reserved/processing hold exactly once. Idempotent on replay. */
async function failPayout(deps, input) {
    assertDeps(deps);
    /*
     * EXTERNAL CALL OUTSIDE THE TRANSACTION (see verifyProcessingPayoutOutcome).
     * Inside the transaction the locked row is re-read and the attestation is
     * honoured only if it is bound to the exact unchanged request and its
     * verdict is a definite failure.
     */
    const preEvidenceReference = preflightPayoutInput(input);
    const pre = await verifyProcessingPayoutOutcome(deps, { tenantId: input.tenantId, payoutId: input.payoutId, expectedVersion: input.expectedVersion }, 'failed', preEvidenceReference, null);
    return applyPayoutTransition(deps, {
        tenantId: input.tenantId,
        payoutId: input.payoutId,
        idempotencyKey: input.idempotencyKey,
        action: 'fail',
        toStatus: 'failed',
        expectedVersion: input.expectedVersion,
        actorId: input.actorId,
        reason: input.reason,
        payloadExtra: input.reason ?? '',
        createdAt: input.createdAt,
        effect: async (tx, payout) => {
            const failureReason = optionalBoundedString(input.reason, 'reason', exports.MAX_REASON_LENGTH, 'invalid_reason');
            // A processing payout may have an external transfer in flight: only
            // a definite attested provider failure may release the hold. The
            // caller's reason text is never evidence; unknown/unavailable stays
            // processing for reconciliation.
            let providerEvidence;
            if (payout.status === 'processing') {
                requireAttestedPayoutOutcome(pre, payout, 'definite_failure', 'a definite provider failure');
                providerEvidence = {
                    providerVerdict: 'definite_failure',
                    evidenceReference: preEvidenceReference,
                };
            }
            if (payout.reservationId === null) {
                return {
                    reservationId: null,
                    journalId: null,
                    providerReference: null,
                    failureReason,
                    cancellationReason: null,
                    ...(providerEvidence === undefined ? {} : { providerEvidence }),
                };
            }
            const released = await deps.ledger.release(tx, {
                tenantId: payout.tenantId,
                reservationId: payout.reservationId,
                createdAt: normalizeCreatedAt(input.createdAt),
            });
            return {
                reservationId: payout.reservationId,
                journalId: released.journal.id,
                providerReference: null,
                failureReason,
                cancellationReason: null,
                ...(providerEvidence === undefined ? {} : { providerEvidence }),
            };
        },
    });
}
/**
 * Cancel a requested/reserved payout; its hold is released once. A `processing`
 * payout may be cancelled only when the injected verifier attests a final
 * non-executed/non-settled provider cancellation bound to this exact request;
 * otherwise it stays `processing` (typed `provider_outcome_unverified`,
 * reconciliation required) and no hold is released.
 */
async function cancelPayout(deps, input) {
    assertDeps(deps);
    const evidenceReference = preflightPayoutInput(input);
    const pre = await verifyProcessingPayoutOutcome(deps, { tenantId: input.tenantId, payoutId: input.payoutId, expectedVersion: input.expectedVersion }, 'cancelled', evidenceReference, null);
    return applyPayoutTransition(deps, {
        tenantId: input.tenantId,
        payoutId: input.payoutId,
        idempotencyKey: input.idempotencyKey,
        action: 'cancel',
        toStatus: 'cancelled',
        expectedVersion: input.expectedVersion,
        actorId: input.actorId,
        reason: input.reason,
        payloadExtra: input.reason ?? '',
        createdAt: input.createdAt,
        effect: async (tx, payout) => {
            const cancellationReason = optionalBoundedString(input.reason, 'reason', exports.MAX_REASON_LENGTH, 'invalid_reason');
            let providerEvidence;
            if (payout.status === 'processing') {
                requireAttestedPayoutOutcome(pre, payout, 'definite_cancellation', 'a definitive provider cancellation (final non-executed/non-settled outcome)');
                providerEvidence = { providerVerdict: 'definite_cancellation', evidenceReference };
            }
            if (payout.reservationId === null) {
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
                tenantId: payout.tenantId,
                reservationId: payout.reservationId,
                createdAt: normalizeCreatedAt(input.createdAt),
            });
            return {
                reservationId: payout.reservationId,
                journalId: released.journal.id,
                providerReference: null,
                failureReason: null,
                cancellationReason,
                ...(providerEvidence === undefined ? {} : { providerEvidence }),
            };
        },
    });
}
async function listPayouts(store, input) {
    if (typeof store?.runAtomic !== 'function')
        fail('invalid_input', 'store must expose runAtomic');
    const tenantId = requireBoundedString(input.tenantId, 'tenantId', exports.MAX_TENANT_LENGTH, 'invalid_tenant');
    const limit = input.limit === undefined ? exports.DEFAULT_LIST_LIMIT : input.limit;
    if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1 || limit > exports.MAX_LIST_LIMIT) {
        fail('invalid_input', `limit must be a safe integer between 1 and ${exports.MAX_LIST_LIMIT}`);
    }
    const status = input.status === undefined ? undefined : requireStatus(input.status);
    return store.runAtomic((tx) => tx.listPayouts(tenantId, { limit, status }));
}
