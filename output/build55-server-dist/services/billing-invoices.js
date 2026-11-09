"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.INVOICE_STORE_SQL_CONTRACT = exports.BillingInvoiceError = exports.DEFAULT_LIST_LIMIT = exports.MAX_LIST_LIMIT = exports.MAX_IDEMPOTENCY_KEY_LENGTH = exports.MAX_ENTITY_ID_LENGTH = exports.MAX_INVOICE_STRING_LENGTH = exports.OFFER_PRICING_EFFECT_HELD = exports.BILLING_PHASES = exports.INVOICE_COMPOSITION_VERSION = exports.INVOICE_LINE_KINDS = exports.INVOICE_ISSUE_IDEMPOTENCY_SCOPE = exports.INVOICE_MODEL_VERSION = void 0;
exports.deriveInvoiceChargeComposition = deriveInvoiceChargeComposition;
exports.invoiceIssuanceJournalKey = invoiceIssuanceJournalKey;
exports.invoiceIssuanceJournalReference = invoiceIssuanceJournalReference;
exports.verifyInvoiceIssuanceJournal = verifyInvoiceIssuanceJournal;
exports.assertInvoice = assertInvoice;
exports.serializeMinorAmount = serializeMinorAmount;
exports.serializeMajorAmount = serializeMajorAmount;
exports.rebuildInvoice = rebuildInvoice;
exports.issueInvoice = issueInvoice;
exports.reconcileInvoice = reconcileInvoice;
const node_crypto_1 = require("node:crypto");
const billing_ledger_1 = require("./billing-ledger");
const billing_pricing_1 = require("./billing-pricing");
const billing_basis_1 = require("./billing-basis");
const billing_periods_1 = require("./billing-periods");
const billing_snapshots_1 = require("./billing-snapshots");
exports.INVOICE_MODEL_VERSION = 1;
exports.INVOICE_ISSUE_IDEMPOTENCY_SCOPE = 'billing.invoice.issue.v1';
exports.INVOICE_LINE_KINDS = ['base_subscription', 'registration_step'];
/** Closed composition model (docs/streams/server/CL-B-BILLING section 14.5.1). */
exports.INVOICE_COMPOSITION_VERSION = 1;
exports.BILLING_PHASES = ['first', 'recurring'];
exports.OFFER_PRICING_EFFECT_HELD = 'held_not_settled';
exports.MAX_INVOICE_STRING_LENGTH = 128;
/**
 * Identity column bound: `billing_invoices.id`, `billing_invoices.tenant_id`
 * and `billing_idempotency_keys.invoice_id` are `CHAR(36)`.
 */
exports.MAX_ENTITY_ID_LENGTH = 36;
exports.MAX_IDEMPOTENCY_KEY_LENGTH = 128;
exports.MAX_LIST_LIMIT = 1000;
exports.DEFAULT_LIST_LIMIT = 500;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;
const HEX_64_PATTERN = /^[0-9a-f]{64}$/;
const CYCLE_SECONDS_BIGINT = BigInt(billing_periods_1.CYCLE_SECONDS);
class BillingInvoiceError extends Error {
    constructor(code, message) {
        super(message);
        this.code = code;
        this.name = 'BillingInvoiceError';
    }
}
exports.BillingInvoiceError = BillingInvoiceError;
function fail(code, message) {
    throw new BillingInvoiceError(code, message);
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function requireBoundedString(value, field, maxLength) {
    if (typeof value !== 'string')
        fail('validation', `${field} must be a string`);
    if (value.length === 0 || value.length > maxLength) {
        fail('validation', `${field} must be a non-empty string of at most ${maxLength} characters`);
    }
    if (value !== value.trim()) {
        fail('validation', `${field} must not have leading or trailing whitespace`);
    }
    if (/[\u0000-\u001f\u007f]/.test(value)) {
        fail('validation', `${field} must not contain control characters`);
    }
    return value;
}
function requireSafePositiveInteger(value, field) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
        fail('validation', `${field} must be a non-negative safe integer second`);
    }
    return value;
}
function requireBigint(value, field) {
    if (typeof value !== 'bigint')
        fail('validation', `${field} must be a bigint of minor units`);
    return value;
}
function requireHex64(value, field) {
    const text = requireBoundedString(value, field, 128);
    if (!HEX_64_PATTERN.test(text)) {
        fail('validation', `${field} must be a lowercase SHA-256 hex string`);
    }
    return text;
}
/**
 * Separate the NEW charge from carried debt. Composition v1 knows only the
 * prorated cycle lines, so the new charge is exactly the invoice total and no
 * carried debt exists. Any other model version or line kind cannot be
 * separated and issuance is refused (the displayed total is never used as
 * revenue when composition is unknown).
 */
function deriveInvoiceChargeComposition(invoice) {
    if (!isRecord(invoice) || invoice.modelVersion !== exports.INVOICE_MODEL_VERSION || !Array.isArray(invoice.lines)) {
        fail('composition_unseparable', 'the invoice model version cannot be separated into new charge and carried debt');
    }
    for (const line of invoice.lines) {
        if (!isRecord(line) || !exports.INVOICE_LINE_KINDS.includes(line['kind'])) {
            fail('composition_unseparable', 'an invoice line kind cannot be separated into new charge and carried debt');
        }
    }
    if (typeof invoice.totalMinor !== 'bigint' || invoice.totalMinor < 0n) {
        fail('composition_unseparable', 'the invoice total is not an exact non-negative amount');
    }
    return Object.freeze({
        compositionVersion: exports.INVOICE_COMPOSITION_VERSION,
        newChargeMinor: invoice.totalMinor,
        carriedDebtReferenceMinor: 0n,
    });
}
function invoiceIssuanceJournalKey(invoiceId) {
    return `${billing_ledger_1.PLATFORM_ISSUANCE_KEY_PREFIX}${invoiceId}`;
}
function invoiceIssuanceJournalReference(invoiceId) {
    return `${billing_ledger_1.PLATFORM_JOURNAL_SHAPES.issuance.referencePrefix}${invoiceId}`;
}
/**
 * Pure check that a journal is exactly the issuance journal of one invoice's
 * NEW charge: tenant, currency, standard type, reference, key role and the
 * exact two-line shape (receivable debit / subscription revenue credit, both
 * the new charge). Mere existence of a journal never satisfies it. The SQL
 * adapter re-checks the ACTUAL account rows behind the lines.
 */
