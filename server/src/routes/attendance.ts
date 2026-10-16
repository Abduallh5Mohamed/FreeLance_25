import { Router, RequestHandler, Response } from 'express';
import { sendWhatsAppMessage } from '../services/whatsapp-free';
import {
    authenticateToken,
    instructorScopeId,
    optionalAuth,
    AuthRequest,
} from '../middleware/auth';
import { isSuperAdmin, getAdminPermissions } from '../security/admin-permissions';

/**
 * Attendance router.
 *
 * Authorization model — every decision is derived from server-side principal
 * state (never from a body or query id):
 *  - every route requires an authenticated principal: an anonymous caller is
 *    rejected before any data access, and a malformed token never downgrades
 *    to anonymous;
 *  - an instructor acts only inside the server-derived selected tenant and
 *    only on their own students (direct assignment or an own group);
 *  - a teacher/staff identity acts only inside the selected tenant;
 *  - a verified platform operator (active super_admin or a seeded permission
 *    key — never a role claim) acts across tenants;
 *  - student/parent identities carry no attendance authority;
 *  - body-supplied group/course ids are validated against the resolved
 *    student and the caller's scope instead of being trusted;
 *  - status, date and notes inputs are validated against the `attendance`
 *    schema, so a rejected value is a 4xx and never a driver error.
 *
 * No attendance billing or grade semantics are changed here.
 */

/**
 * Data-access seam for the attendance router. Production binds ../db; hermetic
 * tests inject isolated fixtures through the same boundary so the real
 * authorization logic runs without a database.
 *
 * The shape is referenced by `typeof import` only, so importing this module
 * never executes db.ts: no dotenv side effect and no pool creation. The pool
 * is created on the first real query of the production binding below.
 */
type DbModule = typeof import('../db');

export interface AttendanceDataAccess {
    query: DbModule['query'];
    queryOne: DbModule['queryOne'];
    execute: DbModule['execute'];
}

/**
 * Notification seam. Production binds the free WhatsApp deep-link service;
 * hermetic tests inject a recorder, so no message is ever generated in tests.
 */
export interface AttendanceNotificationService {
    sendWhatsAppMessage: (to: string, body: string) => Promise<{
        success: boolean;
        whatsappLink?: string;
        error?: string;
    }>;
}

/**
 * Injectable seams for the attendance router. The default export binds the
 * production SQL adapters, the real authentication middleware, the real
 * notification service, and the server-verified platform capability check.
 * Tests inject fixtures through this boundary instead of bypassing production
 * authorization.
 */
export interface AttendanceRouterDeps {
    db: AttendanceDataAccess;
    authenticate: RequestHandler;
    optionalAuthenticate: RequestHandler;
    notify: AttendanceNotificationService;
    hasVerifiedPlatformCapability: (userId: string) => Promise<boolean>;
}

/** Status values allowed by the `attendance.status` enum column. */
const ATTENDANCE_STATUSES = ['present', 'absent', 'late', 'excused'] as const;
type AttendanceStatus = (typeof ATTENDANCE_STATUSES)[number];

/** Method values allowed by the `attendance.method` enum column. */
const ATTENDANCE_METHODS = ['manual', 'qr', 'barcode'] as const;
type AttendanceMethod = (typeof ATTENDANCE_METHODS)[number];

/** Roles that may hold attendance authority inside a tenant. */
const ATTENDANCE_TEACHING_ROLES = new Set(['instructor', 'teacher', 'staff', 'admin']);

/** Longest accepted `notes` value; the column is TEXT but no caller needs more. */
const MAX_NOTES_LENGTH = 2000;

/** Calendar day (YYYY-MM-DD) shape accepted for every date input and filter. */
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** mysql2 duplicate-key error code (ER_DUP_ENTRY). */
const DUPLICATE_KEY_CODE = 'ER_DUP_ENTRY';

const DUPLICATE_MESSAGE = 'Attendance already recorded for this student on the selected date';

const isAttendanceStatus = (value: unknown): value is AttendanceStatus =>
    typeof value === 'string' && (ATTENDANCE_STATUSES as readonly string[]).includes(value);

