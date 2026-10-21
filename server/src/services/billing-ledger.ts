/**
 * B2-C-LEDGER — tenant-scoped, append-only double-entry journal domain.
 *
 * Contract: docs/contracts/BILLING-LEDGER-INTERNAL-CONTRACT.md.
 *
 * This module owns validation, balance arithmetic and the journal/reversal
 * rules. It performs no I/O by itself: persistence is the injected
 * `LedgerStore`, whose `runAtomic` callback is the transaction seam. The
 * in-memory test store lives in the test file; this module says nothing about
 * whether any SQL table exists.
 *
 * Money is exact integer minor units (`bigint`) with no floating-point
 * arithmetic. Every externally visible amount is serialized with
 * `serializeMoneyMinor` as a decimal string.
 *
 * There is no commission, fee, invoice, refund, payout or provider policy in
 * this module; those decisions are HELD (see the contract).
 */

import { createHash, randomUUID } from 'node:crypto';

export const ACCOUNT_KINDS = [
    'platform_receivable',
    'platform_cash',
    'merchant_pending',
    'merchant_available',
    'merchant_reserved',
    'subscription_credit',
    'cash_receipt_clearing',
] as const;

export type AccountKind = (typeof ACCOUNT_KINDS)[number];

export type NormalSide = 'debit' | 'credit';

export const ACCOUNT_NORMAL_SIDE: Readonly<Record<AccountKind, NormalSide>> = Object.freeze({
    platform_receivable: 'debit',
    platform_cash: 'debit',
    merchant_pending: 'credit',
    merchant_available: 'credit',
    merchant_reserved: 'credit',
    subscription_credit: 'credit',
    cash_receipt_clearing: 'credit',
});

export const LINE_DIRECTIONS = ['debit', 'credit'] as const;
export type LineDirection = (typeof LINE_DIRECTIONS)[number];

/** Largest single line/operation amount, in minor units (10^15). */
export const MAX_AMOUNT_MINOR = 1_000_000_000_000_000n;
/** Largest normal-side account balance the domain will write. */
export const MAX_ACCOUNT_BALANCE_MINOR = 9_223_372_036_854_775_807n;
export const MAX_JOURNAL_LINES = 100;
export const MAX_TENANT_ID_LENGTH = 36;
export const MAX_ACCOUNT_ID_LENGTH = 36;
export const MAX_JOURNAL_ID_LENGTH = 36;
export const MAX_IDEMPOTENCY_KEY_LENGTH = 128;
export const MAX_REFERENCE_LENGTH = 200;
export const MAX_DESCRIPTION_LENGTH = 500;

const CURRENCY_PATTERN = /^[A-Z]{3}$/;

export type LedgerErrorCode =
    | 'invalid_input'
    | 'invalid_tenant'
    | 'invalid_currency'
    | 'invalid_idempotency_key'
    | 'invalid_reference'
    | 'invalid_description'
    | 'invalid_lines'
    | 'too_many_lines'
    | 'invalid_line'
    | 'invalid_account_id'
    | 'invalid_direction'
    | 'invalid_amount'
    | 'amount_out_of_range'
    | 'unbalanced_journal'
    | 'currency_mismatch'
    | 'account_not_found'
    | 'tenant_mismatch'
    | 'account_kind_mismatch'
    | 'negative_balance'
    | 'balance_out_of_range'
    | 'idempotency_conflict'
    | 'account_version_conflict'
    | 'journal_not_found'
    | 'already_reversed'
    | 'credit_not_withdrawable'
    | 'cash_receipt_not_available'
    | 'invalid_reversal';

export class LedgerError extends Error {
    constructor(public readonly code: LedgerErrorCode, message: string) {
        super(message);
        this.name = 'LedgerError';
    }
}

function fail(code: LedgerErrorCode, message: string): never {
    throw new LedgerError(code, message);
}

