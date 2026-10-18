/**
 * M4 A7 — student progress and reports domain policy.
 */
export const PROGRESS_STATUSES = ['not_started', 'in_progress', 'completed'] as const;
export type ProgressStatus = (typeof PROGRESS_STATUSES)[number];

export function neutralizeCsvCell(value: unknown): string {
    const raw = value === null || value === undefined ? '' : String(value);
    // Formula injection neutralization: prefix the cell with a single quote so
    // a spreadsheet renders `=cmd|...`, `+`, `-`, `@`, or a leading control
    // character as inert text instead of executing it.
    if (/^[=+\-@\t\r\n]/.test(raw)) return `'${raw}`;
    return raw;
}

export function escapeCsvValue(value: unknown): string {
    const cell = neutralizeCsvCell(value);
    if (/[",\n\r]/.test(cell)) return `"${cell.replace(/"/g, '""')}"`;
    return cell;
}

export function toCsv(headers: readonly string[], rows: readonly (readonly unknown[])[]): string {
    const lines: string[] = [];
    lines.push(headers.map(escapeCsvValue).join(','));
    for (const row of rows) lines.push(row.map(escapeCsvValue).join(','));
    return lines.join('\r\n');
}

export interface ProgressRecord {
    studentEnrollmentId: string;
    courseId: string;
    courseName?: string;
    branchId?: string | null;
    completedLessons: number;
    totalLessons: number;
    examAverage: number | null;
    assignmentAverage: number | null;
    overall: number | null;
    status: ProgressStatus;
    /** True only once a teacher/owner explicitly publishes the report. */
    published?: boolean;
}

export function computeProgressStatus(completed: number, total: number): ProgressStatus {
    if (total <= 0) return 'not_started';
    if (completed <= 0) return 'not_started';
    if (completed >= total) return 'completed';
    return 'in_progress';
}

export function computeOverallProgress(parts: { weight: number; value: number | null }[]): number | null {
    let num = 0;
    let den = 0;
    for (const p of parts) {
        if (p.value === null || !Number.isFinite(p.value)) continue;
        num += p.value * p.weight;
        den += p.weight;
    }
    if (den <= 0) return null;
    return Math.round((num / den) * 100) / 100;
}

export function buildProgressReport(record: ProgressRecord): Record<string, unknown> {
    return {
        student_enrollment_id: record.studentEnrollmentId,
        course_id: record.courseId,
        course_name: record.courseName ?? null,
        completed_lessons: record.completedLessons,
        total_lessons: record.totalLessons,
        exam_average: record.examAverage,
        assignment_average: record.assignmentAverage,
        overall: record.overall,
        status: record.status,
    };
}

export function filterReportsByTenant<T extends { tenantId: string }>(rows: readonly T[], tenantId: string): T[] {
    return rows.filter((r) => r.tenantId === tenantId);
}

/**
 * Teacher-side branch scoping for the reports surface. A row is only visible
 * when its branch matches the caller's selected branch (a null branch scope is
 * tenant-wide and therefore matches every branch).
 */
export function filterReportsByBranch<T extends { branchId?: string | null }>(rows: readonly T[], branchId: string | null): T[] {
    if (!branchId) return [...rows];
    return rows.filter((r) => r.branchId === branchId);
}

/** A parent may only see a report that has been explicitly published. */
export function isProgressPublished(record: { published?: boolean }): boolean {
    return record.published === true;
}

/**
 * Project a progress record for a linked parent: deny-by-default until the
 * report is published, and expose only published aggregate fields (never the
 * internal enrollment id or raw score breakdown).
 */
export function projectProgressForParent(record: ProgressRecord): Record<string, unknown> | null {
    if (!isProgressPublished(record)) return null;
    return {
        course_id: record.courseId,
        course_name: record.courseName ?? null,
        completed_lessons: record.completedLessons,
        total_lessons: record.totalLessons,
        overall: record.overall,
        status: record.status,
    };
}

// Aliases
export const sanitizeCsvCell = neutralizeCsvCell;
export const sanitizeCsvValue = neutralizeCsvCell;
export const escapeCsv = escapeCsvValue;
export const csvEscape = escapeCsvValue;
export const buildReport = buildProgressReport;
export const computeProgress = computeOverallProgress;
export const filterByTenant = filterReportsByTenant;
export const filterByBranch = filterReportsByBranch;
export const selectParentProgress = projectProgressForParent;