function verifyInvoiceIssuanceJournal(journal, expected) {
    const no = (reason) => ({ ok: false, reason });
    if (!isRecord(journal))
        return no('journal missing');
    if (journal.tenantId !== expected.tenantId)
        return no('journal tenant differs');
    if (journal.currency !== expected.currency)
        return no('journal currency differs');
    if (journal.journalType !== 'standard' || journal.reversalOfJournalId !== null) {
        return no('journal is not a standard journal');
    }
    if (journal.reference !== invoiceIssuanceJournalReference(expected.invoiceId)) {
        return no('journal reference is not the invoice issuance reference');
    }
    if (journal.idempotencyKey !== invoiceIssuanceJournalKey(expected.invoiceId)
        || (0, billing_ledger_1.classifyPlatformJournal)(journal.idempotencyKey) !== 'issuance') {
        return no('journal idempotency key is not the invoice issuance key');
    }
    if (typeof expected.newChargeMinor !== 'bigint' || expected.newChargeMinor <= 0n) {
        return no('the new charge is not a positive exact amount');
    }
    const lines = journal.lines;
    if (!Array.isArray(lines) || lines.length !== 2)
        return no('journal must have exactly two lines');
    const shape = billing_ledger_1.PLATFORM_JOURNAL_SHAPES.issuance;
    const debit = lines.filter((line) => line.direction === 'debit');
    const credit = lines.filter((line) => line.direction === 'credit');
    if (debit.length !== 1 || credit.length !== 1)
        return no('journal must have one debit and one credit line');
    const debitLine = debit[0];
    const creditLine = credit[0];
    if (debitLine.accountKind !== shape.debit || creditLine.accountKind !== shape.credit) {
        return no('journal line accounts are not receivable (debit) and subscription revenue (credit)');
    }
    if (debitLine.accountId === creditLine.accountId)
        return no('journal lines must use two distinct accounts');
    if (debitLine.amountMinor !== expected.newChargeMinor || creditLine.amountMinor !== expected.newChargeMinor) {
        return no('journal line amounts differ from the invoice new charge');
    }
    return { ok: true };
}
function requireVerifiedIssuanceJournal(journal, expected) {
    const verdict = verifyInvoiceIssuanceJournal(journal, expected);
    if (!verdict.ok) {
        fail('journal_link_conflict', `the receivable journal is not this invoice's issuance journal: ${verdict.reason}`);
    }
}
/**
 * Replay never writes a link. It only reports what exists and fails closed when
 * the command names a journal that differs from (or cannot be compared to) the
 * stored link.
 */
async function replayReceivable(tx, tenantId, invoiceId, commandJournalId) {
    if (typeof tx.findReceivableJournalId !== 'function') {
        if (commandJournalId !== null) {
            fail('journal_link_unavailable', 'the store cannot compare the receivable journal link on replay');
        }
        return { receivableStatus: 'receivable_status_unknown', receivableJournalId: null };
    }
    const linked = await tx.findReceivableJournalId(tenantId, invoiceId);
    if (linked === null)
        return { receivableStatus: 'receivable_not_issued', receivableJournalId: null };
    if (commandJournalId !== null && linked !== commandJournalId) {
        fail('journal_link_conflict', 'the invoice is already linked to a different receivable journal');
    }
    return { receivableStatus: 'receivable_issued', receivableJournalId: linked };
}
exports.INVOICE_STORE_SQL_CONTRACT = Object.freeze([
    'Table credit: invoices live with a composite tenant foreign key on tenant_id and a tenant predicate applied to every query; a global query must never be possible.',
    'UNIQUE (tenant_id, org_kind, cycle_start) enforces one invoice per organization per cycle; the domain key (tenant, org kind, cycle start) maps to exactly one row.',
    'Issued invoice rows are immutable: the schema must have no UPDATE/DELETE grants on invoice or line rows; corrections are new adjustment/credit rows or superseding documents, never rewrites.',
    'Invoice lines live in a child table keyed by (tenant_id, invoice_id, line_id) with a composite tenant foreign key to the invoice.',
    'All money columns are BIGINT minor units and rational numerators/denominators are BIGINT; reads are converted with BigInt() and never pass through Number (HK2 precision rule).',
    'currency is CHAR(3) uppercase ISO-4217.',
    'Idempotent issuance flows through a billing_idempotency_keys registry with UNIQUE (tenant_id, scope, idempotency_key) and columns payload_hash and invoice_id (HK1): lookups carry tenant/scope/payloadHash before any insert.',
    'The frozen price snapshot and, when present, the offer snapshot are persisted on the SAME connection/transaction BEFORE the invoice insert (FK targets); persistence is idempotent by content hash and a rollback removes snapshot, invoice, lines and key together.',
    'The sealed audit row for issuance is written on the SAME connection/transaction as the invoice insert; an audit failure rolls the invoice, its lines and the idempotency key back completely.',
    'Listing is bounded and returns an explicit truncated flag instead of silently cutting the result.',
    'This domain stores prices as captured snapshot values with a SHA-256 content hash; later price-version changes must create new snapshot rows and must never update a stored snapshot.',
    'Invoices reference ledger journals by id in billing_invoice_journals; the only journal this domain ever posts is the issuance journal of the NEW charge (debit platform_receivable / credit platform_subscription_revenue, key billing:invoice_issue:<invoiceId>, reference invoice_issue:<invoiceId>), through the accepted ledger adapter on the SAME connection, never a fabricated zero line, opening receivable or carried-debt revenue.',
    'With receivablePosting "post" the invoice, registry row, issuance journal (with its account provisioning), journal link, billing_invoice_obligations row and the single sealed audit are ONE transaction; a failure of any of them rolls all back and a retry finds the same journal by key.',
    'An already-posted journal is linked (receivablePosting "link_existing") only after it is verified against the invoice new charge: tenant, currency, standard type, issuance key and reference, exactly two lines with ACTUAL accounts platform_receivable (debit) and platform_subscription_revenue (credit) of the new charge; journal existence or a pooled receivable balance is never proof. The link is unique per invoice and per journal.',
    'billing_invoice_obligations is insert-only (invoice_id PK, composite tenant and invoice FKs, new_charge_minor > 0, carried_debt_reference_minor reference only); a duplicate insert reads the stored row back and never overwrites it. Due terms are resolved only when an injected approved rule supplies them (due_at, due_basis_ref, due_basis_version); there is no default deadline and no backfill, a missing row reads as unresolved.',
    'Without a journal id and without receivablePosting nothing is linked, posted or stored as terms and the invoice is reported receivable_not_issued; a store that cannot report links reports receivable_status_unknown.',
]);
function requireOrgKind(value) {
    if (typeof value !== 'string' || !billing_pricing_1.BILLING_ORGANIZATIONS.includes(value)) {
        fail('validation', 'orgKind must be teacher or center');
    }
    return value;
}
function requirePhase(value) {
    if (value !== 'first' && value !== 'recurring') {
        fail('validation', 'billingPhase must be first or recurring');
    }
    return value;
}
function requireCycleWindow(value) {
    if (!isRecord(value))
        fail('invalid_window', 'window must be an object');
    const start = requireSafePositiveInteger(value['start'], 'window.start');
    const end = requireSafePositiveInteger(value['end'], 'window.end');
    if (end - start !== billing_periods_1.CYCLE_SECONDS) {
        fail('invalid_window', `window must span exactly ${billing_periods_1.CYCLE_SECONDS} seconds (30-day UTC cycle)`);
    }
    return Object.freeze({ start, end });
}
function ownKeys(value) {
    return Object.keys(value);
}
function ownsExactly(value, keys) {
    const own = ownKeys(value);
    if (own.length !== keys.length)
        return false;
    return keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}
