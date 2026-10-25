import { createHash } from 'node:crypto';
import {
    MAX_PRICE_TIERS,
    validatePriceVersion,
    type PriceSchedule,
    type PriceVersion,
} from './billing-pricing';

export const SNAPSHOT_MODEL_VERSION = 1;
export const MAX_SNAPSHOT_ID_LENGTH = 128;
export const MAX_VERSION_LABEL_LENGTH = 128;
export const MAX_CURRENCY_LENGTH = 16;
export const MAX_OFFER_PAYLOAD_LENGTH = 8192;
export const SNAPSHOTS_ARE_IMMUTABLE = true;
export const OFFER_PRICING_EFFECT_STATUS = 'held_not_settled_docs19' as const;

export type BillingSnapshotErrorCode =
    | 'validation'
    | 'hash_mismatch'
    | 'malformed_snapshot';
export class BillingSnapshotError extends Error {
    constructor(
        public readonly code: BillingSnapshotErrorCode,
        message: string,
    ) {
        super(message);
        this.name = 'BillingSnapshotError';
    }
}

function fail(code: BillingSnapshotErrorCode, message: string): never {
    throw new BillingSnapshotError(code, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireBoundedString(
    value: unknown,
    field: string,
    maxLength: number,
): string {
    if (typeof value !== 'string') fail('validation', `${field} must be a string`);
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

function requireNonNegativeSafeInteger(value: unknown, field: string): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
        fail('validation', `${field} must be a non-negative safe integer second`);
    }
    return value;
}

function requireNonNegativeBigint(value: unknown, field: string): bigint {
    if (typeof value !== 'bigint' || value < 0n) {
        fail('validation', `${field} must be a non-negative bigint`);
    }
    return value;
}

export interface CapturedTier {
    readonly upToCount: number | null;
    readonly pricePerRegistrationMinor: bigint;
}

export interface CapturedPriceSchedule {
    readonly includedRegistrations: number;
    readonly baseAmountMinor: bigint;
    readonly tiers: readonly CapturedTier[];
}

export interface CapturedPriceContent {
    readonly currency: string;
    readonly minorUnitsPerMajor: bigint;
    readonly schedules: Readonly<{
        teacher: CapturedPriceSchedule;
        center: CapturedPriceSchedule;
    }>;
}

export interface PriceVersionSnapshot {
    readonly modelVersion: number;
    readonly id: string;
    readonly versionLabel: string;
    readonly effectiveFrom: number;
    readonly contentHash: string;
    readonly content: CapturedPriceContent;
}

export interface SnapshotComparison {
    readonly contentEqual: boolean;
    readonly idEqual: boolean;
    readonly versionLabelEqual: boolean;
    readonly effectiveFromEqual: boolean;
}

function captureSchedule(source: PriceSchedule): CapturedPriceSchedule {
    return Object.freeze({
        includedRegistrations: source.includedRegistrations,
        baseAmountMinor: source.baseAmountMinor,
        tiers: Object.freeze(
            source.tiers.map((tier) => Object.freeze({
                upToCount: tier.upToCount,
                pricePerRegistrationMinor: tier.pricePerRegistrationMinor,
            })),
        ),
    });
}

function captureContent(version: PriceVersion): CapturedPriceContent {
    return Object.freeze({
        currency: version.currency,
        minorUnitsPerMajor: version.minorUnitsPerMajor,
        schedules: Object.freeze({
            teacher: captureSchedule(version.schedules.teacher),
            center: captureSchedule(version.schedules.center),
        }),
    });
}

function canonicalSchedule(schedule: CapturedPriceSchedule): Record<string, unknown> {
    return {
        includedRegistrations: schedule.includedRegistrations,
        baseAmountMinor: schedule.baseAmountMinor.toString(),
        tiers: schedule.tiers.map((tier) => ({
            upToCount: tier.upToCount,
            pricePerRegistrationMinor: tier.pricePerRegistrationMinor.toString(),
        })),
    };
}

function canonicalPriceContentString(content: CapturedPriceContent): string {
    return JSON.stringify({
        currency: content.currency,
        minorUnitsPerMajor: content.minorUnitsPerMajor.toString(),
        schedules: {
            teacher: canonicalSchedule(content.schedules.teacher),
            center: canonicalSchedule(content.schedules.center),
        },
    });
}

function priceContentHash(content: CapturedPriceContent): string {
    return createHash('sha256').update(canonicalPriceContentString(content)).digest('hex');
}

/**
 * Canonical JSON text of captured price content, ready for the
 * `billing_price_version_snapshots.content` JSON column. Amounts remain
 * decimal strings so no JS number can lose precision on the persistence path.
 */
export function serializeCapturedPriceContent(content: CapturedPriceContent): string {
    return canonicalPriceContentString(content);
}

/**
 * Freeze an immutable snapshot of a price version.
 *
 * The tier definitions are captured BY VALUE (new frozen objects, never
 * references into the caller's schedules), so a later price change can never
 * alter an issued invoice that references this snapshot. The SHA-256 content
 * hash covers the captured tier definitions; version labels and identifiers
 * are recorded separately and are not part of the content hash.
 */
export function freezePriceVersionSnapshot(
    version: unknown,
    effectiveFrom: unknown,
    id: string,
): PriceVersionSnapshot {
    const validated = validatePriceVersion(version);
    if (!validated.ok) {
        fail('validation', `price version is invalid: ${validated.error.message}`);
    }
    requireBoundedString(id, 'snapshot id', MAX_SNAPSHOT_ID_LENGTH);
    const from = requireNonNegativeSafeInteger(effectiveFrom, 'effectiveFrom');

    const content = captureContent(validated.value);
    const contentHash = priceContentHash(content);

    return Object.freeze({
        modelVersion: SNAPSHOT_MODEL_VERSION,
        id,
        versionLabel: validated.value.id,
        effectiveFrom: from,
        contentHash,
        content,
    });
}

const SNAPSHOT_KEYS = ['modelVersion', 'id', 'versionLabel', 'effectiveFrom', 'contentHash', 'content'];
const CONTENT_KEYS = ['currency', 'minorUnitsPerMajor', 'schedules'];
const SCHEDULE_KEYS = ['includedRegistrations', 'baseAmountMinor', 'tiers'];
const TIER_KEYS = ['upToCount', 'pricePerRegistrationMinor'];

function ownsExactly(value: object, keys: readonly string[]): boolean {
    const own = Object.keys(value);
    if (own.length !== keys.length) return false;
    return keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function assertCapturedSchedule(input: unknown, label: string): CapturedPriceSchedule {
    if (!isRecord(input) || !ownsExactly(input, SCHEDULE_KEYS)) {
        fail('malformed_snapshot', `${label} must have exactly ${SCHEDULE_KEYS.join(', ')}`);
    }
    const included = input['includedRegistrations'];
    if (typeof included !== 'number' || !Number.isSafeInteger(included) || included < 0) {
        fail('malformed_snapshot', `${label}.includedRegistrations must be a non-negative safe integer`);
    }
    const base = requireNonNegativeBigint(input['baseAmountMinor'], `${label}.baseAmountMinor`);
    const rawTiers = input['tiers'];
    if (!Array.isArray(rawTiers) || rawTiers.length === 0 || rawTiers.length > MAX_PRICE_TIERS) {
        fail('malformed_snapshot', `${label}.tiers must be a bounded non-empty array`);
    }
    const tiers = rawTiers.map((tier, index) => {
        if (!isRecord(tier) || !ownsExactly(tier, TIER_KEYS)) {
            fail('malformed_snapshot', `${label}.tiers[${index}] must have exactly ${TIER_KEYS.join(', ')}`);
        }
        const upTo = tier['upToCount'];
        if (upTo !== null && (typeof upTo !== 'number' || !Number.isSafeInteger(upTo) || upTo < 0)) {
            fail('malformed_snapshot', `${label}.tiers[${index}].upToCount must be null or a non-negative safe integer`);
        }
        return Object.freeze({
            upToCount: upTo as number | null,
            pricePerRegistrationMinor: requireNonNegativeBigint(
                tier['pricePerRegistrationMinor'],
                `${label}.tiers[${index}].pricePerRegistrationMinor`,
            ),
        });
    });
    return Object.freeze({ includedRegistrations: included, baseAmountMinor: base, tiers: Object.freeze(tiers) });
}

function assertSnapshotShape(input: unknown): PriceVersionSnapshot {
    if (!isRecord(input) || !ownsExactly(input, SNAPSHOT_KEYS)) {
        fail('malformed_snapshot', `snapshot must have exactly ${SNAPSHOT_KEYS.join(', ')}`);
    }
    const parsed: PriceVersionSnapshot = {
        modelVersion: SNAPSHOT_MODEL_VERSION,
        id: requireBoundedString(input['id'], 'snapshot id', MAX_SNAPSHOT_ID_LENGTH),
        versionLabel: requireBoundedString(input['versionLabel'], 'versionLabel', MAX_VERSION_LABEL_LENGTH),
        effectiveFrom: requireNonNegativeSafeInteger(input['effectiveFrom'], 'effectiveFrom'),
        contentHash: requireBoundedString(input['contentHash'], 'contentHash', 128),
        content: assertSnapshotContent(input['content']),
    };
    if (input['modelVersion'] !== SNAPSHOT_MODEL_VERSION) {
        fail('malformed_snapshot', `snapshot modelVersion must be ${SNAPSHOT_MODEL_VERSION}`);
    }
    if (!/^[0-9a-f]{64}$/.test(parsed.contentHash)) {
        fail('malformed_snapshot', 'contentHash must be a lowercase SHA-256 hex string');
    }
    const contentVersion = reconstructCapturedPriceVersionObject(parsed.content, parsed.versionLabel);
    const validatedContent = validatePriceVersion(contentVersion);
    if (!validatedContent.ok) {
        fail('malformed_snapshot', `captured content does not form a valid price version: ${validatedContent.error.message}`);
    }
    return parsed;
}

function assertSnapshotContent(input: unknown): CapturedPriceContent {
    if (!isRecord(input) || !ownsExactly(input, CONTENT_KEYS)) {
        fail('malformed_snapshot', `content must have exactly ${CONTENT_KEYS.join(', ')}`);
    }
    const schedules = input['schedules'];
    if (!isRecord(schedules) || !ownsExactly(schedules, ['teacher', 'center'])) {
        fail('malformed_snapshot', 'content.schedules must have exactly teacher and center');
    }
    return Object.freeze({
        currency: requireBoundedString(input['currency'], 'content.currency', MAX_CURRENCY_LENGTH),
        minorUnitsPerMajor: ((): bigint => {
            if (typeof input['minorUnitsPerMajor'] !== 'bigint' || (input['minorUnitsPerMajor'] as bigint) <= 0n) {
                fail('malformed_snapshot', 'content.minorUnitsPerMajor must be a positive bigint');
            }
            return input['minorUnitsPerMajor'] as bigint;
        })(),
        schedules: Object.freeze({
            teacher: assertCapturedSchedule(schedules['teacher'], 'content.schedules.teacher'),
            center: assertCapturedSchedule(schedules['center'], 'content.schedules.center'),
        }),
    });
}

function reconstructCapturedPriceVersionObject(
    content: CapturedPriceContent,
    versionLabel: string,
): PriceVersion {
    return {
        id: versionLabel,
        currency: content.currency,
        minorUnitsPerMajor: content.minorUnitsPerMajor,
        schedules: {
            teacher: content.schedules.teacher as unknown as PriceSchedule,
            center: content.schedules.center as unknown as PriceSchedule,
        },
    };
}

/**
 * Recompute the content hash from the captured tier definitions and compare it
 * with the stored hash. Returns `false` on any mismatch; malformed snapshots
 * throw `BillingSnapshotError`.
 */
export function verifyPriceVersionSnapshot(input: unknown): boolean {
    const snapshot = assertSnapshotShape(input);
    return priceContentHash(snapshot.content) === snapshot.contentHash;
}

/**
 * Compare two snapshots field by field. No exception is raised for unequal
 * snapshots; every compared facet is reported explicitly.
 */
export function comparePriceVersionSnapshots(
    leftInput: unknown,
    rightInput: unknown,
): SnapshotComparison {
    const left = assertSnapshotShape(leftInput);
    const right = assertSnapshotShape(rightInput);
    return Object.freeze({
        contentEqual:
            left.contentHash === right.contentHash
            && canonicalPriceContentString(left.content) === canonicalPriceContentString(right.content),
        idEqual: left.id === right.id,
        versionLabelEqual: left.versionLabel === right.versionLabel,
        effectiveFromEqual: left.effectiveFrom === right.effectiveFrom,
    });
}

/**
 * Rebuild the `PriceVersion`-shaped value that must be handed to the pure
 * pricing engine when computing from a captured snapshot. The result is always
 * derived from the captured values, never from the current price tables.
 */
export function reconstructCapturedPriceVersion(input: unknown): PriceVersion {
    const snapshot = assertSnapshotShape(input);
    if (priceContentHash(snapshot.content) !== snapshot.contentHash) {
        fail('hash_mismatch', 'captured content does not hash to the stored snapshot content hash');
    }
    const priceVersion = reconstructCapturedPriceVersionObject(snapshot.content, snapshot.versionLabel);
    const validated = validatePriceVersion(priceVersion);
    if (!validated.ok) {
        fail('malformed_snapshot', `captured content does not form a valid price version: ${validated.error.message}`);
    }
    return validated.value;
}

export interface OfferSnapshot {
    readonly modelVersion: number;
    readonly id: string;
    readonly versionLabel: string | null;
    readonly effectiveFrom: number;
    readonly effectiveUntil: number | null;
    readonly payload: string;
    readonly payloadHash: string;
}

const OFFER_KEYS = ['modelVersion', 'id', 'versionLabel', 'effectiveFrom', 'effectiveUntil', 'payload', 'payloadHash'];

/**
 * Freeze an immutable snapshot of an offer (discount link).
 *
 * docs/19 (line 11) settles only that a snapshot of the price and the offer is
 * recorded in the invoice; the arithmetic effect of the offer on invoice
 * totals is NOT settled, so this container records an opaque validated
 * payload and keeps no pricing field. The pricing effect remains HELD.
 */
export function freezeOfferSnapshot(input: unknown): OfferSnapshot {
    if (!isRecord(input)) {
        fail('validation', 'offer snapshot input must be an object');
    }
    const id = requireBoundedString(input['id'], 'offer snapshot id', MAX_SNAPSHOT_ID_LENGTH);
    const rawLabel = input['versionLabel'];
    const versionLabel = rawLabel === undefined || rawLabel === null
        ? null
        : requireBoundedString(rawLabel, 'offer versionLabel', MAX_VERSION_LABEL_LENGTH);
    const effectiveFrom = requireNonNegativeSafeInteger(input['effectiveFrom'], 'offer effectiveFrom');
    const rawUntil = input['effectiveUntil'];
    let effectiveUntil: number | null = null;
    if (rawUntil !== undefined && rawUntil !== null) {
        effectiveUntil = requireNonNegativeSafeInteger(rawUntil, 'offer effectiveUntil');
        if (effectiveUntil < effectiveFrom) {
            fail('validation', 'offer effectiveUntil must not be before effectiveFrom');
        }
    }
    const payload = input['payload'];
    if (typeof payload !== 'string') {
        fail('validation', 'offer payload must be a JSON string');
    }
    if (payload.length === 0 || payload.length > MAX_OFFER_PAYLOAD_LENGTH) {
        fail('validation', `offer payload must be a non-empty string of at most ${MAX_OFFER_PAYLOAD_LENGTH} characters`);
    }
    try {
        JSON.parse(payload);
    } catch {
        fail('validation', 'offer payload must be well-formed JSON');
    }
    return Object.freeze({
        modelVersion: SNAPSHOT_MODEL_VERSION,
        id,
        versionLabel,
        effectiveFrom,
        effectiveUntil,
        payload,
        payloadHash: createHash('sha256').update(payload).digest('hex'),
    });
}

function assertOfferSnapshotShape(input: unknown): OfferSnapshot {
    if (!isRecord(input) || !ownsExactly(input, OFFER_KEYS)) {
        fail('malformed_snapshot', `offer snapshot must have exactly ${OFFER_KEYS.join(', ')}`);
    }
    if (input['modelVersion'] !== SNAPSHOT_MODEL_VERSION) {
        fail('malformed_snapshot', `offer snapshot modelVersion must be ${SNAPSHOT_MODEL_VERSION}`);
    }
    const snapshot: OfferSnapshot = {
        modelVersion: SNAPSHOT_MODEL_VERSION,
        id: requireBoundedString(input['id'], 'offer snapshot id', MAX_SNAPSHOT_ID_LENGTH),
        versionLabel: input['versionLabel'] === null
            ? null
            : requireBoundedString(input['versionLabel'], 'offer versionLabel', MAX_VERSION_LABEL_LENGTH),
        effectiveFrom: requireNonNegativeSafeInteger(input['effectiveFrom'], 'offer effectiveFrom'),
        effectiveUntil: input['effectiveUntil'] === null
            ? null
            : ((): number => {
                const until = requireNonNegativeSafeInteger(input['effectiveUntil'], 'offer effectiveUntil');
                if (until < snapshotEffectiveFrom(input['effectiveFrom'])) {
                    fail('malformed_snapshot', 'offer effectiveUntil must not be before effectiveFrom');
                }
                return until;
            })(),
        payload: ((): string => {
            const payload = input['payload'];
            if (typeof payload !== 'string' || payload.length === 0 || payload.length > MAX_OFFER_PAYLOAD_LENGTH) {
                fail('malformed_snapshot', 'offer payload must be a bounded non-empty JSON string');
            }
            return payload;
        })(),
        payloadHash: requireBoundedString(input['payloadHash'], 'offer payloadHash', 128),
    };
    if (!/^[0-9a-f]{64}$/.test(snapshot.payloadHash)) {
        fail('malformed_snapshot', 'offer payloadHash must be a lowercase SHA-256 hex string');
    }
    return snapshot;
}

function snapshotEffectiveFrom(value: unknown): number {
    return requireNonNegativeSafeInteger(value, 'offer effectiveFrom');
}

/** Re-hash the stored payload and compare with the stored hash. */
export function verifyOfferSnapshot(input: unknown): boolean {
    const snapshot = assertOfferSnapshotShape(input);
    const recomputed = createHash('sha256').update(snapshot.payload).digest('hex');
    return recomputed === snapshot.payloadHash;
}

export interface OfferSnapshotComparison {
    readonly contentEqual: boolean;
    readonly idEqual: boolean;
    readonly payloadEqual: boolean;
}

export function compareOfferSnapshots(
    leftInput: unknown,
    rightInput: unknown,
): OfferSnapshotComparison {
    const left = assertOfferSnapshotShape(leftInput);
    const right = assertOfferSnapshotShape(rightInput);
    return Object.freeze({
        contentEqual: left.payloadHash === right.payloadHash && left.payload === right.payload,
        idEqual: left.id === right.id,
        payloadEqual: left.payload === right.payload,
    });
}
