/**
 * C7a / FIN1 — billing basis: unique-user count as a union of activation
 * intervals (docs/19 lines 37-54, 60 and 111).
 *
 * Input is an immutable activation-event stream. For every tenant the engine
 * builds one timeline of the number of UNIQUE users whose eligible
 * student-teacher relation is active at each instant:
 *
 *  - events are grouped by tenant; a user can never be deduplicated across
 *    tenants (no cross-tenant discount);
 *  - inside one tenant all intervals of the same user are unioned across every
 *    teacher, so a student with three teachers counts once;
 *  - overlapping or adjacent intervals of the same user are one continuous
 *    interval and never double count;
 *  - change points are the sorted instants where that unique count changes,
 *    with the count of the half-open segment `[at, nextAt)`.
 *
 * Time is integer UTC epoch seconds. All interval arithmetic runs over bigint;
 * the module never uses local time, DST rules or floating-point arithmetic.
 *
 * This module performs no I/O, no authorization and no persistence.
 */

export interface ActivationEvent {
    readonly tenantId: string;
    readonly userId: string;
    readonly teacherId: string;
    /** Inclusive UTC epoch second. */
    readonly start: number;
    /** Exclusive UTC epoch second. */
    readonly end: number;
}

export interface CountChangePoint {
    readonly at: number;
    readonly count: number;
}

export interface TenantCountTimeline {
    readonly tenantId: string;
    /** Sorted, non-overlapping half-open segments `[at, next.at)`. */
    readonly changePoints: readonly CountChangePoint[];
}

export type BasisErrorCode =
    | 'invalid_events'
    | 'invalid_identifier'
    | 'invalid_instant'
    | 'invalid_interval'
    | 'invalid_timeline';

export interface BasisError {
    readonly code: BasisErrorCode;
    readonly message: string;
    readonly eventIndex?: number;
}

export type BasisResult<T> =
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly error: BasisError };