const isAttendanceMethod = (value: unknown): value is AttendanceMethod =>
    typeof value === 'string' && (ATTENDANCE_METHODS as readonly string[]).includes(value);

/**
 * Normalize a date input to the calendar day it denotes (YYYY-MM-DD), or null
 * when the value is not a usable date. Keeps the historical day extraction so
 * existing clients that send a Date or an ISO string keep working.
 */
const normalizeDay = (value: unknown): string | null => {
    if (value instanceof Date) return normalizeDay(value.toISOString());
    if (typeof value !== 'string' || value === '') return null;
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return null;
    const day = parsed.toISOString().slice(0, 10);
    return DAY_PATTERN.test(day) ? day : null;
};

const isDuplicateKeyError = (error: unknown): boolean =>
    typeof error === 'object' && error !== null
    && (error as { code?: unknown }).code === DUPLICATE_KEY_CODE;

/** Non-empty, trimmed string, or undefined when the value is absent. */
const readOptionalText = (value: unknown): string | undefined => {
    if (value === undefined || value === null || value === '') return undefined;
    return typeof value === 'string' ? value : undefined;
};

/** Optional date input: undefined when absent, null when present but invalid. */
const readOptionalDay = (value: unknown): string | null | undefined => {
    if (value === undefined || value === null || value === '') return undefined;
    return normalizeDay(value);
};

interface Attendance {
    id: string;
    student_id: string;
    course_id?: string;
    group_id?: string;
    attendance_date: Date;
    status: AttendanceStatus;
    notes?: string;
    method?: AttendanceMethod;
    created_at: Date;
}

/** An attendance row as loaded from the data layer (nullable foreign keys). */
interface AttendanceRow {
    id: string;
    student_id: string;
    course_id: string | null;
    group_id: string | null;
    attendance_date: Date;
    attendance_time: string | null;
    status: AttendanceStatus;
    notes: string | null;
    marked_by: string | null;
    method: AttendanceMethod;
    created_at: Date;
}

interface StudentRefRow {
    id: string;
    group_id: string | null;
}

/**
 * Attendance authority of the resolved principal.
 *
 * `tenantId` is the server-derived selected workspace: absent for a verified
 * platform operator only. `instructorId` is non-null only for the instructor
 * role, which additionally restricts acting to own students.
 */
interface AttendanceScope {
    platform: boolean;
    tenantId: string | null;
    instructorId: string | null;
}

/**
 * Resolve the caller's attendance authority from the authenticated principal
 * only. Writes the refusal response and returns null when the caller may not
 * act at all, so no data access happens afterwards.
 */
const resolveAttendanceScope = async (
    req: AuthRequest,
    res: Response,
    hasVerifiedPlatformCapability: (userId: string) => Promise<boolean>,
): Promise<AttendanceScope | null> => {
    const user = req.user;
    if (!user) {
        res.status(401).json({ error: 'Authentication required' });
        return null;
    }
    if (!ATTENDANCE_TEACHING_ROLES.has(user.role)) {
        res.status(403).json({ error: 'Attendance access requires a teaching identity' });
        return null;
    }

    const instructorId = instructorScopeId(req);
    if (instructorId && !user.tenantId) {
        // Zero, ambiguous or revoked workspace selection: denied before any
        // lookup, never silently widened to every tenant.
        res.status(403).json({ error: 'Workspace access required' });
        return null;
    }

    const platform = !instructorId && await hasVerifiedPlatformCapability(user.id);
    if (!instructorId && !platform && !user.tenantId) {
        res.status(403).json({ error: 'Workspace access required' });
        return null;
    }

    return { platform, tenantId: user.tenantId ?? null, instructorId };
};

let dbModule: DbModule | null = null;
const loadDb = async (): Promise<DbModule> => {
    dbModule ??= await import('../db');
    return dbModule;
};

/**
 * Verified platform capability, resolved server-side (active super_admin or a
 * seeded permission key). Never consults a JWT role claim.
 */
