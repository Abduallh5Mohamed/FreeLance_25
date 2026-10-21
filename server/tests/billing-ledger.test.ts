import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import {
    ACCOUNT_NORMAL_SIDE,
    AccountKind,
    InsertJournalInput,
    InsertJournalResult,
    JournalRecord,
    LedgerAccount,
    LedgerError,
    LedgerStore,
    LedgerTransaction,
    MAX_AMOUNT_MINOR,
    normalizeAmountMinor,
    postCashReceipt,
    postJournal,
    postJournalInTransaction,
    reverseJournal,
    serializeMoneyMinor,
} from '../src/services/billing-ledger';

/**
 * In-memory ledger store for the contract tests. It is NOT SQL evidence and
 * does not pretend to be: `runAtomic` executes the callback and records an
 * undo log, which is discarded on throw. `insertJournal` CASes every expected
 * account version before applying any write, and applies the idempotency key,
 * journal, lines and balances as one unit.
 */

interface IdempotencyEntry {
    readonly payloadHash: string;
    readonly journalId: string;
}

class TestLedgerTx implements LedgerTransaction {
    private readonly undo: Array<() => void> = [];

    constructor(private readonly store: TestLedgerStore) {}

    rollback(): void {
        for (let index = this.undo.length - 1; index >= 0; index -= 1) {
            const action = this.undo[index];
            action();
        }
        this.undo.length = 0;
    }

    async getAccount(tenantId: string, accountId: string): Promise<LedgerAccount | null> {
        this.store.accountReads.push(accountId);
        const account = this.store.accounts.get(accountId);
        return account ?? null;
    }

    async findJournalByIdempotencyKey(tenantId: string, idempotencyKey: string): Promise<JournalRecord | null> {
        const entry = this.store.idempotency.get(idempotencyMapKey(tenantId, idempotencyKey));
        if (entry === undefined) return null;
        return this.store.journals.get(entry.journalId) ?? null;
    }

    async getJournal(tenantId: string, journalId: string): Promise<JournalRecord | null> {
        const journal = this.store.journals.get(journalId);
        if (journal === undefined || journal.tenantId !== tenantId) return null;
        return journal;
    }

    async findReversalOf(tenantId: string, journalId: string): Promise<JournalRecord | null> {
        const reversalId = this.store.reversals.get(reversalMapKey(tenantId, journalId));
        if (reversalId === undefined) return null;
        return this.store.journals.get(reversalId) ?? null;
    }

    async insertJournal(input: InsertJournalInput): Promise<InsertJournalResult> {
        const store = this.store;
        const key = idempotencyMapKey(input.journal.tenantId, input.idempotencyKey);
        const existing = store.idempotency.get(key);
        if (existing !== undefined) {
            const journal = store.journals.get(existing.journalId);
            if (journal === undefined) throw new Error('test store: idempotency target missing');
            if (existing.payloadHash !== input.payloadHash) {
                return { ok: false, reason: 'idempotency_conflict' };
            }
            return { ok: false, reason: 'idempotent_replay', journal };
        }

        store.balanceChangeOrders.push(input.balanceChanges.map((change) => change.accountId));

        for (const change of input.balanceChanges) {
            const account = store.accounts.get(change.accountId);
            if (account === undefined || account.version !== change.expectedVersion) {
                return { ok: false, reason: 'account_version_conflict', accountId: change.accountId };
            }
        }

        if (input.journal.reversalOfJournalId !== null) {
            const reversalKey = reversalMapKey(input.journal.tenantId, input.journal.reversalOfJournalId);
            if (store.reversals.has(reversalKey)) {
                throw new Error('test store: duplicate reversal reached storage');
            }
        }

        for (const change of input.balanceChanges) {
            const before = store.accounts.get(change.accountId);
            if (before === undefined) throw new Error('test store: account missing during apply');
            store.accounts.set(change.accountId, {
                ...before,
                balanceMinor: change.newBalanceMinor,
                version: change.newVersion,
            });
            this.undo.push(() => store.accounts.set(change.accountId, before));
        }

        const journal: JournalRecord = {
            id: input.journal.id,
            tenantId: input.journal.tenantId,
            currency: input.journal.currency,
            journalType: input.journal.journalType,
            reversalOfJournalId: input.journal.reversalOfJournalId,
            reference: input.journal.reference,
            description: input.journal.description,
            idempotencyKey: input.idempotencyKey,
            payloadHash: input.payloadHash,
            createdAt: input.journal.createdAt,
            lines: input.lines,
        };

        store.journals.set(journal.id, journal);
        this.undo.push(() => store.journals.delete(journal.id));

        store.idempotency.set(key, { payloadHash: input.payloadHash, journalId: journal.id });
        this.undo.push(() => store.idempotency.delete(key));

        if (journal.reversalOfJournalId !== null) {
            const reversalKey = reversalMapKey(journal.tenantId, journal.reversalOfJournalId);
            store.reversals.set(reversalKey, journal.id);
            this.undo.push(() => store.reversals.delete(reversalKey));
        }

        return { ok: true, journal };
    }
}