const INVOICE_KEYS = [
    'modelVersion', 'invoiceId', 'invoiceNumber', 'tenantId', 'orgKind', 'billingPhase',
    'window', 'currency', 'minorUnitsPerMajor', 'priceSnapshotRef', 'offerSnapshotRef',
    'lines', 'totalMinor', 'payloadHash',
];
const LINE_KEYS = ['lineId', 'kind', 'segmentStart', 'segmentEnd', 'registrationCount', 'numeratorMinorSeconds', 'denominatorSeconds'];
const PRICE_REF_KEYS = ['snapshotId', 'priceVersionId', 'contentHash'];
const OFFER_REF_KEYS = ['snapshotId', 'versionLabel', 'payloadHash', 'effectiveFrom', 'pricingEffect'];
function assertInvoiceLine(input) {
    if (!isRecord(input) || !ownsExactly(input, LINE_KEYS)) {
        fail('validation', `line must have exactly ${LINE_KEYS.join(', ')}`);
    }
    const kind = input['kind'];
    if (kind !== 'base_subscription' && kind !== 'registration_step') {
        fail('validation', 'line kind must be base_subscription or registration_step');
    }
    requireBoundedString(input['lineId'], 'line.lineId', exports.MAX_INVOICE_STRING_LENGTH);
    const numerator = requireBigint(input['numeratorMinorSeconds'], 'line.numeratorMinorSeconds');
    const denominator = requireBigint(input['denominatorSeconds'], 'line.denominatorSeconds');
    if (denominator <= 0n)
        fail('validation', 'line.denominatorSeconds must be positive');
    const segmentStart = input['segmentStart'];
    const segmentEnd = input['segmentEnd'];
    const registrationCount = input['registrationCount'];
    if (segmentStart === null) {
        if (kind !== 'base_subscription')
            fail('validation', 'only the base_subscription line may omit its segment');
    }
    else {
        requireSafePositiveInteger(segmentStart, 'line.segmentStart');
        requireSafePositiveInteger(segmentEnd, 'line.segmentEnd');
        requireSafePositiveInteger(registrationCount, 'line.registrationCount');
        if (segmentEnd <= segmentStart) {
            fail('validation', 'line segment end must be greater than its start');
        }
    }
    if (kind === 'base_subscription' && (segmentEnd !== null || registrationCount !== null)) {
        fail('validation', 'base_subscription line must not carry segment fields');
    }
    return {
        lineId: input['lineId'],
        kind,
        segmentStart: segmentStart,
        segmentEnd: segmentEnd,
        registrationCount: registrationCount,
        numeratorMinorSeconds: numerator,
        denominatorSeconds: denominator,
    };
}
function assertOfferRef(input) {
    if (!isRecord(input) || !ownsExactly(input, OFFER_REF_KEYS)) {
        fail('validation', `offerSnapshotRef must have exactly ${OFFER_REF_KEYS.join(', ')}`);
    }
    if (input['pricingEffect'] !== exports.OFFER_PRICING_EFFECT_HELD) {
        fail('validation', 'offer pricing effect must remain held_not_settled');
    }
    const effectiveFrom = requireSafePositiveInteger(input['effectiveFrom'], 'offerSnapshotRef.effectiveFrom');
    const versionLabel = input['versionLabel'] === null ? null : requireBoundedString(input['versionLabel'], 'offerSnapshotRef.versionLabel', exports.MAX_INVOICE_STRING_LENGTH);
    return {
        snapshotId: requireBoundedString(input['snapshotId'], 'offerSnapshotRef.snapshotId', exports.MAX_INVOICE_STRING_LENGTH),
        versionLabel,
        payloadHash: requireHex64(input['payloadHash'], 'offerSnapshotRef.payloadHash'),
        effectiveFrom,
        pricingEffect: exports.OFFER_PRICING_EFFECT_HELD,
    };
}
/**
 * Validate and deep-normalize an invoice shape. Used on every invoice boundary
 * (rebuild result, store read) so a store can never hand the domain malformed
 * or foreign-shaped data. The returned value is deeply frozen.
 */