function requireBoundedString(value: unknown, field: string, maxLength: number, code: LedgerErrorCode): string {
    if (typeof value !== 'string') fail(code, `${field} must be a string`);
    const text = value.trim();
    if (text.length === 0 || text.length > maxLength || text !== value) {
        fail(code, `${field} must be a non-empty trimmed string of at most ${maxLength} characters`);
    }
    return text;
}

function optionalBoundedString(value: unknown, field: string, maxLength: number, code: LedgerErrorCode): string | null {
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

function requireDirection(value: unknown): LineDirection {
    if (value !== 'debit' && value !== 'credit') fail('invalid_direction', 'direction must be debit or credit');
    return value;
}

/**
 * Validate one exact minor-unit amount. Only `bigint` is accepted; numbers and
 * numeric strings are rejected so no implicitly rounded value can enter the
 * ledger. Zero and negative values are rejected.
 */
export function normalizeAmountMinor(value: unknown): bigint {
    if (typeof value !== 'bigint') fail('invalid_amount', 'amount must be a bigint of minor units');
    if (value <= 0n) fail('invalid_amount', 'amount must be positive');
    if (value > MAX_AMOUNT_MINOR) fail('amount_out_of_range', `amount exceeds ${MAX_AMOUNT_MINOR.toString()}`);
    return value;
}

/** Serialize exact minor units as a decimal string (never a JS number). */
export function serializeMoneyMinor(value: bigint): string {
    if (typeof value !== 'bigint') fail('invalid_amount', 'amount must be a bigint of minor units');
    return value.toString();
}

export interface LedgerAccount {
    readonly id: string;
    readonly tenantId: string;
    readonly kind: AccountKind;
    readonly normalSide: NormalSide;
    readonly currency: string;
    readonly balanceMinor: bigint;
    readonly version: number;
}

export interface JournalLineRecord {
    readonly lineNo: number;
    readonly accountId: string;
    readonly accountKind: AccountKind;
    readonly direction: LineDirection;
    readonly amountMinor: bigint;
}

export interface JournalRecord {
    readonly id: string;
    readonly tenantId: string;
    readonly currency: string;
    readonly journalType: 'standard' | 'reversal';
    readonly reversalOfJournalId: string | null;
    readonly reference: string | null;
    readonly description: string | null;
    readonly idempotencyKey: string;
    readonly payloadHash: string;
    readonly createdAt: string;
    readonly lines: readonly JournalLineRecord[];
}

export interface AccountBalanceChange {
    readonly accountId: string;
    readonly expectedVersion: number;
    readonly newBalanceMinor: bigint;
    readonly newVersion: number;
}

export interface NewJournalRecord {
    readonly id: string;
    readonly tenantId: string;
    readonly currency: string;
    readonly journalType: 'standard' | 'reversal';
    readonly reversalOfJournalId: string | null;
    readonly reference: string | null;
    readonly description: string | null;
    readonly createdAt: string;
}

export interface InsertJournalInput {
    readonly journal: NewJournalRecord;
    readonly lines: readonly JournalLineRecord[];
    readonly balanceChanges: readonly AccountBalanceChange[];
    readonly idempotencyKey: string;
    readonly payloadHash: string;
}

export type InsertJournalResult =
    | { readonly ok: true; readonly journal: JournalRecord }
    | { readonly ok: false; readonly reason: 'idempotent_replay'; readonly journal: JournalRecord }
    | { readonly ok: false; readonly reason: 'idempotency_conflict' }
    | { readonly ok: false; readonly reason: 'account_version_conflict'; readonly accountId: string };

/**
 * Transaction-bound persistence contract.
 *
 * SQL obligations behind this interface (see contract §7):
 *  - `getAccount` reads the row through the same transaction; `insertJournal`
 *    is the only balance-mutating primitive and must lock every touched
 *    account row in ascending `id` order, then CAS on `version`.
 *  - `insertJournal` must atomically write the idempotency key, the journal,
 *    its lines and every account balance/version update. A duplicate
 *    `(tenant, key)` with the same payload hash returns `idempotent_replay`;
 *    a different hash returns `idempotency_conflict`; any CAS mismatch returns
 *    `account_version_conflict`.
 *  - The store must not auto-create accounts.
 */
export interface LedgerTransaction {
    getAccount(tenantId: string, accountId: string): Promise<LedgerAccount | null>;
    findJournalByIdempotencyKey(tenantId: string, idempotencyKey: string): Promise<JournalRecord | null>;
    getJournal(tenantId: string, journalId: string): Promise<JournalRecord | null>;
    findReversalOf(tenantId: string, journalId: string): Promise<JournalRecord | null>;
    insertJournal(input: InsertJournalInput): Promise<InsertJournalResult>;
}

export interface LedgerStore<Tx extends LedgerTransaction = LedgerTransaction> {
    runAtomic<T>(callback: (tx: Tx) => Promise<T>): Promise<T>;
}

export interface JournalLineInput {
    readonly accountId: string;
    readonly direction: LineDirection;
    readonly amountMinor: unknown;
}

export interface PostJournalInput {
    readonly tenantId: string;
    readonly currency: string;
    readonly idempotencyKey: string;
    readonly lines: readonly JournalLineInput[];
    readonly reference?: string | null;
    readonly description?: string | null;
    readonly createdAt?: string;
    readonly journalType?: 'standard' | 'reversal';
    readonly reversalOfJournalId?: string | null;
}

export interface PostJournalResult {
    readonly journal: JournalRecord;
    readonly replayed: boolean;
}

interface NormalizedLine {
    readonly accountId: string;
    readonly direction: LineDirection;
    readonly amountMinor: bigint;
}

interface NormalizedJournal {
    readonly tenantId: string;
    readonly currency: string;
    readonly idempotencyKey: string;
    readonly reference: string | null;
    readonly description: string | null;
    readonly createdAt: string;
    readonly journalType: 'standard' | 'reversal';
    readonly reversalOfJournalId: string | null;
    readonly lines: readonly NormalizedLine[];
    readonly payloadHash: string;
}

function normalizeCreatedAt(value: unknown): string {
    if (value === undefined) return new Date().toISOString();
    if (typeof value !== 'string' || value.trim() === '' || Number.isNaN(Date.parse(value))) {
        fail('invalid_input', 'createdAt must be a parseable timestamp string');
    }
    return value;
}

function normalizeJournal(input: PostJournalInput): NormalizedJournal {
    const tenantId = requireBoundedString(input.tenantId, 'tenantId', MAX_TENANT_ID_LENGTH, 'invalid_tenant');
    const currency = requireCurrency(input.currency);
    const idempotencyKey = requireBoundedString(
        input.idempotencyKey,
        'idempotencyKey',
        MAX_IDEMPOTENCY_KEY_LENGTH,
        'invalid_idempotency_key',
    );
    const reference = optionalBoundedString(input.reference, 'reference', MAX_REFERENCE_LENGTH, 'invalid_reference');
    const description = optionalBoundedString(
        input.description,
        'description',
        MAX_DESCRIPTION_LENGTH,
        'invalid_description',
    );

    const journalType = input.journalType ?? 'standard';
    if (journalType !== 'standard' && journalType !== 'reversal') {
        fail('invalid_input', 'journalType must be standard or reversal');
    }

    let reversalOfJournalId: string | null = null;
    if (journalType === 'reversal') {
        reversalOfJournalId = requireBoundedString(
            input.reversalOfJournalId,
            'reversalOfJournalId',
            MAX_JOURNAL_ID_LENGTH,
            'invalid_reversal',
        );
    } else if (input.reversalOfJournalId !== undefined && input.reversalOfJournalId !== null) {
        fail('invalid_reversal', 'a standard journal cannot reference a reversal target');
    }

    if (!Array.isArray(input.lines)) fail('invalid_lines', 'lines must be an array');
    if (input.lines.length < 2) fail('invalid_lines', 'a journal needs at least two lines');
    if (input.lines.length > MAX_JOURNAL_LINES) {
        fail('too_many_lines', `a journal may have at most ${MAX_JOURNAL_LINES} lines`);
    }

    const lines: NormalizedLine[] = [];
    for (const raw of input.lines) {
        if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
            fail('invalid_line', 'each line must be an object');
        }
        const line = raw as JournalLineInput;
        const accountId = requireBoundedString(
            line.accountId,
            'accountId',
            MAX_ACCOUNT_ID_LENGTH,
            'invalid_account_id',
        );
        const direction = requireDirection(line.direction);
        const amountMinor = normalizeAmountMinor(line.amountMinor);
        lines.push({ accountId, direction, amountMinor });
    }

    const createdAt = normalizeCreatedAt(input.createdAt);
    const payloadHash = hashJournalPayload({
        tenantId,
        currency,
        reference,
        description,
        journalType,
        reversalOfJournalId,
        lines,
    });

    return {
        tenantId,
        currency,
        idempotencyKey,
        reference,
        description,
        createdAt,
        journalType,
        reversalOfJournalId,
        lines,
        payloadHash,
    };
}