function idempotencyMapKey(tenantId: string, key: string): string {
    return `${tenantId}\u0000${key}`;
}

function reversalMapKey(tenantId: string, journalId: string): string {
    return `${tenantId}\u0000${journalId}`;
}

class TestLedgerStore implements LedgerStore {
    readonly accounts = new Map<string, LedgerAccount>();
    readonly journals = new Map<string, JournalRecord>();
    readonly idempotency = new Map<string, IdempotencyEntry>();
    readonly reversals = new Map<string, string>();
    readonly accountReads: string[] = [];
    readonly balanceChangeOrders: string[][] = [];

    seedAccount(input: {
        id: string;
        tenantId: string;
        kind: AccountKind;
        currency: string;
        balanceMinor: bigint;
        version?: number;
    }): void {
        this.accounts.set(input.id, {
            id: input.id,
            tenantId: input.tenantId,
            kind: input.kind,
            normalSide: ACCOUNT_NORMAL_SIDE[input.kind],
            currency: input.currency,
            balanceMinor: input.balanceMinor,
            version: input.version ?? 0,
        });
    }

    account(id: string): LedgerAccount | undefined {
        return this.accounts.get(id);
    }

    journalList(): JournalRecord[] {
        return Array.from(this.journals.values());
    }

    async runAtomic<T>(callback: (tx: LedgerTransaction) => Promise<T>): Promise<T> {
        const tx = new TestLedgerTx(this);
        try {
            return await callback(tx);
        } catch (error) {
            tx.rollback();
            throw error;
        }
    }
}

const TENANT_A = 'tenant-a';
const TENANT_B = 'tenant-b';
const EGP = 'EGP';

function seed(
    store: TestLedgerStore,
    tenantId: string,
    kind: AccountKind,
    balanceMinor: bigint,
    currency = EGP,
): string {
    const id = `${tenantId}:${kind}:${currency}`;
    store.seedAccount({ id, tenantId, kind, currency, balanceMinor });
    return id;
}

function balanceOf(store: TestLedgerStore, id: string): bigint {
    const account = store.account(id);
    assert.ok(account !== undefined, `account ${id} must exist`);
    return account.balanceMinor;
}

function isLedgerError(code: string): (error: unknown) => boolean {
    return (error: unknown): boolean => error instanceof LedgerError && error.code === code;
}

function moneySafeJson(value: unknown): string {
    return JSON.stringify(value, (_key: string, entry: unknown) => (
        typeof entry === 'bigint' ? entry.toString() : entry
    ));
}

test('unbalanced journal is rejected without writing', async () => {
    const store = new TestLedgerStore();
    const cash = seed(store, TENANT_A, 'platform_cash', 0n);
    const available = seed(store, TENANT_A, 'merchant_available', 1000n);

    await assert.rejects(
        postJournal(store, {
            tenantId: TENANT_A,
            currency: EGP,
            idempotencyKey: 'unbalanced-1',
            lines: [
                { accountId: cash, direction: 'debit', amountMinor: 100n },
                { accountId: available, direction: 'credit', amountMinor: 99n },
            ],
        }),
        isLedgerError('unbalanced_journal'),
    );

    assert.equal(store.journals.size, 0);
    assert.equal(store.idempotency.size, 0);
    assert.equal(balanceOf(store, cash), 0n);
    assert.equal(balanceOf(store, available), 1000n);
});

