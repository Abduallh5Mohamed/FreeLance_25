"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createRevenuesRouter = void 0;
const express_1 = require("express");
const auth_1 = require("../middleware/auth");
const db_1 = require("../db");
const admin_permissions_1 = require("../security/admin-permissions");
/**
 * Money columns are DECIMAL: reject non-numeric, non-finite, negative, or
 * >2dp input before the driver can coerce it into a money row. Only JSON
 * numbers in integer minor units or decimal-safe form are accepted — numeric
 * strings are rejected so the driver never coerces text into a ledger row.
 */
const isValidMoney = (value) => {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0)
        return false;
    return Math.abs(value - Math.round(value * 100) / 100) < 1e-9;
};
const createRevenuesRouter = (deps) => {
    const router = (0, express_1.Router)();
    const { query, queryOne, execute } = deps.db;
    // Revenues are tenant financial records: authentication and an allowed
    // staff role are required before any handler runs (deny by default).
    router.use(deps.authenticate, deps.authorize);
    const hasVerifiedPlatformFinanceAccess = deps.hasVerifiedPlatformFinanceAccess
        ?? ((userId) => (0, admin_permissions_1.hasVerifiedPlatformPermission)('finance.read', userId));
    /**
     * Active authority inside a tenant, resolved from server-side rows only:
     * the verified tenant owner, or an active membership with role_key
     * owner/instructor in an active tenant by an active user. A bare
     * teacher/staff/instructor JWT role claim never satisfies this.
     */
    const loadActiveTenantAuthority = deps.loadActiveTenantAuthority
        ?? (async (userId, tenantId) => queryOne(`SELECT 'owner' AS authority
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
             LIMIT 1`, [tenantId, userId, userId, tenantId]));
    /**
     * Verify the platform finance-read capability before any data access.
     * A lookup failure denies with 503 instead of failing open onto a role
     * claim.
     */
    const verifyPlatformFinanceAccess = async (req, res) => {
        const user = req.user;
        if (!user) {
            res.status(401).json({ error: 'Authentication required' });
            return null;
        }
        try {
            return await hasVerifiedPlatformFinanceAccess(user.id);
        }
        catch (error) {
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
    const resolveReadScope = async (req, res) => {
        const platform = await verifyPlatformFinanceAccess(req, res);
        if (platform === null)
            return null;
        const user = req.user;
        if (platform)
            return { platform: true, authority: null, userId: user.id, tenantId: null };
        const tenantId = user.tenantId;
        if (!tenantId) {
            res.status(403).json({ error: 'Workspace access required' });
            return null;
        }
        let authorityRow;
        try {
            authorityRow = await loadActiveTenantAuthority(user.id, tenantId);
        }
        catch (error) {
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
    const resolveWriteScope = async (req, res) => {
        const scope = await resolveReadScope(req, res);
        if (!scope)
            return null;
        if (scope.platform) {
            res.status(403).json({ error: 'Active tenant membership required' });
            return null;
        }
        return scope;
    };
    const readClause = (scope) => scope.platform
        ? { sql: '', params: [] }
        : { sql: ' AND tenant_id=?', params: [scope.tenantId] };
    // Get all revenues
    router.get('/', async (req, res) => {
        try {
            const { start_date, end_date, source } = req.query;
            const scope = await resolveReadScope(req, res);
            if (!scope)
                return;
            const clause = readClause(scope);
            let sql = `SELECT * FROM revenues WHERE 1=1${clause.sql}`;
            const params = [...clause.params];
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
        }
        catch (error) {
            console.error('Error fetching revenues:', error);
            res.status(500).json({ error: 'Failed to fetch revenues' });
        }
    });
    // Create new revenue
    router.post('/', async (req, res) => {
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
            if (!scope)
                return;
            const tenantId = scope.tenantId;
            const result = await execute('INSERT INTO revenues (tenant_id, amount, source, description, date) VALUES (?, ?, ?, ?, ?)', [tenantId, amount, source, description || null, date]);
            res.status(201).json({
                message: 'Revenue created successfully',
                id: result.insertId
            });
        }
        catch (error) {
            console.error('Error creating revenue:', error);
            res.status(500).json({ error: 'Failed to create revenue' });
        }
    });
    // Get revenue statistics
    router.get('/stats', async (req, res) => {
        try {
            const scope = await resolveReadScope(req, res);
            if (!scope)
                return;
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
            `, clause.params);
            res.json(stats);
        }
        catch (error) {
            console.error('Error fetching revenue stats:', error);
            res.status(500).json({ error: 'Failed to fetch revenue statistics' });
        }
    });
    return router;
};
exports.createRevenuesRouter = createRevenuesRouter;
const productionDb = { query: db_1.query, queryOne: db_1.queryOne, execute: db_1.execute };
exports.default = (0, exports.createRevenuesRouter)({
    db: productionDb,
    authenticate: auth_1.authenticateToken,
    authorize: (0, auth_1.requireRoles)('admin', 'instructor', 'teacher', 'staff'),
});