function hashJournalPayload(input: {
    tenantId: string;
    currency: string;
    reference: string | null;
    description: string | null;
    journalType: 'standard' | 'reversal';
    reversalOfJournalId: string | null;
    lines: readonly NormalizedLine[];
}): string {
    const canonicalLines = input.lines
        .map((line) => ({
            accountId: line.accountId,
            direction: line.direction,
            amountMinor: line.amountMinor.toString(),
        }))
        .sort((left, right) => {
            if (left.accountId !== right.accountId) return left.accountId < right.accountId ? -1 : 1;
            if (left.direction !== right.direction) return left.direction < right.direction ? -1 : 1;
            if (left.amountMinor !== right.amountMinor) return left.amountMinor < right.amountMinor ? -1 : 1;
            return 0;
        });

    return createHash('sha256')
        .update(JSON.stringify({
            tenantId: input.tenantId,
            currency: input.currency,
            reference: input.reference,
            description: input.description,
            journalType: input.journalType,
            reversalOfJournalId: input.reversalOfJournalId,
            lines: canonicalLines,
        }))
        .digest('hex');
}

function assertNoForbiddenWalletTransfers(kinds: ReadonlySet<AccountKind>): void {
    const merchantKinds: readonly AccountKind[] = ['merchant_pending', 'merchant_available', 'merchant_reserved'];
    const touchesMerchant = merchantKinds.some((kind) => kinds.has(kind));

    if (kinds.has('subscription_credit') && touchesMerchant) {
        fail(
            'credit_not_withdrawable',
            'subscription_credit may only offset platform receivables, never a merchant wallet',
        );
    }
    if (kinds.has('cash_receipt_clearing') && touchesMerchant) {
        fail(
            'cash_receipt_not_available',
            'cash receipt clearing is not withdrawable e-money and cannot touch a merchant wallet',
        );
    }
}

