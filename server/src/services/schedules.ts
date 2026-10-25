/**
 * M5 G2 recurring schedules/calendar domain policy.
 *
 * Pure, deterministic and clock-free. This module validates/normalizes input,
 * expands a recurrence rule into absolute UTC occurrences, and decides
 * AUDIENCE visibility. It never reads the request, never resolves tenant/branch
 * authority and never performs I/O; the route layer composes it with the
 * verified principal, the server-owned tenant authority and the session rows.
 *
 * Recurrence model:
 *  - `weekly`  : one or more ISO weekdays (0=Sun..6=Sat) between `startsOn`
 *                and an inclusive `endsOn` (or up to a bounded horizon).
 *  - `monthly` : `dayOfMonth` 1..31, clamped to the last day of a shorter
 *                month (Feb 31 -> Feb 28/29, Apr 31 -> Apr 30). This is the
 *                month-end edge case.
 *
 * Each occurrence is authored as a local wall time in an IANA timezone and is
 * converted to an absolute UTC instant with the DST-correct offset, so a
 * weekly 09:00 Cairo/New York series shifts its UTC instant across a DST
 * boundary but keeps the same local wall time.
 *
 * Audience visibility is deny-by-default and reuses the C11 schedule audience
 * contract: `tenant` (whole tenant), `branch` (a proven branch) and `group`
 * (a proven group). A viewer with no matching branch/group never sees it.
 *
 * No `any`, no ts-ignore, no network, no runtime DDL.
 */

import { createHash } from 'node:crypto';
import {
    AudienceViewer,
    ScheduleAudience,
    ValidationResult,
    buildVisibleScheduleFilter,
    isScheduleVisibleTo,
    normalizeId,
    normalizeScheduleAudience,
    toMysqlUtc,
} from './announcements';
import { isValidTimeZone, localWallTimeToInstant } from './content-release';

export {
    buildVisibleScheduleFilter,
    isScheduleVisibleTo,
    normalizeId,
    normalizeScheduleAudience,
    toMysqlUtc,
};
export type { AudienceViewer, ScheduleAudience, ValidationResult };

export const RECURRENCE_KINDS = ['weekly', 'monthly'] as const;
export type RecurrenceKind = (typeof RECURRENCE_KINDS)[number];

export const SCHEDULE_SESSION_STATUSES = ['scheduled', 'cancelled'] as const;
export type ScheduleSessionStatus = (typeof SCHEDULE_SESSION_STATUSES)[number];

export const MAX_TITLE_LENGTH = 200;
export const MAX_REASON_LENGTH = 255;
export const MAX_DURATION_MINUTES = 24 * 60;
export const DEFAULT_MAX_OCCURRENCES = 366;
export const HARD_MAX_OCCURRENCES = 2000;

/* ------------------------------------------------------------------------- */
/* Series-creation idempotency                                               */
/* ------------------------------------------------------------------------- */

export const MIN_IDEMPOTENCY_KEY_LENGTH = 8;
export const MAX_IDEMPOTENCY_KEY_LENGTH = 200;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

/**
 * Normalize a client-supplied series-creation idempotency key. The key is a
 * caller-scoped opaque token (at least 8 characters, printable ASCII subset);
 * anything else is refused so a retry can never be silently de-duplicated
 * against an unrelated request.
 */
export function normalizeIdempotencyKey(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (trimmed.length < MIN_IDEMPOTENCY_KEY_LENGTH || trimmed.length > MAX_IDEMPOTENCY_KEY_LENGTH) return null;
    return IDEMPOTENCY_KEY_PATTERN.test(trimmed) ? trimmed : null;
}

export interface SeriesIdempotencyIdentity {
    tenantId: string;
    userId: string;
    idempotencyKey: string;
}

/**
 * Deterministic `schedule_series.id` for one idempotency key.
 *
 * The id is a name-based UUID (SHA-256 over tenant + author + key, RFC 4122
 * version 5 shape), so a retried creation targets the row the first attempt
 * already created instead of materializing a second series and a second set of
 * sessions. The key is scoped to the authoring user inside the tenant, so two
 * teachers can never collide on the same client token. Returns null when any
 * part is malformed so the caller fails closed.
 */
