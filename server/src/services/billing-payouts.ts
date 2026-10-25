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

import { createHash, randomUUID } from 'node:crypto';
import {
    MAX_AMOUNT_MINOR as LEDGER_MAX_AMOUNT_MINOR,
    postJournalInTransaction,
    reverseJournal as reverseJournalAccepted,
    type JournalRecord,
    type LedgerStore,
    type LedgerTransaction,
    type PostJournalInput,
    type PostJournalResult,
    type ReverseJournalInput,
} from './billing-ledger';
import {
    consumeReservation,
    releaseReservation,
    reserveFunds,
    ReservationError,
    type ConsumeReservationInput,
    type ReleaseReservationInput,
    type ReservationRecord,
    type ReservationStore,
    type ReservationTransaction,
    type ReservationTransitionResult,
    type ReserveFundsInput,
} from './billing-reservations';
import { decideWithdrawalPriority, type SubscriptionDebt } from './billing-collection';

/* =========================================================================
 * Constants and errors
 * ========================================================================= */

export const PAYOUT_STATUSES = [
    'requested',
    'reserved',
    'processing',
    'confirmed',
    'failed',
    'cancelled',
] as const;
export type PayoutStatus = (typeof PAYOUT_STATUSES)[number];

export const PAYOUT_ACTIONS = ['request', 'reserve', 'process', 'confirm', 'fail', 'cancel'] as const;
export type PayoutAction = (typeof PAYOUT_ACTIONS)[number];

export const TERMINAL_PAYOUT_STATUSES: readonly PayoutStatus[] = Object.freeze([
    'confirmed',
    'failed',
    'cancelled',
]);

export const MAX_PAYOUT_AMOUNT_MINOR = LEDGER_MAX_AMOUNT_MINOR;
export const MAX_TENANT_LENGTH = 36;
export const MAX_PAYOUT_ID_LENGTH = 64;
export const MAX_DESTINATION_LENGTH = 200;
export const MAX_IDEMPOTENCY_KEY_LENGTH = 128;
export const MAX_ACTOR_LENGTH = 128;
export const MAX_REASON_LENGTH = 500;
/** Opaque caller reference to provider evidence; never a free-form reason. */
export const MAX_EVIDENCE_REFERENCE_LENGTH = 200;
export const MAX_ACCOUNT_ID_LENGTH = 36;
export const MAX_LIST_LIMIT = 1_000;
export const DEFAULT_LIST_LIMIT = 200;
export const DEBT_SCAN_LIMIT = 500;
export const RESERVATION_SCAN_LIMIT = 500;

const CURRENCY_PATTERN = /^[A-Z]{3}$/;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/;
const EVIDENCE_REFERENCE_PATTERN = /^[A-Za-z0-9._:/-]+$/;

export type PayoutErrorCode =
    | 'invalid_input'
    | 'invalid_tenant'
    | 'invalid_payout_id'
    | 'invalid_destination'
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
    | 'payout_not_found'
    | 'payout_exists'
    | 'idempotency_conflict'
    | 'version_conflict'
    | 'destination_denied'
    | 'destination_unavailable'
    | 'destination_snapshot_mismatch'
    | 'counter_account_mismatch'
    | 'payout_in_flight'
    | 'debt_source_unavailable'
    | 'invalid_destination_authority'
    | 'account_not_found'
    | 'account_kind_mismatch'
    | 'tenant_mismatch'
    | 'currency_mismatch'
    | 'insufficient_available'
    | 'subscription_debt_due'
    | 'priority_scan_truncated'
    | 'provider_outcome_unverified'
    | 'reservation_not_found'
    | 'reservation_state_invalid'
    | 'already_consumed'
    | 'store_inconsistent';

export class PayoutError extends Error {
    constructor(
        public readonly code: PayoutErrorCode,
        message: string,
    ) {
        super(message);
        this.name = 'PayoutError';
    }
}

function fail(code: PayoutErrorCode, message: string): never {
    throw new PayoutError(code, message);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireBoundedString(
    value: unknown,
    field: string,
    maxLength: number,
    code: PayoutErrorCode = 'invalid_input',
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
    code: PayoutErrorCode = 'invalid_input',
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
    if (value > MAX_PAYOUT_AMOUNT_MINOR) {
        fail('amount_out_of_range', `${field} exceeds ${MAX_PAYOUT_AMOUNT_MINOR.toString()}`);
    }
    return value;
}

function requireSafeInteger(value: unknown, field: string): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
        fail('invalid_version', `${field} must be a non-negative safe integer`);
    }
    return value;
}

function requireSafeSecond(value: unknown, field: string): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
        fail('invalid_timestamp', `${field} must be a non-negative safe integer second`);
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

function requireStatus(value: unknown): PayoutStatus {
    if (typeof value !== 'string' || !(PAYOUT_STATUSES as readonly string[]).includes(value)) {
        fail('invalid_status', 'unknown payout status');
    }
    return value as PayoutStatus;
}

export function serializePayoutAmountMinor(value: bigint): string {
    if (typeof value !== 'bigint') fail('invalid_amount', 'amount must be a bigint of minor units');
    return value.toString();
}

/* =========================================================================
 * State machine
 * ========================================================================= */

const LEGAL_PAYOUT_TRANSITIONS: Readonly<Record<PayoutStatus, readonly PayoutStatus[]>> = Object.freeze({
    requested: ['reserved', 'cancelled'],
    reserved: ['processing', 'failed', 'cancelled'],
    processing: ['confirmed', 'failed', 'cancelled'],
    confirmed: [],
    failed: [],
    cancelled: [],
});

