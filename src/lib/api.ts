/**
 * M2-19 — canonical client surface for the private group weekly schedule.
 *
 * `api-http.ts` stays the single transport for everything already exported
 * from it (this module still re-exports it unchanged). The group SCHEDULE
 * endpoints need two things that module cannot offer without changing its
 * public behaviour:
 *
 *  1. **Truthful failures.** The existing `updateGroup`/`deleteGroup` swallow
 *     every error into a boolean, so the page cannot tell a permission loss
 *     from a malformed payload from an uncertain 500. The adapters below throw
 *     the server's own `error` message, exactly like the canonical
 *     `request` helper does (message only — never the HTTP status, never the
 *     `code`), so a caller classifies an outcome from documented wording only.
 *
 *  2. **A canonical, validated DTO.** The server answers a bounded
 *     ten-field group projection whose `schedule_days` is the seven existing
 *     weekday keys in canonical order and whose `schedule_time` is `HH:mm` or
 *     `null`. `parseGroupSchedule` re-checks that shape at runtime, so a
 *     malformed or oversized body is a failed read rather than a fabricated
 *     group.
 *
 * The transport here mirrors the canonical helper's documented behaviour:
 * bearer token from `authToken`, JSON content type, `error.error` as the
 * thrown message, the `BILLING_ONLY` identity event + redirect and the
 * `TENANT_SUSPENDED` teardown. Nothing new is invented; no status is exposed
 * to callers.
 *
 * Timetable metadata only: no timezone, recurrence, session, attendance,
 * notification, enrollment, access or billing semantics are added here.
 */
import { clearAuthToken } from './api-http';
import { notifySessionChange } from './session-events';

export * from './api-http';

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

const GROUP_API_BASE_URL: string = (() => {
    const envApiUrl = (import.meta as { env?: Record<string, string | undefined> }).env?.VITE_API_URL;
    return envApiUrl ?? '/api';
})();

/** Local wording for a 2xx body that is not the accepted bounded DTO. The
 *  server never sends this string, so it can never be mistaken for a server
 *  classification. */
export const GROUP_SCHEDULE_MALFORMED_MESSAGE = 'استجابة غير صالحة من الخادم';

/**
 * The one group-schedule transport. It is deliberately a faithful copy of the
 * canonical helper's observable contract, because the canonical helper is
 * module-private and this task may not change `api-http.ts`.
 */
async function groupRequest<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
    const token = typeof localStorage !== 'undefined' ? localStorage.getItem('authToken') : null;
    const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        ...(options.headers as Record<string, string> | undefined),
    };
    if (token) headers.Authorization = `Bearer ${token}`;

    const response = await fetch(`${GROUP_API_BASE_URL}${endpoint}`, { ...options, headers });

    if (!response.ok) {
        const error: { error?: string; code?: string } = await response
            .json()
            .catch(() => ({ error: 'Request failed', code: undefined }));

        if (response.status === 403 && error.code === 'BILLING_ONLY') {
            try {
                const current = JSON.parse(localStorage.getItem('currentUser') || 'null');
                if (current?.role === 'instructor') {
                    localStorage.setItem('currentUser', JSON.stringify({ ...current, billing_only: true }));
                    notifySessionChange('identity');
                }
            } catch {
                /* a malformed local session is the auth guard's problem */
            }
            const path = typeof window !== 'undefined' ? window.location.pathname : '';
            if (!['/instructor-subscription', '/instructor-wallet', '/support'].includes(path)) {
                window.location.assign('/instructor-subscription');
            }
        }
        if (response.status === 403 && error.code === 'TENANT_SUSPENDED') {
            clearAuthToken();
            const path = typeof window !== 'undefined' ? window.location.pathname : '';
            if (path !== '/auth') window.location.assign('/auth');
        }

        throw new Error(error.error || `HTTP ${response.status}`);
    }

    return response.json();
}

// ---------------------------------------------------------------------------
// Canonical schedule vocabulary
// ---------------------------------------------------------------------------

/** The seven existing weekday keys, in their one canonical order. */
export const GROUP_SCHEDULE_DAYS = ['sat', 'sun', 'mon', 'tue', 'wed', 'thu', 'fri'] as const;

export type GroupScheduleDay = (typeof GROUP_SCHEDULE_DAYS)[number];

const GROUP_DAY_SET: ReadonlySet<string> = new Set(GROUP_SCHEDULE_DAYS);

/** The Arabic labels the existing screen already shows, unchanged. */
export const GROUP_SCHEDULE_DAY_LABELS: Record<GroupScheduleDay, string> = {
    sat: 'السبت',
    sun: 'الأحد',
    mon: 'الاثنين',
    tue: 'الثلاثاء',
    wed: 'الأربعاء',
    thu: 'الخميس',
    fri: 'الجمعة',
};

/** A real 24-hour wall-clock time. The projection always emits `HH:mm`. */
const GROUP_TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** The bounded canonical group DTO the private endpoints answer with. */
export interface GroupSchedule {
    readonly id: string;
    readonly name: string;
    readonly description: string | null;
    readonly course_id: string | null;
    readonly grade_id: string | null;
    readonly max_students: number;
    readonly current_students: number;
    readonly is_active: boolean;
    readonly schedule_days: GroupScheduleDay[];
    readonly schedule_time: string | null;
}

/**
 * The strict canonical write body. An ABSENT key keeps the stored value; a
 * present `null` on a clearable field clears it explicitly. `schedule_days`
 * accepts only known unique keys and is emitted in canonical order.
 */
