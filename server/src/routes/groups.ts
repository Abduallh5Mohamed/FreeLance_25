import { Router, Request, Response } from 'express';
import { randomUUID } from 'crypto';
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
        const { name, description, max_students, is_active = true, grade_id } = req.body;
        let course_id = (req.body && req.body.course_id) ?? null;

        // New: schedule fields
        let schedule_days = (req.body && (req.body.schedule_days ?? null)) as any;
        const schedule_time = (req.body && (req.body.schedule_time ?? null)) as string | null;

        if (!name) {
            return res.status(400).json({ error: 'Group name is required' });
        }

        // Normalize incoming course_id: accept empty string or undefined as null
        if (course_id === '' || course_id === undefined) {
            course_id = null;
        } else {
            // verify course exists; if not, null it to avoid FK failure
            const courseExists = await queryOne('SELECT id FROM courses WHERE id = ?', [course_id]);
            if (!courseExists) {
                console.warn(`Create group: provided course_id ${course_id} not found, setting to NULL`);
                course_id = null;
            }
        }

        // Handle grade_id
        let finalGradeId = grade_id || null;
        if (finalGradeId === '' || finalGradeId === undefined) {
            finalGradeId = null;
        }

        // Normalize schedule_days to JSON string or null
        if (Array.isArray(schedule_days)) {
            schedule_days = JSON.stringify(schedule_days);
        } else if (typeof schedule_days === 'string') {
            // if it's already a JSON array string, keep as is; otherwise wrap single day to array
            try {
                const parsed = JSON.parse(schedule_days);
                if (Array.isArray(parsed)) {
                    schedule_days = JSON.stringify(parsed);
                } else {
                    schedule_days = JSON.stringify([schedule_days]);
                }
            } catch {
                schedule_days = JSON.stringify([schedule_days]);
            }
        } else if (schedule_days == null) {
            schedule_days = null;
        }

        // groups.id is CHAR(36) (UUID) in schema. Generate id client-side for reliable fetch.
        const newId = randomUUID();
        await execute(
            'INSERT INTO `groups` (id, name, description, course_id, grade_id, max_students, is_active, schedule_days, schedule_time) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [newId, name, description || null, course_id, finalGradeId, max_students || 30, is_active, schedule_days, schedule_time ?? null]
        );

        const newGroup = await queryOne<Group>(
            'SELECT * FROM `groups` WHERE id = ?',
            [newId]
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
        const { name, description, max_students, is_active, grade_id } = req.body;
        let course_id = (req.body && req.body.course_id) ?? null;
        let schedule_days = (req.body && (req.body.schedule_days ?? null)) as any;
        const schedule_time = (req.body && (req.body.schedule_time ?? null)) as string | null;

        // Normalize course_id: treat empty string or undefined as null
        if (course_id === '' || course_id === undefined) {
            course_id = null;
        } else {
            // If provided, ensure the referenced course actually exists. If not, set to null to avoid FK errors.
            const courseExists = await queryOne('SELECT id FROM courses WHERE id = ?', [course_id]);
            if (!courseExists) {
                console.warn(`Update group: provided course_id ${course_id} not found, setting to NULL`);
                course_id = null;
            }
        }

        // Handle grade_id
        let finalGradeId = grade_id;
        if (finalGradeId === '' || finalGradeId === undefined) {
            finalGradeId = null;
        }

        // Normalize schedule_days
        if (Array.isArray(schedule_days)) {
            schedule_days = JSON.stringify(schedule_days);
        } else if (typeof schedule_days === 'string') {
            try {
                const parsed = JSON.parse(schedule_days);
                schedule_days = Array.isArray(parsed) ? JSON.stringify(parsed) : JSON.stringify([schedule_days]);
            } catch {
                schedule_days = JSON.stringify([schedule_days]);
            }
        } else if (schedule_days === undefined) {
            schedule_days = null; // COALESCE will keep existing if null is passed
        }

        const result = await execute(
            `UPDATE \`groups\` 
             SET name = COALESCE(?, name),
                 description = COALESCE(?, description),
                 course_id = COALESCE(?, course_id),
                 grade_id = COALESCE(?, grade_id),
                 max_students = COALESCE(?, max_students),
                 is_active = COALESCE(?, is_active),
                 schedule_days = COALESCE(?, schedule_days),
                 schedule_time = COALESCE(?, schedule_time),
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = ?`,
            [
                name ?? null,
                description ?? null,
                course_id ?? null,
                finalGradeId ?? null,
                max_students ?? null,
                is_active ?? null,
                schedule_days ?? null,
                schedule_time ?? null,
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

// Delete group (hard delete - permanent deletion from database)
router.delete('/:id', async (req: Request, res: Response) => {
    try {
        const result = await execute(
            'DELETE FROM `groups` WHERE id = ?',
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
