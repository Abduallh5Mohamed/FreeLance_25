import { Router, Request, Response, RequestHandler } from 'express';
import { v4 as uuidv4 } from 'uuid';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { AuthRequest, authenticateToken } from '../middleware/auth';
import { isSuperAdmin, getAdminPermissions } from '../security/admin-permissions';
import {
    getResourceBranchDeps,
    principalFromAuthUser,
    resolveResourceBranchAccess,
    resourceBranchDenial,
    type ResourceBranchDeps,
} from '../security/resource-branch';

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
// ACCESS POLICY
// ===============================

/**
 * Platform capability key for cross-tenant premium-lecture administration.
 * Verified against the migrations: admin_role_permissions seeds no
 * premium.* key, so the verified-active-super_admin check is the effective
 * policy today; deny-by-default for every non-owner identity.
 */
const PLATFORM_ADMIN_PERMISSION = 'premium.manage';

/** Instructor/tenant ownership of a lecture (group instructor owns the tenant). */
const LECTURE_OWNERSHIP_SQL = `
    SELECT pl.id
    FROM premium_lectures pl
    INNER JOIN \`groups\` g ON g.id = pl.group_id
    INNER JOIN tenants t ON t.owner_user_id = g.instructor_id
    WHERE pl.id = ? AND t.owner_user_id = ? AND t.status = 'active'
`;

/** Instructor/tenant ownership of a student (through the student's group). */
const STUDENT_OWNERSHIP_SQL = `
    SELECT s.id
    FROM students s
    INNER JOIN \`groups\` g ON g.id = s.group_id
    INNER JOIN tenants t ON t.owner_user_id = g.instructor_id
    WHERE s.id = ? AND t.owner_user_id = ? AND t.status = 'active'
`;

/** Scopes a premium_lectures row (aliased `pl`) to the calling instructor's tenant. */
const TEACHER_LECTURE_SCOPE_SQL = `
    EXISTS (
        SELECT 1
        FROM \`groups\` gg
        INNER JOIN tenants tt ON tt.owner_user_id = gg.instructor_id
        WHERE gg.id = pl.group_id AND tt.owner_user_id = ? AND tt.status = 'active'
    )
`;

interface PaymentRow {
    id: string;
    student_id: string;
    premium_lecture_id: string;
    status: 'pending' | 'approved' | 'rejected';
}

interface LectureRow {
    id: string;
    title: string;
    is_published: number;
}

interface StudentRow {
    id: string;
    grade_id: string | null;
    group_id: string | null;
}

export interface PremiumLectureRouterDeps {
    query: <T = any>(sql: string, params?: any[]) => Promise<T[]>;
    queryOne: <T = any>(sql: string, params?: any[]) => Promise<T | null>;
    execute: (sql: string, params?: any[]) => Promise<{ insertId: number; affectedRows: number }>;
    authenticate: RequestHandler;
    /**
     * Run `work` inside a single database transaction. The payment-approve
     * flow's status flip and access grant commit or roll back together; the
     * guarded flip (WHERE status='pending') means exactly one concurrent
     * approval can win.
     */
    withTransaction?: <T>(
        work: (tx: Pick<PremiumLectureRouterDeps, 'query' | 'queryOne' | 'execute'>) => Promise<T>,
    ) => Promise<T>;
    /**
     * Verified platform capability resolved server-side (active super_admin
     * or a seeded permission key). It never consults a JWT role claim, so an
     * arbitrary admin-role token cannot approve payments or read other
     * tenants' lectures.
     */
    hasPlatformCapability: (userId: string, permission: string) => Promise<boolean>;
    /** Resource-derived branch authority; defaults to the production SQL deps. */
    branchAccess?: ResourceBranchDeps;
}

/**
 * Money crosses the API as integer minor units or a decimal string with at
 * most two fraction digits; MySQL DECIMAL(10,2) does the arithmetic. Native
 * floats are accepted only when decimal-safe (finite, >= 0, <= 2dp).
 */
