"use strict";
/**
 * C7a / FIN1 — pure subscription pricing (docs/19 lines 13-35).
 *
 * All money is held as integer minor units (piasters for EGP) in `bigint`.
 * There is no floating-point arithmetic in this module: the tier formula is a
 * sequence of bigint integer additions/multiplications only. The function
 * returns an exact minor-unit amount; rounding belongs to the period engine
 * and happens exactly once at the end of a proration.
 *
 * The price snapshot is an injected, immutable value object. The engine never
 * reads module globals; `DEFAULT_PRICE_VERSION` is only a caller-supplied
 * convenience value for tests and future wiring.
 *
 * This module performs no I/O, no authorization and no persistence. It says
 * nothing about whether any SQL table or price-version row exists.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_PRICE_VERSION = exports.MAX_REGISTRATION_COUNT = exports.MAX_PRICE_TIERS = exports.BILLING_ORGANIZATIONS = void 0;
exports.validatePriceVersion = validatePriceVersion;
exports.calculateTeacherPriceMinor = calculateTeacherPriceMinor;
exports.calculateCenterPriceMinor = calculateCenterPriceMinor;
exports.calculatePriceMinor = calculatePriceMinor;
exports.BILLING_ORGANIZATIONS = ['teacher', 'center'];
exports.MAX_PRICE_TIERS = 32;
exports.MAX_REGISTRATION_COUNT = Number.MAX_SAFE_INTEGER;
function failure(code, message) {
    return { ok: false, error: { code, message } };
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function isNonEmptyString(value, maxLength) {
    return typeof value === 'string'
        && value.length > 0
        && value.length <= maxLength
        && value === value.trim();
}
function isCount(value) {
    return typeof value === 'number'
        && Number.isSafeInteger(value)
        && value >= 0
        && value <= exports.MAX_REGISTRATION_COUNT;
}
function normalizeRegistrationCount(value) {
    if (typeof value === 'number')
        return isCount(value) ? value : null;
    if (typeof value === 'bigint') {
        if (value < 0n || value > BigInt(exports.MAX_REGISTRATION_COUNT))
            return null;
        return Number(value);
    }
    return null;
}
function validateSchedule(value, label) {
    if (!isRecord(value)) {
        return failure('invalid_price_version', `${label} must be an object`);
    }
    const included = value['includedRegistrations'];
    if (!isCount(included)) {
        return failure('invalid_price_version', `${label}.includedRegistrations must be a non-negative safe integer`);
    }
    const base = value['baseAmountMinor'];
    if (typeof base !== 'bigint' || base < 0n) {
        return failure('invalid_price_version', `${label}.baseAmountMinor must be a non-negative bigint`);
    }
    const rawTiers = value['tiers'];
    if (!Array.isArray(rawTiers) || rawTiers.length === 0) {
        return failure('invalid_price_version', `${label}.tiers must be a non-empty array`);
    }
    if (rawTiers.length > exports.MAX_PRICE_TIERS) {
        return failure('invalid_price_version', `${label}.tiers exceeds ${exports.MAX_PRICE_TIERS} entries`);
    }
    const tiers = [];
    let previousUpperBound = included;
    for (let index = 0; index < rawTiers.length; index += 1) {
        const rawTier = rawTiers[index];
        if (!isRecord(rawTier)) {
            return failure('invalid_price_version', `${label}.tiers[${index}] must be an object`);
        }
        const unitAmount = rawTier['pricePerRegistrationMinor'];
        if (typeof unitAmount !== 'bigint' || unitAmount < 0n) {
            return failure('invalid_price_version', `${label}.tiers[${index}].pricePerRegistrationMinor must be a non-negative bigint`);
        }
        const upTo = rawTier['upToCount'];
        const isLast = index === rawTiers.length - 1;
        if (isLast) {
            if (upTo !== null) {
                return failure('invalid_price_version', `${label}.tiers must end with an open-ended (null) tier`);
            }
        }
        else {
            if (!isCount(upTo)) {
                return failure('invalid_price_version', `${label}.tiers[${index}].upToCount must be a non-negative safe integer`);
            }
            if (upTo <= previousUpperBound) {
                return failure('invalid_price_version', `${label}.tiers must be strictly increasing after the included count`);
            }
        }
        if (upTo !== null)
            previousUpperBound = upTo;
        tiers.push(Object.freeze({ upToCount: upTo, pricePerRegistrationMinor: unitAmount }));
    }
    return {
        ok: true,
        value: Object.freeze({
            includedRegistrations: included,
            baseAmountMinor: base,
            tiers: Object.freeze(tiers),
        }),
    };
}
/**
 * Validate and normalize an injected price snapshot.
 *
 * The returned value is deeply frozen. The input is never mutated. A snapshot
 * with gaps, overlaps, a non-final open-ended tier or non-integer amounts is
 * rejected as `invalid_price_version`.
 */
