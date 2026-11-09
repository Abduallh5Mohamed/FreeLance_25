"use strict";
/**
 * B2-C-PERSISTENCE — SQL read model for `ProgressReportSource`.
 *
 * SOURCE CODE ONLY: no connection is opened here and no SQL is executed by this
 * file. The caller injects a connection-bound transaction runner; every read is
 * issued on that `conn`.
 *
 * Sources (approved existing only):
 *  - lesson completion counts + published lesson counts, following the exact
 *    predicates of `createSqlParentViewsStore.lessonProgressSummary`
 *    (`lectures.is_published = 1`, `archived_at IS NULL`, `lesson_completions`);
 *  - exam / assignment aggregates from `gradebook_scores`, recomputed through
 *    the existing `calculateGrade` helper. There is no raw-grade fallback and
 *    no invented zero: a missing table/column is a typed `unavailable` result.
 *
 * Scope: the caller passes the server-computed `ProgressReportQueryScope`
 * (tenant + authorized course ids + optional branch). Tenant and course scope
 * are applied in SQL. A branch id is a CONSTRAINT (`g.branch_id = ?`), never a
 * grant: no `branch_memberships` read and no membership-only branch access.
 *
 * COMPLETENESS / 503 CONTRACT: every bounded read requests `cap + 1` rows. A
 * full extra row is a typed `incomplete` result, never a silently truncated
 * list or an average computed from a subset. `listRecordsResult` /
 * `findRecordResult` return the discriminated result; `listRecords` /
 * `findRecord` throw the same typed `ProgressReportSourceUnavailableError`.
 * The injected route contract recognises either form and maps both
 * `unavailable` and `incomplete` to HTTP 503 (no records, no CSV, no audit),
 * while untyped errors stay a generic 500. `overall` remains null because no
 * approved weighting policy exists.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.createBoundProgressReportSourceSql = exports.createProgressReportSourceSql = exports.ProgressReportSourceSqlError = exports.PROGRESS_REPORT_SOURCE_MAX_SCORE_ROWS = exports.PROGRESS_REPORT_SOURCE_MAX_ROWS = exports.ProgressReportSourceUnavailableError = void 0;
const progress_reports_1 = require("../routes/progress-reports");
Object.defineProperty(exports, "ProgressReportSourceUnavailableError", { enumerable: true, get: function () { return progress_reports_1.ProgressReportSourceUnavailableError; } });
const gradebook_1 = require("./gradebook");
const progress_reports_2 = require("./progress-reports");
/** Bounded reads; the route additionally caps its list/export output. */
exports.PROGRESS_REPORT_SOURCE_MAX_ROWS = 5000;
exports.PROGRESS_REPORT_SOURCE_MAX_SCORE_ROWS = 50000;
class ProgressReportSourceSqlError extends Error {
    constructor(code, message) {
        super(message);
        this.code = code;
        this.name = 'ProgressReportSourceSqlError';
    }
}
exports.ProgressReportSourceSqlError = ProgressReportSourceSqlError;
const UNAVAILABLE_ERROR_CODES = new Set([
    'ER_NO_SUCH_TABLE',
    'ER_BAD_FIELD_ERROR',
    'ER_CANT_OPEN_TABLE',
    'ER_UNKNOWN_TABLE',
]);
const UNAVAILABLE_ERRNOS = new Set([1051, 1054, 1109, 1146]);
const unavailableDetail = (error) => {
    if (typeof error !== 'object' || error === null)
        return null;
    const code = error.code;
    const errno = error.errno;
    if (typeof code === 'string' && UNAVAILABLE_ERROR_CODES.has(code))
        return code;
    if (typeof errno === 'number' && UNAVAILABLE_ERRNOS.has(errno)) {
        return typeof code === 'string' ? code : `errno ${errno}`;
    }
    return null;
};
/**
 * Invalid COUNT value. A NULL/NaN/negative/fractional/non-numeric count is
 * evidence the source answer cannot be trusted; it must never be coerced to 0.
 */
