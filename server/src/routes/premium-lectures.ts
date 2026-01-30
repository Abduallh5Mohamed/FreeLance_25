import { Router, Request, Response } from 'express';
import { query, queryOne, execute } from '../db';
import { v4 as uuidv4 } from 'uuid';
import multer from 'multer';
import path from 'path';
import fs from 'fs';

const router = Router();

// Configure multer for receipt image uploads
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const uploadDir = path.join(__dirname, '../../uploads/receipts');
        if (!fs.existsSync(uploadDir)) {
            fs.mkdirSync(uploadDir, { recursive: true });
        }
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, 'receipt-' + uniqueSuffix + path.extname(file.originalname));
    }
});

const upload = multer({
    storage,
    limits: { fileSize: 5 * 1024 * 1024 }, // 5MB max
    fileFilter: (req, file, cb) => {
        const allowedTypes = /jpeg|jpg|png|gif|webp/;
        const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
        const mimetype = allowedTypes.test(file.mimetype);
        if (extname && mimetype) {
            return cb(null, true);
        }
        cb(new Error('يُسمح فقط بالصور (jpeg, jpg, png, gif, webp)'));
    }
});

// ===============================
// PREMIUM LECTURES MANAGEMENT
// ===============================

// Get all premium lectures (for teacher)
router.get('/', async (req: Request, res: Response) => {
    try {
        const { grade_id, group_id } = req.query;
        
        let sql = `
            SELECT 
                pl.*,
                gr.name as grade_name,
                g.name as group_name,
                (SELECT COUNT(*) FROM premium_lecture_access WHERE premium_lecture_id = pl.id) as enrolled_count,
                (SELECT COUNT(*) FROM premium_lecture_payments WHERE premium_lecture_id = pl.id AND status = 'pending') as pending_payments
            FROM premium_lectures pl
            LEFT JOIN grades gr ON pl.grade_id = gr.id
            LEFT JOIN \`groups\` g ON pl.group_id = g.id
            WHERE 1=1
        `;
        const params: string[] = [];

        if (grade_id && typeof grade_id === 'string') {
            sql += ' AND pl.grade_id = ?';
            params.push(grade_id);
        }

        if (group_id && typeof group_id === 'string') {
            sql += ' AND pl.group_id = ?';
            params.push(group_id);
        }

        sql += ' ORDER BY pl.created_at DESC';

        const lectures = await query(sql, params);
        res.json(lectures || []);
    } catch (error) {
        console.error('Get premium lectures error:', error);
        res.status(500).json({ error: 'فشل في جلب الحصص المدفوعة' });
    }
});

// Get single premium lecture
router.get('/:id', async (req: Request, res: Response) => {
    try {
        const { id } = req.params;
        const lecture = await queryOne(`
            SELECT 
                pl.*,
                gr.name as grade_name,
                g.name as group_name
            FROM premium_lectures pl
            LEFT JOIN grades gr ON pl.grade_id = gr.id
            LEFT JOIN \`groups\` g ON pl.group_id = g.id
            WHERE pl.id = ?
        `, [id]);

        if (!lecture) {
            return res.status(404).json({ error: 'الحصة غير موجودة' });
        }

        res.json(lecture);
    } catch (error) {
        console.error('Get premium lecture error:', error);
        res.status(500).json({ error: 'فشل في جلب بيانات الحصة' });
    }
});

