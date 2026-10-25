import assert from 'node:assert/strict';
import test from 'node:test';
import {
    ACCOUNT_NORMAL_SIDE,
    AccountKind,
    InsertJournalInput,
    InsertJournalResult,
    JournalRecord,
    LedgerAccount,
    LedgerTransaction,
    MAX_AMOUNT_MINOR,
    reverseJournal,
    serializeMoneyMinor,
} from '../src/services/billing-ledger';
import {
    ConsumeReservationInput,
    InsertReservationResult,
    ReleaseReservationInput,
    ReservationEventInput,
    ReservationRecord,
    ReservationStore,
    ReservationTransaction,
    ReserveFundsInput,
    UpdateReservationInput,
    UpdateReservationResult,
    consumeReservation,
    releaseReservation,
    reserveFunds,
} from '../src/services/billing-reservations';

/**
 * In-memory reservation ledger for the contract tests. It is NOT SQL evidence:
 * `runAtomic` executes the callback with a per-transaction undo log that is
 * discarded on throw. Account-version CAS and reservation-version CAS are
 * checked before writes, so a concurrent reserve either posts or fails without
 * leaving a partial journal. The store is shared across concurrent calls so
 * the interleaving test is real code interleaving, not a mock story.
 */

interface JournalIdempotencyEntry {
    readonly payloadHash: string;
    readonly journalId: string;
}

class TestReservationTx implements ReservationTransaction {
    private readonly undo: Array<() => void> = [];

    constructor(private readonly store: TestReservationStore) {}

    rollback(): void {
        for (let index = this.undo.length - 1; index >= 0; index -= 1) {
            const action = this.undo[index];
            action();
        }
        this.undo.length = 0;
    }

    async getAccount(tenantId: string, accountId: string): Promise<LedgerAccount | null> {
        return this.store.accounts.get(accountId) ?? null;
    }

    async findJournalByIdempotencyKey(tenantId: string, idempotencyKey: string): Promise<JournalRecord | null> {
        const entry = this.store.journalIdempotency.get(mapKey(tenantId, idempotencyKey));
        if (entry === undefined) return null;
        return this.store.journals.get(entry.journalId) ?? null;
    }

    async getJournal(tenantId: string, journalId: string): Promise<JournalRecord | null> {
        const journal = this.store.journals.get(journalId);
        if (journal === undefined || journal.tenantId !== tenantId) return null;
        return journal;
    }

    async findReversalOf(tenantId: string, journalId: string): Promise<JournalRecord | null> {
        const reversalId = this.store.reversals.get(mapKey(tenantId, journalId));
        if (reversalId === undefined) return null;
        return this.store.journals.get(reversalId) ?? null;
    }

