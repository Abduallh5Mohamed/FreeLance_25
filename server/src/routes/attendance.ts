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

        let sql = `
            SELECT 
                a.id,
                a.student_id,
                a.course_id,
                COALESCE(a.group_id, s.group_id) as group_id,
                a.attendance_date,
                a.attendance_time,
                a.status,
                a.notes,
                a.marked_by,
                a.method,
                a.created_at,
                s.name as student_name,
                s.barcode as student_barcode
            FROM attendance a
            LEFT JOIN students s ON a.student_id = s.id
            WHERE 1=1
        `;
        const params: any[] = [];

        if (date) {
            sql += ' AND DATE(a.attendance_date) = ?';
            params.push(date);
        }
        if (student_id) {
            sql += ' AND a.student_id = ?';
            params.push(student_id);
        }
        if (group_id) {
            sql += ' AND a.group_id = ?';
            params.push(group_id);
        }
        if (course_id) {
            sql += ' AND a.course_id = ?';
            params.push(course_id);
        }

        sql += ' ORDER BY a.attendance_date DESC, a.created_at DESC';

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
        const { barcode, student_id, attendance_date, status = 'present', course_id, group_id, notes } = req.body;

        const normalizedDate = attendance_date ? new Date(attendance_date) : new Date();
        if (Number.isNaN(normalizedDate.getTime())) {
            return res.status(400).json({ error: 'Invalid attendance_date' });
        }

        let studentId = student_id as string | undefined;
        let resolvedGroupId = group_id as string | undefined;

        if (!studentId && !barcode) {
            return res.status(400).json({ error: 'barcode or student_id is required' });
        }

        if (barcode) {
            const student = await queryOne(
                `SELECT id, group_id FROM students WHERE barcode = ? AND is_active = TRUE`,
                [barcode]
            );

            if (!student) {
                return res.status(404).json({ error: 'Student not found for provided barcode' });
            }

            studentId = student.id;
            resolvedGroupId = student.group_id ?? resolvedGroupId;
        }

        if (!studentId) {
            return res.status(400).json({ error: 'Student not resolved' });
        }

        const dateStr = normalizedDate.toISOString().split('T')[0];

        const existing = await queryOne(
            `SELECT id FROM attendance WHERE student_id = ? AND DATE(attendance_date) = ?`,
            [studentId, dateStr]
        );

        if (existing) {
            return res.status(409).json({ error: 'Attendance already recorded for this student on the selected date' });
        }

        await execute(
            `INSERT INTO attendance (id, student_id, course_id, group_id, attendance_date, attendance_time, status, notes, method, created_at)
             VALUES (UUID(), ?, ?, ?, ?, CURTIME(), ?, ?, 'barcode', NOW())`,
            [studentId, course_id ?? null, resolvedGroupId ?? null, dateStr, status, notes ?? null]
        );

        const newAttendance = await queryOne(
            `SELECT a.*, s.name AS student_name, s.group_id AS student_group_id
             FROM attendance a
             LEFT JOIN students s ON a.student_id = s.id
             WHERE a.student_id = ? AND DATE(a.attendance_date) = ?
             ORDER BY a.created_at DESC
             LIMIT 1`,
            [studentId, dateStr]
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