function failure<T>(
    code: BasisErrorCode,
    message: string,
    eventIndex?: number,
): BasisResult<T> {
    const error: BasisError = eventIndex === undefined
        ? { code, message }
        : { code, message, eventIndex };
    return { ok: false, error };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const MAX_IDENTIFIER_LENGTH = 128;
const MAX_SAFE_SECONDS = BigInt(Number.MAX_SAFE_INTEGER);

function normalizeIdentifier(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    if (value.length === 0 || value.length > MAX_IDENTIFIER_LENGTH) return null;
    if (value !== value.trim()) return null;
    if (/[\u0000-\u001f\u007f]/.test(value)) return null;
    return value;
}

function normalizeSeconds(value: unknown): bigint | null {
    if (typeof value === 'number') {
        if (!Number.isSafeInteger(value) || value < 0) return null;
        return BigInt(value);
    }
    if (typeof value === 'bigint') {
        if (value < 0n || value > MAX_SAFE_SECONDS) return null;
        return value;
    }
    return null;
}

function toSafeSeconds(value: bigint): number | null {
    if (value < 0n || value > MAX_SAFE_SECONDS) return null;
    return Number(value);
}

interface ParsedEvent {
    readonly tenantId: string;
    readonly userId: string;
    readonly teacherId: string;
    readonly start: bigint;
    readonly end: bigint;
}

function parseEvent(input: unknown, index: number): BasisResult<ParsedEvent> {
    if (!isRecord(input)) {
        return failure('invalid_events', `event ${index} must be an object`, index);
    }

    const tenantId = normalizeIdentifier(input['tenantId']);
    if (tenantId === null) {
        return failure('invalid_identifier', `event ${index} tenantId is invalid`, index);
    }
    const userId = normalizeIdentifier(input['userId']);
    if (userId === null) {
        return failure('invalid_identifier', `event ${index} userId is invalid`, index);
    }
    const teacherId = normalizeIdentifier(input['teacherId']);
    if (teacherId === null) {
        return failure('invalid_identifier', `event ${index} teacherId is invalid`, index);
    }

    const start = normalizeSeconds(input['start']);
    if (start === null) {
        return failure('invalid_instant', `event ${index} start must be a non-negative integer second`, index);
    }
    const end = normalizeSeconds(input['end']);
    if (end === null) {
        return failure('invalid_instant', `event ${index} end must be a non-negative integer second`, index);
    }
    if (end <= start) {
        return failure('invalid_interval', `event ${index} end must be greater than start`, index);
    }

    return { ok: true, value: { tenantId, userId, teacherId, start, end } };
}

interface Interval {
    start: bigint;
    end: bigint;
}

function unionIntervals(intervals: readonly Interval[]): Interval[] {
    const sorted = [...intervals].sort((left, right) => {
        if (left.start !== right.start) return left.start < right.start ? -1 : 1;
        if (left.end !== right.end) return left.end < right.end ? -1 : 1;
        return 0;
    });

    const merged: Interval[] = [];
    for (const interval of sorted) {
        const last = merged[merged.length - 1];
        if (last !== undefined && interval.start <= last.end) {
            if (interval.end > last.end) last.end = interval.end;
            continue;
        }
        merged.push({ start: interval.start, end: interval.end });
    }
    return merged;
}

function addDelta(deltas: Map<bigint, bigint>, instant: bigint, delta: bigint): void {
    deltas.set(instant, (deltas.get(instant) ?? 0n) + delta);
}

/**
 * Build deterministic per-tenant unique-user timelines.
 *
 * The input array may arrive in any order. Events with equal instants are
 * aggregated before the sweep, so an end and a start at the same instant keep
 * the count unchanged and do not create a spurious change point.
 */
export function buildTenantCountTimelines(input: unknown): BasisResult<readonly TenantCountTimeline[]> {
    if (!Array.isArray(input)) {
        return failure('invalid_events', 'events must be an array');
    }

    const byTenant = new Map<string, Map<string, Interval[]>>();
    for (let index = 0; index < input.length; index += 1) {
        const parsed = parseEvent(input[index], index);
        if (!parsed.ok) return parsed;
        const event = parsed.value;

        const users = byTenant.get(event.tenantId) ?? new Map<string, Interval[]>();
        const intervals = users.get(event.userId) ?? [];
        intervals.push({ start: event.start, end: event.end });
        users.set(event.userId, intervals);
        byTenant.set(event.tenantId, users);
    }

    const timelines: TenantCountTimeline[] = [];
    for (const [tenantId, users] of byTenant) {
        const deltas = new Map<bigint, bigint>();
        for (const intervals of users.values()) {
            for (const interval of unionIntervals(intervals)) {
                addDelta(deltas, interval.start, 1n);
                addDelta(deltas, interval.end, -1n);
            }
        }

        const instants = [...deltas.keys()].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
        const changePoints: CountChangePoint[] = [];
        let running = 0n;
        let previousCount: bigint | null = null;

        for (const instant of instants) {
            running += deltas.get(instant) ?? 0n;
            if (running < 0n) {
                return failure('invalid_timeline', `negative unique-user count in tenant ${tenantId}`);
            }
            if (previousCount === null || running !== previousCount) {
                const at = toSafeSeconds(instant);
                if (at === null) {
                    return failure('invalid_instant', `change point for tenant ${tenantId} is outside the safe integer range`);
                }
                if (running > MAX_SAFE_SECONDS) {
                    return failure('invalid_timeline', `unique-user count in tenant ${tenantId} is too large`);
                }
                changePoints.push(Object.freeze({ at, count: Number(running) }));
                previousCount = running;
            }
        }

        timelines.push(Object.freeze({
            tenantId,
            changePoints: Object.freeze(changePoints),
        }));
    }

    timelines.sort((left, right) => (
        left.tenantId < right.tenantId ? -1 : left.tenantId > right.tenantId ? 1 : 0
    ));
    return { ok: true, value: Object.freeze(timelines) };
}

/**
 * The unique-user count active in the half-open segment starting at `at`.
 * Returns 0 before the first activation and after the final expiry.
 */
export function countUniqueUsersAt(
    timeline: TenantCountTimeline,
    at: unknown,
): BasisResult<number> {
    const instant = normalizeSeconds(at);
    if (instant === null) {
        return failure('invalid_instant', 'at must be a non-negative integer second');
    }

    let count = 0;
    for (const point of timeline.changePoints) {
        const pointAt = BigInt(point.at);
        if (pointAt > instant) break;
        count = point.count;
    }
    return { ok: true, value: count };
}