function assertInvoice(input) {
    if (!isRecord(input) || !ownsExactly(input, INVOICE_KEYS)) {
        fail('validation', `invoice must have exactly ${INVOICE_KEYS.join(', ')}`);
    }
    if (input['modelVersion'] !== exports.INVOICE_MODEL_VERSION) {
        fail('validation', `invoice modelVersion must be ${exports.INVOICE_MODEL_VERSION}`);
    }
    const orgKind = requireOrgKind(input['orgKind']);
    const billingPhase = requirePhase(input['billingPhase']);
    const window = requireCycleWindow(input['window']);
    const currency = requireBoundedString(input['currency'], 'invoice.currency', 3);
    if (!CURRENCY_PATTERN.test(currency)) {
        fail('validation', 'invoice currency must be a three-letter uppercase ISO-4217 code');
    }
    const minorUnitsPerMajor = requireBigint(input['minorUnitsPerMajor'], 'invoice.minorUnitsPerMajor');
    if (minorUnitsPerMajor <= 0n)
        fail('validation', 'invoice.minorUnitsPerMajor must be positive');
    const rawPriceRef = input['priceSnapshotRef'];
    if (!isRecord(rawPriceRef) || !ownsExactly(rawPriceRef, PRICE_REF_KEYS)) {
        fail('validation', `priceSnapshotRef must have exactly ${PRICE_REF_KEYS.join(', ')}`);
    }
    const priceSnapshotRef = {
        snapshotId: requireBoundedString(rawPriceRef['snapshotId'], 'priceSnapshotRef.snapshotId', exports.MAX_INVOICE_STRING_LENGTH),
        priceVersionId: requireBoundedString(rawPriceRef['priceVersionId'], 'priceSnapshotRef.priceVersionId', exports.MAX_INVOICE_STRING_LENGTH),
        contentHash: requireHex64(rawPriceRef['contentHash'], 'priceSnapshotRef.contentHash'),
    };
    const rawOfferRef = input['offerSnapshotRef'];
    const offerSnapshotRef = rawOfferRef === null ? null : assertOfferRef(rawOfferRef);
    const rawLines = input['lines'];
    if (!Array.isArray(rawLines) || rawLines.length === 0) {
        fail('validation', 'invoice lines must be a non-empty array');
    }
    const lines = rawLines.map(assertInvoiceLine);
    const ids = new Set();
    for (const line of lines) {
        if (ids.has(line.lineId))
            fail('validation', `duplicate line id ${line.lineId}`);
        ids.add(line.lineId);
    }
    const totalMinor = requireBigint(input['totalMinor'], 'invoice.totalMinor');
    const invoice = {
        modelVersion: exports.INVOICE_MODEL_VERSION,
        invoiceId: requireBoundedString(input['invoiceId'], 'invoice.invoiceId', exports.MAX_ENTITY_ID_LENGTH),
        invoiceNumber: requireBoundedString(input['invoiceNumber'], 'invoice.invoiceNumber', exports.MAX_INVOICE_STRING_LENGTH),
        tenantId: requireBoundedString(input['tenantId'], 'invoice.tenantId', exports.MAX_ENTITY_ID_LENGTH),
        orgKind,
        billingPhase,
        window,
        currency,
        minorUnitsPerMajor,
        priceSnapshotRef: Object.freeze(priceSnapshotRef),
        offerSnapshotRef: offerSnapshotRef === null ? null : Object.freeze(offerSnapshotRef),
        lines: Object.freeze(lines),
        totalMinor,
        payloadHash: requireHex64(input['payloadHash'], 'invoice.payloadHash'),
    };
    return Object.freeze(invoice);
}
/** Serialize exact minor units as a decimal string; numeric input is rejected. */
function serializeMinorAmount(value) {
    if (typeof value !== 'bigint')
        fail('validation', 'amount must be a bigint of minor units');
    return value.toString();
}
/** Exact major-unit display string via integer arithmetic only (no floats). */
function serializeMajorAmount(amount, minorUnitsPerMajor) {
    if (typeof amount !== 'bigint')
        fail('validation', 'amount must be a bigint of minor units');
    if (typeof minorUnitsPerMajor !== 'bigint' || minorUnitsPerMajor <= 0n) {
        fail('validation', 'minorUnitsPerMajor must be a positive bigint');
    }
    const negative = amount < 0n;
    const magnitude = negative ? -amount : amount;
    const whole = magnitude / minorUnitsPerMajor;
    const fraction = magnitude % minorUnitsPerMajor;
    const fractionDigits = (minorUnitsPerMajor - 1n).toString().length;
    const text = `${whole}.${fraction.toString().padStart(fractionDigits, '0')}`;
    return negative ? `-${text}` : text;
}
function normalizeEventStream(stream, phase, source) {
    if (phase === 'first') {
        if (stream === undefined || stream === null) {
            return { events: [], truncated: false };
        }
        if (source === 'rebuild') {
            if (!isRecord(stream) || !Array.isArray(stream['events']) || typeof stream['truncated'] !== 'boolean') {
                fail('validation', 'a first invoice rebuild takes an empty stream or no stream at all');
            }
            if (stream['truncated']) {
                fail('truncated_events', 'relation event stream is truncated; refusing to compute an invoice from a partial log');
            }
            if (stream['events'].length > 0) {
                fail('validation', 'a first invoice takes base only and must not receive predicted event counts');
            }
            return { events: [], truncated: false };
        }
        fail('validation', 'a first invoice takes base only and must not receive predicted event counts');
    }
    if (!isRecord(stream) || typeof stream['truncated'] !== 'boolean' || !Array.isArray(stream['events'])) {
        fail('validation', 'recurring issuance requires an event stream with explicit truncated flag');
    }
    if (stream['truncated']) {
        fail('truncated_events', 'relation event stream is truncated; refusing to compute an invoice from a partial log');
    }
    return { events: stream['events'], truncated: false };
}
function segmentsFromTimeline(timeline, window) {
    const atStart = (0, billing_basis_1.countUniqueUsersAt)(timeline, window.start);
    if (!atStart.ok)
        fail('validation', atStart.error.message);
    let count = atStart.value;
    const inner = timeline.changePoints.filter((point) => point.at > window.start && point.at < window.end);
    const segments = [];
    let cursor = window.start;
    for (const point of inner) {
        if (point.at > cursor) {
            segments.push({ start: cursor, end: point.at, registrationCount: count });
        }
        cursor = point.at;
        count = point.count;
    }
    if (cursor < window.end) {
        segments.push({ start: cursor, end: window.end, registrationCount: count });
    }
    return segments;
}
function zeroCoverageSegments(window) {
    return [{ start: window.start, end: window.end, registrationCount: 0 }];
}
function invoiceIdentityHash(tenantId, orgKind, cycleStart) {
    return (0, node_crypto_1.createHash)('sha256')
        .update(JSON.stringify({
        modelVersion: exports.INVOICE_MODEL_VERSION,
        tenantId,
        orgKind,
        cycleStart,
    }))
        .digest('hex');
}
function cycleStartUtcCompactDate(cycleStart) {
    return new Date(cycleStart * 1000).toISOString().slice(0, 10).replace(/-/g, '');
}
function buildDialogContent(params) {
    const identityHash = invoiceIdentityHash(params.tenantId, params.orgKind, params.window.start);
    const invoiceId = `inv_${identityHash.slice(0, 32)}`;
    const invoiceNumber = `INV-${params.orgKind === 'teacher' ? 'T' : 'C'}-${cycleStartUtcCompactDate(params.window.start)}-${identityHash.slice(0, 8).toUpperCase()}`;
    const payloadHash = (0, node_crypto_1.createHash)('sha256')
        .update(JSON.stringify({
        modelVersion: exports.INVOICE_MODEL_VERSION,
        invoiceId,
        invoiceNumber,
        tenantId: params.tenantId,
        orgKind: params.orgKind,
        billingPhase: params.billingPhase,
        window: { start: params.window.start, end: params.window.end },
        currency: params.currency,
        minorUnitsPerMajor: params.minorUnitsPerMajor.toString(),
        priceSnapshotRef: params.priceSnapshotRef,
        offerSnapshotRef: params.offerSnapshotRef,
        lines: params.lines.map((line) => ({
            lineId: line.lineId,
            kind: line.kind,
            segmentStart: line.segmentStart,
            segmentEnd: line.segmentEnd,
            registrationCount: line.registrationCount,
            numeratorMinorSeconds: line.numeratorMinorSeconds.toString(),
            denominatorSeconds: line.denominatorSeconds.toString(),
        })),
        totalMinor: params.totalMinor.toString(),
    }))
        .digest('hex');
    return assertInvoice({
        modelVersion: exports.INVOICE_MODEL_VERSION,
        invoiceId,
        invoiceNumber,
        tenantId: params.tenantId,
        orgKind: params.orgKind,
        billingPhase: params.billingPhase,
        window: { start: params.window.start, end: params.window.end },
        currency: params.currency,
        minorUnitsPerMajor: params.minorUnitsPerMajor,
        priceSnapshotRef: params.priceSnapshotRef,
        offerSnapshotRef: params.offerSnapshotRef,
        lines: params.lines,
        totalMinor: params.totalMinor,
        payloadHash,
    });
}
function offerRefFromSnapshot(offer) {
    return {
        snapshotId: offer.id,
        versionLabel: offer.versionLabel,
        payloadHash: offer.payloadHash,
        effectiveFrom: offer.effectiveFrom,
        pricingEffect: exports.OFFER_PRICING_EFFECT_HELD,
    };
}
function computeInvoice(input) {
    const { priceSnapshot, window, orgKind, billingPhase } = input;
    if (!(0, billing_snapshots_1.verifyPriceVersionSnapshot)(priceSnapshot)) {
        fail('invalid_snapshot', 'price snapshot content hash does not cover its captured content');
    }
    const priceVersion = (0, billing_snapshots_1.reconstructCapturedPriceVersion)(priceSnapshot);
    const schedule = priceVersion.schedules[orgKind];
    const priceSnapshotRef = {
        snapshotId: priceSnapshot.id,
        priceVersionId: priceSnapshot.versionLabel,
        contentHash: priceSnapshot.contentHash,
    };
    const events = input.events;
    let timeline = null;
    if (billingPhase === 'recurring' || events.events.length > 0) {
        for (const event of events.events) {
            if (event.tenantId !== input.tenantId) {
                fail('tenant_mismatch', `event belongs to tenant ${event.tenantId}, not to ${input.tenantId}`);
            }
        }
        const timelines = (0, billing_basis_1.buildTenantCountTimelines)(events.events);
        if (!timelines.ok)
            fail('validation', timelines.error.message);
        timeline = timelines.value.find((candidate) => candidate.tenantId === input.tenantId) ?? null;
    }
    const segments = timeline === null
        ? zeroCoverageSegments(window)
        : segmentsFromTimeline(timeline, window);
    if (segments.length === 0) {
        fail('internal_inconsistency', 'segments must cover the full cycle window');
    }
    const proration = (0, billing_periods_1.prorateCycle)(priceVersion, orgKind, window, segments);
    if (!proration.ok)
        fail('validation', `cycle proration failed: ${proration.error.message}`);
    const included = schedule.includedRegistrations;
    const baseMinor = schedule.baseAmountMinor;
    const baseNumerator = baseMinor * CYCLE_SECONDS_BIGINT;
    const baseLine = {
        lineId: 'base_subscription',
        kind: 'base_subscription',
        segmentStart: null,
        segmentEnd: null,
        registrationCount: null,
        numeratorMinorSeconds: baseNumerator,
        denominatorSeconds: CYCLE_SECONDS_BIGINT,
    };
    const stepLines = [];
    for (const segment of segments) {
        if (segment.registrationCount <= included)
            continue;
        const price = (0, billing_pricing_1.calculatePriceMinor)(priceVersion, orgKind, segment.registrationCount);
        if (!price.ok)
            fail('validation', price.error.message);
        const stepUnits = price.value - baseMinor;
        if (stepUnits <= 0n)
            continue;
        const duration = segment.end - segment.start;
        if (duration <= 0)
            continue;
        stepLines.push({
            lineId: `registration_step:${segment.start}`,
            kind: 'registration_step',
            segmentStart: segment.start,
            segmentEnd: segment.end,
            registrationCount: segment.registrationCount,
            numeratorMinorSeconds: stepUnits * BigInt(duration),
            denominatorSeconds: CYCLE_SECONDS_BIGINT,
        });
    }
    const lines = [baseLine, ...stepLines];
    const sumNumerator = lines.reduce((total, line) => total + line.numeratorMinorSeconds, 0n);
    if (sumNumerator !== proration.value.exactNumeratorMinorSeconds) {
        fail('internal_inconsistency', 'line decomposition does not match the cycle proration integrand');
    }
    return buildDialogContent({
        tenantId: input.tenantId,
        orgKind,
        billingPhase,
        window,
        currency: priceVersion.currency,
        minorUnitsPerMajor: priceVersion.minorUnitsPerMajor,
        priceSnapshotRef,
        offerSnapshotRef: input.offerSnapshotRef,
        lines,
        totalMinor: proration.value.roundedMinor,
    });
}
/**
 * Recompute an invoice purely from the activation-event stream and a frozen
 * price snapshot. A truncated stream is refused: the domain never computes
 * from a partial relation log. The returned invoice is deeply frozen; no
 * stored data is read or changed.
 */
