import { Router, Request, Response } from 'express';
import { query, queryOne, execute } from '../db';

const router = Router();

interface Attendance {
    id: string;
    student_id: string;
    course_id?: string;
    group_id?: string;
    attendance_date: Date;
    status: 'present' | 'absent' | 'late' | 'excused';
    notes?: string;
    created_at: Date;
}

// Get all attendance records
router.get('/', async (req: Request, res: Response) => {
    try {
        const { date, student_id, group_id, course_id } = req.query;

        let sql = 'SELECT * FROM attendance WHERE 1=1';
        const params: any[] = [];

        if (date) {
            sql += ' AND DATE(attendance_date) = ?';
            params.push(date);
        }
        if (student_id) {
            sql += ' AND student_id = ?';
            params.push(student_id);
        }
        if (group_id) {
            sql += ' AND group_id = ?';
            params.push(group_id);
        }
        if (course_id) {
            sql += ' AND course_id = ?';
            params.push(course_id);
        }

        sql += ' ORDER BY attendance_date DESC';

        const attendance = await query<Attendance>(sql, params);
        res.json(attendance);
    } catch (error) {
        console.error('Get attendance error:', error);
        res.status(500).json({ error: 'Failed to fetch attendance records' });
    }
});

// Get attendance by ID
router.get('/:id', async (req: Request, res: Response) => {
    try {
        const attendance = await queryOne<Attendance>(
            'SELECT * FROM attendance WHERE id = ?',
            [req.params.id]
        );

        if (!attendance) {
            return res.status(404).json({ error: 'Attendance record not found' });
        }

        res.json(attendance);
    } catch (error) {
        console.error('Get attendance by ID error:', error);
        res.status(500).json({ error: 'Failed to fetch attendance record' });
    }
});

// Mark attendance
router.post('/', async (req: Request, res: Response) => {
    try {
        const { student_id, course_id, group_id, attendance_date, status, notes } = req.body;

        if (!student_id || !attendance_date || !status) {
            return res.status(400).json({ error: 'Missing required fields' });
        }

        const result = await execute(
            `INSERT INTO attendance (id, student_id, course_id, group_id, attendance_date, status, notes, created_at)
             VALUES (UUID(), ?, ?, ?, ?, ?, ?, NOW())`,
            [student_id, course_id ?? null, group_id ?? null, attendance_date, status, notes ?? null]
        );

        const newAttendance = await queryOne<Attendance>(
            'SELECT * FROM attendance WHERE id = (SELECT id FROM attendance ORDER BY created_at DESC LIMIT 1)'
        );

        res.status(201).json(newAttendance);
    } catch (error) {
        console.error('Mark attendance error:', error);
        res.status(500).json({ error: 'Failed to mark attendance' });
    }
});

// Update attendance
router.put('/:id', async (req: Request, res: Response) => {
    try {
        const { status, notes, attendance_date } = req.body;

        const result = await execute(
            `UPDATE attendance 
             SET status = COALESCE(?, status),
                 notes = COALESCE(?, notes),
                 attendance_date = COALESCE(?, attendance_date)
             WHERE id = ?`,
            [status ?? null, notes ?? null, attendance_date ?? null, req.params.id]
        );

        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Attendance record not found' });
        }

        const updatedAttendance = await queryOne<Attendance>(
            'SELECT * FROM attendance WHERE id = ?',
            [req.params.id]
        );

        res.json(updatedAttendance);
    } catch (error) {
        console.error('Update attendance error:', error);
        res.status(500).json({ error: 'Failed to update attendance' });
    }
});

// Delete attendance
router.delete('/:id', async (req: Request, res: Response) => {
    try {
        const result = await execute(
            'DELETE FROM attendance WHERE id = ?',
            [req.params.id]
        );

        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Attendance record not found' });
        }

        res.json({ message: 'Attendance record deleted successfully' });
    } catch (error) {
        console.error('Delete attendance error:', error);
        res.status(500).json({ error: 'Failed to delete attendance record' });
    }
});

export default router;