function balanceDelta(account: LedgerAccount, direction: LineDirection, amountMinor: bigint): bigint {
    const signedAmount = direction === account.normalSide ? amountMinor : -amountMinor;
    return signedAmount;
}

async function loadAccounts(
    tx: LedgerTransaction,
    tenantId: string,
    currency: string,
    lines: readonly NormalizedLine[],
): Promise<Map<string, LedgerAccount>> {
    const accountIds = Array.from(new Set(lines.map((line) => line.accountId))).sort();
    const accounts = new Map<string, LedgerAccount>();

    for (const accountId of accountIds) {
        const account = await tx.getAccount(tenantId, accountId);
        if (account === null) fail('account_not_found', `account ${accountId} was not found`);
        if (account.tenantId !== tenantId) fail('tenant_mismatch', `account ${accountId} belongs to another tenant`);
        if (account.currency !== currency) {
            fail('currency_mismatch', `account ${accountId} is not in ${currency}`);
        }
        const expectedSide = ACCOUNT_NORMAL_SIDE[account.kind];
        if (expectedSide === undefined) fail('account_kind_mismatch', `account ${accountId} has an unknown kind`);
        if (account.normalSide !== expectedSide) {
            fail('account_kind_mismatch', `account ${accountId} normal side does not match its kind`);
        }
        if (!Number.isSafeInteger(account.version) || account.version < 0) {
            fail('invalid_input', `account ${accountId} has an invalid version`);
        }
        accounts.set(accountId, account);
    }

    return accounts;
}