function rebuildInvoice(events, priceSnapshot, window, organization) {
    if (!isRecord(organization))
        fail('validation', 'organization must be an object');
    if (!isRecord(priceSnapshot))
        fail('invalid_snapshot', 'priceSnapshot must be a PriceVersionSnapshot');
    const tenantId = requireBoundedString(organization['tenantId'], 'organization.tenantId', exports.MAX_ENTITY_ID_LENGTH);
    const kind = requireOrgKind(organization['kind']);
    const phase = requirePhase(organization['billingPhase']);
    const cycleWindow = requireCycleWindow(window);
    const stream = normalizeEventStream(events, phase, 'rebuild');
    return computeInvoice({
        events: stream,
        priceSnapshot: priceSnapshot,
        window: cycleWindow,
        tenantId,
        orgKind: kind,
        billingPhase: phase,
        offerSnapshotRef: null,
    });
}
function keyMatches(invoice, tenantId, orgKind, cycleStart) {
    return invoice.tenantId === tenantId
        && invoice.orgKind === orgKind
        && invoice.window.start === cycleStart;
}
function requireKeyedTenant(invoice, tenantId) {
    if (invoice.tenantId !== tenantId) {
        fail('store_inconsistent', 'the invoice store returned a row outside the requested tenant');
    }
}
function comparePayloads(invoice, payloadHash) {
    if (invoice.payloadHash !== payloadHash) {
        fail('idempotency_conflict', 'the same invoice key exists with a different payload');
    }
}
/**
 * Issue one invoice atomically.
 *
 * Idempotent per (tenant, org kind, cycle start) through the idempotency
 * registry (HK1): same key + same payload replays the stored invoice; same
 * key + different payload is a typed conflict. The sealed audit writer runs
 * inside the transaction so a failing audit rolls the issuance back.
 */
