import { Router, RequestHandler, Response } from 'express';
import { AuthRequest, authenticateToken, requireRoles } from '../middleware/auth';
import { query, queryOne, execute } from '../db';
import { hasVerifiedPlatformPermission } from '../security/admin-permissions';

/**
 * Data-access seam for the expenses router. Production binds ../db; hermetic
 * tests inject isolated fixtures through the same boundary so the real
 * authorization logic runs without a database.
 */
export interface ExpensesDataAccess {
    query: typeof query;
    queryOne: typeof queryOne;
    execute: typeof execute;
}

/**
 * Injectable seams for the expenses router. The default export binds the
 * production SQL adapters, the real authentication middleware, and the real
 * role gate. Tests inject fixtures through this boundary instead of
 * bypassing production authorization.
 */
export interface ExpensesRouterDeps {
    db: ExpensesDataAccess;
    authenticate: RequestHandler;
    authorize: RequestHandler;
    /**
     * Server-verified platform finance-read capability (active super_admin or
     * a seeded platform permission key), resolved against admin_user_roles.
     * A JWT role claim never satisfies this predicate. Production binds the
     * real SQL-backed check; hermetic tests inject isolated fixtures through
     * this same boundary so the production guard runs without a database.
     */
    hasVerifiedPlatformFinanceAccess?: (userId: string) => Promise<boolean>;
    /**
     * Active authority of a principal inside one tenant: the verified owner
     * row, or an active membership with role_key IN ('owner','instructor') in
     * an active tenant by an active user. Mirrors the server-owned authority
     * lookup used by video-access-policy / videos.ts / teaching-access so no
     * new authority vocabulary is invented. Production binds the SQL-backed
     * lookup; hermetic tests inject isolated fixtures through this boundary.
     */
    loadActiveTenantAuthority?: (userId: string, tenantId: string) => Promise<{ authority: string } | null>;
}

/**
 * Money columns are DECIMAL: reject non-numeric, non-finite, or negative
 * input before the driver can coerce it into a money row.
 */
const isValidMoney = (value: unknown): boolean =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0;

