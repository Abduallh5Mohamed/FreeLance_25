"use strict";
/**
 * D1 — settlement obligations: verified merchant receipt, independently
 * verified merchant settlement and platform-invoice payment allocation.
 *
 * Scope (Codex decisions, do not re-decide):
 *  - a confirmed payment and an externally verified settlement are separate
 *    events;
 *  - an unknown fee/tax/net is NEVER replaced by zero and NEVER immediately
 *    available: the obligation rests at `awaiting_allocation` with those
 *    columns NULL and nothing is posted;
 *  - cash receipts never create `merchant_available`; `subscription_credit` is
 *    never touched; there is no platform commission on student payments;
 *  - money is exact BigInt minor units, BIGINT strings at the SQL edge,
 *    versions are safe integers (HK2);
 *  - every mutation runs in one transaction on one injected connection, posts
 *    at most one balanced journal, writes exactly one sealed audit row, and
 *    rolls back completely on failure.
 *
 * Schema owner: `server/migrations/20261023_01_financial_settlement_obligations.sql`
 * (authoritative table/column/key names) and section 16 of
 * `docs/streams/server/CL-C-SCHEMA-20261022.md`.
 *
 * IMMUTABLE POSTING MAP
 *  | event                        | journal key (deterministic)              | debit              | credit              | amount source                                   | transition |
 *  | ---------------------------- | ---------------------------------------- | ------------------ | ------------------- | ----------------------------------------------- | ---------- |
 *  | merchant receipt completed   | settlement:receipt:<obligationId>        | platform_cash      | merchant_pending    | proved net (fee+tax=0, net=gross)               | pending/awaiting_allocation -> completed (journal_id, net_minor, CAS version) |
 *  | merchant receipt not proved  | (none)                                   | (none)             | (none)              | fee/tax/net stay NULL                            | pending -> awaiting_allocation (CAS version) |
 *  | merchant settlement verified | settlement:settle:<obligationId>:<sha256(settlementRef)> | merchant_pending | merchant_available | verified settled amount (<= proved net)        | provider_settlement_reference + reconciled (CAS version) |
 *  | platform receipt verified    | settlement:platform_receipt:<obligationId> | platform_cash | platform_unallocated_receipts | verified allocatable_minor (fee=tax=0 until policy) | pending/awaiting_allocation -> awaiting_allocation (allocatable_minor + platform_receipt_journal_id, CAS version) |
 *  | platform receipt allocated   | settlement:platform_alloc:<obligationId>:<invoiceId> | platform_unallocated_receipts | platform_receivable | min(allocatable, proven invoice outstanding) | billing_payment_allocations row (kind 'payment'); awaiting_allocation -> allocated ONLY when non-reversed net allocations cover allocatable |
 *  | platform allocation reversed | settlement:platform_alloc_rev:<allocationId> | platform_receivable | platform_unallocated_receipts | the allocation amount (full mirror, journal_type reversal) | billing_payment_allocations row (kind 'reversal', reverses_allocation_id); reconciliation_status -> discrepancy; status NOT rewritten |
 *  | LEGACY direct allocation (REPLAY ONLY) | settlement:invoice_payment:<obligationId>:<invoiceId> | platform_cash | invoice platform_receivable | frozen history, never posted again | an existing allocation row is replayed; nothing new is written (legacy_path_disabled otherwise) |
 *
 * The fee/tax liability account is a HELD question: the frozen account kinds
 * have no fee/tax account, so a proved positive fee+tax fails closed with
 * `allocation_account_unavailable` and posts nothing.
 *
 * SOURCE ONLY. No SQL, connection, provider call or test runs here.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.SettlementError = exports.INVOICE_PAYMENT_JOURNAL_KEY_PREFIX = exports.SETTLEMENT_JOURNAL_KEY_PREFIX = exports.RECEIPT_JOURNAL_KEY_PREFIX = exports.PLATFORM_DIFFERENCE_PAYMENT_PURPOSES = exports.PLATFORM_INVOICE_PAYMENT_PURPOSES = exports.MERCHANT_RECEIPT_PURPOSES = exports.DEFAULT_LIST_LIMIT = exports.MAX_LIST_LIMIT = exports.MAX_ACTOR_ID_LENGTH = exports.MAX_REASON_LENGTH = exports.MAX_IDEMPOTENCY_KEY_LENGTH = exports.MAX_CURRENCY_LENGTH = exports.MAX_PROVIDER_REFERENCE_LENGTH = exports.MAX_REFERENCE_LENGTH = exports.MAX_PROVIDER_EVENT_ID_LENGTH = exports.MAX_PROVIDER_LENGTH = exports.MAX_PURPOSE_LENGTH = exports.MAX_ORDER_ID_LENGTH = exports.MAX_ALLOCATION_ID_LENGTH = exports.MAX_INVOICE_ID_LENGTH = exports.MAX_OBLIGATION_ID_LENGTH = exports.ALLOCATION_KINDS = exports.RECONCILIATION_STATUSES = exports.SETTLEMENT_OBLIGATION_STATUSES = void 0;
exports.merchantReceiptJournalKey = merchantReceiptJournalKey;
exports.merchantSettlementJournalKey = merchantSettlementJournalKey;
exports.invoicePaymentJournalKey = invoicePaymentJournalKey;
exports.asSettlementObligationId = asSettlementObligationId;
exports.platformReceiptJournalKey = platformReceiptJournalKey;
exports.platformAllocationJournalKey = platformAllocationJournalKey;
exports.platformAllocationReversalJournalKey = platformAllocationReversalJournalKey;
exports.recordVerifiedMerchantReceipt = recordVerifiedMerchantReceipt;
exports.settleVerifiedMerchantObligation = settleVerifiedMerchantObligation;
exports.recordVerifiedPlatformReceipt = recordVerifiedPlatformReceipt;
exports.allocatePlatformReceiptToInvoice = allocatePlatformReceiptToInvoice;
exports.reversePlatformAllocation = reversePlatformAllocation;
exports.readPlatformAllocationBalance = readPlatformAllocationBalance;
exports.allocateVerifiedPaymentToInvoice = allocateVerifiedPaymentToInvoice;
exports.isDebtSourceUnavailableError = isDebtSourceUnavailableError;
exports.computeInvoiceOutstanding = computeInvoiceOutstanding;
exports.listInvoiceOutstanding = listInvoiceOutstanding;
exports.settlementCodeForLedgerError = settlementCodeForLedgerError;
const node_crypto_1 = require("node:crypto");
const billing_ledger_1 = require("./billing-ledger");
/* =========================================================================
 * Constants
 * ========================================================================= */
exports.SETTLEMENT_OBLIGATION_STATUSES = ['pending', 'awaiting_allocation', 'completed', 'allocated'];
exports.RECONCILIATION_STATUSES = ['unreconciled', 'reconciled', 'discrepancy'];
exports.ALLOCATION_KINDS = ['payment', 'credit', 'reversal'];
exports.MAX_OBLIGATION_ID_LENGTH = 36;
exports.MAX_INVOICE_ID_LENGTH = 36;
exports.MAX_ALLOCATION_ID_LENGTH = 36;
exports.MAX_ORDER_ID_LENGTH = 64;
exports.MAX_PURPOSE_LENGTH = 64;
exports.MAX_PROVIDER_LENGTH = 64;
exports.MAX_PROVIDER_EVENT_ID_LENGTH = 128;
exports.MAX_REFERENCE_LENGTH = 128;
exports.MAX_PROVIDER_REFERENCE_LENGTH = 128;
exports.MAX_CURRENCY_LENGTH = 3;
exports.MAX_IDEMPOTENCY_KEY_LENGTH = 128;
exports.MAX_REASON_LENGTH = 500;
exports.MAX_ACTOR_ID_LENGTH = 64;
exports.MAX_LIST_LIMIT = 1000;
exports.DEFAULT_LIST_LIMIT = 500;
const MAX_MINOR = 1000000000000000n;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;
const HEX_64_PATTERN = /^[0-9a-f]{64}$/;
/**
 * Payment purposes. Exactly one merchant purpose exists (Codex decision: no
 * alias); the only documented platform-subscription purpose is
 * `subscription_difference` (payment-checkout.ts / docs 19). A purpose outside
 * the relevant set is a typed `purpose_mismatch` and nothing is written.
 */
exports.MERCHANT_RECEIPT_PURPOSES = new Set(['student_tuition']);
/**
 * Frozen allowlist: mutation after construction throws. Adding a purpose is a
 * contract change, never a runtime parameter (CL-B section 14.3.2).
 */
class FrozenPurposeSet extends Set {
    constructor(values) {
        super();
        for (const value of values)
            super.add(value);
    }
    add() {
        throw new Error('the platform payment purpose allowlist is frozen');
    }
    delete() {
        throw new Error('the platform payment purpose allowlist is frozen');
    }
    clear() {
        throw new Error('the platform payment purpose allowlist is frozen');
    }
}
exports.PLATFORM_INVOICE_PAYMENT_PURPOSES = new FrozenPurposeSet([
    'subscription_difference',
]);
/** Same frozen set under its contract name (14.7); `===` PLATFORM_INVOICE_PAYMENT_PURPOSES. */
exports.PLATFORM_DIFFERENCE_PAYMENT_PURPOSES = exports.PLATFORM_INVOICE_PAYMENT_PURPOSES;
exports.RECEIPT_JOURNAL_KEY_PREFIX = 'settlement:receipt:';
exports.SETTLEMENT_JOURNAL_KEY_PREFIX = 'settlement:settle:';
exports.INVOICE_PAYMENT_JOURNAL_KEY_PREFIX = 'settlement:invoice_payment:';
class SettlementError extends Error {
    constructor(code, message) {
        super(message);
        this.code = code;
        this.name = 'SettlementError';
    }
}
exports.SettlementError = SettlementError;
function fail(code, message) {
    throw new SettlementError(code, message);
}
/* =========================================================================
 * Validation helpers (exact minor units only)
 * ========================================================================= */
