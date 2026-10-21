/**
 * M5 G7 (C3a) — manual-attendance report aggregation policy.
 *
 * Source of truth for this module is the `attendance_records` table ONLY
 * (migration 20261018_11_schedules_attendance_records.sql). No legacy
 * `attendance` table is read and no legacy-vs-new truth decision is made here.
 *
 * Everything in this file is pure: it takes raw record facts and produces
 * deterministic aggregates and a neutralized CSV text. The SQL that feeds the
 * facts lives in the route factory (`createAttendanceReportsRouter`), which is
 * NOT mounted by this task; production wiring is a later task (I1/I2).
 *
 * Data contract enforced here (also documented in the route module):
 *  - A record fact carries id/tenant/session/group/student/state/marked_at and
 *    a boolean saying whether the stored row was corrected. It NEVER carries
 *    `reason` or `correction_reason`: visibility of private reasons is an
 *    undecided policy (D3), so no report, export or aggregate exposes them.
 *  - An aggregate is always the exact sum of the underlying rows it received:
 *    per-state buckets sum to `total`, `corrected` rows are counted as a
 *    boolean fact, and the per-student/per-group/per-session partitions sum
 *    back to the top-level totals.
 *  - Rows with a state outside the four stored ENUM values are skipped in
 *    every aggregate (MySQL ENUM makes this impossible in production; it keeps
 *    the pure arithmetic honest).
 *
 * CSV formula-injection neutralization reuses `escapeCsvValue` (and therefore
 * `neutralizeCsvCell`) imported from `services/progress-reports.ts`.
 */

import { escapeCsvValue } from './progress-reports';
import { normalizeAttendanceState, AttendanceState } from './attendance-records';

export const ATTENDANCE_REPORT_STATES = ['present', 'absent', 'late', 'excused'] as const;
export type AttendanceReportState = AttendanceState;

/**
 * Hard row cap for the report feeds (summary and CSV export alike). The
 * route fetches one row past this cap so it can expose an explicit
 * `X-Results-Truncated: true|false` header instead of silently dropping rows;
 * aggregates are computed over exactly the rows that are reported on, so the
 * "totals equal the sum of underlying rows" invariant still holds under
 * truncation.
 */
export const ATTENDANCE_REPORT_ROW_CAP = 5000;

/**
 * A report range must be a bounded, validated pair of UTC instants. Both
 * bounds are required (an open-ended report would be an unbounded read) and
 * the span may not exceed one leap year. This is a technical read cap, not a
 * product policy.
 */
export const ATTENDANCE_REPORT_MAX_RANGE_DAYS = 366;

export interface AttendanceReportRange {
    /** Normalized `YYYY-MM-DD HH:MM:SS` UTC literal (inclusive lower bound). */
    fromUtc: string;
    /** Normalized `YYYY-MM-DD HH:MM:SS` UTC literal (inclusive upper bound). */
    toUtc: string;
}

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * Span in days between two normalized UTC literals. Fractional (an hour is
 * 1/24 of a day). Unparseable inputs yield NaN so the caller can reject.
 */
export function rangeSpanDays(fromUtc: string, toUtc: string): number {
    const from = Date.parse(`${fromUtc.replace(' ', 'T')}Z`);
    const to = Date.parse(`${toUtc.replace(' ', 'T')}Z`);
    if (!Number.isFinite(from) || !Number.isFinite(to)) return Number.NaN;
    return (to - from) / 86_400_000;
}

/**
 * Validate the report range. The shared `parseTimeRangeFilter` from
 * `services/schedules.ts` does the syntactic work (real calendar times, UTC,
 * storable year range, `from` not after `to`), then this layer imposes "both
 * bounds required" and the documented max span.
 */
