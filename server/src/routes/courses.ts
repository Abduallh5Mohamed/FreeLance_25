import { Router, Request, Response } from 'express';
import { query, queryOne, execute } from '../db';

const router = Router();

// Get all courses
router.get('/', async (req: Request, res: Response) => {
    try {
        const courses = await query(
            'SELECT * FROM courses WHERE is_active = TRUE ORDER BY name'
        );
        res.json(courses);
    } catch (error) {
        console.error('Get courses error:', error);
        res.status(500).json({ error: 'Failed to fetch courses' });
    }
});

// Get course by ID
router.get('/:id', async (req: Request, res: Response) => {
    try {
        const course = await queryOne(
            'SELECT * FROM courses WHERE id = ? AND is_active = TRUE',
            [req.params.id]
        );

        if (!course) {
            return res.status(404).json({ error: 'Course not found' });
        }

        res.json(course);
    } catch (error) {
        console.error('Get course error:', error);
        res.status(500).json({ error: 'Failed to fetch course' });
    }
});

// Create new course
router.post('/', async (req: Request, res: Response) => {
    try {
        const { name, subject, description, grade, price = 0 } = req.body;

        if (!name) {
            return res.status(400).json({ error: 'Course name is required' });
        }

        const result = await execute(
            'INSERT INTO courses (name, subject, description, grade, price) VALUES (?, ?, ?, ?, ?)',
            [name, subject || null, description || null, grade || null, price]
        );

        const newCourse = await queryOne(
            'SELECT * FROM courses WHERE id = ?',
            [result.insertId]
        );

        res.status(201).json(newCourse);
    } catch (error) {
        console.error('Create course error:', error);
        res.status(500).json({ error: 'Failed to create course' });
    }
});

export default router;
