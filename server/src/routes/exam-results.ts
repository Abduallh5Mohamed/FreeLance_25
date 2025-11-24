import { Router, Request, Response } from 'express';
import { query } from '../db';

const router = Router();

interface ExamResult {
    id: string;
    exam_id: string;
    exam_title: string;
    student_id: string; // user id
    student_name: string;
    grade_id?: string | null;
    group_id?: string | null;
    grade_name?: string | null;
    group_name?: string | null;
    score: number;
    total_marks: number;
    passing_marks?: number;
    status: 'pending' | 'graded' | 'submitted';
    submitted_at: string;
    graded_at?: string;
}

// Get all exam results with filters
router.get('/', async (req: Request, res: Response) => {
    try {
        const { exam_id, student_id } = req.query;

        let sql = `
            SELECT 
                er.id,
                er.exam_id,
                e.title AS exam_title,
                er.student_id,
                COALESCE(u.name, 'طالب غير معروف') AS student_name,
                s.grade_id,
                s.group_id,
                gr.name AS grade_name,
                grp.name AS group_name,
                er.marks_obtained AS score,
                er.total_marks,
                e.passing_marks,
                'graded' AS status,
                er.submitted_at,
                er.graded_at
            FROM exam_results er
            INNER JOIN exams e ON e.id = er.exam_id
            LEFT JOIN users u ON u.id = er.student_id AND u.role = 'student'
            /* Try to locate matching student row by explicit link, or fallback by phone, or by id match */
            LEFT JOIN students s ON (s.id = u.student_id OR (u.student_id IS NULL AND s.phone = u.phone) OR s.id = u.id)
            LEFT JOIN grades gr ON gr.id = s.grade_id
            LEFT JOIN \`groups\` grp ON grp.id = s.group_id
            WHERE 1=1
        `;
        const params: string[] = [];

        if (exam_id) {
            sql += ' AND er.exam_id = ?';
            params.push(exam_id as string);
        }

        if (student_id) {
            sql += ' AND er.student_id = ?';
            params.push(student_id as string);
        }

        sql += ' ORDER BY er.submitted_at DESC';

        const results = await query<ExamResult>(sql, params);
        res.json(results);
    } catch (error) {
        console.error('Get exam results error:', error);
        res.status(500).json({ error: 'Failed to fetch exam results', details: error instanceof Error ? error.message : 'Unknown error' });
    }
});

// Get exam result by ID
router.get('/:id', async (req: Request, res: Response) => {
    try {
        const { id } = req.params;

        const sql = `
            SELECT 
                er.id,
                er.exam_id,
                e.title AS exam_title,
                er.student_id,
                COALESCE(u.name, 'طالب غير معروف') AS student_name,
                s.grade_id,
                s.group_id,
                gr.name AS grade_name,
                grp.name AS group_name,
                er.marks_obtained AS score,
                er.total_marks,
                e.passing_marks,
                'graded' AS status,
                NULL AS answers,
                er.submitted_at,
                er.graded_at,
                er.graded_by,
                er.remarks AS feedback
            FROM exam_results er
            INNER JOIN exams e ON e.id = er.exam_id
            LEFT JOIN users u ON u.id = er.student_id AND u.role = 'student'
            LEFT JOIN students s ON (s.id = u.student_id OR (u.student_id IS NULL AND s.phone = u.phone) OR s.id = u.id)
            LEFT JOIN grades gr ON gr.id = s.grade_id
            LEFT JOIN \`groups\` grp ON grp.id = s.group_id
            WHERE er.id = ?
        `;

        const results = await query<ExamResult>(sql, [id]);
        if (results.length === 0) {
            return res.status(404).json({ error: 'Exam result not found' });
        }

        res.json(results[0]);
    } catch (error) {
        console.error('Get exam result error:', error);
        res.status(500).json({ error: 'Failed to fetch exam result', details: error instanceof Error ? error.message : 'Unknown error' });
    }
});

export default router;