export interface PayoutTransitionDecision {
    readonly allowed: boolean;
    readonly idempotent: boolean;
    readonly reason: 'unknown-status' | 'illegal-transition' | null;
}

/** Repeating the current status is an idempotent no-op; anything else must be legal. */
export function evaluatePayoutTransition(from: unknown, to: unknown): PayoutTransitionDecision {
    let fromStatus: PayoutStatus;
    let toStatus: PayoutStatus;
    try {
        fromStatus = requireStatus(from);
        toStatus = requireStatus(to);
    } catch {
        return { allowed: false, idempotent: false, reason: 'unknown-status' };
    }
    if (fromStatus === toStatus) return { allowed: true, idempotent: true, reason: null };
    return LEGAL_PAYOUT_TRANSITIONS[fromStatus].includes(toStatus)
        ? { allowed: true, idempotent: false, reason: null }
        : { allowed: false, idempotent: false, reason: 'illegal-transition' };
}

export function isTerminalPayoutStatus(status: PayoutStatus): boolean {
    return TERMINAL_PAYOUT_STATUSES.includes(status);
}

/* =========================================================================
 * Public rows
 * ========================================================================= */

export interface PayoutRequest {
    readonly payoutId: string;
    readonly tenantId: string;
    /** Opaque bounded destination authority reference; never a card/PAN. */
    readonly destinationRef: string;
    readonly amountMinor: bigint;
    readonly currency: string;
    readonly status: PayoutStatus;
    readonly reservationId: string | null;
    readonly version: number;
    readonly idempotencyKey: string;
    readonly payloadHash: string;
    readonly requestedBy: string | null;
    /** Opaque provider transfer reference, recorded only after proof. */
    readonly providerReference: string | null;
    readonly failureReason: string | null;
    readonly cancellationReason: string | null;
    readonly createdAt: string;
    readonly updatedAt: string;
}

export interface PayoutTransitionRecord {
    readonly id: string;
    readonly tenantId: string;
    readonly payoutId: string;
    readonly action: PayoutAction;
    readonly idempotencyKey: string;
    readonly payloadHash: string;
    readonly fromStatus: PayoutStatus;
    readonly toStatus: PayoutStatus;
    readonly versionAfter: number;
    readonly reservationId: string | null;
    readonly journalId: string | null;
    readonly actorId: string | null;
    readonly reason: string | null;
    readonly createdAt: string;
}

export interface PayoutPage {
    readonly payouts: readonly PayoutRequest[];
    readonly truncated: boolean;
}

export interface SubscriptionDebtPage {
    readonly debts: readonly SubscriptionDebt[];
    readonly truncated: boolean;
}

export interface ActiveReservationPage {
    readonly reservations: readonly ReservationRecord[];
    readonly truncated: boolean;
}

/* =========================================================================
 * Ledger port (accepted FIN3 domain)
 * ========================================================================= */

/**
 * Injected bridge to the accepted ledger/reservation domain. Tests implement
 * it with the REAL accepted functions over their stateful in-memory store, so
 * no reservation/journal arithmetic is reimplemented here.
 */
export interface LedgerPort<Tx extends ReservationTransaction = ReservationTransaction> {
    reserve(tx: Tx, input: ReserveFundsInput): Promise<ReservationTransitionResult>;
    release(tx: Tx, input: ReleaseReservationInput): Promise<ReservationTransitionResult>;
    consume(tx: Tx, input: ConsumeReservationInput): Promise<ReservationTransitionResult>;
    postJournal(tx: LedgerTransaction, input: PostJournalInput): Promise<PostJournalResult>;
    reverseJournal(tx: LedgerTransaction, input: ReverseJournalInput): Promise<PostJournalResult>;
}

/**
 * Production wiring for the port: it calls the accepted FIN3 functions with a
 * one-hop store whose `runAtomic` reuses the caller's open transaction. This
 * keeps every reservation/journal write on the SAME transaction as the payout
 * row and its sealed audit.
 */
export function acceptedLedgerPort<Tx extends ReservationTransaction>(): LedgerPort<Tx> {
    const reservationStore = (tx: Tx): ReservationStore => ({
        runAtomic: <R>(callback: (inner: ReservationTransaction) => Promise<R>): Promise<R> => callback(tx),
    });
    const ledgerStore = (tx: LedgerTransaction): LedgerStore<LedgerTransaction> => ({
        runAtomic: <R>(callback: (inner: LedgerTransaction) => Promise<R>): Promise<R> => callback(tx),
    });
    return {
        reserve: (tx, input) => reserveFunds(reservationStore(tx), input),
        release: (tx, input) => releaseReservation(reservationStore(tx), input),
        consume: (tx, input) => consumeReservation(reservationStore(tx), input),
        postJournal: (tx, input) => postJournalInTransaction(tx, input),
        reverseJournal: (tx, input) => reverseJournalAccepted(ledgerStore(tx), input),
    };
}

/* =========================================================================
 * Destination authority (HELD policy, fail-closed)
 * ========================================================================= */

export interface DestinationAuthorityRequest {
    readonly tenantId: string;
    /** Payout id, or refund id when `kind` is `refund`. */
    readonly payoutId: string;
    readonly kind: 'payout' | 'refund';
    readonly destinationRef: string;
    readonly amountMinor: bigint;
    readonly currency: string;
    /** Version of the immutable locked payout/refund snapshot being checked. */
    readonly version: number;
    readonly phase: 'request' | 'reserve' | 'confirm' | 'complete';
    /**
     * Caller-presented platform counter account for `confirm`/`complete`. The
     * authority must echo the SAME authorized account in its decision; a caller
     * value is never itself authority.
     */
    readonly counterAccountId?: string | null;
}

