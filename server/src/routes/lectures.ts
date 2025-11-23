import { Router, Request, Response } from 'express';
import { query, queryOne, execute } from '../db';

const router = Router();

interface Lecture {
    id: string;
    course_id: string;
    grade_id?: string;
    group_id?: string;
    title: string;
    description?: string;
    video_url: string;
    duration_minutes?: number;
    display_order?: number;
    is_free: boolean;
    is_published: boolean;
    created_at?: Date;
    updated_at?: Date;
    course_name?: string;
    course_subject?: string;
    grade_name?: string;
    group_name?: string;
}

// Get all lectures (published by default)
router.get('/', async (req: Request, res: Response) => {
    try {
        const { course_id, group_id, grade_id } = req.query;

        let sql = `
            SELECT 
                l.*,
                c.name as course_name,
                c.subject as course_subject,
                gr.name as grade_name,
                g.name as group_name
            FROM lectures l
            LEFT JOIN courses c ON l.course_id = c.id
            LEFT JOIN grades gr ON l.grade_id = gr.id
            LEFT JOIN \`groups\` g ON l.group_id = g.id
            WHERE l.is_published = TRUE
        `;
        const params: string[] = [];

        if (course_id && typeof course_id === 'string') {
            sql += ' AND l.course_id = ?';
            params.push(course_id);
        }

        if (grade_id && typeof grade_id === 'string') {
            sql += ' AND l.grade_id = ?';
            params.push(grade_id);
        }

        if (group_id && typeof group_id === 'string') {
            sql += ' AND (l.group_id = ? OR l.group_id IS NULL)';
            params.push(group_id);
        }

        sql += ' ORDER BY l.display_order ASC, l.created_at DESC';

        const lectures = await query(sql, params);
        console.log(`[Lectures] GET / - Found ${lectures?.length || 0} lectures`);
        res.json(lectures);
    } catch (error) {
        console.error('Get lectures error:', error);
        res.status(500).json({ error: 'Failed to fetch lectures' });
    }
});

// Get lectures for a specific student based on their group
router.get('/student/:userId', async (req: Request, res: Response) => {
    try {
        const { userId } = req.params;

        console.log(`[Lectures] Looking up student for userId: ${userId}`);

        // First, get user info to find their phone
        const userRecord = await queryOne(
            'SELECT id, phone, role FROM users WHERE id = ? AND role = "student"',
            [userId]
        );

        if (!userRecord || !userRecord.phone) {
            console.log(`[Lectures] User not found or has no phone: ${userId}`);
            return res.json([]);
        }

        console.log(`[Lectures] Found user with phone: ${userRecord.phone}`);

        // Find student by phone (students table has phone directly)
        const student = await queryOne(
            'SELECT id, name, phone, group_id, grade_id FROM students WHERE phone = ? AND is_active = TRUE',
            [userRecord.phone]
        );

        if (!student) {
            console.log(`[Lectures] Student not found for phone: ${userRecord.phone}`);
            return res.json([]);
        }

        console.log(`[Lectures] Found student: ${student.name} (grade: ${student.grade_id}, group: ${student.group_id})`);

        // Get lectures for student's grade and group
        let sql = `
            SELECT 
                l.*,
                c.name as course_name,
                c.subject as course_subject,
                gr.name as grade_name,
                g.name as group_name
            FROM lectures l
            LEFT JOIN courses c ON l.course_id = c.id
            LEFT JOIN grades gr ON l.grade_id = gr.id
            LEFT JOIN \`groups\` g ON l.group_id = g.id
            WHERE l.is_published = TRUE
        `;

        const params: any[] = [];
        const conditions: string[] = [];

        // Filter by grade if student has one
        if (student.grade_id) {
            conditions.push('l.grade_id = ?');
            params.push(student.grade_id);
        }

        // Filter by group if student has one
        if (student.group_id) {
            conditions.push('l.group_id = ?');
            params.push(student.group_id);
        }

        if (conditions.length > 0) {
            sql += ' AND (' + conditions.join(' OR ') + ')';
        }

        sql += ' ORDER BY l.display_order ASC, l.created_at DESC';

        const lectures = await query(sql, params);

        console.log(`[Lectures] Student ${userId} (grade: ${student.grade_id}, group: ${student.group_id}) - Found ${lectures?.length || 0} lectures`);
        res.json(lectures);
    } catch (error) {
        console.error('Get student lectures error:', error);
        res.status(500).json({ error: 'Failed to fetch student lectures' });
    }
});

