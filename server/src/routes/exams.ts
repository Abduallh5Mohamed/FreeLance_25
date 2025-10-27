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
    marks: number;
    display_order: number;
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
        const { course_id, is_active } = req.query;

        let sql = 'SELECT * FROM exams WHERE 1=1';
        const params: string[] = [];

        if (course_id) {
            sql += ' AND course_id = ?';
            params.push(course_id as string);
        }
        if (is_active !== undefined) {
            sql += ' AND is_active = ?';
            params.push(is_active as string);
        }

        sql += ' ORDER BY created_at DESC';

        const exams = await query<Exam>(sql, params);
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
        const {
            title,
            description,
            course_id,
            duration_minutes,
            total_marks,
            passing_marks,
            start_time,
            end_time,
            is_active = true
        } = req.body;

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
                start_time ?? null,
                end_time ?? null,
                is_active
            ]
        );

        const newExam = await queryOne<Exam>(
            'SELECT * FROM exams WHERE id = (SELECT id FROM exams ORDER BY created_at DESC LIMIT 1)'
        );

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
        const questions = await query<ExamQuestion>(
            'SELECT * FROM exam_questions WHERE exam_id = ? ORDER BY display_order',
            [req.params.examId]
        );
        res.json(questions);
    } catch (error) {
        console.error('Get exam questions error:', error);
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
            `INSERT INTO exam_questions (id, exam_id, question_text, question_type, options, correct_answer, marks, display_order, created_at)
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

export default router;
