"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isDuplicateEntryError = isDuplicateEntryError;
exports.createLessonProgressService = createLessonProgressService;
/**
 * C7 lesson completion records.
 *
 * The store is deliberately small and idempotent: recording the same
 * completion twice never creates a duplicate row (the table's UNIQUE key on
 * `(student_enrollment_id, lecture_id)` is the authority) and never reports a
 * second creation, so the caller's audit write fires exactly once per real
 * completion. Every row is tenant-scoped by the caller, which derives the
 * tenant, enrollment, course and lecture from server state only.
 *
 * No `any`, no ts-ignore, no runtime DDL.
 */
const crypto_1 = require("crypto");
/** MySQL duplicate-key error, recognised without importing the driver. */
function isDuplicateEntryError(error) {
    if (!error || typeof error !== 'object')
        return false;
    return error.code === 'ER_DUP_ENTRY';
}
function createLessonProgressService(db, idFactory = crypto_1.randomUUID) {
    return {
        isCompleted: async (studentEnrollmentId, lectureId) => {
            const row = await db.queryOne(`SELECT id FROM lesson_completions
                 WHERE student_enrollment_id = ? AND lecture_id = ? LIMIT 1`, [studentEnrollmentId, lectureId]);
            return row !== null;
        },
        completedLectureIds: async (studentEnrollmentId, courseId) => {
            const rows = await db.query(`SELECT DISTINCT lecture_id FROM lesson_completions
                 WHERE student_enrollment_id = ? AND course_id = ?`, [studentEnrollmentId, courseId]);
            return rows.map((row) => row.lecture_id);
        },
        recordCompletion: async (input) => {
            try {
                const result = await db.execute(`INSERT INTO lesson_completions
                       (id, tenant_id, student_enrollment_id, course_id, lecture_id, source)
                     VALUES (?, ?, ?, ?, ?, ?)`, [
                    idFactory(),
                    input.tenantId,
                    input.studentEnrollmentId,
                    input.courseId,
                    input.lectureId,
                    input.source,
                ]);
                return { created: (result.affectedRows ?? 0) > 0 };
            }
            catch (error) {
                if (isDuplicateEntryError(error))
                    return { created: false };
                throw error;
            }
        },
    };
}
