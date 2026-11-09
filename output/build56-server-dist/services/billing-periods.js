"use strict";
/**
 * C7a / FIN1 — UTC 30-day billing periods and exact proration
 * (docs/19 lines 37-54 and 111).
 *
 * A cycle is exactly 2,592,000 seconds (30 days). Windows are half-open UTC
 * intervals `[start, end)` built from an arbitrary start instant; no calendar
 * month, local time or DST rule is consulted. All interval and money
 * arithmetic is bigint, so the same segments always produce the same result.
 *
 * Proration integrates the cumulative tier price over the change-point
 * segments of a full cycle:
 *
 *   sum(priceMinor(count_i) * duration_i) / 2,592,000
 *
 * The sum is kept as an exact rational numerator over 2,592,000 and is rounded
 * HALF_UP exactly once, at the end, to whole minor units. There is no
 * intermediate rounding and no floating-point division.
 *
 * This module performs no I/O, no collection, no grace enforcement and no
 * persistence. The 96-hour constant is exported for later use only.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.MAX_CYCLE_COUNT = exports.NINETY_SIX_HOURS_SECONDS = exports.CYCLE_SECONDS = void 0;
exports.buildCycleWindows = buildCycleWindows;
exports.prorateCycle = prorateCycle;
const billing_pricing_1 = require("./billing-pricing");
/** 30 days in seconds. */
exports.CYCLE_SECONDS = 2592000;
/** Approved difference-payment grace duration (96 hours), exported for later use. */
exports.NINETY_SIX_HOURS_SECONDS = 345600;
/** Bound a single window request to keep the pure engine predictable. */
exports.MAX_CYCLE_COUNT = 1200;
const MAX_SAFE_SECONDS = BigInt(Number.MAX_SAFE_INTEGER);
const CYCLE_SECONDS_BIGINT = BigInt(exports.CYCLE_SECONDS);
function failure(code, message, segmentIndex) {
    const error = segmentIndex === undefined
        ? { code, message }
        : { code, message, segmentIndex };
    return { ok: false, error };
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function normalizeSeconds(value) {
    if (typeof value === 'number') {
        if (!Number.isSafeInteger(value) || value < 0)
            return null;
        return BigInt(value);
    }
    if (typeof value === 'bigint') {
        if (value < 0n || value > MAX_SAFE_SECONDS)
            return null;
        return value;
    }
    return null;
}
function normalizeCount(value) {
    if (typeof value === 'number') {
        if (!Number.isSafeInteger(value) || value < 0)
            return null;
        return BigInt(value);
    }
    if (typeof value === 'bigint') {
        if (value < 0n || value > MAX_SAFE_SECONDS)
            return null;
        return value;
    }
    return null;
}
function toSafeSeconds(value) {
    if (value < 0n || value > MAX_SAFE_SECONDS)
        return null;
    return Number(value);
}
/**
 * Build consecutive 30-day UTC cycles from `start`.
 *
 * Cycle i is `[start + i*2,592,000, start + (i+1)*2,592,000)`. A count of 0
 * returns an empty array. Any fractional/negative start or count is rejected.
 */
function buildCycleWindows(start, count) {
    const startSeconds = normalizeSeconds(start);
    if (startSeconds === null) {
        return failure('invalid_start', 'start must be a non-negative integer second');
    }
    const cycleCount = normalizeCount(count);
    if (cycleCount === null || cycleCount > BigInt(exports.MAX_CYCLE_COUNT)) {
        return failure('invalid_cycle_count', `cycle count must be an integer between 0 and ${exports.MAX_CYCLE_COUNT}`);
    }
    const windows = [];
    for (let index = 0n; index < cycleCount; index += 1n) {
        const windowStart = startSeconds + index * CYCLE_SECONDS_BIGINT;
        const windowEnd = windowStart + CYCLE_SECONDS_BIGINT;
        const safeStart = toSafeSeconds(windowStart);
        const safeEnd = toSafeSeconds(windowEnd);
        if (safeStart === null || safeEnd === null) {
            return failure('invalid_cycle_count', 'requested cycles exceed the safe integer second range');
        }
        windows.push(Object.freeze({ start: safeStart, end: safeEnd }));
    }
    return { ok: true, value: Object.freeze(windows) };
}
function parseWindow(input) {
    if (!isRecord(input)) {
        return failure('invalid_window', 'window must be an object');
    }
    const start = normalizeSeconds(input['start']);
    const end = normalizeSeconds(input['end']);
    if (start === null || end === null) {
        return failure('invalid_window', 'window start and end must be non-negative integer seconds');
    }
    if (end - start !== CYCLE_SECONDS_BIGINT) {
        return failure('invalid_window', `window must be exactly ${exports.CYCLE_SECONDS} seconds`);
    }
    const safeStart = toSafeSeconds(start);
    const safeEnd = toSafeSeconds(end);
    if (safeStart === null || safeEnd === null) {
        return failure('invalid_window', 'window exceeds the safe integer second range');
    }
    return { ok: true, value: Object.freeze({ start: safeStart, end: safeEnd }) };
}
function parseSegments(input, window) {
    if (!Array.isArray(input) || input.length === 0) {
        return failure('invalid_segments', 'segments must be a non-empty array');
    }
    const windowStart = BigInt(window.start);
    const windowEnd = BigInt(window.end);
    const segments = [];
    let cursor = windowStart;
    for (let index = 0; index < input.length; index += 1) {
        const raw = input[index];
        if (!isRecord(raw)) {
            return failure('invalid_segment', `segment ${index} must be an object`, index);
        }
        const start = normalizeSeconds(raw['start']);
        const end = normalizeSeconds(raw['end']);
        const count = normalizeCount(raw['registrationCount']);
        if (start === null || end === null) {
            return failure('invalid_segment', `segment ${index} start and end must be non-negative integer seconds`, index);
        }
        if (count === null) {
            return failure('invalid_segment', `segment ${index} registrationCount must be a non-negative integer`, index);
        }
        if (end <= start) {
            return failure('invalid_segment', `segment ${index} end must be greater than start`, index);
        }
        if (start !== cursor) {
            return failure('invalid_segments', 'segments must be sorted, contiguous and non-overlapping', index);
        }
        if (end > windowEnd) {
            return failure('invalid_segments', 'segments must stay inside the billing window', index);
        }
        segments.push({ start, end, registrationCount: count });
        cursor = end;
    }
    if (cursor !== windowEnd) {
        return failure('invalid_segments', 'segments must cover the full cycle');
    }
    return { ok: true, value: Object.freeze(segments) };
}
/** HALF_UP integer division over bigint; the denominator must be positive. */
function divideHalfUp(numerator, denominator) {
    if (denominator <= 0n) {
        throw new Error('denominator must be positive');
    }
    const magnitude = numerator < 0n ? -numerator : numerator;
    const quotient = magnitude / denominator;
    const remainder = magnitude % denominator;
    const rounded = remainder * 2n >= denominator ? quotient + 1n : quotient;
    return numerator < 0n ? -rounded : rounded;
}
/**
 * Prorate one complete cycle over change-point segments.
 *
 * Segments must be sorted, contiguous, non-overlapping and cover the window
 * exactly. Gaps, overlaps and unsorted input are rejected rather than guessed.
 * The result keeps the exact rational numerator, so callers can audit the
 * single final HALF_UP rounding.
 */
function prorateCycle(priceVersion, organization, window, segments) {
    const parsedWindow = parseWindow(window);
    if (!parsedWindow.ok)
        return parsedWindow;
    const parsedSegments = parseSegments(segments, parsedWindow.value);
    if (!parsedSegments.ok)
        return parsedSegments;
    let numerator = 0n;
    for (let index = 0; index < parsedSegments.value.length; index += 1) {
        const segment = parsedSegments.value[index];
        const price = (0, billing_pricing_1.calculatePriceMinor)(priceVersion, organization, segment.registrationCount);
        if (!price.ok) {
            return failure('pricing_error', price.error.message, index);
        }
        const duration = segment.end - segment.start;
        numerator += price.value * duration;
    }
    const roundedMinor = divideHalfUp(numerator, CYCLE_SECONDS_BIGINT);
    return {
        ok: true,
        value: Object.freeze({
            priceVersionId: priceVersion.id,
            organization,
            window: parsedWindow.value,
            roundedMinor,
            exactNumeratorMinorSeconds: numerator,
            exactDenominatorSeconds: CYCLE_SECONDS_BIGINT,
        }),
    };
}
