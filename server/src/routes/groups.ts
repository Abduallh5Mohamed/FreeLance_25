import { Router, Request, Response } from 'express';
import { query, queryOne, execute } from '../db';

const router = Router();

interface Group {
    id: string;
    name: string;
    description?: string;
    course_id?: string;
    max_students?: number;
    current_students?: number;
    is_active: boolean;
}

// Get all groups
router.get('/', async (req: Request, res: Response) => {
    try {
        const groups = await query<Group>(
            'SELECT * FROM `groups` WHERE is_active = TRUE ORDER BY name'
        );
        res.json(groups);
    } catch (error) {
        console.error('Get groups error:', error);
        res.status(500).json({ error: 'Failed to fetch groups' });
    }
});

// Get group by ID
router.get('/:id', async (req: Request, res: Response) => {
    try {
        const group = await queryOne<Group>(
            'SELECT * FROM `groups` WHERE id = ? AND is_active = TRUE',
            [req.params.id]
        );

        if (!group) {
            return res.status(404).json({ error: 'Group not found' });
        }

        res.json(group);
    } catch (error) {
        console.error('Get group error:', error);
        res.status(500).json({ error: 'Failed to fetch group' });
    }
});

// Create new group
router.post('/', async (req: Request, res: Response) => {
    try {
        const { name, description, course_id, max_students, is_active = true } = req.body;

        if (!name) {
            return res.status(400).json({ error: 'Group name is required' });
        }

        // Set course_id to NULL to avoid foreign key constraint errors
        // Groups will be linked to grades instead of courses
        const result = await execute(
            'INSERT INTO `groups` (name, description, course_id, max_students, is_active) VALUES (?, ?, NULL, ?, ?)',
            [name, description || null, max_students || 30, is_active]
        );

        const newGroup = await queryOne<Group>(
            'SELECT * FROM `groups` WHERE id = ?',
            [result.insertId]
        );

        res.status(201).json(newGroup);
    } catch (error) {
        console.error('Create group error:', error);
        res.status(500).json({ error: 'Failed to create group' });
    }
});

// Update group
router.put('/:id', async (req: Request, res: Response) => {
    try {
        const { name, description, course_id, max_students, is_active } = req.body;

        const result = await execute(
            `UPDATE \`groups\` 
             SET name = COALESCE(?, name),
                 description = COALESCE(?, description),
                 course_id = COALESCE(?, course_id),
                 max_students = COALESCE(?, max_students),
                 is_active = COALESCE(?, is_active),
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = ?`,
            [
                name ?? null,
                description ?? null,
                course_id ?? null,
                max_students ?? null,
                is_active ?? null,
                req.params.id
            ]
        );

        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Group not found' });
        }

        const updatedGroup = await queryOne<Group>(
            'SELECT * FROM `groups` WHERE id = ?',
            [req.params.id]
        );

        res.json(updatedGroup);
    } catch (error) {
        console.error('Update group error:', error);
        res.status(500).json({ error: 'Failed to update group' });
    }
});

// Delete group (soft delete)
router.delete('/:id', async (req: Request, res: Response) => {
    try {
        const result = await execute(
            'UPDATE `groups` SET is_active = FALSE WHERE id = ?',
            [req.params.id]
        );

        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Group not found' });
        }

        res.json({ message: 'Group deleted successfully' });
    } catch (error) {
        console.error('Delete group error:', error);
        res.status(500).json({ error: 'Failed to delete group' });
    }
});

export default router;
