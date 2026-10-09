import { Router, Request, Response } from 'express';
import { query, queryOne, execute } from '../db';
import {
    authenticateToken,
    AuthRequest,
} from '../middleware/auth';
import { adjustServiceCredit, CreditAdjustmentError } from '../services/service-credit';
import { requireAdminPermission, requireSelfOrAdminPermission } from '../security/admin-permissions';

const router = Router();

router.use(authenticateToken);

interface QueryResult {
    insertId: number;
    affectedRows: number;
}

// Ensure wallet tables exist before any query
let tablesEnsured = false;
async function ensureWalletTables() {
    if (tablesEnsured) return;
    try {
        await execute(`CREATE TABLE IF NOT EXISTS instructor_wallets (
            id INT AUTO_INCREMENT PRIMARY KEY,
            instructor_id CHAR(36) NOT NULL,
            balance DECIMAL(10,2) NOT NULL DEFAULT 0.00,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            UNIQUE KEY uq_instructor_wallet (instructor_id),
            FOREIGN KEY (instructor_id) REFERENCES users(id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);

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

        tablesEnsured = true;
        console.log('✅ Instructor wallet tables ensured');
    } catch (error) {
        console.error('⚠️ Instructor wallet table migration error (non-fatal):', error);
    }
}

router.use(async (_req, _res, next) => {
    await ensureWalletTables();
    next();
});

// ============================================================
// GET /api/instructor-wallet/:instructorId
// Get current balance + summary
// ============================================================
router.get('/:instructorId', requireSelfOrAdminPermission('instructorId', 'service_credit.read'), async (req: Request, res: Response) => {
    try {
        const { instructorId } = req.params;

        // Ensure wallet exists (auto-create if missing)
        await query(
            `INSERT IGNORE INTO instructor_wallets (instructor_id, balance) VALUES (?, 0.00)`,
            [instructorId]
        );

        const wallet = await queryOne<{ balance: number; updated_at: string }>(
            'SELECT balance, updated_at FROM instructor_wallets WHERE instructor_id = ?',
            [instructorId]
        );

        const txCount = await queryOne<{ credits: number; debits: number; total_credited: number; total_debited: number }>(
            `SELECT
                SUM(type = 'credit')                                       AS credits,
                SUM(type = 'debit')                                        AS debits,
                COALESCE(SUM(CASE WHEN type='credit' THEN amount END), 0)  AS total_credited,
                COALESCE(SUM(CASE WHEN type='debit'  THEN amount END), 0)  AS total_debited
             FROM instructor_wallet_transactions
             WHERE instructor_id = ?`,
            [instructorId]
        );

        res.json({
            instructor_id: instructorId,
            balance: wallet?.balance ?? 0,
            last_updated: wallet?.updated_at,
            summary: {
                total_credited: txCount?.total_credited ?? 0,
                total_debited:  txCount?.total_debited  ?? 0,
                credit_count:   txCount?.credits        ?? 0,
                debit_count:    txCount?.debits         ?? 0,
            }
        });
    } catch (error) {
        console.error('Get wallet error:', error);
        res.status(500).json({ error: 'فشل في جلب بيانات المحفظة' });
    }
});

// ============================================================
// GET /api/instructor-wallet/:instructorId/transactions
// Paginated transaction history
// ============================================================
router.get('/:instructorId/transactions', requireSelfOrAdminPermission('instructorId', 'service_credit.read'), async (req: Request, res: Response) => {
    try {
        const { instructorId } = req.params;
        const page  = Math.max(1, parseInt(req.query.page  as string) || 1);
        const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 20));
        const type  = req.query.type as string | undefined;  // 'credit' | 'debit'
        const offset = (page - 1) * limit;

        // NOTE: mysql2's server-side prepared statements (execute) fail with
        // "ER_WRONG_ARGUMENTS" when LIMIT/OFFSET are bound as placeholders,
        // so we inline validated integers instead.
        const limitSql = `LIMIT ${limit} OFFSET ${offset}`;

        let sql    = `SELECT t.*, u.name AS created_by_name
                      FROM instructor_wallet_transactions t
                      LEFT JOIN users u ON u.id = t.created_by
                      WHERE t.instructor_id = ?`;
        const params: any[] = [instructorId];

        if (type === 'credit' || type === 'debit') {
            sql += ' AND t.type = ?';
            params.push(type);
        }

        sql += ` ORDER BY t.created_at DESC ${limitSql}`;

        const transactions = await query(sql, params);

        const totalRow = await queryOne<{ total: number }>(
            `SELECT COUNT(*) AS total FROM instructor_wallet_transactions WHERE instructor_id = ?${type ? ' AND type = ?' : ''}`,
            type ? [instructorId, type] : [instructorId]
        );

        res.json({
            data:       transactions || [],
            pagination: {
                page,
                limit,
                total: totalRow?.total ?? 0,
                pages: Math.ceil((totalRow?.total ?? 0) / limit),
            }
        });
    } catch (error) {
        console.error('Get transactions error:', error);
        res.status(500).json({ error: 'فشل في جلب سجل المعاملات' });
    }
});

// ============================================================
// POST /api/instructor-wallet/:instructorId/credit
// Admin adds balance to an instructor's wallet
// ============================================================
router.post('/:instructorId/credit', requireAdminPermission('service_credit.adjust'), async (req: AuthRequest, res: Response) => {
    if (process.env.ALLOW_DIRECT_SERVICE_CREDIT_ADJUSTMENT !== 'true') {
        return res.status(409).json({ error: 'تعديل رصيد الخدمات يتطلب طلب موافقة عبر /api/admin/approvals' });
    }
    try {
        const newBalance = await adjustServiceCredit({
            instructorId: req.params.instructorId,
            actorId: req.user!.id,
            type: 'credit',
            amount: req.body.amount,
            reason: req.body.description,
        });
        res.json({
            message: 'تم إضافة رصيد خدمات المنصة بنجاح',
            new_balance: newBalance,
        });
    } catch (error) {
        if (error instanceof CreditAdjustmentError) return res.status(error.status).json({ error: error.message });
        console.error('Credit wallet error:', error);
        res.status(500).json({ error: 'فشل في إضافة الرصيد' });
    }
});

// ============================================================
// POST /api/instructor-wallet/:instructorId/debit
// Admin deducts balance from an instructor's wallet
// ============================================================
router.post('/:instructorId/debit', requireAdminPermission('service_credit.adjust'), async (req: AuthRequest, res: Response) => {
    if (process.env.ALLOW_DIRECT_SERVICE_CREDIT_ADJUSTMENT !== 'true') {
        return res.status(409).json({ error: 'تعديل رصيد الخدمات يتطلب طلب موافقة عبر /api/admin/approvals' });
    }
    try {
        const newBalance = await adjustServiceCredit({
            instructorId: req.params.instructorId,
            actorId: req.user!.id,
            type: 'debit',
            amount: req.body.amount,
            reason: req.body.description,
        });
        res.json({
            message: 'تم خصم رصيد خدمات المنصة بنجاح',
            new_balance: newBalance,
        });
    } catch (error) {
        if (error instanceof CreditAdjustmentError) return res.status(error.status).json({ error: error.message });
        console.error('Debit wallet error:', error);
        res.status(500).json({ error: 'فشل في خصم الرصيد' });
    }
});

export default router;