function requireBoundedString(value, field, maxLength, code) {
    if (typeof value !== 'string')
        fail(code, `${field} must be a string`);
    const text = value.trim();
    if (text.length === 0 || text.length > maxLength || text !== value) {
        fail(code, `${field} must be a non-empty trimmed string of at most ${maxLength} characters`);
    }
    return text;
}
function optionalBoundedString(value, field, maxLength, code) {
    if (value === undefined || value === null)
        return null;
    if (typeof value !== 'string')
        fail(code, `${field} must be a string or null`);
    const text = value.trim();
    if (text.length > maxLength || text !== value) {
        fail(code, `${field} must be a trimmed string of at most ${maxLength} characters`);
    }
    return text === '' ? null : text;
}
function requireCurrency(value) {
    if (typeof value !== 'string' || !CURRENCY_PATTERN.test(value)) {
        fail('invalid_currency', 'currency must be a three-letter uppercase ISO-4217 code');
    }
    return value;
}
function requireHex64(value, field) {
    if (typeof value !== 'string' || !HEX_64_PATTERN.test(value)) {
        fail('invalid_input', `${field} must be a lowercase SHA-256 hex string`);
    }
    return value;
}
/** Exact positive minor units; zero and negative are rejected. */
function requirePositiveMinor(value, field) {
    if (typeof value !== 'bigint')
        fail('invalid_amount', `${field} must be a bigint of minor units`);
    if (value <= 0n)
        fail('invalid_amount', `${field} must be positive`);
    if (value > MAX_MINOR)
        fail('invalid_amount', `${field} exceeds the exact minor-unit bound`);
    return value;
}
/** Optional proved minor units: `undefined`/`null` means "not proved", never 0. */
function optionalMinor(value, field) {
    if (value === undefined || value === null)
        return null;
    if (typeof value !== 'bigint')
        fail('invalid_amount', `${field} must be a bigint of minor units or null`);
    if (value < 0n || value > MAX_MINOR)
        fail('invalid_amount', `${field} is outside the exact minor-unit bound`);
    return value;
}
function requireSafeVersion(value, field) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
        fail('invalid_version', `${field} must be a non-negative safe integer`);
    }
    return value;
}
function requireStatus(value) {
    if (typeof value !== 'string' || !exports.SETTLEMENT_OBLIGATION_STATUSES.includes(value)) {
        fail('store_inconsistent', 'obligation has an unknown status');
    }
    return value;
}
function requireReconciliation(value) {
    if (typeof value !== 'string' || !exports.RECONCILIATION_STATUSES.includes(value)) {
        fail('store_inconsistent', 'obligation has an unknown reconciliation status');
    }
    return value;
}
function requireAllocationKind(value) {
    if (typeof value !== 'string' || !exports.ALLOCATION_KINDS.includes(value)) {
        fail('store_inconsistent', 'allocation has an unknown kind');
    }
    return value;
}
/* =========================================================================
 * Deterministic journal idempotency keys
 * ========================================================================= */
/** Receipt key derived only from the obligation id: crash retry finds the same journal. */
function merchantReceiptJournalKey(obligationId) {
    const id = requireBoundedString(obligationId, 'obligationId', exports.MAX_OBLIGATION_ID_LENGTH, 'invalid_input');
    return `${exports.RECEIPT_JOURNAL_KEY_PREFIX}${id}`;
}
/** Settlement key derived from the obligation id and the verified settlement reference. */
function merchantSettlementJournalKey(obligationId, settlementReference) {
    const id = requireBoundedString(obligationId, 'obligationId', exports.MAX_OBLIGATION_ID_LENGTH, 'invalid_input');
    const reference = requireBoundedString(settlementReference, 'settlementReference', exports.MAX_REFERENCE_LENGTH, 'invalid_reference');
    const referenceHash = (0, node_crypto_1.createHash)('sha256').update(reference, 'utf8').digest('hex');
    const key = `${exports.SETTLEMENT_JOURNAL_KEY_PREFIX}${id}:${referenceHash}`;
    if (key.length > exports.MAX_IDEMPOTENCY_KEY_LENGTH) {
        fail('invalid_input', 'the derived settlement journal key exceeds the ledger key bound');
    }
    return key;
}
/** Platform invoice payment key derived from the obligation and invoice ids. */
function invoicePaymentJournalKey(obligationId, invoiceId) {
    const obligation = requireBoundedString(obligationId, 'obligationId', exports.MAX_OBLIGATION_ID_LENGTH, 'invalid_input');
    const invoice = requireBoundedString(invoiceId, 'invoiceId', exports.MAX_INVOICE_ID_LENGTH, 'invalid_input');
    const key = `${exports.INVOICE_PAYMENT_JOURNAL_KEY_PREFIX}${obligation}:${invoice}`;
    if (key.length > exports.MAX_IDEMPOTENCY_KEY_LENGTH) {
        fail('invalid_input', 'the derived invoice journal key exceeds the ledger key bound');
    }
    return key;
}
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
/** Byte-exact: no trimming, no case folding, no normalisation (column is utf8mb4_0900_bin). */
function asSettlementObligationId(value) {
    if (typeof value !== 'string')
        fail('invalid_input', 'obligationId must be a string');
    if (value.length === 0
        || value.length > exports.MAX_OBLIGATION_ID_LENGTH
        || value.trim() !== value
        || CONTROL_CHARACTERS.test(value)) {
        fail('invalid_input', `obligationId must be a non-empty trimmed string of at most ${exports.MAX_OBLIGATION_ID_LENGTH} characters without control characters`);
    }
    return value;
}
/** Receipt key: once per obligation. */
function platformReceiptJournalKey(obligationId) {
    const id = asSettlementObligationId(obligationId);
    return `${billing_ledger_1.PLATFORM_RECEIPT_KEY_PREFIX}${id}`;
}
/** Allocation key: once per obligation and invoice (<= 99 characters). */
function platformAllocationJournalKey(obligationId, invoiceId) {
    const obligation = asSettlementObligationId(obligationId);
    const invoice = requireBoundedString(invoiceId, 'invoiceId', exports.MAX_INVOICE_ID_LENGTH, 'invalid_input');
    const key = `${billing_ledger_1.PLATFORM_ALLOCATION_KEY_PREFIX}${obligation}:${invoice}`;
    if (key.length > exports.MAX_IDEMPOTENCY_KEY_LENGTH) {
        fail('invalid_input', 'the derived platform allocation journal key exceeds the ledger key bound');
    }
    return key;
}
/** Allocation reversal key: once per allocation (<= 66 characters). */
function platformAllocationReversalJournalKey(allocationId) {
    const allocation = requireBoundedString(allocationId, 'allocationId', exports.MAX_ALLOCATION_ID_LENGTH, 'invalid_input');
    return `${billing_ledger_1.PLATFORM_ALLOCATION_REVERSAL_KEY_PREFIX}${allocation}`;
}
function assertMerchantPurpose(obligation) {
    if (!exports.MERCHANT_RECEIPT_PURPOSES.has(obligation.purpose)) {
        fail('purpose_mismatch', `obligation purpose '${obligation.purpose}' is not a merchant payment purpose`);
    }
}
function assertPlatformInvoicePurpose(obligation) {
    if (!exports.PLATFORM_INVOICE_PAYMENT_PURPOSES.has(obligation.purpose)) {
        fail('purpose_mismatch', `obligation purpose '${obligation.purpose}' is not a platform subscription invoice purpose`);
    }
}
/* =========================================================================
 * Paid-order ownership proof
 * ========================================================================= */
/**
 * A free payment string is never financial proof. The obligation's order is
 * re-read under lock and its tenant, order, purpose, amount and currency must
 * equal the obligation. When the paid order records the confirming provider
 * event, it must equal the obligation's verified event too.
 */
async function assertPaidOrderMatches(tx, obligation) {
    const order = await tx.findCheckoutOrderForUpdate(obligation.tenantId, obligation.orderId);
    if (order === null) {
        fail('payment_order_mismatch', `obligation ${obligation.id} names no order in its tenant`);
    }
    if (order.tenantId !== obligation.tenantId) {
        fail('payment_order_mismatch', 'the locked order belongs to another tenant');
    }
    if (order.status !== 'paid') {
        fail('payment_order_mismatch', `the obligation order status '${order.status}' is not paid`);
    }
    if (order.orderId !== obligation.orderId) {
        fail('payment_order_mismatch', 'the locked order id does not equal the obligation order id');
    }
    if (order.purpose !== obligation.purpose) {
        fail('payment_order_mismatch', 'the order purpose does not equal the obligation purpose');
    }
    if (order.amountMinor !== obligation.amountMinor) {
        fail('payment_order_mismatch', 'the order amount does not equal the obligation amount');
    }
    if (order.currency !== obligation.currency) {
        fail('payment_order_mismatch', 'the order currency does not equal the obligation currency');
    }
    if (order.confirmedProviderEventId !== null
        && order.confirmedProviderEventId !== obligation.providerEventId) {
        fail('payment_order_mismatch', 'the confirming provider event does not equal the verified obligation event');
    }
    return order;
}
function mapCasFailure(result) {
    if (result.ok)
        fail('store_inconsistent', 'a successful CAS was classified as a failure');
    if (result.reason === 'not_found')
        fail('obligation_not_found', 'the obligation disappeared during the CAS');
    if (result.reason === 'status_conflict') {
        fail('obligation_status_conflict', 'the obligation status does not allow this transition');
    }
    fail('version_conflict', 'the obligation version changed concurrently');
}
function accountOfKind(accounts, kind) {
    const account = accounts.find((candidate) => candidate.kind === kind);
    if (account === undefined)
        fail('store_inconsistent', `provisioning did not return a ${kind} account`);
    return account;
}
/**
 * Post the merchant receipt journal at most once per obligation.
 *
 * Proved fee+tax+net must equal the verified gross exactly. Unknown values are
 * stored NULL and the obligation rests at `awaiting_allocation` with no journal.
 * A proved positive fee+tax fails closed: the frozen account kinds have no
 * fee/tax liability account (HELD question), so nothing is posted.
 */
