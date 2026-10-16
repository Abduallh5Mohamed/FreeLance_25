import { Router, Request, Response, RequestHandler } from 'express';
import { query, queryOne, execute } from '../db';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { randomUUID } from 'crypto';
import { optionalAuth, authenticateToken, instructorScopeId, AuthRequest } from '../middleware/auth';
import { requireTeachingWrite } from '../middleware/teaching-access';

/**
 * Data-access seam for the exams router. Production binds ../db; hermetic
 * tests inject isolated fixtures through the same boundary so the real
 * authorization logic runs without a database.
 */
export interface ExamDataAccess {
    query: typeof query;
    queryOne: typeof queryOne;
    execute: typeof execute;
}

/**
 * Injectable seams for the exams router. The default export binds the
 * production SQL adapters, the real optional/strict authentication middleware
 * and the real teaching-entitlement guard. Tests inject fixtures through this
 * boundary instead of bypassing production authorization.
 */
export interface ExamRouterDeps {
    db: ExamDataAccess;
    optionalAuthenticate: RequestHandler;
    authenticate: RequestHandler;
    requireTeachingWriteAccess: RequestHandler;
}

// Setup multer for question image uploads (module level: no DB, no env).
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const uploadDir = path.join(__dirname, '../../uploads/questions');
        if (!fs.existsSync(uploadDir)) {
            fs.mkdirSync(uploadDir, { recursive: true });
        }
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, 'question-' + uniqueSuffix + path.extname(file.originalname));
    }
});

const upload = multer({
    storage: storage,
    limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
    fileFilter: (req, file, cb) => {
        // Check file extension
        const allowedExtensions = /jpeg|jpg|png|gif|webp|bmp|svg|ico|tiff|tif|heic|heif|avif/i;
        const extname = allowedExtensions.test(path.extname(file.originalname).toLowerCase());

        // Check mimetype - should start with 'image/'
        const isImage = file.mimetype.startsWith('image/');

        console.log('📷 Upload attempt:', {
            originalname: file.originalname,
            mimetype: file.mimetype,
            extname: path.extname(file.originalname),
            extValid: extname,
            mimeValid: isImage
        });

        // Accept if mimetype is image/* (more permissive)
        if (isImage) {
            cb(null, true);
        } else {
            console.error('❌ File rejected:', file.originalname, 'mimetype:', file.mimetype);
            cb(new Error('Only image files are allowed'));
        }
    }
});

// Helper: parse 'YYYY-MM-DD HH:MM:SS[.fraction]' or 'YYYY-MM-DDTHH:MM:SS' as local Date
function parseLocalDateTime(dt: any): Date | null {
    if (!dt) return null;
    try {
        let s = String(dt).trim();
        s = s.replace(' ', 'T');
        const dot = s.indexOf('.');
        if (dot > -1) s = s.substring(0, dot);
        const d = new Date(s);
        if (isNaN(d.getTime())) return null;
        return d;
    } catch {
        return null;
    }
}

interface Exam {
    id: string;
    title: string;
    description?: string;
    course_id: string;
    duration_minutes: number;
    total_marks: number;
    passing_marks?: number;
    start_time?: Date;
    end_time?: Date;
    is_active: boolean;
    created_at: Date;
}

interface ExamQuestion {
    id: string;
    exam_id: string;
    question_text: string;
    question_type: 'multiple_choice' | 'true_false' | 'short_answer' | 'essay';
    options?: string;
    correct_answer?: string;
    points: number;
    display_order: number;
    explanation?: string;
}

interface ExamResult {
    id: string;
    exam_id: string;
    student_id: string;
    score: number;
    total_marks: number;
    status: 'pending' | 'graded' | 'submitted';
    started_at?: Date;
    submitted_at?: Date;
    graded_at?: Date;
}

