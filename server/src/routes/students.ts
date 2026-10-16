import { Router, Response, RequestHandler } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { getPool, query, queryOne, execute } from '../db';
import { optionalAuth, instructorScopeId, AuthRequest, authenticateToken } from '../middleware/auth';
import { requireTeachingWrite } from '../middleware/teaching-access';
import { normalizeEgyptianPhone, phoneLookupCandidates } from '../security/phone';
import { isSuperAdmin } from '../security/admin-permissions';

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
                ) AS course_names
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
                ) AS course_names
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
                ) AS course_names
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
                ) AS course_names
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
                ) AS course_names
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
router.post('/', requireTeachingWrite('students'), async (req: AuthRequest, res: Response) => {
    try {
        const scopeId = instructorScopeId(req);
        const { name, email, phone, guardian_phone, grade, grade_id, group_id, password, barcode: incomingBarcode, is_offline = false, approval_status = 'approved' } = req.body;
        const offline = is_offline === true || is_offline === 1 || is_offline === 'true';

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
            await connection.beginTransaction();
            const [tenantRows] = scopeId ? await connection.execute<any[]>(
                "SELECT id FROM tenants WHERE owner_user_id=? AND status='active' LIMIT 1", [scopeId]
            ) : [[] as any];
            const tenantId = tenantRows?.[0]?.id || null;
            let linkedUserId: string | null = null;
            let normalizedPhone = phone ? normalizeEgyptianPhone(phone) : null;
            if (!offline) {
                if (!normalizedPhone) { await connection.rollback(); return res.status(400).json({ error: 'Invalid Egyptian mobile number' }); }
                const candidates = phoneLookupCandidates(normalizedPhone);
                const [existingUsers] = await connection.execute<any[]>(
                    `SELECT id FROM users WHERE role='student' AND phone IN (${candidates.map(() => '?').join(',')}) LIMIT 1`, candidates
                );
                linkedUserId = existingUsers?.[0]?.id || crypto.randomUUID();
                if (tenantId) {
                    const [membership] = await connection.execute<any[]>('SELECT id FROM students WHERE tenant_id=? AND user_id=? LIMIT 1', [tenantId, linkedUserId]);
                    if (membership?.[0]) { await connection.rollback(); return res.status(409).json({ error: 'Student already belongs to this instructor' }); }
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
            await connection.commit();
        } catch (transactionError: any) {
            await connection.rollback();
            if (transactionError?.code === 'ER_DUP_ENTRY') {
                return res.status(409).json({ error: 'رقم الهاتف أو البريد مستخدم بالفعل' });
            }
            throw transactionError;
        } finally { connection.release(); }

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
                ) AS course_names
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
        const { name, email, phone, guardian_phone, grade, grade_id, group_id, barcode, password, notes } = req.body;
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

        if (fields.length === 0) {
            return res.status(400).json({ error: 'No fields provided for update' });
        }

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
                ) AS course_names
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

    return router;
};

export default createStudentsRouter();
