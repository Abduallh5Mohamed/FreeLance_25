/**
 * B2-C-LEDGER — exactly-once ledger reservations.
 *
 * A reservation moves money from `merchant_available` to `merchant_reserved`,
 * releases it back, or consumes it from reserved into a platform-side counter
 * account. Every transition is one journal plus one CAS update of the
 * reservation row, all inside the injected `runAtomic` transaction seam.
 *
 * Contract: docs/contracts/BILLING-LEDGER-INTERNAL-CONTRACT.md.
 *
 * This module does not implement SQL, collection, fees, commission, refunds,
 * payouts or dispute policy. Compensation is an append-only reversal journal
 * (`reverseJournal` in billing-ledger.ts); the business approval path for
 * compensating an already-consumed reservation is HELD.
 */

import { createHash, randomUUID } from 'node:crypto';
import {
    LedgerStore,
    LedgerTransaction,
    JournalRecord,
    LedgerAccount,
    MAX_ACCOUNT_ID_LENGTH,
    normalizeAmountMinor,
    postJournalInTransaction,
    ACCOUNT_KINDS,
} from './billing-ledger';

export const RESERVATION_STATUSES = ['reserved', 'released', 'consumed'] as const;
export type ReservationStatus = (typeof RESERVATION_STATUSES)[number];

export type ReservationEventType = 'reserve' | 'release' | 'consume' | 'reversal';

export const MAX_RESERVATION_KEY_LENGTH = 100;
export const MAX_RESERVATION_ID_LENGTH = 36;
export const MAX_RESERVATION_TENANT_LENGTH = 36;
export const MAX_RESERVATION_REFERENCE_LENGTH = 200;
export const MAX_RESERVATION_DESCRIPTION_LENGTH = 500;

const CURRENCY_PATTERN = /^[A-Z]{3}$/;
const CONSUME_COUNTER_KINDS = new Set<string>(['platform_receivable', 'platform_cash']);

export type ReservationErrorCode =
    | 'invalid_input'
    | 'invalid_tenant'
    | 'invalid_reservation_key'
    | 'invalid_reservation_id'
    | 'invalid_currency'
    | 'invalid_amount'
    | 'invalid_reference'
    | 'invalid_description'
    | 'account_not_found'
    | 'tenant_mismatch'
    | 'account_kind_mismatch'
    | 'currency_mismatch'
    | 'insufficient_available'
    | 'reservation_not_found'
    | 'reservation_payload_conflict'
    | 'reservation_key_conflict'
    | 'reservation_not_reserved'
    | 'already_consumed'
    | 'invalid_consume_target'
    | 'reservation_state_invalid'
    | 'version_conflict';

export class ReservationError extends Error {
    constructor(public readonly code: ReservationErrorCode, message: string) {
        super(message);
        this.name = 'ReservationError';
    }
}

function fail(code: ReservationErrorCode, message: string): never {
    throw new ReservationError(code, message);
}