// Create premium lecture
router.post('/', async (req: Request, res: Response) => {
    try {
        const { title, description, video_url, thumbnail_url, duration_minutes, price, grade_id, group_id, is_published, created_by } = req.body;

        if (!title || !video_url || price === undefined) {
            return res.status(400).json({ error: 'العنوان ورابط الفيديو والسعر مطلوبين' });
        }

        const id = uuidv4();
        await execute(`
            INSERT INTO premium_lectures (id, title, description, video_url, thumbnail_url, duration_minutes, price, grade_id, group_id, is_published, created_by)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [id, title, description || null, video_url, thumbnail_url || null, duration_minutes || 0, price, grade_id || null, group_id || null, is_published ? 1 : 0, created_by || null]);

        const newLecture = await queryOne('SELECT * FROM premium_lectures WHERE id = ?', [id]);
        res.status(201).json(newLecture);
    } catch (error) {
        console.error('Create premium lecture error:', error);
        res.status(500).json({ error: 'فشل في إنشاء الحصة المدفوعة' });
    }
});

// Update premium lecture
router.put('/:id', async (req: Request, res: Response) => {
    try {
        const { id } = req.params;
        const { title, description, video_url, thumbnail_url, duration_minutes, price, grade_id, group_id, is_published } = req.body;

        await execute(`
            UPDATE premium_lectures 
            SET title = ?, description = ?, video_url = ?, thumbnail_url = ?, duration_minutes = ?, price = ?, grade_id = ?, group_id = ?, is_published = ?
            WHERE id = ?
        `, [title, description || null, video_url, thumbnail_url || null, duration_minutes || 0, price, grade_id || null, group_id || null, is_published ? 1 : 0, id]);

        const updatedLecture = await queryOne('SELECT * FROM premium_lectures WHERE id = ?', [id]);
        res.json(updatedLecture);
    } catch (error) {
        console.error('Update premium lecture error:', error);
        res.status(500).json({ error: 'فشل في تحديث الحصة المدفوعة' });
    }
});

// Delete premium lecture
router.delete('/:id', async (req: Request, res: Response) => {
    try {
        const { id } = req.params;
        await execute('DELETE FROM premium_lectures WHERE id = ?', [id]);
        res.json({ success: true, message: 'تم حذف الحصة بنجاح' });
    } catch (error) {
        console.error('Delete premium lecture error:', error);
        res.status(500).json({ error: 'فشل في حذف الحصة المدفوعة' });
    }
});

// ===============================
// STUDENT PREMIUM LECTURES
// ===============================

// Get available premium lectures for a student
router.get('/student/:studentId/available', async (req: Request, res: Response) => {
    try {
        const { studentId } = req.params;

        // Get student's grade and group
        const student = await queryOne('SELECT id, grade_id, group_id FROM students WHERE id = ?', [studentId]);
        
        if (!student) {
            return res.status(404).json({ error: 'الطالب غير موجود' });
        }

        // Get all published premium lectures for student's grade/group
        const sql = `
            SELECT 
                pl.*,
                gr.name as grade_name,
                g.name as group_name,
                pla.id as access_id,
                plp.id as payment_id,
                plp.status as payment_status
            FROM premium_lectures pl
            LEFT JOIN grades gr ON pl.grade_id = gr.id
            LEFT JOIN \`groups\` g ON pl.group_id = g.id
            LEFT JOIN premium_lecture_access pla ON pla.premium_lecture_id = pl.id AND pla.student_id = ?
            LEFT JOIN premium_lecture_payments plp ON plp.premium_lecture_id = pl.id AND plp.student_id = ? 
                AND plp.status IN ('pending', 'approved')
            WHERE pl.is_published = TRUE
            AND (pl.grade_id IS NULL OR pl.grade_id = ?)
            AND (pl.group_id IS NULL OR pl.group_id = ?)
            ORDER BY pl.created_at DESC
        `;

        const lectures = await query(sql, [studentId, studentId, student.grade_id, student.group_id]);
        res.json(lectures || []);
    } catch (error) {
        console.error('Get student premium lectures error:', error);
        res.status(500).json({ error: 'فشل في جلب الحصص المدفوعة' });
    }
});

// Get student's purchased/accessible premium lectures
router.get('/student/:studentId/purchased', async (req: Request, res: Response) => {
    try {
        const { studentId } = req.params;

        const sql = `
            SELECT 
                pl.*,
                gr.name as grade_name,
                g.name as group_name,
                pla.granted_at
            FROM premium_lecture_access pla
            JOIN premium_lectures pl ON pla.premium_lecture_id = pl.id
            LEFT JOIN grades gr ON pl.grade_id = gr.id
            LEFT JOIN \`groups\` g ON pl.group_id = g.id
            WHERE pla.student_id = ?
            ORDER BY pla.granted_at DESC
        `;

        const lectures = await query(sql, [studentId]);
        res.json(lectures || []);
    } catch (error) {
        console.error('Get purchased lectures error:', error);
        res.status(500).json({ error: 'فشل في جلب الحصص المشتراة' });
    }
});

// ===============================
// PAYMENT REQUESTS
// ===============================

// Submit payment request with receipt image
router.post('/payments', upload.single('receipt'), async (req: Request, res: Response) => {
    try {
        const { student_id, premium_lecture_id, amount, notes } = req.body;

        if (!student_id || !premium_lecture_id || !req.file) {
            return res.status(400).json({ error: 'معرف الطالب والحصة وصورة الإيصال مطلوبين' });
        }

        // Check if student already has access or pending payment
        const existingPayment = await queryOne(`
            SELECT id, status FROM premium_lecture_payments 
            WHERE student_id = ? AND premium_lecture_id = ? AND status IN ('pending', 'approved')
        `, [student_id, premium_lecture_id]);

        if (existingPayment) {
            if (existingPayment.status === 'approved') {
                return res.status(400).json({ error: 'لديك وصول مسبق لهذه الحصة' });
            }
            return res.status(400).json({ error: 'لديك طلب دفع قيد المراجعة' });
        }

        const id = uuidv4();
        const receiptUrl = `/uploads/receipts/${req.file.filename}`;

        await execute(`
            INSERT INTO premium_lecture_payments (id, student_id, premium_lecture_id, receipt_image_url, amount, notes, status)
            VALUES (?, ?, ?, ?, ?, ?, 'pending')
        `, [id, student_id, premium_lecture_id, receiptUrl, amount || 0, notes || null]);

        const newPayment = await queryOne('SELECT * FROM premium_lecture_payments WHERE id = ?', [id]);
        res.status(201).json(newPayment);
    } catch (error) {
        console.error('Submit payment error:', error);
        res.status(500).json({ error: 'فشل في إرسال طلب الدفع' });
    }
});

// Get student's payment requests
router.get('/payments/student/:studentId', async (req: Request, res: Response) => {
    try {
        const { studentId } = req.params;

        const sql = `
            SELECT 
                plp.*,
                pl.title as lecture_title,
                pl.price as lecture_price
            FROM premium_lecture_payments plp
            JOIN premium_lectures pl ON plp.premium_lecture_id = pl.id
            WHERE plp.student_id = ?
            ORDER BY plp.created_at DESC
        `;

        const payments = await query(sql, [studentId]);
        res.json(payments || []);
    } catch (error) {
        console.error('Get student payments error:', error);
        res.status(500).json({ error: 'فشل في جلب طلبات الدفع' });
    }
});

// Get all pending payment requests (for teacher)
router.get('/payments/pending', async (req: Request, res: Response) => {
    try {
        const sql = `
            SELECT 
                plp.*,
                pl.title as lecture_title,
                pl.price as lecture_price,
                s.name as student_name,
                s.phone as student_phone,
                gr.name as grade_name,
                g.name as group_name
            FROM premium_lecture_payments plp
            JOIN premium_lectures pl ON plp.premium_lecture_id = pl.id
            JOIN students s ON plp.student_id = s.id
            LEFT JOIN grades gr ON s.grade_id = gr.id
            LEFT JOIN \`groups\` g ON s.group_id = g.id
            WHERE plp.status = 'pending'
            ORDER BY plp.created_at ASC
        `;

        const payments = await query(sql);
        res.json(payments || []);
    } catch (error) {
        console.error('Get pending payments error:', error);
        res.status(500).json({ error: 'فشل في جلب طلبات الدفع المعلقة' });
    }
});

// Get all payment requests (for teacher)
router.get('/payments', async (req: Request, res: Response) => {
    try {
        const { status, lecture_id } = req.query;

        let sql = `
            SELECT 
                plp.*,
                pl.title as lecture_title,
                pl.price as lecture_price,
                s.name as student_name,
                s.phone as student_phone,
                gr.name as grade_name,
                g.name as group_name
            FROM premium_lecture_payments plp
            JOIN premium_lectures pl ON plp.premium_lecture_id = pl.id
            JOIN students s ON plp.student_id = s.id
            LEFT JOIN grades gr ON s.grade_id = gr.id
            LEFT JOIN \`groups\` g ON s.group_id = g.id
            WHERE 1=1
        `;
        const params: string[] = [];

        if (status && typeof status === 'string') {
            sql += ' AND plp.status = ?';
            params.push(status);
        }

        if (lecture_id && typeof lecture_id === 'string') {
            sql += ' AND plp.premium_lecture_id = ?';
            params.push(lecture_id);
        }

        sql += ' ORDER BY plp.created_at DESC';

        const payments = await query(sql, params);
        res.json(payments || []);
    } catch (error) {
        console.error('Get all payments error:', error);
        res.status(500).json({ error: 'فشل في جلب طلبات الدفع' });
    }
});

// Approve payment request
router.post('/payments/:id/approve', async (req: Request, res: Response) => {
    try {
        const { id } = req.params;
        const { reviewed_by } = req.body;

        const payment = await queryOne('SELECT * FROM premium_lecture_payments WHERE id = ?', [id]);
        
        if (!payment) {
            return res.status(404).json({ error: 'طلب الدفع غير موجود' });
        }

        if (payment.status !== 'pending') {
            return res.status(400).json({ error: 'تم مراجعة هذا الطلب مسبقاً' });
        }

        // Update payment status
        await execute(`
            UPDATE premium_lecture_payments 
            SET status = 'approved', reviewed_by = ?, reviewed_at = NOW()
            WHERE id = ?
        `, [reviewed_by || null, id]);

        // Grant access to the lecture
        const accessId = uuidv4();
        await execute(`
            INSERT INTO premium_lecture_access (id, student_id, premium_lecture_id, payment_id)
            VALUES (?, ?, ?, ?)
        `, [accessId, payment.student_id, payment.premium_lecture_id, id]);

        res.json({ success: true, message: 'تمت الموافقة على طلب الدفع وتم منح الوصول للحصة' });
    } catch (error) {
        console.error('Approve payment error:', error);
        res.status(500).json({ error: 'فشل في الموافقة على طلب الدفع' });
    }
});

// Reject payment request
router.post('/payments/:id/reject', async (req: Request, res: Response) => {
    try {
        const { id } = req.params;
        const { reviewed_by, rejection_reason } = req.body;

        const payment = await queryOne('SELECT * FROM premium_lecture_payments WHERE id = ?', [id]);
        
        if (!payment) {
            return res.status(404).json({ error: 'طلب الدفع غير موجود' });
        }

        if (payment.status !== 'pending') {
            return res.status(400).json({ error: 'تم مراجعة هذا الطلب مسبقاً' });
        }

        await execute(`
            UPDATE premium_lecture_payments 
            SET status = 'rejected', reviewed_by = ?, reviewed_at = NOW(), rejection_reason = ?
            WHERE id = ?
        `, [reviewed_by || null, rejection_reason || null, id]);

        res.json({ success: true, message: 'تم رفض طلب الدفع' });
    } catch (error) {
        console.error('Reject payment error:', error);
        res.status(500).json({ error: 'فشل في رفض طلب الدفع' });
    }
});

// ===============================
// ACCESS CHECK
// ===============================

// Check if student has access to a premium lecture
router.get('/access/check/:studentId/:lectureId', async (req: Request, res: Response) => {
    try {
        const { studentId, lectureId } = req.params;

        const access = await queryOne(`
            SELECT * FROM premium_lecture_access 
            WHERE student_id = ? AND premium_lecture_id = ?
        `, [studentId, lectureId]);

        res.json({ hasAccess: !!access, access });
    } catch (error) {
        console.error('Check access error:', error);
        res.status(500).json({ error: 'فشل في التحقق من الوصول' });
    }
});

export default router;