export interface DestinationAuthorityDecision {
    readonly allowed: boolean;
    readonly reason?: string | null;
    /**
     * Required for `confirm`/`complete`: the platform-side counter account the
     * authority authorizes (merchant payout/refund must consume into
     * `platform_cash` only). Missing means the port cannot authorize a counter
     * account and the result is `destination_unavailable`, never approved.
     */
    readonly counterAccountId?: string | null;
}

/**
 * Who may set a payout destination is NOT settled. The policy is injected and
 * must return an explicit allow. Missing, malformed or `allowed !== true`
 * decisions deny; there is no default-allow path.
 */
export interface DestinationAuthority {
    authorizeDestination(
        request: DestinationAuthorityRequest,
    ): Promise<DestinationAuthorityDecision> | DestinationAuthorityDecision;
}

/* =========================================================================
 * Provider outcome verification (HELD policy, fail-closed)
 * ========================================================================= */

/**
 * The only answers that may consume (success) or release (failure /
 * cancellation) a processing payout/refund hold. Anything else (unknown,
 * unavailable, malformed, non-echoing or a throwing port) keeps the request in
 * `processing` for reconciliation; a caller-supplied reason or reference is
 * NOT evidence.
 */
export type ProviderOutcomeVerdict =
    | 'definite_success'
    | 'definite_failure'
    | 'definite_cancellation'
    | 'unknown'
    | 'unavailable';

/** The outcome the caller claims; the verifier alone decides whether it holds. */
export type ProviderClaimedOutcome = 'success' | 'failed' | 'cancelled';

const VERDICT_BY_CLAIM: Readonly<Record<ProviderClaimedOutcome, ProviderOutcomeVerdict>> = Object.freeze({
    success: 'definite_success',
    failed: 'definite_failure',
    cancelled: 'definite_cancellation',
});

export interface ProviderOutcomeVerificationRequest {
    readonly tenantId: string;
    /** Payout id, or refund id when `kind` is `refund`. */
    readonly requestId: string;
    readonly kind: 'payout' | 'refund';
    readonly claimedOutcome: ProviderClaimedOutcome;
    /** Opaque reference to provider evidence; never a free-form reason. */
    readonly evidenceReference: string | null;
    /** Exact amount/currency of the non-locking snapshot the verdict is bound to. */
    readonly amountMinor: bigint;
    readonly currency: string;
    /** Destination (payout destinationRef / refund originalReference). */
    readonly destinationRef: string;
    /** Sealed request hash: the immutable destination/amount snapshot identity. */
    readonly destinationSnapshotHash: string;
    /** Version of the request row the verdict is bound to. */
    readonly requestVersion: number;
    /** Caller-presented provider reference (success only); never authority. */
    readonly callerProviderReference: string | null;
}

/**
 * What the trusted port must return. The answer is accepted only when it
 * echoes the exact request (tenant, request id, kind, claimed outcome,
 * amount, currency, snapshot hash, version) AND its verdict is the one that
 * matches the claim. For a success the port must also attest the provider
 * account and a definitive success reference (bounded opaque tokens).
 */
export interface ProviderOutcomeAttestation {
    readonly verdict: ProviderOutcomeVerdict;
    readonly tenantId: string;
    readonly requestId: string;
    readonly kind: 'payout' | 'refund';
    readonly claimedOutcome: ProviderClaimedOutcome;
    readonly amountMinor: bigint;
    readonly currency: string;
    readonly destinationSnapshotHash: string;
    readonly requestVersion: number;
    /** Success only: opaque provider/account identity the transfer settled on. */
    readonly providerAccountRef?: string | null;
    /** Success only: opaque definitive provider success reference. */
    readonly successReference?: string | null;
}

/**
 * Who can prove a provider outcome. The port is injected; absence, a thrown
 * error, a bare string, a non-echoing answer or any non-definite verdict fails
 * closed as `provider_outcome_unverified`. No provider integration exists here.
 */
export interface ProviderOutcomeVerifier {
    verifyProviderOutcome(
        request: ProviderOutcomeVerificationRequest,
    ): Promise<ProviderOutcomeAttestation> | ProviderOutcomeAttestation;
}

/** Normalized verifier result; `verdict` is definite only when fully bound. */
export interface VerifiedProviderOutcome {
    readonly verdict: ProviderOutcomeVerdict;
    readonly providerAccountRef: string | null;
    readonly successReference: string | null;
}

const UNAVAILABLE_OUTCOME: VerifiedProviderOutcome = Object.freeze({
    verdict: 'unavailable',
    providerAccountRef: null,
    successReference: null,
});
const UNKNOWN_OUTCOME: VerifiedProviderOutcome = Object.freeze({
    verdict: 'unknown',
    providerAccountRef: null,
    successReference: null,
});

function boundedOpaqueToken(value: unknown): string | null {
    if (
        typeof value !== 'string'
        || value.length === 0
        || value.length > MAX_EVIDENCE_REFERENCE_LENGTH
        || !EVIDENCE_REFERENCE_PATTERN.test(value)
    ) {
        return null;
    }
    return value;
}

/**
 * Normalize any verifier behaviour into a closed, request-bound result. The
 * verdict source is ONLY the port's return value; it must echo the request.
 */