// Get lecture by ID
router.get('/:id', async (req: Request, res: Response) => {
    try {
        const lecture = await queryOne(
            `SELECT 
                l.*,
                c.name as course_name,
                c.subject as course_subject,
                gr.name as grade_name,
                g.name as group_name
            FROM lectures l
            LEFT JOIN courses c ON l.course_id = c.id
            LEFT JOIN grades gr ON l.grade_id = gr.id
            LEFT JOIN \`groups\` g ON l.group_id = g.id
            WHERE l.id = ?`,
            [req.params.id]
        );

        if (!lecture) {
            return res.status(404).json({ error: 'Lecture not found' });
        }

        res.json(lecture);
    } catch (error) {
        console.error('Get lecture error:', error);
        res.status(500).json({ error: 'Failed to fetch lecture' });
    }
});

// Create new lecture
router.post('/', async (req: Request, res: Response) => {
    try {
        const {
            course_id,
            grade_id,
            group_id,
            title,
            description,
            video_url,
            duration_minutes,
            display_order = 0,
            is_free = false,
            is_published = true
        } = req.body;

        if (!course_id || !title || !video_url) {
            return res.status(400).json({
                error: 'Course ID, title, and video_url are required'
            });
        }

        console.log('[Lectures] Creating lecture:', { course_id, grade_id, group_id, title, video_url });

        const result = await execute(
            `INSERT INTO lectures 
            (course_id, grade_id, group_id, title, description, video_url, duration_minutes, display_order, is_free, is_published) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                course_id,
                grade_id || null,
                group_id || null,
                title,
                description || null,
                video_url,
                duration_minutes || null,
                display_order,
                is_free,
                is_published
            ]
        );

        const newLecture = await queryOne(
            'SELECT * FROM lectures WHERE id = ?',
            [result.insertId]
        );

        console.log('[Lectures] Created lecture:', newLecture?.id);
        res.status(201).json(newLecture);
    } catch (error) {
        console.error('Create lecture error:', error);
        res.status(500).json({ error: 'Failed to create lecture' });
    }
});

// Update lecture
router.put('/:id', async (req: Request, res: Response) => {
    try {
        const {
            title,
            description,
            video_url,
            duration_minutes,
            display_order,
            is_free,
            is_published
        } = req.body;

        const result = await execute(
            `UPDATE lectures 
             SET title = COALESCE(?, title),
                 description = COALESCE(?, description),
                 video_url = COALESCE(?, video_url),
                 duration_minutes = COALESCE(?, duration_minutes),
                 display_order = COALESCE(?, display_order),
                 is_free = COALESCE(?, is_free),
                 is_published = COALESCE(?, is_published),
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = ?`,
            [
                title ?? null,
                description ?? null,
                video_url ?? null,
                duration_minutes ?? null,
                display_order ?? null,
                is_free ?? null,
                is_published ?? null,
                req.params.id
            ]
        );

        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Lecture not found' });
        }

        const updatedLecture = await queryOne(
            'SELECT * FROM lectures WHERE id = ?',
            [req.params.id]
        );

        res.json(updatedLecture);
    } catch (error) {
        console.error('Update lecture error:', error);
        res.status(500).json({ error: 'Failed to update lecture' });
    }
});

// Delete lecture (soft delete by unpublishing)
router.delete('/:id', async (req: Request, res: Response) => {
    try {
        const result = await execute(
            'UPDATE lectures SET is_published = FALSE WHERE id = ?',
            [req.params.id]
        );

        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Lecture not found' });
        }

        console.log('[Lectures] Deleted lecture:', req.params.id);
        res.json({ message: 'Lecture deleted successfully' });
    } catch (error) {
        console.error('Delete lecture error:', error);
        res.status(500).json({ error: 'Failed to delete lecture' });
    }
});

export default router;
