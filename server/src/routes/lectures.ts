import { Router, Request, Response } from 'express';
import { query, queryOne, execute } from '../db';

const router = Router();

interface Lecture {
    id: string;
    course_id: string;
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
}

// Get all lectures (published by default)
router.get('/', async (req: Request, res: Response) => {
    try {
        const { course_id } = req.query;

        let sql = `
            SELECT 
                l.*,
                c.name as course_name,
                c.subject as course_subject
            FROM lectures l
            LEFT JOIN courses c ON l.course_id = c.id
            WHERE l.is_published = TRUE
        `;
        const params: string[] = [];

        if (course_id && typeof course_id === 'string') {
            sql += ' AND l.course_id = ?';
            params.push(course_id);
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

// Get lecture by ID
router.get('/:id', async (req: Request, res: Response) => {
    try {
        const lecture = await queryOne(
            `SELECT 
                l.*,
                c.name as course_name,
                c.subject as course_subject
            FROM lectures l
            LEFT JOIN courses c ON l.course_id = c.id
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

        console.log('[Lectures] Creating lecture:', { course_id, title, video_url });

        const result = await execute(
            `INSERT INTO lectures 
            (course_id, title, description, video_url, duration_minutes, display_order, is_free, is_published) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                course_id,
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
