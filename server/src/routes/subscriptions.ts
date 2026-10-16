import { Router, RequestHandler, Response } from 'express';
import { randomUUID } from 'crypto';
import { AuthRequest, authenticateToken, requireRoles } from '../middleware/auth';
import { query, queryOne, execute, getPool } from '../db';
import { hasVerifiedPlatformPermission } from '../security/admin-permissions';

/**
 * Data-access seam for the subscriptions router. Production binds ../db;
 * hermetic tests inject isolated fixtures through the same boundary so the
 * real authorization logic runs without a database.
 */
export interface SubscriptionsDataAccess {
    query: typeof query;
    queryOne: typeof queryOne;
    execute: typeof execute;
    /**
     * Run `work` inside a single database transaction. Every statement issued
     * through the adapter handed to `work` runs on the transaction connection,
     * so multi-row financial writes commit or roll back together.
     */
    withTransaction: <T>(
        work: (tx: Pick<SubscriptionsDataAccess, 'query' | 'queryOne' | 'execute'>) => Promise<T>,
    ) => Promise<T>;
}

export interface SubscriptionsRouterDeps {
    db: SubscriptionsDataAccess;
    authenticate: RequestHandler;
    authorize: RequestHandler;
    hasVerifiedPlatformFinanceAccess?: (userId: string) => Promise<boolean>;
    loadActiveTenantAuthority?: (userId: string, tenantId: string) => Promise<{ authority: string } | null>;
}