export async function readProviderOutcomeVerdict(
    verifier: ProviderOutcomeVerifier | undefined,
    request: ProviderOutcomeVerificationRequest,
): Promise<VerifiedProviderOutcome> {
    if (verifier === undefined || typeof verifier?.verifyProviderOutcome !== 'function') {
        return UNAVAILABLE_OUTCOME;
    }
    let answer: unknown;
    try {
        answer = await verifier.verifyProviderOutcome(request);
    } catch {
        return UNAVAILABLE_OUTCOME;
    }
    if (!isRecord(answer)) return UNKNOWN_OUTCOME;
    const verdict = answer['verdict'];
    if (verdict === 'unavailable') return UNAVAILABLE_OUTCOME;
    if (verdict !== VERDICT_BY_CLAIM[request.claimedOutcome]) return UNKNOWN_OUTCOME;
    if (
        answer['tenantId'] !== request.tenantId
        || answer['requestId'] !== request.requestId
        || answer['kind'] !== request.kind
        || answer['claimedOutcome'] !== request.claimedOutcome
        || answer['amountMinor'] !== request.amountMinor
        || answer['currency'] !== request.currency
        || answer['destinationSnapshotHash'] !== request.destinationSnapshotHash
        || answer['requestVersion'] !== request.requestVersion
    ) {
        return UNKNOWN_OUTCOME;
    }
    if (request.claimedOutcome !== 'success') {
        return Object.freeze({ verdict: verdict as ProviderOutcomeVerdict, providerAccountRef: null, successReference: null });
    }
    const providerAccountRef = boundedOpaqueToken(answer['providerAccountRef']);
    const successReference = boundedOpaqueToken(answer['successReference']);
    if (providerAccountRef === null || successReference === null) return UNKNOWN_OUTCOME;
    if (request.callerProviderReference !== null && request.callerProviderReference !== successReference) {
        return UNKNOWN_OUTCOME;
    }
    return Object.freeze({ verdict: 'definite_success' as const, providerAccountRef, successReference });
}

export function isDefiniteProviderOutcome(verdict: ProviderOutcomeVerdict): boolean {
    return verdict === 'definite_success' || verdict === 'definite_failure' || verdict === 'definite_cancellation';
}