    async insertJournal(input: InsertJournalInput): Promise<InsertJournalResult> {
        const store = this.store;
        const key = mapKey(input.journal.tenantId, input.idempotencyKey);
        const existing = store.journalIdempotency.get(key);
        if (existing !== undefined) {
            const journal = store.journals.get(existing.journalId);
            if (journal === undefined) throw new Error('test store: idempotency target missing');
            if (existing.payloadHash !== input.payloadHash) {
                return { ok: false, reason: 'idempotency_conflict' };
            }
            return { ok: false, reason: 'idempotent_replay', journal };
        }

        await this.store.beforeInsertJournal();

        for (const change of input.balanceChanges) {
            const account = store.accounts.get(change.accountId);
            if (account === undefined || account.version !== change.expectedVersion) {
                return { ok: false, reason: 'account_version_conflict', accountId: change.accountId };
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

        store.journalIdempotency.set(key, { payloadHash: input.payloadHash, journalId: journal.id });
        this.undo.push(() => store.journalIdempotency.delete(key));

        if (journal.reversalOfJournalId !== null) {
            const reversalKey = mapKey(journal.tenantId, journal.reversalOfJournalId);
            store.reversals.set(reversalKey, journal.id);
            this.undo.push(() => store.reversals.delete(reversalKey));
        }

        return { ok: true, journal };
    }

    async findReservationByKey(tenantId: string, reservationKey: string): Promise<ReservationRecord | null> {
        const id = this.store.reservationKeys.get(mapKey(tenantId, reservationKey));
        if (id === undefined) return null;
        return this.store.reservations.get(id) ?? null;
    }

    async getReservation(tenantId: string, reservationId: string): Promise<ReservationRecord | null> {
        const reservation = this.store.reservations.get(reservationId);
        if (reservation === undefined || reservation.tenantId !== tenantId) return null;
        return reservation;
    }

    async insertReservation(reservation: ReservationRecord): Promise<InsertReservationResult> {
        const store = this.store;
        const key = mapKey(reservation.tenantId, reservation.reservationKey);
        if (store.reservationKeys.has(key)) return { ok: false, reason: 'duplicate_key' };

        store.reservations.set(reservation.id, reservation);
        store.reservationKeys.set(key, reservation.id);
        this.undo.push(() => {
            store.reservations.delete(reservation.id);
            store.reservationKeys.delete(key);
        });
        return { ok: true, reservation };
    }

    async updateReservation(input: UpdateReservationInput): Promise<UpdateReservationResult> {
        const store = this.store;
        const current = store.reservations.get(input.reservationId);
        if (current === undefined || current.tenantId !== input.tenantId) {
            return { ok: false, reason: 'not_found' };
        }
        if (current.version !== input.expectedVersion) {
            return { ok: false, reason: 'version_conflict' };
        }
        if (current.status !== 'reserved') {
            return { ok: false, reason: 'invalid_status' };
        }

        const next: ReservationRecord = {
            ...current,
            status: input.status,
            version: current.version + 1,
            releaseJournalId: input.releaseJournalId,
            consumeJournalId: input.consumeJournalId,
            consumeCounterAccountId: input.consumeCounterAccountId,
            updatedAt: input.updatedAt,
        };
        store.reservations.set(next.id, next);
        this.undo.push(() => store.reservations.set(current.id, current));
        return { ok: true, reservation: next };
    }

    async insertReservationEvent(event: ReservationEventInput): Promise<void> {
        if (this.store.failOnEvent) throw new Error('test store: injected event failure');
        this.store.events.push(event);
        this.undo.push(() => {
            this.store.events.pop();
        });
    }
}

function mapKey(tenantId: string, key: string): string {
    return `${tenantId}\u0000${key}`;
}

class TestReservationStore implements ReservationStore {
    readonly accounts = new Map<string, LedgerAccount>();
    readonly journals = new Map<string, JournalRecord>();
    readonly journalIdempotency = new Map<string, JournalIdempotencyEntry>();
    readonly reversals = new Map<string, string>();
    readonly reservations = new Map<string, ReservationRecord>();
    readonly reservationKeys = new Map<string, string>();
    readonly events: ReservationEventInput[] = [];
    failOnEvent = false;
    private blockNextInsert = false;
    private blockedAtInsert: Promise<void> = Promise.resolve();
    private resolveBlockedAtInsert: (() => void) | null = null;
    private releaseInsert: (() => void) | null = null;
    private insertReleaseGate: Promise<void> = Promise.resolve();

    /**
     * Pause the next `insertJournal` after the domain has read the accounts
     * and before it CASes their versions. Another transaction can then commit
     * a write in between, simulating real contended interleaving without a
     * fake reimplementation of the service logic.
     */
    blockNextInsertJournal(): void {
        this.blockNextInsert = true;
        this.blockedAtInsert = new Promise((resolve) => {
            this.resolveBlockedAtInsert = resolve;
        });
        this.insertReleaseGate = new Promise((resolve) => {
            this.releaseInsert = resolve;
        });
    }

    waitForInsertBlock(): Promise<void> {
        return this.blockedAtInsert;
    }

    releaseInsertBlock(): void {
        this.releaseInsert?.();
    }

    async beforeInsertJournal(): Promise<void> {
        if (!this.blockNextInsert) return;
        this.blockNextInsert = false;
        this.resolveBlockedAtInsert?.();
        await this.insertReleaseGate;
    }

    seedAccount(input: {
        id: string;
        tenantId: string;
        kind: AccountKind;
        currency: string;
        balanceMinor: bigint;
    }): void {
        this.accounts.set(input.id, {
            id: input.id,
            tenantId: input.tenantId,
            kind: input.kind,
            normalSide: ACCOUNT_NORMAL_SIDE[input.kind],
            currency: input.currency,
            balanceMinor: input.balanceMinor,
            version: 0,
        });
    }

    account(id: string): LedgerAccount | undefined {
        return this.accounts.get(id);
    }

    async runAtomic<T>(callback: (tx: ReservationTransaction) => Promise<T>): Promise<T> {
        const tx = new TestReservationTx(this);
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
    store: TestReservationStore,
    tenantId: string,
    kind: AccountKind,
    balanceMinor: bigint,
    currency = EGP,
): string {
    const id = `${tenantId}:${kind}:${currency}`;
    store.seedAccount({ id, tenantId, kind, currency, balanceMinor });
    return id;
}

function balanceOf(store: TestReservationStore, id: string): bigint {
    const account = store.account(id);
    assert.ok(account !== undefined, `account ${id} must exist`);
    return account.balanceMinor;
}

function isReservationError(code: string): (error: unknown) => boolean {
    return (error: unknown): boolean => {
        if (typeof error !== 'object' || error === null || !('code' in error)) return false;
        return (error as { code?: unknown }).code === code;
    };
}

function moneySafeJson(value: unknown): string {
    return JSON.stringify(value, (_key: string, entry: unknown) => (
        typeof entry === 'bigint' ? entry.toString() : entry
    ));
}

function reserveInput(
    overrides: Partial<ReserveFundsInput> & {
        tenantId: string;
        reservationKey: string;
        availableAccountId: string;
        reservedAccountId: string;
    },
): ReserveFundsInput {
    return {
        currency: EGP,
        amountMinor: 2000n,
        ...overrides,
    };
}

test('reserve moves available to reserved and writes one journal and one event', async () => {
    const store = new TestReservationStore();
    const available = seed(store, TENANT_A, 'merchant_available', 5000n);
    const reserved = seed(store, TENANT_A, 'merchant_reserved', 0n);

    const result = await reserveFunds(store, reserveInput({
        tenantId: TENANT_A,
        reservationKey: 'reserve-1',
        availableAccountId: available,
        reservedAccountId: reserved,
    }));

    assert.equal(result.replayed, false);
    assert.equal(result.reservation.status, 'reserved');
    assert.equal(result.reservation.version, 1);
    assert.equal(result.reservation.amountMinor, 2000n);
    assert.equal(result.journal.lines.length, 2);
    assert.equal(result.journal.lines[0].direction, 'debit');
    assert.equal(result.journal.lines[0].accountId, available);
    assert.equal(result.journal.lines[1].direction, 'credit');
    assert.equal(result.journal.lines[1].accountId, reserved);
    assert.equal(balanceOf(store, available), 3000n);
    assert.equal(balanceOf(store, reserved), 2000n);
    assert.equal(store.journals.size, 1);
    assert.equal(store.reservations.size, 1);
    assert.equal(store.events.length, 1);
    assert.equal(store.events[0].eventType, 'reserve');
});

test('reserve replay is idempotent and a changed payload is a conflict', async () => {
    const store = new TestReservationStore();
    const available = seed(store, TENANT_A, 'merchant_available', 5000n);
    const reserved = seed(store, TENANT_A, 'merchant_reserved', 0n);

    const input = reserveInput({
        tenantId: TENANT_A,
        reservationKey: 'reserve-replay',
        availableAccountId: available,
        reservedAccountId: reserved,
    });

    const first = await reserveFunds(store, input);
    const replay = await reserveFunds(store, input);

    assert.equal(replay.replayed, true);
    assert.equal(replay.reservation.id, first.reservation.id);
    assert.equal(replay.journal.id, first.journal.id);
    assert.equal(store.journals.size, 1);
    assert.equal(store.reservations.size, 1);
    assert.equal(store.events.length, 1);

    await assert.rejects(
        reserveFunds(store, { ...input, amountMinor: 2500n }),
        isReservationError('reservation_payload_conflict'),
    );
    assert.equal(store.journals.size, 1);
    assert.equal(balanceOf(store, available), 3000n);
    assert.equal(balanceOf(store, reserved), 2000n);
});

test('release restores available and is idempotent', async () => {
    const store = new TestReservationStore();
    const available = seed(store, TENANT_A, 'merchant_available', 5000n);
    const reserved = seed(store, TENANT_A, 'merchant_reserved', 0n);

    const reservedResult = await reserveFunds(store, reserveInput({
        tenantId: TENANT_A,
        reservationKey: 'release-1',
        availableAccountId: available,
        reservedAccountId: reserved,
    }));

    const releaseInput: ReleaseReservationInput = {
        tenantId: TENANT_A,
        reservationId: reservedResult.reservation.id,
    };
    const released = await releaseReservation(store, releaseInput);

    assert.equal(released.replayed, false);
    assert.equal(released.reservation.status, 'released');
    assert.equal(released.reservation.version, 2);
    assert.equal(balanceOf(store, available), 5000n);
    assert.equal(balanceOf(store, reserved), 0n);
    assert.equal(store.journals.size, 2);
    assert.equal(store.events.length, 2);
    assert.equal(store.events[1].eventType, 'release');

    const replay = await releaseReservation(store, releaseInput);
    assert.equal(replay.replayed, true);
    assert.equal(replay.reservation.id, reservedResult.reservation.id);
    assert.equal(store.journals.size, 2);
    assert.equal(store.events.length, 2);
    assert.equal(balanceOf(store, available), 5000n);
    assert.equal(balanceOf(store, reserved), 0n);
});

test('consume spends only from reserved into a platform-side account', async () => {
    const store = new TestReservationStore();
    const available = seed(store, TENANT_A, 'merchant_available', 5000n);
    const reserved = seed(store, TENANT_A, 'merchant_reserved', 0n);
    const receivable = seed(store, TENANT_A, 'platform_receivable', 3000n);

    const reservedResult = await reserveFunds(store, reserveInput({
        tenantId: TENANT_A,
        reservationKey: 'consume-1',
        availableAccountId: available,
        reservedAccountId: reserved,
    }));

    const consumed = await consumeReservation(store, {
        tenantId: TENANT_A,
        reservationId: reservedResult.reservation.id,
        counterAccountId: receivable,
    });

    assert.equal(consumed.reservation.status, 'consumed');
    assert.equal(consumed.reservation.version, 2);
    assert.equal(consumed.reservation.consumeCounterAccountId, receivable);
    assert.equal(balanceOf(store, available), 3000n);
    assert.equal(balanceOf(store, reserved), 0n);
    assert.equal(balanceOf(store, receivable), 1000n);
    assert.equal(store.journals.size, 2);
    assert.equal(store.events.length, 2);
    assert.equal(store.events[1].eventType, 'consume');
});

test('consume rejects a released reservation and a merchant-wallet target', async () => {
    const store = new TestReservationStore();
    const available = seed(store, TENANT_A, 'merchant_available', 5000n);
    const reserved = seed(store, TENANT_A, 'merchant_reserved', 0n);

    const reservedResult = await reserveFunds(store, reserveInput({
        tenantId: TENANT_A,
        reservationKey: 'consume-state',
        availableAccountId: available,
        reservedAccountId: reserved,
    }));
    await releaseReservation(store, { tenantId: TENANT_A, reservationId: reservedResult.reservation.id });

    await assert.rejects(
        consumeReservation(store, {
            tenantId: TENANT_A,
            reservationId: reservedResult.reservation.id,
            counterAccountId: available,
        }),
        isReservationError('reservation_not_reserved'),
    );

    const second = await reserveFunds(store, reserveInput({
        tenantId: TENANT_A,
        reservationKey: 'consume-target',
        availableAccountId: available,
        reservedAccountId: reserved,
    }));
    await assert.rejects(
        consumeReservation(store, {
            tenantId: TENANT_A,
            reservationId: second.reservation.id,
            counterAccountId: available,
        }),
        isReservationError('invalid_consume_target'),
    );

    assert.equal(store.journals.size, 3);
    assert.equal(balanceOf(store, available), 3000n);
    assert.equal(balanceOf(store, reserved), 2000n);
});

test('over-reserve is rejected before any write', async () => {
    const store = new TestReservationStore();
    const available = seed(store, TENANT_A, 'merchant_available', 1000n);
    const reserved = seed(store, TENANT_A, 'merchant_reserved', 0n);

    await assert.rejects(
        reserveFunds(store, reserveInput({
            tenantId: TENANT_A,
            reservationKey: 'over-reserve',
            availableAccountId: available,
            reservedAccountId: reserved,
            amountMinor: 1001n,
        })),
        isReservationError('insufficient_available'),
    );

    assert.equal(store.journals.size, 0);
    assert.equal(store.reservations.size, 0);
    assert.equal(store.events.length, 0);
    assert.equal(balanceOf(store, available), 1000n);
    assert.equal(balanceOf(store, reserved), 0n);
});

test('two concurrent reserves of the same available: only one succeeds', async () => {
    const store = new TestReservationStore();
    const available = seed(store, TENANT_A, 'merchant_available', 5000n);
    const reserved = seed(store, TENANT_A, 'merchant_reserved', 0n);

    const first = reserveFunds(store, reserveInput({
        tenantId: TENANT_A,
        reservationKey: 'race-a',
        availableAccountId: available,
        reservedAccountId: reserved,
        amountMinor: 4000n,
    }));
    const second = reserveFunds(store, reserveInput({
        tenantId: TENANT_A,
        reservationKey: 'race-b',
        availableAccountId: available,
        reservedAccountId: reserved,
        amountMinor: 4000n,
    }));

    const outcomes = await Promise.allSettled([first, second]);
    const fulfilled = outcomes.filter((outcome) => outcome.status === 'fulfilled');
    const rejected = outcomes.filter((outcome) => outcome.status === 'rejected');

    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);
    const rejection = rejected[0];
    assert.equal(rejection.status, 'rejected');
    if (rejection.status === 'rejected') {
        const code = typeof rejection.reason === 'object' && rejection.reason !== null && 'code' in rejection.reason
            ? (rejection.reason as { code?: unknown }).code
            : undefined;
        assert.ok(
            code === 'account_version_conflict' || code === 'insufficient_available',
            `unexpected race rejection ${String(code)}`,
        );
    }

    assert.equal(store.journals.size, 1);
    assert.equal(store.reservations.size, 1);
    assert.equal(store.events.length, 1);
    assert.equal(balanceOf(store, available), 1000n);
    assert.equal(balanceOf(store, reserved), 4000n);
});

test('an interleaved write between account read and CAS lets only one reserve win', async () => {
    const store = new TestReservationStore();
    const available = seed(store, TENANT_A, 'merchant_available', 5000n);
    const reserved = seed(store, TENANT_A, 'merchant_reserved', 0n);

    store.blockNextInsertJournal();

    const first = reserveFunds(store, reserveInput({
        tenantId: TENANT_A,
        reservationKey: 'interleave-first',
        availableAccountId: available,
        reservedAccountId: reserved,
        amountMinor: 4000n,
    }));

    await store.waitForInsertBlock();

    const second = await reserveFunds(store, reserveInput({
        tenantId: TENANT_A,
        reservationKey: 'interleave-second',
        availableAccountId: available,
        reservedAccountId: reserved,
        amountMinor: 4000n,
    }));

    store.releaseInsertBlock();
    await assert.rejects(first, isReservationError('account_version_conflict'));

    assert.equal(second.replayed, false);
    assert.equal(second.reservation.status, 'reserved');
    assert.equal(store.journals.size, 1);
    assert.equal(store.journalIdempotency.size, 1);
    assert.equal(store.reservations.size, 1);
    assert.equal(store.events.length, 1);
    assert.equal(balanceOf(store, available), 1000n);
    assert.equal(balanceOf(store, reserved), 4000n);
});

test('reserve amounts are exact bigint minor units with string serialization and bounds', async () => {
    const store = new TestReservationStore();
    const available = seed(store, TENANT_A, 'merchant_available', 5000n);
    const reserved = seed(store, TENANT_A, 'merchant_reserved', 0n);

    const rejected: Array<{ amountMinor: unknown; code: string }> = [
        { amountMinor: 0n, code: 'invalid_amount' },
        { amountMinor: -1n, code: 'invalid_amount' },
        { amountMinor: MAX_AMOUNT_MINOR + 1n, code: 'amount_out_of_range' },
        { amountMinor: 1.5, code: 'invalid_amount' },
        { amountMinor: '2000', code: 'invalid_amount' },
    ];

    for (const [index, entry] of rejected.entries()) {
        await assert.rejects(
            reserveFunds(store, reserveInput({
                tenantId: TENANT_A,
                reservationKey: `amount-bounds-${index}`,
                availableAccountId: available,
                reservedAccountId: reserved,
                amountMinor: entry.amountMinor,
            })),
            isReservationError(entry.code),
        );
    }

    assert.equal(store.journals.size, 0);
    assert.equal(store.reservations.size, 0);
    assert.equal(store.events.length, 0);
    assert.equal(balanceOf(store, available), 5000n);

    const result = await reserveFunds(store, reserveInput({
        tenantId: TENANT_A,
        reservationKey: 'amount-exact',
        availableAccountId: available,
        reservedAccountId: reserved,
        amountMinor: 2000n,
    }));

    assert.equal(typeof result.reservation.amountMinor, 'bigint');
    assert.equal(serializeMoneyMinor(result.reservation.amountMinor), '2000');
    assert.equal(serializeMoneyMinor(result.journal.lines[0].amountMinor), '2000');
    assert.equal(balanceOf(store, reserved), 2000n);
});

test('double consume is rejected and does not post a second journal', async () => {
    const store = new TestReservationStore();
    const available = seed(store, TENANT_A, 'merchant_available', 5000n);
    const reserved = seed(store, TENANT_A, 'merchant_reserved', 0n);
    const receivable = seed(store, TENANT_A, 'platform_receivable', 5000n);

    const reservedResult = await reserveFunds(store, reserveInput({
        tenantId: TENANT_A,
        reservationKey: 'double-consume',
        availableAccountId: available,
        reservedAccountId: reserved,
    }));
    await consumeReservation(store, {
        tenantId: TENANT_A,
        reservationId: reservedResult.reservation.id,
        counterAccountId: receivable,
    });

    const journalsBefore = store.journals.size;
    const eventsBefore = store.events.length;
    await assert.rejects(
        consumeReservation(store, {
            tenantId: TENANT_A,
            reservationId: reservedResult.reservation.id,
            counterAccountId: receivable,
        }),
        isReservationError('already_consumed'),
    );

    assert.equal(store.journals.size, journalsBefore);
    assert.equal(store.events.length, eventsBefore);
    assert.equal(balanceOf(store, reserved), 0n);
    assert.equal(balanceOf(store, receivable), 3000n);
});

test('rollback on a later failure leaves no partial journal, reservation or balance change', async () => {
    const store = new TestReservationStore();
    const available = seed(store, TENANT_A, 'merchant_available', 5000n);
    const reserved = seed(store, TENANT_A, 'merchant_reserved', 0n);

    store.failOnEvent = true;
    await assert.rejects(
        reserveFunds(store, reserveInput({
            tenantId: TENANT_A,
            reservationKey: 'rollback-1',
            availableAccountId: available,
            reservedAccountId: reserved,
        })),
    );
    store.failOnEvent = false;

    assert.equal(store.journals.size, 0);
    assert.equal(store.journalIdempotency.size, 0);
    assert.equal(store.reservations.size, 0);
    assert.equal(store.reservationKeys.size, 0);
    assert.equal(store.events.length, 0);
    assert.equal(balanceOf(store, available), 5000n);
    assert.equal(balanceOf(store, reserved), 0n);
});

test('a reservation account of another tenant is rejected without writes', async () => {
    const store = new TestReservationStore();
    const availableA = seed(store, TENANT_A, 'merchant_available', 5000n);
    const reservedA = seed(store, TENANT_A, 'merchant_reserved', 0n);
    const availableB = seed(store, TENANT_B, 'merchant_available', 5000n);

    await assert.rejects(
        reserveFunds(store, reserveInput({
            tenantId: TENANT_A,
            reservationKey: 'tenant-mismatch',
            availableAccountId: availableB,
            reservedAccountId: reservedA,
        })),
        isReservationError('tenant_mismatch'),
    );

    assert.equal(store.journals.size, 0);
    assert.equal(store.reservations.size, 0);
    assert.equal(balanceOf(store, availableA), 5000n);
    assert.equal(balanceOf(store, availableB), 5000n);
    assert.equal(balanceOf(store, reservedA), 0n);
});

test('reservation identifiers follow the CHAR(36) contract bound', async () => {
    const store = new TestReservationStore();
    const available = seed(store, TENANT_A, 'merchant_available', 5000n);
    const reserved = seed(store, TENANT_A, 'merchant_reserved', 0n);

    await assert.rejects(
        reserveFunds(store, reserveInput({
            tenantId: 't'.repeat(37),
            reservationKey: 'identifier-tenant-37',
            availableAccountId: available,
            reservedAccountId: reserved,
        })),
        isReservationError('invalid_tenant'),
    );

    await assert.rejects(
        reserveFunds(store, reserveInput({
            tenantId: TENANT_A,
            reservationKey: 'identifier-account-37',
            availableAccountId: 'a'.repeat(37),
            reservedAccountId: reserved,
        })),
        isReservationError('invalid_input'),
    );

    assert.equal(store.journals.size, 0);
    assert.equal(store.reservations.size, 0);
});

test('reservation-managed journals cannot be bypassed by a generic reversal', async () => {
    const store = new TestReservationStore();
    const available = seed(store, TENANT_A, 'merchant_available', 5000n);
    const reserved = seed(store, TENANT_A, 'merchant_reserved', 0n);
    const receivable = seed(store, TENANT_A, 'platform_receivable', 3000n);

    const reservedResult = await reserveFunds(store, reserveInput({
        tenantId: TENANT_A,
        reservationKey: 'compensation-1',
        availableAccountId: available,
        reservedAccountId: reserved,
    }));
    const consumed = await consumeReservation(store, {
        tenantId: TENANT_A,
        reservationId: reservedResult.reservation.id,
        counterAccountId: receivable,
    });
    const consumedSnapshot = moneySafeJson(consumed.journal);

    await assert.rejects(
        reverseJournal(store, {
            tenantId: TENANT_A,
            journalId: consumed.journal.id,
            idempotencyKey: 'compensation-reversal-1',
            reason: 'operator compensation',
        }),
        (error: unknown) => error instanceof Error
            && (error as Error & { code?: string }).code === 'reservation_managed_journal',
    );

    assert.equal(balanceOf(store, reserved), 0n);
    assert.equal(balanceOf(store, receivable), 1000n);
    assert.equal(moneySafeJson(store.journals.get(consumed.journal.id)), consumedSnapshot);
    assert.equal(store.journals.size, 2);
});