test('balanced journal posts exact BigInt amounts and serializes money as strings', async () => {
    const store = new TestLedgerStore();
    const cash = seed(store, TENANT_A, 'platform_cash', 0n);
    const available = seed(store, TENANT_A, 'merchant_available', 1000n);

    const result = await postJournal(store, {
        tenantId: TENANT_A,
        currency: EGP,
        idempotencyKey: 'balanced-1',
        reference: 'student receipt',
        lines: [
            { accountId: cash, direction: 'debit', amountMinor: 250n },
            { accountId: available, direction: 'credit', amountMinor: 250n },
        ],
    });

    assert.equal(result.replayed, false);
    assert.equal(result.journal.lines.length, 2);
    assert.equal(typeof result.journal.lines[0].amountMinor, 'bigint');
    assert.equal(serializeMoneyMinor(result.journal.lines[0].amountMinor), '250');
    assert.equal(balanceOf(store, cash), 250n);
    assert.equal(balanceOf(store, available), 1250n);
});

test('journals are balanced per currency and mixed-currency lines are rejected', async () => {
    const store = new TestLedgerStore();
    const egpCash = seed(store, TENANT_A, 'platform_cash', 0n, EGP);
    const egpAvailable = seed(store, TENANT_A, 'merchant_available', 0n, EGP);
    const eurCash = seed(store, TENANT_A, 'platform_cash', 0n, 'EUR');
    const eurAvailable = seed(store, TENANT_A, 'merchant_available', 0n, 'EUR');

    await assert.rejects(
        postJournal(store, {
            tenantId: TENANT_A,
            currency: EGP,
            idempotencyKey: 'mixed-currency-1',
            lines: [
                { accountId: egpCash, direction: 'debit', amountMinor: 100n },
                { accountId: eurAvailable, direction: 'credit', amountMinor: 100n },
            ],
        }),
        isLedgerError('currency_mismatch'),
    );
    assert.equal(store.journals.size, 0);

    const egp = await postJournal(store, {
        tenantId: TENANT_A,
        currency: EGP,
        idempotencyKey: 'egp-1',
        lines: [
            { accountId: egpCash, direction: 'debit', amountMinor: 100n },
            { accountId: egpAvailable, direction: 'credit', amountMinor: 100n },
        ],
    });
    const eur = await postJournal(store, {
        tenantId: TENANT_A,
        currency: 'EUR',
        idempotencyKey: 'eur-1',
        lines: [
            { accountId: eurCash, direction: 'debit', amountMinor: 700n },
            { accountId: eurAvailable, direction: 'credit', amountMinor: 700n },
        ],
    });

    assert.equal(egp.journal.currency, 'EGP');
    assert.equal(eur.journal.currency, 'EUR');
    assert.equal(balanceOf(store, egpCash), 100n);
    assert.equal(balanceOf(store, eurCash), 700n);
    assert.equal(balanceOf(store, egpAvailable), 100n);
    assert.equal(balanceOf(store, eurAvailable), 700n);
});

test('idempotent replay returns the same journal; a different payload conflicts', async () => {
    const store = new TestLedgerStore();
    const cash = seed(store, TENANT_A, 'platform_cash', 0n);
    const pending = seed(store, TENANT_A, 'merchant_pending', 0n);

    const input = {
        tenantId: TENANT_A,
        currency: EGP,
        idempotencyKey: 'receipt-stable-1',
        reference: 'same payload',
        lines: [
            { accountId: cash, direction: 'debit' as const, amountMinor: 500n },
            { accountId: pending, direction: 'credit' as const, amountMinor: 500n },
        ],
    };

    const first = await postJournal(store, input);
    const replay = await postJournal(store, input);

    assert.equal(replay.replayed, true);
    assert.equal(replay.journal.id, first.journal.id);
    assert.equal(store.journals.size, 1);
    assert.equal(balanceOf(store, cash), 500n);
    assert.equal(balanceOf(store, pending), 500n);

    await assert.rejects(
        postJournal(store, {
            ...input,
            lines: [
                { accountId: cash, direction: 'debit', amountMinor: 501n },
                { accountId: pending, direction: 'credit', amountMinor: 501n },
            ],
        }),
        isLedgerError('idempotency_conflict'),
    );

    assert.equal(store.journals.size, 1);
    assert.equal(balanceOf(store, cash), 500n);
    assert.equal(balanceOf(store, pending), 500n);
});