function computeTotals(lines: readonly NormalizedLine[]): { debits: bigint; credits: bigint } {
    let debits = 0n;
    let credits = 0n;
    for (const line of lines) {
        if (line.direction === 'debit') debits += line.amountMinor;
        else credits += line.amountMinor;
    }
    return { debits, credits };
}

function assertReversalMirrorsOriginal(original: JournalRecord, lines: readonly NormalizedLine[]): void {
    const expected = original.lines
        .map((line) => ({
            accountId: line.accountId,
            direction: line.direction === 'debit' ? 'credit' : 'debit',
            amountMinor: line.amountMinor.toString(),
        }))
        .sort((left, right) => {
            if (left.accountId !== right.accountId) return left.accountId < right.accountId ? -1 : 1;
            if (left.direction !== right.direction) return left.direction < right.direction ? -1 : 1;
            if (left.amountMinor !== right.amountMinor) return left.amountMinor < right.amountMinor ? -1 : 1;
            return 0;
        });

    const actual = lines
        .map((line) => ({
            accountId: line.accountId,
            direction: line.direction,
            amountMinor: line.amountMinor.toString(),
        }))
        .sort((left, right) => {
            if (left.accountId !== right.accountId) return left.accountId < right.accountId ? -1 : 1;
            if (left.direction !== right.direction) return left.direction < right.direction ? -1 : 1;
            if (left.amountMinor !== right.amountMinor) return left.amountMinor < right.amountMinor ? -1 : 1;
            return 0;
        });

    if (JSON.stringify(expected) !== JSON.stringify(actual)) {
        fail('invalid_reversal', 'reversal lines must mirror the original journal with sides swapped');
    }
}

/**
 * Post one journal through an already-open transaction. Used directly by
 * `billing-reservations.ts`; other callers should use `postJournal`.
 */