export interface GroupScheduleWrite {
    name?: string;
    description?: string | null;
    course_id?: string | null;
    grade_id?: string | null;
    max_students?: number;
    is_active?: boolean;
    schedule_days?: GroupScheduleDay[];
    schedule_time?: string | null;
}

const GROUP_DTO_KEYS = [
    'course_id',
    'current_students',
    'description',
    'grade_id',
    'id',
    'is_active',
    'max_students',
    'name',
    'schedule_days',
    'schedule_time',
];

/**
 * Strict read-side canonicalisation of the weekday list.
 *
 * Returns `null` for anything that is not an array of unique known keys of at
 * most seven entries. The surviving keys are re-emitted in the single
 * canonical order, so a server that answers in another order is normalised
 * rather than trusted.
 */
export function canonicalGroupDays(value: unknown): GroupScheduleDay[] | null {
    if (!Array.isArray(value)) return null;
    if (value.length > GROUP_SCHEDULE_DAYS.length) return null;
    const seen = new Set<string>();
    for (const entry of value) {
        if (typeof entry !== 'string' || !GROUP_DAY_SET.has(entry)) return null;
        if (seen.has(entry)) return null;
        seen.add(entry);
    }
    return GROUP_SCHEDULE_DAYS.filter((day) => seen.has(day));
}

/** `null` stays `null`; a real `HH:mm` stays; anything else is `undefined`. */
export function canonicalGroupTime(value: unknown): string | null | undefined {
    if (value === null) return null;
    if (typeof value !== 'string') return undefined;
    return GROUP_TIME_PATTERN.test(value) ? value : undefined;
}

/** `null` or a string, as a type predicate (a negated check cannot narrow
 *  `unknown` on its own). */
const isNullableString = (value: unknown): value is string | null =>
    value === null || typeof value === 'string';

/**
 * Validates one group DTO against the accepted server contract: a non-null
 * object whose key set is EXACTLY the ten projected fields, with canonical
 * weekday keys and an `HH:mm`-or-null time.
 *
 * An extra key, a missing field, an unknown weekday or a `HH:mm:ss` time is a
 * malformed response — never a fabricated group.
 */
export function parseGroupSchedule(body: unknown): GroupSchedule | null {
    if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
    const row = body as Record<string, unknown>;

    const keys = Object.keys(row).sort();
    if (keys.length !== GROUP_DTO_KEYS.length) return null;
    for (let index = 0; index < GROUP_DTO_KEYS.length; index += 1) {
        if (keys[index] !== GROUP_DTO_KEYS[index]) return null;
    }

    const { id, name, description, course_id, grade_id, max_students, current_students, is_active } = row;
    if (typeof id !== 'string' || id.trim() === '') return null;
    if (typeof name !== 'string' || name.trim() === '') return null;
    if (!isNullableString(description)) return null;
    if (!isNullableString(course_id)) return null;
    if (!isNullableString(grade_id)) return null;
    if (typeof max_students !== 'number' || !Number.isFinite(max_students)) return null;
    if (typeof current_students !== 'number' || !Number.isFinite(current_students)) return null;
    if (typeof is_active !== 'boolean') return null;

    const days = canonicalGroupDays(row.schedule_days);
    if (days === null) return null;
    const time = canonicalGroupTime(row.schedule_time);
    if (time === undefined) return null;

    return {
        id,
        name,
        description,
        course_id,
        grade_id,
        max_students,
        current_students,
        is_active,
        schedule_days: days,
        schedule_time: time,
    };
}

/** Validates the bounded list body: a bare array of valid group DTOs. */
export function parseGroupScheduleList(body: unknown): GroupSchedule[] | null {
    if (!Array.isArray(body)) return null;
    const rows: GroupSchedule[] = [];
    for (const item of body) {
        const parsed = parseGroupSchedule(item);
        if (parsed === null) return null;
        rows.push(parsed);
    }
    return rows;
}

// ---------------------------------------------------------------------------
// Adapters — the exact production calls the page's controller makes
// ---------------------------------------------------------------------------

/** `GET /api/groups` — the caller's own bounded groups of the selected tenant. */
export const listGroupSchedules = async (): Promise<GroupSchedule[]> => {
    const body = await groupRequest<unknown>('/groups');
    const parsed = parseGroupScheduleList(body);
    if (parsed === null) throw new Error(GROUP_SCHEDULE_MALFORMED_MESSAGE);
    return parsed;
};

/** `POST /api/groups` — strict canonical create. */
export const createGroupSchedule = async (write: GroupScheduleWrite): Promise<GroupSchedule> => {
    const body = await groupRequest<unknown>('/groups', {
        method: 'POST',
        body: JSON.stringify(write),
    });
    const parsed = parseGroupSchedule(body);
    if (parsed === null) throw new Error(GROUP_SCHEDULE_MALFORMED_MESSAGE);
    return parsed;
};

/** `PUT /api/groups/:id` — omission keeps, `null` clears. */
export const updateGroupSchedule = async (
    id: string,
    write: GroupScheduleWrite,
): Promise<GroupSchedule> => {
    const body = await groupRequest<unknown>(`/groups/${encodeURIComponent(id)}`, {
        method: 'PUT',
        body: JSON.stringify(write),
    });
    const parsed = parseGroupSchedule(body);
    if (parsed === null) throw new Error(GROUP_SCHEDULE_MALFORMED_MESSAGE);
    return parsed;
};

/** `DELETE /api/groups/:id` — only an owned group is deletable. */
export const deleteGroupSchedule = async (id: string): Promise<void> => {
    await groupRequest<unknown>(`/groups/${encodeURIComponent(id)}`, { method: 'DELETE' });
};