export function deterministicSeriesId(identity: SeriesIdempotencyIdentity): string | null {
    if (normalizeId(identity.tenantId) === null) return null;
    if (normalizeId(identity.userId) === null) return null;
    if (normalizeIdempotencyKey(identity.idempotencyKey) === null) return null;
    const digest = createHash('sha256')
        .update(['schedule-series', 'v1', identity.tenantId, identity.userId, identity.idempotencyKey].join('|'))
        .digest();
    const bytes = Buffer.from(digest.subarray(0, 16));
    bytes[6] = (bytes[6] & 0x0f) | 0x50;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = bytes.toString('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function normalizeRecurrenceKind(value: unknown): RecurrenceKind | null {
    if (typeof value !== 'string') return null;
    return (RECURRENCE_KINDS as readonly string[]).includes(value) ? (value as RecurrenceKind) : null;
}

export function normalizeSessionStatus(value: unknown): ScheduleSessionStatus | null {
    if (typeof value !== 'string') return null;
    return (SCHEDULE_SESSION_STATUSES as readonly string[]).includes(value)
        ? (value as ScheduleSessionStatus)
        : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// Calendar primitives
// ---------------------------------------------------------------------------

interface CalendarDate {
    year: number;
    month: number;
    day: number;
}

const CALENDAR_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const WALL_TIME_RE = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/;
/** Storable year range: the session columns are DATETIME (1000..9999). */
const MIN_STORABLE_YEAR = 1000;
const MAX_STORABLE_YEAR = 9999;
/** Requires an explicit time of day after the date (a bare date would silently become midnight). */
const WALL_TIME_OF_DAY_RE = /^\s*\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/;

function isStorableInstant(instant: Date): boolean {
    const year = instant.getUTCFullYear();
    return Number.isFinite(instant.getTime()) && year >= MIN_STORABLE_YEAR && year <= MAX_STORABLE_YEAR;
}

/** Whole number from a JSON number or a plain digit string; booleans/arrays/blank are rejected. */
function strictWholeNumber(value: unknown): number {
    if (typeof value === 'number') return value;
    if (typeof value === 'string' && /^\s*\d+\s*$/.test(value)) return Number(value);
    return Number.NaN;
}

export function daysInMonth(year: number, month: number): number {
    return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Parse a real `YYYY-MM-DD` calendar date; returns null for anything else. */
export function parseCalendarDate(value: unknown): CalendarDate | null {
    if (typeof value !== 'string') return null;
    const match = CALENDAR_DATE_RE.exec(value.trim());
    if (!match) return null;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    if (year < MIN_STORABLE_YEAR || year > MAX_STORABLE_YEAR) return null;
    if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null;
    return { year, month, day };
}

function pad(value: number): string {
    return String(value).padStart(2, '0');
}

function formatCalendarDate(date: CalendarDate): string {
    return `${date.year}-${pad(date.month)}-${pad(date.day)}`;
}

function normalizeWallTime(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const match = WALL_TIME_RE.exec(value.trim());
    if (!match) return null;
    const hour = Number(match[1]);
    const minute = Number(match[2]);
    const second = Number(match[3] ?? '0');
    // Seconds are not representable in the HH:MM recurrence; never drop them silently.
    if (hour > 23 || minute > 59 || second !== 0) return null;
    return `${pad(hour)}:${pad(minute)}`;
}

function compareCalendarDates(a: CalendarDate, b: CalendarDate): number {
    if (a.year !== b.year) return a.year - b.year;
    if (a.month !== b.month) return a.month - b.month;
    return a.day - b.day;
}

// ---------------------------------------------------------------------------
// Recurrence expansion
// ---------------------------------------------------------------------------

export interface RecurrenceRule {
    kind: RecurrenceKind;
    /** Weekly: ISO weekdays 0=Sun..6=Sat. Ignored for monthly. */
    weekdays: number[];
    /** Monthly: 1..31. Ignored for weekly. */
    dayOfMonth: number | null;
    /** First date to consider (inclusive), `YYYY-MM-DD`. */
    startsOn: string;
    /** Last date to consider (inclusive), `YYYY-MM-DD`, or null (open). */
    endsOn: string | null;
    /** Local wall time `HH:MM` in `timezone`. */
    startTime: string;
    durationMinutes: number;
    timezone: string;
}

export interface Occurrence {
    /** Absolute UTC instant, ISO 8601. */
    startsAt: string;
    /** Absolute UTC instant, ISO 8601. */
    endsAt: string;
}

/**
 * Resolution of one candidate date inside a recurrence rule:
 *  - `occurrence`          : a storable UTC occurrence;
 *  - `nonexistent-wall-time`: the authored local time does not exist in the
 *    timezone (DST spring-forward gap), so no instant may be scheduled;
 *  - `unstorable-instant`  : the instant falls outside the DATETIME-safe
 *    year range and is skipped.
 */
type OccurrenceResolution =
    | { kind: 'occurrence'; occurrence: Occurrence }
    | { kind: 'nonexistent-wall-time' }
    | { kind: 'unstorable-instant' };

function resolveOccurrence(
    date: CalendarDate,
    time: string,
    timezone: string,
    durationMinutes: number,
): OccurrenceResolution {
    const instant = localWallTimeToInstant(`${formatCalendarDate(date)} ${time}`, timezone);
    if (!instant) return { kind: 'nonexistent-wall-time' };
    const endsAt = new Date(instant.getTime() + durationMinutes * 60_000);
    if (!isStorableInstant(instant) || !isStorableInstant(endsAt)) return { kind: 'unstorable-instant' };
    return { kind: 'occurrence', occurrence: { startsAt: instant.toISOString(), endsAt: endsAt.toISOString() } };
}

export interface RecurrenceExpansion {
    occurrences: Occurrence[];
    /**
     * Dates inside [startsOn, endsOn] whose authored local wall time does not
     * exist in the rule's timezone (a DST spring-forward gap). A non-empty
     * list must be rejected by the caller BEFORE any write: scheduling the
     * silently-shifted earlier instant would move the session without the
     * author ever authoring that time.
     */
    nonexistentDates: string[];
}

/**
 * Expand a recurrence rule into absolute UTC occurrences, ordered ascending,
 * and report any DST-gap dates separately. Bounded by `limit` (capped at
 * HARD_MAX_OCCURRENCES) so a caller can never request an unbounded expansion.
 * An invalid rule yields no occurrences (deny-by-default rather than a
 * partially-materialized schedule).
 */
export function expandRecurrenceDetailed(rule: RecurrenceRule, limit: number = DEFAULT_MAX_OCCURRENCES): RecurrenceExpansion {
    const cap = Math.min(Math.max(0, Math.floor(limit)), HARD_MAX_OCCURRENCES);
    const occurrences: Occurrence[] = [];
    const nonexistentDates: string[] = [];
    if (cap === 0) return { occurrences, nonexistentDates };

    const start = parseCalendarDate(rule.startsOn);
    if (!start) return { occurrences, nonexistentDates };
    const end = rule.endsOn === null ? null : parseCalendarDate(rule.endsOn);
    if (rule.endsOn !== null && !end) return { occurrences, nonexistentDates };
    if (end && compareCalendarDates(end, start) < 0) return { occurrences, nonexistentDates };

    const time = normalizeWallTime(rule.startTime);
    if (!time) return { occurrences, nonexistentDates };
    if (!isValidTimeZone(rule.timezone)) return { occurrences, nonexistentDates };
    if (!Number.isInteger(rule.durationMinutes) || rule.durationMinutes <= 0 || rule.durationMinutes > MAX_DURATION_MINUTES) return { occurrences, nonexistentDates };
    if (!Number.isInteger(limit) && !Number.isFinite(limit)) return { occurrences, nonexistentDates };

    const pushDate = (date: CalendarDate): boolean => {
        const resolution = resolveOccurrence(date, time, rule.timezone, rule.durationMinutes);
        if (resolution.kind === 'nonexistent-wall-time') {
            nonexistentDates.push(formatCalendarDate(date));
            return false;
        }
        if (resolution.kind === 'occurrence') {
            occurrences.push(resolution.occurrence);
            return occurrences.length >= cap;
        }
        return false;
    };

    if (rule.kind === 'weekly') {
        const weekdays = new Set(rule.weekdays);
        if (weekdays.size === 0) return { occurrences, nonexistentDates };
        const cursorStart = Date.UTC(start.year, start.month - 1, start.day);
        const cursorEnd = end ? Date.UTC(end.year, end.month - 1, end.day) : null;
        // A weekly rule needs at most one occurrence per week; the slack also
        // covers the (at most one or two per year per weekday) DST-gap dates a
        // real IANA zone can produce before the cap is reached.
        const maxIterations = cap * 7 + 7;

        for (let i = 0; i < maxIterations; i += 1) {
            const ms = cursorStart + i * 86_400_000;
            if (cursorEnd !== null && ms > cursorEnd) break;
            const dt = new Date(ms);
            if (weekdays.has(dt.getUTCDay())) {
                const reachedCap = pushDate({ year: dt.getUTCFullYear(), month: dt.getUTCMonth() + 1, day: dt.getUTCDate() });
                if (reachedCap) break;
            }
            if (cursorEnd === null && occurrences.length >= cap) break;
        }
        return { occurrences, nonexistentDates };
    }

    // monthly with month-end clamping
    if (!Number.isInteger(rule.dayOfMonth) || rule.dayOfMonth === null || rule.dayOfMonth < 1 || rule.dayOfMonth > 31) {
        return { occurrences, nonexistentDates };
    }
    let year = start.year;
    let month = start.month;
    const startMs = Date.UTC(start.year, start.month - 1, start.day);
    const endMs = end ? Date.UTC(end.year, end.month - 1, end.day) : null;
    const maxMonths = cap + 1;

    for (let i = 0; i < maxMonths; i += 1) {
        const day = Math.min(rule.dayOfMonth, daysInMonth(year, month));
        const ms = Date.UTC(year, month - 1, day);
        if (endMs !== null && Date.UTC(year, month - 1, 1) > endMs) break;
        if (ms >= startMs && (endMs === null || ms <= endMs)) {
            const reachedCap = pushDate({ year, month, day });
            if (reachedCap) break;
        }
        month += 1;
        if (month > 12) {
            month = 1;
            year += 1;
        }
    }
    return { occurrences, nonexistentDates };
}

/**
 * Expand a recurrence rule into absolute UTC occurrences, ordered ascending.
 * Bounded by `limit` (capped at HARD_MAX_OCCURRENCES) so a caller can never
 * request an unbounded expansion. An invalid rule yields `[]` (deny-by-default
 * rather than a partially-materialized schedule). Use
 * `expandRecurrenceDetailed` when the caller must also reject DST-gap dates
 * before writing.
 */
export function expandRecurrence(rule: RecurrenceRule, limit: number = DEFAULT_MAX_OCCURRENCES): Occurrence[] {
    return expandRecurrenceDetailed(rule, limit).occurrences;
}

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

export interface ValidatedSeries {
    title: string;
    audience: ScheduleAudience;
    branchId: string | null;
    groupId: string | null;
    timezone: string;
    recurrence: RecurrenceKind;
    weekdays: number[];
    dayOfMonth: number | null;
    startsOn: string;
    endsOn: string | null;
    startTime: string;
    durationMinutes: number;
}

export interface ValidatedReschedule {
    startsAt: string;
    endsAt: string;
    reason: string;
}

export interface ValidatedReason {
    reason: string;
}

function resolveTimeZone(value: unknown): string | null {
    if (value === undefined || value === null || value === '') return 'UTC';
    if (typeof value !== 'string') return null;
    return isValidTimeZone(value) ? value : null;
}

function normalizeWeekdays(value: unknown): number[] | null {
    let raw: unknown[] | null = null;
    if (Array.isArray(value)) raw = value;
    else if (typeof value === 'string' && value.trim() !== '') raw = value.split(',');
    if (!raw || raw.length === 0) return null;
    const days = new Set<number>();
    for (const item of raw) {
        const parsed = strictWholeNumber(item);
        if (!Number.isInteger(parsed) || parsed < 0 || parsed > 6) return null;
        days.add(parsed);
    }
    return days.size > 0 ? [...days].sort((a, b) => a - b) : null;
}

function normalizeDuration(value: unknown): number | null {
    const parsed = strictWholeNumber(value);
    if (!Number.isInteger(parsed) || parsed <= 0 || parsed > MAX_DURATION_MINUTES) return null;
    return parsed;
}

function resolveTarget(
    audience: ScheduleAudience,
    record: Record<string, unknown>,
): ValidationResult<{ branchId: string | null; groupId: string | null }> {
    const hasBranch = record['branch_id'] !== undefined && record['branch_id'] !== null && record['branch_id'] !== '';
    const hasGroup = record['group_id'] !== undefined && record['group_id'] !== null && record['group_id'] !== '';

    if (audience === 'branch') {
        const branchId = normalizeId(record['branch_id']);
        if (!branchId) return { ok: false, error: 'branch_id is required for a branch schedule' };
        if (hasGroup) return { ok: false, error: 'a branch schedule must not target a group' };
        return { ok: true, value: { branchId, groupId: null } };
    }
    if (audience === 'group') {
        const groupId = normalizeId(record['group_id']);
        if (!groupId) return { ok: false, error: 'group_id is required for a group schedule' };
        if (hasBranch) return { ok: false, error: 'a group schedule must not target a branch' };
        return { ok: true, value: { branchId: null, groupId } };
    }
    if (hasBranch || hasGroup) {
        return { ok: false, error: 'a tenant schedule must not target a branch or group' };
    }
    return { ok: true, value: { branchId: null, groupId: null } };
}

/** Validate a recurring-series create payload. Deny-by-default on any ambiguity. */
export function validateSeriesInput(body: unknown): ValidationResult<ValidatedSeries> {
    const record = isRecord(body) ? body : {};
    const title = typeof record['title'] === 'string' ? record['title'].trim() : '';
    const audience = normalizeScheduleAudience(record['audience']);

    if (!title) return { ok: false, error: 'title is required' };
    if (title.length > MAX_TITLE_LENGTH) return { ok: false, error: `title must be at most ${MAX_TITLE_LENGTH} characters` };
    if (!audience) return { ok: false, error: 'audience must be tenant, branch or group' };

    const target = resolveTarget(audience, record);
    if (!target.ok) return target;

    const timezone = resolveTimeZone(record['timezone']);
    if (timezone === null) return { ok: false, error: 'timezone is invalid' };

    const recurrence = normalizeRecurrenceKind(record['recurrence']);
    if (!recurrence) return { ok: false, error: 'recurrence must be weekly or monthly' };

    const startsOn = parseCalendarDate(record['starts_on']);
    if (!startsOn) return { ok: false, error: 'starts_on must be a valid YYYY-MM-DD date' };
    let endsOn: string | null = null;
    if (record['ends_on'] !== undefined && record['ends_on'] !== null && record['ends_on'] !== '') {
        const end = parseCalendarDate(record['ends_on']);
        if (!end) return { ok: false, error: 'ends_on must be a valid YYYY-MM-DD date' };
        if (compareCalendarDates(end, startsOn) < 0) return { ok: false, error: 'ends_on must not be before starts_on' };
        endsOn = formatCalendarDate(end);
    }

    const startTime = normalizeWallTime(record['start_time']);
    if (!startTime) return { ok: false, error: 'start_time must be a valid HH:MM time' };

    const durationMinutes = normalizeDuration(record['duration_minutes']);
    if (durationMinutes === null) {
        return { ok: false, error: `duration_minutes must be a whole number from 1 to ${MAX_DURATION_MINUTES}` };
    }

    let weekdays: number[] = [];
    let dayOfMonth: number | null = null;
    if (recurrence === 'weekly') {
        const normalized = normalizeWeekdays(record['weekdays']);
        if (!normalized) return { ok: false, error: 'weekdays must list one or more days 0..6 for a weekly schedule' };
        weekdays = normalized;
    } else {
        const raw = strictWholeNumber(record['day_of_month']);
        if (!Number.isInteger(raw) || raw < 1 || raw > 31) {
            return { ok: false, error: 'day_of_month must be a whole number from 1 to 31 for a monthly schedule' };
        }
        dayOfMonth = raw;
    }

    return {
        ok: true,
        value: {
            title,
            audience,
            branchId: target.value.branchId,
            groupId: target.value.groupId,
            timezone,
            recurrence,
            weekdays,
            dayOfMonth,
            startsOn: formatCalendarDate(startsOn),
            endsOn,
            startTime,
            durationMinutes,
        },
    };
}

/**
 * Validate a reschedule payload. `starts_at` is authored as a local wall time
 * in the session's retained timezone; `ends_at` defaults to the existing
 * duration when omitted. A reason is mandatory (audited).
 */
export function validateRescheduleInput(
    body: unknown,
    context: { timezone: string; durationMinutes: number },
): ValidationResult<ValidatedReschedule> {
    const record = isRecord(body) ? body : {};
    if (!isValidTimeZone(context.timezone)) {
        return { ok: false, error: 'session timezone is invalid' };
    }
    const timezone = context.timezone;

    const rawStart = record['starts_at'];
    if (typeof rawStart !== 'string' || rawStart.trim() === '') {
        return { ok: false, error: 'starts_at is required' };
    }
    if (!WALL_TIME_OF_DAY_RE.test(rawStart)) return { ok: false, error: 'starts_at must include a time of day' };
    const startInstant = localWallTimeToInstant(rawStart, timezone);
    if (!startInstant || !isStorableInstant(startInstant)) {
        return { ok: false, error: 'starts_at must be a valid local date/time' };
    }

    const duration = Number.isInteger(context.durationMinutes) && context.durationMinutes > 0
        ? context.durationMinutes
        : null;

    let endsAt: Date;
    const rawEnd = record['ends_at'];
    if (rawEnd === undefined || rawEnd === null || rawEnd === '') {
        if (duration === null) return { ok: false, error: 'ends_at is required' };
        endsAt = new Date(startInstant.getTime() + duration * 60_000);
    } else {
        if (typeof rawEnd !== 'string' || !WALL_TIME_OF_DAY_RE.test(rawEnd)) {
            return { ok: false, error: 'ends_at must be a valid local date/time' };
        }
        const endInstant = localWallTimeToInstant(rawEnd, timezone);
        if (!endInstant) return { ok: false, error: 'ends_at must be a valid local date/time' };
        endsAt = endInstant;
    }
    if (!isStorableInstant(endsAt)) return { ok: false, error: 'ends_at must be a valid local date/time' };
    if (endsAt.getTime() <= startInstant.getTime()) {
        return { ok: false, error: 'ends_at must be after starts_at' };
    }
    if (endsAt.getTime() - startInstant.getTime() > MAX_DURATION_MINUTES * 60_000) {
        return { ok: false, error: `a session must not be longer than ${MAX_DURATION_MINUTES} minutes` };
    }

    const reason = resolveReason(record['reason']);
    if (!reason.ok) return reason;

    return {
        ok: true,
        value: { startsAt: startInstant.toISOString(), endsAt: endsAt.toISOString(), reason: reason.value },
    };
}

function resolveReason(value: unknown): ValidationResult<string> {
    const reason = typeof value === 'string' ? value.trim() : '';
    if (!reason) return { ok: false, error: 'reason is required' };
    if (reason.length > MAX_REASON_LENGTH) return { ok: false, error: `reason must be at most ${MAX_REASON_LENGTH} characters` };
    return { ok: true, value: reason };
}

/** Validate a cancel payload; a reason is mandatory (audited). */
export function validateCancelInput(body: unknown): ValidationResult<ValidatedReason> {
    const record = isRecord(body) ? body : {};
    const reason = resolveReason(record['reason']);
    if (!reason.ok) return reason;
    return { ok: true, value: { reason: reason.value } };
}

/** Duration in minutes between two stored UTC instants, or null when invalid. */
export function sessionDurationMinutes(startsAt: string | Date, endsAt: string | Date): number | null {
    const start = startsAt instanceof Date ? startsAt.getTime() : Date.parse(`${String(startsAt).replace(' ', 'T')}Z`);
    const end = endsAt instanceof Date ? endsAt.getTime() : Date.parse(`${String(endsAt).replace(' ', 'T')}Z`);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
    return Math.round((end - start) / 60_000);
}

// ---------------------------------------------------------------------------
// Bounded time-range list filters
// ---------------------------------------------------------------------------

/**
 * A validated UTC time range for list feeds. `fromUtc`/`toUtc` are normalized
 * `YYYY-MM-DD HH:MM:SS` MySQL UTC literals, or null when the bound is absent.
 * The range is bounded by the storable DATETIME year range (1000..9999); no
 * arbitrary duration policy is imposed.
 */
export interface TimeRangeFilter {
    fromUtc: string | null;
    toUtc: string | null;
}

const TIME_RANGE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/;

/**
 * Parse one `from`/`to` query bound into a normalized UTC datetime literal.
 * Accepts `YYYY-MM-DD[ HH:MM[:SS]]` only; anything else (non-string, offset
 * suffix, impossible calendar time, unstorable year) yields null.
 */
function parseTimeRangeBound(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (!trimmed || trimmed.length > 19) return null;
    const match = TIME_RANGE_PATTERN.exec(trimmed);
    if (!match) return null;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const hour = Number(match[4] ?? '00');
    const minute = Number(match[5] ?? '00');
    const second = Number(match[6] ?? '00');
    if (year < MIN_STORABLE_YEAR || year > MAX_STORABLE_YEAR) return null;
    if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null;
    if (hour > 23 || minute > 59 || second > 59) return null;
    return `${match[1]}-${match[2]}-${match[3]} ${pad(hour)}:${pad(minute)}:${pad(second)}`;
}

/**
 * Validate the `from`/`to` query bounds of a list feed. Both are optional; a
 * present bound must be a real UTC `YYYY-MM-DD[ HH:MM[:SS]]` instant inside
 * the storable year range, and `from` must not be after `to`. Deny-by-default:
 * a malformed bound is a 400, never a silently ignored filter.
 */
export function parseTimeRangeFilter(query: Record<string, unknown>): ValidationResult<TimeRangeFilter> {
    const fromRaw = query['from'];
    const toRaw = query['to'];
    let fromUtc: string | null = null;
    let toUtc: string | null = null;
    if (fromRaw !== undefined && fromRaw !== null && fromRaw !== '') {
        fromUtc = parseTimeRangeBound(fromRaw);
        if (fromUtc === null) return { ok: false, error: 'from must be a valid YYYY-MM-DD[ HH:MM[:SS]]' };
    }
    if (toRaw !== undefined && toRaw !== null && toRaw !== '') {
        toUtc = parseTimeRangeBound(toRaw);
        if (toUtc === null) return { ok: false, error: 'to must be a valid YYYY-MM-DD[ HH:MM[:SS]]' };
    }
    if (fromUtc !== null && toUtc !== null && fromUtc > toUtc) {
        return { ok: false, error: 'from must not be after to' };
    }
    return { ok: true, value: { fromUtc, toUtc } };
}

/**
 * AND-fragments applying a validated time range to a column, mirroring the
 * audit-log `from`/`to` contract (`created_at >= ?` / `created_at <= ?`). The
 * column name is a server-side literal, never client input.
 */
export function buildTimeRangeConditions(
    column: string,
    range: TimeRangeFilter,
): { sql: string; params: unknown[] } {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (range.fromUtc !== null) {
        conditions.push(`${column} >= ?`);
        params.push(range.fromUtc);
    }
    if (range.toUtc !== null) {
        conditions.push(`${column} <= ?`);
        params.push(range.toUtc);
    }
    return { sql: conditions.length > 0 ? ` AND ${conditions.join(' AND ')}` : '', params };
}