export async function postJournalInTransaction(
    tx: LedgerTransaction,
    input: PostJournalInput,
): Promise<PostJournalResult> {
    const draft = normalizeJournal(input);

    const existing = await tx.findJournalByIdempotencyKey(draft.tenantId, draft.idempotencyKey);
    if (existing !== null) {
        if (existing.payloadHash !== draft.payloadHash) {
            fail('idempotency_conflict', 'idempotency key was reused with a different payload');
        }
        return { journal: existing, replayed: true };
    }

    if (draft.journalType === 'reversal' && draft.reversalOfJournalId !== null) {
        const original = await tx.getJournal(draft.tenantId, draft.reversalOfJournalId);
        if (original === null) fail('journal_not_found', 'the journal being reversed was not found');
        if (original.tenantId !== draft.tenantId) fail('tenant_mismatch', 'the journal being reversed is foreign');
        if (original.currency !== draft.currency) {
            fail('currency_mismatch', 'a reversal must use the original journal currency');
        }
        const existingReversal = await tx.findReversalOf(draft.tenantId, draft.reversalOfJournalId);
        if (existingReversal !== null) {
            fail('already_reversed', 'journal already has a reversal');
        }
        assertReversalMirrorsOriginal(original, draft.lines);
    }

    const accounts = await loadAccounts(tx, draft.tenantId, draft.currency, draft.lines);
    const kinds = new Set<AccountKind>();
    for (const account of accounts.values()) kinds.add(account.kind);
    assertNoForbiddenWalletTransfers(kinds);

    const totals = computeTotals(draft.lines);
    if (totals.debits !== totals.credits) {
        fail('unbalanced_journal', 'journal debits and credits are not equal in the journal currency');
    }

    const deltas = new Map<string, bigint>();
    for (const line of draft.lines) {
        const account = accounts.get(line.accountId);
        if (account === undefined) fail('account_not_found', `account ${line.accountId} was not found`);
        const current = deltas.get(line.accountId) ?? 0n;
        deltas.set(line.accountId, current + balanceDelta(account, line.direction, line.amountMinor));
    }

    const balanceChanges: AccountBalanceChange[] = [];
    for (const accountId of Array.from(deltas.keys()).sort()) {
        const account = accounts.get(accountId);
        if (account === undefined) fail('account_not_found', `account ${accountId} was not found`);
        const delta = deltas.get(accountId) ?? 0n;
        const newBalance = account.balanceMinor + delta;
        if (newBalance < 0n) {
            fail('negative_balance', `posting would make account ${accountId} negative`);
        }
        if (newBalance > MAX_ACCOUNT_BALANCE_MINOR) {
            fail('balance_out_of_range', `posting would exceed the account balance bound for ${accountId}`);
        }
        balanceChanges.push({
            accountId,
            expectedVersion: account.version,
            newBalanceMinor: newBalance,
            newVersion: account.version + 1,
        });
    }

    const lines: JournalLineRecord[] = draft.lines.map((line, index) => {
        const account = accounts.get(line.accountId);
        if (account === undefined) fail('account_not_found', `account ${line.accountId} was not found`);
        return {
            lineNo: index + 1,
            accountId: line.accountId,
            accountKind: account.kind,
            direction: line.direction,
            amountMinor: line.amountMinor,
        };
    });

    const journal: NewJournalRecord = {
        id: randomUUID(),
        tenantId: draft.tenantId,
        currency: draft.currency,
        journalType: draft.journalType,
        reversalOfJournalId: draft.reversalOfJournalId,
        reference: draft.reference,
        description: draft.description,
        createdAt: draft.createdAt,
    };

    const inserted = await tx.insertJournal({
        journal,
        lines,
        balanceChanges,
        idempotencyKey: draft.idempotencyKey,
        payloadHash: draft.payloadHash,
    });

    if (inserted.ok) return { journal: inserted.journal, replayed: false };

    if (inserted.reason === 'idempotent_replay') {
        if (inserted.journal.payloadHash !== draft.payloadHash) {
            fail('idempotency_conflict', 'idempotency key was reused with a different payload');
        }
        return { journal: inserted.journal, replayed: true };
    }
    if (inserted.reason === 'idempotency_conflict') {
        fail('idempotency_conflict', 'idempotency key was reused with a different payload');
    }
    fail('account_version_conflict', `account ${inserted.accountId} changed during the posting`);
}

export async function postJournal<Tx extends LedgerTransaction>(
    store: LedgerStore<Tx>,
    input: PostJournalInput,
): Promise<PostJournalResult> {
    return store.runAtomic((tx) => postJournalInTransaction(tx, input));
}

export interface ReverseJournalInput {
    readonly tenantId: string;
    readonly journalId: string;
    readonly idempotencyKey: string;
    readonly reason: string;
    readonly createdAt?: string;
}

/**
 * Append a reversal journal. The original journal and its lines are never
 * updated or deleted; only a new mirror journal with swapped debit/credit
 * sides is written. One journal may be reversed at most once per tenant.
 */
