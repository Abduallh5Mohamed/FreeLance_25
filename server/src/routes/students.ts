import { Router, Request, Response, RequestHandler } from 'express';
import type { PoolConnection } from 'mysql2/promise';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { getPool, query, queryOne, execute } from '../db';
import { optionalAuth, instructorScopeId, AuthRequest, authenticateToken } from '../middleware/auth';
import { requireTeachingWrite } from '../middleware/teaching-access';
import { normalizeEgyptianPhone, phoneLookupCandidates } from '../security/phone';
import { isSuperAdmin } from '../security/admin-permissions';
import {
    applyOfflineCourseSelection,
    createTransactionEnrollmentSeam,
    lockOfflineCourseTarget,
    runStudentWriteTransaction,
    StudentWriteRefusal,
    type CourseAuthorityCaller,
} from '../lib/offline-student-courses';


const STUDENT_COLUMNS = `
    s.id, s.user_id, s.tenant_id, s.name, s.email, s.phone, s.guardian_phone,
    s.guardian_name, s.grade, s.grade_id, s.group_id, s.instructor_id, s.barcode,
    s.is_offline, s.approval_status, s.parent_phone, s.address, s.notes,
    s.is_active, s.created_at, s.updated_at`;

export interface StudentsRouterDeps {
    query: typeof query;
    queryOne: typeof queryOne;
    authenticate: RequestHandler;
    optionalAuth: RequestHandler;
    hasPlatformCapability: (userId: string) => Promise<boolean>;
}

const defaultStudentsRouterDeps: StudentsRouterDeps = {
    query,
    queryOne,
    authenticate: authenticateToken,
    optionalAuth,
    hasPlatformCapability: isSuperAdmin,
};

// Does this student belong to the instructor? Either directly assigned
// (instructor_id) or a member of one of the instructor's groups.
const isStudentInScope = async (studentId: string, scopeId: string): Promise<boolean> => {
    const row = await queryOne(
        `SELECT s.id
         FROM students s
         LEFT JOIN \`groups\` g ON s.group_id = g.id
         WHERE s.id = ? AND (s.instructor_id = ? OR g.instructor_id = ?)`,
        [studentId, scopeId, scopeId]
    );
    return !!row;
};

// Check that a group belongs to the instructor (used when assigning groups)
const isGroupInScope = async (groupId: string | null | undefined, scopeId: string): Promise<boolean> => {
    if (!groupId) return true;
    const row = await queryOne('SELECT id FROM `groups` WHERE id = ? AND instructor_id = ?', [groupId, scopeId]);
    return !!row;
};

interface StudentReadScope {
    tenantId?: string;
    studentId?: string;
    platformWide: boolean;
}

const BARCODE_CHARSET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const BARCODE_LENGTH = 25;

const generateBarcode = (): string => {
    let code = '';
    for (let i = 0; i < BARCODE_LENGTH; i += 1) {
        const index = Math.floor(Math.random() * BARCODE_CHARSET.length);
        code += BARCODE_CHARSET[index];
    }
    return code;
};

const sanitizeBarcode = (value: string): string => {
    const normalized = value.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
    if (normalized.length !== BARCODE_LENGTH) {
        const error = new Error('INVALID_BARCODE_LENGTH');
        error.name = 'INVALID_BARCODE_LENGTH';
        throw error;
    }
    return normalized;
};

