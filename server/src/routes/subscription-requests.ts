import { Router, RequestHandler, Response } from 'express';
import { randomUUID } from 'crypto';
import { query, execute, queryOne, getPool } from '../db';
import { sendSubscriptionApprovalNotification } from '../services/whatsapp-free';
import { AuthRequest, authenticateToken, requireRoles } from '../middleware/auth';
import { hasVerifiedPlatformPermission } from '../security/admin-permissions';

export interface SubscriptionRequestsDataAccess {
    query: typeof query;
    queryOne: typeof queryOne;
    execute: typeof execute;
    /**
     * Run `work` inside a single database transaction. The approve flow's
     * student insert, fee insert, and status transition commit or roll back
     * together; the guarded status flip means exactly one concurrent approval
     * can win.
     */
    withTransaction: <T>(
        work: (tx: Pick<SubscriptionRequestsDataAccess, 'query' | 'queryOne' | 'execute'>) => Promise<T>,
    ) => Promise<T>;
}

export interface SubscriptionRequestsRouterDeps {
    db: SubscriptionRequestsDataAccess;
    authenticate: RequestHandler;
    authorize: RequestHandler;
    hasVerifiedPlatformFinanceAccess?: (userId: string) => Promise<boolean>;
    loadActiveTenantAuthority?: (userId: string, tenantId: string) => Promise<{ authority: string } | null>;
    sendApprovalNotification?: typeof sendSubscriptionApprovalNotification;
}

/**
 * Money crosses the API as integer minor units or a decimal string with at
 * most two fraction digits; MySQL DECIMAL(12,2) does the arithmetic.
 */
