import assert from 'node:assert/strict';
import test from 'node:test';
import {
    DEFAULT_PRICE_VERSION,
    type BillingOrganization,
    type PriceVersion,
} from '../src/services/billing-pricing';
import {
    buildTenantCountTimelines,
    countUniqueUsersAt,
    type ActivationEvent,
} from '../src/services/billing-basis';
import {
    CYCLE_SECONDS,
    NINETY_SIX_HOURS_SECONDS,
    buildCycleWindows,
    prorateCycle,
    type BillingWindow,
    type ProrationResult,
    type ProrationSegment,
} from '../src/services/billing-periods';

function windows(start: unknown, count: unknown): readonly BillingWindow[] {
    const result = buildCycleWindows(start, count);
    if (!result.ok) assert.fail(`${result.error.code}: ${result.error.message}`);
    return result.value;
}

function prorate(
    version: unknown,
    organization: unknown,
    window: unknown,
    segments: unknown,
): ReturnType<typeof prorateCycle> {
    return prorateCycle(
        version as PriceVersion,
        organization as BillingOrganization,
        window as BillingWindow,
        segments as readonly ProrationSegment[],
    );
}

function prorated(
    version: unknown,
    organization: unknown,
    window: unknown,
    segments: unknown,
): ProrationResult {
    const result = prorate(version, organization, window, segments);
    if (!result.ok) assert.fail(`${result.error.code}: ${result.error.message}`);
    return result.value;
}

const CUSTOM_PRICE_VERSION: PriceVersion = {
    id: 'rounding-probe-v1',
    currency: 'EGP',
    minorUnitsPerMajor: 100n,
    schedules: {
        teacher: {
            includedRegistrations: 0,
            baseAmountMinor: 0n,
            tiers: [{ upToCount: null, pricePerRegistrationMinor: 1n }],
        },
        center: {
            includedRegistrations: 0,
            baseAmountMinor: 0n,
            tiers: [{ upToCount: null, pricePerRegistrationMinor: 1n }],
        },
    },
};

test('cycle and grace constants match docs/19', () => {
    assert.equal(CYCLE_SECONDS, 2_592_000);
    assert.equal(NINETY_SIX_HOURS_SECONDS, 345_600);
    assert.equal(NINETY_SIX_HOURS_SECONDS, 96 * 60 * 60);
});

test('cycle windows are consecutive 30-day half-open UTC intervals', () => {
    const result = windows(1_700_000_000, 2);
    assert.deepEqual(result, [
        { start: 1_700_000_000, end: 1_700_000_000 + CYCLE_SECONDS },
        { start: 1_700_000_000 + CYCLE_SECONDS, end: 1_700_000_000 + 2 * CYCLE_SECONDS },
    ]);
    assert.deepEqual(windows(0, 0), []);
    assert.equal(windows(0n, 1n).length, 1);
});

test('cycle windows reject invalid start/count', () => {
    for (const start of [-1, 1.5, Number.NaN, '0']) {
        const result = buildCycleWindows(start, 1);
        assert.equal(result.ok, false);
        if (!result.ok) assert.equal(result.error.code, 'invalid_start');
    }
    for (const count of [-1, 1.5, Number.NaN, '1']) {
        const result = buildCycleWindows(0, count);
        assert.equal(result.ok, false);
        if (!result.ok) assert.equal(result.error.code, 'invalid_cycle_count');
    }
});

test('a 51st registration active for exactly one hour prorates to 2000.07 EGP', () => {
    const window = windows(0, 1)[0];
    const result = prorated(DEFAULT_PRICE_VERSION, 'teacher', window, [
        { start: 0, end: CYCLE_SECONDS - 3600, registrationCount: 50 },
        { start: CYCLE_SECONDS - 3600, end: CYCLE_SECONDS, registrationCount: 51 },
    ]);

    assert.equal(result.roundedMinor, 200_007n);
    assert.equal(result.roundedMinor, 2000n * 100n + 7n);
    assert.equal(
        result.exactNumeratorMinorSeconds,
        200_000n * 2_592_000n + 5_000n * 3_600n,
    );
    assert.equal(result.exactDenominatorSeconds, 2_592_000n);
});

test('50 registrations then the 51st for the second half of the cycle is 2025 EGP', () => {
    const window = windows(0, 1)[0];
    const half = CYCLE_SECONDS / 2;
    const result = prorated(DEFAULT_PRICE_VERSION, 'teacher', window, [
        { start: 0, end: half, registrationCount: 50 },
        { start: half, end: CYCLE_SECONDS, registrationCount: 51 },
    ]);

    assert.equal(result.roundedMinor, 202_500n);
});

test('a center with 200 unique students for a full cycle pays the 7000 EGP base', () => {
    const window = windows(0, 1)[0];
    const result = prorated(DEFAULT_PRICE_VERSION, 'center', window, [
        { start: 0, end: CYCLE_SECONDS, registrationCount: 200 },
    ]);

    assert.equal(result.roundedMinor, 700_000n);
});

test('basis union feeds pricing: 200 students x 3 teachers -> 200 -> 7000 EGP', () => {
    const events: ActivationEvent[] = [];
    for (let student = 0; student < 200; student += 1) {
        for (let teacher = 0; teacher < 3; teacher += 1) {
            events.push({
                tenantId: 'center-a',
                userId: `student-${student}`,
                teacherId: `teacher-${teacher}`,
                start: 0,
                end: CYCLE_SECONDS,
            });
        }
    }

    const timelines = buildTenantCountTimelines(events);
    if (!timelines.ok) assert.fail(`${timelines.error.code}: ${timelines.error.message}`);
    assert.equal(timelines.value.length, 1);

    const count = countUniqueUsersAt(timelines.value[0], 0);
    if (!count.ok) assert.fail(`${count.error.code}: ${count.error.message}`);
    assert.equal(count.value, 200);

    const window = windows(0, 1)[0];
    const result = prorated(DEFAULT_PRICE_VERSION, 'center', window, [
        { start: window.start, end: window.end, registrationCount: count.value },
    ]);
    assert.equal(result.roundedMinor, 700_000n);
});