function requireBoundedString(
    value: unknown,
    field: string,
    maxLength: number,
    code: ReservationErrorCode,
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
    code: ReservationErrorCode,
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

function normalizeCreatedAt(value: unknown): string {
    if (value === undefined) return new Date().toISOString();
    if (typeof value !== 'string' || value.trim() === '' || Number.isNaN(Date.parse(value))) {
        fail('invalid_input', 'createdAt must be a parseable timestamp string');
    }
    return value;
}

export interface ReservationRecord {
    readonly id: string;
    readonly tenantId: string;
    readonly reservationKey: string;
    readonly payloadHash: string;
    readonly currency: string;
    readonly amountMinor: bigint;
    readonly availableAccountId: string;
    readonly reservedAccountId: string;
    readonly status: ReservationStatus;
    readonly version: number;
    readonly reserveJournalId: string;
    readonly releaseJournalId: string | null;
    readonly consumeJournalId: string | null;
    readonly consumeCounterAccountId: string | null;
    readonly reference: string | null;
    readonly description: string | null;
    readonly createdAt: string;
    readonly updatedAt: string;
}

export interface ReservationEventInput {
    readonly id: string;
    readonly tenantId: string;
    readonly reservationId: string;
    readonly eventType: ReservationEventType;
    readonly amountMinor: bigint;
    readonly journalId: string;
    readonly versionAfter: number;
    readonly idempotencyKey: string;
    readonly createdAt: string;
}

export type InsertReservationResult =
    | { readonly ok: true; readonly reservation: ReservationRecord }
    | { readonly ok: false; readonly reason: 'duplicate_key' };

export interface UpdateReservationInput {
    readonly tenantId: string;
    readonly reservationId: string;
    readonly expectedVersion: number;
    readonly status: 'released' | 'consumed';
    readonly releaseJournalId: string | null;
    readonly consumeJournalId: string | null;
    readonly consumeCounterAccountId: string | null;
    readonly updatedAt: string;
}

export type UpdateReservationResult =
    | { readonly ok: true; readonly reservation: ReservationRecord }
    | { readonly ok: false; readonly reason: 'not_found' | 'version_conflict' | 'invalid_status' };

/**
 * Transaction-bound reservation persistence contract. It extends the ledger
 * seam, so a reservation transition and its journal are written through the
 * same transaction handle.
 */
export interface ReservationTransaction extends LedgerTransaction {
    findReservationByKey(tenantId: string, reservationKey: string): Promise<ReservationRecord | null>;
    getReservation(tenantId: string, reservationId: string): Promise<ReservationRecord | null>;
    insertReservation(reservation: ReservationRecord): Promise<InsertReservationResult>;
    updateReservation(input: UpdateReservationInput): Promise<UpdateReservationResult>;
    insertReservationEvent(event: ReservationEventInput): Promise<void>;
}

export interface ReservationStore extends LedgerStore<ReservationTransaction> {}

export interface ReserveFundsInput {
    readonly tenantId: string;
    readonly reservationKey: string;
    readonly currency: string;
    readonly amountMinor: unknown;
    readonly availableAccountId: string;
    readonly reservedAccountId: string;
    readonly reference?: string | null;
    readonly description?: string | null;
    readonly createdAt?: string;
}

export interface ReleaseReservationInput {
    readonly tenantId: string;
    readonly reservationId: string;
    readonly createdAt?: string;
}

export interface ConsumeReservationInput {
    readonly tenantId: string;
    readonly reservationId: string;
    readonly counterAccountId: string;
    readonly createdAt?: string;
}

export interface ReservationTransitionResult {
    readonly reservation: ReservationRecord;
    readonly journal: JournalRecord;
    readonly replayed: boolean;
}

interface NormalizedReserve {
    readonly tenantId: string;
    readonly reservationKey: string;
    readonly currency: string;
    readonly amountMinor: bigint;
    readonly availableAccountId: string;
    readonly reservedAccountId: string;
    readonly reference: string | null;
    readonly description: string | null;
    readonly createdAt: string;
    readonly payloadHash: string;
}

function hashReservationPayload(input: {
    tenantId: string;
    reservationKey: string;
    currency: string;
    amountMinor: bigint;
    availableAccountId: string;
    reservedAccountId: string;
    reference: string | null;
}): string {
    return createHash('sha256')
        .update(JSON.stringify({
            tenantId: input.tenantId,
            reservationKey: input.reservationKey,
            currency: input.currency,
            amountMinor: input.amountMinor.toString(),
            availableAccountId: input.availableAccountId,
            reservedAccountId: input.reservedAccountId,
            reference: input.reference,
        }))
        .digest('hex');
}

function normalizeReserveInput(input: ReserveFundsInput): NormalizedReserve {
    const tenantId = requireBoundedString(
        input.tenantId,
        'tenantId',
        MAX_RESERVATION_TENANT_LENGTH,
        'invalid_tenant',
    );
    const reservationKey = requireBoundedString(
        input.reservationKey,
        'reservationKey',
        MAX_RESERVATION_KEY_LENGTH,
        'invalid_reservation_key',
    );
    const currency = requireCurrency(input.currency);
    const amountMinor = normalizeAmountMinor(input.amountMinor);
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
    if (availableAccountId === reservedAccountId) {
        fail('invalid_input', 'available and reserved accounts must differ');
    }
    const reference = optionalBoundedString(
        input.reference,
        'reference',
        MAX_RESERVATION_REFERENCE_LENGTH,
        'invalid_reference',
    );
    const description = optionalBoundedString(
        input.description,
        'description',
        MAX_RESERVATION_DESCRIPTION_LENGTH,
        'invalid_description',
    );
    const createdAt = normalizeCreatedAt(input.createdAt);

    return {
        tenantId,
        reservationKey,
        currency,
        amountMinor,
        availableAccountId,
        reservedAccountId,
        reference,
        description,
        createdAt,
        payloadHash: hashReservationPayload({
            tenantId,
            reservationKey,
            currency,
            amountMinor,
            availableAccountId,
            reservedAccountId,
            reference,
        }),
    };
}

function requireAccount(
    account: LedgerAccount | null,
    tenantId: string,
    kind: string | null,
    currency: string,
    label: string,
): LedgerAccount {
    if (account === null) fail('account_not_found', `${label} account was not found`);
    if (account.tenantId !== tenantId) fail('tenant_mismatch', `${label} account belongs to another tenant`);
    if (kind !== null && account.kind !== kind) fail('account_kind_mismatch', `${label} account must be ${kind}`);
    if (account.currency !== currency) {
        fail('currency_mismatch', `${label} account is not in ${currency}`);
    }
    return account;
}

function requireReservation(record: ReservationRecord | null): ReservationRecord {
    if (record === null) fail('reservation_not_found', 'reservation was not found');
    return record;
}

function assertKnownAccountKind(kind: string): void {
    if (!(ACCOUNT_KINDS as readonly string[]).includes(kind)) {
        fail('account_kind_mismatch', `unknown account kind ${kind}`);
    }
}

function eventKey(prefix: 'reserve' | 'release' | 'consume', identity: string): string {
    const key = `${prefix}:${identity}`;
    if (key.length > 128) fail('invalid_input', 'derived reservation event key exceeds 128 characters');
    return key;
}

/**
 * Reserve `amountMinor` from available into reserved.
 *
 * - replay with the same reservation key and payload returns the recorded row;
 * - replay with the same key and a different payload is a conflict;
 * - over-reserve (available below the amount) is rejected before writing;
 * - concurrent reserves CAS on the same account versions, so only the one that
 *   still sees enough available can post.
 */
export async function reserveFunds(
    store: ReservationStore,
    input: ReserveFundsInput,
): Promise<ReservationTransitionResult> {
    const normalized = normalizeReserveInput(input);

    return store.runAtomic(async (tx) => {
        const existing = await tx.findReservationByKey(normalized.tenantId, normalized.reservationKey);
        if (existing !== null) {
            if (existing.payloadHash !== normalized.payloadHash) {
                fail('reservation_payload_conflict', 'reservation key was reused with a different payload');
            }
            const journal = await tx.getJournal(normalized.tenantId, existing.reserveJournalId);
            if (journal === null) fail('reservation_state_invalid', 'reservation journal is missing');
            return { reservation: existing, journal, replayed: true };
        }

        const available = requireAccount(
            await tx.getAccount(normalized.tenantId, normalized.availableAccountId),
            normalized.tenantId,
            'merchant_available',
            normalized.currency,
            'available',
        );
        const reserved = requireAccount(
            await tx.getAccount(normalized.tenantId, normalized.reservedAccountId),
            normalized.tenantId,
            'merchant_reserved',
            normalized.currency,
            'reserved',
        );
        assertKnownAccountKind(available.kind);
        assertKnownAccountKind(reserved.kind);

        if (available.balanceMinor < normalized.amountMinor) {
            fail(
                'insufficient_available',
                `available balance ${available.balanceMinor.toString()} is below the reservation amount`,
            );
        }

        const posted = await postJournalInTransaction(tx, {
            tenantId: normalized.tenantId,
            currency: normalized.currency,
            idempotencyKey: eventKey('reserve', normalized.reservationKey),
            reference: normalized.reference,
            description: normalized.description,
            createdAt: normalized.createdAt,
            lines: [
                {
                    accountId: normalized.availableAccountId,
                    direction: 'debit',
                    amountMinor: normalized.amountMinor,
                },
                {
                    accountId: normalized.reservedAccountId,
                    direction: 'credit',
                    amountMinor: normalized.amountMinor,
                },
            ],
        });

        const reservation: ReservationRecord = {
            id: randomUUID(),
            tenantId: normalized.tenantId,
            reservationKey: normalized.reservationKey,
            payloadHash: normalized.payloadHash,
            currency: normalized.currency,
            amountMinor: normalized.amountMinor,
            availableAccountId: normalized.availableAccountId,
            reservedAccountId: normalized.reservedAccountId,
            status: 'reserved',
            version: 1,
            reserveJournalId: posted.journal.id,
            releaseJournalId: null,
            consumeJournalId: null,
            consumeCounterAccountId: null,
            reference: normalized.reference,
            description: normalized.description,
            createdAt: normalized.createdAt,
            updatedAt: normalized.createdAt,
        };

        const inserted = await tx.insertReservation(reservation);
        if (!inserted.ok) {
            fail('reservation_key_conflict', 'reservation key was created concurrently');
        }

        await tx.insertReservationEvent({
            id: randomUUID(),
            tenantId: normalized.tenantId,
            reservationId: inserted.reservation.id,
            eventType: 'reserve',
            amountMinor: normalized.amountMinor,
            journalId: posted.journal.id,
            versionAfter: inserted.reservation.version,
            idempotencyKey: eventKey('reserve', normalized.reservationKey),
            createdAt: normalized.createdAt,
        });

        return { reservation: inserted.reservation, journal: posted.journal, replayed: false };
    });
}

/**
 * Release a reserved amount back to available. Releasing an already released
 * reservation is a no-op replay; releasing a consumed reservation is rejected.
 */
export async function releaseReservation(
    store: ReservationStore,
    input: ReleaseReservationInput,
): Promise<ReservationTransitionResult> {
    const tenantId = requireBoundedString(
        input.tenantId,
        'tenantId',
        MAX_RESERVATION_TENANT_LENGTH,
        'invalid_tenant',
    );
    const reservationId = requireBoundedString(
        input.reservationId,
        'reservationId',
        MAX_RESERVATION_ID_LENGTH,
        'invalid_reservation_id',
    );
    const createdAt = normalizeCreatedAt(input.createdAt);

    return store.runAtomic(async (tx) => {
        const reservation = requireReservation(await tx.getReservation(tenantId, reservationId));

        if (reservation.status === 'released') {
            if (reservation.releaseJournalId === null) {
                fail('reservation_state_invalid', 'released reservation has no release journal');
            }
            const journal = await tx.getJournal(tenantId, reservation.releaseJournalId);
            if (journal === null) fail('reservation_state_invalid', 'release journal is missing');
            return { reservation, journal, replayed: true };
        }
        if (reservation.status !== 'reserved') {
            fail('reservation_not_reserved', 'only a reserved amount can be released');
        }

        requireAccount(
            await tx.getAccount(tenantId, reservation.availableAccountId),
            tenantId,
            'merchant_available',
            reservation.currency,
            'available',
        );
        const reserved = requireAccount(
            await tx.getAccount(tenantId, reservation.reservedAccountId),
            tenantId,
            'merchant_reserved',
            reservation.currency,
            'reserved',
        );
        if (reserved.balanceMinor < reservation.amountMinor) {
            fail('reservation_state_invalid', 'reserved balance is below the reservation amount');
        }

        const posted = await postJournalInTransaction(tx, {
            tenantId,
            currency: reservation.currency,
            idempotencyKey: eventKey('release', reservation.id),
            reference: reservation.reference,
            description: reservation.description,
            createdAt,
            lines: [
                {
                    accountId: reservation.reservedAccountId,
                    direction: 'debit',
                    amountMinor: reservation.amountMinor,
                },
                {
                    accountId: reservation.availableAccountId,
                    direction: 'credit',
                    amountMinor: reservation.amountMinor,
                },
            ],
        });

        const updated = await tx.updateReservation({
            tenantId,
            reservationId: reservation.id,
            expectedVersion: reservation.version,
            status: 'released',
            releaseJournalId: posted.journal.id,
            consumeJournalId: null,
            consumeCounterAccountId: null,
            updatedAt: createdAt,
        });
        if (!updated.ok) {
            if (updated.reason === 'version_conflict') fail('version_conflict', 'reservation changed concurrently');
            if (updated.reason === 'not_found') fail('reservation_not_found', 'reservation was not found');
            fail('reservation_state_invalid', 'reservation cannot be released from its current state');
        }

        await tx.insertReservationEvent({
            id: randomUUID(),
            tenantId,
            reservationId: updated.reservation.id,
            eventType: 'release',
            amountMinor: reservation.amountMinor,
            journalId: posted.journal.id,
            versionAfter: updated.reservation.version,
            idempotencyKey: eventKey('release', reservation.id),
            createdAt,
        });

        return { reservation: updated.reservation, journal: posted.journal, replayed: false };
    });
}

/**
 * Consume a reserved amount into a platform-side counter account. Consuming
 * twice is rejected, and consuming a released reservation is rejected.
 */
export async function consumeReservation(
    store: ReservationStore,
    input: ConsumeReservationInput,
): Promise<ReservationTransitionResult> {
    const tenantId = requireBoundedString(
        input.tenantId,
        'tenantId',
        MAX_RESERVATION_TENANT_LENGTH,
        'invalid_tenant',
    );
    const reservationId = requireBoundedString(
        input.reservationId,
        'reservationId',
        MAX_RESERVATION_ID_LENGTH,
        'invalid_reservation_id',
    );
    const counterAccountId = requireBoundedString(
        input.counterAccountId,
        'counterAccountId',
        MAX_ACCOUNT_ID_LENGTH,
        'invalid_input',
    );
    const createdAt = normalizeCreatedAt(input.createdAt);

    return store.runAtomic(async (tx) => {
        const reservation = requireReservation(await tx.getReservation(tenantId, reservationId));

        if (reservation.status === 'consumed') {
            fail('already_consumed', 'reservation was already consumed');
        }
        if (reservation.status !== 'reserved') {
            fail('reservation_not_reserved', 'only a reserved amount can be consumed');
        }

        const reserved = requireAccount(
            await tx.getAccount(tenantId, reservation.reservedAccountId),
            tenantId,
            'merchant_reserved',
            reservation.currency,
            'reserved',
        );
        const counter = requireAccount(
            await tx.getAccount(tenantId, counterAccountId),
            tenantId,
            null,
            reservation.currency,
            'counter',
        );
        if (!CONSUME_COUNTER_KINDS.has(counter.kind)) {
            fail(
                'invalid_consume_target',
                'consume target must be a platform-side account, never a merchant wallet',
            );
        }
        if (reserved.balanceMinor < reservation.amountMinor) {
            fail('reservation_state_invalid', 'reserved balance is below the reservation amount');
        }

        const posted = await postJournalInTransaction(tx, {
            tenantId,
            currency: reservation.currency,
            idempotencyKey: eventKey('consume', reservation.id),
            reference: reservation.reference,
            description: reservation.description,
            createdAt,
            lines: [
                {
                    accountId: reservation.reservedAccountId,
                    direction: 'debit',
                    amountMinor: reservation.amountMinor,
                },
                {
                    accountId: counterAccountId,
                    direction: 'credit',
                    amountMinor: reservation.amountMinor,
                },
            ],
        });

        const updated = await tx.updateReservation({
            tenantId,
            reservationId: reservation.id,
            expectedVersion: reservation.version,
            status: 'consumed',
            releaseJournalId: null,
            consumeJournalId: posted.journal.id,
            consumeCounterAccountId: counterAccountId,
            updatedAt: createdAt,
        });
        if (!updated.ok) {
            if (updated.reason === 'version_conflict') fail('version_conflict', 'reservation changed concurrently');
            if (updated.reason === 'not_found') fail('reservation_not_found', 'reservation was not found');
            fail('reservation_state_invalid', 'reservation cannot be consumed from its current state');
        }

        await tx.insertReservationEvent({
            id: randomUUID(),
            tenantId,
            reservationId: updated.reservation.id,
            eventType: 'consume',
            amountMinor: reservation.amountMinor,
            journalId: posted.journal.id,
            versionAfter: updated.reservation.version,
            idempotencyKey: eventKey('consume', reservation.id),
            createdAt,
        });

        return { reservation: updated.reservation, journal: posted.journal, replayed: false };
    });
}
