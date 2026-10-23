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
import crypto from 'crypto';

/** Longest accepted course selection; keeps the IN(...) query bounded. */
export const MAX_COURSE_SELECTION = 50;

/** Longest accepted single course id (UUID shape); no query text is trusted. */
export const MAX_COURSE_ID_LENGTH = 64;

/** Caller authority used to resolve course visibility (mirrors courseScope). */
export interface CourseAuthorityCaller {
    /** Server-derived selected tenant; null for platform roles without one. */
    tenantId: string | null;
    /** The admin platform role, unrestricted by tenant (canonical courseScope). */
    isAdmin: boolean;
}

/**
 * The SQL predicate and params that restrict course lookups to the caller's
 * authority. Mirrors `courseScope` in routes/courses.ts exactly so a course
 * the operator can see is a course they may enroll a student into.
 */
export const buildCourseAuthoritySql = (
    caller: CourseAuthorityCaller,
): { sql: string; params: unknown[] } => {
    if (caller.isAdmin) return { sql: '', params: [] };
    if (caller.tenantId) return { sql: ' AND tenant_id = ?', params: [caller.tenantId] };
    return { sql: ' AND tenant_id IS NULL', params: [] };
};

/**
 * Pure validation of a requested `course_ids` value: an array of unique,
 * non-empty id strings within the bounded length. Returns the normalized
 * list, or a rejection reason the route maps to 400.
 */