test('reversal restores balances without editing the original journal', async () => {
    const store = new TestLedgerStore();
    const pending = seed(store, TENANT_A, 'merchant_pending', 1000n);
    const available = seed(store, TENANT_A, 'merchant_available', 0n);

    const settlement = await postJournal(store, {
        tenantId: TENANT_A,
        currency: EGP,
        idempotencyKey: 'settlement-1',
        lines: [
            { accountId: pending, direction: 'debit', amountMinor: 400n },
            { accountId: available, direction: 'credit', amountMinor: 400n },
        ],
    });
    const originalSnapshot = moneySafeJson(store.journalList()[0]);

    assert.equal(balanceOf(store, pending), 600n);
    assert.equal(balanceOf(store, available), 400n);

    const reversal = await reverseJournal(store, {
        tenantId: TENANT_A,
        journalId: settlement.journal.id,
        idempotencyKey: 'settlement-1-reversal',
        reason: 'correction',
        createdAt: '2026-10-21T10:00:00.000Z',
    });

    assert.equal(reversal.journal.journalType, 'reversal');
    assert.equal(reversal.journal.reversalOfJournalId, settlement.journal.id);
    assert.equal(balanceOf(store, pending), 1000n);
    assert.equal(balanceOf(store, available), 0n);
    assert.equal(store.journals.size, 2);

    const originalAfter = store.journals.get(settlement.journal.id);
    assert.ok(originalAfter !== undefined);
    assert.equal(moneySafeJson(originalAfter), originalSnapshot);

    const swapped = reversal.journal.lines.map((line) => ({
        accountId: line.accountId,
        direction: line.direction,
        amountMinor: line.amountMinor,
    }));
    assert.deepEqual(swapped, [
        { accountId: pending, direction: 'credit', amountMinor: 400n },
        { accountId: available, direction: 'debit', amountMinor: 400n },
    ]);

    await assert.rejects(
        reverseJournal(store, {
            tenantId: TENANT_A,
            journalId: settlement.journal.id,
            idempotencyKey: 'settlement-1-reversal-second',
            reason: 'second correction',
        }),
        isLedgerError('already_reversed'),
    );
    assert.equal(store.journals.size, 2);
});

test('subscription_credit can never become withdrawable merchant money', async () => {
    const store = new TestLedgerStore();
    const cash = seed(store, TENANT_A, 'platform_cash', 0n);
    const credit = seed(store, TENANT_A, 'subscription_credit', 0n);
    const available = seed(store, TENANT_A, 'merchant_available', 500n);

    const issued = await postJournal(store, {
        tenantId: TENANT_A,
        currency: EGP,
        idempotencyKey: 'credit-issued-1',
        lines: [
            { accountId: cash, direction: 'debit', amountMinor: 200n },
            { accountId: credit, direction: 'credit', amountMinor: 200n },
        ],
    });
    assert.equal(issued.journal.lines.length, 2);
    assert.equal(balanceOf(store, credit), 200n);
    assert.equal(balanceOf(store, available), 500n);

    await assert.rejects(
        postJournal(store, {
            tenantId: TENANT_A,
            currency: EGP,
            idempotencyKey: 'credit-to-wallet-1',
            lines: [
                { accountId: credit, direction: 'debit', amountMinor: 100n },
                { accountId: available, direction: 'credit', amountMinor: 100n },
            ],
        }),
        isLedgerError('credit_not_withdrawable'),
    );

    assert.equal(balanceOf(store, credit), 200n);
    assert.equal(balanceOf(store, available), 500n);
    assert.equal(store.journals.size, 1);
});