async function requireDestinationApproval(
    authority: DestinationAuthority,
    request: DestinationAuthorityRequest,
): Promise<void> {
    const decision: unknown = await authority.authorizeDestination(request);
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
async function requireAuthorizedCounterAccount(
    authority: DestinationAuthority | undefined,
    request: DestinationAuthorityRequest,
): Promise<string> {
    if (typeof authority?.authorizeDestination !== 'function') {
        fail('destination_unavailable', 'no destination authority port is available for counter-account confirmation');
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

/** Merchant payouts/refunds may only consume reserved liability into platform cash. */
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
            'merchant payout/refund consumption may only credit platform_cash; platform_receivable is for subscription debt settlement',
        );
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
export const PAYOUT_STORE_SQL_CONTRACT: readonly string[] = Object.freeze([
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

export interface UpdatePayoutStatusCasInput {
    readonly tenantId: string;
    readonly payoutId: string;
    readonly expectedVersion: number;
    readonly fromStatus: PayoutStatus;
    readonly toStatus: PayoutStatus;
    readonly reservationId: string | null;
    readonly providerReference: string | null;
    readonly failureReason: string | null;
    readonly cancellationReason: string | null;
    readonly updatedAt: string;
}

export type UpdatePayoutStatusCasResult =
    | { readonly ok: true; readonly payout: PayoutRequest }
    | { readonly ok: false; readonly reason: 'not_found' | 'version_conflict' | 'invalid_transition' };

export type InsertPayoutResult = 'inserted' | 'duplicate_key';

export interface PayoutTransaction extends ReservationTransaction {
    findByIdempotencyKey(tenantId: string, idempotencyKey: string): Promise<PayoutRequest | null>;
    findPayoutForUpdate(tenantId: string, payoutId: string): Promise<PayoutRequest | null>;
    /**
     * OPTIONAL plain NON-LOCKING read of one payout (no FOR UPDATE). It lets a
     * transition that must consult the external provider verifier learn the
     * current status BEFORE the locking transaction opens, so the external
     * call never runs while the payout row is locked. When a store does not
     * implement it, a processing-payout release fails closed as
     * `provider_outcome_unverified` (no verdict could be obtained outside the
     * transaction).
     */
    findPayoutSnapshot?(tenantId: string, payoutId: string): Promise<PayoutRequest | null>;
    insertPayout(payout: PayoutRequest): Promise<InsertPayoutResult>;
    updateStatusCas(input: UpdatePayoutStatusCasInput): Promise<UpdatePayoutStatusCasResult>;
    findTransitionByIdempotencyKey(
        tenantId: string,
        idempotencyKey: string,
    ): Promise<PayoutTransitionRecord | null>;
    insertTransition(record: PayoutTransitionRecord): Promise<'inserted' | 'duplicate_key'>;
    listDueSubscriptionDebts(
        tenantId: string,
        currency: string,
        query?: {
            readonly limit?: number;
            /**
             * Server clock (UTC epoch SECONDS) supplied by the payout domain.
             * Absent or invalid => the adapter reports `debt_source_unavailable`;
             * the adapter never invents a time source.
             */
            readonly asOfSeconds: number;
        },
    ): Promise<SubscriptionDebtPage>;
    listActiveReservations(
        tenantId: string,
        currency: string,
        query?: { readonly limit?: number },
    ): Promise<ActiveReservationPage>;
    listPayouts(
        tenantId: string,
        query?: { readonly limit?: number; readonly status?: PayoutStatus },
    ): Promise<PayoutPage>;
    writeAudit(record: PayoutAuditRecord): Promise<void>;
}

export interface PayoutStore<Tx extends PayoutTransaction = PayoutTransaction> {
    runAtomic<T>(callback: (tx: Tx) => Promise<T>): Promise<T>;
}

/* =========================================================================
 * Audit contract
 * ========================================================================= */

export type PayoutAuditAction =
    | 'billing.payout.requested'
    | 'billing.payout.reserved'
    | 'billing.payout.processing'
    | 'billing.payout.confirmed'
    | 'billing.payout.failed'
    | 'billing.payout.cancelled';

export interface PayoutAuditRecord {
    readonly action: PayoutAuditAction;
    readonly tenantId: string;
    readonly payoutId: string;
    readonly status: PayoutStatus;
    readonly version: number;
    readonly amountMinor: string;
    readonly currency: string;
    readonly reservationId: string | null;
    readonly journalId: string | null;
    readonly actorId: string | null;
    readonly reason: string | null;
    /**
     * Present only for a release out of `processing`: the provider verdict that
     * authorised it and the opaque (bounded, non-secret) evidence reference.
     */
    readonly providerVerdict?: ProviderOutcomeVerdict;
    readonly evidenceReference?: string | null;
    /** Success only: attested opaque provider account and success reference. */
    readonly providerAccountRef?: string | null;
    readonly successReference?: string | null;
}

const AUDIT_ACTION_BY_STATUS: Readonly<Record<PayoutStatus, PayoutAuditAction>> = Object.freeze({
    requested: 'billing.payout.requested',
    reserved: 'billing.payout.reserved',
    processing: 'billing.payout.processing',
    confirmed: 'billing.payout.confirmed',
    failed: 'billing.payout.failed',
    cancelled: 'billing.payout.cancelled',
});

export interface PayoutProviderEvidence {
    readonly providerVerdict: ProviderOutcomeVerdict;
    readonly evidenceReference: string | null;
    readonly providerAccountRef?: string | null;
    readonly successReference?: string | null;
}

function auditFor(
    payout: PayoutRequest,
    journalId: string | null,
    actorId: string | null,
    reason: string | null,
    evidence?: PayoutProviderEvidence,
): PayoutAuditRecord {
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

function hashRequestPayload(input: {
    tenantId: string;
    payoutId: string;
    destinationRef: string;
    amountMinor: bigint;
    currency: string;
    requestedBy: string | null;
}): string {
    return createHash('sha256')
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
function verifyPayoutSnapshot(payout: PayoutRequest): void {
    const recomputed = hashRequestPayload({
        tenantId: payout.tenantId,
        payoutId: payout.payoutId,
        destinationRef: payout.destinationRef,
        amountMinor: payout.amountMinor,
        currency: payout.currency,
        requestedBy: payout.requestedBy,
    });
    if (recomputed !== payout.payloadHash) {
        fail(
            'destination_snapshot_mismatch',
            'the locked payout destination/amount snapshot does not match its sealed request hash',
        );
    }
}

function hashTransitionPayload(input: {
    tenantId: string;
    payoutId: string;
    action: PayoutAction;
    toStatus: PayoutStatus;
    extra: string;
}): string {
    return createHash('sha256')
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

function requireSameTenant(payout: PayoutRequest, tenantId: string): void {
    if (payout.tenantId !== tenantId) {
        fail('tenant_mismatch', 'the store returned a payout outside the requested tenant');
    }
}

function checkedPayout(value: PayoutRequest | null, tenantId: string): PayoutRequest | null {
    if (value === null) return null;
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

function requirePayout(value: PayoutRequest | null, tenantId: string): PayoutRequest {
    const payout = checkedPayout(value, tenantId);
    if (payout === null) fail('payout_not_found', 'payout was not found');
    return payout;
}

/**
 * The debt-source adapter failure is a typed domain gate: a payout cannot
 * proceed, but it is not a not-found and must not be swallowed. The adapter
 * (`billing-payouts-sql.ts`) is not imported here, so the error is recognized by
 * its stable adapter name/code and narrowed without `any`.
 */
function isAdapterError(error: unknown, code: string): boolean {
    if (!isRecord(error)) return false;
    return error['name'] === 'BillingPayoutSqlError' && error['code'] === code;
}

function mapReservationError(error: unknown): unknown {
    if (isAdapterError(error, 'debt_source_unavailable')) {
        return new PayoutError(
            'debt_source_unavailable',
            'the subscription debt source is unavailable; refusing to create or move a payout hold',
        );
    }
    if (error instanceof ReservationError) {
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

function requireMerchantAvailableAccount(
    account: { readonly tenantId: string; readonly kind: string; readonly currency: string; readonly balanceMinor: bigint } | null,
    tenantId: string,
    currency: string,
): { readonly balanceMinor: bigint } {
    if (account === null) fail('account_not_found', 'merchant available account was not found');
    if (account.tenantId !== tenantId) fail('tenant_mismatch', 'merchant available account is foreign');
    if (account.kind !== 'merchant_available') {
        fail('account_kind_mismatch', 'payout funding must come from merchant_available only');
    }
    if (account.currency !== currency) {
        fail('currency_mismatch', 'merchant available account uses another currency');
    }
    return account;
}

function payoutReservationKey(payoutId: string): string {
    const key = `payout:${payoutId}`;
    if (key.length > 100) fail('invalid_payout_id', 'derived reservation key exceeds 100 characters');
    return key;
}

/* =========================================================================
 * Dependencies
 * ========================================================================= */

export interface PayoutDeps<Tx extends PayoutTransaction = PayoutTransaction> {
    readonly store: PayoutStore<Tx>;
    readonly ledger: LedgerPort<Tx>;
    readonly destinationAuthority: DestinationAuthority;
    /**
     * Optional provider evidence port. Releasing a `processing` payout hold
     * REQUIRES a definite failure/cancellation verdict; absence fails closed.
     */
    readonly providerOutcomeVerifier?: ProviderOutcomeVerifier;
}

function assertDeps<Tx extends PayoutTransaction>(deps: PayoutDeps<Tx>): void {
    if (typeof deps?.store?.runAtomic !== 'function') fail('invalid_input', 'store must expose runAtomic');
    if (typeof deps?.ledger?.reserve !== 'function' || typeof deps?.ledger?.release !== 'function') {
        fail('invalid_input', 'the accepted ledger port is required');
    }
    if (typeof deps?.destinationAuthority?.authorizeDestination !== 'function') {
        fail('invalid_destination_authority', 'an injected destination authority is required');
    }
}

/* =========================================================================
 * Request
 * ========================================================================= */

export interface RequestPayoutInput {
    readonly tenantId: string;
    readonly payoutId: string;
    readonly destinationRef: string;
    readonly amountMinor: unknown;
    readonly currency: string;
    readonly idempotencyKey: string;
    readonly requestedBy?: string | null;
    readonly createdAt?: string;
}

export interface RequestPayoutResult {
    readonly payout: PayoutRequest;
    readonly replayed: boolean;
}

/**
 * Create a payout request. No money moves here: the reservation is created by
 * `reservePayout` after the debt-priority decision.
 */
export async function requestPayout<Tx extends PayoutTransaction>(
    deps: PayoutDeps<Tx>,
    input: RequestPayoutInput,
): Promise<RequestPayoutResult> {
    assertDeps(deps);
    const tenantId = requireBoundedString(input.tenantId, 'tenantId', MAX_TENANT_LENGTH, 'invalid_tenant');
    const payoutId = requireBoundedString(input.payoutId, 'payoutId', MAX_PAYOUT_ID_LENGTH, 'invalid_payout_id');
    const destinationRef = requireBoundedString(
        input.destinationRef,
        'destinationRef',
        MAX_DESTINATION_LENGTH,
        'invalid_destination',
    );
    const amountMinor = requirePositiveAmount(input.amountMinor);
    const currency = requireCurrency(input.currency);
    const idempotencyKey = requireBoundedString(
        input.idempotencyKey,
        'idempotencyKey',
        MAX_IDEMPOTENCY_KEY_LENGTH,
        'invalid_idempotency_key',
    );
    const requestedBy = optionalBoundedString(input.requestedBy, 'requestedBy', MAX_ACTOR_LENGTH, 'invalid_actor');
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

        const payout: PayoutRequest = Object.freeze({
            payoutId,
            tenantId,
            destinationRef,
            amountMinor,
            currency,
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

/* =========================================================================
 * Transitions
 * ========================================================================= */

export interface PayoutTransitionResult {
    readonly payout: PayoutRequest;
    readonly transition: PayoutTransitionRecord;
    readonly replayed: boolean;
}

interface PayoutEffect {
    readonly reservationId: string | null;
    readonly journalId: string | null;
    readonly providerReference: string | null;
    readonly failureReason: string | null;
    readonly cancellationReason: string | null;
    /** Verdict + evidence reference to record in the single audit write. */
    readonly providerEvidence?: PayoutProviderEvidence;
}

interface TransitionOptions<Tx extends PayoutTransaction> {
    readonly tenantId: string;
    readonly payoutId: string;
    readonly idempotencyKey: string;
    readonly action: PayoutAction;
    readonly toStatus: PayoutStatus;
    readonly expectedVersion?: number;
    readonly actorId?: string | null;
    readonly reason?: string | null;
    readonly payloadExtra: string;
    readonly createdAt?: string;
    readonly effect: (tx: Tx, payout: PayoutRequest) => Promise<PayoutEffect>;
}

async function applyPayoutTransition<Tx extends PayoutTransaction>(
    deps: PayoutDeps<Tx>,
    options: TransitionOptions<Tx>,
): Promise<PayoutTransitionResult> {
    assertDeps(deps);
    const tenantId = requireBoundedString(options.tenantId, 'tenantId', MAX_TENANT_LENGTH, 'invalid_tenant');
    const payoutId = requireBoundedString(options.payoutId, 'payoutId', MAX_PAYOUT_ID_LENGTH, 'invalid_payout_id');
    const idempotencyKey = requireBoundedString(
        options.idempotencyKey,
        'idempotencyKey',
        MAX_IDEMPOTENCY_KEY_LENGTH,
        'invalid_idempotency_key',
    );
    const toStatus = requireStatus(options.toStatus);
    const actorId = optionalBoundedString(options.actorId, 'actorId', MAX_ACTOR_LENGTH, 'invalid_actor');
    const reason = optionalBoundedString(options.reason, 'reason', MAX_REASON_LENGTH, 'invalid_reason');
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
            if (existing.tenantId !== tenantId) fail('tenant_mismatch', 'transition belongs to another tenant');
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
                fail(
                    'payout_in_flight',
                    'a processing payout may still be in flight; it stays processing pending reconciliation and no hold is released',
                );
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

        let effect: PayoutEffect;
        try {
            effect = await options.effect(tx, payout);
        } catch (error) {
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
            if (updated.reason === 'not_found') fail('payout_not_found', 'payout was not found');
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

function transitionRecord(input: {
    payout: PayoutRequest;
    action: PayoutAction;
    idempotencyKey: string;
    payloadHash: string;
    fromStatus: PayoutStatus;
    toStatus: PayoutStatus;
    versionAfter: number;
    reservationId: string | null;
    journalId: string | null;
    actorId: string | null;
    reason: string | null;
    createdAt: string;
}): PayoutTransitionRecord {
    return Object.freeze({
        id: randomUUID(),
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

/* =========================================================================
 * Reserve
 * ========================================================================= */

export interface ReservePayoutInput {
    readonly tenantId: string;
    readonly payoutId: string;
    readonly idempotencyKey: string;
    readonly availableAccountId: string;
    readonly reservedAccountId: string;
    readonly now?: number;
    readonly expectedVersion?: number;
    readonly actorId?: string | null;
    readonly createdAt?: string;
}

/**
 * Move the requested amount from available to reserved, but only after the
 * accepted debt-priority decision. Existing reservations are never touched.
 */
export function reservePayout<Tx extends PayoutTransaction>(
    deps: PayoutDeps<Tx>,
    input: ReservePayoutInput,
): Promise<PayoutTransitionResult> {
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

            const available = requireMerchantAvailableAccount(
                await tx.getAccount(tenantId, availableAccountId),
                tenantId,
                payout.currency,
            );

            const debts = await tx.listDueSubscriptionDebts(tenantId, payout.currency, {
                limit: DEBT_SCAN_LIMIT,
                asOfSeconds: now,
            });
            if (debts.truncated) {
                fail('priority_scan_truncated', 'due subscription debt scan was truncated; refusing a new reservation');
            }
            const existing = await tx.listActiveReservations(tenantId, payout.currency, {
                limit: RESERVATION_SCAN_LIMIT,
            });

            const priority = decideWithdrawalPriority({
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

/* =========================================================================
 * Processing / confirmation / failure / cancellation
 * ========================================================================= */

export interface StartPayoutProcessingInput {
    readonly tenantId: string;
    readonly payoutId: string;
    readonly idempotencyKey: string;
    readonly expectedVersion?: number;
    readonly actorId?: string | null;
    readonly createdAt?: string;
}

/** Record that the external transfer step started. No provider call is made. */
export function startPayoutProcessing<Tx extends PayoutTransaction>(
    deps: PayoutDeps<Tx>,
    input: StartPayoutProcessingInput,
): Promise<PayoutTransitionResult> {
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

export interface ConfirmPayoutInput {
    readonly tenantId: string;
    readonly payoutId: string;
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

interface PayoutPreflightInput {
    readonly tenantId: unknown;
    readonly payoutId: unknown;
    readonly idempotencyKey: unknown;
    readonly actorId?: unknown;
    readonly reason?: unknown;
    readonly createdAt?: unknown;
    readonly expectedVersion?: unknown;
    readonly evidenceReference?: unknown;
}

/**
 * Validate EVERY input before any store call or external call, so a malformed
 * request can never reach the snapshot read or the verifier. Returns the
 * normalized opaque evidence reference.
 */
function preflightPayoutInput(input: PayoutPreflightInput): string | null {
    requireBoundedString(input.tenantId, 'tenantId', MAX_TENANT_LENGTH, 'invalid_tenant');
    requireBoundedString(input.payoutId, 'payoutId', MAX_PAYOUT_ID_LENGTH, 'invalid_payout_id');
    requireBoundedString(
        input.idempotencyKey,
        'idempotencyKey',
        MAX_IDEMPOTENCY_KEY_LENGTH,
        'invalid_idempotency_key',
    );
    optionalBoundedString(input.actorId, 'actorId', MAX_ACTOR_LENGTH, 'invalid_actor');
    optionalBoundedString(input.reason, 'reason', MAX_REASON_LENGTH, 'invalid_reason');
    normalizeCreatedAt(input.createdAt);
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

interface PayoutPreOutcome {
    /** Non-locking snapshot the verifier answer is bound to. */
    readonly snapshot: PayoutRequest;
    readonly outcome: VerifiedProviderOutcome;
}

/**
 * EXTERNAL CALL OUTSIDE THE TRANSACTION: a plain non-locking snapshot read
 * tells whether the payout is processing; only then the injected verifier is
 * consulted, BEFORE the locking transaction opens. No verifier call is made
 * for any non-processing payout or a stale expected version.
 */
async function verifyProcessingPayoutOutcome<Tx extends PayoutTransaction>(
    deps: PayoutDeps<Tx>,
    input: { readonly tenantId: string; readonly payoutId: string; readonly expectedVersion?: number },
    claimedOutcome: ProviderClaimedOutcome,
    evidenceReference: string | null,
    callerProviderReference: string | null,
): Promise<PayoutPreOutcome | null> {
    const snapshot = await deps.store.runAtomic(async (tx) =>
        typeof tx.findPayoutSnapshot === 'function'
            ? tx.findPayoutSnapshot(input.tenantId, input.payoutId)
            : null);
    if (
        snapshot === null
        || snapshot.tenantId !== input.tenantId
        || snapshot.payoutId !== input.payoutId
        || snapshot.status !== 'processing'
        || (input.expectedVersion !== undefined && snapshot.version !== input.expectedVersion)
    ) {
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
function requireAttestedPayoutOutcome(
    pre: PayoutPreOutcome | null,
    payout: PayoutRequest,
    verdict: ProviderOutcomeVerdict,
    what: string,
): VerifiedProviderOutcome {
    if (
        pre === null
        || pre.outcome.verdict !== verdict
        || pre.snapshot.tenantId !== payout.tenantId
        || pre.snapshot.payoutId !== payout.payoutId
        || pre.snapshot.version !== payout.version
        || pre.snapshot.amountMinor !== payout.amountMinor
        || pre.snapshot.currency !== payout.currency
        || pre.snapshot.destinationRef !== payout.destinationRef
        || pre.snapshot.payloadHash !== payout.payloadHash
    ) {
        fail(
            'provider_outcome_unverified',
            `a processing payout requires ${what}, attested by the injected verifier for this exact unchanged request before the transaction; nothing was consumed or released`,
        );
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
export async function confirmPayout<Tx extends PayoutTransaction>(
    deps: PayoutDeps<Tx>,
    input: ConfirmPayoutInput,
): Promise<PayoutTransitionResult> {
    assertDeps(deps);
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
    const evidenceReference = preflightPayoutInput(input);
    const pre = await verifyProcessingPayoutOutcome(
        deps,
        { tenantId: input.tenantId, payoutId: input.payoutId, expectedVersion: input.expectedVersion },
        'success',
        evidenceReference,
        providerReference,
    );
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
            const attested = requireAttestedPayoutOutcome(
                pre,
                payout,
                'definite_success',
                'a definitive provider success',
            );
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
            requirePlatformCashCounterAccount(
                await tx.getAccount(payout.tenantId, authorizedCounterId),
                payout.tenantId,
                payout.currency,
            );
            const reservation = await tx.getReservation(payout.tenantId, payout.reservationId);
            if (
                reservation === null
                || reservation.tenantId !== payout.tenantId
                || reservation.currency !== payout.currency
                || reservation.amountMinor !== payout.amountMinor
            ) {
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
                    providerVerdict: 'definite_success' as const,
                    evidenceReference,
                    providerAccountRef: attested.providerAccountRef,
                    successReference: attested.successReference,
                },
            };
        },
    });
}

export interface FailPayoutInput {
    readonly tenantId: string;
    readonly payoutId: string;
    readonly idempotencyKey: string;
    readonly reason?: string | null;
    /**
     * Opaque reference to provider evidence. The reason text is never treated
     * as proof; the injected verifier decides from this reference.
     */
    readonly evidenceReference?: string | null;
    readonly expectedVersion?: number;
    readonly actorId?: string | null;
    readonly createdAt?: string;
}

/** Release a reserved/processing hold exactly once. Idempotent on replay. */
export async function failPayout<Tx extends PayoutTransaction>(
    deps: PayoutDeps<Tx>,
    input: FailPayoutInput,
): Promise<PayoutTransitionResult> {
    assertDeps(deps);
    /*
     * EXTERNAL CALL OUTSIDE THE TRANSACTION (see verifyProcessingPayoutOutcome).
     * Inside the transaction the locked row is re-read and the attestation is
     * honoured only if it is bound to the exact unchanged request and its
     * verdict is a definite failure.
     */
    const preEvidenceReference = preflightPayoutInput(input);
    const pre = await verifyProcessingPayoutOutcome(
        deps,
        { tenantId: input.tenantId, payoutId: input.payoutId, expectedVersion: input.expectedVersion },
        'failed',
        preEvidenceReference,
        null,
    );
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
            const failureReason = optionalBoundedString(
                input.reason,
                'reason',
                MAX_REASON_LENGTH,
                'invalid_reason',
            );
            // A processing payout may have an external transfer in flight: only
            // a definite attested provider failure may release the hold. The
            // caller's reason text is never evidence; unknown/unavailable stays
            // processing for reconciliation.
            let providerEvidence: PayoutEffect['providerEvidence'];
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

export interface CancelPayoutInput {
    readonly tenantId: string;
    readonly payoutId: string;
    readonly idempotencyKey: string;
    readonly reason?: string | null;
    /** Opaque reference handed to the verifier; the reason is never evidence. */
    readonly evidenceReference?: string | null;
    readonly expectedVersion?: number;
    readonly actorId?: string | null;
    readonly createdAt?: string;
}

/**
 * Cancel a requested/reserved payout; its hold is released once. A `processing`
 * payout may be cancelled only when the injected verifier attests a final
 * non-executed/non-settled provider cancellation bound to this exact request;
 * otherwise it stays `processing` (typed `provider_outcome_unverified`,
 * reconciliation required) and no hold is released.
 */
export async function cancelPayout<Tx extends PayoutTransaction>(
    deps: PayoutDeps<Tx>,
    input: CancelPayoutInput,
): Promise<PayoutTransitionResult> {
    assertDeps(deps);
    const evidenceReference = preflightPayoutInput(input);
    const pre = await verifyProcessingPayoutOutcome(
        deps,
        { tenantId: input.tenantId, payoutId: input.payoutId, expectedVersion: input.expectedVersion },
        'cancelled',
        evidenceReference,
        null,
    );
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
            const cancellationReason = optionalBoundedString(
                input.reason,
                'reason',
                MAX_REASON_LENGTH,
                'invalid_reason',
            );
            let providerEvidence: PayoutEffect['providerEvidence'];
            if (payout.status === 'processing') {
                requireAttestedPayoutOutcome(
                    pre,
                    payout,
                    'definite_cancellation',
                    'a definitive provider cancellation (final non-executed/non-settled outcome)',
                );
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

/* =========================================================================
 * Bounded listing
 * ========================================================================= */

export interface ListPayoutsInput {
    readonly tenantId: string;
    readonly limit?: number;
    readonly status?: PayoutStatus;
}

export async function listPayouts<Tx extends PayoutTransaction>(
    store: PayoutStore<Tx>,
    input: ListPayoutsInput,
): Promise<PayoutPage> {
    if (typeof store?.runAtomic !== 'function') fail('invalid_input', 'store must expose runAtomic');
    const tenantId = requireBoundedString(input.tenantId, 'tenantId', MAX_TENANT_LENGTH, 'invalid_tenant');
    const limit = input.limit === undefined ? DEFAULT_LIST_LIMIT : input.limit;
    if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT) {
        fail('invalid_input', `limit must be a safe integer between 1 and ${MAX_LIST_LIMIT}`);
    }
    const status = input.status === undefined ? undefined : requireStatus(input.status);
    return store.runAtomic((tx) => tx.listPayouts(tenantId, { limit, status }));
}

/**
 * Re-exported for callers that need the accepted journal shape without
 * reaching into the ledger module directly.
 */
export type { JournalRecord };