const DECIMAL_RE = /^(?:0|[1-9]\d{0,9})(?:\.\d{1,2})?$/;
export const toDecimalMoney = (value: unknown): string | null => {
    if (typeof value === 'string') {
        const trimmed = value.trim();
        return DECIMAL_RE.test(trimmed) ? trimmed : null;
    }
    if (typeof value === 'number') {
        if (!Number.isFinite(value) || value < 0) return null;
        const rounded = Math.round(value * 100) / 100;
        if (Math.abs(value - rounded) > 1e-9) return null;
        return rounded.toFixed(2);
    }
    return null;
};

/**
 * Build the premium-lectures router over injected dependencies. Production
 * wiring (default export) passes the lazily loaded pool, the production auth
 * middleware, and the verified platform-capability check; hermetic tests pass
 * isolated fixtures and exercise the real handlers without a database.
 */
export const createPremiumLectureRouter = (deps: PremiumLectureRouterDeps) => {
    const router = Router();

    const withTransaction = deps.withTransaction ?? (async <T>(work: (tx: Pick<PremiumLectureRouterDeps, 'query' | 'queryOne' | 'execute'>) => Promise<T>): Promise<T> =>
        work({ query: deps.query, queryOne: deps.queryOne, execute: deps.execute }));

    const hasPlatformAdmin = async (userId: string): Promise<boolean> =>
        deps.hasPlatformCapability(userId, PLATFORM_ADMIN_PERMISSION);

    const ownsLecture = async (lectureId: string, userId: string): Promise<boolean> =>
        !!(await deps.queryOne(LECTURE_OWNERSHIP_SQL, [lectureId, userId]));

    /** Owner instructor of the lecture, or a verified platform admin. */
    const canManageLecture = async (
        user: NonNullable<AuthRequest['user']>,
        lectureId: string,
    ): Promise<boolean> => {
        if (await hasPlatformAdmin(user.id)) return true;
        return ownsLecture(lectureId, user.id);
    };

    /** The student themself, their owning instructor, or a platform admin. */
    const canViewStudent = async (
        user: NonNullable<AuthRequest['user']>,
        studentId: string,
    ): Promise<boolean> => {
        if (await hasPlatformAdmin(user.id)) return true;
        if (user.studentEnrollmentId === studentId) return true;
        return !!(await deps.queryOne(STUDENT_OWNERSHIP_SQL, [studentId, user.id]));
    };

    const isStudentOnly = (user: NonNullable<AuthRequest['user']>): boolean =>
        user.role === 'student' && !user.instructorId && !user.tenantId;

    /**
     * Resource-derived branch check for a premium lecture. Its branch comes
     * from premium_lectures.group_id -> groups; the caller selector is never
     * authority.
     */
    const enforcePremiumBranch = async (
        req: AuthRequest,
        res: Response,
        lectureId: string,
        requestedBranchId?: unknown,
    ): Promise<boolean> => {
        if (!req.user) {
            res.status(401).json({ error: 'Authentication required' });
            return false;
        }
        const decision = await resolveResourceBranchAccess(
            deps.branchAccess ?? getResourceBranchDeps(),
            principalFromAuthUser(req.user),
            { resourceType: 'premium_lecture', resourceId: lectureId, requestedBranchId },
        );
        if (decision.kind !== 'allowed') {
            const denial = resourceBranchDenial(decision);
            res.status(denial.status).json(denial.body);
            return false;
        }
        return true;
    };

    /** Validate the target group's branch before create/move. */
    const validatePremiumGroupBranch = async (
        user: NonNullable<AuthRequest['user']>,
        groupId: unknown,
    ): Promise<{ ok: true } | { ok: false; status: number; error: string }> => {
        if (groupId === undefined || groupId === null || groupId === '') return { ok: true };
        if (typeof groupId !== 'string') return { ok: false, status: 400, error: 'Invalid group' };
        const group = await deps.queryOne<{ id: string; branch_id: string | null; branch_scope: string | null }>(
            'SELECT id, branch_id, branch_scope FROM `groups` WHERE id = ?', [groupId],
        );
        if (!group) return { ok: false, status: 404, error: 'Group not found' };
        if (group.branch_scope !== 'branch') return { ok: true };
        if (!group.branch_id) return { ok: false, status: 403, error: 'Branch context is ambiguous' };
        const tenantId = user.tenantId;
        if (!tenantId) return { ok: false, status: 403, error: 'Workspace access required' };
        const branch = await deps.queryOne<{ tenant_id: string; status: string }>(
            'SELECT tenant_id, status FROM branches WHERE id = ?', [group.branch_id],
        );
        if (!branch || branch.tenant_id !== tenantId || branch.status !== 'active') {
            return { ok: false, status: 403, error: 'Branch is outside your teaching scope' };
        }
        const owner = await deps.queryOne<{ id: string }>(
            "SELECT id FROM tenants WHERE id = ? AND owner_user_id = ? AND status = 'active'",
            [tenantId, user.id],
        );
        if (!owner) {
            const membership = await deps.queryOne<{ id: string }>(
                "SELECT id FROM branch_memberships WHERE branch_id = ? AND user_id = ? AND status = 'active'",
                [group.branch_id, user.id],
            );
            if (!membership) return { ok: false, status: 403, error: 'Branch membership required' };
        }
        return { ok: true };
    };

    // ===============================
    // PAYMENT REQUESTS (before /:id routes)
    // ===============================

    const paymentSelect = `
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
    `;

    // Get all pending payment requests (teacher: own lectures only; platform admin: all)
    router.get('/payments/pending', deps.authenticate, async (req: AuthRequest, res: Response) => {
        try {
            const user = req.user!;
            let sql = `${paymentSelect} WHERE plp.status = 'pending'`;
            const params: any[] = [];
            if (!(await hasPlatformAdmin(user.id))) {
                if (!user.instructorId) {
                    return res.status(403).json({ error: 'ليست لديك صلاحية لعرض طلبات الدفع' });
                }
                sql += ` AND ${TEACHER_LECTURE_SCOPE_SQL}`;
                params.push(user.id);
            }
            sql += ' ORDER BY plp.created_at ASC';

            const payments = await deps.query(sql, params);
            res.json(payments || []);
        } catch (error) {
            console.error('Get pending payments error:', error);
            res.status(500).json({ error: 'فشل في جلب طلبات الدفع المعلقة' });
        }
    });

    // Get student's payment requests (self, owning instructor, or platform admin)
    router.get('/payments/student/:studentId', deps.authenticate, async (req: AuthRequest, res: Response) => {
        try {
            const { studentId } = req.params;
            if (!(await canViewStudent(req.user!, studentId))) {
                return res.status(403).json({ error: 'ليست لديك صلاحية لعرض طلبات هذا الطالب' });
            }

            const payments = await deps.query(`
                SELECT
                    plp.*,
                    pl.title as lecture_title,
                    pl.price as lecture_price
                FROM premium_lecture_payments plp
                JOIN premium_lectures pl ON plp.premium_lecture_id = pl.id
                WHERE plp.student_id = ?
                ORDER BY plp.created_at DESC
            `, [studentId]);
            res.json(payments || []);
        } catch (error) {
            console.error('Get student payments error:', error);
            res.status(500).json({ error: 'فشل في جلب طلبات الدفع' });
        }
    });

    // Get all payment requests (teacher: own lectures only; platform admin: all)
    router.get('/payments', deps.authenticate, async (req: AuthRequest, res: Response) => {
        try {
            const user = req.user!;
            const { status, lecture_id } = req.query;

            let sql = `${paymentSelect} WHERE 1=1`;
            const params: any[] = [];

            if (status && typeof status === 'string') {
                sql += ' AND plp.status = ?';
                params.push(status);
            }

            if (lecture_id && typeof lecture_id === 'string') {
                sql += ' AND plp.premium_lecture_id = ?';
                params.push(lecture_id);
            }

            if (!(await hasPlatformAdmin(user.id))) {
                if (!user.instructorId) {
                    return res.status(403).json({ error: 'ليست لديك صلاحية لعرض طلبات الدفع' });
                }
                sql += ` AND ${TEACHER_LECTURE_SCOPE_SQL}`;
                params.push(user.id);
            }

            sql += ' ORDER BY plp.created_at DESC';

            const payments = await deps.query(sql, params);
            res.json(payments || []);
        } catch (error) {
            console.error('Get all payments error:', error);
            res.status(500).json({ error: 'فشل في جلب طلبات الدفع' });
        }
    });

    // Submit payment request with receipt image (student; lecture must be in the caller's tenant)
    router.post('/payments', deps.authenticate, upload.single('receipt'), async (req: AuthRequest, res: Response) => {
        try {
            const { premium_lecture_id, amount, notes } = req.body;
            const student_id = req.user!.studentEnrollmentId;
            const tenantId = req.user!.tenantId;

            if (!student_id || !tenantId || !premium_lecture_id || !req.file) {
                return res.status(400).json({ error: 'معرف الطالب والحصة وصورة الإيصال مطلوبين' });
            }

            const lecture = await deps.queryOne(
                `SELECT pl.id FROM premium_lectures pl
                 INNER JOIN \`groups\` g ON g.id=pl.group_id
                 INNER JOIN tenants t ON t.owner_user_id=g.instructor_id
                 WHERE pl.id=? AND t.id=? AND t.status='active'`, [premium_lecture_id, tenantId]
            );
            if (!lecture) return res.status(404).json({ error: 'الحصة غير موجودة في مساحتك' });
            if (!(await enforcePremiumBranch(req, res, premium_lecture_id))) return;

            if (amount !== undefined && amount !== null && amount !== '' && toDecimalMoney(amount) === null) {
                return res.status(400).json({ error: 'المبلغ يجب أن يكون موجبًا وبدقتين عشريتين كحد أقصى' });
            }

            // Check if student already has access or pending payment
            const existingPayment = await deps.queryOne(`
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
            const fileId = uuidv4();
            const receiptUrl = `/api/files/${fileId}/download`;
            await deps.execute(
                `INSERT INTO tenant_media_files (id,tenant_id,uploaded_by,storage_path,original_name,mime_type,byte_size)
                 VALUES (?,?,?,?,?,?,?)`,
                [fileId, tenantId, req.user!.id, path.relative(process.cwd(), req.file.path), req.file.originalname, req.file.mimetype, req.file.size]
            );

            await deps.execute(`
                INSERT INTO premium_lecture_payments (id, student_id, premium_lecture_id, receipt_image_url, amount, notes, status)
                VALUES (?, ?, ?, ?, ?, ?, 'pending')
            `, [id, student_id, premium_lecture_id, receiptUrl, toDecimalMoney(amount) ?? '0.00', notes || null]);

            const newPayment = await deps.queryOne('SELECT * FROM premium_lecture_payments WHERE id = ?', [id]);
            res.status(201).json(newPayment);
        } catch (error) {
            console.error('Submit payment error:', error);
            res.status(500).json({ error: 'فشل في إرسال طلب الدفع' });
        }
    });

    // Approve payment request (owning instructor or verified platform admin; reviewed_by is the verified identity)
    // Transactional + idempotent: the payment row is locked (FOR UPDATE),
    // the status flips conditionally (WHERE status='pending') so exactly one
    // concurrent approval wins, and the access grant commits in the same
    // transaction. A retry of an approved payment returns 400 and grants
    // nothing twice (unique_student_lecture + INSERT IGNORE).
    router.post('/payments/:id/approve', deps.authenticate, async (req: AuthRequest, res: Response) => {
        try {
            const { id } = req.params;

            const outcome = await withTransaction(async (tx) => {
                const payment = await tx.queryOne<PaymentRow>('SELECT * FROM premium_lecture_payments WHERE id = ? FOR UPDATE', [id]);

                if (!payment) {
                    return { status: 404 as const, body: { error: 'طلب الدفع غير موجود' } };
                }

                if (payment.status !== 'pending') {
                    return { status: 400 as const, body: { error: 'تم مراجعة هذا الطلب مسبقاً' } };
                }

                if (!(await canManageLecture(req.user!, payment.premium_lecture_id))) {
                    return { status: 403 as const, body: { error: 'ليست لديك صلاحية على هذه الحصة' } };
                }
                const branchDecision = await resolveResourceBranchAccess(
                    deps.branchAccess ?? getResourceBranchDeps(),
                    principalFromAuthUser(req.user!),
                    { resourceType: 'premium_lecture', resourceId: payment.premium_lecture_id },
                );
                if (branchDecision.kind !== 'allowed') {
                    return { status: 403 as const, body: { error: 'Forbidden' } };
                }

                // Guarded flip FIRST: the loser of a concurrent approval
                // affects zero rows and grants no access.
                const transition = await tx.execute(`
                    UPDATE premium_lecture_payments
                    SET status = 'approved', reviewed_by = ?, reviewed_at = NOW()
                    WHERE id = ? AND status = 'pending'
                `, [req.user!.id, id]);
                if (transition.affectedRows === 0) {
                    return { status: 400 as const, body: { error: 'تم مراجعة هذا الطلب مسبقاً' } };
                }

                // Grant access to the lecture (idempotent: the unique
                // (student_id, premium_lecture_id) key dedupes retries).
                const accessId = uuidv4();
                await tx.execute(`
                    INSERT IGNORE INTO premium_lecture_access (id, student_id, premium_lecture_id, payment_id)
                    VALUES (?, ?, ?, ?)
                `, [accessId, payment.student_id, payment.premium_lecture_id, id]);
                return { status: 200 as const, body: { success: true, message: 'تمت الموافقة على طلب الدفع وتم منح الوصول للحصة' } };
            });
            res.status(outcome.status === 200 ? 200 : outcome.status).json(outcome.body);
        } catch (error) {
            console.error('Approve payment error:', error);
            res.status(500).json({ error: 'فشل في الموافقة على طلب الدفع' });
        }
    });

    // Reject payment request (owning instructor or verified platform admin; reviewed_by is the verified identity)
    // Guarded transition: a concurrent rejection already consumed the flip if
    // this affects zero rows, and the retry returns 400 without side effects.
    router.post('/payments/:id/reject', deps.authenticate, async (req: AuthRequest, res: Response) => {
        try {
            const { id } = req.params;
            const { rejection_reason } = req.body;

            const payment = await deps.queryOne<PaymentRow>('SELECT * FROM premium_lecture_payments WHERE id = ?', [id]);

            if (!payment) {
                return res.status(404).json({ error: 'طلب الدفع غير موجود' });
            }

            if (payment.status !== 'pending') {
                return res.status(400).json({ error: 'تم مراجعة هذا الطلب مسبقاً' });
            }

            if (!(await canManageLecture(req.user!, payment.premium_lecture_id))) {
                return res.status(403).json({ error: 'ليست لديك صلاحية على هذه الحصة' });
            }
            if (!(await enforcePremiumBranch(req, res, payment.premium_lecture_id))) return;

            const transition = await deps.execute(`
                UPDATE premium_lecture_payments
                SET status = 'rejected', reviewed_by = ?, reviewed_at = NOW(), rejection_reason = ?
                WHERE id = ? AND status = 'pending'
            `, [req.user!.id, rejection_reason || null, id]);
            if (transition.affectedRows === 0) {
                return res.status(400).json({ error: 'تم مراجعة هذا الطلب مسبقاً' });
            }

            res.json({ success: true, message: 'تم رفض طلب الدفع' });
        } catch (error) {
            console.error('Reject payment error:', error);
            res.status(500).json({ error: 'فشل في رفض طلب الدفع' });
        }
    });

    // ===============================
    // STUDENT PREMIUM LECTURES
    // ===============================

    // Get available premium lectures for a student (self, owning instructor, or platform admin)
    router.get('/student/:studentId/available', deps.authenticate, async (req: AuthRequest, res: Response) => {
        try {
            const { studentId } = req.params;

            if (!(await canViewStudent(req.user!, studentId))) {
                return res.status(403).json({ error: 'ليست لديك صلاحية لعرض حصص هذا الطالب' });
            }

            const student = await deps.queryOne<StudentRow>('SELECT id, grade_id, group_id FROM students WHERE id = ?', [studentId]);

            if (!student) {
                return res.status(404).json({ error: 'الطالب غير موجود' });
            }

            const lectures = await deps.query(`
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
            `, [studentId, studentId, student.grade_id, student.group_id]);
            res.json(lectures || []);
        } catch (error) {
            console.error('Get student premium lectures error:', error);
            res.status(500).json({ error: 'فشل في جلب الحصص المدفوعة' });
        }
    });

    // Get student's purchased/accessible premium lectures (self, owning instructor, or platform admin)
    router.get('/student/:studentId/purchased', deps.authenticate, async (req: AuthRequest, res: Response) => {
        try {
            const { studentId } = req.params;

            if (!(await canViewStudent(req.user!, studentId))) {
                return res.status(403).json({ error: 'ليست لديك صلاحية لعرض حصص هذا الطالب' });
            }

            const lectures = await deps.query(`
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
            `, [studentId]);
            res.json(lectures || []);
        } catch (error) {
            console.error('Get purchased lectures error:', error);
            res.status(500).json({ error: 'فشل في جلب الحصص المشتراة' });
        }
    });

    // ===============================
    // ACCESS CHECK
    // ===============================

    // Check if student has access to a premium lecture (self, owning instructor, or platform admin)
    router.get('/access/check/:studentId/:lectureId', deps.authenticate, async (req: AuthRequest, res: Response) => {
        try {
            const { studentId, lectureId } = req.params;

            if (!(await canViewStudent(req.user!, studentId))) {
                return res.status(403).json({ error: 'ليست لديك صلاحية للتحقق من وصول هذا الطالب' });
            }

            const access = await deps.queryOne(`
                SELECT * FROM premium_lecture_access
                WHERE student_id = ? AND premium_lecture_id = ?
            `, [studentId, lectureId]);

            res.json({ hasAccess: !!access, access });
        } catch (error) {
            console.error('Check access error:', error);
            res.status(500).json({ error: 'فشل في التحقق من الوصول' });
        }
    });

    // ===============================
    // LECTURE MANAGEMENT
    // ===============================

    // Get all premium lectures (owning instructor: own lectures only; platform admin: all)
    router.get('/', deps.authenticate, async (req: AuthRequest, res: Response) => {
        try {
            const user = req.user!;
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
            const params: any[] = [];

            if (grade_id && typeof grade_id === 'string') {
                sql += ' AND pl.grade_id = ?';
                params.push(grade_id);
            }

            if (group_id && typeof group_id === 'string') {
                sql += ' AND pl.group_id = ?';
                params.push(group_id);
            }

            if (!(await hasPlatformAdmin(user.id))) {
                if (!user.instructorId) {
                    return res.status(403).json({ error: 'ليست لديك صلاحية لعرض الحصص المدفوعة' });
                }
                sql += ` AND ${TEACHER_LECTURE_SCOPE_SQL}`;
                params.push(user.id);
                sql += ` AND (pl.group_id IS NULL OR NOT EXISTS (
                    SELECT 1 FROM \`groups\` bg
                    WHERE bg.id = pl.group_id AND bg.branch_scope = 'branch'
                      AND NOT EXISTS (
                        SELECT 1 FROM branch_memberships bm
                        WHERE bm.branch_id = bg.branch_id AND bm.user_id = ? AND bm.status = 'active'
                      )
                      AND NOT EXISTS (
                        SELECT 1 FROM tenants owner_t
                        WHERE owner_t.id = ? AND owner_t.owner_user_id = ? AND owner_t.status = 'active'
                      )
                ))`;
                params.push(user.id, user.tenantId ?? null, user.id);
                if (user.branchId) {
                    sql += ` AND (pl.group_id IS NULL OR NOT EXISTS (
                        SELECT 1 FROM \`groups\` bg2
                        WHERE bg2.id = pl.group_id AND bg2.branch_scope = 'branch' AND bg2.branch_id <> ?
                    ))`;
                    params.push(user.branchId);
                }
            }

            sql += ' ORDER BY pl.created_at DESC';

            const lectures = await deps.query(sql, params);
            res.json(lectures || []);
        } catch (error) {
            console.error('Get premium lectures error:', error);
            res.status(500).json({ error: 'فشل في جلب الحصص المدفوعة' });
        }
    });

    // Get single premium lecture (owner/admin, or a student holding granted access)
    router.get('/:id', deps.authenticate, async (req: AuthRequest, res: Response) => {
        try {
            const { id } = req.params;
            const user = req.user!;

            const lecture = await deps.queryOne<LectureRow>(`
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
            if (!(await enforcePremiumBranch(req, res, id, req.query?.branch_id))) return;

            if (await canManageLecture(user, id)) {
                return res.json(lecture);
            }

            // Students see a lecture only when access was actually granted;
            // published-but-not-granted lectures stay invisible (no metadata leak).
            if (user.studentEnrollmentId) {
                const access = await deps.queryOne(`
                    SELECT id FROM premium_lecture_access
                    WHERE student_id = ? AND premium_lecture_id = ?
                `, [user.studentEnrollmentId, id]);
                if (access) {
                    return res.json(lecture);
                }
            }

            return res.status(404).json({ error: 'الحصة غير موجودة' });
        } catch (error) {
            console.error('Get premium lecture error:', error);
            res.status(500).json({ error: 'فشل في جلب بيانات الحصة' });
        }
    });

    // Create premium lecture (owner of the target group, or verified platform admin)
    router.post('/', deps.authenticate, async (req: AuthRequest, res: Response) => {
        try {
            const { title, description, video_url, thumbnail_url, duration_minutes, price, grade_id, group_id, is_published } = req.body;
            const user = req.user!;

            if (!title || !video_url || price === undefined) {
                return res.status(400).json({ error: 'العنوان ورابط الفيديو والسعر مطلوبين' });
            }
            const decimalPrice = toDecimalMoney(price);
            if (decimalPrice === null) {
                return res.status(400).json({ error: 'السعر يجب أن يكون موجبًا وبدقتين عشريتين كحد أقصى' });
            }

            if (!(await hasPlatformAdmin(user.id))) {
                if (!user.instructorId || !group_id) {
                    return res.status(403).json({ error: 'ليست لديك صلاحية لإنشاء حصة مدفوعة' });
                }
                // The target group must belong to the caller's own tenant.
                const group = await deps.queryOne(`
                    SELECT g.id
                    FROM \`groups\` g
                    INNER JOIN tenants t ON t.owner_user_id = g.instructor_id
                    WHERE g.id = ? AND t.owner_user_id = ? AND t.status = 'active'
                `, [group_id, user.id]);
                if (!group) {
                    return res.status(403).json({ error: 'المجموعة ليست داخل مساحتك' });
                }
            }

            const id = uuidv4();

            // A premium lecture's branch is derived from its group; the
            // caller cannot assign an unauthorized branch.
            const groupBranch = await validatePremiumGroupBranch(user, group_id);
            if (!groupBranch.ok) {
                return res.status(groupBranch.status).json({ error: groupBranch.error });
            }

            await deps.execute(`
                INSERT INTO premium_lectures (id, title, description, video_url, thumbnail_url, duration_minutes, price, grade_id, group_id, is_published, created_by)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `, [id, title, description || null, video_url, thumbnail_url || null, duration_minutes || 0, decimalPrice, grade_id || null, group_id || null, is_published ? 1 : 0, user.id]);

            const newLecture = await deps.queryOne('SELECT * FROM premium_lectures WHERE id = ?', [id]);
            res.status(201).json(newLecture);
        } catch (error) {
            console.error('Create premium lecture error:', error);
            res.status(500).json({ error: 'فشل في إنشاء الحصة المدفوعة' });
        }
    });

    // Update premium lecture (owner of the lecture, or verified platform admin)
    router.put('/:id', deps.authenticate, async (req: AuthRequest, res: Response) => {
        try {
            const { id } = req.params;
            const { title, description, video_url, thumbnail_url, duration_minutes, price, grade_id, group_id, is_published } = req.body;

            if (!(await canManageLecture(req.user!, id))) {
                return res.status(403).json({ error: 'ليست لديك صلاحية على هذه الحصة' });
            }
            if (!(await enforcePremiumBranch(req, res, id, req.body?.branch_id))) return;
            const targetGroupBranch = await validatePremiumGroupBranch(req.user!, group_id);
            if (!targetGroupBranch.ok) {
                return res.status(targetGroupBranch.status).json({ error: targetGroupBranch.error });
            }

            if (price !== undefined && toDecimalMoney(price) === null) {
                return res.status(400).json({ error: 'السعر يجب أن يكون موجبًا وبدقتين عشريتين كحد أقصى' });
            }

            await deps.execute(`
                UPDATE premium_lectures
                SET title = ?, description = ?, video_url = ?, thumbnail_url = ?, duration_minutes = ?, price = ?, grade_id = ?, group_id = ?, is_published = ?
                WHERE id = ?
            `, [title, description || null, video_url, thumbnail_url || null, duration_minutes || 0, toDecimalMoney(price) ?? price, grade_id || null, group_id || null, is_published ? 1 : 0, id]);

            const updatedLecture = await deps.queryOne('SELECT * FROM premium_lectures WHERE id = ?', [id]);
            res.json(updatedLecture);
        } catch (error) {
            console.error('Update premium lecture error:', error);
            res.status(500).json({ error: 'فشل في تحديث الحصة المدفوعة' });
        }
    });

    // Delete premium lecture (owner of the lecture, or verified platform admin)
    router.delete('/:id', deps.authenticate, async (req: AuthRequest, res: Response) => {
        try {
            const { id } = req.params;

            if (!(await canManageLecture(req.user!, id))) {
                return res.status(403).json({ error: 'ليست لديك صلاحية على هذه الحصة' });
            }
            if (!(await enforcePremiumBranch(req, res, id))) return;

            await deps.execute('DELETE FROM premium_lectures WHERE id = ?', [id]);
            res.json({ success: true, message: 'تم حذف الحصة بنجاح' });
        } catch (error) {
            console.error('Delete premium lecture error:', error);
            res.status(500).json({ error: 'فشل في حذف الحصة المدفوعة' });
        }
    });

    return router;
};

// `../db` is loaded lazily (and cached) so importing this module never runs
// db.ts: no dotenv side effect and no pool creation at import time.
let dbModule: typeof import('../db') | null = null;
const loadDb = async (): Promise<typeof import('../db')> => {
    dbModule ??= await import('../db');
    return dbModule;
};

/** Verified platform capability: active super_admin or a seeded permission key. */
const productionPlatformCapability = async (userId: string, permission: string): Promise<boolean> => {
    if (await isSuperAdmin(userId)) return true;
    return (await getAdminPermissions(userId)).includes(permission);
};

/** Production wiring: real pool, live auth middleware, verified capability check. */
export default createPremiumLectureRouter({
    query: (sql, params) => loadDb().then((db) => db.query(sql, params)),
    queryOne: (sql, params) => loadDb().then((db) => db.queryOne(sql, params)),
    execute: (sql, params) => loadDb().then((db) => db.execute(sql, params)),
    withTransaction: async <T>(work: (tx: {
        query: <U = unknown>(sql: string, params?: unknown[]) => Promise<U[]>;
        queryOne: <U = unknown>(sql: string, params?: unknown[]) => Promise<U | null>;
        execute: (sql: string, params?: unknown[]) => Promise<{ insertId: number; affectedRows: number }>;
    }) => Promise<T>): Promise<T> => {
        const db = await loadDb();
        const connection = await db.getPool().getConnection();
        try {
            await connection.beginTransaction();
            const tx = {
                query: async <U = unknown>(sql: string, params?: unknown[]): Promise<U[]> => {
                    const [rows] = await connection.execute(sql, params);
                    return rows as U[];
                },
                queryOne: async <U = unknown>(sql: string, params?: unknown[]): Promise<U | null> => {
                    const [rows] = await connection.execute(sql, params);
                    const list = rows as U[];
                    return list.length > 0 ? list[0] : null;
                },
                execute: async (sql: string, params?: unknown[]) => {
                    const [result] = await connection.execute(sql, params);
                    return result as { insertId: number; affectedRows: number };
                },
            };
            const result = await work(tx);
            await connection.commit();
            return result;
        } catch (error) {
            await connection.rollback();
            throw error;
        } finally {
            connection.release();
        }
    },
    authenticate: authenticateToken,
    hasPlatformCapability: productionPlatformCapability,
});
