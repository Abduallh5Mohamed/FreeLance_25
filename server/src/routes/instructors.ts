import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { query, queryOne, execute } from '../db';
import {
    authenticateToken,
    AuthRequest,
} from '../middleware/auth';
import { getAdminPermissions, requireAdminPermission, requireSelfOrAdminPermission } from '../security/admin-permissions';

const router = Router();

router.use(authenticateToken);

interface QueryResult {
    insertId: number;
    affectedRows: number;
}

// ============================================================
// Auto-migrate: ensure instructor tables & columns exist
// ============================================================
let tablesEnsured = false;
async function ensureInstructorTables() {
    if (tablesEnsured) return;
    try {
        // 1. Add instructor + staff to users.role ENUM if missing
        const enumCol = await queryOne<{ COLUMN_TYPE: string }>(
            `SELECT COLUMN_TYPE FROM INFORMATION_SCHEMA.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'role'`
        );
        if (enumCol && !enumCol.COLUMN_TYPE.includes('instructor')) {
            await execute(`ALTER TABLE users MODIFY COLUMN role ENUM('admin','teacher','student','instructor','staff') NOT NULL DEFAULT 'student'`);
        }

        // 2. Create instructor_wallets if not exists
        await execute(`CREATE TABLE IF NOT EXISTS instructor_wallets (
            id INT AUTO_INCREMENT PRIMARY KEY,
            instructor_id CHAR(36) NOT NULL,
            balance DECIMAL(10,2) NOT NULL DEFAULT 0.00,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            UNIQUE KEY uq_instructor_wallet (instructor_id),
            FOREIGN KEY (instructor_id) REFERENCES users(id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);

        // 3. Create instructor_wallet_transactions if not exists
        await execute(`CREATE TABLE IF NOT EXISTS instructor_wallet_transactions (
            id INT AUTO_INCREMENT PRIMARY KEY,
            instructor_id CHAR(36) NOT NULL,
            type ENUM('credit', 'debit') NOT NULL,
            amount DECIMAL(10,2) NOT NULL,
            balance_after DECIMAL(10,2) NOT NULL DEFAULT 0.00,
            description VARCHAR(500),
            reference_id INT DEFAULT NULL,
            created_by CHAR(36) DEFAULT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (instructor_id) REFERENCES users(id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);

        // Video exchange tables are versioned by 20260924_instructor_video_exchange.sql.
        // Keep this compatibility bootstrap limited to legacy ownership/wallet fields.
        // 4. Add instructor_id to lectures if not exists
        const lecCol = await queryOne<{ cnt: number }>(
            `SELECT COUNT(*) AS cnt FROM INFORMATION_SCHEMA.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'lectures' AND COLUMN_NAME = 'instructor_id'`
        );
        if (lecCol && lecCol.cnt === 0) {
            await execute('ALTER TABLE lectures ADD COLUMN instructor_id CHAR(36) DEFAULT NULL AFTER group_id, ADD INDEX idx_instructor_id (instructor_id)');
        }

        // 5. Add instructor_id to students if not exists
        const stuCol = await queryOne<{ cnt: number }>(
            `SELECT COUNT(*) AS cnt FROM INFORMATION_SCHEMA.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'students' AND COLUMN_NAME = 'instructor_id'`
        );
        if (stuCol && stuCol.cnt === 0) {
            await execute('ALTER TABLE students ADD COLUMN instructor_id CHAR(36) DEFAULT NULL AFTER group_id, ADD INDEX idx_inst_id (instructor_id)');
        }

        // 6. Auto-create wallets for existing instructors
        await execute(`INSERT IGNORE INTO instructor_wallets (instructor_id, balance)
            SELECT id, 0.00 FROM users WHERE role = 'instructor'`);

        tablesEnsured = true;
        console.log('✅ Instructor tables auto-migrated successfully');
    } catch (error) {
        console.error('⚠️ Instructor table auto-migration error (non-fatal):', error);
    }
}

// Run migration on first request
router.use(async (_req, _res, next) => {
    await ensureInstructorTables();
    next();
});

// ============================================================
// GET /api/instructors  — list all instructors (admin only)
// ============================================================
router.get('/', requireAdminPermission('instructor.read'), async (req: AuthRequest, res: Response) => {
    try {
        // Use a simpler query that doesn't depend on instructor_id columns
        // First check if the columns exist
        const hasLecCol = await queryOne<{ cnt: number }>(
            `SELECT COUNT(*) AS cnt FROM INFORMATION_SCHEMA.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'lectures' AND COLUMN_NAME = 'instructor_id'`
        );
        const hasStuCol = await queryOne<{ cnt: number }>(
            `SELECT COUNT(*) AS cnt FROM INFORMATION_SCHEMA.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'students' AND COLUMN_NAME = 'instructor_id'`
        );

        const hasLectures = hasLecCol && hasLecCol.cnt > 0;
        const hasStudents = hasStuCol && hasStuCol.cnt > 0;

        let instructors;

        if (hasLectures && hasStudents) {
            instructors = await query(`
                SELECT
                    u.id,
                    u.name,
                    u.email,
                    u.phone,
                    u.is_active,
                    u.created_at,
                    COALESCE(w.balance, 0.00) AS wallet_balance,
                    COUNT(DISTINCT l.id)       AS total_lectures,
                    COUNT(DISTINCT s.id)       AS total_students
                FROM users u
                LEFT JOIN instructor_wallets w ON w.instructor_id = u.id
                LEFT JOIN lectures l           ON l.instructor_id = u.id
                LEFT JOIN students s           ON s.instructor_id = u.id
                WHERE u.role = 'instructor'
                GROUP BY u.id, u.name, u.email, u.phone, u.is_active, u.created_at, w.balance
                ORDER BY u.created_at DESC
            `);
        } else if (hasLectures) {
            instructors = await query(`
                SELECT
                    u.id,
                    u.name,
                    u.email,
                    u.phone,
                    u.is_active,
                    u.created_at,
                    COALESCE(w.balance, 0.00) AS wallet_balance,
                    COUNT(DISTINCT l.id)       AS total_lectures,
                    0                          AS total_students
                FROM users u
                LEFT JOIN instructor_wallets w ON w.instructor_id = u.id
                LEFT JOIN lectures l           ON l.instructor_id = u.id
                WHERE u.role = 'instructor'
                GROUP BY u.id, u.name, u.email, u.phone, u.is_active, u.created_at, w.balance
                ORDER BY u.created_at DESC
            `);
        } else {
            // Fallback: no instructor_id columns yet
            instructors = await query(`
                SELECT
                    u.id,
                    u.name,
                    u.email,
                    u.phone,
                    u.is_active,
                    u.created_at,
                    COALESCE(w.balance, 0.00) AS wallet_balance,
                    0                          AS total_lectures,
                    0                          AS total_students
                FROM users u
                LEFT JOIN instructor_wallets w ON w.instructor_id = u.id
                WHERE u.role = 'instructor'
                ORDER BY u.created_at DESC
            `);
        }

        const permissions = await getAdminPermissions(req.user!.id);
        const visible = permissions.includes('service_credit.read') ? instructors : (instructors || []).map((row: any) => {
            const { wallet_balance: _hidden, ...safe } = row;
            return safe;
        });
        res.json(visible || []);
    } catch (error) {
        console.error('Get instructors error:', error);
        res.status(500).json({ error: 'فشل في جلب الـ instructors' });
    }
});

// ============================================================
// GET /api/instructors/:id  — single instructor details
// ============================================================
router.get('/:id', requireSelfOrAdminPermission('id', 'instructor.detail.read'), async (req: AuthRequest, res: Response) => {
    try {
        const { id } = req.params;

        const instructor = await queryOne<any>(`
            SELECT
                u.id,
                u.name,
                u.email,
                u.phone,
                u.is_active,
                u.created_at,
                COALESCE(w.balance, 0.00) AS wallet_balance
            FROM users u
            LEFT JOIN instructor_wallets w ON w.instructor_id = u.id
            WHERE u.id = ? AND u.role = 'instructor'
        `, [id]);

        if (!instructor) {
            return res.status(404).json({ error: 'Instructor غير موجود' });
        }

        const self = req.user!.id === id;
        const permissions = self ? [] : await getAdminPermissions(req.user!.id);
        if (!self && !permissions.includes('service_credit.read')) delete instructor.wallet_balance;
        res.json(instructor);
    } catch (error) {
        console.error('Get instructor error:', error);
        res.status(500).json({ error: 'فشل في جلب بيانات الـ instructor' });
    }
});

// ============================================================
// GET /api/instructors/:id/stats  — dashboard stats
// ============================================================
router.get('/:id/stats', requireSelfOrAdminPermission('id', 'instructor.detail.read'), async (req: AuthRequest, res: Response) => {
    try {
        const { id } = req.params;

        // Check which columns exist
        const hasLecCol = await queryOne<{ cnt: number }>(
            `SELECT COUNT(*) AS cnt FROM INFORMATION_SCHEMA.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'lectures' AND COLUMN_NAME = 'instructor_id'`
        );
        const hasStuCol = await queryOne<{ cnt: number }>(
            `SELECT COUNT(*) AS cnt FROM INFORMATION_SCHEMA.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'students' AND COLUMN_NAME = 'instructor_id'`
        );

        const self = req.user!.id === id;
        const permissions = self ? [] : await getAdminPermissions(req.user!.id);
        const canReadCredit = self || permissions.includes('service_credit.read');
        const walletRow = canReadCredit
            ? await queryOne<{ balance: number }>('SELECT COALESCE(balance, 0) AS balance FROM instructor_wallets WHERE instructor_id = ?', [id])
            : null;

        let lectureCount = { cnt: 0 };
        let studentCount = { cnt: 0 };

        if (hasLecCol && hasLecCol.cnt > 0) {
            lectureCount = await queryOne<{ cnt: number }>('SELECT COUNT(*) AS cnt FROM lectures WHERE instructor_id = ?', [id]) || lectureCount;
        }
        if (hasStuCol && hasStuCol.cnt > 0) {
            studentCount = await queryOne<{ cnt: number }>('SELECT COUNT(*) AS cnt FROM students WHERE instructor_id = ?', [id]) || studentCount;
        }

        const pendingRequests = await queryOne<{ cnt: number }>("SELECT COUNT(*) AS cnt FROM instructor_video_requests WHERE requester_id = ? AND status IN ('open','awaiting_requester')", [id]);
        const receivedRequests = await queryOne<{ cnt: number }>("SELECT COUNT(*) AS cnt FROM instructor_video_requests WHERE owner_id = ? AND status IN ('open','awaiting_requester')", [id]);

        res.json({
            ...(canReadCredit ? { wallet_balance: walletRow?.balance ?? 0 } : {}),
            total_lectures: lectureCount?.cnt ?? 0,
            total_students: studentCount?.cnt ?? 0,
            pending_sent_requests: pendingRequests?.cnt ?? 0,
            pending_received_requests: receivedRequests?.cnt ?? 0,
        });
    } catch (error) {
        console.error('Get instructor stats error:', error);
        res.status(500).json({ error: 'فشل في جلب إحصائيات الـ instructor' });
    }
});

// ============================================================
// GET /api/instructors/:id/lectures  — instructor's own lectures
// ============================================================
router.get('/:id/lectures', requireSelfOrAdminPermission('id', 'instructor.detail.read'), async (req: Request, res: Response) => {
    try {
        const { id } = req.params;

        const lectures = await query(`
            SELECT
                l.*,
                v.status AS video_status,
                v.preview_status,
                v.preview_duration_seconds,
                c.name AS course_name,
                g.name AS grade_name
            FROM lectures l
            LEFT JOIN videos v ON l.video_url = CONCAT('video://',v.id)
            LEFT JOIN courses c ON l.course_id = c.id
            LEFT JOIN grades  g ON l.grade_id  = g.id
            WHERE l.instructor_id = ?
            ORDER BY l.created_at DESC
        `, [id]);

        res.json(lectures || []);
    } catch (error) {
        console.error('Get instructor lectures error:', error);
        res.status(500).json({ error: 'فشل في جلب الفيديوهات' });
    }
});

// ============================================================
// GET /api/instructors/:id/students  — instructor's students
// ============================================================
router.get('/:id/students', requireSelfOrAdminPermission('id', 'instructor.detail.read'), async (req: Request, res: Response) => {
    try {
        const { id } = req.params;

        const students = await query(`
            SELECT
                s.id,
                s.name,
                s.phone,
                s.is_offline,
                s.approval_status,
                s.is_active,
                s.created_at,
                g.name  AS grade_name,
                gr.name AS group_name
            FROM students s
            LEFT JOIN grades  g  ON s.grade_id = g.id
            LEFT JOIN \`groups\` gr ON s.group_id = gr.id
            WHERE s.instructor_id = ?
            ORDER BY s.created_at DESC
        `, [id]);

        res.json(students || []);
    } catch (error) {
        console.error('Get instructor students error:', error);
        res.status(500).json({ error: 'فشل في جلب الطلاب' });
    }
});

// ============================================================
// POST /api/instructors  — create a new instructor (admin only)
// ============================================================
router.post('/', requireAdminPermission('instructor.create'), async (req: Request, res: Response) => {
    if (process.env.ALLOW_LEGACY_INSTRUCTOR_CREATION !== 'true') {
        return res.status(409).json({ error: 'استخدم تهيئة المدرس واشتراك المنصة عبر /api/admin/platform/tenants' });
    }
    try {
        const { name, email, phone, password } = req.body;

        if (!name || !password || (!email && !phone)) {
            return res.status(400).json({ error: 'الاسم وكلمة المرور والهاتف (أو الإيميل) مطلوبة' });
        }

        // Check uniqueness
        const identifier = phone ? phone.trim() : (email || '').toLowerCase().trim();
        const whereCol  = phone ? 'phone' : 'email';

        const existing = await queryOne(`SELECT id FROM users WHERE ${whereCol} = ?`, [identifier]);
        if (existing) {
            return res.status(409).json({ error: 'يوجد مستخدم بنفس الهاتف أو الإيميل مسبقاً' });
        }

        const passwordHash = await bcrypt.hash(password, 10);

        // Insert the new instructor user
        const normalizedPhone = phone ? phone.trim() : null;
        const normalizedEmail = email ? email.toLowerCase().trim() : null;

        await execute(
            `INSERT INTO users (name, email, phone, password_hash, role, is_active)
             VALUES (?, ?, ?, ?, 'instructor', 1)`,
            [name, normalizedEmail, normalizedPhone, passwordHash]
        );

        // Fetch the newly created user by phone or email to get the UUID
        // (mysql2.execute().insertId returns 0 for UUID columns)
        const newUser = await queryOne<{ id: string }>(
            normalizedPhone
                ? 'SELECT id FROM users WHERE phone = ? AND role = "instructor" ORDER BY created_at DESC LIMIT 1'
                : 'SELECT id FROM users WHERE email = ? AND role = "instructor" ORDER BY created_at DESC LIMIT 1',
            [normalizedPhone || normalizedEmail]
        );

        if (!newUser) {
            return res.status(500).json({ error: 'تم إنشاء الحساب لكن لم يتم العثور عليه' });
        }

        const newId = newUser.id;

        // Create wallet automatically
        await execute(
            'INSERT IGNORE INTO instructor_wallets (instructor_id, balance) VALUES (?, 0.00)',
            [newId]
        );

        res.status(201).json({ id: newId, name, email, phone, role: 'instructor', wallet_balance: 0 });
    } catch (error) {
        console.error('Create instructor error:', error);
        res.status(500).json({ error: 'فشل في إنشاء الـ instructor' });
    }
});

// ============================================================
// PUT /api/instructors/:id  — update instructor info (admin)
// ============================================================
router.put('/:id', requireAdminPermission('instructor.update'), async (req: Request, res: Response) => {
    try {
        const { id } = req.params;
        const { name, email, phone, password, is_active } = req.body;
        const activating = is_active === true || is_active === 1 || is_active === 'true' || is_active === '1';

        if (activating) {
            const tenant = await queryOne<{ legacy_compat: number; subscription_status: string | null }>(
                `SELECT t.legacy_compat,
                        (SELECT s.status FROM tenant_subscriptions s WHERE s.tenant_id=t.id ORDER BY s.created_at DESC LIMIT 1) AS subscription_status
                 FROM tenants t WHERE t.owner_user_id=?`, [id]
            );
            if (!tenant || (!tenant.legacy_compat && !['active', 'grace_period'].includes(tenant.subscription_status || ''))) {
                return res.status(409).json({ error: 'لا يمكن تفعيل المدرس قبل توثيق اشتراك المنصة' });
            }
        }

        const instructor = await queryOne('SELECT id FROM users WHERE id = ? AND role = "instructor"', [id]);
        if (!instructor) return res.status(404).json({ error: 'Instructor غير موجود' });

        const updates: string[] = [];
        const values: any[]     = [];

        if (name !== undefined)      { updates.push('name = ?');      values.push(name); }
        if (email !== undefined)     { updates.push('email = ?');     values.push(email ? email.toLowerCase().trim() : null); }
        if (phone !== undefined)     { updates.push('phone = ?');     values.push(phone ? phone.trim() : null); }
        if (is_active !== undefined) { updates.push('is_active = ?'); values.push(activating ? 1 : 0); }
        if (password)                {
            const hash = await bcrypt.hash(password, 10);
            updates.push('password_hash = ?');
            values.push(hash);
        }

        if (updates.length === 0) {
            return res.status(400).json({ error: 'لا توجد بيانات للتحديث' });
        }

        values.push(id);
        await execute(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`, values);

        res.json({ message: 'تم تحديث بيانات الـ instructor بنجاح' });
    } catch (error) {
        console.error('Update instructor error:', error);
        res.status(500).json({ error: 'فشل في تحديث الـ instructor' });
    }
});

// ============================================================
// DELETE /api/instructors/:id  — delete instructor (admin)
// ============================================================
router.delete('/:id', requireAdminPermission('instructor.suspend'), async (req: Request, res: Response) => {
    try {
        const { id } = req.params;

        const instructor = await queryOne('SELECT id FROM users WHERE id = ? AND role = "instructor"', [id]);
        if (!instructor) return res.status(404).json({ error: 'Instructor غير موجود' });

        // Compatibility endpoint: never cascade-delete a teacher's students,
        // content, payments or history. Explicit archival is added with tenants.
        await execute('UPDATE users SET is_active = 0 WHERE id = ? AND role = "instructor"', [id]);

        res.json({ message: 'تم إيقاف حساب المدرس مع الاحتفاظ ببياناته', archived: true });
    } catch (error) {
        console.error('Delete instructor error:', error);
        res.status(500).json({ error: 'فشل في حذف الـ instructor' });
    }
});

export default router;