export function validateReportRange(
    query: Record<string, unknown>,
    parseRange: (q: Record<string, unknown>) => ValidationResult<{ fromUtc: string | null; toUtc: string | null }>,
): ValidationResult<AttendanceReportRange> {
    const parsed = parseRange(query);
    if (!parsed.ok) return { ok: false, error: parsed.error };
    const { fromUtc, toUtc } = parsed.value;
    if (fromUtc === null || toUtc === null) {
        return { ok: false, error: 'from and to are required and must be valid YYYY-MM-DD[ HH:MM[:SS]] UTC dates' };
    }
    const span = rangeSpanDays(fromUtc, toUtc);
    if (!Number.isFinite(span)) {
        return { ok: false, error: 'from and to must be valid UTC dates' };
    }
    if (span > ATTENDANCE_REPORT_MAX_RANGE_DAYS) {
        return { ok: false, error: `Date range must not exceed ${ATTENDANCE_REPORT_MAX_RANGE_DAYS} days` };
    }
    return { ok: true, value: { fromUtc, toUtc } };
}

// ---------------------------------------------------------------------------
// Record facts
// ---------------------------------------------------------------------------

/**
 * One attendance fact as the report reads it. The SELECT list of the route is
 * restricted to exactly these fields; `reason` and `correction_reason` are
 * deliberately absent (undecided private-reason visibility policy). The
 * corrected flag is a boolean fact ("this row was corrected"), not the reason.
 */
export interface AttendanceReportRecordRow {
    id: string;
    tenant_id: string;
    session_id: string;
    group_id: string | null;
    student_id: string;
    state: string;
    marked_at: string | Date;
    corrected: boolean | number | null;
}

/** mysql2 gives 0/1 for computed booleans; hermetic stores may give booleans. */
export function recordIsCorrected(row: Pick<AttendanceReportRecordRow, 'corrected'>): boolean {
    if (row.corrected === null || row.corrected === undefined) return false;
    const asNumber = Number(row.corrected);
    if (Number.isNaN(asNumber)) return Boolean(row.corrected);
    return asNumber !== 0;
}

/** Normalize `marked_at` to a `YYYY-MM-DD HH:MM:SS` UTC cell string. */
export function normalizeMarkedAt(value: string | Date | null | undefined): string {
    if (value instanceof Date) return value.toISOString().replace('T', ' ').slice(0, 19);
    if (typeof value === 'string') return value.replace('T', ' ').slice(0, 19);
    return '';
}

/** A row is aggregatable only when its state is one of the four stored states. */
export function isAggregatableRow(row: AttendanceReportRecordRow): boolean {
    return normalizeAttendanceState(row.state) !== null;
}

// ---------------------------------------------------------------------------
// Aggregates — every aggregate equals the sum of the rows it was given
// ---------------------------------------------------------------------------

export interface AttendanceStateCounts {
    present: number;
    absent: number;
    late: number;
    excused: number;
    total: number;
    corrected: number;
}

export interface AttendanceReportTotals extends AttendanceStateCounts {
    students: number;
    sessions: number;
}

export interface StudentTotals extends AttendanceStateCounts {
    student_id: string;
}

export interface GroupTotals extends AttendanceStateCounts {
    /** NULL = records of tenant/branch sessions (the column is nullable). */
    group_id: string | null;
    students: number;
    sessions: number;
}

export interface SessionTotals extends AttendanceStateCounts {
    session_id: string;
    students: number;
}

const emptyCounts = (): AttendanceStateCounts => ({ present: 0, absent: 0, late: 0, excused: 0, total: 0, corrected: 0 });

/** Fold one row into a mutable counter; invalid-state rows count nothing. */
const countRow = (counts: AttendanceStateCounts, row: AttendanceReportRecordRow): void => {
    const state = normalizeAttendanceState(row.state);
    if (!state) return;
    counts[state] += 1;
    counts.total += 1;
    if (recordIsCorrected(row)) counts.corrected += 1;
};

/** Idcmp: null sorts before any id so the ordering is total and stable. */
const compareNullableId = (a: string | null, b: string | null): number => {
    if (a === b) return 0;
    if (a === null) return -1;
    if (b === null) return 1;
    return a < b ? -1 : 1;
};