export const createStudentsRouter = (deps: StudentsRouterDeps = defaultStudentsRouterDeps): Router => {
    const router = Router();
    router.use(deps.optionalAuth);

    const resolveReadScope = async (req: AuthRequest, allowStudent: boolean): Promise<StudentReadScope | null> => {
        const user = req.user;
        if (!user || !['admin', 'instructor', 'teacher', 'staff', 'student'].includes(user.role)) return null;
        if (user.role === 'student') {
            if (!allowStudent || !user.tenantId || !user.studentEnrollmentId) return null;
            return { tenantId: user.tenantId, studentId: user.studentEnrollmentId, platformWide: false };
        }
        if (user.role === 'admin' && await deps.hasPlatformCapability(user.id)) {
            return { platformWide: true };
        }
        return user.tenantId ? { tenantId: user.tenantId, platformWide: false } : null;
    };

    const scopePredicate = (scope: StudentReadScope): { sql: string; params: string[] } => {
        if (scope.platformWide) return { sql: '', params: [] };
        const predicates = ['s.tenant_id = ?'];
        const params = [scope.tenantId as string];
        if (scope.studentId) {
            predicates.push('s.id = ?');
            params.push(scope.studentId);
        }
        return { sql: ` AND ${predicates.join(' AND ')}`, params };
    };

    // Get all students
    router.get('/', deps.authenticate, async (req: AuthRequest, res: Response) => {
    try {
        const scope = await resolveReadScope(req, false);
        if (!scope) return res.status(403).json({ error: 'Forbidden' });
        const scoped = scopePredicate(scope);
        const sql = `SELECT
                ${STUDENT_COLUMNS},
                g.name AS grade_name,
                grp.name AS group_name,
                s.created_at AS enrollment_date,
                (
                    SELECT GROUP_CONCAT(DISTINCT c.name ORDER BY c.name SEPARATOR ',')
                    FROM student_courses sc
                    INNER JOIN courses c ON sc.course_id = c.id
                    WHERE sc.student_id = s.id
                ) AS course_names,
                (
                    SELECT GROUP_CONCAT(DISTINCT sc.course_id ORDER BY sc.course_id SEPARATOR ',')
                    FROM student_courses sc
                    WHERE sc.student_id = s.id
                ) AS course_ids
             FROM students s
             LEFT JOIN grades g ON s.grade_id = g.id
             LEFT JOIN \`groups\` grp ON s.group_id = grp.id
             WHERE s.is_active = TRUE${scoped.sql}
             ORDER BY s.name`;
        const students = await deps.query(sql, scoped.params);
        res.json(students);
    } catch (error) {
        console.error('Get students error:', error);
        res.status(500).json({ error: 'Failed to fetch students' });
    }
});

// The authenticated principal is the only source of student identity. A scoped
// token is issued after the student chooses an instructor workspace.
router.get('/me', deps.authenticate, async (req: AuthRequest, res: Response) => {
    if (req.user?.role !== 'student' || !req.user.studentEnrollmentId || !req.user.tenantId) {
        return res.status(409).json({ error: 'Select an instructor workspace first', code: 'STUDENT_SPACE_REQUIRED' });
    }
    const student = await deps.queryOne(
        `SELECT s.id,s.user_id,s.tenant_id,s.name,s.phone,s.guardian_name,s.guardian_phone,s.grade_id,s.group_id,
                s.barcode,s.approval_status,s.is_active,g.name grade_name,grp.name group_name,t.business_name
         FROM students s INNER JOIN tenants t ON t.id=s.tenant_id
         LEFT JOIN grades g ON g.id=s.grade_id LEFT JOIN \`groups\` grp ON grp.id=s.group_id
         WHERE s.id=? AND s.user_id=? AND s.tenant_id=? AND s.is_active=1`,
        [req.user.studentEnrollmentId, req.user.id, req.user.tenantId]
    );
    if (!student) return res.status(404).json({ error: 'Student enrollment not found' });
    res.json(student);
});

// Get student by ID
router.get('/:id', deps.authenticate, async (req: AuthRequest, res: Response) => {
    try {
        const scope = await resolveReadScope(req, true);
        if (!scope) return res.status(403).json({ error: 'Forbidden' });
        const scoped = scopePredicate(scope);
        const student = await deps.queryOne(
            `SELECT
                ${STUDENT_COLUMNS},
                g.name AS grade_name,
                grp.name AS group_name,
                s.created_at AS enrollment_date,
                (
                    SELECT GROUP_CONCAT(DISTINCT c.name ORDER BY c.name SEPARATOR ',')
                    FROM student_courses sc
                    INNER JOIN courses c ON sc.course_id = c.id
                    WHERE sc.student_id = s.id
                ) AS course_names,
                (
                    SELECT GROUP_CONCAT(DISTINCT sc.course_id ORDER BY sc.course_id SEPARATOR ',')
                    FROM student_courses sc
                    WHERE sc.student_id = s.id
                ) AS course_ids
             FROM students s
             LEFT JOIN grades g ON s.grade_id = g.id
             LEFT JOIN \`groups\` grp ON s.group_id = grp.id
             WHERE s.id = ? AND s.is_active = TRUE${scoped.sql}`,
            [req.params.id, ...scoped.params]
        );

        if (!student) {
            return res.status(404).json({ error: 'Student not found' });
        }
        res.json(student);
    } catch (error) {
        console.error('Get student by ID error:', error);
        res.status(500).json({ error: 'Failed to fetch student' });
    }
});

// Get student by email
router.get('/email/:email', deps.authenticate, async (req: AuthRequest, res: Response) => {
    try {
        const scope = await resolveReadScope(req, true);
        if (!scope) return res.status(403).json({ error: 'Forbidden' });
        const scoped = scopePredicate(scope);
        const student = await deps.queryOne(
            `SELECT
                ${STUDENT_COLUMNS},
                g.name AS grade_name,
                grp.name AS group_name,
                s.created_at AS enrollment_date,
                (
                    SELECT GROUP_CONCAT(DISTINCT c.name ORDER BY c.name SEPARATOR ',')
                    FROM student_courses sc
                    INNER JOIN courses c ON sc.course_id = c.id
                    WHERE sc.student_id = s.id
                ) AS course_names,
                (
                    SELECT GROUP_CONCAT(DISTINCT sc.course_id ORDER BY sc.course_id SEPARATOR ',')
                    FROM student_courses sc
                    WHERE sc.student_id = s.id
                ) AS course_ids
             FROM students s
             LEFT JOIN grades g ON s.grade_id = g.id
             LEFT JOIN \`groups\` grp ON s.group_id = grp.id
             WHERE s.email = ? AND s.is_active = TRUE${scoped.sql}`,
            [req.params.email, ...scoped.params]
        );

        if (!student) {
            return res.status(404).json({ error: 'Student not found' });
        }
        res.json(student);
    } catch (error) {
        console.error('Get student by email error:', error);
        res.status(500).json({ error: 'Failed to fetch student' });
    }
});

// Get student by phone
router.get('/phone/:phone', deps.authenticate, async (req: AuthRequest, res: Response) => {
    try {
        const scope = await resolveReadScope(req, false);
        if (!scope) return res.status(403).json({ error: 'Forbidden' });
        const scoped = scopePredicate(scope);
        const student = await deps.queryOne(
            `SELECT
                ${STUDENT_COLUMNS},
                g.name AS grade_name,
                grp.name AS group_name,
                s.created_at AS enrollment_date,
                (
                    SELECT GROUP_CONCAT(DISTINCT c.name ORDER BY c.name SEPARATOR ',')
                    FROM student_courses sc
                    INNER JOIN courses c ON sc.course_id = c.id
                    WHERE sc.student_id = s.id
                ) AS course_names,
                (
                    SELECT GROUP_CONCAT(DISTINCT sc.course_id ORDER BY sc.course_id SEPARATOR ',')
                    FROM student_courses sc
                    WHERE sc.student_id = s.id
                ) AS course_ids
             FROM students s
             LEFT JOIN grades g ON s.grade_id = g.id
             LEFT JOIN \`groups\` grp ON s.group_id = grp.id
             WHERE s.phone = ? AND s.is_active = TRUE${scoped.sql}`,
            [req.params.phone, ...scoped.params]
        );

        if (!student) {
            return res.status(404).json({ error: 'Student not found' });
        }
        res.json(student);
    } catch (error) {
        console.error('Get student by phone error:', error);
        res.status(500).json({ error: 'Failed to fetch student' });
    }
});

// Get student by ID
router.get('/barcode/:barcode', deps.authenticate, async (req: AuthRequest, res: Response) => {
    try {
        const scope = await resolveReadScope(req, true);
        if (!scope) return res.status(403).json({ error: 'Forbidden' });
        const scoped = scopePredicate(scope);
        const student = await deps.queryOne(
            `SELECT
                ${STUDENT_COLUMNS},
                g.name AS grade_name,
                grp.name AS group_name,
                s.created_at AS enrollment_date,
                (
                    SELECT GROUP_CONCAT(DISTINCT c.name ORDER BY c.name SEPARATOR ',')
                    FROM student_courses sc
                    INNER JOIN courses c ON sc.course_id = c.id
                    WHERE sc.student_id = s.id
                ) AS course_names,
                (
                    SELECT GROUP_CONCAT(DISTINCT sc.course_id ORDER BY sc.course_id SEPARATOR ',')
                    FROM student_courses sc
                    WHERE sc.student_id = s.id
                ) AS course_ids
             FROM students s
             LEFT JOIN grades g ON s.grade_id = g.id
             LEFT JOIN \`groups\` grp ON s.group_id = grp.id
             WHERE s.barcode = ? AND s.is_active = TRUE${scoped.sql}`,
            [req.params.barcode, ...scoped.params]
        );

        if (!student) {
            return res.status(404).json({ error: 'Student not found' });
        }
        res.json(student);
    } catch (error) {
        console.error('Get student error:', error);
        res.status(500).json({ error: 'Failed to fetch student' });
    }
});

// (moved email & phone handlers above to avoid route conflicts)

// Create new student
/**
 * Course-selection authority for the offline-student contract
 * (supervisor/026): the caller's server-derived selected tenant, with the
 * admin platform role unrestricted — the canonical `courseScope` rule from
 * routes/courses.ts, never a body-supplied id.
 */
const courseAuthorityCaller = async (req: AuthRequest): Promise<CourseAuthorityCaller> => ({
    tenantId: req.user?.tenantId ?? null,
    isAdmin: req.user?.role === 'admin' && await deps.hasPlatformCapability(req.user.id),
});

router.post('/', requireTeachingWrite('students'), async (req: AuthRequest, res: Response) => {
    try {
        const scopeId = instructorScopeId(req);
        const { name, email, phone, guardian_phone, grade, grade_id, group_id, password, barcode: incomingBarcode, is_offline = false, approval_status = 'approved', course_ids } = req.body;
        const offline = is_offline === true || is_offline === 1 || is_offline === 'true';

        // Server-enforced offline-only eligibility (supervisor/029): a course
        // selection on a creation whose stored student would NOT be offline is
        // refused here, never silently applied or ignored.
        if (course_ids !== undefined && !offline) {
            return res.status(400).json({ error: 'اختيار المقررات متاح لطلاب الأوفلاين فقط' });
        }

        if (!String(name || '').trim()) {
            return res.status(400).json({ error: 'اسم الطالب مطلوب' });
        }
        if (!offline && (!String(phone || '').trim() || String(password || '').length < 10)) {
            return res.status(400).json({ error: 'طالب الأونلاين يحتاج رقم هاتف وكلمة مرور من 10 أحرف على الأقل' });
        }

        // Instructors always own the students they create, and can only place
        // them in their own groups
        let finalGroupId = group_id || null;
        if (scopeId) {
            if (finalGroupId && !(await isGroupInScope(finalGroupId, scopeId))) {
                return res.status(403).json({ error: 'لا يمكن إضافة الطالب لمجموعة لا تخصك' });
            }
        }

        // Generate UUID for new student
        const studentId = crypto.randomUUID();

        // Insert into students table
        let barcodeToStore: string;
        try {
            barcodeToStore = incomingBarcode ? sanitizeBarcode(incomingBarcode) : generateBarcode();
        } catch (validationError) {
            if ((validationError as Error).name === 'INVALID_BARCODE_LENGTH') {
                return res.status(400).json({ error: 'Barcode must be exactly 25 alphanumeric characters.' });
            }
            throw validationError;
        }

        const connection = await getPool().getConnection();
        try {
            await runStudentWriteTransaction(connection, async () => {
                const [tenantRows] = scopeId ? await connection.execute<any[]>(
                    "SELECT id FROM tenants WHERE owner_user_id=? AND status='active' LIMIT 1", [scopeId]
                ) : [[] as any];
                const tenantId = tenantRows?.[0]?.id || null;
                let linkedUserId: string | null = null;
                let normalizedPhone = phone ? normalizeEgyptianPhone(phone) : null;
                if (!offline) {
                    if (!normalizedPhone) throw new StudentWriteRefusal(400, 'Invalid Egyptian mobile number');
                    const candidates = phoneLookupCandidates(normalizedPhone);
                    const [existingUsers] = await connection.execute<any[]>(
                        `SELECT id FROM users WHERE role='student' AND phone IN (${candidates.map(() => '?').join(',')}) LIMIT 1`, candidates
                    );
                    linkedUserId = existingUsers?.[0]?.id || crypto.randomUUID();
                    if (tenantId) {
                        const [membership] = await connection.execute<any[]>('SELECT id FROM students WHERE tenant_id=? AND user_id=? LIMIT 1', [tenantId, linkedUserId]);
                        if (membership?.[0]) throw new StudentWriteRefusal(409, 'Student already belongs to this instructor');
                    }
                    if (!existingUsers?.[0]) {
                        const passwordHash = await bcrypt.hash(String(password), 12);
                        await connection.execute(
                            `INSERT INTO users (id,email,password_hash,role,phone,name,student_id,is_active)
                             VALUES (?,?,?,'student',?,?,?,1)`,
                            [linkedUserId, email || null, passwordHash, normalizedPhone, String(name).trim(), studentId]
                        );
                    }
                }
                await connection.execute(
                    `INSERT INTO students (id,user_id,tenant_id,name,email,phone,guardian_phone,grade,grade_id,group_id,instructor_id,barcode,is_offline,approval_status)
                     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
                    [studentId, linkedUserId, tenantId, String(name).trim(), email || null, normalizedPhone || phone || null,
                        guardian_phone || null, grade || null, grade_id || null, finalGroupId, scopeId, barcodeToStore, offline ? 1 : 0, approval_status]
                );

                // Optional course selection (supervisor/026): validated and
                // applied inside the SAME transaction as the student/user writes,
                // so a rejected or failed selection can never leave an orphan
                // student or a partially replaced enrollment. The whole
                // transaction is owned by runStudentWriteTransaction: a refusal
                // throws and the runner rolls back before any partial
                // student/user write can commit (supervisor/035).
                const courseResult = await applyOfflineCourseSelection(
                    studentId,
                    course_ids,
                    createTransactionEnrollmentSeam(connection),
                    await courseAuthorityCaller(req),
                );
                if (!courseResult.ok) {
                    throw new StudentWriteRefusal(courseResult.status, courseResult.error);
                }
            });
        } catch (transactionError: any) {
            if (transactionError instanceof StudentWriteRefusal) {
                return res.status(transactionError.status).json({ error: transactionError.error });
            }
            if (transactionError?.code === 'ER_DUP_ENTRY') {
                return res.status(409).json({ error: 'رقم الهاتف أو البريد مستخدم بالفعل' });
            }
            throw transactionError;
        }

        const newStudent = await queryOne(
            `SELECT
                ${STUDENT_COLUMNS},
                g.name AS grade_name,
                grp.name AS group_name,
                s.created_at AS enrollment_date,
                (
                    SELECT GROUP_CONCAT(DISTINCT c.name ORDER BY c.name SEPARATOR ',')
                    FROM student_courses sc
                    INNER JOIN courses c ON sc.course_id = c.id
                    WHERE sc.student_id = s.id
                ) AS course_names,
                (
                    SELECT GROUP_CONCAT(DISTINCT sc.course_id ORDER BY sc.course_id SEPARATOR ',')
                    FROM student_courses sc
                    WHERE sc.student_id = s.id
                ) AS course_ids
             FROM students s
             LEFT JOIN grades g ON s.grade_id = g.id
             LEFT JOIN \`groups\` grp ON s.group_id = grp.id
             WHERE s.id = ?`,
            [studentId]
        );

        res.status(201).json(newStudent);
    } catch (error: any) {
        console.error('Create student error:', error);
        console.error('Error details:', {
            message: error.message,
            code: error.code,
            sqlMessage: error.sqlMessage
        });
        res.status(500).json({
            error: 'Failed to create student',
            details: error.message
        });
    }
});

// Get student admin notes
router.get('/:id/notes', deps.authenticate, async (req: AuthRequest, res: Response) => {
    try {
        const scope = await resolveReadScope(req, false);
        if (!scope) return res.status(403).json({ error: 'Forbidden' });
        const scoped = scopePredicate(scope);
        const student = await deps.queryOne<{ id: string; notes: string | null }>(
            `SELECT s.id, s.notes FROM students s WHERE s.id = ?${scoped.sql}`,
            [req.params.id, ...scoped.params]
        );
        if (!student) {
            return res.status(404).json({ error: 'Student not found' });
        }
        res.json({ notes: student.notes || '' });
    } catch (error) {
        console.error('Get student notes error:', error);
        res.status(500).json({ error: 'Failed to get student notes' });
    }
});

// Update student admin notes
router.put('/:id/notes', requireTeachingWrite('students'), async (req: AuthRequest, res: Response) => {
    try {
        const scopeId = instructorScopeId(req);
        if (scopeId && !(await isStudentInScope(req.params.id, scopeId))) {
            return res.status(404).json({ error: 'Student not found' });
        }
        const { notes } = req.body;
        const result = await execute(
            'UPDATE students SET notes = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
            [notes || null, req.params.id]
        );
        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Student not found' });
        }
        res.json({ message: 'Notes saved successfully', notes: notes || '' });
    } catch (error) {
        console.error('Update student notes error:', error);
        res.status(500).json({ error: 'Failed to update student notes' });
    }
});

// Update student
router.put('/:id', requireTeachingWrite('students'), async (req: AuthRequest, res: Response) => {
    try {
        const scopeId = instructorScopeId(req);
        if (scopeId && !(await isStudentInScope(req.params.id, scopeId))) {
            return res.status(404).json({ error: 'Student not found' });
        }
        const { name, email, phone, guardian_phone, grade, grade_id, group_id, barcode, password, notes, course_ids } = req.body;
        if (scopeId && group_id !== undefined && group_id !== null && !(await isGroupInScope(group_id, scopeId))) {
            return res.status(403).json({ error: 'لا يمكن نقل الطالب لمجموعة لا تخصك' });
        }

        const fields: string[] = [];
        const params: any[] = [];

        if (name !== undefined) {
            fields.push('name = ?');
            params.push(name ?? null);
        }
        if (email !== undefined) {
            fields.push('email = ?');
            params.push(email ?? null);
        }
        if (phone !== undefined) {
            fields.push('phone = ?');
            params.push(phone ?? null);
        }
        if (guardian_phone !== undefined) {
            fields.push('guardian_phone = ?');
            params.push(guardian_phone ?? null);
        }
        if (grade !== undefined) {
            fields.push('grade = ?');
            params.push(grade ?? null);
        }
        if (grade_id !== undefined) {
            fields.push('grade_id = ?');
            params.push(grade_id ?? null);
        }
        if (group_id !== undefined) {
            fields.push('group_id = ?');
            params.push(group_id ?? null);
        }
        if (notes !== undefined) {
            fields.push('notes = ?');
            params.push(notes ?? null);
        }
        if (barcode !== undefined) {
            if (barcode === null) {
                fields.push('barcode = NULL');
            } else {
                try {
                    const sanitized = sanitizeBarcode(barcode);
                    fields.push('barcode = ?');
                    params.push(sanitized);
                } catch (validationError) {
                    if ((validationError as Error).name === 'INVALID_BARCODE_LENGTH') {
                        return res.status(400).json({ error: 'Barcode must be exactly 25 alphanumeric characters.' });
                    }
                    throw validationError;
                }
            }
        }

        // An absent course_ids preserves the existing enrollment untouched; a
        // present value (including []) participates in the update.
        const courseSelectionRequested = course_ids !== undefined;
        if (fields.length === 0 && !courseSelectionRequested) {
            return res.status(400).json({ error: 'No fields provided for update' });
        }

        if (courseSelectionRequested) {
            // Transactional path (supervisor/026): the student (and linked
            // user) update and the enrollment diff commit or roll back
            // together, so a rejected or failed selection can never leave a
            // half-applied update or a partially replaced enrollment.
            const connection = await getPool().getConnection();
            try {
                await runStudentWriteTransaction(connection, async () => {
                    // Lock and re-validate the target INSIDE the transaction
                    // (supervisor/029): the stored offline predicate — never a
                    // UI flag — decides eligibility, an instructor's authority
                    // is re-checked under the lock, and FOR UPDATE serializes a
                    // concurrent replacement on the same student.
                    const lockResult = await lockOfflineCourseTarget(connection, req.params.id, scopeId);
                    if (!lockResult.ok) {
                        throw new StudentWriteRefusal(lockResult.status, lockResult.error);
                    }

                    if (fields.length > 0) {
                        fields.push('updated_at = CURRENT_TIMESTAMP');
                        const [result] = (await connection.execute(
                            `UPDATE students SET ${fields.join(', ')} WHERE id = ?`,
                            [...params, req.params.id]
                        )) as [{ affectedRows: number }, unknown];
                        if (result.affectedRows === 0) {
                            throw new StudentWriteRefusal(404, 'Student not found');
                        }
                    }

                    // Also update users table if email exists (same rule as the
                    // non-transactional path below).
                    if (email) {
                        const updateFields = ['name = ?', 'phone = ?'];
                        const updateValues = [name, phone || null];

                        if (password) {
                            // Hash the password before updating
                            const passwordHash = await bcrypt.hash(password, 10);
                            updateFields.push('password_hash = ?');
                            updateValues.push(passwordHash);
                        }

                        updateValues.push(email);

                        await connection.execute(
                            `UPDATE users SET ${updateFields.join(', ')} WHERE email = ? AND role = 'student'`,
                            updateValues
                        );
                    }

                    const courseResult = await applyOfflineCourseSelection(
                        req.params.id,
                        course_ids,
                        createTransactionEnrollmentSeam(connection),
                        await courseAuthorityCaller(req),
                    );
                    if (!courseResult.ok) {
                        throw new StudentWriteRefusal(courseResult.status, courseResult.error);
                    }
                });
            } catch (transactionError) {
                if (transactionError instanceof StudentWriteRefusal) {
                    return res.status(transactionError.status).json({ error: transactionError.error });
                }
                throw transactionError;
            }
        } else {
            fields.push('updated_at = CURRENT_TIMESTAMP');

            const result = await execute(
                `UPDATE students SET ${fields.join(', ')} WHERE id = ?`,
                [...params, req.params.id]
            );

            if (result.affectedRows === 0) {
                return res.status(404).json({ error: 'Student not found' });
            }

            // Also update users table if email exists
            if (email) {
                const updateFields = ['name = ?', 'phone = ?'];
                const updateValues = [name, phone || null];

                if (password) {
                    // Hash the password before updating
                    const passwordHash = await bcrypt.hash(password, 10);
                    updateFields.push('password_hash = ?');
                    updateValues.push(passwordHash);
                }

                updateValues.push(email);

                await execute(
                    `UPDATE users SET ${updateFields.join(', ')} WHERE email = ? AND role = 'student'`,
                    updateValues
                );
            }
        }

        const updatedStudent = await queryOne(
            `SELECT
                ${STUDENT_COLUMNS},
                g.name AS grade_name,
                grp.name AS group_name,
                s.created_at AS enrollment_date,
                (
                    SELECT GROUP_CONCAT(DISTINCT c.name ORDER BY c.name SEPARATOR ',')
                    FROM student_courses sc
                    INNER JOIN courses c ON sc.course_id = c.id
                    WHERE sc.student_id = s.id
                ) AS course_names,
                (
                    SELECT GROUP_CONCAT(DISTINCT sc.course_id ORDER BY sc.course_id SEPARATOR ',')
                    FROM student_courses sc
                    WHERE sc.student_id = s.id
                ) AS course_ids
             FROM students s
             LEFT JOIN grades g ON s.grade_id = g.id
             LEFT JOIN \`groups\` grp ON s.group_id = grp.id
             WHERE s.id = ?`,
            [req.params.id]
        );

        res.json(updatedStudent);
    } catch (error) {
        console.error('Update student error:', error);
        res.status(500).json({ error: 'Failed to update student' });
    }
});

// Delete student (hard delete - removes from database)
router.delete('/:id', requireTeachingWrite('students'), async (req: AuthRequest, res: Response) => {
    try {
        const scopeId = instructorScopeId(req);
        if (scopeId && !(await isStudentInScope(req.params.id, scopeId))) {
            return res.status(404).json({ error: 'Student not found' });
        }
        // First delete related records (student_courses)
        await execute(
            'DELETE FROM student_courses WHERE student_id = ?',
            [req.params.id]
        );

        // Then delete the student (only from students table, keep in users table)
        const result = await execute(
            'DELETE FROM students WHERE id = ?',
            [req.params.id]
        );

        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Student not found' });
        }

        res.json({ message: 'Student deleted successfully' });
    } catch (error) {
        console.error('Delete student error:', error);
        res.status(500).json({ error: 'Failed to delete student' });
    }
});

// ---------------------------------------------------------------------------
// M2-18 — private student branch assignment (owner-only, additive)
//
// One owner-only route beside the existing student management handlers:
// PATCH /api/students/:id/branch with the strict single-field body
// `{ branch_id }`. `branch_id` is either a branch UUID or `null`; `null`
// CLEARS the assignment. Nothing else is accepted.
//
// This is organization/planning metadata only. Assigning or clearing a branch
// never changes a login, an account, an invitation, an enrollment, a
// group/course membership, an academic-period binding, an access rule, pricing
// or billing: the route writes exactly one nullable column on the student row
// plus one sanitized audit event, inside one transaction, on one connection.
//
// Authority is deliberately NOT the instructor scope used by the handlers
// above (`instructorScopeId` / `isStudentInScope`): branch assignment belongs
// to the verified OWNER of the server-selected tenant, re-resolved from
// server-side rows on the same connection that performs the write — the same
// owner rule the accepted M2-B03 branch routes use
// (routes/tenant-self.ts). A membership role label never grants it.
//
// `/api/students` is NOT one of the billing-only exempt prefixes
// (middleware/auth.ts isInstructorBillingPath), so a billed-out instructor is
// already refused by the shared authentication middleware before this handler
// runs; no local billing guard is needed or added here.
// ---------------------------------------------------------------------------

/** A server-generated UUID. A client-supplied id is only a SELECTOR. */
const BRANCH_ID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const STUDENT_ID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * Explicit bounded projection. The student row is never spread into the
 * response: exactly three fields, no name, phone, email, barcode, grade, group
 * or any other stored value. `branch_name` is the name read under the same
 * lock inside the same transaction, and it is `null` exactly when there is no
 * branch.
 */
const studentBranchDto = (studentId: string, branchId: string | null, branchName: string | null) => ({
  student_id: studentId,
  branch_id: branchId,
  branch_name: branchName,
});

router.patch('/:id/branch', deps.authenticate, async (req: AuthRequest, res: Response) => {
  // The cache directive is applied before the first await and before any
  // denial, so every outcome this handler produces carries it.
  res.set('Cache-Control', 'no-store');

  const studentId = String(req.params?.id ?? '');
  if (!STUDENT_ID_PATTERN.test(studentId)) {
    return res.status(400).json({ error: 'Invalid student id' });
  }

  // Strict single-field body: exactly `{ branch_id }`, where the value is a
  // branch UUID or null. A tenant selector, a status, a name or any extra key
  // is refused before a connection is taken.
  const body = req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return res.status(400).json({ error: 'Invalid student branch payload' });
  }
  const keys = Object.keys(body);
  if (keys.length !== 1 || keys[0] !== 'branch_id') {
    return res.status(400).json({ error: 'Invalid student branch payload' });
  }
  const rawBranchId = (body as Record<string, unknown>).branch_id;
  let branchId: string | null = null;
  if (rawBranchId !== null) {
    if (typeof rawBranchId !== 'string' || !BRANCH_ID_PATTERN.test(rawBranchId)) {
      return res.status(400).json({ error: 'Invalid student branch payload' });
    }
    branchId = rawBranchId;
  }

  const userId = req.user?.id;
  const tenantId = req.user?.tenantId;
  if (!userId || !tenantId) return res.status(404).json({ error: 'Tenant membership not found' });

  let connection: PoolConnection | null = null;
  let transactionStarted = false;
  let commitAttempted = false;
  let disposal: 'release' | 'destroy' = 'release';

  const rollbackOrDiscard = async (): Promise<void> => {
    try {
      await connection!.rollback();
    } catch (rollbackError) {
      disposal = 'destroy';
      console.error('Rollback student branch assignment error (connection will be discarded):', rollbackError);
    }
  };

  try {
    connection = await getPool().getConnection();
    await connection.beginTransaction();
    transactionStarted = true;

    // Owner revalidation INSIDE the transaction, on the same connection that
    // performs the write: the tenant's real `owner_user_id`, its status and
    // the caller's own active user row, locked so the write cannot race an
    // ownership change.
    const [ownerRows] = await connection.execute<any[]>(
      `SELECT t.owner_user_id,t.status AS tenant_status,u.is_active AS caller_active
       FROM tenants t JOIN users u ON u.id=? WHERE t.id=? FOR UPDATE`,
      [userId, tenantId]
    );
    const owner = (ownerRows as any[])[0];
    if (!owner || String(owner.owner_user_id) !== userId || owner.tenant_status !== 'active' || Number(owner.caller_active) !== 1) {
      await rollbackOrDiscard();
      return res.status(403).json({ error: 'Forbidden' });
    }

    // The target student is qualified by BOTH the id and the selected tenant
    // and locked, so a foreign tenant's student and an absent id produce the
    // identical not-found result and no cross-tenant existence is disclosed.
    const [studentRows] = await connection.execute<any[]>(
      `SELECT s.id,s.branch_id FROM students s WHERE s.id=? AND s.tenant_id=? FOR UPDATE`,
      [studentId, tenantId]
    );
    const student = (studentRows as any[])[0];
    if (!student) {
      await rollbackOrDiscard();
      return res.status(404).json({ error: 'Student not found' });
    }
    const currentBranchId =
      student.branch_id === null || student.branch_id === undefined ? null : String(student.branch_id);

    // An assign target must exist, belong to the SAME tenant and be active;
    // an archived or foreign branch is refused exactly like a missing one.
    let branchName: string | null = null;
    if (branchId !== null) {
      const [branchRows] = await connection.execute<any[]>(
        `SELECT b.id,b.name,b.status FROM tenant_branches b WHERE b.id=? AND b.tenant_id=? FOR UPDATE`,
        [branchId, tenantId]
      );
      const branch = (branchRows as any[])[0];
      if (!branch || String(branch.status) !== 'active') {
        await rollbackOrDiscard();
        return res.status(404).json({ error: 'Branch not found' });
      }
      branchName = String(branch.name);
    }

    if (branchId === currentBranchId) {
      // Truthful no-op: an identical retry writes nothing and audits nothing.
      await rollbackOrDiscard();
      return res.json({ student: studentBranchDto(studentId, currentBranchId, branchName) });
    }

    const [updateResult] = await connection.execute<any[]>(
      'UPDATE students SET branch_id=? WHERE id=? AND tenant_id=?',
      [branchId, studentId, tenantId]
    );
    if (Number((updateResult as any)?.affectedRows) !== 1) {
      await rollbackOrDiscard();
      return res.status(409).json({ error: 'Student was modified concurrently' });
    }

    // One sanitized audit event, inside the same transaction as the write: the
    // action names the operation, the resource is the student id, and the
    // old/new values carry ONLY the branch id — never a student value, never a
    // branch name, never an existing-record identity.
    await connection.execute(
      `INSERT INTO audit_events (id,actor_user_id,tenant_id,action,resource_type,resource_id,old_value,new_value)
       VALUES (?,?,?,?,?,?,?,?)`,
      [crypto.randomUUID(), userId, tenantId,
        branchId === null ? 'student.branch_cleared' : 'student.branch_assigned',
        'student', studentId,
        JSON.stringify({ branch_id: currentBranchId }),
        JSON.stringify({ branch_id: branchId })]
    );

    commitAttempted = true;
    await connection.commit();
    return res.json({ student: studentBranchDto(studentId, branchId, branchName) });
  } catch (error) {
    if (commitAttempted) {
      // The commit acknowledgement was lost: whether the write persisted is
      // UNKNOWN. Do not claim a rollback happened, do not retry silently, and
      // never return this connection to the pool.
      disposal = 'destroy';
      console.error('Assign student branch error after commit attempt (persistence uncertain):', error);
    } else if (transactionStarted) {
      console.error('Assign student branch error:', error);
      await rollbackOrDiscard();
    } else {
      disposal = 'destroy';
      console.error('Assign student branch error before transaction start:', error);
    }
    return res.status(500).json({ error: 'Failed to update student branch' });
  } finally {
    if (connection) {
      if (disposal === 'destroy') {
        try { connection.destroy(); } catch { /* connection already gone */ }
      } else {
        try { connection.release(); } catch { /* connection already released */ }
      }
    }
  }
});


    return router;
};

export default createStudentsRouter();
