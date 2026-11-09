"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.createAttendanceRouter = void 0;
const express_1 = require("express");
const whatsapp_free_1 = require("../services/whatsapp-free");
const auth_1 = require("../middleware/auth");
const admin_permissions_1 = require("../security/admin-permissions");
const resource_branch_1 = require("../security/resource-branch");
const attendance_calendar_1 = require("../lib/attendance-calendar");
/** Status values allowed by the `attendance.status` enum column. */
const ATTENDANCE_STATUSES = ['present', 'absent', 'late', 'excused'];
/** Method values allowed by the `attendance.method` enum column. */
const ATTENDANCE_METHODS = ['manual', 'qr', 'barcode'];
/** Roles that may hold attendance authority inside a tenant. */
const ATTENDANCE_TEACHING_ROLES = new Set(['instructor', 'teacher', 'staff', 'admin']);
/** Longest accepted `notes` value; the column is TEXT but no caller needs more. */
const MAX_NOTES_LENGTH = 2000;
/** Calendar day (YYYY-MM-DD) shape accepted for every date input and filter. */
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
/** mysql2 duplicate-key error code (ER_DUP_ENTRY). */
const DUPLICATE_KEY_CODE = 'ER_DUP_ENTRY';
const DUPLICATE_MESSAGE = 'Attendance already recorded for this student on the selected date';
const isAttendanceStatus = (value) => typeof value === 'string' && ATTENDANCE_STATUSES.includes(value);
const isAttendanceMethod = (value) => typeof value === 'string' && ATTENDANCE_METHODS.includes(value);
/**
 * Normalize a date input to the calendar day it denotes (YYYY-MM-DD), or null
 * when the value is not a usable date. Delegates to the shared
 * Africa/Cairo attendance business-day calendar (supervisor/026): an explicit
 * YYYY-MM-DD key is a calendar day and is preserved unchanged after strict
 * validation, while a Date or ISO datetime converts to the Cairo calendar
 * day it denotes — never the UTC or host-local day.
 */
const normalizeDay = (value) => (0, attendance_calendar_1.normalizeAttendanceDay)(value);
const isDuplicateKeyError = (error) => typeof error === 'object' && error !== null
    && error.code === DUPLICATE_KEY_CODE;
/** Non-empty, trimmed string, or undefined when the value is absent. */
const readOptionalText = (value) => {
    if (value === undefined || value === null || value === '')
        return undefined;
    return typeof value === 'string' ? value : undefined;
};
/** Optional date input: undefined when absent, null when present but invalid. */
const readOptionalDay = (value) => {
    if (value === undefined || value === null || value === '')
        return undefined;
    return normalizeDay(value);
};
/**
 * Resolve the caller's attendance authority from the authenticated principal
 * only. Writes the refusal response and returns null when the caller may not
 * act at all, so no data access happens afterwards.
 */
const resolveAttendanceScope = async (req, res, hasVerifiedPlatformCapability) => {
    const user = req.user;
    if (!user) {
        res.status(401).json({ error: 'Authentication required' });
        return null;
    }
    if (!ATTENDANCE_TEACHING_ROLES.has(user.role)) {
        res.status(403).json({ error: 'Attendance access requires a teaching identity' });
        return null;
    }
    const instructorId = (0, auth_1.instructorScopeId)(req);
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
    return { platform, tenantId: user.tenantId ?? null, instructorId, userId: user.id };
};
let dbModule = null;
const loadDb = async () => {
    dbModule ?? (dbModule = await Promise.resolve().then(() => __importStar(require('../db'))));
    return dbModule;
};
/**
 * Verified platform capability, resolved server-side (active super_admin or a
 * seeded permission key). Never consults a JWT role claim.
 */
