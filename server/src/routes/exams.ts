import { Router, Request, Response } from 'express';
import { query, queryOne, execute } from '../db';
import multer from 'multer';
import path from 'path';
import fs from 'fs';

const router = Router();

// Setup multer for question image uploads
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
    limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
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

// ✅ Get exams for a specific student based on their group
router.get('/student/:userId', async (req: Request, res: Response) => {
    try {
        const { userId } = req.params;

        // Get student's group_id using phone from users table
        const user = await queryOne<{ phone: string }>(
            'SELECT phone FROM users WHERE id = ?',
            [userId]
        );

        if (!user?.phone) {
            return res.json([]); // User not found
        }

        const student = await queryOne<{ group_id: string }>(
            'SELECT group_id FROM students WHERE phone = ?',
            [user.phone]
        );

        if (!student?.group_id) {
            return res.json([]); // Student has no group, return empty
        }

        // Get exams assigned to this group (only active exams)
        const exams = await query<Exam>(
            `SELECT DISTINCT e.* 
             FROM exams e
             INNER JOIN exam_groups eg ON e.id = eg.exam_id
             WHERE eg.group_id = ? AND e.is_active = TRUE
             ORDER BY e.created_at DESC`,
            [student.group_id]
        );

        res.json(exams);
    } catch (error) {
        console.error('❌ Error fetching student exams:', error);
        res.status(500).json({ error: 'Failed to fetch exams' });
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

// ===== EXAMS =====

// Get all exams
router.get('/', async (req: Request, res: Response) => {
    try {
        const { course_id, is_active, student_id, grade_id } = req.query;

        // Return raw fields - start_time and end_time are DATETIME columns
        let sql = `SELECT e.* FROM exams e WHERE 1=1`;
        const params: string[] = [];

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

        sql += ' ORDER BY created_at DESC';

        let exams = await query<any>(sql, params);

        // If student_id provided, add attempt count for each exam
        if (student_id) {
            // TODO: Add exam_attempts table
            // For now, return 0 attempts for all exams
            exams = exams.map((exam) => ({
                ...exam,
                attempts: 0
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
router.get('/:id', async (req: Request, res: Response) => {
    try {
        const exam = await queryOne<Exam>(
            'SELECT * FROM exams WHERE id = ?',
            [req.params.id]
        );

        if (!exam) {
            return res.status(404).json({ error: 'Exam not found' });
        }

        res.json(exam);
    } catch (error) {
        console.error('Get exam by ID error:', error);
        res.status(500).json({ error: 'Failed to fetch exam' });
    }
});

// Create exam
router.post('/', async (req: Request, res: Response) => {
    try {
        console.log('📝 Creating exam with data:', JSON.stringify(req.body, null, 2));

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

        const result = await execute(
            `INSERT INTO exams (id, title, description, course_id, grade_id, duration_minutes, total_marks, passing_marks, exam_date, start_time, end_time, is_active, is_published, created_at, updated_at)
             VALUES (UUID(), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NOW(), NOW())`,
            [
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
            'SELECT * FROM exams WHERE id = (SELECT id FROM exams ORDER BY created_at DESC LIMIT 1)'
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
router.put('/:id', async (req: Request, res: Response) => {
    try {
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
            group_id
        } = req.body;

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
        if (group_id !== undefined) {
            updates.push('group_id = ?');
            values.push(group_id);
        }

        updates.push('updated_at = NOW()');
        values.push(req.params.id);

        if (updates.length === 1) {
            return res.status(400).json({ error: 'No fields to update' });
        }

        const query = `UPDATE exams SET ${updates.join(', ')} WHERE id = ?`;
        console.log('🔧 UPDATE QUERY:', query);
        console.log('📊 VALUES:', values);

        const result = await execute(query, values);

        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Exam not found' });
        }

        console.log('✅ UPDATE RESULT:', result);

        const updatedExam = await queryOne<Exam>(
            'SELECT * FROM exams WHERE id = ?',
            [req.params.id]
        );

        console.log('✅ UPDATED EXAM:', updatedExam);

        res.json(updatedExam);
    } catch (error) {
        console.error('Update exam error:', error);
        res.status(500).json({ error: 'Failed to update exam' });
    }
});

// Delete exam (soft delete)
router.delete('/:id', async (req: Request, res: Response) => {
    try {
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
router.post('/upload-question-image', upload.single('image'), async (req: Request, res: Response) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No image file provided' });
        }

        const imageUrl = `/uploads/questions/${req.file.filename}`;

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
router.get('/:examId/questions', async (req: Request, res: Response) => {
    try {
        const examId = req.params.examId;
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
router.post('/:examId/questions', async (req: Request, res: Response) => {
    try {
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

        await execute(
            `INSERT INTO exam_questions (id, exam_id, question_text, question_image, question_type, options, correct_answer, points, display_order, created_at)
             VALUES (UUID(), ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
            [
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

        const newQuestion = await queryOne<ExamQuestion>(
            'SELECT * FROM exam_questions WHERE id = (SELECT id FROM exam_questions ORDER BY created_at DESC LIMIT 1)'
        );

        res.status(201).json(newQuestion);
    } catch (error) {
        console.error('Add exam question error:', error);
        res.status(500).json({ error: 'Failed to add exam question' });
    }
});

// ===== EXAM RESULTS =====

// Get all results for an exam
router.get('/:examId/results', async (req: Request, res: Response) => {
    try {
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
router.get('/:examId/results/student/:studentId', async (req: Request, res: Response) => {
    try {
        const result = await queryOne<ExamResult>(
            'SELECT * FROM exam_results WHERE exam_id = ? AND student_id = ?',
            [req.params.examId, req.params.studentId]
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
router.post('/:examId/results', async (req: Request, res: Response) => {
    try {
        const { student_id, score, total_marks, status = 'submitted' } = req.body;

        if (!student_id || score === undefined || !total_marks) {
            return res.status(400).json({ error: 'Missing required fields' });
        }

        await execute(
            `INSERT INTO exam_results (id, exam_id, student_id, score, total_marks, status, submitted_at, created_at)
             VALUES (UUID(), ?, ?, ?, ?, ?, NOW(), NOW())`,
            [req.params.examId, student_id, score, total_marks, status]
        );

        const newResult = await queryOne<ExamResult>(
            'SELECT * FROM exam_results WHERE id = (SELECT id FROM exam_results ORDER BY created_at DESC LIMIT 1)'
        );

        res.status(201).json(newResult);
    } catch (error) {
        console.error('Submit exam result error:', error);
        res.status(500).json({ error: 'Failed to submit exam result' });
    }
});

// ===== EXAM ATTEMPTS =====

// Check if student can take exam (enrolled + not attempted + within schedule)
router.get('/:examId/can-attempt/:studentId', async (req: Request, res: Response) => {
    try {
        const { examId, studentId } = req.params;

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
                [studentId, exam.course_id]
            );

            if (!enrollment) {
                // Auto-enroll student in course
                try {
                    await execute(
                        'INSERT INTO student_courses (student_id, course_id) VALUES (?, ?)',
                        [studentId, exam.course_id]
                    );
                    console.log(`✅ Auto-enrolled student ${studentId} in course ${exam.course_id}`);
                } catch (enrollError) {
                    console.error('⚠️ Auto-enrollment failed (continuing anyway):', enrollError);
                    // Continue to allow exam attempt even if enrollment fails
                }
            }
        }

        // Check if already attempted
        const attempt = await queryOne(
            'SELECT * FROM exam_attempts WHERE exam_id = ? AND student_id = ?',
            [examId, studentId]
        );

        if (attempt) {
            return res.json({
                canAttempt: false,
                reason: 'already_attempted',
                message: 'لقد قمت بالامتحان من قبل',
                score: attempt.score,
                totalMarks: exam.total_marks || 0,
                passed: attempt.status === 'passed'
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
router.post('/:examId/start/:studentId', async (req: Request, res: Response) => {
    try {
        const { examId, studentId } = req.params;

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
                [studentId, exam.course_id]
            );

            if (!enrollment) {
                // Auto-enroll student in the course
                try {
                    await execute(
                        'INSERT INTO student_courses (student_id, course_id) VALUES (?, ?)',
                        [studentId, exam.course_id]
                    );
                    console.log(`✅ Auto-enrolled student ${studentId} in course ${exam.course_id}`);
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
        const existingAttempt = await queryOne(
            'SELECT * FROM exam_attempts WHERE exam_id = ? AND student_id = ?',
            [examId, studentId]
        );

        if (existingAttempt) {
            return res.status(400).json({ error: 'Exam already attempted' });
        }

        // Create new attempt with generated UUID
        const attemptId = require('crypto').randomUUID();
        await execute(
            `INSERT INTO exam_attempts (id, exam_id, student_id, status, started_at, created_at)
             VALUES (?, ?, ?, 'in_progress', NOW(), NOW())`,
            [attemptId, examId, studentId]
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

// Submit exam attempt
router.post('/:examId/submit/:studentId', async (req: Request, res: Response) => {
    try {
        const { examId, studentId } = req.params;
        const { answers, score: frontendScore, essayAnswers, answerImages, hasEssayQuestions } = req.body;  // ✅ دعم الإجابات المقالية وصور الإجابات

        console.log('🔍 Submit exam attempt - Start');
        console.log('📝 Exam ID:', examId);
        console.log('👤 Student ID:', studentId);
        console.log('📊 Frontend Score:', frontendScore);
        console.log('📝 Has Essay Questions:', hasEssayQuestions);
        console.log('✍️ Essay Answers:', essayAnswers);
        console.log('🖼️ Answer Images:', answerImages);

        // Get user info and find matching student by phone
        const userRow = await queryOne<any>(
            'SELECT id, phone FROM users WHERE id = ?',
            [studentId]
        );

        // Find student ID by phone for exam_results table
        let resultsStudentId = studentId; // Default to user ID
        if (userRow?.phone) {
            const studentRow = await queryOne<any>(
                'SELECT id FROM students WHERE phone = ?',
                [userRow.phone]
            );
            if (studentRow?.id) {
                resultsStudentId = studentRow.id;
            }
        }

        // Verify the student exists in students table for exam_results
        const studentExists = await queryOne<any>(
            'SELECT id FROM students WHERE id = ?',
            [resultsStudentId]
        );

        // Get exam info for total_marks
        const exam = await queryOne<any>(
            'SELECT total_marks, passing_marks FROM exams WHERE id = ?',
            [examId]
        );

        if (!exam) {
            console.error('❌ Exam not found:', examId);
            return res.status(404).json({ error: 'Exam not found' });
        }

        console.log('✅ Exam found:', exam);

        // ✅ Fetch all questions and calculate score on backend
        const questionRows = await query<any>(
            'SELECT id, question_type, correct_answer, points FROM exam_questions WHERE exam_id = ?',
            [examId]
        );

        // Calculate score on backend to ensure accuracy
        let calculatedScore = 0;
        let mcqTotal = 0;

        for (const q of questionRows) {
            const questionPoints = Number(q.points) || 1;

            if (q.question_type === 'multiple_choice') {
                mcqTotal += questionPoints;
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
            }
        }

        console.log(`📊 Backend calculated score: ${calculatedScore}/${mcqTotal}`);

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

        // ✅ If essay questions exist, status is 'pending_review' until manually graded
        const status = hasEssayQuestions ? 'pending_review' : ((Number(score) || 0) >= passingMarks ? 'passed' : 'failed');
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

        // Update exam_attempts table
        console.log('🔄 Updating exam_attempts table...');
        await execute(
            `UPDATE exam_attempts 
             SET status = ?, 
                 completed_at = NOW(),
                 score = ?,
                 answers = ?
             WHERE exam_id = ? AND student_id = ?`,
            [status, score ?? null, JSON.stringify(allAnswers), examId, studentId]
        );

        console.log('✅ Exam attempt updated');

        // ✅ Get actual student.id from students table using phone
        console.log('🔍 Getting student.id from students table...');

        // First get user phone
        const userRecordArray = await query<any>(
            'SELECT phone FROM users WHERE id = ?',
            [studentId]
        );

        const userRecord = userRecordArray[0];

        if (!userRecord || !userRecord.phone) {
            console.error('❌ User not found or has no phone');
            return res.status(400).json({
                error: 'لا يمكن العثور على بيانات المستخدم. يرجى التواصل مع الإدارة.'
            });
        }

        // Then get student by phone
        const studentRecords = await query<any>(
            'SELECT id FROM students WHERE phone = ?',
            [userRecord.phone]
        );

        const actualStudentId = studentRecords[0]?.id;

        // If student doesn't exist in students table, skip exam_student_answers (only save to exam_attempts and exam_results)
        if (!actualStudentId) {
            console.warn(`⚠️ Student not found in students table for phone ${userRecord.phone}. Skipping exam_student_answers.`);

            // Still save to exam_results (uses user ID)
            await execute(
                `INSERT INTO exam_results (exam_id, student_id, marks_obtained, total_marks, submitted_at)
                 VALUES (?, ?, ?, ?, NOW())
                 ON DUPLICATE KEY UPDATE 
                    marks_obtained = VALUES(marks_obtained),
                    total_marks = VALUES(total_marks),
                    submitted_at = VALUES(submitted_at)`,
                [examId, studentId, score ?? 0, exam.total_marks || 0]
            );

            const responseData = {
                exam_id: examId,
                student_id: studentId,
                status: status,
                completed_at: new Date().toISOString(),
                score: score ?? null,
                total_marks: exam.total_marks || 0,
                passed: status === 'passed'
            };

            return res.status(201).json(responseData);
        }

        console.log(`📊 User ID: ${studentId}`);
        console.log(`📊 User Phone: ${userRecord.phone}`);
        console.log(`📊 Student ID: ${actualStudentId}`);

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
            [examId, actualStudentId]
        );

        // Insert all answers
        for (const question of questions) {
            let studentAnswer: string | null = null;
            let isCorrect: number = 0;
            let pointsEarned: number = 0;

            if (question.type === 'multiple_choice') {
                const rawAnswer = allAnswers.multipleChoice?.[question.id];
                if (rawAnswer !== undefined && rawAnswer !== null) {
                    studentAnswer = String.fromCharCode(97 + rawAnswer); // Convert 0->a, 1->b, etc.

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
            } else if (question.type === 'essay') {
                studentAnswer = allAnswers.essay?.[question.id] || null;
                // Essay questions need manual grading, so is_correct and points_earned will be null initially
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
                    [examId, actualStudentId, question.id, studentAnswer, isCorrect, pointsEarned]
                );
            }
        }

        console.log('✅ Individual answers saved to exam_student_answers');

        // Insert or update exam_results table for the results page
        // ⚠️ IMPORTANT: exam_results.student_id references users.id, NOT students.id
        console.log('🔄 Inserting/updating exam_results table...');
        await execute(
            `INSERT INTO exam_results (exam_id, student_id, marks_obtained, total_marks, submitted_at)
             VALUES (?, ?, ?, ?, NOW())
             ON DUPLICATE KEY UPDATE 
                marks_obtained = VALUES(marks_obtained),
                total_marks = VALUES(total_marks),
                submitted_at = VALUES(submitted_at)`,
            [examId, studentId, score ?? 0, totalMarks]
        );

        console.log('✅ Exam results inserted/updated');

        // ✅ Build response with fresh data instead of querying again
        const responseData = {
            exam_id: examId,
            student_id: studentId,
            status: status,
            completed_at: new Date().toISOString(),
            score: score ?? null,
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
router.get('/:examId/attempts', async (req: Request, res: Response) => {
    try {
        const { examId } = req.params;

        const attempts = await query(
            `SELECT 
                ea.*,
                s.name as student_name,
                s.phone as student_phone,
                s.email as student_email
             FROM exam_attempts ea
             INNER JOIN students s ON ea.student_id = s.id
             WHERE ea.exam_id = ?
             ORDER BY ea.started_at DESC`,
            [examId]
        );

        res.json(attempts);
    } catch (error) {
        console.error('Get exam attempts error:', error);
        res.status(500).json({ error: 'Failed to fetch exam attempts' });
    }
});

// Get students who haven't attempted the exam
router.get('/:examId/not-attempted', async (req: Request, res: Response) => {
    try {
        const { examId } = req.params;

        const notAttempted = await query(
            `SELECT s.id, s.name, s.phone, s.email, s.grade_id, s.group_id
             FROM students s
             WHERE s.is_active = TRUE
             AND s.id NOT IN (
                 SELECT student_id FROM exam_attempts WHERE exam_id = ?
             )
             ORDER BY s.name`,
            [examId]
        );

        res.json(notAttempted);
    } catch (error) {
        console.error('Get not attempted students error:', error);
        res.status(500).json({ error: 'Failed to fetch students' });
    }
});

// ✅ Update exam question with image support
router.put('/:examId/questions/:questionId', async (req: Request, res: Response) => {
    try {
        const { examId, questionId } = req.params;
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

        res.json({ message: 'Question updated successfully' });
    } catch (error) {
        console.error('Update question error:', error);
        res.status(500).json({ error: 'Failed to update question' });
    }
});

// ✅ Delete exam question
router.delete('/:examId/questions/:questionId', async (req: Request, res: Response) => {
    try {
        const { examId, questionId } = req.params;

        await execute(
            'DELETE FROM exam_questions WHERE id = ? AND exam_id = ?',
            [questionId, examId]
        );

        res.json({ message: 'Question deleted successfully' });
    } catch (error) {
        console.error('Delete question error:', error);
        res.status(500).json({ error: 'Failed to delete question' });
    }
});

// ✅ Get exam attempt review details (questions + answers + grading)
router.get('/:examId/review/:studentId', async (req: Request, res: Response) => {
    try {
        const { examId, studentId } = req.params;

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

export default router;