async function recordVerifiedMerchantReceipt(store, input, deps = {}) {
    const tenantId = requireBoundedString(input.tenantId, 'tenantId', billing_ledger_1.MAX_TENANT_ID_LENGTH, 'invalid_tenant');
    const obligationId = requireBoundedString(input.obligationId, 'obligationId', exports.MAX_OBLIGATION_ID_LENGTH, 'invalid_input');
    const inputReceipt = optionalBoundedString(input.providerReceiptReference, 'providerReceiptReference', exports.MAX_PROVIDER_REFERENCE_LENGTH, 'invalid_reference');
    // Phase 1 (read only): purpose + provider identity for the proof request.
    // The provider-facing call must not run while the obligation row is locked.
    let proof = 'unavailable';
    const verifier = deps.feeAllocationVerifier;
    if (verifier !== undefined) {
        if (typeof verifier.verifyFeeAllocation !== 'function') {
            fail('invalid_input', 'feeAllocationVerifier must implement verifyFeeAllocation');
        }
        const identity = await store.runAtomic(async (tx) => {
            const found = await tx.findObligationForUpdate(tenantId, obligationId);
            if (found === null)
                fail('obligation_not_found', `obligation ${obligationId} was not found`);
            if (found.tenantId !== tenantId) {
                fail('invalid_tenant', 'the locked obligation belongs to another tenant');
            }
            assertMerchantPurpose(found);
            return found.status === 'completed'
                ? null
                : { provider: found.provider, providerEventId: found.providerEventId };
        });
        if (identity !== null) {
            const answer = await verifier.verifyFeeAllocation({
                tenantId,
                obligationId,
                provider: identity.provider,
                providerEventId: identity.providerEventId,
            });
            if (answer !== 'unavailable') {
                if (typeof answer !== 'object' || answer === null) {
                    fail('invalid_amount', 'the fee allocation proof is malformed');
                }
                const fee = optionalMinor(answer.feeMinor, 'proved feeMinor');
                const tax = optionalMinor(answer.taxMinor, 'proved taxMinor');
                const net = optionalMinor(answer.netMinor, 'proved netMinor');
                if (fee === null || tax === null || net === null) {
                    fail('invalid_amount', 'the fee allocation proof must carry fee, tax and net');
                }
                proof = { feeMinor: fee, taxMinor: tax, netMinor: net };
            }
        }
    }
    return store.runAtomic(async (tx) => {
        const obligation = await tx.findObligationForUpdate(tenantId, obligationId);
        if (obligation === null)
            fail('obligation_not_found', `obligation ${obligationId} was not found`);
        if (obligation.tenantId !== tenantId) {
            fail('invalid_tenant', 'the locked obligation belongs to another tenant');
        }
        assertMerchantPurpose(obligation);
        // Mutual exclusion with the platform-invoice path, under the obligation lock.
        const priorAllocation = await tx.findAllocationByObligation(tenantId, obligation.id);
        if (priorAllocation !== null) {
            fail('allocation_conflict', 'this payment is already allocated to a platform invoice and cannot also be received as merchant money');
        }
        await assertPaidOrderMatches(tx, obligation);
        const feeMinor = proof === 'unavailable' ? null : proof.feeMinor;
        const taxMinor = proof === 'unavailable' ? null : proof.taxMinor;
        const netMinor = proof === 'unavailable' ? null : proof.netMinor;
        const providerReceiptReference = input.providerReceiptReference === undefined
            ? obligation.providerReceiptReference
            : inputReceipt;
        if (obligation.status === 'completed') {
            const key = merchantReceiptJournalKey(obligation.id);
            const journal = await tx.findJournalByIdempotencyKey(tenantId, key);
            if (journal === null) {
                fail('store_inconsistent', 'a completed obligation has no receipt journal at its deterministic key');
            }
            return {
                status: 'completed',
                posted: true,
                replayed: true,
                journalId: journal.id,
                obligation,
            };
        }
        const proved = feeMinor !== null && taxMinor !== null && netMinor !== null;
        if (!proved) {
            const changed = obligation.status !== 'awaiting_allocation'
                || feeMinor !== obligation.feeMinor
                || taxMinor !== obligation.taxMinor
                || netMinor !== obligation.netMinor
                || providerReceiptReference !== obligation.providerReceiptReference;
            let current = obligation;
            if (changed) {
                const cas = await tx.markObligationAwaitingAllocation({
                    tenantId,
                    obligationId: obligation.id,
                    expectedVersion: obligation.version,
                    feeMinor,
                    taxMinor,
                    netMinor,
                    providerReceiptReference,
                });
                if (!cas.ok)
                    mapCasFailure(cas);
                current = cas.obligation;
                await tx.writeAudit({
                    action: 'billing.settlement.receipt_awaiting_allocation',
                    tenantId,
                    obligationId: current.id,
                    orderId: current.orderId,
                    invoiceId: null,
                    journalId: null,
                    amountMinor: (0, billing_ledger_1.serializeMoneyMinor)(current.amountMinor),
                    currency: current.currency,
                    status: current.status,
                    settlementReference: null,
                });
            }
            return {
                status: 'awaiting_allocation',
                posted: false,
                replayed: false,
                obligation: current,
            };
        }
        if (netMinor <= 0n)
            fail('allocation_mismatch', 'a proved net must be positive');
        if (netMinor + feeMinor + taxMinor !== obligation.amountMinor) {
            fail('allocation_mismatch', 'proved net + fee + tax does not equal the verified gross amount');
        }
        if (feeMinor + taxMinor > 0n) {
            fail('allocation_account_unavailable', 'the frozen ledger account kinds provide no fee/tax liability account; nothing was posted');
        }
        const accounts = await (0, billing_ledger_1.provisionAccountsInTransaction)(tx, {
            tenantId,
            accounts: [
                { kind: 'platform_cash', currency: obligation.currency },
                { kind: 'merchant_pending', currency: obligation.currency },
            ],
        });
        const cash = accountOfKind(accounts, 'platform_cash');
        const pending = accountOfKind(accounts, 'merchant_pending');
        const key = merchantReceiptJournalKey(obligation.id);
        const posted = await (0, billing_ledger_1.postJournalInTransaction)(tx, {
            tenantId,
            currency: obligation.currency,
            idempotencyKey: key,
            reference: `obligation:${obligation.id}`,
            description: 'verified merchant payment receipt',
            lines: [
                { accountId: cash.id, direction: 'debit', amountMinor: netMinor },
                { accountId: pending.id, direction: 'credit', amountMinor: netMinor },
            ],
        });
        const cas = await tx.completeObligationReceipt({
            tenantId,
            obligationId: obligation.id,
            expectedVersion: obligation.version,
            feeMinor,
            taxMinor,
            netMinor,
            providerReceiptReference,
            journalId: posted.journal.id,
        });
        if (!cas.ok)
            mapCasFailure(cas);
        await tx.writeAudit({
            action: 'billing.settlement.receipt_posted',
            tenantId,
            obligationId: cas.obligation.id,
            orderId: cas.obligation.orderId,
            invoiceId: null,
            journalId: posted.journal.id,
            amountMinor: (0, billing_ledger_1.serializeMoneyMinor)(netMinor),
            currency: cas.obligation.currency,
            status: cas.obligation.status,
            settlementReference: null,
        });
        return {
            status: 'completed',
            posted: true,
            replayed: posted.replayed,
            journalId: posted.journal.id,
            obligation: cas.obligation,
        };
    });
}
/**
 * Move proved merchant funds from pending to available only after an
 * independent settlement verification. The verifier runs OUTSIDE the
 * transaction; a transport/verifier failure propagates once, with no retry.
 */
async function settleVerifiedMerchantObligation(store, input, deps = {}) {
    const tenantId = requireBoundedString(input.tenantId, 'tenantId', billing_ledger_1.MAX_TENANT_ID_LENGTH, 'invalid_tenant');
    const obligationId = requireBoundedString(input.obligationId, 'obligationId', exports.MAX_OBLIGATION_ID_LENGTH, 'invalid_input');
    const settlementReference = requireBoundedString(input.settlementReference, 'settlementReference', exports.MAX_REFERENCE_LENGTH, 'invalid_reference');
    const settledAmountMinor = requirePositiveMinor(input.settledAmountMinor, 'settledAmountMinor');
    const currency = requireCurrency(input.currency);
    if (typeof deps.verifySettlement?.verifySettlement !== 'function') {
        fail('settlement_verification_unavailable', 'no independent settlement verification port is available; nothing was settled');
    }
    const request = {
        tenantId,
        obligationId,
        settlementReference,
        settledAmountMinor,
        currency,
    };
    const verified = await deps.verifySettlement.verifySettlement(request);
    if (verified === null) {
        fail('settlement_verification_failed', 'the settlement verifier did not confirm this settlement');
    }
    if (verified.tenantId !== tenantId
        || verified.obligationId !== obligationId
        || verified.settlementReference !== settlementReference
        || verified.currency !== currency
        || typeof verified.settledAmountMinor !== 'bigint'
        || verified.settledAmountMinor !== settledAmountMinor) {
        fail('settlement_verification_mismatch', 'the verified settlement does not match the requested settlement');
    }
    return store.runAtomic(async (tx) => {
        const obligation = await tx.findObligationForUpdate(tenantId, obligationId);
        if (obligation === null)
            fail('obligation_not_found', `obligation ${obligationId} was not found`);
        if (obligation.tenantId !== tenantId) {
            fail('invalid_tenant', 'the locked obligation belongs to another tenant');
        }
        assertMerchantPurpose(obligation);
        await assertPaidOrderMatches(tx, obligation);
        if (obligation.status !== 'completed') {
            fail('receipt_not_completed', 'merchant funds cannot settle before the receipt journal is completed');
        }
        if (obligation.currency !== currency) {
            fail('currency_mismatch', 'the settlement currency does not equal the obligation currency');
        }
        const netMinor = obligation.netMinor;
        if (netMinor === null) {
            fail('store_inconsistent', 'a completed obligation has no proved net');
        }
        if (settledAmountMinor > netMinor) {
            fail('settlement_amount_exceeds_pending', 'the settled amount exceeds the proved merchant liability');
        }
        if (obligation.providerSettlementReference !== null) {
            if (obligation.providerSettlementReference !== settlementReference) {
                fail('settlement_reference_conflict', 'the obligation is already reconciled to another settlement reference');
            }
            const key = merchantSettlementJournalKey(obligation.id, settlementReference);
            const journal = await tx.findJournalByIdempotencyKey(tenantId, key);
            if (journal === null) {
                fail('store_inconsistent', 'a reconciled obligation has no settlement journal at its key');
            }
            // The stored identity of the settled amount is the journal itself: every
            // line of the two-line settlement journal carries the settled amount.
            if (journal.lines.length !== 2
                || journal.lines.some((line) => line.amountMinor !== settledAmountMinor)) {
                fail('settlement_amount_conflict', 'the settlement reference was already settled for a different amount');
            }
            return { status: 'settled', replayed: true, journalId: journal.id, obligation };
        }
        const accounts = await (0, billing_ledger_1.provisionAccountsInTransaction)(tx, {
            tenantId,
            accounts: [
                { kind: 'merchant_pending', currency: obligation.currency },
                { kind: 'merchant_available', currency: obligation.currency },
            ],
        });
        const pending = accountOfKind(accounts, 'merchant_pending');
        const available = accountOfKind(accounts, 'merchant_available');
        const key = merchantSettlementJournalKey(obligation.id, settlementReference);
        const posted = await (0, billing_ledger_1.postJournalInTransaction)(tx, {
            tenantId,
            currency: obligation.currency,
            idempotencyKey: key,
            reference: `settlement:${settlementReference}`,
            description: 'verified merchant settlement',
            lines: [
                { accountId: pending.id, direction: 'debit', amountMinor: settledAmountMinor },
                { accountId: available.id, direction: 'credit', amountMinor: settledAmountMinor },
            ],
        });
        const cas = await tx.recordObligationSettlement({
            tenantId,
            obligationId: obligation.id,
            expectedVersion: obligation.version,
            settlementReference,
        });
        if (!cas.ok)
            mapCasFailure(cas);
        await tx.writeAudit({
            action: 'billing.settlement.merchant_settled',
            tenantId,
            obligationId: cas.obligation.id,
            orderId: cas.obligation.orderId,
            invoiceId: null,
            journalId: posted.journal.id,
            amountMinor: (0, billing_ledger_1.serializeMoneyMinor)(settledAmountMinor),
            currency: cas.obligation.currency,
            status: cas.obligation.status,
            settlementReference,
        });
        return {
            status: 'settled',
            replayed: posted.replayed,
            journalId: posted.journal.id,
            obligation: cas.obligation,
        };
    });
}
/* =========================================================================
 * (3) Platform receipt, allocation, reversal and balance (CL-B section 14)
 * ========================================================================= */
