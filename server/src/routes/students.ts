import { Router, Request, Response } from 'express';
import { query, queryOne, execute } from '../db';

const router = Router();

// Get all students
router.get('/', async (req: Request, res: Response) => {
    try {
        const students = await query(
            'SELECT * FROM students WHERE is_active = TRUE ORDER BY name'
        );
        res.json(students);
    } catch (error) {
        console.error('Get students error:', error);
        res.status(500).json({ error: 'Failed to fetch students' });
    }
});

// Get student by ID
// Get student by email
router.get('/email/:email', async (req: Request, res: Response) => {
    try {
        const student = await queryOne(
            'SELECT * FROM students WHERE email = ? AND is_active = TRUE',
            [req.params.email]
        );

        if (!student) {
            return res.status(404).json({ error: 'Student not found' });
        }

        res.json(student);
    } catch (error) {
        console.error('Get student by email error:', error);
        res.status(500).json({ error: 'Failed to fetch student' });
    }
});

// Get student by phone
router.get('/phone/:phone', async (req: Request, res: Response) => {
    try {
        const student = await queryOne(
            'SELECT * FROM students WHERE phone = ? AND is_active = TRUE',
            [req.params.phone]
        );

        if (!student) {
            return res.status(404).json({ error: 'Student not found' });
        }

        res.json(student);
    } catch (error) {
        console.error('Get student by phone error:', error);
        res.status(500).json({ error: 'Failed to fetch student' });
    }
});

// Get student by ID
router.get('/:id', async (req: Request, res: Response) => {
    try {
        const student = await queryOne(
            'SELECT * FROM students WHERE id = ? AND is_active = TRUE',
            [req.params.id]
        );

        if (!student) {
            return res.status(404).json({ error: 'Student not found' });
        }

        res.json(student);
    } catch (error) {
        console.error('Get student error:', error);
        res.status(500).json({ error: 'Failed to fetch student' });
    }
});

// (moved email & phone handlers above to avoid route conflicts)

// Create new student
router.post('/', async (req: Request, res: Response) => {
    try {
        const { name, email, phone, grade, grade_id, group_id, is_offline = false, approval_status = 'approved' } = req.body;

        if (!name) {
            return res.status(400).json({ error: 'Student name is required' });
        }

        const result = await execute(
            `INSERT INTO students (name, email, phone, grade, grade_id, group_id, is_offline, approval_status) 
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [name, email || null, phone || null, grade || null, grade_id || null, group_id || null, is_offline, approval_status]
        );

        const newStudent = await queryOne(
            'SELECT * FROM students WHERE id = ?',
            [result.insertId]
        );

        res.status(201).json(newStudent);
    } catch (error) {
        console.error('Create student error:', error);
        res.status(500).json({ error: 'Failed to create student' });
    }
});

// Update student
router.put('/:id', async (req: Request, res: Response) => {
    try {
        const { name, email, phone, grade, grade_id, group_id, barcode } = req.body;

        // Build dynamic SQL for fields that are provided
        const updates: string[] = [];
        const params: any[] = [];

        if (name !== undefined) {
            updates.push('name = ?');
            params.push(name);
        }
        if (email !== undefined) {
            updates.push('email = ?');
            params.push(email);
        }
        if (phone !== undefined) {
            updates.push('phone = ?');
            params.push(phone);
        }
        if (grade !== undefined) {
            updates.push('grade = ?');
            params.push(grade);
        }
        if (grade_id !== undefined) {
            updates.push('grade_id = ?');
            params.push(grade_id);
        }
        if (group_id !== undefined) {
            updates.push('group_id = ?');
            params.push(group_id);
        }
        if (barcode !== undefined) {
            updates.push('barcode = ?');
            params.push(barcode);
        }

        if (updates.length === 0) {
            return res.status(400).json({ error: 'No fields to update' });
        }

        updates.push('updated_at = CURRENT_TIMESTAMP');
        params.push(req.params.id);

        const result = await execute(
            `UPDATE students SET ${updates.join(', ')} WHERE id = ?`,
            params
        );

        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Student not found' });
        }

        const updatedStudent = await queryOne(
            'SELECT * FROM students WHERE id = ?',
            [req.params.id]
        );

        res.json(updatedStudent);
    } catch (error) {
        console.error('Update student error:', error);
        res.status(500).json({ error: 'Failed to update student' });
    }
});

// Delete student (soft delete)
router.delete('/:id', async (req: Request, res: Response) => {
    try {
        const result = await execute(
            'UPDATE students SET is_active = FALSE WHERE id = ?',
            [req.params.id]
        );

        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Student not found' });
        }

        res.json({ message: 'Student deleted successfully' });
    } catch (error) {
        console.error('Delete student error:', error);
        res.status(500).json({ error: 'Failed to delete student' });
    }
});

export default router;