/**
 * Money crosses the API as integer minor units or a decimal string with at
 * most two fraction digits; MySQL DECIMAL(10,2) does the arithmetic. Native
 * floats are accepted only when they are decimal-safe (finite, >= 0, <= 2dp)
 * so 19.999 / NaN / Infinity / negatives never reach a money column.
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
        return rounded.toFixed(2).replace(/\.00$/, '.00');
    }
    return null;
};

const VALID_STATUSES = new Set(['pending', 'paid', 'overdue', 'cancelled']);

export const createSubscriptionsRouter = (deps: SubscriptionsRouterDeps): Router => {
    const router = Router();
    const { query, queryOne, execute, withTransaction } = deps.db;
    router.use(deps.authenticate, deps.authorize);

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

    interface SubScope {
        platform: boolean;
        authority: 'owner' | 'instructor' | null;
        userId: string;
        tenantId: string | null;
    }

    const verifyPlatformFinanceAccess = async (req: AuthRequest, res: Response): Promise<boolean | null> => {
        const user = req.user;
        if (!user) {
            res.status(401).json({ error: 'Authentication required' });
            return null;
        }
        try {
            return await hasVerifiedPlatformFinanceAccess(user.id);
        } catch (error) {
            console.error('Finance permission lookup failed:', error);
            res.status(503).json({ error: 'Finance permissions unavailable' });
            return null;
        }
    };

    const resolveReadScope = async (req: AuthRequest, res: Response): Promise<SubScope | null> => {
        const platform = await verifyPlatformFinanceAccess(req, res);
        if (platform === null) return null;
        const user = req.user as NonNullable<AuthRequest['user']>;
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
            res.status(403).json({ error: 'Subscription records require owner or assigned-instructor authority' });
            return null;
        }
        return { platform: false, authority: authorityRow.authority, userId: user.id, tenantId };
    };

    const resolveWriteScope = async (req: AuthRequest, res: Response): Promise<SubScope | null> => {
        const scope = await resolveReadScope(req, res);
        if (!scope) return null;
        if (scope.platform) {
            res.status(403).json({ error: 'Active tenant membership required' });
            return null;
        }
        return scope;
    };

    // The legacy `subscriptions` table carries no tenant_id column; tenancy is
    // derived server-side through the linked student row (students.tenant_id).
    // Every read and write joins/probes that link, so tenant B rows never
    // match a tenant A principal.
    const tenantJoin = (scope: SubScope): { join: string; params: unknown[] } =>
        scope.platform
            ? { join: '', params: [] }
            : { join: 'INNER JOIN students s ON s.id = subscriptions.student_id AND s.tenant_id = ?', params: [scope.tenantId as string] };

    // Get all subscriptions (tenant-scoped; platform reads across tenants)
    router.get('/', async (req: AuthRequest, res: Response) => {
        try {
            const scope = await resolveReadScope(req, res);
            if (!scope) return;
            const { join, params } = tenantJoin(scope);
            const subscriptions = await query(
                `SELECT subscriptions.* FROM subscriptions ${join} ORDER BY subscriptions.created_at DESC`,
                params,
            );
            res.json(subscriptions);
        } catch (error) {
            console.error('Get subscriptions error:', error);
            res.status(500).json({ error: 'Failed to fetch subscriptions' });
        }
    });

    // Get subscription by ID (tenant-scoped)
    router.get('/:id', async (req: AuthRequest, res: Response) => {
        try {
            const scope = await resolveReadScope(req, res);
            if (!scope) return;
            const { join, params } = tenantJoin(scope);
            const subscription = await queryOne(
                `SELECT subscriptions.* FROM subscriptions ${join} WHERE subscriptions.id = ?`,
                [...params, req.params.id],
            );

            if (!subscription) {
                return res.status(404).json({ error: 'Subscription not found' });
            }

            res.json(subscription);
        } catch (error) {
            console.error('Get subscription error:', error);
            res.status(500).json({ error: 'Failed to fetch subscription' });
        }
    });

    // Create new subscription (tenant-scoped, Decimal money, idempotent)
    router.post('/', async (req: AuthRequest, res: Response) => {
        try {
            const scope = await resolveWriteScope(req, res);
            if (!scope) return;
            const tenantId = scope.tenantId as string;
            const { id, student_id, course_id, amount, payment_date, due_date, status = 'pending', payment_method, notes } = req.body;

            if (!student_id || !course_id || amount === undefined || amount === null) {
                return res.status(400).json({ error: 'Student ID, course ID, and amount are required' });
            }
            const decimalAmount = toDecimalMoney(amount);
            if (decimalAmount === null) {
                return res.status(400).json({ error: 'Amount must be a non-negative decimal with at most two fraction digits' });
            }
            if (!VALID_STATUSES.has(String(status))) {
                return res.status(400).json({ error: 'Invalid subscription status' });
            }
            // Tenant probes run before any write: both the student and the
            // course must belong to the caller's resolved tenant.
            const student = await queryOne(
                'SELECT id FROM students WHERE id = ? AND tenant_id = ?',
                [student_id, tenantId],
            );
            if (!student) return res.status(404).json({ error: 'Student not found in your tenant' });
            const course = await queryOne(
                'SELECT id FROM courses WHERE id = ? AND tenant_id = ?',
                [course_id, tenantId],
            );
            if (!course) return res.status(404).json({ error: 'Course not found in your tenant' });

            // Idempotent create: a client-supplied id that already exists in
            // this tenant returns the existing row instead of double-inserting.
            const subscriptionId = typeof id === 'string' && id.length >= 8 ? id : randomUUID();
            const outcome = await withTransaction(async (tx) => {
                const existing = await tx.queryOne(
                    `SELECT subscriptions.* FROM subscriptions
                     INNER JOIN students s ON s.id = subscriptions.student_id AND s.tenant_id = ?
                     WHERE subscriptions.id = ?`,
                    [tenantId, subscriptionId],
                );
                if (existing) return { created: false as const, row: existing };
                await tx.execute(
                    `INSERT INTO subscriptions (id, student_id, course_id, amount, payment_date, due_date, status, payment_method, notes, created_at, updated_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
                    [subscriptionId, student_id, course_id, decimalAmount, payment_date || null, due_date || null, status, payment_method || null, notes || null],
                );
                const row = await tx.queryOne(
                    'SELECT * FROM subscriptions WHERE id = ?',
                    [subscriptionId],
                );
                return { created: true as const, row };
            });

            res.status(outcome.created ? 201 : 200).json(outcome.row);
        } catch (error) {
            console.error('Create subscription error:', error);
            res.status(500).json({ error: 'Failed to create subscription' });
        }
    });

    // Update subscription (same table, tenant-scoped, guarded transition)
    router.put('/:id', async (req: AuthRequest, res: Response) => {
        try {
            const scope = await resolveWriteScope(req, res);
            if (!scope) return;
            const tenantId = scope.tenantId as string;
            const { status, payment_date, due_date, payment_method, notes, amount } = req.body;

            if (status !== undefined && !VALID_STATUSES.has(String(status))) {
                return res.status(400).json({ error: 'Invalid subscription status' });
            }
            let decimalAmount: string | null | undefined;
            if (amount !== undefined) {
                decimalAmount = toDecimalMoney(amount);
                if (decimalAmount === null) {
                    return res.status(400).json({ error: 'Amount must be a non-negative decimal with at most two fraction digits' });
                }
            }

            const updates: string[] = [];
            const values: unknown[] = [];
            if (decimalAmount !== undefined) { updates.push('subscriptions.amount = ?'); values.push(decimalAmount); }
            if (status !== undefined) { updates.push('subscriptions.status = ?'); values.push(status); }
            if (payment_date !== undefined) { updates.push('subscriptions.payment_date = ?'); values.push(payment_date); }
            if (due_date !== undefined) { updates.push('subscriptions.due_date = ?'); values.push(due_date); }
            if (payment_method !== undefined) { updates.push('subscriptions.payment_method = ?'); values.push(payment_method); }
            if (notes !== undefined) { updates.push('subscriptions.notes = ?'); values.push(notes); }
            if (updates.length === 0) {
                return res.status(400).json({ error: 'No fields to update' });
            }

            // Tenant predicate confines the mutation; a foreign id matches
            // nothing and the row survives untouched.
            const result = await execute(
                `UPDATE subscriptions INNER JOIN students s ON s.id = subscriptions.student_id AND s.tenant_id = ?
                 SET ${updates.join(', ')}, subscriptions.updated_at = NOW()
                 WHERE subscriptions.id = ?`,
                [tenantId, ...values, req.params.id],
            );
            if (result.affectedRows === 0) {
                return res.status(404).json({ error: 'Subscription not found' });
            }

            const updated = await queryOne(
                `SELECT subscriptions.* FROM subscriptions
                 INNER JOIN students s ON s.id = subscriptions.student_id AND s.tenant_id = ?
                 WHERE subscriptions.id = ?`,
                [tenantId, req.params.id],
            );
            res.json(updated);
        } catch (error) {
            console.error('Update subscription error:', error);
            res.status(500).json({ error: 'Failed to update subscription' });
        }
    });

    // Delete subscription (tenant-scoped hard scoping; missing -> 404)
    router.delete('/:id', async (req: AuthRequest, res: Response) => {
        try {
            const scope = await resolveWriteScope(req, res);
            if (!scope) return;
            const tenantId = scope.tenantId as string;
            const result = await execute(
                `DELETE subscriptions FROM subscriptions
                 INNER JOIN students s ON s.id = subscriptions.student_id AND s.tenant_id = ?
                 WHERE subscriptions.id = ?`,
                [tenantId, req.params.id],
            );
            if (result.affectedRows === 0) {
                return res.status(404).json({ error: 'Subscription not found' });
            }
            res.json({ message: 'Subscription deleted successfully' });
        } catch (error) {
            console.error('Delete subscription error:', error);
            res.status(500).json({ error: 'Failed to delete subscription' });
        }
    });

    return router;
};

const withTransaction: SubscriptionsDataAccess['withTransaction'] = async (work) => {
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

const productionDb: SubscriptionsDataAccess = { query, queryOne, execute, withTransaction };

export default createSubscriptionsRouter({
    db: productionDb,
    authenticate: authenticateToken,
    authorize: requireRoles('admin', 'teacher'),
});
