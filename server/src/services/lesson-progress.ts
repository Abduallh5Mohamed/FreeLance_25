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
import { randomUUID } from 'crypto';

export interface LessonProgressDb {
    query: <T = unknown>(sql: string, params?: unknown[]) => Promise<T[]>;
    queryOne: <T = unknown>(sql: string, params?: unknown[]) => Promise<T | null>;
    execute: (sql: string, params?: unknown[]) => Promise<{ insertId?: number; affectedRows?: number }>;
}

export interface RecordCompletionInput {
    tenantId: string;
    studentEnrollmentId: string;
    courseId: string;
    lectureId: string;
    source: string;
}

export interface LessonProgressService {
    /** True when a completion record already exists for this enrollment+lesson. */
    isCompleted(studentEnrollmentId: string, lectureId: string): Promise<boolean>;
    /** All completed lecture ids for one enrollment inside one course. */
    completedLectureIds(studentEnrollmentId: string, courseId: string): Promise<string[]>;
    /**
     * Idempotently record a completion. `created` is true only for the request
     * that actually inserted the row; a retry (or a race that loses the unique
     * key) resolves to `created: false`.
     */
    recordCompletion(input: RecordCompletionInput): Promise<{ created: boolean }>;
}

/** MySQL duplicate-key error, recognised without importing the driver. */
export function isDuplicateEntryError(error: unknown): boolean {
    if (!error || typeof error !== 'object') return false;
    return (error as { code?: unknown }).code === 'ER_DUP_ENTRY';
}

export function createLessonProgressService(
    db: LessonProgressDb,
    idFactory: () => string = randomUUID,
): LessonProgressService {
    return {
        isCompleted: async (studentEnrollmentId, lectureId) => {
            const row = await db.queryOne<{ id: string }>(
                `SELECT id FROM lesson_completions
                 WHERE student_enrollment_id = ? AND lecture_id = ? LIMIT 1`,
                [studentEnrollmentId, lectureId],
            );
            return row !== null;
        },

        completedLectureIds: async (studentEnrollmentId, courseId) => {
            const rows = await db.query<{ lecture_id: string }>(
                `SELECT DISTINCT lecture_id FROM lesson_completions
                 WHERE student_enrollment_id = ? AND course_id = ?`,
                [studentEnrollmentId, courseId],
            );
            return rows.map((row) => row.lecture_id);
        },

        recordCompletion: async (input) => {
            try {
                const result = await db.execute(
                    `INSERT INTO lesson_completions
                       (id, tenant_id, student_enrollment_id, course_id, lecture_id, source)
                     VALUES (?, ?, ?, ?, ?, ?)`,
                    [
                        idFactory(),
                        input.tenantId,
                        input.studentEnrollmentId,
                        input.courseId,
                        input.lectureId,
                        input.source,
                    ],
                );
                return { created: (result.affectedRows ?? 0) > 0 };
            } catch (error) {
                if (isDuplicateEntryError(error)) return { created: false };
                throw error;
            }
        },
    };
}