function assertPlatformDifferencePurpose(obligation) {
    if (!exports.PLATFORM_DIFFERENCE_PAYMENT_PURPOSES.has(obligation.purpose)) {
        fail('purpose_mismatch', `obligation purpose '${obligation.purpose}' is not a platform subscription difference purpose`);
    }
}
/** True when the immutable binding row is exactly the locked obligation's order identity. */
function targetMatchesObligation(obligation, target) {
    return target.tenantId === obligation.tenantId
        && target.orderId === obligation.orderId
        && target.purpose === obligation.purpose
        && exports.PLATFORM_DIFFERENCE_PAYMENT_PURPOSES.has(target.purpose)
        && target.currency === obligation.currency
        && target.amountMinor === obligation.amountMinor;
}
function requireTargetBinding(obligation, target) {
    if (target === null) {
        fail('platform_target_missing', `order ${obligation.orderId} has no immutable platform target binding; this is a reconciliation case`);
    }
    if (!targetMatchesObligation(obligation, target)) {
        fail('target_mismatch', 'the platform target binding does not equal the locked obligation');
    }
    return target;
}
/**
 * Shape proof of one platform journal: tenant, currency, type, key, reference,
 * exactly two lines on two distinct accounts with the expected kinds and
 * directions, both for the expected amount. Existence alone is never proof.
 */
function platformJournalMatches(journal, expected) {
    if (journal === null)
        return false;
    if (journal.tenantId !== expected.tenantId
        || journal.currency !== expected.currency
        || journal.journalType !== expected.journalType
        || journal.reversalOfJournalId !== expected.reversalOfJournalId
        || journal.idempotencyKey !== expected.idempotencyKey
        || journal.reference !== expected.reference
        || journal.lines.length !== 2) {
        return false;
    }
    const debitLine = journal.lines.find((line) => line.direction === 'debit');
    const creditLine = journal.lines.find((line) => line.direction === 'credit');
    if (debitLine === undefined || creditLine === undefined)
        return false;
    return debitLine.accountId !== creditLine.accountId
        && debitLine.accountKind === expected.debit
        && creditLine.accountKind === expected.credit
        && debitLine.amountMinor === expected.amountMinor
        && creditLine.amountMinor === expected.amountMinor;
}
function expectedReceiptJournal(obligation, amountMinor) {
    const shape = billing_ledger_1.PLATFORM_JOURNAL_SHAPES.receipt;
    return {
        tenantId: obligation.tenantId,
        currency: obligation.currency,
        journalType: 'standard',
        reversalOfJournalId: null,
        idempotencyKey: platformReceiptJournalKey(asSettlementObligationId(obligation.id)),
        reference: `${shape.referencePrefix}${obligation.id}`,
        debit: shape.debit,
        credit: shape.credit,
        amountMinor,
    };
}
function expectedAllocationJournal(obligation, invoiceId, amountMinor) {
    const shape = billing_ledger_1.PLATFORM_JOURNAL_SHAPES.allocation;
    return {
        tenantId: obligation.tenantId,
        currency: obligation.currency,
        journalType: 'standard',
        reversalOfJournalId: null,
        idempotencyKey: platformAllocationJournalKey(asSettlementObligationId(obligation.id), invoiceId),
        reference: `${shape.referencePrefix}${obligation.id}:${invoiceId}`,
        debit: shape.debit,
        credit: shape.credit,
        amountMinor,
    };
}
function expectedReversalJournal(payment, amountMinor) {
    const shape = billing_ledger_1.PLATFORM_JOURNAL_SHAPES.allocation;
    return {
        tenantId: payment.tenantId,
        currency: payment.currency,
        journalType: 'reversal',
        reversalOfJournalId: payment.journalId,
        idempotencyKey: platformAllocationReversalJournalKey(payment.allocationId),
        reference: `${billing_ledger_1.PLATFORM_ALLOCATION_REVERSAL_REFERENCE_PREFIX}${payment.allocationId}`,
        debit: shape.credit,
        credit: shape.debit,
        amountMinor,
    };
}
function expectedIssuanceJournal(invoice) {
    const shape = billing_ledger_1.PLATFORM_JOURNAL_SHAPES.issuance;
    return {
        tenantId: invoice.tenantId,
        currency: invoice.currency,
        journalType: 'standard',
        reversalOfJournalId: null,
        idempotencyKey: `${billing_ledger_1.PLATFORM_ISSUANCE_KEY_PREFIX}${invoice.invoiceId}`,
        reference: `${shape.referencePrefix}${invoice.invoiceId}`,
        debit: shape.debit,
        credit: shape.credit,
        // Composition v1: new charge == invoice total (billing-invoices deriveInvoiceChargeComposition).
        amountMinor: invoice.totalMinor,
    };
}
async function receiptJournalProves(reader, obligation) {
    if (obligation.platformReceiptJournalId === null || obligation.allocatableMinor === null)
        return false;
    const journal = await reader.getJournal(obligation.tenantId, obligation.platformReceiptJournalId);
    return platformJournalMatches(journal, expectedReceiptJournal(obligation, obligation.allocatableMinor))
        && journal.id === obligation.platformReceiptJournalId;
}
const EVALUATION_INVALID = { ok: false, reason: 'allocation_arithmetic_invalid' };
function amountInBound(value) {
    return typeof value === 'bigint' && value > 0n && value <= MAX_MINOR;
}
/**
 * Kind-aware proof arithmetic (CL-B 14.2.3): payment rows tied to THIS
 * obligation and its target invoice, backed by posted allocation journals, less
 * effective reversals with valid provenance. `credit` rows never count as this
 * payer's payment. Anything unknown, negative, over the allocatable amount or
 * without a resolvable journal is a typed invalid result (never zero, never
 * clamped). A legacy direct allocation is reported separately.
 */
