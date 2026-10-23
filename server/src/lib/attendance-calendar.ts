/**
 * Attendance business-day calendar — Africa/Cairo.
 *
 * Human-approved M1 contract (supervisor/026): Africa/Cairo is the
 * authoritative attendance business timezone for attendance defaults,
 * instant-to-day conversion and scheduled-weekday/previous-scheduled-day
 * decisions. The frontend mirror lives in `src/lib/attendance-calendar.ts`;
 * `server/tests/m1-attendance-calendar.test.ts` exercises this module
 * directly.
 *
 * Semantics:
 *  - `todayDayKey` is the current calendar day in Africa/Cairo — never the
 *    UTC or host-local day — so the server default matches every operator's
 *    page;
 *  - `instantToDayKey` converts a Date or datetime string to the Cairo
 *    calendar day it denotes, DST-aware through runtime `Intl` — no hardcoded
 *    UTC+2/+3 offsets and no host-local date arithmetic;
 *  - `normalizeAttendanceDay` preserves an explicit YYYY-MM-DD key unchanged
 *    after validating it is a real calendar date (2026-02-30 is rejected
 *    instead of silently rolling over); Date/datetime inputs convert to the
 *    Cairo day;
 *  - schedule decisions (`previousScheduledDayKey`, `isScheduledOnDayKey`) are
 *    pure calendar arithmetic over Sunday-first weekday names.
 *
 * No dotenv, no database, no network: safe to import from routes and
 * hermetic tests alike.
 */

/** Authoritative attendance business timezone (human-approved, supervisor/026). */
export const ATTENDANCE_TIMEZONE = 'Africa/Cairo';

/** Calendar day key shape: strict YYYY-MM-DD. */
const DAY_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * ISO-8601 datetime with an EXPLICIT timezone/offset (Z or ±HH:MM), seconds
 * and fractional seconds optional. A datetime string without an offset is
 * parsed host-locally by `Date`, so it never reaches this helper — it is
 * rejected rather than silently producing a host-dependent day.
 */
const EXPLICIT_INSTANT_PATTERN =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;

/** Sunday-first weekday names, matching the `groups.schedule_days` JSON values. */
const WEEKDAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;

const cairoDayFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: ATTENDANCE_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
});

const pad2 = (value: number): string => String(value).padStart(2, '0');

/** Strict calendar-day validation: a real YYYY-MM-DD, never a rollover. */
export const isValidDayKey = (value: unknown): value is string => {
    if (typeof value !== 'string' || !DAY_KEY_PATTERN.test(value)) return false;
    const year = Number(value.slice(0, 4));
    const month = Number(value.slice(5, 7));
    const day = Number(value.slice(8, 10));
    if (month < 1 || month > 12 || day < 1 || day > 31) return false;
    // Round-trip through UTC so an impossible calendar date (2026-02-30) is
    // rejected instead of being coerced to a neighbouring real day.
    const probe = new Date(Date.UTC(year, month - 1, day));
    return probe.getUTCFullYear() === year && probe.getUTCMonth() === month - 1 && probe.getUTCDate() === day;
};

/**
 * True when the string is a well-formed ISO datetime carrying an explicit
 * timezone/offset whose calendar date and clock components are real — no
 * rollover (2026-02-30), no impossible time (25:00), no host-dependent
 * offsetless parsing.
 */
const isExplicitInstant = (value: string): boolean => {
    const match = EXPLICIT_INSTANT_PATTERN.exec(value);
    if (!match) return false;
    const [, year, month, day, hour, minute, second] = match;
    if (Number(hour) > 23 || Number(minute) > 59) return false;
    if (second !== undefined && Number(second) > 59) return false;
    return isValidDayKey(`${year}-${month}-${day}`);
};

/**
 * The Cairo calendar day an instant denotes, or null when the value is not a
 * usable instant. DST transitions are handled by the runtime timezone data
 * through `Intl`, so Egypt's 2026-04-24 DST start converts correctly.
 *
 * Accepted string forms: a strict day key (UTC midnight — deterministic, the
 * form this server stores) or an explicit-offset ISO datetime with real
 * components. Offsetless datetimes and impossible dates are rejected, never
 * rolled over and never parsed host-locally.
 */