test('center C(351) is 13030 EGP and not 13000 EGP', () => {
    const window = windows(0, 1)[0];
    const result = prorated(DEFAULT_PRICE_VERSION, 'center', window, [
        { start: 0, end: CYCLE_SECONDS, registrationCount: 351 },
    ]);

    assert.equal(result.roundedMinor, 1_303_000n);
    assert.notEqual(result.roundedMinor, 1_300_000n);
});

test('the integral is rounded HALF_UP exactly once at the end', () => {
    const window = windows(0, 1)[0];
    const third = CYCLE_SECONDS / 3;
    const result = prorated(CUSTOM_PRICE_VERSION, 'teacher', window, [
        { start: 0, end: third, registrationCount: 1 },
        { start: third, end: third * 2, registrationCount: 1 },
        { start: third * 2, end: CYCLE_SECONDS, registrationCount: 1 },
    ]);

    assert.equal(result.exactNumeratorMinorSeconds, 2_592_000n);
    assert.equal(result.roundedMinor, 1n);
});

test('exact half rounds up and just below half rounds down', () => {
    const window = windows(0, 1)[0];
    const half = CYCLE_SECONDS / 2;

    const halfUp = prorated(CUSTOM_PRICE_VERSION, 'teacher', window, [
        { start: 0, end: half, registrationCount: 1 },
        { start: half, end: CYCLE_SECONDS, registrationCount: 0 },
    ]);
    assert.equal(halfUp.exactNumeratorMinorSeconds, 1_296_000n);
    assert.equal(halfUp.roundedMinor, 1n);

    const belowHalf = prorated(CUSTOM_PRICE_VERSION, 'teacher', window, [
        { start: 0, end: half - 1, registrationCount: 1 },
        { start: half - 1, end: CYCLE_SECONDS, registrationCount: 0 },
    ]);
    assert.equal(belowHalf.exactNumeratorMinorSeconds, 1_295_999n);
    assert.equal(belowHalf.roundedMinor, 0n);
});

test('proration rejects malformed windows, segments and snapshots with typed errors', () => {
    const validWindow = windows(0, 1)[0];
    const validSegments: ProrationSegment[] = [
        { start: 0, end: CYCLE_SECONDS, registrationCount: 50 },
    ];

    const invalidWindowCases: unknown[] = [
        null,
        { start: 0, end: CYCLE_SECONDS - 1 },
        { start: -1, end: CYCLE_SECONDS - 1 },
        { start: 0, end: 1.5 },
        { start: 5, end: 4 },
    ];
    for (const window of invalidWindowCases) {
        const result = prorate(DEFAULT_PRICE_VERSION, 'teacher', window, validSegments);
        assert.equal(result.ok, false);
        if (!result.ok) assert.equal(result.error.code, 'invalid_window');
    }

    const invalidSegmentCases: Array<{ segments: unknown; code: string }> = [
        { segments: [], code: 'invalid_segments' },
        { segments: null, code: 'invalid_segments' },
        { segments: [{ start: 0, end: CYCLE_SECONDS, registrationCount: -1 }], code: 'invalid_segment' },
        { segments: [{ start: 0, end: CYCLE_SECONDS, registrationCount: 1.5 }], code: 'invalid_segment' },
        { segments: [{ start: 0, end: CYCLE_SECONDS, registrationCount: 1, extra: true }, { start: 0, end: CYCLE_SECONDS, registrationCount: 0 }], code: 'invalid_segments' },
        { segments: [{ start: 0, end: CYCLE_SECONDS / 2, registrationCount: 1 }, { start: CYCLE_SECONDS / 2 + 1, end: CYCLE_SECONDS, registrationCount: 1 }], code: 'invalid_segments' },
        { segments: [{ start: 0, end: CYCLE_SECONDS / 2, registrationCount: 1 }, { start: CYCLE_SECONDS / 2 - 1, end: CYCLE_SECONDS, registrationCount: 1 }], code: 'invalid_segments' },
        { segments: [{ start: 10, end: CYCLE_SECONDS, registrationCount: 1 }], code: 'invalid_segments' },
        { segments: [{ start: 0, end: CYCLE_SECONDS - 1, registrationCount: 1 }], code: 'invalid_segments' },
        { segments: [{ start: CYCLE_SECONDS, end: CYCLE_SECONDS + 10, registrationCount: 1 }], code: 'invalid_segments' },
    ];
    for (const testCase of invalidSegmentCases) {
        const result = prorate(DEFAULT_PRICE_VERSION, 'teacher', validWindow, testCase.segments);
        assert.equal(result.ok, false);
        if (!result.ok) assert.equal(result.error.code, testCase.code);
    }

    const badVersion = prorate({ ...DEFAULT_PRICE_VERSION, id: '' }, 'teacher', validWindow, validSegments);
    assert.equal(badVersion.ok, false);
    if (!badVersion.ok) assert.equal(badVersion.error.code, 'pricing_error');

    const badOrganization = prorate(DEFAULT_PRICE_VERSION, 'vendor', validWindow, validSegments);
    assert.equal(badOrganization.ok, false);
    if (!badOrganization.ok) assert.equal(badOrganization.error.code, 'pricing_error');
});
