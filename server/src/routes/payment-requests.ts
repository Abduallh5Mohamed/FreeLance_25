import { Router, Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { getPool, execute, query } from '../db';

const router = Router();

interface PaymentRequestRow {
    id: string;
    student_name: string;
    phone: string;
    grade_id: string | null;
    grade_name: string | null;
    group_id: string | null;
    group_name: string | null;
    amount: number;
    notes: string | null;
    receipt_image_url: string | null;
    status: 'pending' | 'approved' | 'rejected';
    created_at: string;
    updated_at: string;
}

interface PaymentRequestResponse {
    id: string;
    studentName: string;
    phone: string;
    gradeId: string | null;
    gradeName: string | null;
    groupId: string | null;
    groupName: string | null;
    amount: number;
    notes: string | null;
    receiptImageUrl: string | null;
    status: 'pending' | 'approved' | 'rejected';
    createdAt: string;
    updatedAt: string;
}

const mapPaymentRequest = (row: PaymentRequestRow): PaymentRequestResponse => ({
    id: row.id,
    studentName: row.student_name,
    phone: row.phone,
    gradeId: row.grade_id,
    gradeName: row.grade_name,
    groupId: row.group_id,
    groupName: row.group_name,
    amount: Number(row.amount || 0),
    notes: row.notes,
    receiptImageUrl: row.receipt_image_url,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
});

router.get('/', async (req: Request, res: Response) => {
    try {
        const { status } = req.query;
        let sql = 'SELECT * FROM payment_requests';
        const params: unknown[] = [];

        if (status) {
            sql += ' WHERE status = ?';
            params.push(status);
        }

        sql += ' ORDER BY created_at DESC';

        const rows = await query<PaymentRequestRow>(sql, params);
        res.json(rows.map(mapPaymentRequest));
    } catch (error) {
        console.error('Get payment requests error:', error);
        res.status(500).json({ error: 'Failed to fetch payment requests' });
    }
});

router.post('/', async (req: Request, res: Response) => {
    try {
        const {
            student_name,
            phone,
            grade_id,
            grade_name,
            group_id,
            group_name,
            amount,
            notes,
            receipt_image_url,
        } = req.body;

        if (!student_name || !phone || !amount) {
            return res.status(400).json({ error: 'Student name, phone, and amount are required' });
        }

        const id = randomUUID();
        await execute(
            `INSERT INTO payment_requests (
                id, student_name, phone, grade_id, grade_name, group_id, group_name,
                amount, notes, receipt_image_url, status
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
            [
                id,
                student_name,
                phone,
                grade_id || null,
                grade_name || null,
                group_id || null,
                group_name || null,
                Number(amount) || 0,
                notes || null,
                receipt_image_url || null,
            ]
        );

        const rows = await query<PaymentRequestRow>('SELECT * FROM payment_requests WHERE id = ?', [id]);
        const paymentRequest = rows[0];

        res.status(201).json(mapPaymentRequest(paymentRequest));
    } catch (error) {
        console.error('Create payment request error:', error);
        res.status(500).json({ error: 'Failed to create payment request' });
    }
});

router.post('/:id/approve', async (req: Request, res: Response) => {
    const pool = getPool();
    const connection = await pool.getConnection();

    try {
        await connection.beginTransaction();

        const [requestRows] = await connection.query<PaymentRequestRow[]>(
            'SELECT * FROM payment_requests WHERE id = ? FOR UPDATE',
            [req.params.id]
        );

        if (requestRows.length === 0) {
            await connection.rollback();
            return res.status(404).json({ error: 'Payment request not found' });
        }

        const request = requestRows[0];

        if (request.status !== 'pending') {
            await connection.rollback();
            return res.status(400).json({ error: 'Only pending requests can be approved' });
        }

        const feeId = randomUUID();
        const today = new Date().toISOString().split('T')[0];

        await connection.query(
            `INSERT INTO student_fees (
                id, student_name, phone, grade_id, grade_name, group_id, group_name,
                amount, paid_amount, status, payment_method, is_offline, notes, payment_date, receipt_image_url
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'paid', 'online', FALSE, ?, ?, ?)` ,
            [
                feeId,
                request.student_name,
                request.phone,
                request.grade_id,
                request.grade_name,
                request.group_id,
                request.group_name,
                Number(request.amount) || 0,
                Number(request.amount) || 0,
                request.notes,
                today,
                request.receipt_image_url,
            ]
        );

        await connection.query(
            'UPDATE payment_requests SET status = ?, updated_at = NOW() WHERE id = ?',
            ['approved', req.params.id]
        );

        await connection.commit();

        res.json({
            message: 'Payment request approved and recorded in fees',
            paymentRequest: mapPaymentRequest({ ...request, status: 'approved' }),
        });
    } catch (error) {
        await connection.rollback();
        console.error('Approve payment request error:', error);
        res.status(500).json({ error: 'Failed to approve payment request' });
    } finally {
        connection.release();
    }
});

router.post('/:id/reject', async (req: Request, res: Response) => {
    try {
        const result = await execute(
            'UPDATE payment_requests SET status = ?, updated_at = NOW() WHERE id = ? AND status = \'pending\'',
            ['rejected', req.params.id]
        );

        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Pending payment request not found' });
        }

        res.json({ message: 'Payment request rejected' });
    } catch (error) {
        console.error('Reject payment request error:', error);
        res.status(500).json({ error: 'Failed to reject payment request' });
    }
});

export default router;
