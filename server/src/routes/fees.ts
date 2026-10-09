import { Router, Request, Response } from 'express';
import { AuthRequest, authenticateToken, requireRoles } from '../middleware/auth';
import { query, queryOne, execute } from '../db';

const router = Router();
router.use(authenticateToken, requireRoles('admin', 'instructor', 'teacher', 'staff'));
const tenantFilter = (req: AuthRequest) => req.user?.role === 'admin' ? '' : ' AND tenant_id=?';
const tenantParam = (req: AuthRequest) => req.user?.role === 'admin' ? [] : [req.user?.tenantId || ''];

interface Fee {
    id: string;
    student_id?: string;
    student_name: string;
    phone?: string;
    guardian_phone?: string;
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
    payment_year?: number;
    payment_month?: number;
    receipt_image_url?: string;
}

// Get all fees
router.get('/', async (req: AuthRequest, res: Response) => {
    try {
        const { is_offline, status, phone, name } = req.query;

        let sql = `SELECT * FROM student_fees WHERE 1=1${tenantFilter(req)}`;
        const params: unknown[] = tenantParam(req);

        if (is_offline !== undefined) {
            sql += ' AND is_offline = ?';
            params.push(is_offline === 'true');
        }

        if (status) {
            sql += ' AND status = ?';
            params.push(status);
        }

        if (phone) {
            sql += ' AND phone = ?';
            params.push(phone);
        }

        if (name) {
            sql += ' AND student_name LIKE ?';
            params.push(`%${name}%`);
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
router.get('/:id', async (req: AuthRequest, res: Response) => {
    try {
        const fee = await queryOne<Fee>(
            `SELECT * FROM student_fees WHERE id = ?${tenantFilter(req)}`,
            [req.params.id, ...tenantParam(req)]
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
router.post('/', async (req: AuthRequest, res: Response) => {
    try {
        const {
            student_name,
            phone,
            guardian_phone,
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
            payment_year,
            payment_month,
            receipt_image_url
        } = req.body;

        const tenantId = req.user?.tenantId;
        if (!tenantId) return res.status(403).json({ error: 'Active tenant membership required' });
        if (!student_name && !phone && !barcode) {
            return res.status(400).json({ error: 'Student information is required' });
        }

        let linkedStudent = null;

        if (barcode) {
            linkedStudent = await queryOne(
                `SELECT s.*, g.name AS grade_name, grp.name AS group_name
                 FROM students s
                 LEFT JOIN grades g ON s.grade_id = g.id
                 LEFT JOIN \`groups\` grp ON s.group_id = grp.id
                 WHERE s.barcode = ? AND s.tenant_id=?`,
                [barcode, tenantId]
            );
        }

        if (!linkedStudent && phone) {
            linkedStudent = await queryOne(
                `SELECT s.*, g.name AS grade_name, grp.name AS group_name
                 FROM students s
                 LEFT JOIN grades g ON s.grade_id = g.id
                 LEFT JOIN \`groups\` grp ON s.group_id = grp.id
                 WHERE s.phone = ? AND s.tenant_id=?`,
                [phone, tenantId]
            );
        }

        if (!linkedStudent && student_name) {
            linkedStudent = await queryOne(
                `SELECT s.*, g.name AS grade_name, grp.name AS group_name
                 FROM students s
                 LEFT JOIN grades g ON s.grade_id = g.id
                 LEFT JOIN \`groups\` grp ON s.group_id = grp.id
                 WHERE s.name LIKE ? AND s.tenant_id=?
                 ORDER BY CHAR_LENGTH(s.name) ASC
                 LIMIT 1`,
                [`%${student_name}%`, tenantId]
            );
        }

        // For offline students, allow direct creation without requiring student in database
        const resolvedStudentId = linkedStudent?.id || null;
        const resolvedStudentName = linkedStudent?.name || student_name;
        const resolvedPhone = linkedStudent?.phone || phone;
        const resolvedGuardianPhone = linkedStudent?.guardian_phone || guardian_phone;
        const resolvedGradeId = linkedStudent?.grade_id || grade_id;
        const resolvedGradeName = linkedStudent?.grade_name || grade_name;
        const resolvedGroupId = linkedStudent?.group_id || group_id;
        const resolvedGroupName = linkedStudent?.group_name || group_name;
        const resolvedBarcode = linkedStudent?.barcode || barcode;

        // Determine payment year and month
        const paymentDateObj = payment_date ? new Date(payment_date) : new Date();
        const finalPaymentYear = payment_year || paymentDateObj.getFullYear();
        const finalPaymentMonth = payment_month || (paymentDateObj.getMonth() + 1);

        // Check if student already paid for this month (only if student_id exists)
        if (resolvedStudentId) {
            const existingPayment = await queryOne<Fee>(
                `SELECT * FROM student_fees
                 WHERE student_id = ? AND tenant_id=? AND payment_year = ? AND payment_month = ? AND status = 'paid'`,
                [resolvedStudentId, tenantId, finalPaymentYear, finalPaymentMonth]
            );

            if (existingPayment) {
                return res.status(400).json({
                    error: 'تم الدفع مسبقاً',
                    message: `الطالب ${resolvedStudentName} قام بالدفع بالفعل لشهر ${finalPaymentMonth}/${finalPaymentYear}`,
                    existing_payment: existingPayment
                });
            }
        }

        const result = await execute(
            `INSERT INTO student_fees (
                tenant_id, student_id, student_name, phone, guardian_phone, grade_id, grade_name, group_id, group_name,
                barcode, amount, paid_amount, status, payment_method, is_offline,
                notes, due_date, payment_date, payment_year, payment_month, receipt_image_url
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                tenantId,
                resolvedStudentId,
                resolvedStudentName,
                resolvedPhone || null,
                resolvedGuardianPhone || null,
                resolvedGradeId || null,
                resolvedGradeName || null,
                resolvedGroupId || null,
                resolvedGroupName || null,
                resolvedBarcode || null,
                amount || 0,
                paid_amount || 0,
                status || 'paid',
                payment_method || 'cash',
                is_offline ?? true,
                notes || null,
                due_date || new Date().toISOString().split('T')[0],
                payment_date || new Date().toISOString().split('T')[0],
                finalPaymentYear,
                finalPaymentMonth,
                receipt_image_url || null
            ]
        );

        let newFee: Fee | null = null;

        if (result.insertId) {
            newFee = await queryOne<Fee>(
                `SELECT * FROM student_fees WHERE id = ?${tenantFilter(req)}`,
                [result.insertId, ...tenantParam(req)]
            );
        }

        if (!newFee) {
            newFee = await queryOne<Fee>(
                `SELECT * FROM student_fees
                 WHERE barcode = ? AND tenant_id=?
                 ORDER BY created_at DESC
                 LIMIT 1`,
                [resolvedBarcode, tenantId]
            );
        }

        res.status(201).json(newFee);
    } catch (error) {
        console.error('Create fee error:', error);
        res.status(500).json({ error: 'Failed to create fee' });
    }
});

// Update fee
router.put('/:id', async (req: AuthRequest, res: Response) => {
    try {
        const { id } = req.params;
        const {
            student_id,
            student_name,
            phone,
            guardian_phone,
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
            payment_year,
            payment_month,
            receipt_image_url
        } = req.body;

        if (student_id && req.user?.role !== 'admin') {
            const ownedStudent = await queryOne('SELECT id FROM students WHERE id=? AND tenant_id=?', [student_id, req.user?.tenantId]);
            if (!ownedStudent) return res.status(404).json({ error: 'Student not found in your tenant' });
        }

        // If payment_date is updated, recalculate year/month
        let finalPaymentYear = payment_year;
        let finalPaymentMonth = payment_month;
        if (payment_date && (!payment_year || !payment_month)) {
            const paymentDateObj = new Date(payment_date);
            finalPaymentYear = paymentDateObj.getFullYear();
            finalPaymentMonth = paymentDateObj.getMonth() + 1;
        }

        await execute(
            `UPDATE student_fees SET
                student_id = COALESCE(?, student_id),
                student_name = COALESCE(?, student_name),
                phone = COALESCE(?, phone),
                guardian_phone = COALESCE(?, guardian_phone),
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
                payment_year = COALESCE(?, payment_year),
                payment_month = COALESCE(?, payment_month),
                receipt_image_url = COALESCE(?, receipt_image_url),
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ?${tenantFilter(req)}`,
            [
                student_id || null,
                student_name || null,
                phone || null,
                guardian_phone || null,
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
                finalPaymentYear || null,
                finalPaymentMonth || null,
                receipt_image_url || null,
                id,
                ...tenantParam(req)
            ]
        );

        const updatedFee = await queryOne<Fee>(
            `SELECT * FROM student_fees WHERE id = ?${tenantFilter(req)}`,
            [id, ...tenantParam(req)]
        );

        res.json(updatedFee);
    } catch (error) {
        console.error('Update fee error:', error);
        res.status(500).json({ error: 'Failed to update fee' });
    }
});

// Delete fee
router.delete('/:id', async (req: AuthRequest, res: Response) => {
    try {
        const result = await execute(
            `DELETE FROM student_fees WHERE id = ?${tenantFilter(req)}`,
            [req.params.id, ...tenantParam(req)]
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
