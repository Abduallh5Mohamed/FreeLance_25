import { Router, Request, Response } from 'express';
import { query, queryOne, execute } from '../db';

const router = Router();

interface Fee {
    id: string;
    student_name: string;
    phone?: string;
    grade_id?: string;
    grade_name?: string;
    group_id?: string;
    group_name?: string;
    barcode?: string;
    amount: number;
    paid_amount: number;
    status: string;
    payment_method?: string;
    is_offline: boolean;
    notes?: string;
    due_date?: string;
    payment_date?: string;
    receipt_image_url?: string;
}

// Get all fees
router.get('/', async (req: Request, res: Response) => {
    try {
        const { is_offline, status } = req.query;
        
        let sql = 'SELECT * FROM student_fees WHERE 1=1';
        const params: any[] = [];
        
        if (is_offline !== undefined) {
            sql += ' AND is_offline = ?';
            params.push(is_offline === 'true');
        }
        
        if (status) {
            sql += ' AND status = ?';
            params.push(status);
        }
        
        sql += ' ORDER BY created_at DESC';
        
        const fees = await query<Fee>(sql, params);
        res.json(fees);
    } catch (error) {
        console.error('Get fees error:', error);
        res.status(500).json({ error: 'Failed to fetch fees' });
    }
});

// Get fee by ID
router.get('/:id', async (req: Request, res: Response) => {
    try {
        const fee = await queryOne<Fee>(
            'SELECT * FROM student_fees WHERE id = ?',
            [req.params.id]
        );

        if (!fee) {
            return res.status(404).json({ error: 'Fee not found' });
        }

        res.json(fee);
    } catch (error) {
        console.error('Get fee error:', error);
        res.status(500).json({ error: 'Failed to fetch fee' });
    }
});

// Create new fee
router.post('/', async (req: Request, res: Response) => {
    try {
        const {
            student_name,
            phone,
            grade_id,
            grade_name,
            group_id,
            group_name,
            barcode,
            amount,
            paid_amount,
            status,
            payment_method,
            is_offline,
            notes,
            due_date,
            payment_date,
            receipt_image_url
        } = req.body;

        if (!student_name) {
            return res.status(400).json({ error: 'Student name is required' });
        }

        const result = await execute(
            `INSERT INTO student_fees (
                student_name, phone, grade_id, grade_name, group_id, group_name,
                barcode, amount, paid_amount, status, payment_method, is_offline,
                notes, due_date, payment_date, receipt_image_url
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                student_name,
                phone || null,
                grade_id || null,
                grade_name || null,
                group_id || null,
                group_name || null,
                barcode || null,
                amount || 0,
                paid_amount || 0,
                status || 'pending',
                payment_method || 'cash',
                is_offline || false,
                notes || null,
                due_date || null,
                payment_date || null,
                receipt_image_url || null
            ]
        );

        const newFee = await queryOne<Fee>(
            'SELECT * FROM student_fees WHERE id = ?',
            [result.insertId]
        );

        res.status(201).json(newFee);
    } catch (error) {
        console.error('Create fee error:', error);
        res.status(500).json({ error: 'Failed to create fee' });
    }
});

// Update fee
router.put('/:id', async (req: Request, res: Response) => {
    try {
        const { id } = req.params;
        const {
            student_name,
            phone,
            grade_id,
            grade_name,
            group_id,
            group_name,
            amount,
            paid_amount,
            status,
            payment_method,
            notes,
            due_date,
            payment_date,
            receipt_image_url
        } = req.body;

        await execute(
            `UPDATE student_fees SET
                student_name = COALESCE(?, student_name),
                phone = COALESCE(?, phone),
                grade_id = COALESCE(?, grade_id),
                grade_name = COALESCE(?, grade_name),
                group_id = COALESCE(?, group_id),
                group_name = COALESCE(?, group_name),
                amount = COALESCE(?, amount),
                paid_amount = COALESCE(?, paid_amount),
                status = COALESCE(?, status),
                payment_method = COALESCE(?, payment_method),
                notes = COALESCE(?, notes),
                due_date = COALESCE(?, due_date),
                payment_date = COALESCE(?, payment_date),
                receipt_image_url = COALESCE(?, receipt_image_url),
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ?`,
            [
                student_name || null,
                phone || null,
                grade_id || null,
                grade_name || null,
                group_id || null,
                group_name || null,
                amount || null,
                paid_amount || null,
                status || null,
                payment_method || null,
                notes || null,
                due_date || null,
                payment_date || null,
                receipt_image_url || null,
                id
            ]
        );

        const updatedFee = await queryOne<Fee>(
            'SELECT * FROM student_fees WHERE id = ?',
            [id]
        );

        res.json(updatedFee);
    } catch (error) {
        console.error('Update fee error:', error);
        res.status(500).json({ error: 'Failed to update fee' });
    }
});

// Delete fee
router.delete('/:id', async (req: Request, res: Response) => {
    try {
        const result = await execute(
            'DELETE FROM student_fees WHERE id = ?',
            [req.params.id]
        );

        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Fee not found' });
        }

        res.json({ message: 'Fee deleted successfully' });
    } catch (error) {
        console.error('Delete fee error:', error);
        res.status(500).json({ error: 'Failed to delete fee' });
    }
});

export default router;