export const normalizeCourseIds = (
    value: unknown,
): { ok: true; courseIds: string[] } | { ok: false; error: string } => {
    if (!Array.isArray(value)) {
        return { ok: false, error: 'course_ids must be an array of course ids' };
    }
    if (value.length > MAX_COURSE_SELECTION) {
        return { ok: false, error: `course_ids may contain at most ${MAX_COURSE_SELECTION} courses` };
    }
    const seen = new Set<string>();
    const courseIds: string[] = [];
    for (const entry of value) {
        if (typeof entry !== 'string') {
            return { ok: false, error: 'course_ids must contain course id strings' };
        }
        const id = entry.trim();
        if (id === '' || id.length > MAX_COURSE_ID_LENGTH) {
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

/**
 * Data-access seam over the caller's transaction connection. Production
 * binds these to `connection.execute`; hermetic tests inject an in-memory
 * implementation so the real diff and authority logic runs without a DB.
 */
export interface OfflineCourseEnrollmentSeam {
    /** Course ids that exist at all (any tenant/owner). */
    findExistingCourseIds: (courseIds: string[]) => Promise<string[]>;
    /** Course ids that exist AND sit inside the caller's authority. */
    findAuthorizedCourseIds: (
        courseIds: string[],
        caller: CourseAuthorityCaller,
    ) => Promise<string[]>;
    /** The student's currently enrolled course ids. */
    readEnrolledCourseIds: (studentId: string) => Promise<string[]>;
    /** Insert added and delete removed rows (inside the caller's transaction). */
    replaceEnrollment: (
        studentId: string,
        added: string[],
        removed: string[],
    ) => Promise<void>;
}

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
export const applyOfflineCourseSelection = async (
    studentId: string,
    requested: unknown,
    seam: OfflineCourseEnrollmentSeam,
    caller: CourseAuthorityCaller,
): Promise<
    | { ok: true; added: string[]; removed: string[] }
    | { ok: false; status: 400 | 403 | 404; error: string }
> => {
    // Absent field: existing enrollment is preserved untouched.
    if (requested === undefined) return { ok: true, added: [], removed: [] };

    const validation = normalizeCourseIds(requested);
    if (!validation.ok) return { ok: false, status: 400, error: validation.error };
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

/**
 * Production binding of the seam over a mysql2 transaction connection
 * (the same connection the student/user writes run on). The unique
 * (student_id, course_id) key makes the insert idempotent under a
 * concurrent duplicate; deletes only ever target the computed diff.
 */
export const createTransactionEnrollmentSeam = (
    connection: {
        execute: (sql: string, params: unknown[]) => Promise<unknown>;
    },
): OfflineCourseEnrollmentSeam => ({
    findExistingCourseIds: async (courseIds) => {
        if (courseIds.length === 0) return [];
        const [rows] = (await connection.execute(
            `SELECT id FROM courses WHERE id IN (${courseIds.map(() => '?').join(',')})`,
            courseIds,
        )) as [{ id: string }[], unknown];
        return rows.map((row) => String(row.id));
    },
    findAuthorizedCourseIds: async (courseIds, caller) => {
        if (courseIds.length === 0) return [];
        const authority = buildCourseAuthoritySql(caller);
        const [rows] = (await connection.execute(
            `SELECT id FROM courses WHERE id IN (${courseIds.map(() => '?').join(',')})${authority.sql}`,
            [...courseIds, ...authority.params],
        )) as [{ id: string }[], unknown];
        return rows.map((row) => String(row.id));
    },
    readEnrolledCourseIds: async (studentId) => {
        const [rows] = (await connection.execute(
            'SELECT course_id FROM student_courses WHERE student_id = ?',
            [studentId],
        )) as [{ course_id: string }[], unknown];
        return rows.map((row) => String(row.course_id));
    },
    replaceEnrollment: async (studentId, added, removed) => {
        if (removed.length > 0) {
            await connection.execute(
                `DELETE FROM student_courses WHERE student_id = ? AND course_id IN (${removed.map(() => '?').join(',')})`,
                [studentId, ...removed],
            );
        }
        for (const courseId of added) {
            // INSERT IGNORE: a concurrent identical enrollment is a no-op
            // under the unique (student_id, course_id) key.
            await connection.execute(
                'INSERT IGNORE INTO student_courses (id, student_id, course_id) VALUES (?, ?, ?)',
                [crypto.randomUUID(), studentId, courseId],
            );
        }
    },
});

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
export const lockOfflineCourseTarget = async (
    connection: {
        execute: (sql: string, params: unknown[]) => Promise<unknown>;
    },
    studentId: string,
    scopeId: string | null,
): Promise<{ ok: true } | { ok: false; status: 404 | 400; error: string }> => {
    const [rows] = (await connection.execute(
        scopeId
            ? `SELECT s.id, s.is_offline FROM students s LEFT JOIN \`groups\` g ON s.group_id = g.id WHERE s.id = ? AND (s.instructor_id = ? OR g.instructor_id = ?) FOR UPDATE`
            : 'SELECT id, is_offline FROM students WHERE id = ? FOR UPDATE',
        scopeId ? [studentId, scopeId, scopeId] : [studentId],
    )) as [{ id: string; is_offline: unknown }[], unknown];
    const row = rows?.[0];
    if (!row) {
        return { ok: false, status: 404, error: 'Student not found' };
    }
    if (Number(row.is_offline) !== 1) {
        return { ok: false, status: 400, error: OFFLINE_ONLY_ERROR };
    }
    return { ok: true };
};

/**
 * The smallest production transaction runner used by the student write
 * handlers (supervisor/035, hardened for the 036/037 connection-release
 * boundary). It owns begin/commit/rollback/release so the handler body only
 * expresses the work. A thrown `StudentWriteRefusal` or any error rolls the
 * whole transaction back and releases the connection; a normal return commits
 * and releases. The handlers must never call begin/commit/rollback/release
 * themselves — that boundary is what the transaction tests pin, so a route can
 * neither drop a commit/release nor issue an enrollment write before the lock.
 *
 * Release-boundary invariant (supervisor/037): `beginTransaction` runs INSIDE
 * the try block, and a `began` flag records whether a transaction actually
 * opened. A connection that failed to begin MUST NOT be rolled back, but it
 * MUST still be released — otherwise a pooled connection leaks. If rollback
 * itself rejects, the primary body/commit error is preserved (recorded as its
 * `cause`) and still rethrown; `release` always runs in the finally block so
 * the connection is returned exactly once regardless of where the failure sat.
 */
export interface WriteTransactionConnection {
    beginTransaction: () => Promise<void>;
    commit: () => Promise<void>;
    rollback: () => Promise<void>;
    release: () => void;
    execute: (sql: string, params?: unknown[]) => Promise<unknown>;
}

/** A deliberate refusal the route answers with a 4xx, never a 500. */
export class StudentWriteRefusal extends Error {
    constructor(
        public readonly status: 400 | 403 | 404 | 409,
        public readonly error: string,
    ) {
        super(error);
        this.name = 'StudentWriteRefusal';
    }
}

export const runStudentWriteTransaction = async <T>(
    connection: WriteTransactionConnection,
    body: (connection: WriteTransactionConnection) => Promise<T>,
): Promise<T> => {
    let began = false;
    try {
        await connection.beginTransaction();
        began = true;
        const result = await body(connection);
        await connection.commit();
        return result;
    } catch (error) {
        // Only roll back a transaction that actually began. A failed begin must
        // not attempt a rollback on a connection that was never opened.
        if (began) {
            try {
                await connection.rollback();
            } catch (rollbackError) {
                // The body/commit error is the one the caller must see; record
                // the failed rollback as its cause rather than swapping it in.
                if (error instanceof Error) {
                    (error as { cause?: unknown }).cause = rollbackError;
                }
            }
        }
        throw error;
    } finally {
        // Always release the connection exactly once — even when begin or
        // rollback rejected — so a pooled connection never leaks.
        connection.release();
    }
};