async function issueInvoice(store, command, options = {}) {
    if (typeof store?.runAtomic !== 'function') {
        fail('validation', 'store must expose runAtomic');
    }
    if (!isRecord(command))
        fail('validation', 'issue command must be an object');
    const tenantId = requireBoundedString(command['tenantId'], 'tenantId', exports.MAX_ENTITY_ID_LENGTH);
    const orgKind = requireOrgKind(command['orgKind']);
    const phase = requirePhase(command['billingPhase']);
    const cycleWindow = requireCycleWindow(command['window']);
    const stream = normalizeEventStream(command['events'], phase, 'issue');
    const rawSnapshot = command['priceSnapshot'];
    if (!isRecord(rawSnapshot))
        fail('invalid_snapshot', 'priceSnapshot must be a PriceVersionSnapshot');
    const offerSnapshot = command['offerSnapshot'];
    let offerSnapshotRef = null;
    if (offerSnapshot !== undefined && offerSnapshot !== null) {
        if (!(0, billing_snapshots_1.verifyOfferSnapshot)(offerSnapshot)) {
            fail('invalid_snapshot', 'offer snapshot payload hash does not match its payload');
        }
        offerSnapshotRef = offerRefFromSnapshot(offerSnapshot);
    }
    const rawKey = command['idempotencyKey'];
    const idempotencyKey = rawKey === undefined || rawKey === null
        ? `${orgKind}:${cycleWindow.start}`
        : requireBoundedString(rawKey, 'idempotencyKey', exports.MAX_IDEMPOTENCY_KEY_LENGTH);
    const rawJournalId = command['receivableJournalId'];
    const receivableJournalId = rawJournalId === undefined || rawJournalId === null
        ? null
        : requireBoundedString(rawJournalId, 'receivableJournalId', exports.MAX_ENTITY_ID_LENGTH);
    const rawPosting = command['receivablePosting'];
    if (rawPosting !== undefined && rawPosting !== null && rawPosting !== 'post' && rawPosting !== 'link_existing') {
        fail('validation', 'receivablePosting must be post or link_existing');
    }
    if (rawPosting === 'post' && receivableJournalId !== null) {
        fail('validation', 'receivablePosting post cannot be combined with a receivableJournalId');
    }
    if (rawPosting === 'link_existing' && receivableJournalId === null) {
        fail('validation', 'receivablePosting link_existing requires a receivableJournalId');
    }
    const posting = rawPosting === 'post' || rawPosting === 'link_existing'
        ? rawPosting
        : (receivableJournalId !== null ? 'link_existing' : null);
    const dueRule = requireDueRule(options.dueRule);
    if (options.now !== undefined && typeof options.now !== 'function') {
        fail('validation', 'options.now must be a function');
    }
    const invoice = computeInvoice({
        events: stream,
        priceSnapshot: rawSnapshot,
        window: cycleWindow,
        tenantId,
        orgKind,
        billingPhase: phase,
        offerSnapshotRef,
    });
    // Refuses issuance (nothing written) when the charge cannot be separated.
    const composition = deriveInvoiceChargeComposition(invoice);
    return store.runAtomic(async (tx) => {
        const record = await tx.findIdempotencyRecord(tenantId, exports.INVOICE_ISSUE_IDEMPOTENCY_SCOPE, idempotencyKey);
        if (record !== null) {
            comparePayloads(invoice, record.payloadHash);
            const existingByRecord = await tx.findInvoiceByKey(tenantId, orgKind, cycleWindow.start);
            if (existingByRecord === null || existingByRecord.invoiceId !== record.invoiceId) {
                fail('store_inconsistent', 'idempotency record references a missing or mismatched invoice');
            }
            requireKeyedTenant(existingByRecord, tenantId);
            return replayResult(tx, existingByRecord, receivableJournalId, dueRule);
        }
        const existing = await tx.findInvoiceByKey(tenantId, orgKind, cycleWindow.start);
        if (existing !== null) {
            requireKeyedTenant(existing, tenantId);
            comparePayloads(existing, invoice.payloadHash);
            const insertedRecord = await tx.insertIdempotencyRecord({
                tenantId,
                scope: exports.INVOICE_ISSUE_IDEMPOTENCY_SCOPE,
                key: idempotencyKey,
                payloadHash: invoice.payloadHash,
                invoiceId: existing.invoiceId,
            });
            if (insertedRecord === 'duplicate_key') {
                fail('store_inconsistent', 'idempotency key raced to a second value inside one transaction');
            }
            return replayResult(tx, existing, receivableJournalId, dueRule);
        }
        // Every capability the requested posting needs must exist BEFORE the
        // first write so a missing capability leaves nothing behind.
        if (posting !== null)
            requirePostingCapabilities(tx, posting);
        // FK targets first, on the same transaction connection. The adapter
        // resolves a repeated (id, content hash) idempotently and rejects a
        // different hash on an immutable snapshot id.
        await tx.persistPriceVersionSnapshot(tenantId, rawSnapshot);
        if (offerSnapshot !== undefined && offerSnapshot !== null) {
            await tx.persistOfferSnapshot(tenantId, offerSnapshot);
        }
        const inserted = await tx.insertInvoice(invoice);
        if (inserted === 'duplicate_key') {
            const raced = await tx.findInvoiceByKey(tenantId, orgKind, cycleWindow.start);
            if (raced === null) {
                fail('store_inconsistent', 'insert raced with a row that cannot be read inside the transaction');
            }
            requireKeyedTenant(raced, tenantId);
            comparePayloads(raced, invoice.payloadHash);
            const recordInsert = await tx.insertIdempotencyRecord({
                tenantId,
                scope: exports.INVOICE_ISSUE_IDEMPOTENCY_SCOPE,
                key: idempotencyKey,
                payloadHash: invoice.payloadHash,
                invoiceId: raced.invoiceId,
            });
            if (recordInsert === 'duplicate_key') {
                fail('store_inconsistent', 'idempotency key raced to a second value inside one transaction');
            }
            return replayResult(tx, raced, receivableJournalId, dueRule);
        }
        const recordInsert = await tx.insertIdempotencyRecord({
            tenantId,
            scope: exports.INVOICE_ISSUE_IDEMPOTENCY_SCOPE,
            key: idempotencyKey,
            payloadHash: invoice.payloadHash,
            invoiceId: invoice.invoiceId,
        });
        if (recordInsert === 'duplicate_key') {
            fail('store_inconsistent', 'idempotency key raced to a second value inside one transaction');
        }
        // Receivable handling, same transaction/connection as the invoice
        // insert. Nothing is posted, linked or fabricated without a posting mode.
        let linkedJournalId = null;
        let obligation = null;
        const newChargeMinor = composition.newChargeMinor;
        if (posting !== null) {
            if (newChargeMinor === 0n) {
                if (posting === 'link_existing') {
                    fail('validation', 'a zero-charge invoice has no receivable journal to link');
                }
                // Zero charge: no journal and no obligation row (outstanding is 0).
            }
            else {
                const expected = {
                    tenantId,
                    invoiceId: invoice.invoiceId,
                    currency: invoice.currency,
                    newChargeMinor,
                };
                const issuedAt = readIssuedAt(options.now);
                let journalToLink;
                if (posting === 'post') {
                    // Ascending kind order: platform_receivable < platform_subscription_revenue.
                    const receivable = await tx.provisionAccountIdempotent(tenantId, 'platform_receivable', invoice.currency);
                    requireProvisionedAccount(receivable, tenantId, 'platform_receivable', invoice.currency);
                    const revenue = await tx.provisionAccountIdempotent(tenantId, 'platform_subscription_revenue', invoice.currency);
                    requireProvisionedAccount(revenue, tenantId, 'platform_subscription_revenue', invoice.currency);
                    const posted = await tx.postJournal({
                        tenantId,
                        currency: invoice.currency,
                        idempotencyKey: invoiceIssuanceJournalKey(invoice.invoiceId),
                        reference: invoiceIssuanceJournalReference(invoice.invoiceId),
                        lines: [
                            { accountId: receivable.id, direction: 'debit', amountMinor: newChargeMinor },
                            { accountId: revenue.id, direction: 'credit', amountMinor: newChargeMinor },
                        ],
                    });
                    requireVerifiedIssuanceJournal(posted.journal, expected);
                    journalToLink = posted.journal.id;
                }
                else {
                    const existingJournal = await tx.getJournal(tenantId, receivableJournalId);
                    if (existingJournal === null) {
                        fail('journal_link_conflict', 'the receivable journal does not exist for this tenant');
                    }
                    requireVerifiedIssuanceJournal(existingJournal, expected);
                    journalToLink = existingJournal.id;
                }
                const linked = await tx.linkReceivableJournal({
                    tenantId,
                    invoiceId: invoice.invoiceId,
                    journalId: journalToLink,
                });
                if (linked === 'duplicate_key') {
                    fail('journal_link_conflict', 'the receivable journal is already linked to an invoice');
                }
                linkedJournalId = journalToLink;
                const terms = deriveDueTerms(dueRule, {
                    tenantId,
                    orgKind,
                    billingPhase: phase,
                    cycleStart: cycleWindow.start,
                    cycleEnd: cycleWindow.end,
                    issuedAt,
                    currency: invoice.currency,
                    newChargeMinor,
                });
                const insertedTerms = await tx.insertInvoiceObligation({
                    tenantId,
                    invoiceId: invoice.invoiceId,
                    currency: invoice.currency,
                    newChargeMinor,
                    carriedDebtReferenceMinor: composition.carriedDebtReferenceMinor,
                    compositionVersion: composition.compositionVersion,
                    issuedAt,
                    ...terms,
                });
                if (insertedTerms.outcome !== 'inserted') {
                    fail('store_inconsistent', 'a just-inserted invoice already has stored obligation terms');
                }
                obligation = insertedTerms.stored;
            }
        }
        if (options.audit !== undefined) {
            await options.audit({
                action: 'billing.invoice.issued',
                tenantId: invoice.tenantId,
                invoiceId: invoice.invoiceId,
                invoiceNumber: invoice.invoiceNumber,
                orgKind: invoice.orgKind,
                cycleStart: invoice.window.start,
                totalMinor: serializeMinorAmount(invoice.totalMinor),
                payloadHash: invoice.payloadHash,
                journalId: linkedJournalId,
                newChargeMinor: posting === null ? null : serializeMinorAmount(composition.newChargeMinor),
                compositionVersion: posting === null ? null : String(composition.compositionVersion),
                dueStatus: obligation === null ? null : obligation.dueStatus,
            });
        }
        return {
            invoice,
            replayed: false,
            receivableStatus: linkedJournalId === null ? 'receivable_not_issued' : 'receivable_issued',
            receivableJournalId: linkedJournalId,
            obligation,
            dueTermsReplayDiffers: false,
        };
    });
}
function requireDueRule(rule) {
    if (rule === undefined)
        return undefined;
    if (!isRecord(rule) || typeof rule.derive !== 'function') {
        fail('validation', 'dueRule must expose derive()');
    }
    requireBoundedString(rule.ruleRef, 'dueRule.ruleRef', exports.MAX_INVOICE_STRING_LENGTH);
    if (typeof rule.ruleVersion !== 'number' || !Number.isSafeInteger(rule.ruleVersion) || rule.ruleVersion < 1) {
        fail('validation', 'dueRule.ruleVersion must be a safe positive integer');
    }
    return rule;
}
/** No rule or an `'unresolved'` answer keeps the terms unresolved; there is no default deadline. */
function deriveDueTerms(rule, input) {
    const unresolved = { dueStatus: 'unresolved', dueAt: null, dueBasisRef: null, dueBasisVersion: null };
    if (rule === undefined)
        return unresolved;
    const derived = rule.derive(Object.freeze({ ...input }));
    if (derived === 'unresolved')
        return unresolved;
    if (typeof derived !== 'number' || !Number.isSafeInteger(derived) || derived < 0) {
        fail('validation', 'a due rule must return unresolved or a non-negative safe integer second');
    }
    return { dueStatus: 'resolved', dueAt: derived, dueBasisRef: rule.ruleRef, dueBasisVersion: rule.ruleVersion };
}
function readIssuedAt(now) {
    const value = now === undefined ? Math.floor(Date.now() / 1000) : now();
    return requireSafePositiveInteger(value, 'issuedAt');
}
function requirePostingCapabilities(tx, posting) {
    const common = typeof tx.linkReceivableJournal === 'function'
        && typeof tx.insertInvoiceObligation === 'function';
    const specific = posting === 'post'
        ? typeof tx.provisionAccountIdempotent === 'function' && typeof tx.postJournal === 'function'
        : typeof tx.getJournal === 'function';
    if (!common || !specific) {
        fail('journal_link_unavailable', 'the store cannot post, verify or link the receivable journal; nothing was written');
    }
}
function requireProvisionedAccount(account, tenantId, kind, currency) {
    if (!isRecord(account) || account.tenantId !== tenantId || account.kind !== kind || account.currency !== currency) {
        fail('store_inconsistent', `the provisioned ${kind} account does not match tenant, kind and currency`);
    }
}
function sameDueTerms(stored, terms) {
    return stored.dueStatus === terms.dueStatus
        && stored.dueAt === terms.dueAt
        && stored.dueBasisRef === terms.dueBasisRef
        && stored.dueBasisVersion === terms.dueBasisVersion;
}
/**
 * Replay never writes: it reports the stored link and the stored terms (never
 * backfilled, never overwritten) and flags when the supplied rule would now
 * derive different terms from the STORED inputs.
 */