async function evaluatePlatformAllocationRows(reader, obligation, target, rows) {
    const journals = new Map();
    const loadJournal = async (journalId) => {
        if (!journals.has(journalId)) {
            journals.set(journalId, await reader.getJournal(obligation.tenantId, journalId));
        }
        return journals.get(journalId) ?? null;
    };
    // Pass 1: a legacy direct allocation anywhere makes the obligation legacy-bound.
    for (const row of rows) {
        if (row.kind !== 'payment')
            continue;
        const journal = await loadJournal(row.journalId);
        if (journal !== null && (0, billing_ledger_1.classifyPlatformJournal)(journal.idempotencyKey) === 'legacy_direct_allocation') {
            return { ok: false, reason: 'legacy_path_bound' };
        }
    }
    const payments = new Map();
    const reversals = [];
    for (const row of rows) {
        if (row.tenantId !== obligation.tenantId || row.obligationId !== obligation.id)
            return EVALUATION_INVALID;
        if (row.kind === 'credit')
            continue;
        if (row.kind === 'reversal') {
            reversals.push(row);
            continue;
        }
        if (row.kind !== 'payment')
            return EVALUATION_INVALID;
        if (payments.has(row.allocationId)
            || !amountInBound(row.amountMinor)
            || row.currency !== obligation.currency
            || row.invoiceId !== target.invoiceId
            || row.paymentReference !== obligation.id
            || row.reversesAllocationId !== null) {
            return EVALUATION_INVALID;
        }
        const journal = await loadJournal(row.journalId);
        if (journal === null
            || row.journalId !== journal.id
            || !platformJournalMatches(journal, expectedAllocationJournal(obligation, row.invoiceId, row.amountMinor))) {
            return EVALUATION_INVALID;
        }
        payments.set(row.allocationId, row);
    }
    if (payments.size > 1)
        return EVALUATION_INVALID;
    const reversedPayments = new Set();
    let reversedMinor = 0n;
    for (const row of reversals) {
        const payment = row.reversesAllocationId === null ? undefined : payments.get(row.reversesAllocationId);
        if (payment === undefined
            || reversedPayments.has(payment.allocationId)
            || !amountInBound(row.amountMinor)
            || row.amountMinor > payment.amountMinor
            || row.invoiceId !== payment.invoiceId
            || row.currency !== payment.currency
            || row.paymentReference !== `reversal:${payment.allocationId}`) {
            return EVALUATION_INVALID;
        }
        const journal = await loadJournal(row.journalId);
        if (journal === null
            || row.journalId !== journal.id
            || !platformJournalMatches(journal, expectedReversalJournal(payment, row.amountMinor))) {
            return EVALUATION_INVALID;
        }
        reversedPayments.add(payment.allocationId);
        reversedMinor += row.amountMinor;
    }
    let grossMinor = 0n;
    for (const payment of payments.values())
        grossMinor += payment.amountMinor;
    if (reversedMinor > grossMinor)
        return EVALUATION_INVALID;
    const netMinor = grossMinor - reversedMinor;
    if (netMinor < 0n)
        return EVALUATION_INVALID;
    if (obligation.allocatableMinor === null) {
        if (payments.size > 0)
            return EVALUATION_INVALID;
    }
    else if (grossMinor > obligation.allocatableMinor || netMinor > obligation.allocatableMinor) {
        return EVALUATION_INVALID;
    }
    const payment = payments.size === 1 ? payments.values().next().value : null;
    return {
        ok: true,
        payment,
        paymentJournal: payment === null ? null : (journals.get(payment.journalId) ?? null),
        reversal: payment === null
            ? null
            : (reversals.find((row) => row.reversesAllocationId === payment.allocationId) ?? null),
        grossMinor,
        reversedMinor,
        netMinor,
    };
}
function failEvaluation(evaluation) {
    if (evaluation.reason === 'legacy_path_bound') {
        fail('legacy_path_bound', 'the obligation already carries a legacy direct allocation and is a reconciliation case');
    }
    fail('allocation_arithmetic_invalid', 'the obligation allocation rows do not form a provable, non-negative net total');
}
/** Proven outstanding of the locked target invoice; typed failures, never a clamp. */
async function readProvenOutstanding(tx, invoice) {
    const issuance = await tx.findInvoiceIssuance(invoice.tenantId, invoice.invoiceId);
    if (issuance === null) {
        fail('receivable_not_issued', 'the invoice has no issuance journal link; no receivable can be credited');
    }
    if (issuance.tenantId !== invoice.tenantId || issuance.invoiceId !== invoice.invoiceId) {
        fail('store_inconsistent', 'the invoice issuance link does not match the locked invoice');
    }
    const issuanceJournal = await tx.getJournal(invoice.tenantId, issuance.journalId);
    if (!platformJournalMatches(issuanceJournal, expectedIssuanceJournal(invoice))) {
        fail('issuance_journal_invalid', 'the invoice issuance journal does not prove the new charge (tenant, currency, reference, accounts, amount)');
    }
    const total = await tx.readInvoiceAllocationTotal(invoice.tenantId, invoice.invoiceId, invoice.currency);
    if (!total.ok)
        fail('debt_source_unavailable', 'the invoice allocation source is incomplete');
    if (total.totalMinor > invoice.totalMinor) {
        fail('debt_source_unavailable', 'the invoice allocation source exceeds the invoice total');
    }
    return invoice.totalMinor - total.totalMinor;
}
/**
 * Post the verified platform receipt at most once per obligation:
 * debit platform_cash / credit platform_unallocated_receipts for the verified
 * `allocatable_minor`; the obligation rests at `awaiting_allocation` carrying
 * the amount and the receipt journal id. When the allocatable amount cannot be
 * proved nothing is posted and the obligation rests at `awaiting_allocation`
 * with every new column NULL. A proved positive fee+tax fails closed (HELD).
 */
async function recordVerifiedPlatformReceipt(store, input, deps = {}) {
    const tenantId = requireBoundedString(input.tenantId, 'tenantId', billing_ledger_1.MAX_TENANT_ID_LENGTH, 'invalid_tenant');
    const obligationId = asSettlementObligationId(input.obligationId);
    // Phase 1 (plain read): provider identity for the proof request. The
    // provider-facing call must never run while a row lock is held.
    let proof = 'unavailable';
    const verifier = deps.allocatableVerifier;
    if (verifier !== undefined) {
        if (typeof verifier.verifyAllocatable !== 'function') {
            fail('invalid_input', 'allocatableVerifier must implement verifyAllocatable');
        }
        const identity = await store.runAtomic(async (tx) => {
            const found = await tx.findObligationForRead(tenantId, obligationId);
            if (found === null)
                fail('obligation_not_found', `obligation ${obligationId} was not found`);
            if (found.tenantId !== tenantId)
                fail('invalid_tenant', 'the obligation belongs to another tenant');
            assertPlatformDifferencePurpose(found);
            return found.platformReceiptJournalId !== null
                ? null
                : { provider: found.provider, providerEventId: found.providerEventId };
        });
        if (identity !== null) {
            const answer = await verifier.verifyAllocatable({
                tenantId,
                obligationId,
                provider: identity.provider,
                providerEventId: identity.providerEventId,
            });
            if (answer !== 'unavailable') {
                if (typeof answer !== 'object' || answer === null) {
                    fail('invalid_amount', 'the allocatable proof is malformed');
                }
                const fee = optionalMinor(answer.feeMinor, 'proved feeMinor');
                const tax = optionalMinor(answer.taxMinor, 'proved taxMinor');
                const allocatable = optionalMinor(answer.allocatableMinor, 'proved allocatableMinor');
                if (fee === null || tax === null || allocatable === null) {
                    fail('invalid_amount', 'the allocatable proof must carry fee, tax and allocatable');
                }
                proof = { feeMinor: fee, taxMinor: tax, allocatableMinor: allocatable };
            }
        }
    }
    return store.runAtomic(async (tx) => {
        // G4
        const obligation = await tx.findObligationForUpdate(tenantId, obligationId);
        if (obligation === null)
            fail('obligation_not_found', `obligation ${obligationId} was not found`);
        if (obligation.tenantId !== tenantId)
            fail('invalid_tenant', 'the locked obligation belongs to another tenant');
        assertPlatformDifferencePurpose(obligation);
        if (obligation.status === 'completed' || obligation.journalId !== null) {
            fail('obligation_status_conflict', 'a merchant receipt obligation cannot be received as a platform payment');
        }
        const merchantReceipt = await tx.findJournalByIdempotencyKey(tenantId, merchantReceiptJournalKey(obligation.id));
        if (merchantReceipt !== null) {
            fail('obligation_status_conflict', 'the obligation already has a merchant receipt journal');
        }
        // G5
        await assertPaidOrderMatches(tx, obligation);
        // G6
        requireTargetBinding(obligation, await tx.findPlatformTargetByOrder(tenantId, obligation.orderId, 'share'));
        // Replay: the receipt is already posted and linked.
        if (obligation.platformReceiptJournalId !== null) {
            if (!(await receiptJournalProves(tx, obligation))) {
                fail('store_inconsistent', 'the stored platform receipt journal does not prove the allocatable amount');
            }
            return {
                status: 'awaiting_allocation',
                posted: true,
                replayed: true,
                obligation,
                journalId: obligation.platformReceiptJournalId,
            };
        }
        // Mutual exclusion with the legacy direct path (never both for one payment).
        const prior = await tx.findAllocationByObligation(tenantId, obligation.id);
        if (prior !== null) {
            const priorJournal = await tx.getJournal(tenantId, prior.journalId);
            if (priorJournal !== null
                && (0, billing_ledger_1.classifyPlatformJournal)(priorJournal.idempotencyKey) === 'legacy_direct_allocation') {
                fail('legacy_path_bound', 'the obligation already carries a legacy direct allocation');
            }
            fail('store_inconsistent', 'an allocation exists although no platform receipt journal is recorded');
        }
        if (proof === 'unavailable') {
            // Not proved: nothing posted, every new column stays NULL (never 0).
            if (obligation.status === 'awaiting_allocation') {
                return {
                    status: 'awaiting_allocation',
                    posted: false,
                    replayed: true,
                    obligation,
                    journalId: null,
                };
            }
            const cas = await tx.markObligationAwaitingAllocation({
                tenantId,
                obligationId: obligation.id,
                expectedVersion: obligation.version,
                feeMinor: null,
                taxMinor: null,
                netMinor: null,
                providerReceiptReference: obligation.providerReceiptReference,
            });
            if (!cas.ok)
                mapCasFailure(cas);
            await tx.writeAudit({
                action: 'billing.settlement.receipt_awaiting_allocation',
                tenantId,
                obligationId: cas.obligation.id,
                orderId: cas.obligation.orderId,
                invoiceId: null,
                journalId: null,
                amountMinor: (0, billing_ledger_1.serializeMoneyMinor)(cas.obligation.amountMinor),
                currency: cas.obligation.currency,
                status: cas.obligation.status,
                settlementReference: null,
            });
            return {
                status: 'awaiting_allocation',
                posted: false,
                replayed: false,
                obligation: cas.obligation,
                journalId: null,
            };
        }
        const { feeMinor, taxMinor, allocatableMinor } = proof;
        if (allocatableMinor <= 0n) {
            fail('allocation_arithmetic_invalid', 'a proved allocatable amount must be positive');
        }
        if (allocatableMinor + feeMinor + taxMinor !== obligation.amountMinor) {
            fail('allocation_arithmetic_invalid', 'proved allocatable + fee + tax does not equal the verified gross amount');
        }
        if (feeMinor + taxMinor > 0n) {
            fail('allocation_account_unavailable', 'the frozen ledger account kinds provide no fee/tax liability account; nothing was posted');
        }
        // G10 (ascending kind)
        const accounts = await (0, billing_ledger_1.provisionAccountsInTransaction)(tx, {
            tenantId,
            accounts: [
                { kind: 'platform_cash', currency: obligation.currency },
                { kind: 'platform_unallocated_receipts', currency: obligation.currency },
            ],
        });
        const cash = accountOfKind(accounts, 'platform_cash');
        const unallocated = accountOfKind(accounts, 'platform_unallocated_receipts');
        const expected = expectedReceiptJournal(obligation, allocatableMinor);
        const posted = await (0, billing_ledger_1.postJournalInTransaction)(tx, {
            tenantId,
            currency: obligation.currency,
            idempotencyKey: expected.idempotencyKey,
            reference: expected.reference,
            description: 'verified platform payment receipt',
            lines: [
                { accountId: cash.id, direction: 'debit', amountMinor: allocatableMinor },
                { accountId: unallocated.id, direction: 'credit', amountMinor: allocatableMinor },
            ],
        });
        const cas = await tx.recordPlatformReceipt({
            tenantId,
            obligationId: obligation.id,
            expectedVersion: obligation.version,
            feeMinor,
            taxMinor,
            allocatableMinor,
            platformReceiptJournalId: posted.journal.id,
            providerReceiptReference: obligation.providerReceiptReference,
        });
        if (!cas.ok)
            mapCasFailure(cas);
        await tx.writeAudit({
            action: 'billing.settlement.platform_receipt_posted',
            tenantId,
            obligationId: cas.obligation.id,
            orderId: cas.obligation.orderId,
            invoiceId: null,
            journalId: posted.journal.id,
            amountMinor: (0, billing_ledger_1.serializeMoneyMinor)(allocatableMinor),
            currency: cas.obligation.currency,
            status: cas.obligation.status,
            settlementReference: null,
        });
        return {
            status: 'awaiting_allocation',
            posted: true,
            replayed: posted.replayed,
            obligation: cas.obligation,
            journalId: posted.journal.id,
        };
    });
}
/**
 * Allocate the unallocated platform receipt to the invoice named by the
 * immutable target binding: debit platform_unallocated_receipts / credit
 * platform_receivable, capped at the invoice's PROVEN outstanding. The status
 * becomes `allocated` only when the non-reversed net allocations cover the
 * allocatable amount completely. A smaller outstanding leaves the remainder in
 * unallocated receipts, flags `reconciliation_status = 'discrepancy'` and keeps
 * the obligation at `awaiting_allocation` (over-funded: never discarded, never
 * fully allocated). Nothing is posted when the invoice has no outstanding.
 */