const verifiedPlatformCapability = async (userId: string): Promise<boolean> => {
    if (await isSuperAdmin(userId)) return true;
    return (await getAdminPermissions(userId)).includes('security.manage');
};

export const createAttendanceRouter = (deps: AttendanceRouterDeps): Router => {
    const router = Router();
    const { query, queryOne, execute } = deps.db;
    const hasVerifiedPlatformCapability = deps.hasVerifiedPlatformCapability;
    router.use(deps.optionalAuthenticate);

    /**
     * Students the caller may act on, as a predicate over the `students`
     * table aliased `sc`. The selected tenant comes from the principal, so an
     * instructor's own students outside the selected workspace stay
     * unreachable, and a same-tenant foreign teacher reaches only that tenant.
     */
    const studentScopeSql = (scope: AttendanceScope): { sql: string; params: unknown[] } => {
        if (scope.platform) return { sql: '', params: [] };
        const tenantId = scope.tenantId as string;
        if (scope.instructorId) {
            return {
                sql: ` AND sc.tenant_id = ? AND (sc.instructor_id = ?
                        OR sc.group_id IN (SELECT id FROM \`groups\` WHERE instructor_id = ?))`,
                params: [tenantId, scope.instructorId, scope.instructorId],
            };
        }
        return { sql: ' AND sc.tenant_id = ?', params: [tenantId] };
    };

    const studentInScope = async (studentId: string, scope: AttendanceScope): Promise<boolean> => {
        const scopeSql = studentScopeSql(scope);
        const row = await queryOne(
            `SELECT sc.id FROM students sc WHERE sc.id = ?${scopeSql.sql}`,
            [studentId, ...scopeSql.params],
        );
        return !!row;
    };

    /**
     * Course reference used by an attendance row must sit inside the caller's
     * selected tenant. A course with no provable tenant owner never matches,
     * and owning the course in another tenant does not widen the boundary.
     */
    const courseInScope = async (
        courseId: string,
        scope: AttendanceScope,
    ): Promise<{ ok: true } | { ok: false; status: 404 | 403; error: string }> => {
        const course = await queryOne<{ id: string; tenant_id: string | null }>(
            'SELECT id, tenant_id FROM courses WHERE id = ?',
            [courseId],
        );
        if (!course) return { ok: false, status: 404, error: 'Course not found' };
        if (!scope.platform && (!scope.tenantId || String(course.tenant_id) !== String(scope.tenantId))) {
            return { ok: false, status: 403, error: 'Course is outside your teaching scope' };
        }
        return { ok: true };
    };

    /**
     * A group used by an attendance row must belong to the caller's scope.
     * `groups` carries no tenant column, so the group's tenant is derived
     * through its course (same rule as the materials router).
     */
    const groupInScope = async (groupId: string, scope: AttendanceScope): Promise<boolean> => {
        if (scope.platform) return true;
        const tenantId = scope.tenantId as string;
        if (scope.instructorId) {
            const row = await queryOne(
                `SELECT g.id FROM \`groups\` g
                 LEFT JOIN courses gc ON g.course_id = gc.id
                 WHERE g.id = ? AND g.instructor_id = ? AND gc.tenant_id = ?`,
                [groupId, scope.instructorId, tenantId],
            );
            return !!row;
        }
        const row = await queryOne(
            `SELECT g.id FROM \`groups\` g
             LEFT JOIN courses gc ON g.course_id = gc.id
             WHERE g.id = ? AND gc.tenant_id = ?`,
            [groupId, tenantId],
        );
        return !!row;
    };

    /** Duplicate guard for one attendance record per student and calendar day. */
    const findDuplicate = async (studentId: string, day: string, exceptId?: string) =>
        queryOne(
            `SELECT id FROM attendance
             WHERE student_id = ? AND DATE(attendance_date) = ?${exceptId ? ' AND id <> ?' : ''}`,
            exceptId ? [studentId, day, exceptId] : [studentId, day],
        );

    // Get all attendance records
    router.get('/', deps.authenticate, async (req: AuthRequest, res: Response) => {
        try {
            const scope = await resolveAttendanceScope(req, res, hasVerifiedPlatformCapability);
            if (!scope) return;

            const { date, start_date, end_date, student_id, group_id, course_id, limit, order } =
                req.query as Record<string, unknown>;

            const dateDay = readOptionalDay(date);
            const startDay = readOptionalDay(start_date);
            const endDay = readOptionalDay(end_date);
            if ((date && !dateDay) || (start_date && !startDay) || (end_date && !endDay)) {
                return res.status(400).json({ error: 'Invalid date filter' });
            }

            let sql = `
                SELECT
                    a.id,
                    a.student_id,
                    a.course_id,
                    COALESCE(a.group_id, s.group_id) as group_id,
                    a.attendance_date,
                    a.attendance_time,
                    a.status,
                    a.notes,
                    a.marked_by,
                    a.method,
                    a.created_at,
                    s.name as student_name,
                    s.barcode as student_barcode
                FROM attendance a
                LEFT JOIN students s ON a.student_id = s.id
                WHERE 1=1
            `;
            const params: unknown[] = [];

            if (dateDay) {
                sql += ' AND DATE(a.attendance_date) = ?';
                params.push(dateDay);
            } else if (startDay && endDay) {
                sql += ' AND DATE(a.attendance_date) BETWEEN ? AND ?';
                params.push(startDay, endDay);
            } else if (startDay) {
                sql += ' AND DATE(a.attendance_date) >= ?';
                params.push(startDay);
            } else if (endDay) {
                sql += ' AND DATE(a.attendance_date) <= ?';
                params.push(endDay);
            }
            if (readOptionalText(student_id)) {
                sql += ' AND a.student_id = ?';
                params.push(student_id);
            }
            if (readOptionalText(group_id)) {
                // Use COALESCE to match either explicit attendance group_id or fallback to student's group_id
                sql += ' AND COALESCE(a.group_id, s.group_id) = ?';
                params.push(group_id);
            }
            if (readOptionalText(course_id)) {
                sql += ' AND a.course_id = ?';
                params.push(course_id);
            }

            const studentScope = studentScopeSql(scope);
            if (studentScope.sql) {
                sql += ` AND a.student_id IN (SELECT sc.id FROM students sc WHERE 1=1${studentScope.sql})`;
                params.push(...studentScope.params);
            }

            sql += ` ORDER BY a.attendance_date ${order === 'asc' ? 'ASC' : 'DESC'}, a.created_at DESC`;

            if (limit) {
                const limitNum = parseInt(limit as string);
                if (!isNaN(limitNum) && limitNum > 0 && limitNum <= 1000) {
                    // LIMIT cannot be a placeholder in MySQL prepared statements
                    sql += ` LIMIT ${limitNum}`;
                }
            }

            const attendance = await query<Attendance>(sql, params);
            res.json(attendance);
        } catch (error) {
            console.error('Get attendance error:', error);
            res.status(500).json({ error: 'Failed to fetch attendance records' });
        }
    });

    // Get attendance by ID
    router.get('/:id', deps.authenticate, async (req: AuthRequest, res: Response) => {
        try {
            const scope = await resolveAttendanceScope(req, res, hasVerifiedPlatformCapability);
            if (!scope) return;

            const attendance = await queryOne<AttendanceRow>('SELECT * FROM attendance WHERE id = ?', [req.params.id]);

            if (!attendance) {
                return res.status(404).json({ error: 'Attendance record not found' });
            }
            // A record the caller may not act on is indistinguishable from a
            // missing one.
            if (!(await studentInScope(attendance.student_id, scope))) {
                return res.status(404).json({ error: 'Attendance record not found' });
            }

            res.json(attendance);
        } catch (error) {
            console.error('Get attendance by ID error:', error);
            res.status(500).json({ error: 'Failed to fetch attendance record' });
        }
    });

    // Mark attendance
    router.post('/', deps.authenticate, async (req: AuthRequest, res: Response) => {
        try {
            const scope = await resolveAttendanceScope(req, res, hasVerifiedPlatformCapability);
            if (!scope) return;

            const { barcode, student_id, attendance_date, status, course_id, group_id, notes } = req.body ?? {};

            if (status !== undefined && status !== null && !isAttendanceStatus(status)) {
                return res.status(400).json({ error: 'Invalid attendance status' });
            }
            if (notes !== undefined && notes !== null) {
                if (typeof notes !== 'string' || notes.length > MAX_NOTES_LENGTH) {
                    return res.status(400).json({ error: 'Invalid notes' });
                }
            }

            // An absent date defaults to today; a present-but-invalid date is
            // rejected instead of being silently coerced to the current day
            // (`null ?? new Date()` used to swallow the invalid case).
            const requestedDay = readOptionalDay(attendance_date);
            if (requestedDay === null) {
                return res.status(400).json({ error: 'Invalid attendance_date' });
            }
            const day = requestedDay ?? normalizeDay(new Date());
            if (!day) {
                return res.status(400).json({ error: 'Invalid attendance_date' });
            }

            const barcodeValue = readOptionalText(barcode);
            const studentIdValue = readOptionalText(student_id);
            if (!studentIdValue && !barcodeValue) {
                return res.status(400).json({ error: 'barcode or student_id is required' });
            }

            let student: StudentRefRow | null = null;

            if (barcodeValue) {
                // The barcode lookup carries the caller's scope, so a barcode
                // outside the selected tenant/ownership is indistinguishable
                // from an unknown one.
                const scopeSql = studentScopeSql(scope);
                student = await queryOne<StudentRefRow>(
                    `SELECT sc.id, sc.group_id FROM students sc
                     WHERE sc.barcode = ? AND sc.is_active = TRUE${scopeSql.sql}`,
                    [barcodeValue, ...scopeSql.params],
                );
                if (!student) {
                    return res.status(404).json({ error: 'Student not found for provided barcode' });
                }
            } else {
                student = await queryOne<StudentRefRow>(
                    'SELECT id, group_id FROM students WHERE id = ?',
                    [studentIdValue],
                );
                if (!student) {
                    return res.status(404).json({ error: 'Student not found' });
                }
            }

            // Instructors can only mark attendance for their own students.
            if (!(await studentInScope(student.id, scope))) {
                return res.status(403).json({ error: 'لا يمكن تسجيل حضور لطالب لا يتبعك' });
            }

            // The stored group is server-derived from the resolved student; a
            // client-supplied group that disagrees with it is refused instead
            // of mis-attributing attendance to a foreign group.
            const resolvedGroupId = student.group_id ?? null;
            const groupIdValue = readOptionalText(group_id);
            if (group_id !== undefined && group_id !== null && group_id !== '' && groupIdValue === undefined) {
                return res.status(400).json({ error: 'Invalid group_id' });
            }
            if (groupIdValue !== undefined && groupIdValue !== String(resolvedGroupId ?? '')) {
                return res.status(400).json({ error: 'group_id does not match the student group' });
            }

            let resolvedCourseId: string | null = null;
            const courseIdValue = readOptionalText(course_id);
            if (courseIdValue !== undefined) {
                const course = await courseInScope(courseIdValue, scope);
                if (!course.ok) {
                    return res.status(course.status).json({ error: course.error });
                }
                resolvedCourseId = courseIdValue;
            }

            const existing = await findDuplicate(student.id, day);
            if (existing) {
                return res.status(409).json({ error: DUPLICATE_MESSAGE });
            }

            try {
                await execute(
                    `INSERT INTO attendance (id, student_id, course_id, group_id, attendance_date, attendance_time, status, notes, method, created_at)
                     VALUES (UUID(), ?, ?, ?, ?, CURTIME(), ?, ?, 'barcode', NOW())`,
                    [student.id, resolvedCourseId, resolvedGroupId, day, status ?? 'present', notes ?? null]
                );
            } catch (error) {
                // Two concurrent marks for the same student and day both pass
                // the read check; the loser must be a 409, not a 500.
                if (isDuplicateKeyError(error)) {
                    return res.status(409).json({ error: DUPLICATE_MESSAGE });
                }
                throw error;
            }

            const newAttendance = await queryOne(
                `SELECT a.*, s.name AS student_name, s.group_id AS student_group_id
                 FROM attendance a
                 LEFT JOIN students s ON a.student_id = s.id
                 WHERE a.student_id = ? AND DATE(a.attendance_date) = ?
                 ORDER BY a.created_at DESC
                 LIMIT 1`,
                [student.id, day]
            );

            res.status(201).json(newAttendance);
        } catch (error) {
            console.error('Mark attendance error:', error);
            res.status(500).json({ error: 'Failed to mark attendance' });
        }
    });

    // Update attendance
    router.put('/:id', deps.authenticate, async (req: AuthRequest, res: Response) => {
        try {
            const scope = await resolveAttendanceScope(req, res, hasVerifiedPlatformCapability);
            if (!scope) return;

            // Ownership is resolved before any write, for every identity.
            const attendance = await queryOne<AttendanceRow>('SELECT * FROM attendance WHERE id = ?', [req.params.id]);
            if (!attendance || !(await studentInScope(attendance.student_id, scope))) {
                return res.status(404).json({ error: 'Attendance record not found' });
            }

            const { status, notes, attendance_date } = req.body ?? {};

            if (status !== undefined && status !== null && !isAttendanceStatus(status)) {
                return res.status(400).json({ error: 'Invalid attendance status' });
            }
            if (notes !== undefined && notes !== null) {
                if (typeof notes !== 'string' || notes.length > MAX_NOTES_LENGTH) {
                    return res.status(400).json({ error: 'Invalid notes' });
                }
            }

            const nextDay = readOptionalDay(attendance_date);
            if (nextDay === null) {
                return res.status(400).json({ error: 'Invalid attendance_date' });
            }
            if (nextDay) {
                // Moving a record to another day must not create a second
                // record for the same student and day.
                const clash = await findDuplicate(attendance.student_id, nextDay, attendance.id);
                if (clash) {
                    return res.status(409).json({ error: DUPLICATE_MESSAGE });
                }
            }

            const result = await execute(
                `UPDATE attendance
                 SET status = COALESCE(?, status),
                     notes = COALESCE(?, notes),
                     attendance_date = COALESCE(?, attendance_date)
                 WHERE id = ?`,
                [status ?? null, notes ?? null, nextDay ?? null, req.params.id]
            );

            if (result.affectedRows === 0) {
                return res.status(404).json({ error: 'Attendance record not found' });
            }

            const updatedAttendance = await queryOne<Attendance>(
                'SELECT * FROM attendance WHERE id = ?',
                [req.params.id]
            );

            res.json(updatedAttendance);
        } catch (error) {
            console.error('Update attendance error:', error);
            res.status(500).json({ error: 'Failed to update attendance' });
        }
    });

    // Delete attendance
    router.delete('/:id', deps.authenticate, async (req: AuthRequest, res: Response) => {
        try {
            const scope = await resolveAttendanceScope(req, res, hasVerifiedPlatformCapability);
            if (!scope) return;

            // Ownership is resolved before any write, for every identity.
            const attendance = await queryOne<AttendanceRow>('SELECT * FROM attendance WHERE id = ?', [req.params.id]);
            if (!attendance || !(await studentInScope(attendance.student_id, scope))) {
                return res.status(404).json({ error: 'Attendance record not found' });
            }

            const result = await execute(
                'DELETE FROM attendance WHERE id = ?',
                [req.params.id]
            );

            if (result.affectedRows === 0) {
                return res.status(404).json({ error: 'Attendance record not found' });
            }

            res.json({ message: 'Attendance record deleted successfully' });
        } catch (error) {
            console.error('Delete attendance error:', error);
            res.status(500).json({ error: 'Failed to delete attendance record' });
        }
    });

    // Send WhatsApp notification for absent students in a group
    router.post('/notify-absent', deps.authenticate, async (req: AuthRequest, res: Response) => {
        try {
            const scope = await resolveAttendanceScope(req, res, hasVerifiedPlatformCapability);
            if (!scope) return;

            const { group_id, date } = req.body ?? {};

            if (!group_id || !date) {
                return res.status(400).json({ error: 'group_id and date are required' });
            }

            const day = normalizeDay(date);
            if (!day) {
                return res.status(400).json({ error: 'Invalid date' });
            }

            // Only a group inside the caller's scope may trigger notifications.
            if (!(await groupInScope(group_id, scope))) {
                return res.status(403).json({ error: 'لا يمكن إرسال تنبيهات لمجموعة لا تتبعك' });
            }

            // Get all students in the group
            const allStudents = await query(
                `SELECT id, name, phone, guardian_phone, barcode
                 FROM students
                 WHERE group_id = ? AND is_active = TRUE`,
                [group_id]
            );

            if (!Array.isArray(allStudents) || allStudents.length === 0) {
                return res.status(404).json({ error: 'No students found in this group' });
            }

            // Get students who attended today
            const attendedStudents = await query(
                `SELECT student_id
                 FROM attendance
                 WHERE DATE(attendance_date) = ? AND status = 'present'`,
                [day]
            );

            const attendedIds = Array.isArray(attendedStudents)
                ? attendedStudents.map((a: any) => a.student_id)
                : [];

            // Find absent students
            const absentStudents = allStudents.filter((student: any) =>
                !attendedIds.includes(student.id)
            );

            if (absentStudents.length === 0) {
                return res.json({
                    message: 'No absent students found',
                    total_students: allStudents.length,
                    attended: attendedIds.length,
                    absent: 0,
                    notifications_sent: 0,
                    whatsapp_links: []
                });
            }

            // Send WhatsApp notifications
            const results = [];
            const whatsappLinks = [];

            for (const student of absentStudents) {
                const phone = student.guardian_phone || student.phone;

                if (!phone) {
                    results.push({
                        student_name: student.name,
                        success: false,
                        error: 'No phone number available'
                    });
                    continue;
                }

                const message =
                    `⚠️ *إشعار غياب*\n\n` +
                    `عزيزي ولي أمر الطالب/ة:\n` +
                    `👤 *${student.name}*\n\n` +
                    `نفيدكم بأن الطالب/ة لم يحضر/تحضر اليوم:\n` +
                    `📅 *${new Date(day).toLocaleDateString('ar-EG')}*\n\n` +
                    `يرجى التواصل معنا لمعرفة السبب.\n\n` +
                    `Tabweb Academy 📚`;

                try {
                    const result = await deps.notify.sendWhatsAppMessage(phone, message);

                    results.push({
                        student_name: student.name,
                        phone: phone,
                        success: result.success,
                        whatsapp_link: result.whatsappLink
                    });

                    if (result.whatsappLink) {
                        whatsappLinks.push({
                            student_name: student.name,
                            phone: phone,
                            link: result.whatsappLink
                        });
                    }
                } catch (error) {
                    results.push({
                        student_name: student.name,
                        success: false,
                        error: error instanceof Error ? error.message : 'Unknown error'
                    });
                }
            }

            const successCount = results.filter(r => r.success).length;

            res.json({
                message: `WhatsApp links generated for ${successCount} absent students`,
                total_students: allStudents.length,
                attended: attendedIds.length,
                absent: absentStudents.length,
                notifications_sent: successCount,
                results: results,
                whatsapp_links: whatsappLinks
            });
        } catch (error) {
            console.error('Send absent notifications error:', error);
            res.status(500).json({ error: 'Failed to send absent notifications' });
        }
    });

    return router;
};

export default createAttendanceRouter({
    db: {
        query: async <T>(sql: string, params?: unknown[]) => (await loadDb()).query<T>(sql, params),
        queryOne: async <T>(sql: string, params?: unknown[]) => (await loadDb()).queryOne<T>(sql, params),
        execute: async (sql: string, params?: unknown[]) => (await loadDb()).execute(sql, params),
    },
    authenticate: authenticateToken,
    optionalAuthenticate: optionalAuth,
    notify: { sendWhatsAppMessage },
    hasVerifiedPlatformCapability: verifiedPlatformCapability,
});