class InvalidCountError extends Error {
    constructor(field, value) {
        super(`progress report source returned an invalid ${field} count`);
        this.field = field;
        this.value = value;
        this.name = 'InvalidCountError';
    }
}
const parseCount = (value, field) => {
    if (typeof value === 'number') {
        if (Number.isSafeInteger(value) && value >= 0)
            return value;
        throw new InvalidCountError(field, value);
    }
    if (typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value)) {
        const parsed = Number(value);
        if (Number.isSafeInteger(parsed))
            return parsed;
    }
    throw new InvalidCountError(field, value);
};
const uniqueIds = (values) => {
    const seen = new Set();
    const out = [];
    for (const value of values) {
        if (typeof value !== 'string' || value.length === 0 || seen.has(value))
            continue;
        seen.add(value);
        out.push(value);
    }
    return out;
};
const pairKey = (studentEnrollmentId, courseId) => `${studentEnrollmentId}\u0000${courseId}`;
class ProgressReportSourceSqlReceiver {
    constructor(conn) {
        this.conn = conn;
    }
    inTransaction(conn) {
        return new ProgressReportSourceSqlReceiver(conn);
    }
    async listRecordsResult(scope) {
        const tenantId = scope.tenantId;
        if (typeof tenantId !== 'string' || tenantId.length === 0) {
            throw new ProgressReportSourceSqlError('invalid_scope', 'tenantId is required');
        }
        const courseIds = uniqueIds(scope.courseIds);
        if (courseIds.length === 0)
            return { ok: true, value: [] };
        const rowResult = await this.readRows(tenantId, courseIds, scope.branchId ?? null, null);
        if (!rowResult.ok)
            return rowResult;
        const rows = rowResult.value;
        if (rows.length === 0)
            return { ok: true, value: [] };
        const scoreResult = await this.readScores(tenantId, courseIds, rows);
        if (!scoreResult.ok)
            return scoreResult;
        return this.buildRecords(rows, scoreResult.value);
    }
    async findRecordResult(tenantId, studentEnrollmentId, courseId) {
        if (typeof tenantId !== 'string' || tenantId.length === 0
            || typeof studentEnrollmentId !== 'string' || studentEnrollmentId.length === 0
            || typeof courseId !== 'string' || courseId.length === 0) {
            throw new ProgressReportSourceSqlError('invalid_scope', 'tenant, enrollment and course are required');
        }
        const rowResult = await this.readRows(tenantId, [courseId], null, studentEnrollmentId);
        if (!rowResult.ok)
            return rowResult;
        const rows = rowResult.value.filter((row) => row.student_enrollment_id === studentEnrollmentId
            && row.course_id === courseId);
        if (rows.length === 0)
            return { ok: true, value: null };
        const scoreResult = await this.readScores(tenantId, [courseId], rows);
        if (!scoreResult.ok)
            return scoreResult;
        const built = this.buildRecords(rows, scoreResult.value);
        if (!built.ok)
            return built;
        return { ok: true, value: built.value[0] ?? null };
    }
    async listRecords(scope) {
        const result = await this.listRecordsResult(scope);
        if (!result.ok) {
            throw new progress_reports_1.ProgressReportSourceUnavailableError(result.code, result.detail);
        }
        return result.value;
    }
    async findRecord(tenantId, studentEnrollmentId, courseId) {
        const result = await this.findRecordResult(tenantId, studentEnrollmentId, courseId);
        if (!result.ok) {
            throw new progress_reports_1.ProgressReportSourceUnavailableError(result.code, result.detail);
        }
        return result.value;
    }
    async readRows(tenantId, courseIds, branchId, studentEnrollmentId) {
        const coursePlaceholders = courseIds.map(() => '?').join(', ');
        const params = [];
        let sql = `SELECT s.id AS student_enrollment_id, c.id AS course_id, c.name AS course_name,
                g.branch_id AS branch_id,
                (SELECT COUNT(*) FROM lectures l
                  WHERE l.course_id = c.id AND l.is_published = 1 AND l.archived_at IS NULL) AS total_lessons,
                (SELECT COUNT(*) FROM lesson_completions lc
                   INNER JOIN lectures l2 ON l2.id = lc.lecture_id
                  WHERE lc.tenant_id = ? AND lc.student_enrollment_id = s.id AND lc.course_id = c.id
                    AND l2.is_published = 1 AND l2.archived_at IS NULL) AS completed_lessons
             FROM students s
             INNER JOIN courses c ON c.tenant_id = ? AND c.is_active = 1
                AND c.id IN (${coursePlaceholders})
             LEFT JOIN \`groups\` g ON g.id = s.group_id
             WHERE s.tenant_id = ?
               AND (g.course_id = c.id OR EXISTS (
                    SELECT 1 FROM student_courses sc
                     WHERE sc.student_id = s.id AND sc.course_id = c.id AND sc.status = 'active'
               ))`;
        params.push(tenantId, tenantId, ...courseIds, tenantId);
        if (branchId !== null) {
            sql += ' AND g.branch_id = ?';
            params.push(branchId);
        }
        if (studentEnrollmentId !== null) {
            sql += ' AND s.id = ?';
            params.push(studentEnrollmentId);
        }
        // Read one past the cap: a full page means the caller would otherwise
        // present a truncated list as if it were complete.
        sql += ' ORDER BY s.id ASC, c.id ASC LIMIT ?';
        params.push(exports.PROGRESS_REPORT_SOURCE_MAX_ROWS + 1);
        try {
            const rows = await this.conn.query(sql, params);
            if (rows.length > exports.PROGRESS_REPORT_SOURCE_MAX_ROWS) {
                return {
                    ok: false,
                    code: 'incomplete',
                    detail: `record list exceeded ${exports.PROGRESS_REPORT_SOURCE_MAX_ROWS} rows`,
                };
            }
            return { ok: true, value: rows.filter((row) => row.branch_id === null || branchId === null || row.branch_id === branchId) };
        }
        catch (error) {
            const detail = unavailableDetail(error);
            if (detail !== null)
                return { ok: false, code: 'unavailable', detail };
            throw error;
        }
    }
    async readScores(tenantId, courseIds, rows) {
        const enrollmentIds = uniqueIds(rows.map((row) => row.student_enrollment_id));
        if (enrollmentIds.length === 0)
            return { ok: true, value: [] };
        const coursePlaceholders = courseIds.map(() => '?').join(', ');
        const enrollmentPlaceholders = enrollmentIds.map(() => '?').join(', ');
        try {
            const scores = await this.conn.query(`SELECT student_enrollment_id, course_id, category_id, item_type, item_id,
                        score, max_score, weight
                   FROM gradebook_scores
                  WHERE tenant_id = ? AND item_type IN ('exam', 'assignment')
                    AND course_id IN (${coursePlaceholders})
                    AND student_enrollment_id IN (${enrollmentPlaceholders})
                  ORDER BY student_enrollment_id ASC, course_id ASC, recorded_at ASC
                  LIMIT ?`, [tenantId, ...courseIds, ...enrollmentIds, exports.PROGRESS_REPORT_SOURCE_MAX_SCORE_ROWS + 1]);
            if (scores.length > exports.PROGRESS_REPORT_SOURCE_MAX_SCORE_ROWS) {
                // Do NOT average a truncated subset: the average would look
                // complete while silently excluding rows past the cap.
                return {
                    ok: false,
                    code: 'incomplete',
                    detail: `score rows exceeded ${exports.PROGRESS_REPORT_SOURCE_MAX_SCORE_ROWS}`,
                };
            }
            return { ok: true, value: scores };
        }
        catch (error) {
            const detail = unavailableDetail(error);
            if (detail !== null)
                return { ok: false, code: 'unavailable', detail };
            throw error;
        }
    }
    buildRecords(rows, scores) {
        const examEntries = new Map();
        const assignmentEntries = new Map();
        for (const row of scores) {
            const entry = (0, gradebook_1.normalizeScoreEntry)({
                category_id: row.category_id,
                item_type: row.item_type,
                item_id: row.item_id,
                score: row.score,
                max_score: row.max_score,
                weight: row.weight,
            });
            if (entry === null)
                continue;
            const key = pairKey(row.student_enrollment_id, row.course_id);
            const target = row.item_type === 'exam' ? examEntries : assignmentEntries;
            const bucket = target.get(key) ?? [];
            bucket.push(entry);
            target.set(key, bucket);
        }
        try {
            const records = rows.map((row) => {
                const key = pairKey(row.student_enrollment_id, row.course_id);
                const exams = examEntries.get(key) ?? [];
                const assignments = assignmentEntries.get(key) ?? [];
                const completedLessons = parseCount(row.completed_lessons, 'completed_lessons');
                const totalLessons = parseCount(row.total_lessons, 'total_lessons');
                return {
                    studentEnrollmentId: row.student_enrollment_id,
                    courseId: row.course_id,
                    courseName: row.course_name ?? undefined,
                    branchId: row.branch_id ?? null,
                    completedLessons,
                    totalLessons,
                    examAverage: exams.length > 0 ? (0, gradebook_1.calculateGrade)(exams, { mode: 'points' }).rounded : null,
                    assignmentAverage: assignments.length > 0
                        ? (0, gradebook_1.calculateGrade)(assignments, { mode: 'points' }).rounded
                        : null,
                    // No approved weighting policy combines the two averages;
                    // the value stays null rather than inventing one.
                    overall: null,
                    status: (0, progress_reports_2.computeProgressStatus)(completedLessons, totalLessons),
                };
            });
            return { ok: true, value: records };
        }
        catch (error) {
            if (error instanceof InvalidCountError) {
                return { ok: false, code: 'incomplete', detail: `${error.field} count is invalid` };
            }
            throw error;
        }
    }
}
const createProgressReportSourceSql = (deps) => {
    if (!deps || typeof deps.transaction !== 'function') {
        throw new ProgressReportSourceSqlError('invalid_runner', 'ProgressReportSourceSql requires a connection-bound transaction runner');
    }
    return {
        listRecordsResult: (scope) => deps.transaction((conn) => (new ProgressReportSourceSqlReceiver(conn).listRecordsResult(scope))),
        findRecordResult: (tenantId, studentEnrollmentId, courseId) => deps.transaction((conn) => (new ProgressReportSourceSqlReceiver(conn).findRecordResult(tenantId, studentEnrollmentId, courseId))),
        listRecords: (scope) => deps.transaction((conn) => (new ProgressReportSourceSqlReceiver(conn).listRecords(scope))),
        findRecord: (tenantId, studentEnrollmentId, courseId) => deps.transaction((conn) => (new ProgressReportSourceSqlReceiver(conn).findRecord(tenantId, studentEnrollmentId, courseId))),
        inTransaction: (conn) => new ProgressReportSourceSqlReceiver(conn),
    };
};
exports.createProgressReportSourceSql = createProgressReportSourceSql;
const createBoundProgressReportSourceSql = (conn, deps) => (0, exports.createProgressReportSourceSql)(deps).inTransaction(conn);
exports.createBoundProgressReportSourceSql = createBoundProgressReportSourceSql;