const compareId = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export function summarizeAttendanceRows(rows: readonly AttendanceReportRecordRow[]): AttendanceReportTotals {
    const counts = emptyCounts();
    const students = new Set<string>();
    const sessions = new Set<string>();
    for (const row of rows) {
        if (!isAggregatableRow(row)) continue;
        countRow(counts, row);
        students.add(row.student_id);
        sessions.add(row.session_id);
    }
    return { ...counts, students: students.size, sessions: sessions.size };
}

export function aggregateAttendanceByStudent(rows: readonly AttendanceReportRecordRow[]): StudentTotals[] {
    const map = new Map<string, AttendanceStateCounts>();
    for (const row of rows) {
        if (!isAggregatableRow(row)) continue;
        let counts = map.get(row.student_id);
        if (!counts) {
            counts = emptyCounts();
            map.set(row.student_id, counts);
        }
        countRow(counts, row);
    }
    return [...map.entries()]
        .map(([student_id, counts]) => ({ student_id, ...counts }))
        .sort((a, b) => compareId(a.student_id, b.student_id));
}

export function aggregateAttendanceByGroup(rows: readonly AttendanceReportRecordRow[]): GroupTotals[] {
    const map = new Map<string, { groupId: string | null; counts: AttendanceStateCounts; students: Set<string>; sessions: Set<string> }>();
    for (const row of rows) {
        if (!isAggregatableRow(row)) continue;
        const key = row.group_id ?? '\u0000';
        let entry = map.get(key);
        if (!entry) {
            entry = { groupId: row.group_id, counts: emptyCounts(), students: new Set<string>(), sessions: new Set<string>() };
            map.set(key, entry);
        }
        countRow(entry.counts, row);
        entry.students.add(row.student_id);
        entry.sessions.add(row.session_id);
    }
    return [...map.values()]
        .map((entry) => ({ group_id: entry.groupId, ...entry.counts, students: entry.students.size, sessions: entry.sessions.size }))
        .sort((a, b) => compareNullableId(a.group_id, b.group_id));
}

export function aggregateAttendanceBySession(rows: readonly AttendanceReportRecordRow[]): SessionTotals[] {
    const map = new Map<string, { counts: AttendanceStateCounts; students: Set<string> }>();
    for (const row of rows) {
        if (!isAggregatableRow(row)) continue;
        let entry = map.get(row.session_id);
        if (!entry) {
            entry = { counts: emptyCounts(), students: new Set<string>() };
            map.set(row.session_id, entry);
        }
        countRow(entry.counts, row);
        entry.students.add(row.student_id);
    }
    return [...map.entries()]
        .map(([session_id, entry]) => ({ session_id, ...entry.counts, students: entry.students.size }))
        .sort((a, b) => compareId(a.session_id, b.session_id));
}

// ---------------------------------------------------------------------------
// CSV export (formula-neutralized via services/progress-reports.ts)
// ---------------------------------------------------------------------------

export const ATTENDANCE_REPORT_CSV_HEADERS = [
    'student_id',
    'group_id',
    'session_id',
    'state',
    'marked_at_utc',
    'corrected',
] as const;

/**
 * One CSV line per underlying record row, in the same deterministic order the
 * rows were fetched. Every cell passes through `escapeCsvValue` (which applies
 * the progress-reports `neutralizeCsvCell` formula-injection guard), so a
 * `=cmd|...`, `+`, `-`, `@` or leading control character in any server-stored
 * value renders as inert text in a spreadsheet. No reason column exists.
 */
export function buildAttendanceReportCsv(rows: readonly AttendanceReportRecordRow[]): string {
    const lines: string[] = [];
    lines.push(ATTENDANCE_REPORT_CSV_HEADERS.map((header) => escapeCsvValue(header)).join(','));
    for (const row of rows) {
        lines.push([
            row.student_id,
            row.group_id ?? '',
            row.session_id,
            row.state,
            normalizeMarkedAt(row.marked_at),
            recordIsCorrected(row) ? 'true' : 'false',
        ]
            .map((cell) => escapeCsvValue(cell))
            .join(','));
    }
    return lines.join('\r\n');
}
