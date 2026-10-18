/**
 * C6 scheduled drip release + C7 sequential-unlock release policy.
 *
 * Pure, deterministic and clock-injected. The policy decides whether a
 * lesson is *released*; it never touches tenant/enrollment/branch scoping
 * (that is composed by the content route) and it never reads the request.
 *
 * C6:
 *  - `immediate` lessons are released as soon as they are published.
 *  - `scheduled` lessons are released only once the injected server clock has
 *    reached the absolute UTC instant derived from the authored local time in
 *    the tenant timezone. An early request is denied; a materialized
 *    `released_at` marker makes release runner retries idempotent.
 * C7:
 *  - `sequential` lessons stay locked until their configured prerequisite
 *    lesson has a completion record for the same enrollment.
 *
 * No `any`, no ts-ignore, no network, no runtime DDL.
 */

export const RELEASE_MODES = ['immediate', 'scheduled', 'sequential'] as const;
export type ReleaseMode = (typeof RELEASE_MODES)[number];

export function normalizeReleaseMode(value: unknown): ReleaseMode | null {
    if (typeof value !== 'string') return null;
    return (RELEASE_MODES as readonly string[]).includes(value) ? (value as ReleaseMode) : null;
}

/** IANA timezone validity; bounded length so a caller cannot smuggle a huge string. */
export function isValidTimeZone(value: unknown): value is string {
    if (typeof value !== 'string' || value.length === 0 || value.length > 64) return false;
    try {
        new Intl.DateTimeFormat('en-US', { timeZone: value });
        return true;
    } catch {
        return false;
    }
}

function safeTimeZone(value: string): string {
    return isValidTimeZone(value) ? value : 'UTC';
}

export interface LocalWallTime {
    year: number;
    month: number;
    day: number;
    hour: number;
    minute: number;
    second: number;
}

const WALL_TIME_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/;

/**
 * Parse a local wall-time string (`YYYY-MM-DD` or `YYYY-MM-DD HH:MM[:SS]`).
 * Rejects anything that is not a real calendar date/time; no timezone is
 * assumed here (the caller supplies the zone).
 */
export function parseLocalWallTime(value: unknown): LocalWallTime | null {
    if (typeof value !== 'string') return null;
    const match = WALL_TIME_RE.exec(value.trim());
    if (!match) return null;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const hour = Number(match[4] ?? '0');
    const minute = Number(match[5] ?? '0');
    const second = Number(match[6] ?? '0');
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    if (hour > 23 || minute > 59 || second > 59) return null;
    const check = new Date(Date.UTC(year, month - 1, day));
    if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) {
        return null;
    }
    return { year, month, day, hour, minute, second };
}

function formatInZone(instant: Date, timeZone: string): LocalWallTime {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone,
        hour12: false,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
    }).formatToParts(instant);
    const read = (type: string): number => Number(parts.find((part) => part.type === type)?.value ?? '0');
    return {
        year: read('year'),
        month: read('month'),
        day: read('day'),
        // Some ICU builds emit "24" for midnight; normalize to 0.
        hour: read('hour') % 24,
        minute: read('minute'),
        second: read('second'),
    };
}

/** The wall-clock time a UTC instant maps to inside a tenant timezone. */
export function tenantLocalNow(now: Date, timeZone: string): LocalWallTime {
    return formatInZone(now, safeTimeZone(timeZone));
}

function timeZoneOffsetMs(timeZone: string, instant: Date): number {
    const wall = formatInZone(instant, timeZone);
    const asUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
    return asUtc - instant.getTime();
}

/**
 * Convert a tenant-local wall time into the absolute UTC instant, applying the
 * zone offset (and a second pass so DST boundaries resolve to the correct
 * offset). Returns null for an invalid wall time. Invalid zones fall back to
 * UTC deterministically.
 */
export function localWallTimeToInstant(local: unknown, timeZone: string): Date | null {
    const wall = parseLocalWallTime(local);
    if (!wall) return null;
    const zone = safeTimeZone(timeZone);
    const naive = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
    const firstOffset = timeZoneOffsetMs(zone, new Date(naive));
    let instantMs = naive - firstOffset;
    const secondOffset = timeZoneOffsetMs(zone, new Date(instantMs));
    if (secondOffset !== firstOffset) instantMs = naive - secondOffset;
    return new Date(instantMs);
}