const verifiedPlatformCapability = async (userId) => {
    if (await (0, admin_permissions_1.isSuperAdmin)(userId))
        return true;
    return (await (0, admin_permissions_1.getAdminPermissions)(userId)).includes('security.manage');
};
const createAttendanceRouter = (deps) => {
    const router = (0, express_1.Router)();
    const { query, queryOne, execute } = deps.db;
    const hasVerifiedPlatformCapability = deps.hasVerifiedPlatformCapability;
    const now = deps.now ?? (() => new Date());
    router.use(deps.optionalAuthenticate);
    /**
     * Students the caller may act on, as a predicate over the `students`
     * table aliased `sc`. The selected tenant comes from the principal, so an
     * instructor's own students outside the selected workspace stay
     * unreachable, and a same-tenant foreign teacher reaches only that tenant.
     */
    const studentScopeSql = (scope) => {
        if (scope.platform)
            return { sql: '', params: [] };
        const tenantId = scope.tenantId;
        if (scope.instructorId) {
            return {
                sql: ` AND sc.tenant_id = ? AND (sc.instructor_id = ?
                        OR sc.group_id IN (SELECT g.id FROM \`groups\` g
                            INNER JOIN courses c ON c.id = g.course_id
                            WHERE g.instructor_id = ? AND c.tenant_id = sc.tenant_id))`,
                params: [tenantId, scope.instructorId, scope.instructorId],
            };
        }
        return { sql: ' AND sc.tenant_id = ?', params: [tenantId] };
    };
    const studentInScope = async (studentId, scope) => {
        const scopeSql = studentScopeSql(scope);
        const row = await queryOne(`SELECT sc.id FROM students sc WHERE sc.id = ?${scopeSql.sql}`, [studentId, ...scopeSql.params]);
        return !!row;
    };
    const attendanceMutationScope = (scope) => {
        if (scope.platform)
            return { sql: '', params: [] };
        const studentScope = studentScopeSql(scope);
        return {
            sql: ` AND student_id IN (SELECT sc.id FROM students sc WHERE 1=1${studentScope.sql})`,
            params: studentScope.params,
        };
    };
    /**
     * Course reference used by an attendance row must sit inside the caller's
     * selected tenant. A course with no provable tenant owner never matches,
     * and owning the course in another tenant does not widen the boundary.
     */
    const courseInScope = async (courseId, scope) => {
        const course = await queryOne('SELECT id, tenant_id FROM courses WHERE id = ?', [courseId]);
        if (!course)
            return { ok: false, status: 404, error: 'Course not found' };
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
    const groupInScope = async (groupId, scope) => {
        if (scope.platform)
            return true;
        const tenantId = scope.tenantId;
        if (scope.instructorId) {
            const row = await queryOne(`SELECT g.id FROM \`groups\` g
                 LEFT JOIN courses gc ON g.course_id = gc.id
                 WHERE g.id = ? AND g.instructor_id = ? AND gc.tenant_id = ?`, [groupId, scope.instructorId, tenantId]);
            return !!row;
        }
        const row = await queryOne(`SELECT g.id FROM \`groups\` g
             LEFT JOIN courses gc ON g.course_id = gc.id
             WHERE g.id = ? AND gc.tenant_id = ?`, [groupId, tenantId]);
        return !!row;
    };
    /**
     * Resource-derived branch check for an existing attendance row. The branch
     * comes from the row's group (or the student's group); a group-less row is
     * tenant-level under the existing tenant scope.
     */
    const enforceAttendanceBranch = async (req, res, attendanceId, requestedBranchId) => {
        if (!req.user) {
            res.status(401).json({ error: 'Authentication required' });
            return false;
        }
        const decision = await (0, resource_branch_1.resolveResourceBranchAccess)(deps.branchAccess ?? (0, resource_branch_1.getResourceBranchDeps)(), (0, resource_branch_1.principalFromAuthUser)(req.user), { resourceType: 'attendance', resourceId: attendanceId, requestedBranchId });
        if (decision.kind !== 'allowed') {
            const denial = (0, resource_branch_1.resourceBranchDenial)(decision);
            res.status(denial.status).json(denial.body);
            return false;
        }
        return true;
    };
    /** Validate the branch of the student's group before an attendance write. */
    const validateGroupBranchForWrite = async (user, groupId) => {
        if (!groupId)
            return { ok: true };
        const group = await queryOne('SELECT branch_id, branch_scope FROM `groups` WHERE id = ?', [groupId]);
        if (!group)
            return { ok: false, status: 404, error: 'Group not found' };
        if (group.branch_scope !== 'branch')
            return { ok: true };
        if (!group.branch_id)
            return { ok: false, status: 403, error: 'Branch context is ambiguous' };
        const tenantId = user.tenantId;
        if (!tenantId)
            return { ok: false, status: 403, error: 'Workspace access required' };
        const branch = await queryOne('SELECT tenant_id, status FROM branches WHERE id = ?', [group.branch_id]);
        if (!branch || branch.tenant_id !== tenantId || branch.status !== 'active') {
            return { ok: false, status: 403, error: 'Branch is outside your teaching scope' };
        }
        const owner = await queryOne("SELECT id FROM tenants WHERE id = ? AND owner_user_id = ? AND status = 'active'", [tenantId, user.id]);
        if (!owner) {
            const membership = await queryOne("SELECT id FROM branch_memberships WHERE branch_id = ? AND user_id = ? AND status = 'active'", [group.branch_id, user.id]);
            if (!membership)
                return { ok: false, status: 403, error: 'Branch membership required' };
        }
        return { ok: true };
    };
    /** Duplicate guard for one attendance record per student and calendar day. */
    const findDuplicate = async (studentId, day, exceptId) => queryOne(`SELECT id FROM attendance
             WHERE student_id = ? AND DATE(attendance_date) = ?${exceptId ? ' AND id <> ?' : ''}`, exceptId ? [studentId, day, exceptId] : [studentId, day]);
    // Get all attendance records
    router.get('/', deps.authenticate, async (req, res) => {
        try {
            const scope = await resolveAttendanceScope(req, res, hasVerifiedPlatformCapability);
            if (!scope)
                return;
            const { date, start_date, end_date, student_id, group_id, course_id, limit, order } = req.query;
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
            const params = [];
            if (dateDay) {
                sql += ' AND DATE(a.attendance_date) = ?';
                params.push(dateDay);
            }
            else if (startDay && endDay) {
                sql += ' AND DATE(a.attendance_date) BETWEEN ? AND ?';
                params.push(startDay, endDay);
            }
            else if (startDay) {
                sql += ' AND DATE(a.attendance_date) >= ?';
                params.push(startDay);
            }
            else if (endDay) {
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
            // Branch-owned attendance rows are visible only to a live member
            // of the derived branch or the tenant owner. Group-less rows stay
            // tenant-level under the existing student scope.
            if (!scope.platform && req.user) {
                sql += ` AND (COALESCE(a.group_id, s.group_id) IS NULL OR NOT EXISTS (
                    SELECT 1 FROM \`groups\` bg
                    WHERE bg.id = COALESCE(a.group_id, s.group_id) AND bg.branch_scope = 'branch'
                      AND NOT EXISTS (
                        SELECT 1 FROM branch_memberships bm
                        WHERE bm.branch_id = bg.branch_id AND bm.user_id = ? AND bm.status = 'active'
                      )
                      AND NOT EXISTS (
                        SELECT 1 FROM tenants owner_t
                        WHERE owner_t.id = ? AND owner_t.owner_user_id = ? AND owner_t.status = 'active'
                      )
                ))`;
                params.push(req.user.id, req.user.tenantId ?? null, req.user.id);
                if (req.user.branchId) {
                    sql += ` AND (COALESCE(a.group_id, s.group_id) IS NULL OR NOT EXISTS (
                        SELECT 1 FROM \`groups\` bg2
                        WHERE bg2.id = COALESCE(a.group_id, s.group_id)
                          AND bg2.branch_scope = 'branch' AND bg2.branch_id <> ?
                    ))`;
                    params.push(req.user.branchId);
                }
            }
            sql += ` ORDER BY a.attendance_date ${order === 'asc' ? 'ASC' : 'DESC'}, a.created_at DESC`;
            if (limit) {
                // Digits only. `parseInt('0x10')` returned 16 and `'5abc'`
                // returned 5, so a malformed `limit` silently became a real page
                // size instead of being ignored.
                const limitNum = typeof limit === 'string' && /^\d+$/.test(limit.trim())
                    ? Number(limit.trim())
                    : Number.NaN;
                if (Number.isSafeInteger(limitNum) && limitNum > 0 && limitNum <= 1000) {
                    // LIMIT cannot be a placeholder in MySQL prepared statements
                    sql += ` LIMIT ${limitNum}`;
                }
            }
            const attendance = await query(sql, params);
            res.json(attendance);
        }
        catch (error) {
            console.error('Get attendance error:', error);
            res.status(500).json({ error: 'Failed to fetch attendance records' });
        }
    });
    // Get attendance by ID
    router.get('/:id', deps.authenticate, async (req, res) => {
        try {
            const scope = await resolveAttendanceScope(req, res, hasVerifiedPlatformCapability);
            if (!scope)
                return;
            const attendance = await queryOne('SELECT * FROM attendance WHERE id = ?', [req.params.id]);
            if (!attendance) {
                return res.status(404).json({ error: 'Attendance record not found' });
            }
            // A record the caller may not act on is indistinguishable from a
            // missing one.
            if (!(await studentInScope(attendance.student_id, scope))) {
                return res.status(404).json({ error: 'Attendance record not found' });
            }
            if (!(await enforceAttendanceBranch(req, res, req.params.id, req.query?.branch_id)))
                return;
            res.json(attendance);
        }
        catch (error) {
            console.error('Get attendance by ID error:', error);
            res.status(500).json({ error: 'Failed to fetch attendance record' });
        }
    });
    // Mark attendance
    router.post('/', deps.authenticate, async (req, res) => {
        try {
            const scope = await resolveAttendanceScope(req, res, hasVerifiedPlatformCapability);
            if (!scope)
                return;
            const { barcode, student_id, attendance_date, status, course_id, group_id, notes } = req.body ?? {};
            if (status !== undefined && status !== null && !isAttendanceStatus(status)) {
                return res.status(400).json({ error: 'Invalid attendance status' });
            }
            if (notes !== undefined && notes !== null) {
                if (typeof notes !== 'string' || notes.length > MAX_NOTES_LENGTH) {
                    return res.status(400).json({ error: 'Invalid notes' });
                }
            }
            // An absent date defaults to the current Africa/Cairo business
            // day (supervisor/026); a present-but-invalid date is rejected
            // instead of being silently coerced to the current day.
            const requestedDay = readOptionalDay(attendance_date);
            if (requestedDay === null) {
                return res.status(400).json({ error: 'Invalid attendance_date' });
            }
            const day = requestedDay ?? (0, attendance_calendar_1.todayDayKey)(now());
            if (!day) {
                return res.status(400).json({ error: 'Invalid attendance_date' });
            }
            const barcodeValue = readOptionalText(barcode);
            const studentIdValue = readOptionalText(student_id);
            if (!studentIdValue && !barcodeValue) {
                return res.status(400).json({ error: 'barcode or student_id is required' });
            }
            let student = null;
            // Provenance: how this student was identified is recorded with the
            // mark. Every row used to be written `method = 'barcode'` — including
            // a staff member marking by `student_id` — so attendance provenance
            // was wrong for every manual mark, and `marked_by` was never
            // populated at all.
            let attendanceMethod = 'manual';
            if (barcodeValue) {
                // The barcode lookup carries the caller's scope, so a barcode
                // outside the selected tenant/ownership is indistinguishable
                // from an unknown one.
                const scopeSql = studentScopeSql(scope);
                student = await queryOne(`SELECT sc.id, sc.group_id FROM students sc
                     WHERE sc.barcode = ? AND sc.is_active = TRUE${scopeSql.sql}`, [barcodeValue, ...scopeSql.params]);
                if (!student) {
                    return res.status(404).json({ error: 'Student not found for provided barcode' });
                }
                attendanceMethod = 'barcode';
            }
            else {
                // The same liveness rule as the barcode path: a deactivated
                // student must not be reachable through one identification route
                // and unreachable through the other.
                const scopeSql = studentScopeSql(scope);
                student = await queryOne(`SELECT sc.id, sc.group_id FROM students sc
                     WHERE sc.id = ? AND sc.is_active = TRUE${scopeSql.sql}`, [studentIdValue, ...scopeSql.params]);
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
            const groupBranch = await validateGroupBranchForWrite(req.user, resolvedGroupId);
            if (!groupBranch.ok) {
                return res.status(groupBranch.status).json({ error: groupBranch.error });
            }
            let resolvedCourseId = null;
            const courseIdValue = readOptionalText(course_id);
            if (courseIdValue !== undefined) {
                const course = await courseInScope(courseIdValue, scope);
                if (!course.ok) {
                    return res.status(course.status).json({ error: course.error });
                }
                resolvedCourseId = courseIdValue;
            }
            // One attendance row per student per calendar day.
            //
            // The legacy `attendance` table has no UNIQUE key on
            // `(student_id, attendance_date)` — verified across every migration —
            // so the driver can never raise ER_DUP_ENTRY for this race and the
            // `isDuplicateKeyError` handler below is unreachable. The check and
            // the insert are therefore serialized on the STUDENT row: the
            // transaction locks `students` for this id, the duplicate read runs
            // inside that lock, and the insert follows in the same unit. A second
            // concurrent mark for the same student blocks on the lock, then sees
            // the committed row and answers 409 instead of inserting a twin.
            //
            // Without the transaction seam the guard cannot be performed soundly,
            // so the route refuses rather than racing: an unavailable guard is not
            // a reason to admit a double-counted mark.
            if (typeof deps.db.transaction !== 'function') {
                return res.status(503).json({ error: 'Attendance marking is temporarily unavailable' });
            }
            try {
                const writeScope = studentScopeSql(scope);
                const inserted = await deps.db.transaction(async (tx) => {
                    // Lock the student row first: this is what serializes two
                    // concurrent marks for the same student. `FOR UPDATE` on the
                    // scoped read means the second caller waits here rather than
                    // reading a stale "no duplicate yet".
                    const locked = await tx.queryOne(`SELECT sc.id FROM students sc WHERE sc.id = ? AND sc.is_active = TRUE${writeScope.sql} FOR UPDATE`, [student.id, ...writeScope.params]);
                    if (!locked)
                        return { affectedRows: 0 };
                    const duplicate = await tx.queryOne(`SELECT id FROM attendance
                         WHERE student_id = ? AND DATE(attendance_date) = ? LIMIT 1`, [student.id, day]);
                    if (duplicate) {
                        return { affectedRows: 0, duplicate: true };
                    }
                    return tx.execute(`INSERT INTO attendance (id, student_id, course_id, group_id, attendance_date, attendance_time, status, notes, method, marked_by, created_at)
                         SELECT UUID(), ?, ?, ?, ?, CURTIME(), ?, ?, ?, ?, NOW()
                         FROM students sc WHERE sc.id = ? AND sc.group_id <=> ? AND sc.is_active = TRUE${writeScope.sql}`, [student.id, resolvedCourseId, resolvedGroupId, day, status ?? 'present', notes ?? null,
                        attendanceMethod, scope.userId ?? null, student.id, resolvedGroupId, ...writeScope.params]);
                });
                const duplicate = inserted.duplicate === true;
                if (duplicate) {
                    return res.status(409).json({ error: DUPLICATE_MESSAGE });
                }
                // A usable count is required: `undefined` is neither zero nor one,
                // and treating it as either fabricates an outcome.
                if (typeof inserted.affectedRows !== 'number' || !Number.isSafeInteger(inserted.affectedRows)) {
                    throw new Error('attendance insert did not report a usable affected-row count');
                }
                if (inserted.affectedRows === 0) {
                    return res.status(404).json({ error: 'Student not found' });
                }
            }
            catch (error) {
                // Two concurrent marks for the same student and day both pass
                // the read check; the loser must be a 409, not a 500.
                if (isDuplicateKeyError(error)) {
                    return res.status(409).json({ error: DUPLICATE_MESSAGE });
                }
                throw error;
            }
            const newAttendance = await queryOne(`SELECT a.*, s.name AS student_name, s.group_id AS student_group_id
                 FROM attendance a
                 LEFT JOIN students s ON a.student_id = s.id
                 WHERE a.student_id = ? AND DATE(a.attendance_date) = ?
                 ORDER BY a.created_at DESC
                 LIMIT 1`, [student.id, day]);
            res.status(201).json(newAttendance);
        }
        catch (error) {
            console.error('Mark attendance error:', error);
            res.status(500).json({ error: 'Failed to mark attendance' });
        }
    });
    // Update attendance
    router.put('/:id', deps.authenticate, async (req, res) => {
        try {
            const scope = await resolveAttendanceScope(req, res, hasVerifiedPlatformCapability);
            if (!scope)
                return;
            // Ownership is resolved before any write, for every identity.
            const attendance = await queryOne('SELECT * FROM attendance WHERE id = ?', [req.params.id]);
            if (!attendance || !(await studentInScope(attendance.student_id, scope))) {
                return res.status(404).json({ error: 'Attendance record not found' });
            }
            if (!(await enforceAttendanceBranch(req, res, req.params.id, req.body?.branch_id)))
                return;
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
            const mutationScope = attendanceMutationScope(scope);
            const result = await execute(`UPDATE attendance
                 SET status = COALESCE(?, status),
                     notes = COALESCE(?, notes),
                     attendance_date = COALESCE(?, attendance_date)
                 WHERE id = ?${mutationScope.sql}`, [status ?? null, notes ?? null, nextDay ?? null, req.params.id, ...mutationScope.params]);
            if (result.affectedRows === 0) {
                return res.status(404).json({ error: 'Attendance record not found' });
            }
            const updatedAttendance = await queryOne(`SELECT * FROM attendance WHERE id = ?${mutationScope.sql}`, [req.params.id, ...mutationScope.params]);
            res.json(updatedAttendance);
        }
        catch (error) {
            console.error('Update attendance error:', error);
            res.status(500).json({ error: 'Failed to update attendance' });
        }
    });
    // Delete attendance
    router.delete('/:id', deps.authenticate, async (req, res) => {
        try {
            const scope = await resolveAttendanceScope(req, res, hasVerifiedPlatformCapability);
            if (!scope)
                return;
            // Ownership is resolved before any write, for every identity.
            const attendance = await queryOne('SELECT * FROM attendance WHERE id = ?', [req.params.id]);
            if (!attendance || !(await studentInScope(attendance.student_id, scope))) {
                return res.status(404).json({ error: 'Attendance record not found' });
            }
            if (!(await enforceAttendanceBranch(req, res, req.params.id)))
                return;
            const mutationScope = attendanceMutationScope(scope);
            const result = await execute(`DELETE FROM attendance WHERE id = ?${mutationScope.sql}`, [req.params.id, ...mutationScope.params]);
            if (result.affectedRows === 0) {
                return res.status(404).json({ error: 'Attendance record not found' });
            }
            res.json({ message: 'Attendance record deleted successfully' });
        }
        catch (error) {
            console.error('Delete attendance error:', error);
            res.status(500).json({ error: 'Failed to delete attendance record' });
        }
    });
    // Send WhatsApp notification for absent students in a group
    router.post('/notify-absent', deps.authenticate, async (req, res) => {
        try {
            const scope = await resolveAttendanceScope(req, res, hasVerifiedPlatformCapability);
            if (!scope)
                return;
            const { group_id, date } = req.body ?? {};
            if (typeof group_id !== 'string' || group_id.trim() === '' || !date) {
                return res.status(400).json({ error: 'group_id and date are required' });
            }
            const groupId = group_id.trim();
            const day = normalizeDay(date);
            if (!day) {
                return res.status(400).json({ error: 'Invalid date' });
            }
            // Only a group inside the caller's scope may trigger notifications.
            if (!(await groupInScope(groupId, scope))) {
                return res.status(403).json({ error: 'لا يمكن إرسال تنبيهات لمجموعة لا تتبعك' });
            }
            // Keep both the enrollment list and attendance lookup inside the
            // verified group and selected tenant, even if stored references are
            // inconsistent across tenants.
            const tenantClause = scope.platform ? '' : ' AND tenant_id = ?';
            const tenantParams = scope.platform ? [] : [scope.tenantId];
            const allStudents = await query(`SELECT id, name, phone, guardian_phone
                 FROM students
                 WHERE group_id = ? AND is_active = TRUE${tenantClause}`, [groupId, ...tenantParams]);
            if (allStudents.length === 0) {
                return res.status(404).json({ error: 'No students found in this group' });
            }
            const attendedStudents = await query(`SELECT DISTINCT student_id
                 FROM attendance
                 WHERE DATE(attendance_date) = ? AND status IN ('present','late','excused')
                   AND student_id IN (
                       SELECT id FROM students WHERE group_id = ?${tenantClause}
                   )`, [day, groupId, ...tenantParams]);
            // A student is absent only when NO row exists for the day. A `late`
            // or `excused` mark is a recorded, approved state, not an absence:
            // the old query counted only `present`, so a late or excused student
            // had no matching row, was classified absent, and the guardian
            // received "لم يحضر/تحضر اليوم" — a factually false notification for
            // an approved absence.
            const recordedIds = new Set(attendedStudents.map(({ student_id }) => student_id));
            const absentStudents = allStudents.filter((student) => !recordedIds.has(student.id));
            if (absentStudents.length === 0) {
                return res.json({
                    message: 'No absent students found',
                    total_students: allStudents.length,
                    attended: recordedIds.size,
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
                const message = `⚠️ *إشعار غياب*\n\n` +
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
                }
                catch (error) {
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
                attended: recordedIds.size,
                absent: absentStudents.length,
                notifications_sent: successCount,
                results: results,
                whatsapp_links: whatsappLinks
            });
        }
        catch (error) {
            console.error('Send absent notifications error:', error);
            res.status(500).json({ error: 'Failed to send absent notifications' });
        }
    });
    return router;
};
exports.createAttendanceRouter = createAttendanceRouter;
exports.default = (0, exports.createAttendanceRouter)({
    db: {
        query: async (sql, params) => (await loadDb()).query(sql, params),
        queryOne: async (sql, params) => (await loadDb()).queryOne(sql, params),
        execute: async (sql, params) => (await loadDb()).execute(sql, params),
        transaction: async (fn) => {
            const { withTransaction } = await loadDb();
            return withTransaction(async (connection) => {
                const tx = {
                    query: async (sql, params) => {
                        const [rows] = await connection.execute(sql, params);
                        return rows;
                    },
                    queryOne: async (sql, params) => {
                        const [rows] = await connection.execute(sql, params);
                        const list = rows;
                        return list.length > 0 ? list[0] : null;
                    },
                    execute: async (sql, params) => {
                        const [result] = await connection.execute(sql, params);
                        const header = result;
                        if (typeof header.affectedRows !== 'number' || !Number.isSafeInteger(header.affectedRows)) {
                            throw new Error('attendance transaction execute did not report a usable affected-row count');
                        }
                        return header;
                    },
                };
                return fn(tx);
            });
        },
    },
    authenticate: auth_1.authenticateToken,
    optionalAuthenticate: auth_1.optionalAuth,
    notify: { sendWhatsAppMessage: whatsapp_free_1.sendWhatsAppMessage },
    hasVerifiedPlatformCapability: verifiedPlatformCapability,
    now: () => new Date(),
});