async function replayResult(tx, invoice, commandJournalId, dueRule) {
    const receivable = await replayReceivable(tx, invoice.tenantId, invoice.invoiceId, commandJournalId);
    let obligation = null;
    if (typeof tx.findInvoiceObligation === 'function') {
        obligation = await tx.findInvoiceObligation(invoice.tenantId, invoice.invoiceId);
        if (obligation !== null && (obligation.tenantId !== invoice.tenantId || obligation.invoiceId !== invoice.invoiceId)) {
            fail('store_inconsistent', 'the stored invoice obligation does not belong to the invoice');
        }
    }
    let dueTermsReplayDiffers = false;
    if (obligation !== null && dueRule !== undefined) {
        const terms = deriveDueTerms(dueRule, {
            tenantId: invoice.tenantId,
            orgKind: invoice.orgKind,
            billingPhase: invoice.billingPhase,
            cycleStart: invoice.window.start,
            cycleEnd: invoice.window.end,
            issuedAt: obligation.issuedAt,
            currency: invoice.currency,
            newChargeMinor: obligation.newChargeMinor,
        });
        dueTermsReplayDiffers = !sameDueTerms(obligation, terms);
    }
    return { invoice, replayed: true, ...receivable, obligation, dueTermsReplayDiffers };
}
function segmentToken(line) {
    if (line.segmentStart === null)
        return 'base';
    return `${line.segmentStart}:${line.segmentEnd}:${line.registrationCount}`;
}
/**
 * Compare a stored issued invoice against a pure rebuild. The report is read
 * only and serialized amounts are decimal strings; this function never
 * mutates, edits or deletes the stored invoice.
 */