/** Normalize a MySQL TIMESTAMP (Date or string) to an ISO UTC instant. */
export function toUtcIso(value: string | Date | null | undefined): string | null {
    if (value === null || value === undefined) return null;
    const date = value instanceof Date
        ? value
        : new Date(/[TZ]/.test(value) ? value : `${value.replace(' ', 'T')}Z`);
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

export interface LessonReleasePolicy {
    lectureId: string;
    courseId: string;
    tenantId: string;
    releaseMode: ReleaseMode;
    /** Absolute UTC instant for a scheduled release. */
    releaseAtUtc: string | null;
    /** IANA timezone the schedule was authored in (diagnostics / re-editing). */
    releaseTimeZone: string;
    /** Sequential prerequisite lesson id, when the mode is sequential. */
    prerequisiteLectureId: string | null;
    /** Materialized release marker; when set the lesson is released. */
    releasedAtUtc: string | null;
    isPublished: boolean;
    archived: boolean;
    displayOrder: number;
}

export type ReleaseDenialReason =
    | 'not-yet-released'
    | 'prerequisite-required'
    | 'invalid-schedule';

export type ReleaseDecision =
    | { released: true; reason: 'immediate' | 'scheduled' | 'sequential' }
    | { released: false; reason: ReleaseDenialReason };

export interface ReleaseEvaluationContext {
    now: Date;
    /** Whether the sequential prerequisite is completed by this enrollment. */
    prerequisiteCompleted: boolean;
}

/**
 * Evaluate whether the release policy allows the lesson to be served. Deny by
 * default: an unparseable schedule denies instead of leaking an undated
 * lesson, and a sequential lesson with a configured prerequisite requires a
 * completion record.
 */
export function evaluateLessonRelease(
    policy: LessonReleasePolicy,
    context: ReleaseEvaluationContext,
): ReleaseDecision {
    if (policy.releaseMode === 'immediate') {
        return { released: true, reason: 'immediate' };
    }

    if (policy.releaseMode === 'scheduled') {
        if (policy.releasedAtUtc !== null) return { released: true, reason: 'scheduled' };
        if (policy.releaseAtUtc === null) return { released: false, reason: 'invalid-schedule' };
        const target = Date.parse(policy.releaseAtUtc);
        if (!Number.isFinite(target)) return { released: false, reason: 'invalid-schedule' };
        return context.now.getTime() >= target
            ? { released: true, reason: 'scheduled' }
            : { released: false, reason: 'not-yet-released' };
    }

    // sequential
    if (policy.prerequisiteLectureId === null) {
        // No configured prerequisite: nothing to gate on, so it is unlocked.
        return { released: true, reason: 'sequential' };
    }
    if (!context.prerequisiteCompleted) return { released: false, reason: 'prerequisite-required' };
    return { released: true, reason: 'sequential' };
}

/** Shape of a `lesson_release_policies` row as read from the database. */
export interface ReleasePolicyRow {
    lecture_id: string;
    course_id: string;
    tenant_id: string;
    release_mode: string;
    release_at: string | Date | null;
    release_timezone: string | null;
    prerequisite_lecture_id: string | null;
    released_at: string | Date | null;
}

export interface ReleasePolicyLectureFacts {
    id: string;
    course_id: string;
    tenant_id: string;
    is_published: boolean | number;
    archived_at: string | Date | null;
    display_order: number | null;
}

/**
 * Combine a lecture row with an optional policy row into a normalized policy.
 * A missing/invalid policy row degrades to `immediate` (published lectures stay
 * available) — it never silently widens a sequential/scheduled gate because
 * those gates only exist when the explicit row is present.
 */
export function buildLessonReleasePolicy(
    lecture: ReleasePolicyLectureFacts,
    row: ReleasePolicyRow | null,
): LessonReleasePolicy {
    const mode = normalizeReleaseMode(row?.release_mode) ?? 'immediate';
    return {
        lectureId: lecture.id,
        courseId: lecture.course_id,
        tenantId: lecture.tenant_id,
        releaseMode: mode,
        releaseAtUtc: toUtcIso(row?.release_at ?? null),
        releaseTimeZone: row?.release_timezone ?? 'UTC',
        prerequisiteLectureId: mode === 'sequential' ? (row?.prerequisite_lecture_id ?? null) : null,
        releasedAtUtc: toUtcIso(row?.released_at ?? null),
        isPublished: Boolean(lecture.is_published),
        archived: lecture.archived_at !== null && lecture.archived_at !== undefined,
        displayOrder: Number(lecture.display_order ?? 0),
    };
}
