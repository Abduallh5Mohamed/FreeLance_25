"use strict";
/**
 * FIN11 — neutral, READ-ONLY billing read models.
 *
 * Source of truth: docs/streams/server/SERVER-REMAINING-INVENTORY-20261022.md
 * (FIN11) — admin read models are derived from the canonical invoice and ledger
 * tables; debt, pending, available, reserved and subscription credit are
 * reported SEPARATELY and are never netted into one "balance".
 *
 * This module contains no writes: it never INSERTs/UPDATEs/DELETEs, never
 * opens a transaction, and never mutates a ledger row. Every method receives a
 * caller-injected read executor and runs its statements on the connection that
 * executor provides, so a caller can pin one consistent snapshot.
 *
 * MONEY (HK2): amounts are exact integer minor units surfaced as decimal
 * strings (`normalizeSqlBigInt(...).toString()`); versions are safe integers.
 * Required mysql2 options for the production binding: `supportBigNumbers: true`,
 * `bigNumberStrings: true`.
 *
 * DEBT DEFINITION (Codex decision R3, one allocation source):
 *  - Outstanding invoice debt comes ONLY from the shared allocation source
 *    (`listInvoiceOutstanding`, billing-settlement.ts), injected as
 *    `deps.debtSource`. It is issued total minus valid immutable allocations.
 *    The issued invoice total is NEVER reported as debt.
 *  - If the port is absent, the source reports `debt_source_unavailable`, or
 *    the bounded list is truncated (incomplete), the position carries the
 *    explicit marker `availability: 'unavailable'` with a reason and NO
 *    amounts: never zero and never a guessed total.
 *  - The issued invoice total (`invoiceTotals`) and the open difference-request
 *    amounts (`differenceRequests`) are separate informational fields. A
 *    difference request is a payment request for an invoice's REMAINING
 *    balance, not extra debt, so no field sums them with outstanding debt and
 *    no total-debt number exists.
 *  - The debt-source port is bound by the caller to the settlement SQL
 *    adapter's NON-LOCKING snapshot reader (`asSnapshotDebtReader`); the
 *    locking readers belong to the payout gate, collection and allocation.
 *    This module's own statements stay plain SELECTs.
 *  - Active payouts read `payout_requests` from migration
 *    20261022_04_payouts_refunds_disputes.sql (PK `(tenant_id, payout_id)`).
 *  - pending / available / reserved / subscription credit stay separate in
 *    `getMerchantPosition`.
 *
 * KEYSET PAGINATION: every list takes an optional typed cursor describing the
 * last row of the previous page in the exact ORDER BY key. Pages report
 * `truncated` when more rows exist. Export is caller-side: serialize successive
 * pages; this module never invents a file format.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.createBillingReadModels = exports.BillingReadModelError = exports.READ_MODEL_MAX_LIMIT = exports.READ_MODEL_DEFAULT_LIMIT = void 0;
const billing_ledger_1 = require("./billing-ledger");
const billing_ledger_sql_1 = require("./billing-ledger-sql");
const billing_settlement_1 = require("./billing-settlement");
exports.READ_MODEL_DEFAULT_LIMIT = 100;
exports.READ_MODEL_MAX_LIMIT = 500;
/** Largest page the shared debt source accepts; a longer list is reported incomplete. */
const SOURCE_DEBT_LIST_LIMIT = 1000;
const MERCHANT_POSITION_KINDS = Object.freeze([
    'merchant_pending',
    'merchant_available',
    'merchant_reserved',
    'subscription_credit',
]);
class BillingReadModelError extends Error {
    constructor(code, message) {
        super(message);
        this.code = code;
        this.name = 'BillingReadModelError';
    }
}
exports.BillingReadModelError = BillingReadModelError;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;
const TENANT_PATTERN = /^[^\u0000]{1,36}$/;
const requireTenant = (value) => {
    if (typeof value !== 'string' || !TENANT_PATTERN.test(value)) {
        throw new BillingReadModelError('invalid_query', 'tenantId must be a non-empty string of at most 36 characters');
    }
    return value;
};
const requireCurrency = (value) => {
    if (typeof value !== 'string' || !CURRENCY_PATTERN.test(value)) {
        throw new BillingReadModelError('invalid_query', 'currency must be a three-letter uppercase ISO-4217 code');
    }
    return value;
};
const requireLimit = (value) => {
    if (value === undefined)
        return exports.READ_MODEL_DEFAULT_LIMIT;
    if (typeof value !== 'number'
        || !Number.isSafeInteger(value)
        || value < 1
        || value > exports.READ_MODEL_MAX_LIMIT) {
        throw new BillingReadModelError('invalid_query', `limit must be an integer between 1 and ${exports.READ_MODEL_MAX_LIMIT}`);
    }
    return value;
};
const requireSafeEpoch = (value, field) => {
    const integer = (0, billing_ledger_sql_1.normalizeSqlVersion)(value, field);
    return integer;
};
const toIso = (value, field) => {
    const date = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(date.getTime())) {
        throw new BillingReadModelError('invalid_row', `${field} is not a parseable timestamp`);
    }
    return date.toISOString();
};
const requireBounded = (value, field, maxLength) => {
    if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) {
        throw new BillingReadModelError('invalid_row', `${field} must be a non-empty string of at most ${maxLength} characters`);
    }
    return value;
};
const requireNullableBounded = (value, field, maxLength) => {
    if (value === null)
        return null;
    return requireBounded(value, field, maxLength);
};
const requireAccountKind = (value) => {
    if (typeof value !== 'string' || !billing_ledger_1.ACCOUNT_KINDS.includes(value)) {
        throw new BillingReadModelError('invalid_row', 'account kind is not recognized');
    }
    return value;
};
const requireOrgKind = (value) => {
    if (value !== 'teacher' && value !== 'center') {
        throw new BillingReadModelError('invalid_row', 'org_kind is not teacher or center');
    }
    return value;
};
const requireBillingPhase = (value) => {
    if (value !== 'first' && value !== 'recurring') {
        throw new BillingReadModelError('invalid_row', 'billing_phase is not first or recurring');
    }
    return value;
};
const requireDebtStatus = (value) => {
    if (value !== 'open' && value !== 'expired') {
        throw new BillingReadModelError('invalid_row', 'difference request status is not a due status');
    }
    return value;
};
const requireActivePayoutStatus = (value) => {
    if (value !== 'requested' && value !== 'reserved' && value !== 'processing') {
        throw new BillingReadModelError('invalid_row', 'payout status is not an active status');
    }
    return value;
};
const requireCursorTimestamp = (value, field) => {
    if (typeof value !== 'string' || value.trim() === '') {
        throw new BillingReadModelError('invalid_query', `${field} must be an ISO timestamp`);
    }
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) {
        throw new BillingReadModelError('invalid_query', `${field} must be an ISO timestamp`);
    }
    return date;
};
const requireCursorId = (value, field, maxLength) => {
    if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) {
        throw new BillingReadModelError('invalid_query', `${field} must be a non-empty string of at most ${maxLength} characters`);
    }
    return value;
};
const money = (value, field) => (0, billing_ledger_sql_1.normalizeSqlBigInt)(value, field).toString();
const accountOfRow = (row, tenantId) => {
    if (row.tenant_id !== tenantId) {
        throw new BillingReadModelError('invalid_row', 'an account row belongs to another tenant');
    }
    return {
        accountId: requireBounded(row.id, 'billing_accounts.id', 64),
        tenantId: requireBounded(row.tenant_id, 'billing_accounts.tenant_id', 36),
        kind: requireAccountKind(row.kind),
        currency: requireCurrency(row.currency),
        balanceMinor: money(row.balance_minor, 'billing_accounts.balance_minor'),
        version: (0, billing_ledger_sql_1.normalizeSqlVersion)(row.version, 'billing_accounts.version'),
        updatedAt: toIso(row.updated_at, 'billing_accounts.updated_at'),
    };
};
const invoiceOfRow = (row, tenantId) => {
    if (row.tenant_id !== tenantId) {
        throw new BillingReadModelError('invalid_row', 'an invoice row belongs to another tenant');
    }
    return {
        invoiceId: requireBounded(row.id, 'billing_invoices.id', 64),
        tenantId: requireBounded(row.tenant_id, 'billing_invoices.tenant_id', 36),
        orgKind: requireOrgKind(row.org_kind),
        billingPhase: requireBillingPhase(row.billing_phase),
        cycleStart: requireSafeEpoch(row.cycle_start, 'billing_invoices.cycle_start'),
        totalMinor: money(row.total_minor, 'billing_invoices.total_minor'),
        currency: requireCurrency(row.currency),
        invoiceNumber: requireBounded(row.invoice_number, 'billing_invoices.invoice_number', 128),
        createdAt: toIso(row.created_at, 'billing_invoices.created_at'),
    };
};
const differenceOfRow = (row, tenantId) => {
    if (row.tenant_id !== tenantId) {
        throw new BillingReadModelError('invalid_row', 'a difference request row belongs to another tenant');
    }
    return {
        requestId: requireBounded(row.id, 'billing_difference_requests.id', 64),
        tenantId: requireBounded(row.tenant_id, 'billing_difference_requests.tenant_id', 36),
        invoiceId: requireBounded(row.invoice_id, 'billing_difference_requests.invoice_id', 128),
        cycleStart: requireSafeEpoch(row.cycle_start, 'billing_difference_requests.cycle_start'),
        amountMinor: money(row.amount_minor, 'billing_difference_requests.amount_minor'),
        currency: requireCurrency(row.currency),
        status: requireDebtStatus(row.status),
        issuedAt: requireSafeEpoch(row.issued_at, 'billing_difference_requests.issued_at'),
        deadlineAt: requireSafeEpoch(row.deadline_at, 'billing_difference_requests.deadline_at'),
    };
};
const reservationOfRow = (row, tenantId) => {
    if (row.tenant_id !== tenantId) {
        throw new BillingReadModelError('invalid_row', 'a reservation row belongs to another tenant');
    }
    return {
        reservationId: requireBounded(row.id, 'billing_reservations.id', 64),
        tenantId: requireBounded(row.tenant_id, 'billing_reservations.tenant_id', 36),
        currency: requireCurrency(row.currency),
        amountMinor: money(row.amount_minor, 'billing_reservations.amount_minor'),
        availableAccountId: requireBounded(row.available_account_id, 'billing_reservations.available_account_id', 64),
        reservedAccountId: requireBounded(row.reserved_account_id, 'billing_reservations.reserved_account_id', 64),
        version: (0, billing_ledger_sql_1.normalizeSqlVersion)(row.version, 'billing_reservations.version'),
        reference: requireNullableBounded(row.reference, 'billing_reservations.reference', 200),
        createdAt: toIso(row.created_at, 'billing_reservations.created_at'),
    };
};
const payoutOfRow = (row, tenantId) => {
    if (row.tenant_id !== tenantId) {
        throw new BillingReadModelError('invalid_row', 'a payout row belongs to another tenant');
    }
    return {
        payoutId: requireBounded(row.payout_id, 'payout_requests.payout_id', 64),
        tenantId: requireBounded(row.tenant_id, 'payout_requests.tenant_id', 36),
        amountMinor: money(row.amount_minor, 'payout_requests.amount_minor'),
        currency: requireCurrency(row.currency),
        status: requireActivePayoutStatus(row.status),
        version: (0, billing_ledger_sql_1.normalizeSqlVersion)(row.version, 'payout_requests.version'),
        requestedBy: requireNullableBounded(row.requested_by, 'payout_requests.requested_by', 128),
        createdAt: toIso(row.created_at, 'payout_requests.created_at'),
    };
};
const RECONCILE_SCAN_LIMIT = 5000;
const MAX_ALLOCATION_MINOR = 1000000000000000n;
/**
 * Per-obligation net allocation (contract 14.2.3), recomputed from this
 * obligation's own rows. Returns `null` (unproven, never zero) for an unknown
 * kind, a reversal without valid provenance, an out-of-range amount, a
 * currency different from the obligation, a journal that is not of the
 * expected platform role, a missing allocatable, or net outside [0, allocatable].
 * `credit` rows are excluded from the payer's net (and not inspected).
 */
