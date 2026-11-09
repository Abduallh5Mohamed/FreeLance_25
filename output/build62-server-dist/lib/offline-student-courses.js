"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.runStudentWriteTransaction = exports.StudentWriteRefusal = exports.lockOfflineCourseTarget = exports.createTransactionEnrollmentSeam = exports.applyOfflineCourseSelection = exports.normalizeCourseIds = exports.buildCourseAuthoritySql = exports.MAX_COURSE_ID_LENGTH = exports.MAX_COURSE_SELECTION = void 0;
/**
 * Offline-student course-selection contract.
 *
 * Human-approved M1 contract closure (supervisor/026, task
 * client-m1-contract-offline-courses-20261016-02): the offline-student
 * POST/PUT routes accept an optional `course_ids` array so an operator's
 * course selection actually persists.
 *
 * Semantics (bounded — no schema, migration, billing or entitlement change):
 *  - an ABSENT `course_ids` leaves the existing enrollment unchanged;
 *  - an explicit `[]` clears the offline enrollment selection;
 *  - the value must be an array of unique, non-empty id strings within a
 *    bounded length; anything else is a 400, never a coercion;
 *  - every requested course must exist inside the caller's server-derived
 *    authority (admin: all; a selected tenant: that tenant's courses; no
 *    tenant: tenant-less courses — the canonical `courseScope` contract in
 *    routes/courses.ts). A nonexistent id is a 404 and a course outside the
 *    caller's authority is a 403 — never silently dropped, never client
 *    authority;
 *  - the enrollment diff is applied INSIDE the caller's transaction: only
 *    added rows are inserted and only removed rows are deleted, so retained
 *    enrollments keep their status/progress/enrollment_date, and any failure
 *    rolls the whole student write back (no orphan, no partial replace).
 *
 * The seam is injectable: production binds the caller's transaction
 * connection; hermetic tests drive the real diff/authority logic with an
 * in-memory seam. No dotenv, no database, no network.
 */
const crypto_1 = __importDefault(require("crypto"));
/** Longest accepted course selection; keeps the IN(...) query bounded. */
exports.MAX_COURSE_SELECTION = 50;
/** Longest accepted single course id (UUID shape); no query text is trusted. */
exports.MAX_COURSE_ID_LENGTH = 64;
/**
 * The SQL predicate and params that restrict course lookups to the caller's
 * authority. Mirrors `courseScope` in routes/courses.ts exactly so a course
 * the operator can see is a course they may enroll a student into.
 */
const buildCourseAuthoritySql = (caller) => {
    if (caller.isAdmin)
        return { sql: '', params: [] };
    if (caller.tenantId)
        return { sql: ' AND tenant_id = ?', params: [caller.tenantId] };
    return { sql: ' AND tenant_id IS NULL', params: [] };
};
exports.buildCourseAuthoritySql = buildCourseAuthoritySql;
/**
 * Pure validation of a requested `course_ids` value: an array of unique,
 * non-empty id strings within the bounded length. Returns the normalized
 * list, or a rejection reason the route maps to 400.
 */
const normalizeCourseIds = (value) => {
    if (!Array.isArray(value)) {
        return { ok: false, error: 'course_ids must be an array of course ids' };
    }
    if (value.length > exports.MAX_COURSE_SELECTION) {
        return { ok: false, error: `course_ids may contain at most ${exports.MAX_COURSE_SELECTION} courses` };
    }
    const seen = new Set();
    const courseIds = [];
    for (const entry of value) {
        if (typeof entry !== 'string') {
            return { ok: false, error: 'course_ids must contain course id strings' };
        }
        const id = entry.trim();
        if (id === '' || id.length > exports.MAX_COURSE_ID_LENGTH) {
            return { ok: false, error: 'course_ids contains an invalid course id' };
        }
        if (seen.has(id)) {
            return { ok: false, error: 'course_ids must not contain duplicate course ids' };
        }
        seen.add(id);
        courseIds.push(id);
    }
    return { ok: true, courseIds };
};
exports.normalizeCourseIds = normalizeCourseIds;
/** A course id that does not exist anywhere. */
const NOT_FOUND_ERROR = 'One or more selected courses do not exist';
/** A course that exists but sits outside the caller's authority. */
const OUT_OF_SCOPE_ERROR = 'One or more selected courses are outside your teaching scope';
/**
 * Resolve and apply an offline student's course selection inside the
 * caller's transaction.
 *
 * `requested` is undefined when the field is absent (no change at all),
 * null when present but not an array (400), or the requested id list.
 * Returns the applied diff, or the precise refusal (404/403/400) the route
 * answers with after rolling back.
 */
