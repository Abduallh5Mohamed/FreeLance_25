"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createInstructorWalletRouter = void 0;
const express_1 = require("express");
const db_1 = require("../db");
const auth_1 = require("../middleware/auth");
const service_credit_1 = require("../services/service-credit");
const admin_permissions_1 = require("../security/admin-permissions");
const createInstructorWalletRouter = (deps) => {
    const router = (0, express_1.Router)();
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
    router.get('/:instructorId', requireSelfOrAdmin('instructorId', 'service_credit.read'), async (req, res) => {
        try {
            const { instructorId } = req.params;
            // Ensure wallet exists (auto-create if missing)
            await query(`INSERT IGNORE INTO instructor_wallets (instructor_id, balance) VALUES (?, 0.00)`, [instructorId]);
            const wallet = await queryOne('SELECT balance, updated_at FROM instructor_wallets WHERE instructor_id = ?', [instructorId]);
            const txCount = await queryOne(`SELECT
                    SUM(type = 'credit')                                       AS credits,
                    SUM(type = 'debit')                                        AS debits,
                    COALESCE(SUM(CASE WHEN type='credit' THEN amount END), 0)  AS total_credited,
                    COALESCE(SUM(CASE WHEN type='debit'  THEN amount END), 0)  AS total_debited
                 FROM instructor_wallet_transactions
                 WHERE instructor_id = ?`, [instructorId]);
            res.json({
                instructor_id: instructorId,
                balance: wallet?.balance ?? 0,
                last_updated: wallet?.updated_at,
                summary: {
                    total_credited: txCount?.total_credited ?? 0,
                    total_debited: txCount?.total_debited ?? 0,
                    credit_count: txCount?.credits ?? 0,
                    debit_count: txCount?.debits ?? 0,
                }
            });
        }
        catch (error) {
            console.error('Get wallet error:', error);
            res.status(500).json({ error: 'فشل في جلب بيانات المحفظة' });
        }
    });
    // ============================================================
    // GET /api/instructor-wallet/:instructorId/transactions
    // Paginated transaction history
    // ============================================================
    router.get('/:instructorId/transactions', requireSelfOrAdmin('instructorId', 'service_credit.read'), async (req, res) => {
        try {
            const { instructorId } = req.params;
            const page = Math.max(1, parseInt(req.query.page) || 1);
            const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
            const type = req.query.type; // 'credit' | 'debit'
            const offset = (page - 1) * limit;
            // NOTE: mysql2's server-side prepared statements (execute) fail with
            // "ER_WRONG_ARGUMENTS" when LIMIT/OFFSET are bound as placeholders,
            // so we inline validated integers instead.
            const limitSql = `LIMIT ${limit} OFFSET ${offset}`;
            let sql = `SELECT t.*, u.name AS created_by_name
                          FROM instructor_wallet_transactions t
                          LEFT JOIN users u ON u.id = t.created_by
                          WHERE t.instructor_id = ?`;
            const params = [instructorId];
            if (type === 'credit' || type === 'debit') {
                sql += ' AND t.type = ?';
                params.push(type);
            }
            sql += ` ORDER BY t.created_at DESC ${limitSql}`;
            const transactions = await query(sql, params);
            const totalRow = await queryOne(`SELECT COUNT(*) AS total FROM instructor_wallet_transactions WHERE instructor_id = ?${type ? ' AND type = ?' : ''}`, type ? [instructorId, type] : [instructorId]);
            res.json({
                data: transactions || [],
                pagination: {
                    page,
                    limit,
                    total: totalRow?.total ?? 0,
                    pages: Math.ceil((totalRow?.total ?? 0) / limit),
                }
            });
        }
        catch (error) {
            console.error('Get transactions error:', error);
            res.status(500).json({ error: 'فشل في جلب سجل المعاملات' });
        }
    });
    // ============================================================
    // POST /api/instructor-wallet/:instructorId/credit
    // Admin adds balance to an instructor's wallet
    // ============================================================
    router.post('/:instructorId/credit', requireAdmin('service_credit.adjust'), async (req, res) => {
        if (!directAdjustmentAllowed()) {
            return res.status(409).json({ error: 'تعديل رصيد الخدمات يتطلب طلب موافقة عبر /api/admin/approvals' });
        }
        try {
            const newBalance = await deps.adjustServiceCredit({
                instructorId: req.params.instructorId,
                actorId: req.user.id,
                type: 'credit',
                amount: req.body.amount,
                reason: req.body.description,
                // Idempotency: a client-supplied key is stored as the
                // transaction reference so retried approvals can be deduped
                // by (reference_type, reference_uuid) instead of double-posting.
                referenceType: req.body.idempotencyKey || req.body.referenceUuid ? 'wallet_adjustment' : undefined,
                referenceUuid: req.body.idempotencyKey || req.body.referenceUuid || undefined,
            });
            res.json({
                message: 'تم إضافة رصيد خدمات المنصة بنجاح',
                new_balance: newBalance,
            });
        }
        catch (error) {
            if (error instanceof service_credit_1.CreditAdjustmentError)
                return res.status(error.status).json({ error: error.message });
            console.error('Credit wallet error:', error);
            res.status(500).json({ error: 'فشل في إضافة الرصيد' });
        }
    });
    // ============================================================
    // POST /api/instructor-wallet/:instructorId/debit
    // Admin deducts balance from an instructor's wallet
    // ============================================================
    router.post('/:instructorId/debit', requireAdmin('service_credit.adjust'), async (req, res) => {
        if (!directAdjustmentAllowed()) {
            return res.status(409).json({ error: 'تعديل رصيد الخدمات يتطلب طلب موافقة عبر /api/admin/approvals' });
        }
        try {
            const newBalance = await deps.adjustServiceCredit({
                instructorId: req.params.instructorId,
                actorId: req.user.id,
                type: 'debit',
                amount: req.body.amount,
                reason: req.body.description,
                // Idempotency: see the credit endpoint above.
                referenceType: req.body.idempotencyKey || req.body.referenceUuid ? 'wallet_adjustment' : undefined,
                referenceUuid: req.body.idempotencyKey || req.body.referenceUuid || undefined,
            });
            res.json({
                message: 'تم خصم رصيد خدمات المنصة بنجاح',
                new_balance: newBalance,
            });
        }
        catch (error) {
            if (error instanceof service_credit_1.CreditAdjustmentError)
                return res.status(error.status).json({ error: error.message });
            console.error('Debit wallet error:', error);
            res.status(500).json({ error: 'فشل في خصم الرصيد' });
        }
    });
    return router;
};
exports.createInstructorWalletRouter = createInstructorWalletRouter;
const productionDb = { query: db_1.query, queryOne: db_1.queryOne, execute: db_1.execute };
exports.default = (0, exports.createInstructorWalletRouter)({
    db: productionDb,
    authenticate: auth_1.authenticateToken,
    requireAdminPermission: admin_permissions_1.requireAdminPermission,
    requireSelfOrAdminPermission: admin_permissions_1.requireSelfOrAdminPermission,
    adjustServiceCredit: service_credit_1.adjustServiceCredit,
});