function reconcileInvoice(storedInput, rebuiltInput) {
    const stored = assertInvoice(storedInput);
    const rebuilt = assertInvoice(rebuiltInput);
    if (stored.tenantId !== rebuilt.tenantId || stored.orgKind !== rebuilt.orgKind || stored.window.start !== rebuilt.window.start) {
        fail('validation', 'stored and rebuilt invoices must share the same (tenant, org kind, cycle start)');
    }
    const storedRows = new Map(stored.lines.map((line) => [line.lineId, line]));
    const rebuiltRows = new Map(rebuilt.lines.map((line) => [line.lineId, line]));
    const differences = [];
    const lineIds = [...new Set([...storedRows.keys(), ...rebuiltRows.keys()])].sort();
    for (const lineId of lineIds) {
        const storedLine = storedRows.get(lineId) ?? null;
        const rebuiltLine = rebuiltRows.get(lineId) ?? null;
        if (storedLine === null) {
            differences.push({
                lineId,
                reason: 'missing_in_stored',
                storedNumeratorMinorSeconds: null,
                rebuiltNumeratorMinorSeconds: serializeMinorAmount(rebuiltLine?.numeratorMinorSeconds ?? 0n),
                storedSegment: null,
                rebuiltSegment: rebuiltLine === null ? null : segmentToken(rebuiltLine),
            });
            continue;
        }
        if (rebuiltLine === null) {
            differences.push({
                lineId,
                reason: 'missing_in_rebuilt',
                storedNumeratorMinorSeconds: serializeMinorAmount(storedLine.numeratorMinorSeconds),
                rebuiltNumeratorMinorSeconds: null,
                storedSegment: segmentToken(storedLine),
                rebuiltSegment: null,
            });
            continue;
        }
        if (segmentToken(storedLine) !== segmentToken(rebuiltLine)) {
            differences.push({
                lineId,
                reason: 'segment_differs',
                storedNumeratorMinorSeconds: serializeMinorAmount(storedLine.numeratorMinorSeconds),
                rebuiltNumeratorMinorSeconds: serializeMinorAmount(rebuiltLine.numeratorMinorSeconds),
                storedSegment: segmentToken(storedLine),
                rebuiltSegment: segmentToken(rebuiltLine),
            });
            continue;
        }
        if (storedLine.numeratorMinorSeconds !== rebuiltLine.numeratorMinorSeconds
            || storedLine.denominatorSeconds !== rebuiltLine.denominatorSeconds) {
            differences.push({
                lineId,
                reason: 'amount_differs',
                storedNumeratorMinorSeconds: serializeMinorAmount(storedLine.numeratorMinorSeconds),
                rebuiltNumeratorMinorSeconds: serializeMinorAmount(rebuiltLine.numeratorMinorSeconds),
                storedSegment: segmentToken(storedLine),
                rebuiltSegment: segmentToken(rebuiltLine),
            });
        }
    }
    const totalsMatch = stored.totalMinor === rebuilt.totalMinor;
    const priceSnapshotMatches = stored.priceSnapshotRef.contentHash === rebuilt.priceSnapshotRef.contentHash
        && stored.priceSnapshotRef.priceVersionId === rebuilt.priceSnapshotRef.priceVersionId;
    const status = totalsMatch && priceSnapshotMatches && differences.length === 0 ? 'matching' : 'different';
    return Object.freeze({
        status,
        storedInvoiceId: stored.invoiceId,
        rebuiltInvoiceId: rebuilt.invoiceId,
        storedTotalMinor: serializeMinorAmount(stored.totalMinor),
        rebuiltTotalMinor: serializeMinorAmount(rebuilt.totalMinor),
        storedTotalMajor: serializeMajorAmount(stored.totalMinor, stored.minorUnitsPerMajor),
        rebuiltTotalMajor: serializeMajorAmount(rebuilt.totalMinor, rebuilt.minorUnitsPerMajor),
        totalsMatch,
        priceSnapshotMatches,
        lineDifferences: Object.freeze(differences.map((line) => Object.freeze(line))),
    });
}