test('a cash receipt leaves merchant_available unchanged', async () => {
    const store = new TestLedgerStore();
    const cash = seed(store, TENANT_A, 'platform_cash', 0n);
    const clearing = seed(store, TENANT_A, 'cash_receipt_clearing', 0n);
    const available = seed(store, TENANT_A, 'merchant_available', 1000n);

    const receipt = await postCashReceipt(store, {
        tenantId: TENANT_A,
        idempotencyKey: 'cash-receipt-1',
        currency: EGP,
        amountMinor: 300n,
        cashAccountId: cash,
        clearingAccountId: clearing,
        reference: 'cash receipt 1',
    });

    assert.equal(receipt.journal.lines[0].direction, 'debit');
    assert.equal(receipt.journal.lines[1].direction, 'credit');
    assert.equal(balanceOf(store, cash), 300n);
    assert.equal(balanceOf(store, clearing), 300n);
    assert.equal(balanceOf(store, available), 1000n);

    await assert.rejects(
        postJournal(store, {
            tenantId: TENANT_A,
            currency: EGP,
            idempotencyKey: 'cash-to-wallet-1',
            lines: [
                { accountId: clearing, direction: 'debit', amountMinor: 50n },
                { accountId: available, direction: 'credit', amountMinor: 50n },
            ],
        }),
        isLedgerError('cash_receipt_not_available'),
    );
    assert.equal(balanceOf(store, available), 1000n);
});

test('an account of another tenant is rejected and never auto-created', async () => {
    const store = new TestLedgerStore();
    const cash = seed(store, TENANT_A, 'platform_cash', 0n);
    const foreignAvailable = seed(store, TENANT_B, 'merchant_available', 1000n);

    await assert.rejects(
        postJournal(store, {
            tenantId: TENANT_A,
            currency: EGP,
            idempotencyKey: 'tenant-mismatch-1',
            lines: [
                { accountId: cash, direction: 'debit', amountMinor: 100n },
                { accountId: foreignAvailable, direction: 'credit', amountMinor: 100n },
            ],
        }),
        isLedgerError('tenant_mismatch'),
    );
    assert.equal(store.journals.size, 0);
    assert.equal(store.accounts.size, 2);
    assert.equal(balanceOf(store, foreignAvailable), 1000n);

    await assert.rejects(
        postJournal(store, {
            tenantId: TENANT_A,
            currency: EGP,
            idempotencyKey: 'tenant-missing-1',
            lines: [
                { accountId: cash, direction: 'debit', amountMinor: 100n },
                { accountId: 'tenant-a:no-such-account', direction: 'credit', amountMinor: 100n },
            ],
        }),
        isLedgerError('account_not_found'),
    );
    assert.equal(store.accounts.size, 2);
});

test('BigInt bounds: zero, negative, over-max and non-integers are rejected', async () => {
    const store = new TestLedgerStore();
    const cash = seed(store, TENANT_A, 'platform_cash', 0n);
    const available = seed(store, TENANT_A, 'merchant_available', 0n);

    assert.equal(normalizeAmountMinor(MAX_AMOUNT_MINOR), MAX_AMOUNT_MINOR);
    assert.throws(() => normalizeAmountMinor(0n), isLedgerError('invalid_amount'));
    assert.throws(() => normalizeAmountMinor(-1n), isLedgerError('invalid_amount'));
    assert.throws(() => normalizeAmountMinor(MAX_AMOUNT_MINOR + 1n), isLedgerError('amount_out_of_range'));
    assert.throws(() => normalizeAmountMinor(1.5), isLedgerError('invalid_amount'));
    assert.throws(() => normalizeAmountMinor('100'), isLedgerError('invalid_amount'));
    assert.throws(() => normalizeAmountMinor(null), isLedgerError('invalid_amount'));

    for (const amount of [0n, -5n, MAX_AMOUNT_MINOR + 1n, 1.5, '100']) {
        await assert.rejects(
            postJournal(store, {
                tenantId: TENANT_A,
                currency: EGP,
                idempotencyKey: `bounds-${String(amount)}`,
                lines: [
                    { accountId: cash, direction: 'debit', amountMinor: amount },
                    { accountId: available, direction: 'credit', amountMinor: amount },
                ],
            }),
            (error: unknown): boolean => error instanceof LedgerError,
        );
    }

    assert.equal(store.journals.size, 0);
    assert.equal(balanceOf(store, cash), 0n);
    assert.equal(balanceOf(store, available), 0n);
});