const applyOfflineCourseSelection = async (studentId, requested, seam, caller) => {
    // Absent field: existing enrollment is preserved untouched.
    if (requested === undefined)
        return { ok: true, added: [], removed: [] };
    const validation = (0, exports.normalizeCourseIds)(requested);
    if (!validation.ok)
        return { ok: false, status: 400, error: validation.error };
    const wanted = validation.courseIds;
    const existing = new Set(await seam.findExistingCourseIds(wanted));
    const missing = wanted.filter((id) => !existing.has(id));
    if (missing.length > 0) {
        return { ok: false, status: 404, error: NOT_FOUND_ERROR };
    }
    const authorized = new Set(await seam.findAuthorizedCourseIds(wanted, caller));
    const foreign = wanted.filter((id) => !authorized.has(id));
    if (foreign.length > 0) {
        return { ok: false, status: 403, error: OUT_OF_SCOPE_ERROR };
    }
    const current = new Set(await seam.readEnrolledCourseIds(studentId));
    const added = wanted.filter((id) => !current.has(id));
    const removed = [...current].filter((id) => !wanted.includes(id));
    await seam.replaceEnrollment(studentId, added, removed);
    return { ok: true, added, removed };
};
exports.applyOfflineCourseSelection = applyOfflineCourseSelection;
/**
 * Production binding of the seam over a mysql2 transaction connection
 * (the same connection the student/user writes run on). The unique
 * (student_id, course_id) key makes the insert idempotent under a
 * concurrent duplicate; deletes only ever target the computed diff.
 */
const createTransactionEnrollmentSeam = (connection) => ({
    findExistingCourseIds: async (courseIds) => {
        if (courseIds.length === 0)
            return [];
        const [rows] = (await connection.execute(`SELECT id FROM courses WHERE id IN (${courseIds.map(() => '?').join(',')})`, courseIds));
        return rows.map((row) => String(row.id));
    },
    findAuthorizedCourseIds: async (courseIds, caller) => {
        if (courseIds.length === 0)
            return [];
        const authority = (0, exports.buildCourseAuthoritySql)(caller);
        const [rows] = (await connection.execute(`SELECT id FROM courses WHERE id IN (${courseIds.map(() => '?').join(',')})${authority.sql}`, [...courseIds, ...authority.params]));
        return rows.map((row) => String(row.id));
    },
    readEnrolledCourseIds: async (studentId) => {
        const [rows] = (await connection.execute('SELECT course_id FROM student_courses WHERE student_id = ?', [studentId]));
        return rows.map((row) => String(row.course_id));
    },
    replaceEnrollment: async (studentId, added, removed) => {
        if (removed.length > 0) {
            await connection.execute(`DELETE FROM student_courses WHERE student_id = ? AND course_id IN (${removed.map(() => '?').join(',')})`, [studentId, ...removed]);
        }
        for (const courseId of added) {
            // INSERT IGNORE: a concurrent identical enrollment is a no-op
            // under the unique (student_id, course_id) key.
            await connection.execute('INSERT IGNORE INTO student_courses (id, student_id, course_id) VALUES (?, ?, ?)', [crypto_1.default.randomUUID(), studentId, courseId]);
        }
    },
});
exports.createTransactionEnrollmentSeam = createTransactionEnrollmentSeam;
/** Only offline students may carry a course selection — enforced server-side. */
const OFFLINE_ONLY_ERROR = 'اختيار المقررات متاح لطلاب الأوفلاين فقط';
/**
 * Lock and validate the offline course-selection target INSIDE the caller's
 * transaction (supervisor/029): the student row is read with `FOR UPDATE` so
 * a concurrent replacement on the same student is serialized behind this
 * lock, and the stored `is_offline` predicate — never a UI flag or a
 * pre-transaction snapshot — decides eligibility. An instructor caller's
 * authority is re-validated under the same lock, so a student that left the
 * caller's scope mid-flight is refused rather than enrolled.
 *
 * Production binds `connection.execute`; hermetic tests inject an in-memory
 * seam and assert the real SQL this function emits.
 */
const lockOfflineCourseTarget = async (connection, studentId, scopeId) => {
    const [rows] = (await connection.execute(scopeId
        ? `SELECT s.id, s.is_offline FROM students s LEFT JOIN \`groups\` g ON s.group_id = g.id WHERE s.id = ? AND (s.instructor_id = ? OR g.instructor_id = ?) FOR UPDATE`
        : 'SELECT id, is_offline FROM students WHERE id = ? FOR UPDATE', scopeId ? [studentId, scopeId, scopeId] : [studentId]));
    const row = rows?.[0];
    if (!row) {
        return { ok: false, status: 404, error: 'Student not found' };
    }
    if (Number(row.is_offline) !== 1) {
        return { ok: false, status: 400, error: OFFLINE_ONLY_ERROR };
    }
    return { ok: true };
};
exports.lockOfflineCourseTarget = lockOfflineCourseTarget;
/** A deliberate refusal the route answers with a 4xx, never a 500. */
class StudentWriteRefusal extends Error {
    constructor(status, error) {
        super(error);
        this.status = status;
        this.error = error;
        this.name = 'StudentWriteRefusal';
    }
}
exports.StudentWriteRefusal = StudentWriteRefusal;
const runStudentWriteTransaction = async (connection, body) => {
    let began = false;
    try {
        await connection.beginTransaction();
        began = true;
        const result = await body(connection);
        await connection.commit();
        return result;
    }
    catch (error) {
        // Only roll back a transaction that actually began. A failed begin must
        // not attempt a rollback on a connection that was never opened.
        if (began) {
            try {
                await connection.rollback();
            }
            catch (rollbackError) {
                // The body/commit error is the one the caller must see; record
                // the failed rollback as its cause rather than swapping it in.
                if (error instanceof Error) {
                    error.cause = rollbackError;
                }
            }
        }
        throw error;
    }
    finally {
        // Always release the connection exactly once — even when begin or
        // rollback rejected — so a pooled connection never leaks.
        connection.release();
    }
};
exports.runStudentWriteTransaction = runStudentWriteTransaction;
