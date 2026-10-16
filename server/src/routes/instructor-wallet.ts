import { Router, RequestHandler, Response } from 'express';
import { query, queryOne, execute } from '../db';
import {
    authenticateToken,
    AuthRequest,
} from '../middleware/auth';
import { adjustServiceCredit, CreditAdjustmentError } from '../services/service-credit';
import { requireAdminPermission, requireSelfOrAdminPermission } from '../security/admin-permissions';

/**
 * Data-access seam for the instructor-wallet router. Production binds ../db;
 * hermetic tests inject isolated fixtures through the same boundary so the
 * real guard logic runs without a database.
 */
export interface InstructorWalletDataAccess {
    query: typeof query;
    queryOne: typeof queryOne;
    execute: typeof execute;
}

/**
 * Injectable seams for the instructor-wallet router. The default export binds
 * the production SQL adapters, the real authentication middleware, the real
 * platform-capability guards, and the real service-credit transaction service.
 * Tests inject fixtures through this boundary instead of bypassing production
 * authorization.
 */
export interface InstructorWalletRouterDeps {
    db: InstructorWalletDataAccess;
    authenticate: RequestHandler;
    requireAdminPermission: (permission: string) => RequestHandler;
    requireSelfOrAdminPermission: (paramName: string, permission: string) => RequestHandler;
    adjustServiceCredit: typeof adjustServiceCredit;
    /** Production reads ALLOW_DIRECT_SERVICE_CREDIT_ADJUSTMENT; tests inject a fixture. */
    directAdjustmentAllowed?: () => boolean;
}

export const createInstructorWalletRouter = (deps: InstructorWalletRouterDeps): Router => {
    const router = Router();
    const { query, queryOne } = deps.db;
    const requireAdmin = deps.requireAdminPermission;
    const requireSelfOrAdmin = deps.requireSelfOrAdminPermission;
    const directAdjustmentAllowed = deps.directAdjustmentAllowed
        ?? (() => process.env.ALLOW_DIRECT_SERVICE_CREDIT_ADJUSTMENT === 'true');

    router.use(deps.authenticate);

    // ============================================================
    // GET /api/instructor-wallet/:instructorId
    // Get current balance + summary
    // ============================================================
    router.get('/:instructorId', requireSelfOrAdmin('instructorId', 'service_credit.read'), async (req: AuthRequest, res: Response) => {
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
    router.get('/:instructorId/transactions', requireSelfOrAdmin('instructorId', 'service_credit.read'), async (req: AuthRequest, res: Response) => {
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
    router.post('/:instructorId/credit', requireAdmin('service_credit.adjust'), async (req: AuthRequest, res: Response) => {
        if (!directAdjustmentAllowed()) {
            return res.status(409).json({ error: 'تعديل رصيد الخدمات يتطلب طلب موافقة عبر /api/admin/approvals' });
        }
        try {
            const newBalance = await deps.adjustServiceCredit({
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
    router.post('/:instructorId/debit', requireAdmin('service_credit.adjust'), async (req: AuthRequest, res: Response) => {
        if (!directAdjustmentAllowed()) {
            return res.status(409).json({ error: 'تعديل رصيد الخدمات يتطلب طلب موافقة عبر /api/admin/approvals' });
        }
        try {
            const newBalance = await deps.adjustServiceCredit({
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

    return router;
};

const productionDb: InstructorWalletDataAccess = { query, queryOne, execute };

export default createInstructorWalletRouter({
    db: productionDb,
    authenticate: authenticateToken,
    requireAdminPermission,
    requireSelfOrAdminPermission,
    adjustServiceCredit,
});
