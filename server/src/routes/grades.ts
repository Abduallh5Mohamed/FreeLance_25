import { Router, Request, Response } from 'express';
import { query, queryOne, execute } from '../db';

const router = Router();

// Get all grades
router.get('/', async (req: Request, res: Response) => {
    try {
        const grades = await query(
            'SELECT * FROM grades WHERE is_active = TRUE ORDER BY display_order'
        );
        res.json(grades);
    } catch (error) {
        console.error('Get grades error:', error);
        res.status(500).json({ error: 'Failed to fetch grades' });
    }
});

// Get grade by ID
router.get('/:id', async (req: Request, res: Response) => {
    try {
        const grade = await queryOne(
            'SELECT * FROM grades WHERE id = ? AND is_active = TRUE',
            [req.params.id]
        );

        if (!grade) {
            return res.status(404).json({ error: 'Grade not found' });
        }

        res.json(grade);
    } catch (error) {
        console.error('Get grade error:', error);
        res.status(500).json({ error: 'Failed to fetch grade' });
    }
});

// Create new grade
router.post('/', async (req: Request, res: Response) => {
    try {
        const { name, display_order } = req.body;

        if (!name) {
            return res.status(400).json({ error: 'Name is required' });
        }

        const result = await execute(
            'INSERT INTO grades (name, display_order) VALUES (?, ?)',
            [name, display_order || 0]
        );

        const newGrade = await queryOne(
            'SELECT * FROM grades WHERE id = ?',
            [result.insertId]
        );

        res.status(201).json(newGrade);
    } catch (error) {
        console.error('Create grade error:', error);
        res.status(500).json({ error: 'Failed to create grade' });
    }
});

// Update grade
router.put('/:id', async (req: Request, res: Response) => {
    try {
        const { name, display_order } = req.body;
        const { id } = req.params;

        await execute(
            'UPDATE grades SET name = ?, display_order = ? WHERE id = ?',
            [name, display_order, id]
        );

        const updatedGrade = await queryOne(
            'SELECT * FROM grades WHERE id = ?',
            [id]
        );

        res.json(updatedGrade);
    } catch (error) {
        console.error('Update grade error:', error);
        res.status(500).json({ error: 'Failed to update grade' });
    }
});

// Delete grade (soft delete)
router.delete('/:id', async (req: Request, res: Response) => {
    try {
        const { id } = req.params;

        await execute(
            'UPDATE grades SET is_active = FALSE WHERE id = ?',
            [id]
        );

        res.json({ message: 'Grade deleted successfully' });
    } catch (error) {
        console.error('Delete grade error:', error);
        res.status(500).json({ error: 'Failed to delete grade' });
    }
});

export default router;