async function allocatePlatformReceiptToInvoice(store, input) {
    const tenantId = requireBoundedString(input.tenantId, 'tenantId', billing_ledger_1.MAX_TENANT_ID_LENGTH, 'invalid_tenant');
    const obligationId = asSettlementObligationId(input.obligationId);
    return store.runAtomic(async (tx) => {
        // Plain reads: learn the immutable ids before any lock.
        const learned = await tx.findObligationForRead(tenantId, obligationId);
        if (learned === null)
            fail('obligation_not_found', `obligation ${obligationId} was not found`);
        if (learned.tenantId !== tenantId)
            fail('invalid_tenant', 'the obligation belongs to another tenant');
        assertPlatformDifferencePurpose(learned);
        const learnedTarget = requireTargetBinding(learned, await tx.findPlatformTargetByOrder(tenantId, learned.orderId, 'none'));
        const invoiceId = learnedTarget.invoiceId;
        // G1, G2
        const invoice = await tx.findInvoiceForDebtUpdate(tenantId, invoiceId);
        if (invoice === null)
            fail('invoice_not_found', `invoice ${invoiceId} was not found in its tenant`);
        if (invoice.tenantId !== tenantId || invoice.invoiceId !== invoiceId) {
            fail('invalid_tenant', 'the locked invoice does not match the target binding');
        }
        if (invoice.currency !== learned.currency) {
            fail('currency_mismatch', 'the invoice currency does not equal the payment currency');
        }
        const outstanding = await readProvenOutstanding(tx, invoice);
        // G4
        const obligation = await tx.findObligationForUpdate(tenantId, obligationId);
        if (obligation === null)
            fail('obligation_not_found', `obligation ${obligationId} disappeared`);
        if (obligation.tenantId !== tenantId || obligation.orderId !== learned.orderId) {
            fail('store_inconsistent', 'the locked obligation does not match the plain read');
        }
        assertPlatformDifferencePurpose(obligation);
        if (obligation.status === 'completed' || obligation.journalId !== null) {
            fail('obligation_status_conflict', 'a completed merchant receipt obligation cannot fund a platform invoice');
        }
        // G5
        await assertPaidOrderMatches(tx, obligation);
        // G6
        const target = requireTargetBinding(obligation, await tx.findPlatformTargetByOrder(tenantId, obligation.orderId, 'share'));
        if (target.invoiceId !== invoiceId || target.requestId !== learnedTarget.requestId) {
            fail('target_mismatch', 'the platform target binding changed between the plain and the locked read');
        }
        const rows = await tx.listPlatformAllocationRows(tenantId, obligation.id);
        const evaluation = await evaluatePlatformAllocationRows(tx, obligation, target, rows);
        if (!evaluation.ok)
            failEvaluation(evaluation);
        if (obligation.allocatableMinor === null
            || obligation.platformReceiptJournalId === null
            || (obligation.status !== 'awaiting_allocation' && obligation.status !== 'allocated')) {
            fail('obligation_status_conflict', 'the platform receipt has not been recorded for this obligation');
        }
        const allocatable = obligation.allocatableMinor;
        if (!(await receiptJournalProves(tx, obligation))) {
            fail('store_inconsistent', 'the stored platform receipt journal does not prove the allocatable amount');
        }
        const unallocatedOf = (net) => (allocatable - net).toString();
        // Replay: the (single) payment allocation already exists.
        if (evaluation.payment !== null) {
            if (obligation.status === 'awaiting_allocation'
                && evaluation.reversedMinor === 0n
                && evaluation.netMinor === allocatable) {
                fail('store_inconsistent', 'the allocation covers the allocatable amount but the status was not advanced');
            }
            return {
                status: obligation.status === 'allocated' ? 'allocated' : 'awaiting_allocation',
                replayed: true,
                allocation: evaluation.payment,
                journalId: evaluation.payment.journalId,
                allocatedMinor: evaluation.netMinor.toString(),
                unallocatedMinor: unallocatedOf(evaluation.netMinor),
                outstandingBeforeMinor: 'unknown',
                outstandingAfterMinor: outstanding.toString(),
            };
        }
        if (obligation.status !== 'awaiting_allocation') {
            fail('store_inconsistent', 'an allocated obligation has no allocation row');
        }
        if (outstanding === 0n) {
            // Nothing can be allocated: the full receipt stays a visible liability
            // in platform_unallocated_receipts and becomes a reconciliation case.
            if (obligation.reconciliationStatus === 'discrepancy') {
                return {
                    status: 'awaiting_allocation',
                    replayed: true,
                    allocation: null,
                    journalId: null,
                    allocatedMinor: '0',
                    unallocatedMinor: allocatable.toString(),
                    outstandingBeforeMinor: '0',
                    outstandingAfterMinor: '0',
                };
            }
            const flagged = await tx.flagObligationReconciliation({
                tenantId,
                obligationId: obligation.id,
                expectedVersion: obligation.version,
                to: 'discrepancy',
            });
            if (!flagged.ok)
                mapCasFailure(flagged);
            await tx.writeAudit({
                action: 'billing.settlement.platform_overfunded',
                tenantId,
                obligationId: flagged.obligation.id,
                orderId: flagged.obligation.orderId,
                invoiceId,
                journalId: null,
                amountMinor: (0, billing_ledger_1.serializeMoneyMinor)(allocatable),
                currency: flagged.obligation.currency,
                status: flagged.obligation.status,
                settlementReference: null,
            });
            return {
                status: 'awaiting_allocation',
                replayed: false,
                allocation: null,
                journalId: null,
                allocatedMinor: '0',
                unallocatedMinor: allocatable.toString(),
                outstandingBeforeMinor: '0',
                outstandingAfterMinor: '0',
            };
        }
        const allocationAmount = allocatable < outstanding ? allocatable : outstanding;
        // G10 (ascending kind)
        const accounts = await (0, billing_ledger_1.provisionAccountsInTransaction)(tx, {
            tenantId,
            accounts: [
                { kind: 'platform_receivable', currency: invoice.currency },
                { kind: 'platform_unallocated_receipts', currency: invoice.currency },
            ],
        });
        const receivable = accountOfKind(accounts, 'platform_receivable');
        const unallocated = accountOfKind(accounts, 'platform_unallocated_receipts');
        const expected = expectedAllocationJournal(obligation, invoiceId, allocationAmount);
        const posted = await (0, billing_ledger_1.postJournalInTransaction)(tx, {
            tenantId,
            currency: invoice.currency,
            idempotencyKey: expected.idempotencyKey,
            reference: expected.reference,
            description: 'verified platform receipt allocated to invoice',
            lines: [
                { accountId: unallocated.id, direction: 'debit', amountMinor: allocationAmount },
                { accountId: receivable.id, direction: 'credit', amountMinor: allocationAmount },
            ],
        });
        const allocation = {
            allocationId: (0, node_crypto_1.randomUUID)(),
            tenantId,
            invoiceId,
            obligationId: obligation.id,
            paymentReference: obligation.id,
            amountMinor: allocationAmount,
            currency: invoice.currency,
            kind: 'payment',
            journalId: posted.journal.id,
            reversesAllocationId: null,
            createdAt: new Date().toISOString(),
        };
        const inserted = await tx.insertPaymentAllocation(allocation);
        if (inserted === 'duplicate_key') {
            const winner = await tx.findAllocationByPaymentInvoiceForShare(tenantId, allocation.paymentReference, invoiceId, 'payment');
            if (winner === null) {
                fail('store_inconsistent', 'an allocation duplicate could not be re-read inside the transaction');
            }
            return {
                status: 'awaiting_allocation',
                replayed: true,
                allocation: winner,
                journalId: winner.journalId,
                allocatedMinor: winner.amountMinor.toString(),
                unallocatedMinor: unallocatedOf(winner.amountMinor),
                outstandingBeforeMinor: 'unknown',
                outstandingAfterMinor: 'unknown',
            };
        }
        const fullyAllocated = allocationAmount === allocatable;
        let current = obligation;
        if (fullyAllocated) {
            const cas = await tx.markObligationAllocated({
                tenantId,
                obligationId: obligation.id,
                expectedVersion: obligation.version,
            });
            if (!cas.ok)
                mapCasFailure(cas);
            current = cas.obligation;
        }
        else if (obligation.reconciliationStatus !== 'discrepancy') {
            const cas = await tx.flagObligationReconciliation({
                tenantId,
                obligationId: obligation.id,
                expectedVersion: obligation.version,
                to: 'discrepancy',
            });
            if (!cas.ok)
                mapCasFailure(cas);
            current = cas.obligation;
        }
        // Exactly one sealed audit per unit: the over-funded case carries the
        // stronger action and still records the allocation journal and amount.
        await tx.writeAudit({
            action: fullyAllocated
                ? 'billing.settlement.platform_allocated'
                : 'billing.settlement.platform_overfunded',
            tenantId,
            obligationId: current.id,
            orderId: current.orderId,
            invoiceId,
            journalId: posted.journal.id,
            amountMinor: (0, billing_ledger_1.serializeMoneyMinor)(allocationAmount),
            currency: invoice.currency,
            status: current.status,
            settlementReference: null,
        });
        return {
            status: fullyAllocated ? 'allocated' : 'awaiting_allocation',
            replayed: posted.replayed,
            allocation,
            journalId: posted.journal.id,
            allocatedMinor: allocationAmount.toString(),
            unallocatedMinor: unallocatedOf(allocationAmount),
            outstandingBeforeMinor: outstanding.toString(),
            outstandingAfterMinor: (outstanding - allocationAmount).toString(),
        };
    });
}
/**
 * The ONLY compensation of a platform allocation. Posts the `reversal` mirror
 * (debit platform_receivable / credit platform_unallocated_receipts; cash is
 * untouched) through `postJournalInTransaction` with the reversal key, inserts
 * one `kind = 'reversal'` allocation row with `reverses_allocation_id`, flags
 * `reconciliation_status = 'discrepancy'` and writes one sealed audit. The
 * obligation status is never rewritten and no row is deleted. Re-funding after a
 * reversal is a HELD process.
 */