export async function reverseJournal<Tx extends LedgerTransaction>(
    store: LedgerStore<Tx>,
    input: ReverseJournalInput,
): Promise<PostJournalResult> {
    const tenantId = requireBoundedString(input.tenantId, 'tenantId', MAX_TENANT_ID_LENGTH, 'invalid_tenant');
    const journalId = requireBoundedString(input.journalId, 'journalId', MAX_JOURNAL_ID_LENGTH, 'invalid_input');
    const idempotencyKey = requireBoundedString(
        input.idempotencyKey,
        'idempotencyKey',
        MAX_IDEMPOTENCY_KEY_LENGTH,
        'invalid_idempotency_key',
    );
    const reason = requireBoundedString(input.reason, 'reason', MAX_DESCRIPTION_LENGTH, 'invalid_description');

    return store.runAtomic(async (tx) => {
        const original = await tx.getJournal(tenantId, journalId);
        if (original === null) fail('journal_not_found', 'journal was not found');

        const existingReversal = await tx.findReversalOf(tenantId, journalId);
        if (existingReversal !== null && existingReversal.idempotencyKey !== idempotencyKey) {
            fail('already_reversed', 'journal already has a reversal');
        }

        const lines: NormalizedLine[] = original.lines
            .slice()
            .sort((left, right) => left.lineNo - right.lineNo)
            .map((line) => ({
                accountId: line.accountId,
                direction: line.direction === 'debit' ? 'credit' : 'debit',
                amountMinor: line.amountMinor,
            }));

        return postJournalInTransaction(tx, {
            tenantId,
            currency: original.currency,
            idempotencyKey,
            reference: `reversal:${original.id}`,
            description: reason,
            lines,
            journalType: 'reversal',
            reversalOfJournalId: original.id,
            createdAt: input.createdAt,
        });
    });
}

export interface CashReceiptInput {
    readonly tenantId: string;
    readonly idempotencyKey: string;
    readonly currency: string;
    readonly amountMinor: unknown;
    readonly cashAccountId: string;
    readonly clearingAccountId: string;
    readonly reference?: string | null;
    readonly description?: string | null;
    readonly createdAt?: string;
}

/**
 * Record a physical cash receipt in the separate, non-withdrawable clearing
 * account. It must never credit `merchant_available` or `merchant_pending`.
 */
export async function postCashReceipt<Tx extends LedgerTransaction>(
    store: LedgerStore<Tx>,
    input: CashReceiptInput,
): Promise<PostJournalResult> {
    const tenantId = requireBoundedString(input.tenantId, 'tenantId', MAX_TENANT_ID_LENGTH, 'invalid_tenant');
    const currency = requireCurrency(input.currency);
    const amountMinor = normalizeAmountMinor(input.amountMinor);
    const cashAccountId = requireBoundedString(
        input.cashAccountId,
        'cashAccountId',
        MAX_ACCOUNT_ID_LENGTH,
        'invalid_account_id',
    );
    const clearingAccountId = requireBoundedString(
        input.clearingAccountId,
        'clearingAccountId',
        MAX_ACCOUNT_ID_LENGTH,
        'invalid_account_id',
    );

    return store.runAtomic(async (tx) => {
        const cashAccount = await tx.getAccount(tenantId, cashAccountId);
        if (cashAccount === null) fail('account_not_found', 'cash account was not found');
        if (cashAccount.tenantId !== tenantId) fail('tenant_mismatch', 'cash account belongs to another tenant');
        if (cashAccount.kind !== 'platform_cash') fail('account_kind_mismatch', 'cash account must be platform_cash');

        const clearingAccount = await tx.getAccount(tenantId, clearingAccountId);
        if (clearingAccount === null) fail('account_not_found', 'clearing account was not found');
        if (clearingAccount.tenantId !== tenantId) {
            fail('tenant_mismatch', 'clearing account belongs to another tenant');
        }
        if (clearingAccount.kind !== 'cash_receipt_clearing') {
            fail('account_kind_mismatch', 'clearing account must be cash_receipt_clearing');
        }

        return postJournalInTransaction(tx, {
            tenantId,
            currency,
            idempotencyKey: input.idempotencyKey,
            reference: input.reference,
            description: input.description,
            createdAt: input.createdAt,
            lines: [
                { accountId: cashAccountId, direction: 'debit', amountMinor },
                { accountId: clearingAccountId, direction: 'credit', amountMinor },
            ],
        });
    });
}