const DECIMAL_RE = /^(?:0|[1-9]\d{0,9})(?:\.\d{1,2})?$/;
export const toDecimalMoney = (value: unknown): string | null => {
    if (value === null || value === undefined || value === '') return null;
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

export const createSubscriptionRequestsRouter = (deps: SubscriptionRequestsRouterDeps): Router => {
    const router = Router();
    const { query, queryOne, execute, withTransaction } = deps.db;
    router.use(deps.authenticate);

    const hasVerifiedPlatformFinanceAccess = deps.hasVerifiedPlatformFinanceAccess
        ?? ((userId: string) => hasVerifiedPlatformPermission('finance.read', userId));

    const loadActiveTenantAuthority = deps.loadActiveTenantAuthority
        ?? (async (userId: string, tenantId: string) => queryOne<{ authority: string }>(
            `SELECT 'owner' AS authority
             FROM tenants t
             WHERE t.id = ? AND t.owner_user_id = ? AND t.status = 'active'
             UNION ALL
             SELECT m.role_key AS authority
             FROM tenant_memberships m
             INNER JOIN tenants t ON t.id = m.tenant_id
             INNER JOIN users u ON u.id = m.user_id
             WHERE m.user_id = ? AND m.tenant_id = ? AND m.status = 'active'
               AND t.status = 'active' AND u.is_active = 1
               AND m.role_key IN ('owner','instructor')
             LIMIT 1`,
            [tenantId, userId, userId, tenantId],
        ));

    const sendApprovalNotification = deps.sendApprovalNotification ?? sendSubscriptionApprovalNotification;

    interface Scope {
        platform: boolean;
        authority: 'owner' | 'instructor' | null;
        userId: string;
        tenantId: string | null;
    }

    const resolveScope = async (req: AuthRequest, res: Response): Promise<Scope | null> => {
        const user = req.user;
        if (!user) {
            res.status(401).json({ error: 'Authentication required' });
            return null;
        }
        let platform = false;
        try {
            platform = await hasVerifiedPlatformFinanceAccess(user.id);
        } catch (error) {
            console.error('Finance permission lookup failed:', error);
            res.status(503).json({ error: 'Finance permissions unavailable' });
            return null;
        }
        if (platform) return { platform: true, authority: null, userId: user.id, tenantId: null };
        const tenantId = user.tenantId;
        if (!tenantId) {
            res.status(403).json({ error: 'Workspace access required' });
            return null;
        }
        let authorityRow: { authority: string } | null;
        try {
            authorityRow = await loadActiveTenantAuthority(user.id, tenantId);
        } catch (error) {
            console.error('Tenant authority lookup failed:', error);
            res.status(503).json({ error: 'Tenant authority unavailable' });
            return null;
        }
        if (!authorityRow || (authorityRow.authority !== 'owner' && authorityRow.authority !== 'instructor')) {
            res.status(403).json({ error: 'Subscription requests require owner or assigned-instructor authority' });
            return null;
        }
        return { platform: false, authority: authorityRow.authority, userId: user.id, tenantId };
    };

    const tenantParams = (scope: Scope): unknown[] => (scope.platform ? [] : [scope.tenantId as string]);

    // Get all subscription requests (tenant-scoped; verified platform reads all)
    router.get('/', requireRoles('admin', 'instructor', 'teacher', 'staff'), async (req: AuthRequest, res: Response) => {
        try {
            const scope = await resolveScope(req, res);
            if (!scope) return;
            const { status } = req.query;

            let sql = 'SELECT * FROM subscription_requests WHERE 1=1';
            const params: unknown[] = [];
            if (!scope.platform) {
                sql += ' AND tenant_id=?';
                params.push(scope.tenantId as string);
            }

            if (status) {
                sql += ' AND status = ?';
                params.push(status);
            }

            sql += ' ORDER BY created_at DESC';

            const requests = await query(sql, params);
            res.json(requests);
        } catch (error) {
            console.error('Error fetching subscription requests:', error);
            res.status(500).json({ error: 'Failed to fetch subscription requests' });
        }
    });

    // Create new subscription request
    router.post('/', requireRoles('student', 'instructor', 'teacher', 'staff'), async (req: AuthRequest, res: Response) => {
        try {
            const {
                student_name,
                phone,
                guardian_phone,
                grade_id,
                grade_name,
                group_id,
                group_name,
                subscription_plan_id,
                subscription_plan_name,
                amount,
                notes,
                receipt_image_url
            } = req.body;
            const tenantId = req.user!.tenantId;
            if (!tenantId) return res.status(403).json({ error: 'Active tenant membership required' });

            if (!student_name || !phone) {
                return res.status(400).json({ error: 'Student name and phone are required' });
            }
            if (amount !== undefined && amount !== null && amount !== '' && toDecimalMoney(amount) === null) {
                return res.status(400).json({ error: 'Amount must be a non-negative decimal with at most two fraction digits' });
            }
            // A caller-supplied group must belong to the caller's tenant:
            // the group instructor holds an active membership in this tenant.
            if (group_id) {
                const group = await queryOne(
                    `SELECT g.id FROM \`groups\` g
                     INNER JOIN tenant_memberships m ON m.user_id = g.instructor_id AND m.tenant_id = ? AND m.status = 'active'
                     INNER JOIN tenants t ON t.id = m.tenant_id AND t.status = 'active'
                     WHERE g.id = ?`,
                    [tenantId, group_id],
                );
                if (!group) return res.status(404).json({ error: 'Group not found in your tenant' });
            }

            const requestId = randomUUID();

            await execute(
                `INSERT INTO subscription_requests
                 (id, tenant_id, student_name, phone, guardian_phone, grade_id, grade_name, group_id, group_name, subscription_plan_id, subscription_plan_name, amount, notes, receipt_image_url, status)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
                [requestId, tenantId, student_name, phone, guardian_phone || null, grade_id || null, grade_name || null, group_id || null, group_name || null, subscription_plan_id || null, subscription_plan_name || null, amount === undefined || amount === null || amount === '' ? null : toDecimalMoney(amount), notes || null, receipt_image_url || null]
            );

            res.status(201).json({
                message: 'Subscription request created successfully',
                id: requestId
            });
        } catch (error) {
            console.error('Error creating subscription request:', error);
            res.status(500).json({ error: 'Failed to create subscription request' });
        }
    });

    // Approve subscription request (transactional, idempotent)
    router.post('/:id/approve', requireRoles('admin', 'instructor', 'teacher', 'staff'), async (req: AuthRequest, res: Response) => {
        try {
            const scope = await resolveScope(req, res);
            if (!scope) return;
            const { id } = req.params;

            // One transaction: the status flip, the student row, and the fee
            // row commit together. The row is locked with FOR UPDATE so two
            // concurrent approvals serialize; the guarded flip
            // (WHERE status='pending') means exactly one wins and the loser
            // sees affectedRows 0 and writes nothing.
            const outcome = await withTransaction(async (tx) => {
                const request = await tx.queryOne<Record<string, unknown>>(
                    `SELECT * FROM subscription_requests WHERE id = ?${scope.platform ? '' : ' AND tenant_id = ?'} FOR UPDATE`,
                    scope.platform ? [id] : [id, scope.tenantId as string],
                );
                if (!request) return { status: 404 as const, body: { error: 'Subscription request not found' } };
                if (request['status'] !== 'pending') {
                    return { status: 400 as const, body: { error: 'Request already processed' } };
                }
                const requestTenant = String(request['tenant_id']);

                // Guarded flip FIRST: exactly one caller can move the request
                // out of 'pending'. The loser affects zero rows and returns
                // before writing any student/fee row.
                const transition = await tx.execute(
                    `UPDATE subscription_requests SET status = ?, updated_at = NOW() WHERE id = ? AND tenant_id = ? AND status = 'pending'`,
                    ['approved', id, requestTenant]
                );
                if (transition.affectedRows === 0) {
                    return { status: 400 as const, body: { error: 'Request already processed' } };
                }

                // Check if student already exists (tenant-scoped)
                const existingStudents = await tx.query(
                    'SELECT id FROM students WHERE phone = ? AND tenant_id = ?',
                    [request['phone'], requestTenant]
                ) as unknown[];

                // Validate grade_id (global catalog: existence only) and
                // group_id (must belong to the request's tenant) before
                // inserting. A forged cross-tenant group aborts the approval.
                let validGradeId: unknown = null;
                let validGroupId: unknown = null;

                if (request['grade_id']) {
                    const gradeCheck = await tx.query(
                        'SELECT id FROM grades WHERE id = ?',
                        [request['grade_id']]
                    ) as unknown[];
                    if (Array.isArray(gradeCheck) && gradeCheck.length > 0) {
                        validGradeId = request['grade_id'];
                    }
                }

                if (request['group_id']) {
                    const groupCheck = await tx.query(
                        `SELECT g.id FROM \`groups\` g
                         INNER JOIN tenant_memberships m ON m.user_id = g.instructor_id AND m.tenant_id = ? AND m.status = 'active'
                         INNER JOIN tenants t ON t.id = m.tenant_id AND t.status = 'active'
                         WHERE g.id = ?`,
                        [requestTenant, request['group_id']]
                    ) as unknown[];
                    if (Array.isArray(groupCheck) && groupCheck.length > 0) {
                        validGroupId = request['group_id'];
                    }
                }

                let studentId: unknown;
                if (!Array.isArray(existingStudents) || existingStudents.length === 0) {
                    const result = await tx.execute(
                        `INSERT INTO students
                         (name, phone, grade_id, group_id, tenant_id, instructor_id, is_offline, approval_status)
                         VALUES (?, ?, ?, ?, ?, ?, FALSE, 'approved')`,
                        [request['student_name'], request['phone'], validGradeId, validGroupId, requestTenant, scope.userId]
                    );
                    studentId = (result as { insertId: unknown }).insertId;
                } else {
                    studentId = (existingStudents[0] as Record<string, unknown>)['id'];
                }

                const decimalAmount = request['amount'] === null || request['amount'] === undefined
                    ? '0.00'
                    : toDecimalMoney(request['amount']) ?? '0.00';
                await tx.execute(
                    `INSERT INTO student_fees
                     (tenant_id, student_id, student_name, phone, grade_id, grade_name, group_id, group_name, amount, paid_amount, status, is_offline, payment_method, notes, receipt_image_url, payment_date)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'paid', FALSE, 'online', ?, ?, NOW())`,
                    [requestTenant, studentId, request['student_name'], request['phone'], validGradeId, request['grade_name'], validGroupId, request['group_name'], decimalAmount, decimalAmount, request['notes'], request['receipt_image_url']]
                );
                return { status: 200 as const, body: null as unknown as Record<string, unknown>, request: request as Record<string, unknown> };
            });

            if (outcome.status !== 200) {
                res.status(outcome.status).json(outcome.body);
                return;
            }

            // Send WhatsApp message to guardian if guardian_phone exists.
            // A notification failure never rolls back the committed approval.
            const approved = (outcome as { request: Record<string, unknown> }).request;
            let whatsappSent = false;
            let whatsappLink = '';
            if (approved['guardian_phone']) {
                try {
                    const amountNumber = Number(approved['amount'] ?? 0);
                    const result = await sendApprovalNotification(
                        String(approved['guardian_phone']),
                        String(approved['student_name']),
                        Number.isFinite(amountNumber) ? amountNumber : 0,
                        String(approved['grade_name'] || 'غير محدد'),
                        String(approved['group_name'] || 'غير محدد')
                    );
                    whatsappSent = result.success;
                    whatsappLink = result.whatsappLink || '';

                    if (result.success) {
                        console.log(`✅ WhatsApp link generated for ${approved['guardian_phone']}`);
                        console.log(`🔗 Link: ${result.whatsappLink}`);
                    } else {
                        console.error(`❌ Failed to generate WhatsApp link: ${result.error}`);
                    }
                } catch (whatsappError) {
                    console.error('Error sending WhatsApp message:', whatsappError);
                    // Don't fail the approval if WhatsApp fails
                }
            }

            res.json({
                message: 'Subscription request approved successfully',
                whatsapp_sent: whatsappSent,
                whatsapp_link: whatsappLink
            });
        } catch (error) {
            console.error('Error approving subscription request:', error);
            res.status(500).json({ error: 'Failed to approve subscription request' });
        }
    });

    // Reject subscription request (guarded transition: second reject -> 400)
    router.post('/:id/reject', requireRoles('admin', 'instructor', 'teacher', 'staff'), async (req: AuthRequest, res: Response) => {
        try {
            const scope = await resolveScope(req, res);
            if (!scope) return;
            const { id } = req.params;
            const { rejection_reason } = req.body;

            if (!rejection_reason) {
                return res.status(400).json({ error: 'Rejection reason is required' });
            }

            const request = await queryOne<Record<string, unknown>>(
                `SELECT * FROM subscription_requests WHERE id = ?${scope.platform ? '' : ' AND tenant_id = ?'}`,
                scope.platform ? [id] : [id, scope.tenantId as string]
            );

            if (!request) {
                return res.status(404).json({ error: 'Subscription request not found' });
            }

            if (request['status'] !== 'pending') {
                return res.status(400).json({ error: 'Request already processed' });
            }

            // Guarded flip: a concurrent rejection already consumed the
            // transition if this affects zero rows.
            const transition = await execute(
                'UPDATE subscription_requests SET status = ?, rejection_reason = ?, updated_at = NOW() WHERE id = ? AND tenant_id = ? AND status = \'pending\'',
                ['rejected', rejection_reason, id, String(request['tenant_id'])]
            );
            if (transition.affectedRows === 0) {
                return res.status(400).json({ error: 'Request already processed' });
            }

            res.json({ message: 'Subscription request rejected successfully' });
        } catch (error) {
            console.error('Error rejecting subscription request:', error);
            res.status(500).json({ error: 'Failed to reject subscription request' });
        }
    });

    // Delete subscription request (cleanup, tenant-scoped)
    router.delete('/:id', requireRoles('admin', 'instructor', 'teacher', 'staff'), async (req: AuthRequest, res: Response) => {
        try {
            const scope = await resolveScope(req, res);
            if (!scope) return;
            const { id } = req.params;

            const result = await execute(
                `DELETE FROM subscription_requests WHERE id = ?${scope.platform ? '' : ' AND tenant_id = ?'}`,
                scope.platform ? [id] : [id, scope.tenantId as string]
            );

            if (result.affectedRows === 0) {
                return res.status(404).json({ error: 'Subscription request not found' });
            }

            res.json({ message: 'Subscription request deleted successfully' });
        } catch (error) {
            console.error('Error deleting subscription request:', error);
            res.status(500).json({ error: 'Failed to delete subscription request' });
        }
    });

    // Bulk delete approved requests by month (tenant-scoped)
    router.delete('/cleanup/month', requireRoles('admin', 'instructor', 'teacher', 'staff'), async (req: AuthRequest, res: Response) => {
        try {
            const scope = await resolveScope(req, res);
            if (!scope) return;
            const { month, year } = req.query;

            if (!month || !year) {
                return res.status(400).json({ error: 'Month and year are required' });
            }

            const result = await execute(
                `DELETE FROM subscription_requests WHERE status = ? AND MONTH(updated_at) = ? AND YEAR(updated_at) = ?${scope.platform ? '' : ' AND tenant_id = ?'}`,
                scope.platform ? ['approved', month, year] : ['approved', month, year, scope.tenantId as string, ...tenantParams(scope).slice(0, 0)]
            );

            res.json({
                message: 'Approved requests cleaned up successfully',
                deletedCount: result.affectedRows
            });
        } catch (error) {
            console.error('Error cleaning up requests:', error);
            res.status(500).json({ error: 'Failed to cleanup requests' });
        }
    });

    return router;
};

const withTransaction: SubscriptionRequestsDataAccess['withTransaction'] = async (work) => {
    const connection = await getPool().getConnection();
    try {
        await connection.beginTransaction();
        const tx = {
            query: async <T = unknown>(sql: string, params?: unknown[]): Promise<T[]> => {
                const [rows] = await connection.execute(sql, params);
                return rows as T[];
            },
            queryOne: async <T = unknown>(sql: string, params?: unknown[]): Promise<T | null> => {
                const [rows] = await connection.execute(sql, params);
                const list = rows as T[];
                return list.length > 0 ? list[0] : null;
            },
            execute: async (sql: string, params?: unknown[]) => {
                const [result] = await connection.execute(sql, params);
                return result as never;
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
};

const productionDb: SubscriptionRequestsDataAccess = { query, queryOne, execute, withTransaction };

export default createSubscriptionRequestsRouter({
    db: productionDb,
    authenticate: authenticateToken,
    authorize: requireRoles('admin', 'instructor', 'teacher', 'staff'),
});