export const createExamRouter = (deps: ExamRouterDeps): Router => {
    const router = Router();
    const { query, queryOne, execute } = deps.db;
    const requireTeachingWriteAccess = deps.requireTeachingWriteAccess;

    router.use(deps.optionalAuthenticate);

    // Exams belong to an instructor when the exam is linked to at least one of
    // the instructor's groups
    const isExamInScope = async (examId: string, scopeId: string): Promise<boolean> => {
        const row = await queryOne(
            `SELECT eg.exam_id
             FROM exam_groups eg
             INNER JOIN \`groups\` g ON eg.group_id = g.id
             WHERE eg.exam_id = ? AND g.instructor_id = ?
             LIMIT 1`,
            [examId, scopeId]
        );
        return !!row;
    };

    const areGroupsInScope = async (groupIds: any[], scopeId: string): Promise<boolean> => {
        if (!Array.isArray(groupIds) || groupIds.length === 0) return false;
        const rows = await query<any>(
            `SELECT COUNT(*) AS cnt FROM \`groups\` WHERE instructor_id = ? AND id IN (${groupIds.map(() => '?').join(',')})`,
            [scopeId, ...groupIds]
        );
        return rows[0]?.cnt === groupIds.length;
    };

    // Platform admins are trusted staff; instructors are confined to the exams
    // linked to their own groups. Every other authenticated principal fails
    // closed instead of falling back to an unscoped view.
    const isAdmin = (req: AuthRequest): boolean => req.user?.role === 'admin';

    const isStudentSelf = (req: AuthRequest, id: unknown): boolean => {
        if (req.user?.role !== 'student') return false;
        if (String(req.user.id) === String(id)) return true;
        const enrollmentId = req.user.studentEnrollmentId;
        return !!enrollmentId && String(enrollmentId) === String(id);
    };

    /**
     * Resolve the enrollment (students.id) backing a student-action URL param.
     * Student callers never touch the database: the param must name their own
     * user id or their server-derived enrollment id, and the returned key is
     * always the server-derived enrollment id. Teachers/admins resolve the
     * param server-side (enrollment id preferred, user id fallback) so a user
     * id and an enrollment id that differ still address the same attempt row.
     * Returns null when the param cannot be resolved to an enrollment.
     */
    const resolveAttemptStudentId = async (req: AuthRequest, studentIdParam: string): Promise<string | null> => {
        if (req.user?.role === 'student') {
            const enrollmentId = req.user.studentEnrollmentId;
            if (!enrollmentId) return null;
            if (String(req.user.id) === String(studentIdParam)) return enrollmentId;
            if (String(enrollmentId) === String(studentIdParam)) return enrollmentId;
            return null;
        }
        const byEnrollment = await queryOne<{ id: string }>(
            'SELECT id FROM students WHERE id = ?',
            [studentIdParam]
        );
        if (byEnrollment?.id) return byEnrollment.id;
        const byUser = await queryOne<{ id: string }>(
            'SELECT id FROM students WHERE user_id = ? LIMIT 1',
            [studentIdParam]
        );
        if (byUser?.id) return byUser.id;
        // Legacy fallback: rows created before the user_id backfill resolve via phone.
        const userRow = await queryOne<{ phone: string | null }>(
            'SELECT phone FROM users WHERE id = ?',
            [studentIdParam]
        );
        if (userRow?.phone) {
            const byPhone = await queryOne<{ id: string }>(
                'SELECT id FROM students WHERE phone = ? LIMIT 1',
                [userRow.phone]
            );
            if (byPhone?.id) return byPhone.id;
        }
        return null;
    };

    /**
     * Enrollment scope for an instructor: the enrollment must be directly
     * assigned or sit in one of the instructor's groups. Anything else is
     * indistinguishable from missing (404) so group membership cannot be
     * enumerated across instructors.
     */
    const isEnrollmentInInstructorScope = async (enrollmentId: string, scopeId: string): Promise<boolean> => {
        const row = await queryOne(
            `SELECT s.id FROM students s LEFT JOIN \`groups\` g ON s.group_id = g.id
             WHERE s.id = ? AND (s.instructor_id = ? OR g.instructor_id = ?)`,
            [enrollmentId, scopeId, scopeId]
        );
        return !!row;
    };

    /**
     * Server-side attempt timer: true when now exceeds started_at + duration.
     * The database started_at and the exam duration are the only clock inputs;
     * client timestamps are never trusted.
     */
    const isAttemptExpired = (startedAt: unknown, durationMinutes: unknown, now: Date = new Date()): boolean => {
        const start = startedAt instanceof Date ? startedAt : new Date(String(startedAt));
        const duration = Number(durationMinutes);
        if (isNaN(start.getTime()) || !isFinite(duration) || duration <= 0) return false;
        return now.getTime() >= start.getTime() + duration * 60 * 1000;
    };

    /**
     * Teacher-facing exam authorization. Returns null when the caller may act
     * on the exam, else the HTTP status to deny with. An instructor who does
     * not own the exam is indistinguishable from a missing exam (404).
     */
    const authorizeExamTeacher = async (req: AuthRequest, examId: string): Promise<number | null> => {
        const scopeId = instructorScopeId(req);
        if (scopeId) return (await isExamInScope(examId, scopeId)) ? null : 404;
        if (isAdmin(req)) return null;
        return 403;
    };

    /**
     * Student-action authorization (can-attempt / start / save-progress /
     * submit / review). The caller must be the student themselves, or a
     * teacher who owns the exam, or a platform admin. The client-supplied
     * studentId is never trusted on its own.
     */
    const authorizeStudentAction = async (req: AuthRequest, examId: string, studentId: string): Promise<number | null> => {
        if (isStudentSelf(req, studentId)) return null;
        const scopeId = instructorScopeId(req);
        if (scopeId) return (await isExamInScope(examId, scopeId)) ? null : 404;
        if (isAdmin(req)) return null;
        return 403;
    };

    const denyStatus = (res: Response, status: number): Response =>
        res.status(status).json({ error: status === 404 ? 'Exam not found' : 'Forbidden' });

    // ✅ Get exams for a specific student based on their group
    router.get('/student/:userId', deps.authenticate, async (req: AuthRequest, res: Response) => {
        try {
            const { userId } = req.params;

            // Own-workspace access only: the student may read their own exam
            // list; a platform admin is trusted. Any other principal is denied
            // before any data access (no forged userId enumeration).
            if (!isStudentSelf(req, userId) && !isAdmin(req)) {
                return res.status(403).json({ error: 'Student workspace access required' });
            }

            // Get student's group_id and grade_id using phone from users table
            const user = await queryOne<{ phone: string }>(
                'SELECT phone FROM users WHERE id = ?',
                [userId]
            );

            if (!user?.phone) {
                console.log('❌ User not found for ID:', userId);
                return res.json([]); // User not found
            }

            const student = await queryOne<{ group_id: string; grade_id: string }>(
                'SELECT group_id, grade_id FROM students WHERE phone = ?',
                [user.phone]
            );

            if (!student) {
                console.log('❌ Student not found for phone:', user.phone);
                return res.json([]); // Student not found
            }

            console.log('📚 Student info:', { group_id: student.group_id, grade_id: student.grade_id });

            // Get exams: either assigned to student's group OR matching student's grade
            let exams: Exam[] = [];

            if (student.group_id) {
                // Try getting exams via exam_groups first
                exams = await query<Exam>(
                    `SELECT DISTINCT e.*
                     FROM exams e
                     LEFT JOIN exam_groups eg ON e.id = eg.exam_id
                     WHERE (eg.group_id = ? OR (e.grade_id = ? AND eg.exam_id IS NULL))
                       AND e.is_active = TRUE
                     ORDER BY e.created_at DESC`,
                    [student.group_id, student.grade_id]
                );
            }

            // If no exams found via groups, try by grade_id directly
            if (exams.length === 0 && student.grade_id) {
                exams = await query<Exam>(
                    `SELECT DISTINCT e.*
                     FROM exams e
                     WHERE (e.grade_id = ? OR e.grade_id IS NULL)
                       AND e.is_active = TRUE
                     ORDER BY e.created_at DESC`,
                    [student.grade_id]
                );
            }

            console.log(`📚 Found ${exams.length} exams for student`);

            // Get attempt info for this student (status + count)
            const attempts = await query<any>(
                `SELECT exam_id, COUNT(*) as count,
                        MAX(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END) as has_in_progress,
                        MAX(CASE WHEN status = 'in_progress' THEN started_at ELSE NULL END) as in_progress_started_at
                 FROM exam_attempts
                 WHERE student_id = ?
                 GROUP BY exam_id`,
                [userId]
            );

            console.log('📊 Attempts from DB:', attempts);

            const attemptsMap = new Map(attempts.map((a: any) => [a.exam_id, a]));

            // Add attempts count and status to each exam
            const examsWithAttempts = exams.map((exam: any) => {
                const attemptInfo = attemptsMap.get(exam.id);
                return {
                    ...exam,
                    attempts: attemptInfo?.count || 0,
                    has_in_progress: attemptInfo?.has_in_progress === 1,
                    in_progress_started_at: attemptInfo?.in_progress_started_at || null
                };
            });

            console.log('📚 Exams with attempts:', examsWithAttempts.map((e: any) => ({ id: e.id, title: e.title, attempts: e.attempts })));

            res.json(examsWithAttempts);
        } catch (error) {
            console.error('❌ Error fetching student exams:', error);
            res.status(500).json({ error: 'Failed to fetch exams' });
        }
    });

    // ===== EXAMS =====

    // Get all exams
    router.get('/', deps.authenticate, async (req: AuthRequest, res: Response) => {
        try {
            const { course_id, is_active, student_id, grade_id } = req.query;
            const scopeId = instructorScopeId(req);

            // This is a teacher/admin listing; a bare student (or any other
            // authenticated principal that is neither an owning instructor nor
            // an admin) is denied rather than served an unscoped view.
            if (!scopeId && !isAdmin(req)) {
                return res.status(403).json({ error: 'Forbidden' });
            }

            // Return raw fields - start_time and end_time are DATETIME columns
            let sql = `SELECT e.* FROM exams e WHERE 1=1`;
            const params: any[] = [];

            // Default to active exams only (soft delete)
            if (is_active === undefined) {
                sql += ' AND is_active = ?';
                params.push('1');
            } else if (is_active !== undefined) {
                sql += ' AND is_active = ?';
                params.push(is_active as string);
            }

            if (course_id) {
                sql += ' AND course_id = ?';
                params.push(course_id as string);
            }

            // ✅ Add grade_id filter
            if (grade_id) {
                sql += ' AND (grade_id = ? OR grade_id IS NULL)';
                params.push(grade_id as string);
            }

            // Instructors only see exams assigned to their groups
            if (scopeId) {
                sql += ' AND EXISTS (SELECT 1 FROM exam_groups eg2 INNER JOIN `groups` g2 ON eg2.group_id = g2.id WHERE eg2.exam_id = e.id AND g2.instructor_id = ?)';
                params.push(scopeId);
            }

            sql += ' ORDER BY created_at DESC';

            let exams = await query<any>(sql, params);

            // If student_id provided, add attempt count for each exam
            if (student_id) {
                // ✅ جلب عدد المحاولات الفعلية لكل امتحان
                const attempts = await query<any>(
                    `SELECT exam_id, COUNT(*) as count
                     FROM exam_attempts
                     WHERE student_id = ?
                     GROUP BY exam_id`,
                    [student_id]
                );

                const attemptsMap = new Map(attempts.map((a: any) => [a.exam_id, a.count]));

                exams = exams.map((exam) => ({
                    ...exam,
                    attempts: attemptsMap.get(exam.id) || 0
                }));
            }

            res.json(exams.map((e: any) => ({
                ...e,
                // Frontend expects start_time/end_time sometimes as combined; keep backwards compatibility
                start_time: e.start_dt || (e.exam_date && e.start_time ? `${e.exam_date} ${e.start_time}` : e.start_time),
                end_time: e.end_dt || (e.exam_date && e.end_time ? `${e.exam_date} ${e.end_time}` : e.end_time),
            })));
        } catch (error) {
            console.error('Get exams error:', error);
            res.status(500).json({ error: 'Failed to fetch exams' });
        }
    });

    // Get exam by ID
    router.get('/:id', deps.authenticate, async (req: AuthRequest, res: Response) => {
        try {
            const exam = await queryOne<Exam>(
                'SELECT * FROM exams WHERE id = ?',
                [req.params.id]
            );

            if (!exam) {
                return res.status(404).json({ error: 'Exam not found' });
            }
            const denied = await authorizeExamTeacher(req, req.params.id);
            if (denied) {
                return denyStatus(res, denied);
            }

            // Also fetch group_id from exam_groups junction table
            const examGroups = await query<any>(
                'SELECT group_id FROM exam_groups WHERE exam_id = ?',
                [req.params.id]
            );
            if (examGroups && examGroups.length > 0) {
                (exam as any).group_id = examGroups[0].group_id;
                (exam as any).group_ids = examGroups.map((g: any) => g.group_id);
            }

            res.json(exam);
        } catch (error) {
            console.error('Get exam by ID error:', error);
            res.status(500).json({ error: 'Failed to fetch exam' });
        }
    });

    // Create exam
    router.post('/', requireTeachingWriteAccess, async (req: AuthRequest, res: Response) => {
        try {
            console.log('📝 Creating exam with data:', JSON.stringify(req.body, null, 2));
            const scopeId = instructorScopeId(req);

            const {
                title,
                description,
                course_id,
                grade_id,    // ✅ Add grade_id support
                group_ids,   // ✅ Add group_ids support
                duration_minutes,
                total_marks,
                passing_marks,
                start_time,
                end_time,
                start_date,  // ✅ Support from TeacherExams
                end_date,    // ✅ Support from TeacherExams
                is_active = true
            } = req.body;

            if (scopeId && !(await areGroupsInScope(group_ids, scopeId))) {
                return res.status(403).json({ error: 'يجب ربط الامتحان بمجموعة من مجموعاتك فقط' });
            }

            // ✅ Use start_date/end_date if start_time/end_time not provided (store as provided, no UTC conversion)
            const finalStartTime = start_time || start_date || null;
            const finalEndTime = end_time || end_date || null;

            console.log('⏰ Parsed times:');
            console.log('  start_time:', start_time);
            console.log('  end_time:', end_time);
            console.log('  start_date:', start_date);
            console.log('  end_date:', end_date);
            console.log('  ✅ Final start_time:', finalStartTime);
            console.log('  ✅ Final end_time:', finalEndTime);

            if (!title || !course_id || !duration_minutes || !total_marks) {
                return res.status(400).json({ error: 'Missing required fields' });
            }

            // ✅ Validate that end_time is after start_time
            if (finalStartTime && finalEndTime) {
                const startDate = new Date(finalStartTime);
                const endDate = new Date(finalEndTime);
                if (endDate <= startDate) {
                    console.error('❌ Invalid time range: end_time must be after start_time');
                    console.error('  Start:', startDate.toISOString());
                    console.error('  End:', endDate.toISOString());
                    return res.status(400).json({
                        error: 'وقت النهاية يجب أن يكون بعد وقت البداية',
                        details: 'End time must be after start time'
                    });
                }
            }

            // Extract date and keep full datetime for start_time/end_time since they are DATETIME columns
            const examDateOnly = finalStartTime ? finalStartTime.split(' ')[0] : null;

            // The id is generated server-side so the created row is read back
            // through it; ordering the table by created_at would return another
            // tenant's concurrent insert under load.
            const newExamId = randomUUID();
            await execute(
                `INSERT INTO exams (id, title, description, course_id, grade_id, duration_minutes, total_marks, passing_marks, exam_date, start_time, end_time, is_active, is_published, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NOW(), NOW())`,
                [
                    newExamId,
                    title,
                    description ?? null,
                    course_id,
                    grade_id ?? null,
                    duration_minutes,
                    total_marks,
                    passing_marks ?? null,
                    examDateOnly,
                    finalStartTime,  // Keep full datetime
                    finalEndTime,    // Keep full datetime
                    is_active
                ]
            );

            const newExam = await queryOne<Exam>(
                'SELECT * FROM exams WHERE id = ?',
                [newExamId]
            );

            // ✅ Save group associations
            if (group_ids && Array.isArray(group_ids) && group_ids.length > 0 && newExam) {
                for (const groupId of group_ids) {
                    await execute(
                        'INSERT INTO exam_groups (exam_id, group_id) VALUES (?, ?)',
                        [newExam.id, groupId]
                    );
                }
            }

            console.log('✅ Exam created:', newExam);

            res.status(201).json(newExam);
        } catch (error) {
            console.error('Create exam error:', error);
            res.status(500).json({ error: 'Failed to create exam' });
        }
    });

    // Update exam
    router.put('/:id', requireTeachingWriteAccess, async (req: AuthRequest, res: Response) => {
        try {
            const scopeId = instructorScopeId(req);
            if (scopeId && !(await isExamInScope(req.params.id, scopeId))) {
                return res.status(404).json({ error: 'Exam not found' });
            }
            const {
                title,
                description,
                duration_minutes,
                duration, // Support both duration and duration_minutes
                total_marks,
                passing_marks,
                start_time,
                end_time,
                start_date, // optional ISO
                end_date,   // optional ISO
                is_active,
                course_id,
                grade_id,
                group_id,
                group_ids   // ✅ Support array of group IDs for exam_groups
            } = req.body;

            // Instructors can only re-assign their exam to their own groups
            if (scopeId) {
                if (group_ids && Array.isArray(group_ids)) {
                    if (!(await areGroupsInScope(group_ids, scopeId))) {
                        return res.status(403).json({ error: 'يجب ربط الامتحان بمجموعة من مجموعاتك فقط' });
                    }
                } else if (group_id && group_id !== 'all' && !(await areGroupsInScope([group_id], scopeId))) {
                    return res.status(403).json({ error: 'يجب ربط الامتحان بمجموعة من مجموعاتك فقط' });
                } else if (group_id === null || group_id === 'all') {
                    return res.status(403).json({ error: 'لا يمكن إتاحة الامتحان لكل المجموعات' });
                }
            }

            console.log('📝 UPDATE EXAM REQUEST:', {
                id: req.params.id,
                title,
                course_id,
                grade_id,
                group_id,
                start_time,
                end_time,
                duration
            });

            // Normalize incoming date/time (support start_date/end_date from UI) — keep local values as provided
            const finalStart = start_time || start_date || null;
            const finalEnd = end_time || end_date || null;
            const finalDuration = duration || duration_minutes || null;

            // ✅ Validate that end_time is after start_time
            if (finalStart && finalEnd) {
                const startDate = new Date(finalStart);
                const endDate = new Date(finalEnd);
                if (endDate <= startDate) {
                    console.error('❌ Invalid time range: end_time must be after start_time');
                    console.error('  Start:', startDate.toISOString());
                    console.error('  End:', endDate.toISOString());
                    return res.status(400).json({
                        error: 'وقت النهاية يجب أن يكون بعد وقت البداية',
                        details: 'End time must be after start time'
                    });
                }
            }

            // Build UPDATE query dynamically to only update provided fields
            const updates: string[] = [];
            const values: any[] = [];

            if (title !== undefined) {
                updates.push('title = ?');
                values.push(title);
            }
            if (description !== undefined) {
                updates.push('description = ?');
                values.push(description);
            }
            if (finalDuration !== undefined && finalDuration !== null) {
                updates.push('duration_minutes = ?');
                values.push(finalDuration);
            }
            if (total_marks !== undefined) {
                updates.push('total_marks = ?');
                values.push(total_marks);
            }
            if (passing_marks !== undefined) {
                updates.push('passing_marks = ?');
                values.push(passing_marks);
            }
            if (finalStart !== undefined) {
                updates.push('start_time = ?');
                values.push(finalStart);
                if (finalStart) {
                    updates.push('exam_date = DATE(?)');
                    values.push(finalStart);
                }
            }
            if (finalEnd !== undefined) {
                updates.push('end_time = ?');
                values.push(finalEnd);
            }
            if (is_active !== undefined) {
                updates.push('is_active = ?');
                values.push(is_active);
            }
            if (course_id !== undefined) {
                updates.push('course_id = ?');
                values.push(course_id);
            }
            if (grade_id !== undefined) {
                updates.push('grade_id = ?');
                values.push(grade_id);
            }
            // group_id is NOT a column on exams table — handled via exam_groups junction table below

            updates.push('updated_at = NOW()');
            values.push(req.params.id);

            if (updates.length === 1) {
                return res.status(400).json({ error: 'No fields to update' });
            }

            const updateQuery = `UPDATE exams SET ${updates.join(', ')} WHERE id = ?`;
            console.log('🔧 UPDATE QUERY:', updateQuery);
            console.log('📊 VALUES:', values);

            const result = await execute(updateQuery, values);

            if (result.affectedRows === 0) {
                return res.status(404).json({ error: 'Exam not found' });
            }

            console.log('✅ UPDATE RESULT:', result);

            // ✅ Update exam_groups junction table if group_ids provided
            if (group_ids && Array.isArray(group_ids)) {
                // Delete existing group associations
                await execute('DELETE FROM exam_groups WHERE exam_id = ?', [req.params.id]);
                // Insert new group associations
                for (const gid of group_ids) {
                    if (gid && gid !== 'all') {
                        await execute(
                            'INSERT INTO exam_groups (exam_id, group_id) VALUES (?, ?)',
                            [req.params.id, gid]
                        );
                    }
                }
                console.log('✅ Updated exam_groups:', group_ids);
            } else if (group_id && group_id !== 'all') {
                // Single group_id: also update exam_groups for backward compatibility
                await execute('DELETE FROM exam_groups WHERE exam_id = ?', [req.params.id]);
                await execute(
                    'INSERT INTO exam_groups (exam_id, group_id) VALUES (?, ?)',
                    [req.params.id, group_id]
                );
                console.log('✅ Updated exam_groups with single group:', group_id);
            } else if (group_id === null || group_id === 'all') {
                // Clear all group associations (means "all groups")
                await execute('DELETE FROM exam_groups WHERE exam_id = ?', [req.params.id]);
                console.log('✅ Cleared exam_groups (all groups)');
            }

            const updatedExam = await queryOne<Exam>(
                'SELECT * FROM exams WHERE id = ?',
                [req.params.id]
            );

            // Also include group info from exam_groups
            const updatedGroups = await query<any>(
                'SELECT group_id FROM exam_groups WHERE exam_id = ?',
                [req.params.id]
            );
            if (updatedExam && updatedGroups && updatedGroups.length > 0) {
                (updatedExam as any).group_id = updatedGroups[0].group_id;
                (updatedExam as any).group_ids = updatedGroups.map((g: any) => g.group_id);
            }

            console.log('✅ UPDATED EXAM:', updatedExam);

            res.json(updatedExam);
        } catch (error) {
            console.error('Update exam error:', error);
            res.status(500).json({ error: 'Failed to update exam' });
        }
    });

    // ✅ Get groups assigned to an exam
    router.get('/:examId/groups', deps.authenticate, async (req: AuthRequest, res: Response) => {
        try {
            const denied = await authorizeExamTeacher(req, req.params.examId);
            if (denied) {
                return denyStatus(res, denied);
            }
            const groups = await query<any>(
                `SELECT eg.group_id, g.name as group_name
                 FROM exam_groups eg
                 LEFT JOIN \`groups\` g ON eg.group_id = g.id
                 WHERE eg.exam_id = ?`,
                [req.params.examId]
            );
            res.json(groups);
        } catch (error) {
            console.error('Get exam groups error:', error);
            res.status(500).json({ error: 'Failed to fetch exam groups' });
        }
    });

    // Delete exam (soft delete)
    router.delete('/:id', requireTeachingWriteAccess, async (req: AuthRequest, res: Response) => {
        try {
            const scopeId = instructorScopeId(req);
            if (scopeId && !(await isExamInScope(req.params.id, scopeId))) {
                return res.status(404).json({ error: 'Exam not found' });
            }
            const result = await execute(
                'UPDATE exams SET is_active = FALSE WHERE id = ?',
                [req.params.id]
            );

            if (result.affectedRows === 0) {
                return res.status(404).json({ error: 'Exam not found' });
            }

            res.json({ message: 'Exam deleted successfully' });
        } catch (error) {
            console.error('Delete exam error:', error);
            res.status(500).json({ error: 'Failed to delete exam' });
        }
    });

    // Upload question image
    router.post('/upload-question-image', requireTeachingWriteAccess, upload.single('image'), async (req: AuthRequest, res: Response) => {
        try {
            if (!req.file) {
                return res.status(400).json({ error: 'No image file provided' });
            }

            const tenantId = req.user?.tenantId;
            if (!tenantId || !req.user?.id) return res.status(403).json({ error: 'Tenant membership required' });
            const fileId = randomUUID();
            await execute(
                `INSERT INTO tenant_media_files (id,tenant_id,uploaded_by,storage_path,original_name,mime_type,byte_size)
                 VALUES (?,?,?,?,?,?,?)`,
                [fileId, tenantId, req.user.id, path.relative(process.cwd(), req.file.path), req.file.originalname, req.file.mimetype, req.file.size]
            );
            const imageUrl = `/api/files/${fileId}/download`;

            res.json({
                success: true,
                imageUrl: imageUrl,
                filename: req.file.filename
            });
        } catch (error) {
            console.error('Error uploading question image:', error);
            res.status(500).json({ error: 'Failed to upload image' });
        }
    });

    // ===== EXAM QUESTIONS =====

    // Get questions for an exam
    router.get('/:examId/questions', deps.authenticate, async (req: AuthRequest, res: Response) => {
        try {
            const examId = req.params.examId;
            // Answer-key bearing route: teacher-owned only (an instructor who
            // does not own the exam, or any non-teacher principal, is denied).
            const denied = await authorizeExamTeacher(req, examId);
            if (denied) {
                return denyStatus(res, denied);
            }
            console.log(`📝 Fetching questions for exam: ${examId}`);

            const questions = await query<ExamQuestion>(
                'SELECT * FROM exam_questions WHERE exam_id = ? ORDER BY display_order',
                [examId]
            );

            console.log(`✅ Found ${questions.length} questions for exam ${examId}`);
            console.log('Questions:', JSON.stringify(questions, null, 2));

            res.json(questions);
        } catch (error) {
            console.error('❌ Get exam questions error:', error);
            res.status(500).json({ error: 'Failed to fetch exam questions' });
        }
    });

    // Add question to exam
    router.post('/:examId/questions', requireTeachingWriteAccess, async (req: AuthRequest, res: Response) => {
        try {
            const scopeId = instructorScopeId(req);
            if (scopeId && !(await isExamInScope(req.params.examId, scopeId))) {
                return res.status(404).json({ error: 'Exam not found' });
            }
            const {
                question_text,
                question_image,  // ✅ Accept image URL
                question_type,
                options,
                correct_answer,
                marks,
                points,  // ✅ Accept both marks and points
                display_order
            } = req.body;

            const finalPoints = points || marks;  // ✅ Use points if provided, fallback to marks

            if (!question_text || !question_type || !finalPoints) {
                console.error('❌ Missing required fields:', { question_text, question_type, points: finalPoints });
                return res.status(400).json({ error: 'Missing required fields' });
            }

            const newQuestionId = randomUUID();
            await execute(
                `INSERT INTO exam_questions (id, exam_id, question_text, question_image, question_type, options, correct_answer, points, display_order, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
                [
                    newQuestionId,
                    req.params.examId,
                    question_text,
                    question_image ?? null,  // ✅ Save image URL
                    question_type,
                    options ?? null,
                    correct_answer ?? null,
                    finalPoints,
                    display_order ?? 0
                ]
            );

            // Read back the row created above through its server-generated id;
            // ordering the table by created_at would return another exam's
            // concurrent insert.
            const newQuestion = await queryOne<ExamQuestion>(
                'SELECT * FROM exam_questions WHERE id = ?',
                [newQuestionId]
            );

            // ✅ Auto-update total_marks in exams table
            const totalMarksResult = await queryOne<{ total: number }>(
                'SELECT COALESCE(SUM(points), 0) as total FROM exam_questions WHERE exam_id = ?',
                [req.params.examId]
            );
            const totalMarks = totalMarksResult?.total || 0;
            await execute(
                'UPDATE exams SET total_marks = ? WHERE id = ?',
                [totalMarks, req.params.examId]
            );
            console.log(`✅ Updated exam ${req.params.examId} total_marks to ${totalMarks}`);

            res.status(201).json(newQuestion);
        } catch (error) {
            console.error('Add exam question error:', error);
            res.status(500).json({ error: 'Failed to add exam question' });
        }
    });

    // ===== EXAM RESULTS =====

    // Get all results for an exam
    router.get('/:examId/results', deps.authenticate, async (req: AuthRequest, res: Response) => {
        try {
            const denied = await authorizeExamTeacher(req, req.params.examId);
            if (denied) {
                return denyStatus(res, denied);
            }
            const results = await query<ExamResult>(
                `SELECT r.*, s.name as student_name, s.email as student_email
                 FROM exam_results r
                 LEFT JOIN students s ON r.student_id = s.id
                 WHERE r.exam_id = ?
                 ORDER BY r.submitted_at DESC`,
                [req.params.examId]
            );
            res.json(results);
        } catch (error) {
            console.error('Get exam results error:', error);
            res.status(500).json({ error: 'Failed to fetch exam results' });
        }
    });

    // Get student's result for an exam
    router.get('/:examId/results/student/:studentId', deps.authenticate, async (req: AuthRequest, res: Response) => {
        try {
            const denied = await authorizeExamTeacher(req, req.params.examId);
            if (denied) {
                return denyStatus(res, denied);
            }
            // Results are keyed by enrollment (students.id); accept either a
            // user id or an enrollment id and resolve server-side.
            const enrollmentId = await resolveAttemptStudentId(req, req.params.studentId);
            if (!enrollmentId) {
                return res.status(404).json({ error: 'Exam result not found' });
            }
            const result = await queryOne<ExamResult>(
                'SELECT * FROM exam_results WHERE exam_id = ? AND student_id = ?',
                [req.params.examId, enrollmentId]
            );

            if (!result) {
                return res.status(404).json({ error: 'Exam result not found' });
            }

            res.json(result);
        } catch (error) {
            console.error('Get student exam result error:', error);
            res.status(500).json({ error: 'Failed to fetch exam result' });
        }
    });

    // Submit exam result
    router.post('/:examId/results', deps.authenticate, async (req: AuthRequest, res: Response) => {
        try {
            // Grading write: only a teacher who owns the exam (or an admin) may
            // record a result; the client-supplied identity is not authority.
            const denied = await authorizeExamTeacher(req, req.params.examId);
            if (denied) {
                return denyStatus(res, denied);
            }
            const { student_id, score, total_marks, status = 'submitted' } = req.body;

            if (!student_id || score === undefined || !total_marks) {
                return res.status(400).json({ error: 'Missing required fields' });
            }
            if (typeof score !== 'number' || !isFinite(score) || score < 0) {
                return res.status(400).json({ error: 'Invalid score' });
            }
            if (typeof total_marks !== 'number' || !isFinite(total_marks) || total_marks <= 0) {
                return res.status(400).json({ error: 'Invalid total_marks' });
            }
            if (score > total_marks) {
                return res.status(400).json({ error: 'Score cannot exceed total marks' });
            }

            // exam_results.student_id references students(id): resolve the
            // supplied user id or enrollment id to the enrollment id first.
            const enrollmentId = await resolveAttemptStudentId(req, String(student_id));
            if (!enrollmentId) {
                return res.status(404).json({ error: 'Student not found' });
            }
            const scopeId = instructorScopeId(req);
            if (scopeId && !(await isEnrollmentInInstructorScope(enrollmentId, scopeId))) {
                return res.status(404).json({ error: 'Exam not found' });
            }

            // The id is generated server-side so the created row is read back
            // through it; ordering the table by created_at would return
            // another student's concurrent insert.
            const newResultId = randomUUID();
            await execute(
                `INSERT INTO exam_results (id, exam_id, student_id, marks_obtained, total_marks, submitted_at)
                 VALUES (?, ?, ?, ?, ?, NOW())`,
                [newResultId, req.params.examId, enrollmentId, score, total_marks]
            );

            const newResult = await queryOne<ExamResult>(
                'SELECT * FROM exam_results WHERE id = ?',
                [newResultId]
            );

            res.status(201).json(newResult);
        } catch (error) {
            console.error('Submit exam result error:', error);
            res.status(500).json({ error: 'Failed to submit exam result' });
        }
    });

    // ===== EXAM ATTEMPTS =====

    // Check if student can take exam (enrolled + not attempted + within schedule)
    router.get('/:examId/can-attempt/:studentId', deps.authenticate, async (req: AuthRequest, res: Response) => {
        try {
            const { examId, studentId } = req.params;

            const denied = await authorizeStudentAction(req, examId, studentId);
            if (denied) {
                return denyStatus(res, denied);
            }

            // Attempts are keyed by enrollment (students.id): a user id and an
            // enrollment id that differ resolve to the same attempt row.
            const enrollmentId = await resolveAttemptStudentId(req, studentId);
            if (!enrollmentId) {
                return res.status(404).json({ error: 'Student not found' });
            }
            const scopeId = instructorScopeId(req);
            if (scopeId && !(await isEnrollmentInInstructorScope(enrollmentId, scopeId))) {
                return res.status(404).json({ error: 'Exam not found' });
            }

            // Fetch exam - start_time and end_time are already DATETIME columns
            const exam = await queryOne<any>(
                `SELECT e.* FROM exams e WHERE e.id = ?`,
                [examId]
            );

            if (!exam) {
                return res.status(404).json({ error: 'Exam not found' });
            }

            // Auto-enroll student if not enrolled (seamless experience)
            if (exam.course_id) {
                const enrollment = await queryOne(
                    'SELECT * FROM student_courses WHERE student_id = ? AND course_id = ?',
                    [enrollmentId, exam.course_id]
                );

                if (!enrollment) {
                    // Auto-enroll student in course
                    try {
                        await execute(
                            'INSERT INTO student_courses (student_id, course_id) VALUES (?, ?)',
                            [enrollmentId, exam.course_id]
                        );
                        console.log(`✅ Auto-enrolled student ${enrollmentId} in course ${exam.course_id}`);
                    } catch (enrollError) {
                        console.error('⚠️ Auto-enrollment failed (continuing anyway):', enrollError);
                        // Continue to allow exam attempt even if enrollment fails
                    }
                }
            }

            // Check if already attempted
            const attempt = await queryOne<any>(
                'SELECT * FROM exam_attempts WHERE exam_id = ? AND student_id = ?',
                [examId, enrollmentId]
            );

            if (attempt) {
                // ✅ If attempt is in_progress, allow resuming
                if (attempt.status === 'in_progress') {
                    const startedAt = new Date(attempt.started_at);
                    const durationMs = (exam.duration_minutes || 60) * 60 * 1000;
                    const expiresAt = new Date(startedAt.getTime() + durationMs);
                    const now2 = new Date();
                    const remainingSeconds = Math.floor((expiresAt.getTime() - now2.getTime()) / 1000);

                    if (remainingSeconds <= 0) {
                        // Time expired — auto-complete the attempt
                        console.log('⏰ Exam time expired for in_progress attempt, auto-completing');
                        await execute(
                            `UPDATE exam_attempts SET status = 'failed', completed_at = NOW() WHERE id = ?`,
                            [attempt.id]
                        );
                        return res.json({
                            canAttempt: false,
                            reason: 'already_attempted',
                            message: 'انتهى وقت الامتحان',
                            score: attempt.score || 0,
                            totalMarks: exam.total_marks || 0,
                            passed: false,
                            attemptStatus: 'failed'
                        });
                    }

                    console.log(`🔄 Allowing resume: ${remainingSeconds}s remaining`);
                    return res.json({
                        canAttempt: true,
                        reason: 'resuming',
                        message: 'يمكنك استكمال الامتحان',
                        started_at: attempt.started_at,
                        remainingSeconds
                    });
                }

                // Completed/submitted/passed/failed — block re-entry
                return res.json({
                    canAttempt: false,
                    reason: 'already_attempted',
                    message: 'لقد قمت بالامتحان من قبل',
                    score: attempt.score,
                    totalMarks: exam.total_marks || 0,
                    passed: attempt.status === 'passed',
                    attemptStatus: attempt.status
                });
            }

            const now = new Date();

            // Use start_time and end_time directly (they are DATETIME columns)
            const startTime = exam?.start_time ? new Date(exam.start_time) : null;
            const endTime = exam?.end_time ? new Date(exam.end_time) : null;

            // Check if dates are valid before using them
            const isValidStartTime = startTime && !isNaN(startTime.getTime());
            const isValidEndTime = endTime && !isNaN(endTime.getTime());

            console.log('🕐 Time Check:');
            console.log('  Current time:', now.toISOString(), '(Local:', now.toLocaleString('ar-EG'), ')');
            console.log('  Start time:', isValidStartTime ? startTime.toISOString() : 'Invalid/N/A', isValidStartTime ? `(Local: ${startTime.toLocaleString('ar-EG')})` : '');
            console.log('  End time:', isValidEndTime ? endTime.toISOString() : 'Invalid/N/A', isValidEndTime ? `(Local: ${endTime.toLocaleString('ar-EG')})` : '');
            console.log('  Now < Start?', !!(isValidStartTime && now < startTime));
            console.log('  Now > End?', !!(isValidEndTime && now > endTime));

            // If schedule missing/invalid, allow attempt (treat as always-open exam)
            if (!isValidStartTime || !isValidEndTime) {
                return res.json({
                    canAttempt: true,
                    reason: 'no_schedule',
                    message: 'الامتحان بدون جدول زمني؛ الدخول متاح'
                });
            }

            if (now < startTime) {
                return res.json({
                    canAttempt: false,
                    reason: 'not_started',
                    message: 'الامتحان لم يبدأ بعد',
                    startTime: startTime.toISOString()
                });
            }

            if (now > endTime) {
                return res.json({
                    canAttempt: false,
                    reason: 'ended',
                    message: 'انتهى وقت الامتحان'
                });
            }

            res.json({ canAttempt: true });
        } catch (error) {
            console.error('Check can attempt error:', error);
            res.status(500).json({ error: 'Failed to check exam availability' });
        }
    });

    // Start exam attempt
    router.post('/:examId/start/:studentId', deps.authenticate, async (req: AuthRequest, res: Response) => {
        try {
            const { examId, studentId } = req.params;

            const denied = await authorizeStudentAction(req, examId, studentId);
            if (denied) {
                return denyStatus(res, denied);
            }

            // Attempts are keyed by enrollment (students.id).
            const enrollmentId = await resolveAttemptStudentId(req, studentId);
            if (!enrollmentId) {
                return res.status(404).json({ error: 'Student not found' });
            }
            const scopeId = instructorScopeId(req);
            if (scopeId && !(await isEnrollmentInInstructorScope(enrollmentId, scopeId))) {
                return res.status(404).json({ error: 'Exam not found' });
            }

            // Get exam info - start_time and end_time are DATETIME columns
            const exam = await queryOne<any>(
                `SELECT e.* FROM exams e WHERE e.id = ?`,
                [examId]
            );

            if (!exam) {
                return res.status(404).json({ error: 'Exam not found' });
            }

            // Check if student is enrolled in the course - auto-enroll if not
            if (exam.course_id) {
                const enrollment = await queryOne(
                    'SELECT * FROM student_courses WHERE student_id = ? AND course_id = ?',
                    [enrollmentId, exam.course_id]
                );

                if (!enrollment) {
                    // Auto-enroll student in the course
                    try {
                        await execute(
                            'INSERT INTO student_courses (student_id, course_id) VALUES (?, ?)',
                            [enrollmentId, exam.course_id]
                        );
                        console.log(`✅ Auto-enrolled student ${enrollmentId} in course ${exam.course_id}`);
                    } catch (enrollError) {
                        console.error('Auto-enrollment failed:', enrollError);
                        // Continue anyway - enrollment is optional for exams
                    }
                }
            }

            // Enforce schedule window strictly
            const now = new Date();
            const startTime = exam?.start_time ? new Date(exam.start_time) : null;
            const endTime = exam?.end_time ? new Date(exam.end_time) : null;

            if (!startTime || !endTime || isNaN(startTime.getTime()) || isNaN(endTime.getTime())) {
                // Allow starting when schedule is not set
                console.warn('⚠️ Exam has no valid schedule; allowing start:', examId);
            } else {
                if (now < startTime) {
                    return res.status(400).json({ error: 'الامتحان لم يبدأ بعد' });
                }
                if (now > endTime) {
                    return res.status(400).json({ error: 'انتهى وقت الامتحان' });
                }
            }

            // Check if already attempted
            const existingAttempt = await queryOne<any>(
                'SELECT * FROM exam_attempts WHERE exam_id = ? AND student_id = ?',
                [examId, enrollmentId]
            );



            if (existingAttempt) {
                // Resume only while the server-side timer still permits it;
                // an expired in_progress attempt is failed shut, never resumed.
                if (existingAttempt.status === 'in_progress') {
                    if (isAttemptExpired(existingAttempt.started_at, exam.duration_minutes, now)) {
                        await execute(
                            `UPDATE exam_attempts SET status = 'failed', completed_at = NOW() WHERE id = ?`,
                            [existingAttempt.id]
                        );
                        return res.status(400).json({ error: 'انتهى وقت الامتحان' });
                    }
                    console.log('🔄 Resuming existing attempt:', existingAttempt.id);
                    return res.json(existingAttempt);
                }
                return res.status(400).json({ error: 'Exam already attempted' });
            }

            // Create new attempt with generated UUID
            const attemptId = randomUUID();
            await execute(
                `INSERT INTO exam_attempts (id, exam_id, student_id, status, started_at, created_at)
                 VALUES (?, ?, ?, 'in_progress', NOW(), NOW())`,
                [attemptId, examId, enrollmentId]
            );

            const newAttempt = await queryOne(
                'SELECT * FROM exam_attempts WHERE id = ?',
                [attemptId]
            );

            res.status(201).json(newAttempt);
        } catch (error) {
            console.error('Start exam attempt error:', error);
            res.status(500).json({ error: 'Failed to start exam attempt' });
        }
    });


    // ✅ Auto-Save progress (Draft)
    router.post('/:examId/save-progress/:studentId', deps.authenticate, async (req: AuthRequest, res: Response) => {
        try {
            const { examId, studentId } = req.params;
            const { answers, essayAnswers, answerImages } = req.body;

            const denied = await authorizeStudentAction(req, examId, studentId);
            if (denied) {
                return denyStatus(res, denied);
            }

            // Attempts are keyed by enrollment (students.id).
            const enrollmentId = await resolveAttemptStudentId(req, studentId);
            if (!enrollmentId) {
                return res.status(404).json({ error: 'Student not found' });
            }
            const scopeId = instructorScopeId(req);
            if (scopeId && !(await isEnrollmentInInstructorScope(enrollmentId, scopeId))) {
                return res.status(404).json({ error: 'Exam not found' });
            }

            console.log(`💾 Auto-saving progress for student ${enrollmentId} on exam ${examId}`);

            // Merge answers
            const allAnswers = {
                multipleChoice: answers || {},
                essay: essayAnswers || {},
                images: answerImages || {}
            };

            // Server-side timer: refuse writes once the attempt window lapsed.
            const attemptState = await queryOne<any>(
                'SELECT id, status, started_at FROM exam_attempts WHERE exam_id = ? AND student_id = ?',
                [examId, enrollmentId]
            );
            if (!attemptState || attemptState.status !== 'in_progress') {
                console.warn('⚠️ Auto-save failed: No in-progress attempt found');
                return res.status(404).json({ error: 'No in_progress attempt found' });
            }
            const durationRow = await queryOne<any>(
                'SELECT duration_minutes FROM exams WHERE id = ?',
                [examId]
            );
            if (isAttemptExpired(attemptState.started_at, durationRow?.duration_minutes)) {
                await execute(
                    `UPDATE exam_attempts SET status = 'failed', completed_at = NOW() WHERE id = ?`,
                    [attemptState.id]
                );
                return res.status(400).json({ error: 'انتهى وقت الامتحان' });
            }

            // Update exam_attempts table only if status is 'in_progress'
            const result = await execute(
                `UPDATE exam_attempts
                 SET answers = ?
                 WHERE exam_id = ?
                 AND student_id = ?
                 AND status = 'in_progress'`,
                [JSON.stringify(allAnswers), examId, enrollmentId]
            );

            if (result.affectedRows === 0) {
                console.warn('⚠️ Auto-save failed: No in-progress attempt found');
                return res.status(404).json({ error: 'No in_progress attempt found' });
            }

            console.log('✅ Progress saved successfully');
            res.json({ success: true });
        } catch (error) {
            console.error('❌ Auto-save error:', error);
            res.status(500).json({ error: 'Failed to save progress' });
        }
    });

    // Submit exam attempt
    router.post('/:examId/submit/:studentId', deps.authenticate, async (req: AuthRequest, res: Response) => {
        try {
            const { examId, studentId } = req.params;
            const { answers, essayAnswers, answerImages } = req.body;

            const denied = await authorizeStudentAction(req, examId, studentId);
            if (denied) {
                return denyStatus(res, denied);
            }

            // Attempts, answers and results are all keyed by enrollment
            // (students.id). The client-supplied score is never trusted; the
            // server recomputes every auto-gradable mark.
            const enrollmentId = await resolveAttemptStudentId(req, studentId);
            if (!enrollmentId) {
                return res.status(404).json({ error: 'Student not found' });
            }
            const examScopeId = instructorScopeId(req);
            if (examScopeId && !(await isEnrollmentInInstructorScope(enrollmentId, examScopeId))) {
                return res.status(404).json({ error: 'Exam not found' });
            }

            console.log('🔍 Submit exam attempt - Start');
            console.log('📝 Exam ID:', examId);
            console.log('👤 Enrollment ID:', enrollmentId);

            // Get exam info for total_marks
            const exam = await queryOne<any>(
                'SELECT total_marks, passing_marks, duration_minutes FROM exams WHERE id = ?',
                [examId]
            );

            if (!exam) {
                console.error('❌ Exam not found:', examId);
                return res.status(404).json({ error: 'Exam not found' });
            }

            console.log('✅ Exam found:', exam);

            // ✅ State integrity: only an in-progress attempt may be submitted.
            // A completed/graded attempt is never re-graded through this
            // endpoint, and a submission without a started attempt is refused.
            const attemptRow = await queryOne<any>(
                'SELECT id, status, started_at FROM exam_attempts WHERE exam_id = ? AND student_id = ?',
                [examId, enrollmentId]
            );
            if (!attemptRow) {
                return res.status(409).json({ error: 'No attempt in progress for this exam' });
            }
            if (attemptRow.status !== 'in_progress') {
                return res.status(409).json({ error: 'This attempt has already been submitted' });
            }
            // Server-side timer: an attempt past its duration is failed shut
            // and never graded.
            if (isAttemptExpired(attemptRow.started_at, exam.duration_minutes)) {
                await execute(
                    `UPDATE exam_attempts SET status = 'failed', completed_at = NOW() WHERE id = ?`,
                    [attemptRow.id]
                );
                return res.status(400).json({ error: 'انتهى وقت الامتحان' });
            }

            // ✅ Server-derived manual-review presence (never trust the client flag):
            // an exam with essay/short-answer questions must route to review.
            const manualCountRow = await queryOne<{ cnt: number }>(
                `SELECT COUNT(*) AS cnt FROM exam_questions WHERE exam_id = ? AND question_type IN ('essay', 'short_answer')`,
                [examId]
            );
            const hasManualQuestions = Number(manualCountRow?.cnt || 0) > 0;

            console.log('📝 Has manual questions (server-derived):', hasManualQuestions);

            // ✅ Fetch all questions and calculate score on backend
            const questionRows = await query<any>(
                'SELECT id, question_type, correct_answer, points FROM exam_questions WHERE exam_id = ?',
                [examId]
            );

            const normalizeAnswerLetter = (value: unknown): string | null => {
                if (typeof value === 'number' && isFinite(value)) {
                    return String.fromCharCode(97 + value);
                }
                if (typeof value === 'string') {
                    const trimmed = value.trim();
                    if (/^[0-9]$/.test(trimmed)) {
                        return String.fromCharCode(97 + parseInt(trimmed, 10));
                    }
                    if (trimmed !== '') return trimmed.toLowerCase();
                }
                return null;
            };

            // Calculate score on backend to ensure accuracy
            let calculatedScore = 0;
            let autoTotal = 0;

            for (const q of questionRows) {
                const questionPoints = Number(q.points) || 1;

                if (q.question_type === 'multiple_choice') {
                    autoTotal += questionPoints;
                    const studentAnswerIndex = answers?.[q.id];

                    if (studentAnswerIndex !== undefined && studentAnswerIndex !== null) {
                        // Convert student answer to letter
                        const studentLetter = String.fromCharCode(97 + Number(studentAnswerIndex)); // 0->a, 1->b

                        // Convert correct_answer to letter for comparison
                        let correctLetter: string;
                        const correctAnswer = q.correct_answer;

                        if (typeof correctAnswer === 'number') {
                            correctLetter = String.fromCharCode(97 + correctAnswer);
                        } else if (typeof correctAnswer === 'string') {
                            if (/^[0-3]$/.test(correctAnswer)) {
                                correctLetter = String.fromCharCode(97 + parseInt(correctAnswer));
                            } else {
                                correctLetter = correctAnswer.toLowerCase();
                            }
                        } else {
                            correctLetter = 'a';
                        }

                        console.log(`📊 Backend Score Check - Q: ${q.id}, Student: ${studentLetter}, Correct: ${correctLetter}`);

                        if (studentLetter === correctLetter) {
                            calculatedScore += questionPoints;
                            console.log(`✅ Correct! +${questionPoints} points`);
                        }
                    }
                } else if (q.question_type === 'true_false') {
                    autoTotal += questionPoints;
                    const rawAnswer = answers?.[q.id];
                    if (rawAnswer !== undefined && rawAnswer !== null) {
                        const studentNorm = normalizeAnswerLetter(rawAnswer);
                        const correctNorm = normalizeAnswerLetter(q.correct_answer);
                        if (studentNorm !== null && correctNorm !== null && studentNorm === correctNorm) {
                            calculatedScore += questionPoints;
                        }
                    }
                }
            }

            console.log(`📊 Backend calculated score: ${calculatedScore}/${autoTotal}`);

            // Use backend calculated score instead of frontend score
            const score = calculatedScore;

            // Derive total marks if exam.total_marks missing or zero
            let totalMarks: number = Number(exam.total_marks) || 0;
            if (!totalMarks) {
                totalMarks = questionRows.reduce((sum: number, q: any) => sum + (Number(q.points) || Number(q.marks) || 1), 0);
            }

            console.log('📊 Total marks:', totalMarks);

            // Normalize passing marks (percentage vs absolute)
            const rawPassing: number = Number(exam.passing_marks) || 0;
            let passingMarks = rawPassing;
            if (totalMarks > 0 && rawPassing > totalMarks && rawPassing <= 100) {
                passingMarks = Math.ceil((rawPassing / 100) * totalMarks);
            }

            console.log('✅ Passing marks:', passingMarks);

            // ✅ If manual questions exist, status is 'pending_review' until manually graded
            const status = hasManualQuestions ? 'pending_review' : (score >= passingMarks ? 'passed' : 'failed');
            const passed = status === 'passed';

            console.log('📝 Status:', status);
            console.log('✅ Passed:', passed);

            // ✅ دمج الإجابات المختلفة
            const allAnswers = {
                multipleChoice: answers || {},
                essay: essayAnswers || {},
                images: answerImages || {}
            };

            console.log('📝 All answers to save:', JSON.stringify(allAnswers).substring(0, 200) + '...');

            // Update exam_attempts table — guarded on the in_progress state so a
            // concurrent/duplicate submission cannot silently re-grade.
            console.log('🔄 Updating exam_attempts table...');
            const submitResult = await execute(
                `UPDATE exam_attempts
                 SET status = ?,
                     completed_at = NOW(),
                     score = ?,
                     answers = ?
                 WHERE exam_id = ? AND student_id = ? AND status = 'in_progress'`,
                [status, score, JSON.stringify(allAnswers), examId, enrollmentId]
            );

            if (submitResult.affectedRows === 0) {
                return res.status(409).json({ error: 'This attempt has already been submitted' });
            }

            console.log('✅ Exam attempt updated');
            console.log(`📊 Enrollment ID: ${enrollmentId}`);

            // ✅ Fetch all questions for this exam
            console.log('🔄 Fetching questions for exam...');
            const questions = await query<any>(
                'SELECT id, question_type as type, correct_answer, points FROM exam_questions WHERE exam_id = ?',
                [examId]
            );
            console.log(`✅ Found ${questions.length} questions`);

            // ✅ Save each answer individually in exam_student_answers table
            console.log('🔄 Saving individual answers to exam_student_answers...');

            // Delete old answers first
            await execute(
                `DELETE FROM exam_student_answers WHERE exam_id = ? AND student_id = ?`,
                [examId, enrollmentId]
            );

            // Insert all answers
            for (const question of questions) {
                let studentAnswer: string | null = null;
                let isCorrect: number = 0;
                let pointsEarned: number = 0;

                if (question.type === 'multiple_choice') {
                    const rawAnswer = allAnswers.multipleChoice?.[question.id];
                    if (rawAnswer !== undefined && rawAnswer !== null) {
                        studentAnswer = String.fromCharCode(97 + Number(rawAnswer)); // Convert 0->a, 1->b, etc.

                        // ✅ Handle correct_answer comparison - can be letter ('a') or number (0)
                        const correctAnswer = question.correct_answer;
                        let correctLetter: string;

                        if (typeof correctAnswer === 'number') {
                            correctLetter = String.fromCharCode(97 + correctAnswer); // 0->a, 1->b
                        } else if (typeof correctAnswer === 'string') {
                            // If it's a single digit string like '0', '1', convert to letter
                            if (/^[0-3]$/.test(correctAnswer)) {
                                correctLetter = String.fromCharCode(97 + parseInt(correctAnswer));
                            } else {
                                correctLetter = correctAnswer.toLowerCase();
                            }
                        } else {
                            correctLetter = 'a'; // Default
                        }

                        console.log(`📝 Q ${question.id}: Student=${studentAnswer}, Correct=${correctLetter} (raw: ${correctAnswer})`);

                        isCorrect = (studentAnswer === correctLetter) ? 1 : 0;
                        pointsEarned = isCorrect ? (question.points || 0) : 0;
                    }
                } else if (question.type === 'true_false') {
                    const rawAnswer = allAnswers.multipleChoice?.[question.id];
                    if (rawAnswer !== undefined && rawAnswer !== null) {
                        const normalizeTf = (v: unknown): string | null => {
                            if (typeof v === 'boolean') return v ? 'true' : 'false';
                            if (typeof v === 'number') return v === 1 ? 'true' : v === 0 ? 'false' : null;
                            if (typeof v === 'string') {
                                const t = v.trim().toLowerCase();
                                if (['true', 't', '1'].includes(t)) return 'true';
                                if (['false', 'f', '0'].includes(t)) return 'false';
                                if (/^[0-1]$/.test(t)) return t === '1' ? 'true' : 'false';
                                if (/^[a-b]$/.test(t)) return t === 'a' ? 'true' : 'false';
                                return t;
                            }
                            return null;
                        };
                        studentAnswer = String(rawAnswer);
                        const studentNorm = normalizeTf(rawAnswer);
                        const correctNorm = normalizeTf(question.correct_answer);
                        isCorrect = studentNorm !== null && correctNorm !== null && studentNorm === correctNorm ? 1 : 0;
                        pointsEarned = isCorrect ? (question.points || 0) : 0;
                    }
                } else if (question.type === 'essay' || question.type === 'short_answer') {
                    studentAnswer = allAnswers.essay?.[question.id] || null;
                    // Manual questions need grading, so is_correct and points_earned stay 0 initially
                    isCorrect = 0;
                    pointsEarned = 0;
                }

                if (studentAnswer !== null) {
                    await execute(
                        `INSERT INTO exam_student_answers
                         (exam_id, student_id, question_id, student_answer, is_correct, points_earned)
                         VALUES (?, ?, ?, ?, ?, ?)
                         ON DUPLICATE KEY UPDATE
                            student_answer = VALUES(student_answer),
                            is_correct = VALUES(is_correct),
                            points_earned = VALUES(points_earned)`,
                        [examId, enrollmentId, question.id, studentAnswer, isCorrect, pointsEarned]
                    );
                }
            }

            console.log('✅ Individual answers saved to exam_student_answers');

            // Insert or update exam_results table for the results page.
            // exam_results.student_id references students(id) (enrollment id).
            console.log('🔄 Inserting/updating exam_results table...');
            await execute(
                `INSERT INTO exam_results (exam_id, student_id, marks_obtained, total_marks, submitted_at)
                 VALUES (?, ?, ?, ?, NOW())
                 ON DUPLICATE KEY UPDATE
                    marks_obtained = VALUES(marks_obtained),
                    total_marks = VALUES(total_marks),
                    submitted_at = VALUES(submitted_at)`,
                [examId, enrollmentId, score, totalMarks]
            );

            console.log('✅ Exam results inserted/updated');

            // ✅ Build response with fresh data instead of querying again
            const responseData = {
                exam_id: examId,
                student_id: enrollmentId,
                status: status,
                completed_at: new Date().toISOString(),
                score: score,
                answers: allAnswers,
                total_marks: totalMarks,
                passing_marks: passingMarks,
                passed: passed
            };

            console.log('✅ Submit exam attempt - Complete');
            console.log('📊 Response data:', responseData);

            res.json(responseData);
        } catch (error) {
            console.error('❌ Submit exam attempt error:', error);
            console.error('❌ Error stack:', (error as Error).stack);
            res.status(500).json({ error: 'Failed to submit exam attempt' });
        }
    });

    // Get exam attempts with student info (for admin)
    router.get('/:examId/attempts', deps.authenticate, async (req: AuthRequest, res: Response) => {
        try {
            const { examId } = req.params;
            const scopeId = instructorScopeId(req);

            // Teacher/admin only: any other authenticated principal is denied
            // before any data access.
            if (!scopeId && !isAdmin(req)) {
                return res.status(403).json({ error: 'Forbidden' });
            }

            let sql = `SELECT
                    ea.*,
                    s.name as student_name,
                    s.phone as student_phone,
                    s.email as student_email
                 FROM exam_attempts ea
                 INNER JOIN students s ON ea.student_id = s.id
                 WHERE ea.exam_id = ?`;
            const params: any[] = [examId];

            if (scopeId) {
                if (!(await isExamInScope(examId, scopeId))) {
                    return res.status(404).json({ error: 'Exam not found' });
                }
                sql += ` AND ea.student_id IN (SELECT id FROM students WHERE group_id IN (SELECT id FROM \`groups\` WHERE instructor_id = ?))`;
                params.push(scopeId);
            }
            sql += ' ORDER BY ea.started_at DESC';

            const attempts = await query(sql, params);

            res.json(attempts);
        } catch (error) {
            console.error('Get exam attempts error:', error);
            res.status(500).json({ error: 'Failed to fetch exam attempts' });
        }
    });

    // Get students who haven't attempted the exam
    router.get('/:examId/not-attempted', deps.authenticate, async (req: AuthRequest, res: Response) => {
        try {
            const { examId } = req.params;
            const scopeId = instructorScopeId(req);

            // Teacher/admin only.
            if (!scopeId && !isAdmin(req)) {
                return res.status(403).json({ error: 'Forbidden' });
            }

            let sql = `SELECT s.id, s.name, s.phone, s.email, s.grade_id, s.group_id
                 FROM students s
                 WHERE s.is_active = TRUE
                 AND s.id NOT IN (
                     SELECT student_id FROM exam_attempts WHERE exam_id = ?
                 )`;
            const params: any[] = [examId];
            if (scopeId) {
                if (!(await isExamInScope(examId, scopeId))) {
                    return res.status(404).json({ error: 'Exam not found' });
                }
                sql += ` AND s.group_id IN (SELECT id FROM \`groups\` WHERE instructor_id = ?)`;
                params.push(scopeId);
            }
            sql += ' ORDER BY s.name';

            const notAttempted = await query(sql, params);

            res.json(notAttempted);
        } catch (error) {
            console.error('Get not attempted students error:', error);
            res.status(500).json({ error: 'Failed to fetch students' });
        }
    });

    // ✅ Update exam question with image support
    router.put('/:examId/questions/:questionId', requireTeachingWriteAccess, async (req: AuthRequest, res: Response) => {
        try {
            const { examId, questionId } = req.params;
            const scopeId = instructorScopeId(req);
            if (scopeId && !(await isExamInScope(examId, scopeId))) {
                return res.status(404).json({ error: 'Exam not found' });
            }
            const { question_text, question_image, question_type, options, correct_answer, points, explanation } = req.body;

            await execute(
                `UPDATE exam_questions
                 SET question_text = ?,
                     question_image = ?,
                     question_type = ?,
                     options = ?,
                     correct_answer = ?,
                     points = ?,
                     explanation = ?
                 WHERE id = ? AND exam_id = ?`,
                [question_text, question_image || null, question_type, options, correct_answer, points, explanation || null, questionId, examId]
            );

            // ✅ Auto-update total_marks in exams table
            const totalMarksResult = await queryOne<{ total: number }>(
                'SELECT COALESCE(SUM(points), 0) as total FROM exam_questions WHERE exam_id = ?',
                [examId]
            );
            const totalMarks = totalMarksResult?.total || 0;
            await execute(
                'UPDATE exams SET total_marks = ? WHERE id = ?',
                [totalMarks, examId]
            );
            console.log(`✅ Updated exam ${examId} total_marks to ${totalMarks}`);

            res.json({ message: 'Question updated successfully' });
        } catch (error) {
            console.error('Update question error:', error);
            res.status(500).json({ error: 'Failed to update question' });
        }
    });

    // ✅ Delete exam question
    router.delete('/:examId/questions/:questionId', requireTeachingWriteAccess, async (req: AuthRequest, res: Response) => {
        try {
            const { examId, questionId } = req.params;
            const scopeId = instructorScopeId(req);
            if (scopeId && !(await isExamInScope(examId, scopeId))) {
                return res.status(404).json({ error: 'Exam not found' });
            }

            await execute(
                'DELETE FROM exam_questions WHERE id = ? AND exam_id = ?',
                [questionId, examId]
            );

            // ✅ Auto-update total_marks in exams table
            const totalMarksResult = await queryOne<{ total: number }>(
                'SELECT COALESCE(SUM(points), 0) as total FROM exam_questions WHERE exam_id = ?',
                [examId]
            );
            const totalMarks = totalMarksResult?.total || 0;
            await execute(
                'UPDATE exams SET total_marks = ? WHERE id = ?',
                [totalMarks, examId]
            );
            console.log(`✅ Updated exam ${examId} total_marks to ${totalMarks}`);

            res.json({ message: 'Question deleted successfully' });
        } catch (error) {
            console.error('Delete question error:', error);
            res.status(500).json({ error: 'Failed to delete question' });
        }
    });

    // ✅ Get exam attempt review details (questions + answers + grading)
    router.get('/:examId/review/:studentId', deps.authenticate, async (req: AuthRequest, res: Response) => {
        try {
            const { examId, studentId } = req.params;

            // Review exposes the answer key, so it is limited to the owning
            // student, a teacher who owns the exam, or an admin.
            const denied = await authorizeStudentAction(req, examId, studentId);
            if (denied) {
                return denyStatus(res, denied);
            }

            console.log('📖 Fetching exam review for:', { examId, studentId });

            // Get exam details
            const exam = await queryOne<any>(
                'SELECT * FROM exams WHERE id = ?',
                [examId]
            );

            if (!exam) {
                return res.status(404).json({ error: 'Exam not found' });
            }

            // Get exam attempt
            const attempt = await queryOne<any>(
                `SELECT * FROM exam_attempts
                 WHERE exam_id = ? AND student_id = ?
                 ORDER BY started_at DESC LIMIT 1`,
                [examId, studentId]
            );

            if (!attempt) {
                return res.status(404).json({ error: 'Exam attempt not found' });
            }

            // Get all questions
            const questions = await query<any>(
                'SELECT * FROM exam_questions WHERE exam_id = ? ORDER BY id',
                [examId]
            );

            // Parse student's answers
            let studentAnswers: any = {};
            try {
                if (typeof attempt.answers === 'string') {
                    studentAnswers = JSON.parse(attempt.answers);
                } else {
                    studentAnswers = attempt.answers || {};
                }
            } catch (e) {
                console.error('❌ Failed to parse student answers:', e);
                studentAnswers = {};
            }

            console.log('📝 Student Answers Structure:', JSON.stringify(studentAnswers, null, 2));

            // Parse essay scores from attempt.essay_scores
            let essayScores: any = {};
            try {
                if (attempt.essay_scores) {
                    if (typeof attempt.essay_scores === 'string') {
                        essayScores = JSON.parse(attempt.essay_scores);
                    } else {
                        essayScores = attempt.essay_scores;
                    }
                    console.log('📊 Essay Scores:', JSON.stringify(essayScores, null, 2));
                } else {
                    console.log('⚠️ No essay scores found in attempt');
                }
            } catch (e) {
                console.error('❌ Failed to parse essay scores:', e);
                essayScores = {};
            }

            // Build response with questions and grading
            const reviewData = {
                exam: {
                    id: exam.id,
                    title: exam.title,
                    description: exam.description,
                    total_marks: exam.total_marks,
                    passing_marks: exam.passing_marks
                },
                attempt: {
                    status: attempt.status,
                    score: attempt.score,
                    started_at: attempt.started_at,
                    completed_at: attempt.completed_at,
                    passed: attempt.score >= exam.passing_marks
                },
                questions: questions.map((q: any) => {
                    const isEssay = q.question_type === 'essay';
                    const questionId = String(q.id);

                    // Get student's answer
                    let studentAnswer = null;
                    if (isEssay) {
                        studentAnswer = studentAnswers.essay?.[questionId] || studentAnswers[questionId] || null;
                    } else {
                        // Use ?? to avoid treating 0 as falsy value
                        const rawAnswer = studentAnswers.multipleChoice?.[questionId] ?? studentAnswers[questionId] ?? null;
                        // Convert index (0,1,2,3) to letter (a,b,c,d)
                        if (rawAnswer !== null && rawAnswer !== undefined && typeof rawAnswer === 'number') {
                            studentAnswer = String.fromCharCode(97 + rawAnswer); // 97 = 'a'
                        } else if (typeof rawAnswer === 'string') {
                            studentAnswer = rawAnswer.toLowerCase(); // Ensure lowercase
                        } else {
                            studentAnswer = rawAnswer;
                        }
                    }

                    // Get essay grading if exists
                    const essayGrade = isEssay ? essayScores[questionId] : null;

                    const correctAnswer = q.correct_answer ? String(q.correct_answer).toLowerCase() : null;
                    const isCorrect = isEssay ? null : (studentAnswer === correctAnswer);

                    console.log(`Question ${questionId}:`, {
                        question_text: q.question_text.substring(0, 30),
                        raw_student_answer: studentAnswers.multipleChoice?.[questionId],
                        converted_student_answer: studentAnswer,
                        correct_answer: correctAnswer,
                        is_correct: isCorrect
                    });

                    // ✅ Handle both formats: number or object for essay_grade
                    let processedEssayGrade = null;
                    if (essayGrade !== null && essayGrade !== undefined) {
                        if (typeof essayGrade === 'number') {
                            // Simple number format: {question_id: 5}
                            processedEssayGrade = {
                                score: essayGrade,
                                feedback: null,
                                graded_by: null,
                                graded_at: null
                            };
                        } else if (typeof essayGrade === 'object') {
                            // Object format: {question_id: {score: 5, feedback: "..."}}
                            processedEssayGrade = {
                                score: essayGrade.score || 0,
                                feedback: essayGrade.feedback || null,
                                graded_by: essayGrade.graded_by || null,
                                graded_at: essayGrade.graded_at || null
                            };
                        }
                    }

                    return {
                        id: q.id,
                        question_text: q.question_text,
                        question_image: q.question_image,
                        question_type: q.question_type,
                        options: q.options,
                        correct_answer: correctAnswer,
                        points: q.points || q.marks || 1,
                        explanation: q.explanation,
                        student_answer: studentAnswer,
                        is_correct: isCorrect,
                        essay_grade: processedEssayGrade
                    };
                })
            };

            console.log('✅ Review data prepared');
            res.json(reviewData);
        } catch (error) {
            console.error('❌ Get exam review error:', error);
            res.status(500).json({ error: 'Failed to fetch exam review' });
        }
    });

    return router;
};

/** Production wiring: real pool, real auth and entitlement middleware. */
export default createExamRouter({
    db: { query, queryOne, execute },
    optionalAuthenticate: optionalAuth,
    authenticate: authenticateToken,
    requireTeachingWriteAccess: requireTeachingWrite('exams'),
});