async function reversePlatformAllocation(store, input) {
    const tenantId = requireBoundedString(input.tenantId, 'tenantId', billing_ledger_1.MAX_TENANT_ID_LENGTH, 'invalid_tenant');
    const allocationId = requireBoundedString(input.allocationId, 'allocationId', exports.MAX_ALLOCATION_ID_LENGTH, 'invalid_input');
    const reason = requireBoundedString(input.reason, 'reason', exports.MAX_REASON_LENGTH, 'invalid_input');
    const actorId = requireBoundedString(input.actorId, 'actorId', exports.MAX_ACTOR_ID_LENGTH, 'invalid_input');
    return store.runAtomic(async (tx) => {
        // Plain read: learn invoice and obligation ids before any lock.
        const learned = await tx.findAllocationById(tenantId, allocationId);
        if (learned === null)
            fail('allocation_not_found', `allocation ${allocationId} was not found in its tenant`);
        if (learned.kind !== 'payment' || learned.obligationId === null) {
            fail('allocation_mismatch', 'only a platform payment allocation can be reversed');
        }
        // G1, G2
        const invoice = await tx.findInvoiceForDebtUpdate(tenantId, learned.invoiceId);
        if (invoice === null)
            fail('invoice_not_found', `invoice ${learned.invoiceId} was not found in its tenant`);
        if (invoice.tenantId !== tenantId || invoice.currency !== learned.currency) {
            fail('currency_mismatch', 'the locked invoice does not match the allocation');
        }
        const total = await tx.readInvoiceAllocationTotal(tenantId, invoice.invoiceId, invoice.currency);
        if (!total.ok || total.totalMinor > invoice.totalMinor) {
            fail('debt_source_unavailable', 'the invoice allocation source is incomplete');
        }
        // G4
        const obligation = await tx.findObligationForUpdate(tenantId, learned.obligationId);
        if (obligation === null)
            fail('obligation_not_found', `obligation ${learned.obligationId} was not found`);
        if (obligation.tenantId !== tenantId)
            fail('invalid_tenant', 'the locked obligation belongs to another tenant');
        assertPlatformDifferencePurpose(obligation);
        if (obligation.journalId !== null || obligation.status === 'completed') {
            fail('obligation_status_conflict', 'a merchant receipt obligation has no platform allocation to reverse');
        }
        // G6
        const target = requireTargetBinding(obligation, await tx.findPlatformTargetByOrder(tenantId, obligation.orderId, 'share'));
        if (target.invoiceId !== learned.invoiceId) {
            fail('target_mismatch', 'the allocation invoice is not the obligation target invoice');
        }
        const rows = await tx.listPlatformAllocationRows(tenantId, obligation.id);
        const evaluation = await evaluatePlatformAllocationRows(tx, obligation, target, rows);
        if (!evaluation.ok)
            failEvaluation(evaluation);
        const payment = evaluation.payment;
        if (payment === null || payment.allocationId !== allocationId || evaluation.paymentJournal === null) {
            fail('allocation_mismatch', 'the allocation is not the valid payment allocation of its obligation');
        }
        if (evaluation.reversal !== null) {
            return {
                replayed: true,
                reversalAllocation: evaluation.reversal,
                journalId: evaluation.reversal.journalId,
            };
        }
        if (obligation.status !== 'awaiting_allocation' && obligation.status !== 'allocated') {
            fail('obligation_status_conflict', 'the obligation status does not allow an allocation reversal');
        }
        const original = evaluation.paymentJournal;
        const expected = expectedReversalJournal(payment, payment.amountMinor);
        // G10: the accounts are the ones the original journal touched (full mirror).
        const posted = await (0, billing_ledger_1.postJournalInTransaction)(tx, {
            tenantId,
            currency: payment.currency,
            idempotencyKey: expected.idempotencyKey,
            reference: expected.reference,
            description: 'platform allocation reversal',
            journalType: 'reversal',
            reversalOfJournalId: original.id,
            lines: original.lines.map((line) => ({
                accountId: line.accountId,
                direction: line.direction === 'debit' ? 'credit' : 'debit',
                amountMinor: line.amountMinor,
            })),
        });
        const reversalRow = {
            allocationId: (0, node_crypto_1.randomUUID)(),
            tenantId,
            invoiceId: payment.invoiceId,
            obligationId: obligation.id,
            paymentReference: `reversal:${payment.allocationId}`,
            amountMinor: payment.amountMinor,
            currency: payment.currency,
            kind: 'reversal',
            journalId: posted.journal.id,
            reversesAllocationId: payment.allocationId,
            createdAt: new Date().toISOString(),
        };
        const inserted = await tx.insertPaymentAllocation(reversalRow);
        if (inserted === 'duplicate_key') {
            const winner = await tx.findAllocationByPaymentInvoiceForShare(tenantId, reversalRow.paymentReference, reversalRow.invoiceId, 'reversal');
            if (winner === null || winner.reversesAllocationId !== payment.allocationId) {
                fail('store_inconsistent', 'a reversal duplicate could not be re-read inside the transaction');
            }
            return { replayed: true, reversalAllocation: winner, journalId: winner.journalId };
        }
        let current = obligation;
        if (obligation.reconciliationStatus !== 'discrepancy') {
            const cas = await tx.flagObligationReconciliation({
                tenantId,
                obligationId: obligation.id,
                expectedVersion: obligation.version,
                to: 'discrepancy',
            });
            if (!cas.ok)
                mapCasFailure(cas);
            current = cas.obligation;
        }
        await tx.writeAudit({
            action: 'billing.settlement.platform_allocation_reversed',
            tenantId,
            obligationId: current.id,
            orderId: current.orderId,
            invoiceId: payment.invoiceId,
            journalId: posted.journal.id,
            amountMinor: (0, billing_ledger_1.serializeMoneyMinor)(payment.amountMinor),
            currency: payment.currency,
            status: current.status,
            settlementReference: null,
            allocationId: payment.allocationId,
            reason,
            actorId,
        });
        return { replayed: posted.replayed, reversalAllocation: reversalRow, journalId: posted.journal.id };
    });
}
/**
 * Current, non-reversed allocation balance of one platform obligation, derived
 * only from the obligation, its immutable target binding and its allocation
 * rows (never from a pooled account balance). `allocated` status is history:
 * the state and `netAllocatedMinor` are recomputed on every call.
 */
async function readPlatformAllocationBalance(reader, tenantId, obligationId) {
    const tenant = requireBoundedString(tenantId, 'tenantId', billing_ledger_1.MAX_TENANT_ID_LENGTH, 'invalid_tenant');
    const id = asSettlementObligationId(obligationId);
    try {
        const obligation = await reader.findObligationForShare(tenant, id);
        if (obligation === null || obligation.tenantId !== tenant || obligation.id !== id) {
            return { ok: false, reason: 'obligation_not_found' };
        }
        if (!exports.PLATFORM_DIFFERENCE_PAYMENT_PURPOSES.has(obligation.purpose)) {
            return { ok: false, reason: 'purpose_not_allowed' };
        }
        const target = await reader.findPlatformTargetByOrder(tenant, obligation.orderId);
        if (target === null)
            return { ok: false, reason: 'unresolved_reference' };
        if (!targetMatchesObligation(obligation, target))
            return { ok: false, reason: 'target_mismatch' };
        const rows = await reader.listPlatformAllocationRows(tenant, obligation.id);
        const evaluation = await evaluatePlatformAllocationRows(reader, obligation, target, rows);
        if (!evaluation.ok)
            return { ok: false, reason: evaluation.reason };
        const allocatable = obligation.allocatableMinor;
        if (allocatable === null || obligation.platformReceiptJournalId === null) {
            return { ok: false, reason: 'allocatable_unproven' };
        }
        if (!(await receiptJournalProves(reader, obligation))) {
            return { ok: false, reason: 'allocation_arithmetic_invalid' };
        }
        const { grossMinor, reversedMinor, netMinor } = evaluation;
        let state;
        if (reversedMinor > 0n)
            state = 'reversed_after_allocation';
        else if (netMinor === allocatable)
            state = 'allocated';
        else if (netMinor > 0n || obligation.reconciliationStatus === 'discrepancy')
            state = 'over_funded';
        else
            state = 'unallocated';
        return {
            ok: true,
            obligationId: obligation.id,
            requestId: target.requestId,
            invoiceId: target.invoiceId,
            currency: obligation.currency,
            allocatableMinor: allocatable,
            allocatedGrossMinor: grossMinor,
            effectiveReversedMinor: reversedMinor,
            netAllocatedMinor: netMinor,
            unallocatedMinor: allocatable - netMinor,
            state,
            reconciliationStatus: obligation.reconciliationStatus,
        };
    }
    catch (error) {
        if (isDebtSourceUnavailableError(error))
            return { ok: false, reason: 'debt_source_unavailable' };
        throw error;
    }
}
/**
 * Replays cannot know the historical "before" value (later allocations may
 * exist), so it is 'unknown'; "after" is the current recomputed outstanding
 * under the already held invoice lock, or 'unknown' when the source is incomplete.
 */