test('a journal can be reversed only once, including through a direct reversal posting', async () => {
    const store = new TestLedgerStore();
    const pending = seed(store, TENANT_A, 'merchant_pending', 1000n);
    const available = seed(store, TENANT_A, 'merchant_available', 0n);

    const settlement = await postJournal(store, {
        tenantId: TENANT_A,
        currency: EGP,
        idempotencyKey: 'one-reversal-settlement',
        lines: [
            { accountId: pending, direction: 'debit', amountMinor: 400n },
            { accountId: available, direction: 'credit', amountMinor: 400n },
        ],
    });

    await reverseJournal(store, {
        tenantId: TENANT_A,
        journalId: settlement.journal.id,
        idempotencyKey: 'one-reversal-first',
        reason: 'first correction',
    });

    await assert.rejects(
        postJournal(store, {
            tenantId: TENANT_A,
            currency: EGP,
            idempotencyKey: 'one-reversal-second-direct',
            journalType: 'reversal',
            reversalOfJournalId: settlement.journal.id,
            lines: [
                { accountId: pending, direction: 'credit', amountMinor: 400n },
                { accountId: available, direction: 'debit', amountMinor: 400n },
            ],
        }),
        isLedgerError('already_reversed'),
    );

    assert.equal(store.journals.size, 2);
    assert.equal(balanceOf(store, pending), 1000n);
    assert.equal(balanceOf(store, available), 0n);
});

test('subscription_credit cannot be moved into any merchant wallet by any posting path', async () => {
    const store = new TestLedgerStore();
    const cash = seed(store, TENANT_A, 'platform_cash', 0n);
    const credit = seed(store, TENANT_A, 'subscription_credit', 0n);
    const pending = seed(store, TENANT_A, 'merchant_pending', 100n);
    const available = seed(store, TENANT_A, 'merchant_available', 200n);
    const reserved = seed(store, TENANT_A, 'merchant_reserved', 300n);

    const issued = await postJournal(store, {
        tenantId: TENANT_A,
        currency: EGP,
        idempotencyKey: 'credit-path-issued',
        lines: [
            { accountId: cash, direction: 'debit', amountMinor: 900n },
            { accountId: credit, direction: 'credit', amountMinor: 900n },
        ],
    });

    for (const [index, merchant] of [pending, available, reserved].entries()) {
        await assert.rejects(
            postJournal(store, {
                tenantId: TENANT_A,
                currency: EGP,
                idempotencyKey: `credit-path-to-merchant-${index}`,
                lines: [
                    { accountId: credit, direction: 'debit', amountMinor: 50n },
                    { accountId: merchant, direction: 'credit', amountMinor: 50n },
                ],
            }),
            isLedgerError('credit_not_withdrawable'),
        );
    }

    await assert.rejects(
        postJournal(store, {
            tenantId: TENANT_A,
            currency: EGP,
            idempotencyKey: 'credit-path-reversal-to-merchant',
            journalType: 'reversal',
            reversalOfJournalId: issued.journal.id,
            lines: [
                { accountId: credit, direction: 'debit', amountMinor: 900n },
                { accountId: available, direction: 'credit', amountMinor: 900n },
            ],
        }),
        (error: unknown): boolean => error instanceof LedgerError,
    );

    await reverseJournal(store, {
        tenantId: TENANT_A,
        journalId: issued.journal.id,
        idempotencyKey: 'credit-path-issued-reversal',
        reason: 'return issued credit',
    });

    assert.equal(balanceOf(store, cash), 0n);
    assert.equal(balanceOf(store, credit), 0n);
    assert.equal(balanceOf(store, pending), 100n);
    assert.equal(balanceOf(store, available), 200n);
    assert.equal(balanceOf(store, reserved), 300n);
});

