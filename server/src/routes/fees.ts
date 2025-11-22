import { Router, Request, Response } from 'express';
import { query, queryOne, execute } from '../db';

const DATABASE_NAME = process.env.DB_NAME || 'freelance';
let feesSchemaEnsured = false;

const ensureFeesSchema = async () => {
    if (feesSchemaEnsured) {
        return;
    }

    await execute(`
        CREATE TABLE IF NOT EXISTS student_fees (
            id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
            student_id CHAR(36),
            student_name VARCHAR(255) NOT NULL,
            phone VARCHAR(50),
            guardian_phone VARCHAR(50),
            grade_id CHAR(36),
            grade_name VARCHAR(255),
            group_id CHAR(36),
            group_name VARCHAR(255),
            barcode VARCHAR(50),
            amount DECIMAL(10, 2) DEFAULT 0,
            paid_amount DECIMAL(10, 2) DEFAULT 0,
            remaining_amount DECIMAL(10, 2) GENERATED ALWAYS AS (amount - paid_amount) STORED,
            status ENUM('pending', 'partial', 'paid', 'overdue') DEFAULT 'pending',
            payment_method ENUM('cash', 'bank', 'card', 'online') DEFAULT 'cash',
            is_offline BOOLEAN DEFAULT FALSE,
            notes TEXT,
            due_date DATE,
            payment_date DATE,
            payment_year INT,
            payment_month INT,
            receipt_image_url TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            INDEX idx_student_id (student_id),
            INDEX idx_student_name (student_name),
            INDEX idx_phone (phone),
            INDEX idx_guardian_phone (guardian_phone),
            INDEX idx_status (status),
            INDEX idx_is_offline (is_offline),
            INDEX idx_payment_date (payment_date),
            INDEX idx_payment_year_month (payment_year, payment_month),
            UNIQUE KEY unique_student_month (student_id, payment_year, payment_month)
        ) ENGINE=InnoDB;
    `);

    // Ensure optional columns exist when table was previously created with a limited schema
    const requiredColumns: Record<string, string> = {
        student_id: 'ADD COLUMN student_id CHAR(36) NULL',
        student_name: 'ADD COLUMN student_name VARCHAR(255) NULL',
        phone: 'ADD COLUMN phone VARCHAR(50) NULL',
        guardian_phone: 'ADD COLUMN guardian_phone VARCHAR(50) NULL',
        grade_id: 'ADD COLUMN grade_id CHAR(36) NULL',
        grade_name: 'ADD COLUMN grade_name VARCHAR(255) NULL',
        group_id: 'ADD COLUMN group_id CHAR(36) NULL',
        group_name: 'ADD COLUMN group_name VARCHAR(255) NULL',
        barcode: 'ADD COLUMN barcode VARCHAR(50) NULL',
        amount: 'ADD COLUMN amount DECIMAL(10, 2) DEFAULT 0',
        paid_amount: 'ADD COLUMN paid_amount DECIMAL(10, 2) DEFAULT 0',
        remaining_amount: 'ADD COLUMN remaining_amount DECIMAL(10, 2) GENERATED ALWAYS AS (amount - paid_amount) STORED',
        status: "ADD COLUMN status ENUM('pending', 'partial', 'paid', 'overdue') DEFAULT 'pending'",
        payment_method: "ADD COLUMN payment_method ENUM('cash', 'bank', 'card', 'online') DEFAULT 'cash'",
        is_offline: 'ADD COLUMN is_offline BOOLEAN DEFAULT FALSE',
        notes: 'ADD COLUMN notes TEXT NULL',
        due_date: 'ADD COLUMN due_date DATE NULL',
        payment_date: 'ADD COLUMN payment_date DATE NULL',
        payment_year: 'ADD COLUMN payment_year INT NULL',
        payment_month: 'ADD COLUMN payment_month INT NULL',
        receipt_image_url: 'ADD COLUMN receipt_image_url TEXT NULL',
        created_at: 'ADD COLUMN created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP',
        updated_at: 'ADD COLUMN updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP'
    };

    for (const [column, alterStmt] of Object.entries(requiredColumns)) {
        const columnExists = await queryOne<{ COLUMN_NAME: string }>(
            `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'student_fees' AND COLUMN_NAME = ?`,
            [DATABASE_NAME, column]
        );

        if (!columnExists) {
            await execute(`ALTER TABLE student_fees ${alterStmt}`);
        }
    }

    // Backfill payment_year and payment_month from payment_date for existing records
    await execute(`
        UPDATE student_fees 
        SET payment_year = YEAR(payment_date),
            payment_month = MONTH(payment_date)
        WHERE payment_date IS NOT NULL 
          AND (payment_year IS NULL OR payment_month IS NULL)
    `);

    // Ensure unique index exists
    const indexExists = await queryOne<{ INDEX_NAME: string }>(
        `SELECT INDEX_NAME FROM INFORMATION_SCHEMA.STATISTICS 
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'student_fees' AND INDEX_NAME = 'unique_student_month'`,
        [DATABASE_NAME]
    );

    if (!indexExists) {
        try {
            await execute(`
                ALTER TABLE student_fees 
                ADD UNIQUE KEY unique_student_month (student_id, payment_year, payment_month)
            `);
        } catch (err: any) {
            // Ignore duplicate key error if index already exists
            if (err.code !== 'ER_DUP_KEYNAME') {
                console.error('Error creating unique index:', err);
            }
        }
    }

    feesSchemaEnsured = true;
};

const router = Router();

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
router.get('/', async (req: Request, res: Response) => {
    try {
        await ensureFeesSchema();
        const { is_offline, status, phone, name } = req.query;

        let sql = `SELECT * FROM student_fees WHERE 1=1`;
        const params: unknown[] = [];

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
        await ensureFeesSchema();
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
                 WHERE s.barcode = ?`,
                [barcode]
            );
        }

        if (!linkedStudent && phone) {
            linkedStudent = await queryOne(
                `SELECT s.*, g.name AS grade_name, grp.name AS group_name
                 FROM students s
                 LEFT JOIN grades g ON s.grade_id = g.id
                 LEFT JOIN \`groups\` grp ON s.group_id = grp.id
                 WHERE s.phone = ?`,
                [phone]
            );
        }

        if (!linkedStudent && student_name) {
            linkedStudent = await queryOne(
                `SELECT s.*, g.name AS grade_name, grp.name AS group_name
                 FROM students s
                 LEFT JOIN grades g ON s.grade_id = g.id
                 LEFT JOIN \`groups\` grp ON s.group_id = grp.id
                 WHERE s.name LIKE ?
                 ORDER BY CHAR_LENGTH(s.name) ASC
                 LIMIT 1`,
                [`%${student_name}%`]
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
                 WHERE student_id = ? AND payment_year = ? AND payment_month = ? AND status = 'paid'`,
                [resolvedStudentId, finalPaymentYear, finalPaymentMonth]
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
                student_id, student_name, phone, guardian_phone, grade_id, grade_name, group_id, group_name,
                barcode, amount, paid_amount, status, payment_method, is_offline,
                notes, due_date, payment_date, payment_year, payment_month, receipt_image_url
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
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
                'SELECT * FROM student_fees WHERE id = ?',
                [result.insertId]
            );
        }

        if (!newFee) {
            newFee = await queryOne<Fee>(
                `SELECT * FROM student_fees
                 WHERE barcode = ?
                 ORDER BY created_at DESC
                 LIMIT 1`,
                [resolvedBarcode]
            );
        }

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
            WHERE id = ?`,
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