async function recomputeReplayOutstanding(tx, invoice) {
    const total = await tx.readInvoiceAllocationTotal(invoice.tenantId, invoice.invoiceId, invoice.currency);
    if (!total.ok || total.totalMinor > invoice.totalMinor) {
        return { outstandingBeforeMinor: 'unknown', outstandingAfterMinor: 'unknown' };
    }
    return {
        outstandingBeforeMinor: 'unknown',
        outstandingAfterMinor: (invoice.totalMinor - total.totalMinor).toString(),
    };
}
/**
 * REPLAY-ONLY. Returns the existing allocation of the obligation on the invoice
 * and otherwise fails `legacy_path_disabled`; it NEVER posts the legacy
 * `platform_cash -> platform_receivable` journal again. New receipts go through
 * `recordVerifiedPlatformReceipt` + `allocatePlatformReceiptToInvoice`.
 * Lock order: invoice (G1), its allocation rows (G2), then the obligation (G4).
 */
async function allocateVerifiedPaymentToInvoice(store, input) {
    const tenantId = requireBoundedString(input.tenantId, 'tenantId', billing_ledger_1.MAX_TENANT_ID_LENGTH, 'invalid_tenant');
    const obligationId = requireBoundedString(input.obligationId, 'obligationId', exports.MAX_OBLIGATION_ID_LENGTH, 'invalid_input');
    const invoiceId = requireBoundedString(input.invoiceId, 'invoiceId', exports.MAX_INVOICE_ID_LENGTH, 'invalid_input');
    return store.runAtomic(async (tx) => {
        // Plain reads: is there anything to replay at all?
        const anyAllocation = await tx.findAllocationByObligation(tenantId, obligationId);
        if (anyAllocation !== null && anyAllocation.invoiceId !== invoiceId) {
            fail('allocation_conflict', 'this payment is already allocated to another invoice');
        }
        const learned = await tx.findAllocationByPaymentInvoice(tenantId, obligationId, invoiceId, 'payment');
        if (learned === null) {
            fail('legacy_path_disabled', 'direct platform_cash -> platform_receivable allocation is disabled; use recordVerifiedPlatformReceipt and allocatePlatformReceiptToInvoice');
        }
        // G1, G2
        const invoice = await tx.findInvoiceForDebtUpdate(tenantId, invoiceId);
        if (invoice === null)
            fail('invoice_not_found', `invoice ${invoiceId} was not found in its tenant`);
        if (invoice.tenantId !== tenantId)
            fail('invalid_tenant', 'the locked invoice belongs to another tenant');
        if (invoice.currency !== learned.currency) {
            fail('currency_mismatch', 'the invoice currency does not equal the payment currency');
        }
        const replayOutstanding = await recomputeReplayOutstanding(tx, invoice);
        // G4
        const obligation = await tx.findObligationForUpdate(tenantId, obligationId);
        if (obligation === null)
            fail('obligation_not_found', `obligation ${obligationId} was not found`);
        if (obligation.tenantId !== tenantId)
            fail('invalid_tenant', 'the locked obligation belongs to another tenant');
        if (obligation.status === 'completed' || obligation.journalId !== null) {
            fail('obligation_status_conflict', 'a completed merchant receipt obligation cannot also fund a platform invoice');
        }
        assertPlatformInvoicePurpose(obligation);
        const existing = await tx.findAllocationByPaymentInvoiceForShare(tenantId, obligation.id, invoiceId, 'payment');
        if (existing === null) {
            fail('store_inconsistent', 'a plain-read allocation disappeared under the obligation lock');
        }
        return {
            status: 'allocated',
            replayed: true,
            allocation: existing,
            journalId: existing.journalId,
            ...replayOutstanding,
        };
    });
}
function requireListLimit(value) {
    if (value === undefined)
        return exports.DEFAULT_LIST_LIMIT;
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > exports.MAX_LIST_LIMIT) {
        fail('invalid_input', `limit must be an integer between 1 and ${exports.MAX_LIST_LIMIT}`);
    }
    return value;
}
/**
 * Compute one invoice's outstanding allocated debt. The allocation source is
 * the only debt source; a missing invoice/issuance/ledger link is a typed
 * `debt_source_unavailable`, never an invented zero or a counted invoice.
 */
async function computeInvoiceOutstandingUnguarded(reader, tenantId, invoiceId) {
    const tenant = requireBoundedString(tenantId, 'tenantId', billing_ledger_1.MAX_TENANT_ID_LENGTH, 'invalid_tenant');
    const id = requireBoundedString(invoiceId, 'invoiceId', exports.MAX_INVOICE_ID_LENGTH, 'invalid_input');
    const invoice = await reader.findInvoiceForDebtUpdate(tenant, id);
    if (invoice === null)
        return { ok: false, reason: 'invoice_not_found' };
    if (invoice.tenantId !== tenant || invoice.invoiceId !== id) {
        return { ok: false, reason: 'debt_source_unavailable' };
    }
    const issuance = await reader.findInvoiceIssuance(tenant, id);
    if (issuance === null)
        return { ok: false, reason: 'debt_source_unavailable' };
    if (issuance.tenantId !== tenant || issuance.invoiceId !== id) {
        return { ok: false, reason: 'debt_source_unavailable' };
    }
    const total = await reader.readInvoiceAllocationTotal(tenant, id, invoice.currency);
    if (!total.ok)
        return { ok: false, reason: 'debt_source_unavailable' };
    if (total.totalMinor > invoice.totalMinor) {
        return { ok: false, reason: 'debt_source_unavailable' };
    }
    return {
        ok: true,
        invoiceId: invoice.invoiceId,
        currency: invoice.currency,
        outstandingMinor: (invoice.totalMinor - total.totalMinor).toString(),
        due: invoice.due,
    };
}
/**
 * A typed debt-source failure raised by a reader (SQL adapter missing table /
 * locking read refused / corrupt amount row, or this domain) is "unavailable",
 * not an exception. Duck-typed on name + code so no import cycle with the
 * adapter. Deadlock (`lock_conflict`) and lock-wait timeout (`lock_wait_timeout`)
 * are deliberately NOT matched: they propagate so the whole unit rolls back.
 */
function isDebtSourceUnavailableError(error) {
    if (typeof error !== 'object' || error === null)
        return false;
    const { name, code } = error;
    return (name === 'BillingSettlementSqlError' || name === 'SettlementError')
        && (code === 'debt_source_unavailable' || code === 'debt_source_invalid');
}
async function computeInvoiceOutstanding(reader, tenantId, invoiceId) {
    try {
        return await computeInvoiceOutstandingUnguarded(reader, tenantId, invoiceId);
    }
    catch (error) {
        if (isDebtSourceUnavailableError(error))
            return { ok: false, reason: 'debt_source_unavailable' };
        throw error;
    }
}
/**
 * Bounded list of outstanding invoices for the payout gate/read model. Any
 * invoice whose allocation/issuance source is incomplete fails the whole list
 * closed rather than returning an understated debt (which could allow a payout
 * ahead of subscription priority).
 */
async function listInvoiceOutstanding(reader, tenantId, query = {}) {
    const tenant = requireBoundedString(tenantId, 'tenantId', billing_ledger_1.MAX_TENANT_ID_LENGTH, 'invalid_tenant');
    const limit = requireListLimit(query.limit);
    let rows;
    try {
        rows = await reader.listInvoicesForDebt(tenant, limit + 1);
    }
    catch (error) {
        if (isDebtSourceUnavailableError(error))
            return { ok: false, reason: 'debt_source_unavailable' };
        throw error;
    }
    const invoices = [];
    for (const row of rows) {
        if (row.tenantId !== tenant)
            return { ok: false, reason: 'debt_source_unavailable' };
        const outstanding = await computeInvoiceOutstanding(reader, tenant, row.invoiceId);
        if (!outstanding.ok)
            return { ok: false, reason: 'debt_source_unavailable' };
        invoices.push({
            invoiceId: outstanding.invoiceId,
            currency: outstanding.currency,
            outstandingMinor: outstanding.outstandingMinor,
            dueStatus: outstanding.due.status,
            dueAt: outstanding.due.status === 'resolved' ? outstanding.due.dueAt.toString() : null,
            dueBasisRef: outstanding.due.status === 'resolved' ? outstanding.due.basisRef : null,
            dueBasisVersion: outstanding.due.status === 'resolved' ? outstanding.due.basisVersion : null,
        });
    }
    const truncated = rows.length > limit;
    return { ok: true, invoices: invoices.slice(0, limit), truncated };
}
/**
 * Map the accepted ledger error codes that can escape while posting journals to
 * the settlement typed code, so callers never see an untyped negative balance.
 */
function settlementCodeForLedgerError(error) {
    if (!(error instanceof billing_ledger_1.LedgerError))
        return null;
    switch (error.code) {
        case 'account_not_found':
        case 'account_kind_mismatch':
            return 'receivable_not_issued';
        case 'negative_balance':
            return 'settlement_amount_exceeds_pending';
        case 'idempotency_conflict':
            return 'allocation_conflict';
        case 'currency_mismatch':
            return 'currency_mismatch';
        default:
            return null;
    }
}
