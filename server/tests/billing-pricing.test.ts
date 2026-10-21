import assert from 'node:assert/strict';
import test from 'node:test';
import {
    DEFAULT_PRICE_VERSION,
    calculateCenterPriceMinor,
    calculatePriceMinor,
    calculateTeacherPriceMinor,
    validatePriceVersion,
    type PriceVersion,
} from '../src/services/billing-pricing';

/** EGP piasters: one major unit = 100 minor units. */
const MINOR_PER_UNIT = 100n;

function teacherMinor(count: unknown): bigint {
    const result = calculateTeacherPriceMinor(DEFAULT_PRICE_VERSION, count);
    if (!result.ok) assert.fail(`${result.error.code}: ${result.error.message}`);
    return result.value;
}

function centerMinor(count: unknown): bigint {
    const result = calculateCenterPriceMinor(DEFAULT_PRICE_VERSION, count);
    if (!result.ok) assert.fail(`${result.error.code}: ${result.error.message}`);
    return result.value;
}

function units(amountMinor: bigint): bigint {
    return amountMinor / MINOR_PER_UNIT;
}

const CUSTOM_PRICE_VERSION: PriceVersion = {
    id: 'custom-v1',
    currency: 'EGP',
    minorUnitsPerMajor: 100n,
    schedules: {
        teacher: {
            includedRegistrations: 0,
            baseAmountMinor: 1000n,
            tiers: [{ upToCount: null, pricePerRegistrationMinor: 10n }],
        },
        center: {
            includedRegistrations: 2,
            baseAmountMinor: 2000n,
            tiers: [{ upToCount: null, pricePerRegistrationMinor: 20n }],
        },
    },
};

test('teacher formula: approved docs/19 values', () => {
    assert.equal(teacherMinor(0), 2000n * MINOR_PER_UNIT);
    assert.equal(teacherMinor(50), 2000n * MINOR_PER_UNIT);
    assert.equal(teacherMinor(51), 2050n * MINOR_PER_UNIT);
    assert.equal(teacherMinor(100), 4500n * MINOR_PER_UNIT);
    assert.equal(teacherMinor(150), 6750n * MINOR_PER_UNIT);
    assert.equal(teacherMinor(200), 8750n * MINOR_PER_UNIT);
    assert.equal(teacherMinor(500), 19250n * MINOR_PER_UNIT);
    assert.equal(units(teacherMinor(500)), 19250n);
});

test('center formula: approved docs/19 values including C(351) = 13030', () => {
    assert.equal(centerMinor(0), 7000n * MINOR_PER_UNIT);
    assert.equal(centerMinor(200), 7000n * MINOR_PER_UNIT);
    assert.equal(centerMinor(201), 7045n * MINOR_PER_UNIT);
    assert.equal(centerMinor(250), 9250n * MINOR_PER_UNIT);
    assert.equal(centerMinor(300), 11250n * MINOR_PER_UNIT);
    assert.equal(centerMinor(350), 13000n * MINOR_PER_UNIT);
    assert.equal(centerMinor(351), 13030n * MINOR_PER_UNIT);
    assert.notEqual(centerMinor(351), 13000n * MINOR_PER_UNIT);
    assert.equal(centerMinor(500), 17500n * MINOR_PER_UNIT);
});

test('teacher and center cumulative tiers match the closed form for 0..500', () => {
    const bigMin = (left: bigint, right: bigint): bigint => (left < right ? left : right);
    const bigMax = (left: bigint, right: bigint): bigint => (left > right ? left : right);
    const teacherClosedForm = (raw: bigint): bigint => {
        const n = raw;
        const clamp = (value: bigint, upper: bigint): bigint => bigMin(bigMax(value, 0n), upper);
        return 2000n
            + 50n * clamp(n - 50n, 50n)
            + 45n * clamp(n - 100n, 50n)
            + 40n * clamp(n - 150n, 50n)
            + 35n * bigMax(n - 200n, 0n);
    };
    const centerClosedForm = (raw: bigint): bigint => {
        const n = raw;
        const clamp = (value: bigint, upper: bigint): bigint => bigMin(bigMax(value, 0n), upper);
        return 7000n
            + 45n * clamp(n - 200n, 50n)
            + 40n * clamp(n - 250n, 50n)
            + 35n * clamp(n - 300n, 50n)
            + 30n * bigMax(n - 350n, 0n);
    };

    for (let count = 0; count <= 500; count += 1) {
        const n = BigInt(count);
        assert.equal(units(teacherMinor(count)), teacherClosedForm(n), `teacher n=${count}`);
        assert.equal(units(centerMinor(count)), centerClosedForm(n), `center n=${count}`);
    }
});