export const instantToDayKey = (instant: Date | string | number): string | null => {
    let date: Date;
    if (instant instanceof Date) {
        date = instant;
    } else if (typeof instant === 'number') {
        date = new Date(instant);
    } else if (typeof instant === 'string' && DAY_KEY_PATTERN.test(instant)) {
        if (!isValidDayKey(instant)) return null;
        date = new Date(`${instant}T00:00:00Z`);
    } else if (typeof instant === 'string' && isExplicitInstant(instant)) {
        date = new Date(instant);
    } else {
        return null;
    }
    if (Number.isNaN(date.getTime())) return null;
    const parts = cairoDayFormatter.formatToParts(date);
    const pick = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
    const day = `${pick('year')}-${pick('month')}-${pick('day')}`;
    return DAY_KEY_PATTERN.test(day) ? day : null;
};

/** The current Cairo calendar day; `now` is injectable for tests. */
export const todayDayKey = (now: Date = new Date()): string => {
    const day = instantToDayKey(now);
    if (!day) throw new Error('attendance calendar: current instant is not a usable date');
    return day;
};

/**
 * Normalize any accepted attendance date input to the Cairo calendar day it
 * denotes: explicit YYYY-MM-DD keys are validated and preserved unchanged,
 * Date/datetime inputs convert to the Cairo day, and anything unusable
 * returns null (callers must reject rather than coerce).
 */
export const normalizeAttendanceDay = (value: unknown): string | null => {
    if (value instanceof Date) return instantToDayKey(value);
    if (typeof value !== 'string' || value === '') return null;
    if (DAY_KEY_PATTERN.test(value)) return isValidDayKey(value) ? value : null;
    return instantToDayKey(value);
};

/**
 * Parse `groups.schedule_days` (JSON string or array of weekday names) into
 * Sunday-first weekday numbers. Unusable input yields an empty list — a JSON
 * string that parses to a non-array (null, {}, 42, "sun") is an empty
 * schedule, never a TypeError.
 */
export const parseScheduleWeekdays = (scheduleDays: unknown): number[] => {
    let days: unknown = null;
    if (typeof scheduleDays === 'string') {
        try {
            days = JSON.parse(scheduleDays);
        } catch {
            return [];
        }
    } else if (Array.isArray(scheduleDays)) {
        days = scheduleDays;
    }
    if (!Array.isArray(days)) return [];
    return days
        .map((d) => (typeof d === 'string' ? WEEKDAY_NAMES.indexOf(d.toLowerCase() as (typeof WEEKDAY_NAMES)[number]) : -1))
        .filter((n) => n >= 0);
};

/** Weekday (0 = Sunday) of a calendar day key — pure calendar arithmetic. */
export const weekdayOfDayKey = (dayKey: string): number => {
    const anchored = new Date(Date.UTC(Number(dayKey.slice(0, 4)), Number(dayKey.slice(5, 7)) - 1, Number(dayKey.slice(8, 10)), 12));
    return anchored.getUTCDay();
};

/** Is the calendar day's weekday inside the schedule? */
export const isScheduledOnDayKey = (dayKey: string, scheduleWeekdays: readonly number[]): boolean =>
    scheduleWeekdays.includes(weekdayOfDayKey(dayKey));

/**
 * The most recent scheduled weekday strictly before `referenceDayKey`,
 * walking back at most `maxLookback` calendar days, or null when none.
 * Pure calendar arithmetic: the weekday of a calendar day is well defined
 * without any timezone, so only the reference day must come from Cairo.
 */
export const previousScheduledDayKey = (
    referenceDayKey: string,
    scheduleWeekdays: readonly number[],
    maxLookback = 14,
): string | null => {
    if (!isValidDayKey(referenceDayKey) || scheduleWeekdays.length === 0) return null;
    const reference = new Date(Date.UTC(Number(referenceDayKey.slice(0, 4)), Number(referenceDayKey.slice(5, 7)) - 1, Number(referenceDayKey.slice(8, 10)), 12));
    for (let back = 1; back <= maxLookback; back += 1) {
        const candidate = new Date(reference);
        candidate.setUTCDate(candidate.getUTCDate() - back);
        if (scheduleWeekdays.includes(candidate.getUTCDay())) {
            return `${candidate.getUTCFullYear()}-${pad2(candidate.getUTCMonth() + 1)}-${pad2(candidate.getUTCDate())}`;
        }
    }
    return null;
};