test('the legacy instructor service-credit module is never mapped into the ledger', () => {
    const ledgerSource = readFileSync(join(__dirname, '..', 'src', 'services', 'billing-ledger.ts'), 'utf8');
    const reservationSource = readFileSync(
        join(__dirname, '..', 'src', 'services', 'billing-reservations.ts'),
        'utf8',
    );

    for (const source of [ledgerSource, reservationSource]) {
        assert.doesNotMatch(source, /from\s+['"]\.\/service-credit['"]/);
        assert.doesNotMatch(source, /instructor_wallets?/);
        assert.doesNotMatch(source, /instructor_wallet_transactions/);
    }
});

test('rollback discards a journal, its lines and its idempotency row written before a later failure', async () => {
    const store = new TestLedgerStore();
    const cash = seed(store, TENANT_A, 'platform_cash', 0n);
    const pending = seed(store, TENANT_A, 'merchant_pending', 0n);

    await assert.rejects(
        store.runAtomic(async (tx) => {
            await postJournalInTransaction(tx, {
                tenantId: TENANT_A,
                currency: EGP,
                idempotencyKey: 'rollback-after-write',
                lines: [
                    { accountId: cash, direction: 'debit', amountMinor: 700n },
                    { accountId: pending, direction: 'credit', amountMinor: 700n },
                ],
            });
            throw new Error('failure after the journal was staged');
        }),
        /failure after the journal was staged/,
    );

    assert.equal(store.journals.size, 0);
    assert.equal(store.journalList().flatMap((journal) => journal.lines).length, 0);
    assert.equal(store.idempotency.size, 0);
    assert.equal(balanceOf(store, cash), 0n);
    assert.equal(balanceOf(store, pending), 0n);
});

test('identifier lengths follow the CHAR(36) contract bound', async () => {
    const store = new TestLedgerStore();
    const cash = seed(store, TENANT_A, 'platform_cash', 0n);
    const available = seed(store, TENANT_A, 'merchant_available', 0n);

    await assert.rejects(
        postJournal(store, {
            tenantId: 't'.repeat(37),
            currency: EGP,
            idempotencyKey: 'identifier-tenant-37',
            lines: [
                { accountId: cash, direction: 'debit', amountMinor: 1n },
                { accountId: available, direction: 'credit', amountMinor: 1n },
            ],
        }),
        isLedgerError('invalid_tenant'),
    );

    await assert.rejects(
        postJournal(store, {
            tenantId: TENANT_A,
            currency: EGP,
            idempotencyKey: 'identifier-account-37',
            lines: [
                { accountId: 'a'.repeat(37), direction: 'debit', amountMinor: 1n },
                { accountId: available, direction: 'credit', amountMinor: 1n },
            ],
        }),
        isLedgerError('invalid_account_id'),
    );

    assert.equal(store.journals.size, 0);
});

test('lock order: touched accounts are read and CASed in ascending account id order', async () => {
    const store = new TestLedgerStore();
    store.seedAccount({
        id: 'acct-c',
        tenantId: TENANT_A,
        kind: 'platform_cash',
        currency: EGP,
        balanceMinor: 0n,
    });
    store.seedAccount({
        id: 'acct-a',
        tenantId: TENANT_A,
        kind: 'merchant_pending',
        currency: EGP,
        balanceMinor: 1000n,
    });
    store.seedAccount({
        id: 'acct-b',
        tenantId: TENANT_A,
        kind: 'merchant_available',
        currency: EGP,
        balanceMinor: 0n,
    });

    await postJournal(store, {
        tenantId: TENANT_A,
        currency: EGP,
        idempotencyKey: 'lock-order-1',
        lines: [
            { accountId: 'acct-c', direction: 'debit', amountMinor: 20n },
            { accountId: 'acct-a', direction: 'debit', amountMinor: 10n },
            { accountId: 'acct-b', direction: 'credit', amountMinor: 30n },
        ],
    });

    assert.deepEqual(store.accountReads, ['acct-a', 'acct-b', 'acct-c']);
    assert.deepEqual(store.balanceChangeOrders, [['acct-a', 'acct-b', 'acct-c']]);
});