test('pricing engine reads the injected snapshot, not a global', () => {
    assert.equal(calculateTeacherPriceMinor(CUSTOM_PRICE_VERSION, 0).ok, true);
    assert.equal(teacherCustom(0), 1000n);
    assert.equal(teacherCustom(3), 1030n);
    assert.equal(centerCustom(2), 2000n);
    assert.equal(centerCustom(5), 2060n);
});

function teacherCustom(count: unknown): bigint {
    const result = calculateTeacherPriceMinor(CUSTOM_PRICE_VERSION, count);
    if (!result.ok) assert.fail(`${result.error.code}: ${result.error.message}`);
    return result.value;
}

function centerCustom(count: unknown): bigint {
    const result = calculateCenterPriceMinor(CUSTOM_PRICE_VERSION, count);
    if (!result.ok) assert.fail(`${result.error.code}: ${result.error.message}`);
    return result.value;
}

test('default snapshot and its tier tables are frozen and validated', () => {
    assert.equal(Object.isFrozen(DEFAULT_PRICE_VERSION), true);
    assert.equal(Object.isFrozen(DEFAULT_PRICE_VERSION.schedules), true);
    assert.equal(Object.isFrozen(DEFAULT_PRICE_VERSION.schedules.teacher), true);
    assert.equal(Object.isFrozen(DEFAULT_PRICE_VERSION.schedules.teacher.tiers), true);
    assert.equal(Object.isFrozen(DEFAULT_PRICE_VERSION.schedules.teacher.tiers[0]), true);
    assert.equal(DEFAULT_PRICE_VERSION.id, 'docs19-2026-10-20');
    assert.equal(DEFAULT_PRICE_VERSION.schedules.teacher.includedRegistrations, 50);
    assert.equal(DEFAULT_PRICE_VERSION.schedules.center.includedRegistrations, 200);
    assert.deepEqual(validatePriceVersion(DEFAULT_PRICE_VERSION).ok, true);
});

test('registration counts accept non-negative integers and bigint, reject everything else', () => {
    assert.equal(calculateTeacherPriceMinor(DEFAULT_PRICE_VERSION, 51n).ok, true);
    for (const invalid of [-1, -1n, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '51', null, undefined]) {
        const result = calculateTeacherPriceMinor(DEFAULT_PRICE_VERSION, invalid);
        assert.equal(result.ok, false);
        if (!result.ok) assert.equal(result.error.code, 'invalid_registration_count');
    }
});

test('invalid price snapshots are rejected with a typed error', () => {
    const invalidSnapshots: unknown[] = [
        null,
        {},
        { ...DEFAULT_PRICE_VERSION, id: '' },
        { ...DEFAULT_PRICE_VERSION, currency: '' },
        { ...DEFAULT_PRICE_VERSION, minorUnitsPerMajor: 0n },
        {
            ...DEFAULT_PRICE_VERSION,
            schedules: {
                ...DEFAULT_PRICE_VERSION.schedules,
                teacher: {
                    includedRegistrations: 50,
                    baseAmountMinor: 200000n,
                    tiers: [{ upToCount: 100, pricePerRegistrationMinor: 5000n }],
                },
            },
        },
        {
            ...DEFAULT_PRICE_VERSION,
            schedules: {
                ...DEFAULT_PRICE_VERSION.schedules,
                teacher: {
                    includedRegistrations: 50,
                    baseAmountMinor: 200000n,
                    tiers: [
                        { upToCount: 100, pricePerRegistrationMinor: 5000n },
                        { upToCount: 100, pricePerRegistrationMinor: 4500n },
                        { upToCount: null, pricePerRegistrationMinor: 4000n },
                    ],
                },
            },
        },
        {
            ...DEFAULT_PRICE_VERSION,
            schedules: {
                ...DEFAULT_PRICE_VERSION.schedules,
                center: {
                    includedRegistrations: 200,
                    baseAmountMinor: 700000n,
                    tiers: [{ upToCount: null, pricePerRegistrationMinor: -1n }],
                },
            },
        },
    ];

    for (const snapshot of invalidSnapshots) {
        const result = validatePriceVersion(snapshot);
        assert.equal(result.ok, false);
        if (!result.ok) assert.equal(result.error.code, 'invalid_price_version');
    }
});

test('invalid organization is a typed error', () => {
    const result = calculatePriceMinor(DEFAULT_PRICE_VERSION, 'vendor', 10);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, 'invalid_organization');
});