export const createExpensesRouter = (deps: ExpensesRouterDeps): Router => {
    const router = Router();
    const { query, queryOne, execute } = deps.db;
    // Expenses are tenant financial records: authentication and an allowed
    // staff role are required before any handler runs (deny by default).
    router.use(deps.authenticate, deps.authorize);

    const hasVerifiedPlatformFinanceAccess = deps.hasVerifiedPlatformFinanceAccess
        ?? ((userId: string) => hasVerifiedPlatformPermission('finance.read', userId));

    /**
     * Active authority inside a tenant, resolved from server-side rows only:
     * the verified tenant owner, or an active membership with role_key
     * owner/instructor in an active tenant by an active user. A bare
     * teacher/staff/instructor JWT role claim never satisfies this.
     */
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

    /**
     * Resolved financial-record authority of the authenticated principal.
     * `platform` is a server-verified capability (reads only), `authority`
     * is the server-verified tenant role, and `tenantId` is the
     * server-derived active workspace. Expenses carry no per-student or
     * per-group assignment column, so only the verified tenant owner holds
     * expense authority — an instructor membership alone grants nothing.
     */
    interface ExpensesScope {
        platform: boolean;
        authority: 'owner' | null;
        userId: string;
        tenantId: string | null;
    }

    /**
     * Verify the platform finance-read capability before any data access.
     * A lookup failure denies with 503 instead of failing open onto a role
     * claim.
     */
    const verifyPlatformFinanceAccess = async (
        req: AuthRequest,
        res: Response,
    ): Promise<boolean | null> => {
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

    /**
     * Resolve read authority. A verified platform operator reads across
     * tenants; the verified tenant owner reads the whole tenant. Active
     * membership alone — or an instructor membership without tenant
     * ownership — is denied before any query runs, because no per-record
     * assignment exists for expenses.
     */
    const resolveReadScope = async (
        req: AuthRequest,
        res: Response,
    ): Promise<ExpensesScope | null> => {
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
        if (!authorityRow || authorityRow.authority !== 'owner') {
            res.status(403).json({ error: 'Expense records require tenant owner authority' });
            return null;
        }
        return { platform: false, authority: 'owner', userId: user.id, tenantId };
    };

    /**
     * Writes need the same owner authority: the verified platform capability
     * grants reads only, so a platform principal without a tenant membership
     * is denied before any mutation (unchanged fail-closed write contract).
     */
    const resolveWriteScope = async (
        req: AuthRequest,
        res: Response,
    ): Promise<ExpensesScope | null> => {
        const scope = await resolveReadScope(req, res);
        if (!scope) return null;
        if (scope.platform) {
            res.status(403).json({ error: 'Active tenant membership required' });
            return null;
        }
        return scope;
    };

    const readClause = (scope: ExpensesScope): { sql: string; params: unknown[] } =>
        scope.platform
            ? { sql: '', params: [] }
            : { sql: ' AND tenant_id=?', params: [scope.tenantId as string] };

    interface Expense {
        id: string;
        description: string;
        amount: number;
        category: string;
        date: string;
        time: string;
        created_at: string;
        updated_at: string;
    }

    // Get all expenses
    router.get('/', async (req: AuthRequest, res: Response) => {
        try {
            const scope = await resolveReadScope(req, res);
            if (!scope) return;
            const clause = readClause(scope);

            const expenses = await query<Expense>(
                `SELECT * FROM expenses WHERE 1=1${clause.sql} ORDER BY date DESC, time DESC`,
                clause.params
            );
            res.json(expenses);
        } catch (error) {
            console.error('Get expenses error:', error);
            res.status(500).json({ error: 'Failed to fetch expenses' });
        }
    });

    // Get expense by ID
    router.get('/:id', async (req: AuthRequest, res: Response) => {
        try {
            const scope = await resolveReadScope(req, res);
            if (!scope) return;
            const clause = readClause(scope);

            const expense = await queryOne<Expense>(
                `SELECT * FROM expenses WHERE id = ?${clause.sql}`,
                [req.params.id, ...clause.params]
            );

            if (!expense) {
                return res.status(404).json({ error: 'Expense not found' });
            }

            res.json(expense);
        } catch (error) {
            console.error('Get expense error:', error);
            res.status(500).json({ error: 'Failed to fetch expense' });
        }
    });

    // Create new expense
    router.post('/', async (req: AuthRequest, res: Response) => {
        try {
            const { description, amount, category, date, time } = req.body;

            if (!description || !amount || !date) {
                return res.status(400).json({ error: 'Description, amount, and date are required' });
            }

            if (!isValidMoney(amount)) {
                return res.status(400).json({ error: 'Amount must be a non-negative number' });
            }

            // A write must be attributable to a server-resolved tenant and
            // verified owner authority; an admin without an active membership
            // fails closed instead of creating an ownerless financial row.
            const scope = await resolveWriteScope(req, res);
            if (!scope) return;
            const tenantId = scope.tenantId as string;

            const result = await execute(
                `INSERT INTO expenses (tenant_id, description, amount, category, date, time)
                 VALUES (?, ?, ?, ?, ?, ?)`,
                [tenantId, description, amount, category || null, date, time || null]
            );

            const newExpense = await queryOne<Expense>(
                'SELECT * FROM expenses WHERE id = ? AND tenant_id=?',
                [result.insertId, tenantId]
            );

            res.status(201).json(newExpense);
        } catch (error) {
            console.error('Create expense error:', error);
            res.status(500).json({ error: 'Failed to create expense' });
        }
    });

    // Update expense
    router.put('/:id', async (req: AuthRequest, res: Response) => {
        try {
            const { description, amount, category, date, time } = req.body;

            if (amount !== undefined && !isValidMoney(amount)) {
                return res.status(400).json({ error: 'Amount must be a non-negative number' });
            }

            const updates: string[] = [];
            const values: unknown[] = [];

            if (description !== undefined) {
                updates.push('description = ?');
                values.push(description);
            }
            if (amount !== undefined) {
                updates.push('amount = ?');
                values.push(amount);
            }
            if (category !== undefined) {
                updates.push('category = ?');
                values.push(category);
            }
            if (date !== undefined) {
                updates.push('date = ?');
                values.push(date);
            }
            if (time !== undefined) {
                updates.push('time = ?');
                values.push(time);
            }

            if (updates.length === 0) {
                return res.status(400).json({ error: 'No fields to update' });
            }

            // Writes need the same owner authority; a principal without it is
            // denied before any data access.
            const scope = await resolveWriteScope(req, res);
            if (!scope) return;

            // The tenant predicate confines the mutation to the caller's own
            // tenant rows; a foreign id matches nothing and stays untouched.
            values.push(req.params.id, ...readClause(scope).params);

            await execute(
                `UPDATE expenses SET ${updates.join(', ')} WHERE id = ?${readClause(scope).sql}`,
                values
            );

            const updatedExpense = await queryOne<Expense>(
                `SELECT * FROM expenses WHERE id = ?${readClause(scope).sql}`,
                [req.params.id, ...readClause(scope).params]
            );

            if (!updatedExpense) {
                return res.status(404).json({ error: 'Expense not found' });
            }

            res.json(updatedExpense);
        } catch (error) {
            console.error('Update expense error:', error);
            res.status(500).json({ error: 'Failed to update expense' });
        }
    });

    // Delete expense
    router.delete('/:id', async (req: AuthRequest, res: Response) => {
        try {
            // Writes need the same owner authority; a principal without it is
            // denied before any data access.
            const scope = await resolveWriteScope(req, res);
            if (!scope) return;

            const result = await execute(
                `DELETE FROM expenses WHERE id = ?${readClause(scope).sql}`,
                [req.params.id, ...readClause(scope).params]
            );

            if (result.affectedRows === 0) {
                return res.status(404).json({ error: 'Expense not found' });
            }

            res.json({ message: 'Expense deleted successfully' });
        } catch (error) {
            console.error('Delete expense error:', error);
            res.status(500).json({ error: 'Failed to delete expense' });
        }
    });

    return router;
};

const productionDb: ExpensesDataAccess = { query, queryOne, execute };

export default createExpensesRouter({
    db: productionDb,
    authenticate: authenticateToken,
    authorize: requireRoles('admin', 'instructor', 'teacher', 'staff'),
});
