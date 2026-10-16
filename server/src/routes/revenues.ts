import { Router, RequestHandler, Response } from 'express';
import { AuthRequest, authenticateToken, requireRoles } from '../middleware/auth';
import { query, queryOne, execute } from '../db';
import { hasVerifiedPlatformPermission } from '../security/admin-permissions';

/**
 * Data-access seam for the revenues router. Production binds ../db; hermetic
 * tests inject isolated fixtures through the same boundary so the real
 * authorization logic runs without a database.
 */
export interface RevenuesDataAccess {
    query: typeof query;
    queryOne: typeof queryOne;
    execute: typeof execute;
}

/**
 * Injectable seams for the revenues router. The default export binds the
 * production SQL adapters, the real authentication middleware, and the real
 * role gate. Tests inject fixtures through this boundary instead of
 * bypassing production authorization.
 */
export interface RevenuesRouterDeps {
    db: RevenuesDataAccess;
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
 * Money columns are DECIMAL: reject non-numeric, non-finite, negative, or
 * >2dp input before the driver can coerce it into a money row. Only JSON
 * numbers in integer minor units or decimal-safe form are accepted — numeric
 * strings are rejected so the driver never coerces text into a ledger row.
 */
const isValidMoney = (value: unknown): boolean => {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return false;
    return Math.abs(value - Math.round(value * 100) / 100) < 1e-9;
};

export const createRevenuesRouter = (deps: RevenuesRouterDeps): Router => {
    const router = Router();
    const { query, queryOne, execute } = deps.db;
    // Revenues are tenant financial records: authentication and an allowed
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
     * server-derived active workspace. Revenues carry no per-student or
     * per-group assignment column, so only the verified tenant owner holds
     * revenue authority — an instructor membership alone grants nothing.
     */
    interface RevenuesScope {
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
     * assignment exists for revenues.
     */
    const resolveReadScope = async (
        req: AuthRequest,
        res: Response,
    ): Promise<RevenuesScope | null> => {
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
            res.status(403).json({ error: 'Revenue records require tenant owner authority' });
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
    ): Promise<RevenuesScope | null> => {
        const scope = await resolveReadScope(req, res);
        if (!scope) return null;
        if (scope.platform) {
            res.status(403).json({ error: 'Active tenant membership required' });
            return null;
        }
        return scope;
    };

    const readClause = (scope: RevenuesScope): { sql: string; params: unknown[] } =>
        scope.platform
            ? { sql: '', params: [] }
            : { sql: ' AND tenant_id=?', params: [scope.tenantId as string] };

    // Get all revenues
    router.get('/', async (req: AuthRequest, res: Response) => {
        try {
            const { start_date, end_date, source } = req.query;

            const scope = await resolveReadScope(req, res);
            if (!scope) return;
            const clause = readClause(scope);

            let sql = `SELECT * FROM revenues WHERE 1=1${clause.sql}`;
            const params: unknown[] = [...clause.params];

            if (start_date) {
                sql += ' AND date >= ?';
                params.push(start_date);
            }

            if (end_date) {
                sql += ' AND date <= ?';
                params.push(end_date);
            }

            if (source) {
                sql += ' AND source = ?';
                params.push(source);
            }

            sql += ' ORDER BY date DESC';

            const revenues = await query(sql, params);
            res.json(revenues);
        } catch (error) {
            console.error('Error fetching revenues:', error);
            res.status(500).json({ error: 'Failed to fetch revenues' });
        }
    });

    // Create new revenue
    router.post('/', async (req: AuthRequest, res: Response) => {
        try {
            const { amount, source, description, date } = req.body;

            if (!amount || !source || !date) {
                return res.status(400).json({ error: 'Amount, source, and date are required' });
            }

            if (!isValidMoney(amount)) {
                return res.status(400).json({ error: 'Amount must be a non-negative number' });
            }

            // A write must be attributable to a server-resolved tenant and
            // verified owner authority; an admin without an active membership
            // fails closed instead of writing an ownerless financial row.
            const scope = await resolveWriteScope(req, res);
            if (!scope) return;
            const tenantId = scope.tenantId as string;

            const result = await execute(
                'INSERT INTO revenues (tenant_id, amount, source, description, date) VALUES (?, ?, ?, ?, ?)',
                [tenantId, amount, source, description || null, date]
            );

            res.status(201).json({
                message: 'Revenue created successfully',
                id: result.insertId
            });
        } catch (error) {
            console.error('Error creating revenue:', error);
            res.status(500).json({ error: 'Failed to create revenue' });
        }
    });

    // Get revenue statistics
    router.get('/stats', async (req: AuthRequest, res: Response) => {
        try {
            const scope = await resolveReadScope(req, res);
            if (!scope) return;
            const clause = readClause(scope);

            const stats = await query(`
              SELECT
                SUM(amount) as total_revenue,
                COUNT(*) as total_count,
                source,
                DATE_FORMAT(date, '%Y-%m') as month
              FROM revenues
              WHERE 1=1${clause.sql}
              GROUP BY source, month
              ORDER BY month DESC, source
            `, clause.params) as unknown[];

            res.json(stats);
        } catch (error) {
            console.error('Error fetching revenue stats:', error);
            res.status(500).json({ error: 'Failed to fetch revenue statistics' });
        }
    });

    return router;
};

const productionDb: RevenuesDataAccess = { query, queryOne, execute };

export default createRevenuesRouter({
    db: productionDb,
    authenticate: authenticateToken,
    authorize: requireRoles('admin', 'instructor', 'teacher', 'staff'),
});