const proveObligation = (obligation, rows) => {
    if (obligation.allocatable_minor === null || obligation.allocatable_minor === undefined)
        return null;
    if ((0, billing_ledger_1.classifyPlatformJournal)(obligation.receipt_key ?? '') !== 'receipt')
        return null;
    let allocatable;
    try {
        allocatable = (0, billing_ledger_sql_1.normalizeSqlBigInt)(obligation.allocatable_minor, 'obligation allocatable_minor');
    }
    catch {
        return null;
    }
    if (allocatable <= 0n || allocatable > MAX_ALLOCATION_MINOR)
        return null;
    const payments = new Map();
    const reversals = [];
    for (const row of rows) {
        if (row.kind === 'credit')
            continue;
        let amount;
        try {
            amount = (0, billing_ledger_sql_1.normalizeSqlBigInt)(row.amount_minor, 'allocation amount_minor');
        }
        catch {
            return null;
        }
        if (amount <= 0n || amount > MAX_ALLOCATION_MINOR)
            return null;
        if (row.currency !== obligation.currency)
            return null;
        if (row.kind === 'payment') {
            if ((0, billing_ledger_1.classifyPlatformJournal)(row.journal_key ?? '') !== 'allocation')
                return null;
            if (row.reverses_allocation_id !== null)
                return null;
            payments.set(row.allocation_id, amount);
        }
        else if (row.kind === 'reversal') {
            if ((0, billing_ledger_1.classifyPlatformJournal)(row.journal_key ?? '') !== 'allocation_reversal')
                return null;
            if (row.reverses_allocation_id === null)
                return null;
            reversals.push({ of: row.reverses_allocation_id, amount });
        }
        else {
            return null;
        }
    }
    let gross = 0n;
    for (const amount of payments.values())
        gross += amount;
    let reversed = 0n;
    const seen = new Set();
    for (const reversal of reversals) {
        const original = payments.get(reversal.of);
        if (original === undefined || seen.has(reversal.of) || reversal.amount > original)
            return null;
        seen.add(reversal.of);
        reversed += reversal.amount;
    }
    if (reversed > gross)
        return null;
    const net = gross - reversed;
    if (net < 0n || net > allocatable)
        return null;
    return {
        allocatable,
        net,
        paymentRows: payments.size,
        reversedMinor: reversed,
        discrepancy: obligation.reconciliation_status === 'discrepancy',
    };
};
class BillingReadModelsImpl {
    constructor(deps) {
        this.deps = deps;
        if (!deps || typeof deps.read !== 'function') {
            throw new BillingReadModelError('invalid_runner', 'BillingReadModels requires a caller-injected read-only executor');
        }
    }
    read(fn) {
        return this.deps.read(fn);
    }
    async listAccountBalances(tenantId, query) {
        const tenant = requireTenant(tenantId);
        const limit = requireLimit(query?.limit);
        const kind = query?.kind === undefined ? undefined : requireAccountKind(query.kind);
        const currency = query?.currency === undefined ? undefined : requireCurrency(query.currency);
        const after = query?.afterAccountId === undefined
            ? undefined
            : requireCursorId(query.afterAccountId, 'afterAccountId', 64);
        const conditions = ['tenant_id = ?'];
        const params = [tenant];
        if (kind !== undefined) {
            conditions.push('kind = ?');
            params.push(kind);
        }
        if (currency !== undefined) {
            conditions.push('currency = ?');
            params.push(currency);
        }
        if (after !== undefined) {
            conditions.push('id > ?');
            params.push(after);
        }
        params.push(limit + 1);
        const rows = await this.read((conn) => conn.query(`SELECT id, tenant_id, kind, currency, balance_minor, version, updated_at
               FROM billing_accounts
              WHERE ${conditions.join(' AND ')}
              ORDER BY id ASC
              LIMIT ?`, params));
        const truncated = rows.length > limit;
        return { rows: rows.slice(0, limit).map((row) => accountOfRow(row, tenant)), truncated };
    }
    async listInvoices(tenantId, query) {
        const tenant = requireTenant(tenantId);
        const limit = requireLimit(query?.limit);
        const conditions = ['tenant_id = ?'];
        const params = [tenant];
        if (query?.after !== undefined) {
            const cycleStart = requireSafeEpoch(query.after.cycleStart, 'after.cycleStart');
            const invoiceId = requireCursorId(query.after.invoiceId, 'after.invoiceId', 64);
            conditions.push('(cycle_start < ? OR (cycle_start = ? AND id < ?))');
            params.push(cycleStart, cycleStart, invoiceId);
        }
        params.push(limit + 1);
        const rows = await this.read((conn) => conn.query(`SELECT id, tenant_id, org_kind, billing_phase, cycle_start, total_minor,
                    currency, invoice_number, created_at
               FROM billing_invoices
              WHERE ${conditions.join(' AND ')}
              ORDER BY cycle_start DESC, id DESC
              LIMIT ?`, params));
        const truncated = rows.length > limit;
        return { rows: rows.slice(0, limit).map((row) => invoiceOfRow(row, tenant)), truncated };
    }
    async listDifferenceDebts(tenantId, query) {
        const tenant = requireTenant(tenantId);
        const limit = requireLimit(query?.limit);
        const conditions = ['tenant_id = ?', "status IN ('open', 'expired')"];
        const params = [tenant];
        if (query?.after !== undefined) {
            const deadlineAt = requireSafeEpoch(query.after.deadlineAt, 'after.deadlineAt');
            const requestId = requireCursorId(query.after.requestId, 'after.requestId', 64);
            conditions.push('(deadline_at > ? OR (deadline_at = ? AND id > ?))');
            params.push(deadlineAt, deadlineAt, requestId);
        }
        params.push(limit + 1);
        const rows = await this.read((conn) => conn.query(`SELECT id, tenant_id, invoice_id, cycle_start, amount_minor, currency,
                    status, issued_at, deadline_at
               FROM billing_difference_requests
              WHERE ${conditions.join(' AND ')}
              ORDER BY deadline_at ASC, id ASC
              LIMIT ?`, params));
        const truncated = rows.length > limit;
        return { rows: rows.slice(0, limit).map((row) => differenceOfRow(row, tenant)), truncated };
    }
    async listActiveReservations(tenantId, query) {
        const tenant = requireTenant(tenantId);
        const limit = requireLimit(query?.limit);
        const conditions = ['tenant_id = ?', "status = 'reserved'"];
        const params = [tenant];
        if (query?.after !== undefined) {
            const createdAt = requireCursorTimestamp(query.after.createdAt, 'after.createdAt');
            const reservationId = requireCursorId(query.after.reservationId, 'after.reservationId', 64);
            conditions.push('(created_at < ? OR (created_at = ? AND id < ?))');
            params.push(createdAt, createdAt, reservationId);
        }
        params.push(limit + 1);
        const rows = await this.read((conn) => conn.query(`SELECT id, tenant_id, currency, amount_minor, available_account_id,
                    reserved_account_id, version, reference, created_at
               FROM billing_reservations
              WHERE ${conditions.join(' AND ')}
              ORDER BY created_at DESC, id DESC
              LIMIT ?`, params));
        const truncated = rows.length > limit;
        return { rows: rows.slice(0, limit).map((row) => reservationOfRow(row, tenant)), truncated };
    }
    async listActivePayouts(tenantId, query) {
        const tenant = requireTenant(tenantId);
        const limit = requireLimit(query?.limit);
        const conditions = ['tenant_id = ?', "status IN ('requested', 'reserved', 'processing')"];
        const params = [tenant];
        if (query?.after !== undefined) {
            const createdAt = requireCursorTimestamp(query.after.createdAt, 'after.createdAt');
            const payoutId = requireCursorId(query.after.payoutId, 'after.payoutId', 64);
            conditions.push('(created_at < ? OR (created_at = ? AND payout_id < ?))');
            params.push(createdAt, createdAt, payoutId);
        }
        params.push(limit + 1);
        const rows = await this.read((conn) => conn.query(`SELECT payout_id, tenant_id, amount_minor, currency, status, version,
                    requested_by, created_at
               FROM payout_requests
              WHERE ${conditions.join(' AND ')}
              ORDER BY created_at DESC, payout_id DESC
              LIMIT ?`, params));
        const truncated = rows.length > limit;
        return { rows: rows.slice(0, limit).map((row) => payoutOfRow(row, tenant)), truncated };
    }
    async getMerchantPosition(tenantId, query) {
        const tenant = requireTenant(tenantId);
        const currency = query?.currency === undefined ? undefined : requireCurrency(query.currency);
        const placeholders = MERCHANT_POSITION_KINDS.map(() => '?').join(', ');
        const conditions = [`tenant_id = ?`, `kind IN (${placeholders})`];
        const params = [tenant, ...MERCHANT_POSITION_KINDS];
        if (currency !== undefined) {
            conditions.push('currency = ?');
            params.push(currency);
        }
        const rows = await this.read((conn) => conn.query(`SELECT id, tenant_id, kind, currency, balance_minor, version, updated_at
               FROM billing_accounts
              WHERE ${conditions.join(' AND ')}
              ORDER BY currency ASC, kind ASC`, params));
        const byCurrency = new Map();
        for (const row of rows) {
            if (row.tenant_id !== tenant) {
                throw new BillingReadModelError('invalid_row', 'an account row belongs to another tenant');
            }
            const kind = requireAccountKind(row.kind);
            if (!MERCHANT_POSITION_KINDS.includes(kind)) {
                continue;
            }
            const code = requireCurrency(row.currency);
            const bucket = byCurrency.get(code) ?? {};
            bucket[kind] = money(row.balance_minor, 'billing_accounts.balance_minor');
            byCurrency.set(code, bucket);
        }
        return [...byCurrency.entries()]
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
            .map(([code, bucket]) => ({
            currency: code,
            pendingMinor: bucket.merchant_pending ?? null,
            availableMinor: bucket.merchant_available ?? null,
            reservedMinor: bucket.merchant_reserved ?? null,
            subscriptionCreditMinor: bucket.subscription_credit ?? null,
        }));
    }
    async getDebtPosition(tenantId, query) {
        const tenant = requireTenant(tenantId);
        const currency = query?.currency === undefined ? undefined : requireCurrency(query.currency);
        const differenceConditions = ['tenant_id = ?', "status IN ('open', 'expired')"];
        const differenceParams = [tenant];
        const invoiceConditions = ['tenant_id = ?'];
        const invoiceParams = [tenant];
        if (currency !== undefined) {
            differenceConditions.push('currency = ?');
            differenceParams.push(currency);
            invoiceConditions.push('currency = ?');
            invoiceParams.push(currency);
        }
        const { difference, invoice } = await this.read(async (conn) => {
            const differenceRows = await conn.query(`SELECT currency, COALESCE(SUM(amount_minor), 0) AS total
                   FROM billing_difference_requests
                  WHERE ${differenceConditions.join(' AND ')}
                  GROUP BY currency`, differenceParams);
            const invoiceRows = await conn.query(`SELECT currency, COALESCE(SUM(total_minor), 0) AS total
                   FROM billing_invoices
                  WHERE ${invoiceConditions.join(' AND ')}
                  GROUP BY currency`, invoiceParams);
            return { difference: differenceRows, invoice: invoiceRows };
        });
        const differenceRequests = difference
            .map((row) => ({
            currency: requireCurrency(row.currency),
            amountMinor: money(row.total, 'difference request amount total'),
        }))
            .sort((x, y) => (x.currency < y.currency ? -1 : x.currency > y.currency ? 1 : 0));
        const invoiceTotals = invoice
            .map((row) => ({
            currency: requireCurrency(row.currency),
            totalMinor: money(row.total, 'issued invoice total'),
        }))
            .sort((x, y) => (x.currency < y.currency ? -1 : x.currency > y.currency ? 1 : 0));
        const outstandingInvoiceDebt = await this.readOutstandingInvoiceDebt(tenant, currency);
        return { outstandingInvoiceDebt, invoiceTotals, differenceRequests };
    }
    /**
     * Outstanding debt from the shared allocation source only. Any failure or
     * incompleteness is an explicit `unavailable` marker; this method can never
     * return zero or a guessed total.
     */
    async readOutstandingInvoiceDebt(tenant, currency) {
        const source = this.deps.debtSource;
        if (source === undefined) {
            return { availability: 'unavailable', reason: 'debt_source_not_configured' };
        }
        let listed;
        try {
            listed = await source.listInvoiceOutstanding(tenant, { limit: SOURCE_DEBT_LIST_LIMIT });
        }
        catch (error) {
            // A typed debt-source failure (lock refused, lock wait, deadlock,
            // missing table) is "unavailable", never an exception and never zero.
            if ((0, billing_settlement_1.isDebtSourceUnavailableError)(error)) {
                return { availability: 'unavailable', reason: 'debt_source_unavailable' };
            }
            throw error;
        }
        if (!listed.ok) {
            return { availability: 'unavailable', reason: 'debt_source_unavailable' };
        }
        if (listed.truncated) {
            return { availability: 'unavailable', reason: 'debt_source_incomplete' };
        }
        const totals = new Map();
        const open = new Map();
        for (const entry of listed.invoices) {
            const code = requireCurrency(entry.currency);
            if (currency !== undefined && code !== currency)
                continue;
            const outstanding = (0, billing_ledger_sql_1.normalizeSqlBigInt)(entry.outstandingMinor, 'invoice outstanding');
            totals.set(code, (totals.get(code) ?? 0n) + outstanding);
            if (outstanding <= 0n)
                continue;
            // Same due terms the payout gate uses. Unresolved or malformed due
            // on an unpaid invoice makes the whole position unavailable.
            if (entry.dueStatus !== 'resolved') {
                return { availability: 'unavailable', reason: 'debt_source_unavailable', detail: 'due_unresolved' };
            }
            const dueAt = typeof entry.dueAt === 'string' && /^(0|[1-9][0-9]{0,18})$/.test(entry.dueAt)
                ? entry.dueAt
                : null;
            const basisVersion = entry.dueBasisVersion;
            if (dueAt === null
                || typeof entry.dueBasisRef !== 'string'
                || entry.dueBasisRef === ''
                || typeof basisVersion !== 'number'
                || !Number.isSafeInteger(basisVersion)
                || basisVersion < 1) {
                return { availability: 'unavailable', reason: 'debt_source_unavailable', detail: 'due_invalid' };
            }
            const bucket = open.get(code) ?? [];
            bucket.push({
                invoiceId: requireBounded(entry.invoiceId, 'invoice id', 64),
                outstandingMinor: outstanding.toString(),
                dueStatus: 'resolved',
                dueAt,
                dueBasisRef: entry.dueBasisRef,
                dueBasisVersion: basisVersion,
            });
            open.set(code, bucket);
        }
        const rows = [...totals.entries()]
            .sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))
            .map(([code, total]) => ({
            currency: code,
            outstandingMinor: total.toString(),
            invoices: open.get(code) ?? [],
        }));
        return { availability: 'available', rows };
    }
    async reconcileReservedPosition(tenantId, query) {
        const tenant = requireTenant(tenantId);
        const currency = query?.currency === undefined ? undefined : requireCurrency(query.currency);
        const accountConditions = ['tenant_id = ?', "kind = 'merchant_reserved'"];
        const accountParams = [tenant];
        const reservationConditions = ['tenant_id = ?', "status = 'reserved'"];
        const reservationParams = [tenant];
        if (currency !== undefined) {
            accountConditions.push('currency = ?');
            accountParams.push(currency);
            reservationConditions.push('currency = ?');
            reservationParams.push(currency);
        }
        const { accounts, reservations } = await this.read(async (conn) => {
            const accountRows = await conn.query(`SELECT currency, balance_minor AS total
                   FROM billing_accounts
                  WHERE ${accountConditions.join(' AND ')}`, accountParams);
            const reservationRows = await conn.query(`SELECT currency, COALESCE(SUM(amount_minor), 0) AS total
                   FROM billing_reservations
                  WHERE ${reservationConditions.join(' AND ')}
                  GROUP BY currency`, reservationParams);
            return { accounts: accountRows, reservations: reservationRows };
        });
        const codes = new Set();
        const accountByCurrency = new Map();
        const reservationByCurrency = new Map();
        for (const row of accounts) {
            const code = requireCurrency(row.currency);
            codes.add(code);
            accountByCurrency.set(code, (0, billing_ledger_sql_1.normalizeSqlBigInt)(row.total, 'reserved account balance'));
        }
        for (const row of reservations) {
            const code = requireCurrency(row.currency);
            codes.add(code);
            reservationByCurrency.set(code, (0, billing_ledger_sql_1.normalizeSqlBigInt)(row.total, 'active reservation total'));
        }
        return [...codes].sort().map((code) => {
            const account = accountByCurrency.get(code);
            const reserved = reservationByCurrency.get(code) ?? 0n;
            return {
                tenantId: tenant,
                currency: code,
                reservedAccountMinor: account === undefined ? null : account.toString(),
                activeReservationsMinor: reserved.toString(),
                matches: account !== undefined && account === reserved,
            };
        });
    }
    /**
     * Platform unallocated-receipts reconciliation (contract 14.7). NON-LOCKING
     * snapshot, display only, never gating money. The pooled account balance is
     * compared with the obligation-derived remainder per currency but is never
     * used as proof of any single payment: each obligation's net allocation is
     * recomputed from its own allocation rows (payment minus reversals that
     * name the payment they reverse; credit rows excluded) and its journals are
     * classified by idempotency key. Anything unprovable is listed, never zero.
     */
    async reconcileUnallocatedReceipts(tenantId, query) {
        const tenant = requireTenant(tenantId);
        const currency = query?.currency === undefined ? undefined : requireCurrency(query.currency);
        const currencyClause = (alias) => (currency === undefined ? '' : ` AND ${alias}.currency = ?`);
        const tail = currency === undefined ? [] : [currency];
        const snapshot = await this.read(async (conn) => {
            const accounts = await conn.query(`SELECT a.tenant_id, a.currency, a.balance_minor
                   FROM billing_accounts a
                  WHERE a.tenant_id = ? AND a.kind = 'platform_unallocated_receipts'${currencyClause('a')}`, [tenant, ...tail]);
            const obligations = await conn.query(`SELECT o.id, o.tenant_id, o.currency, o.allocatable_minor, o.reconciliation_status,
                        k.idempotency_key AS receipt_key
                   FROM financial_settlement_obligations o
                   LEFT JOIN billing_idempotency_keys k
                     ON k.journal_id = o.platform_receipt_journal_id AND k.tenant_id = o.tenant_id
                    AND k.scope = 'journal'
                  WHERE o.tenant_id = ? AND o.purpose = 'subscription_difference'
                    AND o.platform_receipt_journal_id IS NOT NULL${currencyClause('o')}
                  ORDER BY o.id ASC
                  LIMIT ?`, [tenant, ...tail, RECONCILE_SCAN_LIMIT + 1]);
            const allocations = await conn.query(`SELECT a.allocation_id, a.tenant_id, a.obligation_id, a.currency, a.kind,
                        a.amount_minor, a.reverses_allocation_id, k.idempotency_key AS journal_key
                   FROM billing_payment_allocations a
                   JOIN financial_settlement_obligations o
                     ON o.id = a.obligation_id AND o.tenant_id = a.tenant_id
                   LEFT JOIN billing_idempotency_keys k
                     ON k.journal_id = a.journal_id AND k.tenant_id = a.tenant_id
                    AND k.scope = 'journal'
                  WHERE a.tenant_id = ? AND o.purpose = 'subscription_difference'
                    AND o.platform_receipt_journal_id IS NOT NULL${currencyClause('o')}
                  ORDER BY a.allocation_id ASC
                  LIMIT ?`, [tenant, ...tail, RECONCILE_SCAN_LIMIT + 1]);
            const links = await conn.query(`SELECT l.tenant_id, l.obligation_id, l.request_id, l.currency, l.amount_minor
                   FROM platform_payment_request_links l
                   JOIN billing_difference_requests r
                     ON r.id = l.request_id AND r.tenant_id = l.tenant_id
                  WHERE l.tenant_id = ? AND r.status = 'paid'${currencyClause('l')}
                  ORDER BY l.request_id ASC
                  LIMIT ?`, [tenant, ...tail, RECONCILE_SCAN_LIMIT + 1]);
            return { accounts, obligations, allocations, links };
        });
        if (snapshot.obligations.length > RECONCILE_SCAN_LIMIT
            || snapshot.allocations.length > RECONCILE_SCAN_LIMIT
            || snapshot.links.length > RECONCILE_SCAN_LIMIT) {
            // Never a partial reconciliation: an overrun is an error, not a guess.
            throw new BillingReadModelError('store_overrun', 'the unallocated-receipts reconciliation scan exceeded its bound');
        }
        const allocationsByObligation = new Map();
        for (const row of snapshot.allocations) {
            if (row.tenant_id !== tenant) {
                throw new BillingReadModelError('invalid_row', 'an allocation row belongs to another tenant');
            }
            const id = requireBounded(row.obligation_id, 'billing_payment_allocations.obligation_id', 36);
            const bucket = allocationsByObligation.get(id) ?? [];
            bucket.push(row);
            allocationsByObligation.set(id, bucket);
        }
        const codes = new Set();
        const accountByCurrency = new Map();
        for (const row of snapshot.accounts) {
            if (row.tenant_id !== tenant) {
                throw new BillingReadModelError('invalid_row', 'an account row belongs to another tenant');
            }
            const code = requireCurrency(row.currency);
            codes.add(code);
            accountByCurrency.set(code, (0, billing_ledger_sql_1.normalizeSqlBigInt)(row.balance_minor, 'unallocated receipts balance'));
        }
        const proven = new Map();
        const unproven = new Map();
        for (const row of snapshot.obligations) {
            if (row.tenant_id !== tenant) {
                throw new BillingReadModelError('invalid_row', 'an obligation row belongs to another tenant');
            }
            const id = requireBounded(row.id, 'financial_settlement_obligations.id', 36);
            const code = requireCurrency(row.currency);
            codes.add(code);
            const result = proveObligation(row, allocationsByObligation.get(id) ?? []);
            if (result === null) {
                const list = unproven.get(code) ?? [];
                list.push(id);
                unproven.set(code, list);
            }
            else {
                proven.set(id, { currency: code, ...result });
            }
        }
        const requestsByCurrency = new Map();
        for (const row of snapshot.links) {
            if (row.tenant_id !== tenant) {
                throw new BillingReadModelError('invalid_row', 'a payment request link belongs to another tenant');
            }
            const code = requireCurrency(row.currency);
            codes.add(code);
            const obligationId = requireBounded(row.obligation_id, 'platform_payment_request_links.obligation_id', 36);
            const requestAmount = (0, billing_ledger_sql_1.normalizeSqlBigInt)(row.amount_minor, 'platform_payment_request_links.amount_minor');
            const entry = proven.get(obligationId);
            if (entry === undefined || entry.currency !== code || entry.net < requestAmount) {
                const list = requestsByCurrency.get(code) ?? [];
                list.push(requireBounded(row.request_id, 'platform_payment_request_links.request_id', 36));
                requestsByCurrency.set(code, list);
            }
        }
        return [...codes].sort().map((code) => {
            let derived = 0n;
            const overFunded = [];
            const reversed = [];
            for (const [id, entry] of proven) {
                if (entry.currency !== code)
                    continue;
                derived += entry.allocatable - entry.net;
                if (entry.reversedMinor > 0n) {
                    reversed.push(id);
                }
                else if (entry.net < entry.allocatable && (entry.paymentRows > 0 || entry.discrepancy)) {
                    overFunded.push(id);
                }
            }
            const account = accountByCurrency.get(code);
            const unprovenIds = [...(unproven.get(code) ?? [])].sort();
            return {
                tenantId: tenant,
                currency: code,
                unallocatedAccountMinor: account === undefined ? null : account.toString(),
                obligationDerivedMinor: derived.toString(),
                overFundedObligations: overFunded.sort(),
                reversedAfterAllocationObligations: reversed.sort(),
                unprovenObligations: unprovenIds,
                requestsRequiringReconciliation: [...(requestsByCurrency.get(code) ?? [])].sort(),
                matches: account !== undefined && account === derived && unprovenIds.length === 0,
            };
        });
    }
}
const createBillingReadModels = (deps) => new BillingReadModelsImpl(deps);
exports.createBillingReadModels = createBillingReadModels;