function validatePriceVersion(input) {
    if (!isRecord(input)) {
        return failure('invalid_price_version', 'price version must be an object');
    }
    const id = input['id'];
    if (!isNonEmptyString(id, 128)) {
        return failure('invalid_price_version', 'price version id must be a non-empty bounded string');
    }
    const currency = input['currency'];
    if (!isNonEmptyString(currency, 16)) {
        return failure('invalid_price_version', 'price version currency must be a non-empty bounded string');
    }
    const minorUnitsPerMajor = input['minorUnitsPerMajor'];
    if (typeof minorUnitsPerMajor !== 'bigint' || minorUnitsPerMajor <= 0n) {
        return failure('invalid_price_version', 'minorUnitsPerMajor must be a positive bigint');
    }
    const schedules = input['schedules'];
    if (!isRecord(schedules)) {
        return failure('invalid_price_version', 'schedules must be an object');
    }
    const teacher = validateSchedule(schedules['teacher'], 'schedules.teacher');
    if (!teacher.ok)
        return teacher;
    const center = validateSchedule(schedules['center'], 'schedules.center');
    if (!center.ok)
        return center;
    return {
        ok: true,
        value: Object.freeze({
            id,
            currency,
            minorUnitsPerMajor,
            schedules: Object.freeze({ teacher: teacher.value, center: center.value }),
        }),
    };
}
function calculateScheduleMinor(schedule, count) {
    let remaining = BigInt(count) - BigInt(schedule.includedRegistrations);
    let total = schedule.baseAmountMinor;
    if (remaining <= 0n)
        return total;
    let lowerBound = schedule.includedRegistrations;
    for (const tier of schedule.tiers) {
        if (remaining <= 0n)
            break;
        const capacity = tier.upToCount === null
            ? remaining
            : BigInt(tier.upToCount - lowerBound);
        const billable = remaining < capacity ? remaining : capacity;
        total += billable * tier.pricePerRegistrationMinor;
        remaining -= billable;
        if (tier.upToCount !== null)
            lowerBound = tier.upToCount;
    }
    return total;
}
/**
 * Exact teacher price in minor units.
 *
 * T(n) = 2000 + 50*min(max(n-50,0),50) + 45*min(max(n-100,0),50)
 *          + 40*min(max(n-150,0),50) + 35*max(n-200,0)
 * expressed in minor units by the injected snapshot.
 */
function calculateTeacherPriceMinor(priceVersion, registrationCount) {
    return calculatePriceMinor(priceVersion, 'teacher', registrationCount);
}
/** Exact center price in minor units (same contract as the teacher helper). */
function calculateCenterPriceMinor(priceVersion, registrationCount) {
    return calculatePriceMinor(priceVersion, 'center', registrationCount);
}
/**
 * Exact cumulative price for one organization, in minor units.
 *
 * The count may be a non-negative safe integer number or bigint. Negative,
 * fractional, non-finite and string counts are rejected rather than coerced.
 */
function calculatePriceMinor(priceVersion, organization, registrationCount) {
    const version = validatePriceVersion(priceVersion);
    if (!version.ok)
        return version;
    if (typeof organization !== 'string' || !exports.BILLING_ORGANIZATIONS.includes(organization)) {
        return failure('invalid_organization', 'organization must be teacher or center');
    }
    const count = normalizeRegistrationCount(registrationCount);
    if (count === null) {
        return failure('invalid_registration_count', 'registration count must be a non-negative safe integer');
    }
    const schedule = version.value.schedules[organization];
    return { ok: true, value: calculateScheduleMinor(schedule, count) };
}
const DEFAULT_TEACHER_TIERS = Object.freeze([
    Object.freeze({ upToCount: 100, pricePerRegistrationMinor: 5000n }),
    Object.freeze({ upToCount: 150, pricePerRegistrationMinor: 4500n }),
    Object.freeze({ upToCount: 200, pricePerRegistrationMinor: 4000n }),
    Object.freeze({ upToCount: null, pricePerRegistrationMinor: 3500n }),
]);
const DEFAULT_CENTER_TIERS = Object.freeze([
    Object.freeze({ upToCount: 250, pricePerRegistrationMinor: 4500n }),
    Object.freeze({ upToCount: 300, pricePerRegistrationMinor: 4000n }),
    Object.freeze({ upToCount: 350, pricePerRegistrationMinor: 3500n }),
    Object.freeze({ upToCount: null, pricePerRegistrationMinor: 3000n }),
]);
/**
 * The approved docs/19 tier snapshot, in EGP minor units (piasters).
 *
 * EGP 2000 base / 50 registrations included: 200000 minor.
 * Teacher tiers 50, 45, 40, 35 EGP: 5000, 4500, 4000, 3500 minor.
 * Center base 7000 / 200 included: 700000 minor.
 * Center tiers 45, 40, 35, 30 EGP: 4500, 4000, 3500, 3000 minor.
 *
 * This is data only. The engine receives it as an argument and never reads it
 * implicitly.
 */
exports.DEFAULT_PRICE_VERSION = Object.freeze({
    id: 'docs19-2026-10-20',
    currency: 'EGP',
    minorUnitsPerMajor: 100n,
    schedules: Object.freeze({
        teacher: Object.freeze({
            includedRegistrations: 50,
            baseAmountMinor: 200000n,
            tiers: DEFAULT_TEACHER_TIERS,
        }),
        center: Object.freeze({
            includedRegistrations: 200,
            baseAmountMinor: 700000n,
            tiers: DEFAULT_CENTER_TIERS,
        }),
    }),
});
