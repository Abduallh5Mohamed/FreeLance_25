import { Router, Request, Response } from 'express';
import { query, queryOne, execute } from '../db';

const router = Router();

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
        const { course_id, is_active, student_id } = req.query;

        let sql = 'SELECT * FROM exams WHERE 1=1';
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

        sql += ' ORDER BY created_at DESC';

        let exams = await query<Exam>(sql, params);

        // If student_id provided, add attempt count for each exam
        if (student_id) {
            exams = await Promise.all(exams.map(async (exam) => {
                const attempt = await queryOne(
                    'SELECT COUNT(*) as attempt_count FROM exam_attempts WHERE exam_id = ? AND student_id = ?',
                    [exam.id, student_id as string]
                );
                return {
                    ...exam,
                    attempts: attempt?.attempt_count || 0
                };
            }));
        }

        res.json(exams);
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
            duration_minutes,
            total_marks,
            passing_marks,
            start_time,
            end_time,
            start_date,  // ✅ Support from TeacherExams
            end_date,    // ✅ Support from TeacherExams
            is_active = true
        } = req.body;

        // ✅ Use start_date/end_date if start_time/end_time not provided
        let finalStartTime = start_time || start_date || null;
        let finalEndTime = end_time || end_date || null;

        // ✅ Convert ISO format to MySQL DATETIME format
        if (finalStartTime) {
            finalStartTime = new Date(finalStartTime).toISOString().slice(0, 19).replace('T', ' ');
        }
        if (finalEndTime) {
            finalEndTime = new Date(finalEndTime).toISOString().slice(0, 19).replace('T', ' ');
        }

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

        const result = await execute(
            `INSERT INTO exams (id, title, description, course_id, duration_minutes, total_marks, passing_marks, start_time, end_time, is_active, created_at, updated_at)
             VALUES (UUID(), ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
            [
                title,
                description ?? null,
                course_id,
                duration_minutes,
                total_marks,
                passing_marks ?? null,
                finalStartTime,
                finalEndTime,
                is_active
            ]
        );

        const newExam = await queryOne<Exam>(
            'SELECT * FROM exams WHERE id = (SELECT id FROM exams ORDER BY created_at DESC LIMIT 1)'
        );

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
            total_marks,
            passing_marks,
            start_time,
            end_time,
            is_active
        } = req.body;

        const result = await execute(
            `UPDATE exams 
             SET title = COALESCE(?, title),
                 description = COALESCE(?, description),
                 duration_minutes = COALESCE(?, duration_minutes),
                 total_marks = COALESCE(?, total_marks),
                 passing_marks = COALESCE(?, passing_marks),
                 start_time = COALESCE(?, start_time),
                 end_time = COALESCE(?, end_time),
                 is_active = COALESCE(?, is_active),
                 updated_at = NOW()
             WHERE id = ?`,
            [
                title ?? null,
                description ?? null,
                duration_minutes ?? null,
                total_marks ?? null,
                passing_marks ?? null,
                start_time ?? null,
                end_time ?? null,
                is_active ?? null,
                req.params.id
            ]
        );

        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Exam not found' });
        }

        const updatedExam = await queryOne<Exam>(
            'SELECT * FROM exams WHERE id = ?',
            [req.params.id]
        );

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
            question_type,
            options,
            correct_answer,
            marks,
            display_order
        } = req.body;

        if (!question_text || !question_type || !marks) {
            return res.status(400).json({ error: 'Missing required fields' });
        }

        await execute(
            `INSERT INTO exam_questions (id, exam_id, question_text, question_type, options, correct_answer, points, display_order, created_at)
             VALUES (UUID(), ?, ?, ?, ?, ?, ?, ?, NOW())`,
            [
                req.params.examId,
                question_text,
                question_type,
                options ?? null,
                correct_answer ?? null,
                marks,
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

// Check if student can take exam (not attempted before + exam is open)
router.get('/:examId/can-attempt/:studentId', async (req: Request, res: Response) => {
    try {
        const { examId, studentId } = req.params;

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
                totalMarks: attempt.total_marks || 0,
                passed: attempt.status === 'passed'
            });
        }

        // Check exam timing
        const exam = await queryOne<Exam>(
            'SELECT * FROM exams WHERE id = ?',
            [examId]
        );

        if (!exam) {
            return res.status(404).json({ error: 'Exam not found' });
        }

        const now = new Date();
        const startTime = exam.start_time ? new Date(exam.start_time) : null;
        const endTime = exam.end_time ? new Date(exam.end_time) : null;

        console.log('🕐 Time Check:');
        console.log('  Current time:', now.toISOString(), '(Local:', now.toLocaleString('ar-EG'), ')');
        console.log('  Start time:', startTime?.toISOString(), '(Local:', startTime?.toLocaleString('ar-EG'), ')');
        console.log('  End time:', endTime?.toISOString(), '(Local:', endTime?.toLocaleString('ar-EG'), ')');
        console.log('  Now < Start?', startTime && now < startTime);
        console.log('  Now > End?', endTime && now > endTime);

        if (startTime && now < startTime) {
            return res.json({
                canAttempt: false,
                reason: 'not_started',
                message: 'الامتحان لم يبدأ بعد',
                startTime: startTime
            });
        }

        if (endTime && now > endTime) {
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
        const { answers, score } = req.body;

        await execute(
            `UPDATE exam_attempts 
             SET status = 'completed', 
                 completed_at = NOW(),
                 score = ?,
                 answers = ?
             WHERE exam_id = ? AND student_id = ?`,
            [score ?? null, JSON.stringify(answers) ?? null, examId, studentId]
        );

        const updatedAttempt = await queryOne(
            'SELECT * FROM exam_attempts WHERE exam_id = ? AND student_id = ?',
            [examId, studentId]
        );

        res.json(updatedAttempt);
    } catch (error) {
        console.error('Submit exam attempt error:', error);
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

export default router;
