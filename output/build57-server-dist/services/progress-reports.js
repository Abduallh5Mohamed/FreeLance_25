"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.selectParentProgress = exports.filterByBranch = exports.filterByTenant = exports.computeProgress = exports.buildReport = exports.csvEscape = exports.escapeCsv = exports.sanitizeCsvValue = exports.sanitizeCsvCell = exports.PROGRESS_STATUSES = void 0;
exports.neutralizeCsvCell = neutralizeCsvCell;
exports.escapeCsvValue = escapeCsvValue;
exports.toCsv = toCsv;
exports.computeProgressStatus = computeProgressStatus;
exports.computeOverallProgress = computeOverallProgress;
exports.buildProgressReport = buildProgressReport;
exports.filterReportsByTenant = filterReportsByTenant;
exports.filterReportsByBranch = filterReportsByBranch;
exports.isProgressPublished = isProgressPublished;
exports.projectProgressForParent = projectProgressForParent;
/**
 * M4 A7 — student progress and reports domain policy.
 */
exports.PROGRESS_STATUSES = ['not_started', 'in_progress', 'completed'];
function neutralizeCsvCell(value) {
    const raw = value === null || value === undefined ? '' : String(value);
    // Formula injection neutralization: prefix the cell with a single quote so
    // a spreadsheet renders `=cmd|...`, `+`, `-`, `@`, or a leading control
    // character as inert text instead of executing it.
    if (/^[=+\-@\t\r\n]/.test(raw))
        return `'${raw}`;
    return raw;
}
function escapeCsvValue(value) {
    const cell = neutralizeCsvCell(value);
    if (/[",\n\r]/.test(cell))
        return `"${cell.replace(/"/g, '""')}"`;
    return cell;
}
function toCsv(headers, rows) {
    const lines = [];
    lines.push(headers.map(escapeCsvValue).join(','));
    for (const row of rows)
        lines.push(row.map(escapeCsvValue).join(','));
    return lines.join('\r\n');
}
function computeProgressStatus(completed, total) {
    if (total <= 0)
        return 'not_started';
    if (completed <= 0)
        return 'not_started';
    if (completed >= total)
        return 'completed';
    return 'in_progress';
}
function computeOverallProgress(parts) {
    let num = 0;
    let den = 0;
    for (const p of parts) {
        if (p.value === null || !Number.isFinite(p.value))
            continue;
        num += p.value * p.weight;
        den += p.weight;
    }
    if (den <= 0)
        return null;
    return Math.round((num / den) * 100) / 100;
}
function buildProgressReport(record) {
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
function filterReportsByTenant(rows, tenantId) {
    return rows.filter((r) => r.tenantId === tenantId);
}
/**
 * Teacher-side branch scoping for the reports surface. A row is only visible
 * when its branch matches the caller's selected branch (a null branch scope is
 * tenant-wide and therefore matches every branch).
 */
function filterReportsByBranch(rows, branchId) {
    if (!branchId)
        return [...rows];
    return rows.filter((r) => r.branchId === branchId);
}
/** A parent may only see a report that has been explicitly published. */
function isProgressPublished(record) {
    return record.published === true;
}
/**
 * Project a progress record for a linked parent: deny-by-default until the
 * report is published, and expose only published aggregate fields (never the
 * internal enrollment id or raw score breakdown).
 */
function projectProgressForParent(record) {
    if (!isProgressPublished(record))
        return null;
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
exports.sanitizeCsvCell = neutralizeCsvCell;
exports.sanitizeCsvValue = neutralizeCsvCell;
exports.escapeCsv = escapeCsvValue;
exports.csvEscape = escapeCsvValue;
exports.buildReport = buildProgressReport;
exports.computeProgress = computeOverallProgress;
exports.filterByTenant = filterReportsByTenant;
exports.filterByBranch = filterReportsByBranch;
exports.selectParentProgress = projectProgressForParent;
