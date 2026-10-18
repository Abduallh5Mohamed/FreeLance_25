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
    if (hour > 23 || minute > 59 || second > 59) return null;
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

function buildOccurrence(
    date: CalendarDate,
    time: string,
    timezone: string,
    durationMinutes: number,
): Occurrence | null {
    const instant = localWallTimeToInstant(`${formatCalendarDate(date)} ${time}`, timezone);
    if (!instant) return null;
    const endsAt = new Date(instant.getTime() + durationMinutes * 60_000);
    return { startsAt: instant.toISOString(), endsAt: endsAt.toISOString() };
}

/**
 * Expand a recurrence rule into absolute UTC occurrences, ordered ascending.
 * Bounded by `limit` (capped at HARD_MAX_OCCURRENCES) so a caller can never
 * request an unbounded expansion. An invalid rule yields `[]` (deny-by-default
 * rather than a partially-materialized schedule).
 */
export function expandRecurrence(rule: RecurrenceRule, limit: number = DEFAULT_MAX_OCCURRENCES): Occurrence[] {
    const cap = Math.min(Math.max(0, Math.floor(limit)), HARD_MAX_OCCURRENCES);
    if (cap === 0) return [];

    const start = parseCalendarDate(rule.startsOn);
    if (!start) return [];
    const end = rule.endsOn === null ? null : parseCalendarDate(rule.endsOn);
    if (rule.endsOn !== null && !end) return [];
    if (end && compareCalendarDates(end, start) < 0) return [];

    const time = normalizeWallTime(rule.startTime);
    if (!time) return [];
    if (!isValidTimeZone(rule.timezone)) return [];
    if (!Number.isInteger(rule.durationMinutes) || rule.durationMinutes <= 0 || rule.durationMinutes > MAX_DURATION_MINUTES) return [];
    if (!Number.isInteger(limit) && !Number.isFinite(limit)) return [];

    const occurrences: Occurrence[] = [];
    const pushDate = (date: CalendarDate): boolean => {
        const occurrence = buildOccurrence(date, time, rule.timezone, rule.durationMinutes);
        if (occurrence) occurrences.push(occurrence);
        return occurrences.length >= cap;
    };

    if (rule.kind === 'weekly') {
        const weekdays = new Set(rule.weekdays);
        if (weekdays.size === 0) return [];
        const cursorStart = Date.UTC(start.year, start.month - 1, start.day);
        const cursorEnd = end ? Date.UTC(end.year, end.month - 1, end.day) : null;
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
        return occurrences;
    }

    // monthly with month-end clamping
    if (!Number.isInteger(rule.dayOfMonth) || rule.dayOfMonth === null || rule.dayOfMonth < 1 || rule.dayOfMonth > 31) {
        return [];
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
    return occurrences;
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
        const parsed = typeof item === 'number' ? item : Number(String(item).trim());
        if (!Number.isInteger(parsed) || parsed < 0 || parsed > 6) return null;
        days.add(parsed);
    }
    return days.size > 0 ? [...days].sort((a, b) => a - b) : null;
}

function normalizeDuration(value: unknown): number | null {
    const parsed = typeof value === 'number' ? value : Number(value);
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
        const raw = typeof record['day_of_month'] === 'number' ? record['day_of_month'] : Number(record['day_of_month']);
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
    const timezone = isValidTimeZone(context.timezone) ? context.timezone : 'UTC';

    const rawStart = record['starts_at'];
    if (typeof rawStart !== 'string' || rawStart.trim() === '') {
        return { ok: false, error: 'starts_at is required' };
    }
    const startInstant = localWallTimeToInstant(rawStart, timezone);
    if (!startInstant) return { ok: false, error: 'starts_at must be a valid local date/time' };

    const duration = Number.isInteger(context.durationMinutes) && context.durationMinutes > 0
        ? context.durationMinutes
        : null;

    let endsAt: Date;
    const rawEnd = record['ends_at'];
    if (rawEnd === undefined || rawEnd === null || rawEnd === '') {
        if (duration === null) return { ok: false, error: 'ends_at is required' };
        endsAt = new Date(startInstant.getTime() + duration * 60_000);
    } else {
        if (typeof rawEnd !== 'string') return { ok: false, error: 'ends_at must be a valid local date/time' };
        const endInstant = localWallTimeToInstant(rawEnd, timezone);
        if (!endInstant) return { ok: false, error: 'ends_at must be a valid local date/time' };
        endsAt = endInstant;
    }
    if (endsAt.getTime() <= startInstant.getTime()) {
        return { ok: false, error: 'ends_at must be after starts_at' };
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
