"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createExpensesRouter = void 0;
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
const createExpensesRouter = (deps) => {
    const router = (0, express_1.Router)();
    const { query, queryOne, execute } = deps.db;
    // Expenses are tenant financial records: authentication and an allowed
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
     * assignment exists for expenses.
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
    // Get all expenses
    router.get('/', async (req, res) => {
        try {
            const scope = await resolveReadScope(req, res);
            if (!scope)
                return;
            const clause = readClause(scope);
            const expenses = await query(`SELECT * FROM expenses WHERE 1=1${clause.sql} ORDER BY date DESC, time DESC`, clause.params);
            res.json(expenses);
        }
        catch (error) {
            console.error('Get expenses error:', error);
            res.status(500).json({ error: 'Failed to fetch expenses' });
        }
    });
    // Get expense by ID
    router.get('/:id', async (req, res) => {
        try {
            const scope = await resolveReadScope(req, res);
            if (!scope)
                return;
            const clause = readClause(scope);
            const expense = await queryOne(`SELECT * FROM expenses WHERE id = ?${clause.sql}`, [req.params.id, ...clause.params]);
            if (!expense) {
                return res.status(404).json({ error: 'Expense not found' });
            }
            res.json(expense);
        }
        catch (error) {
            console.error('Get expense error:', error);
            res.status(500).json({ error: 'Failed to fetch expense' });
        }
    });
    // Create new expense
    router.post('/', async (req, res) => {
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
            if (!scope)
                return;
            const tenantId = scope.tenantId;
            const result = await execute(`INSERT INTO expenses (tenant_id, description, amount, category, date, time)
                 VALUES (?, ?, ?, ?, ?, ?)`, [tenantId, description, amount, category || null, date, time || null]);
            const newExpense = await queryOne('SELECT * FROM expenses WHERE id = ? AND tenant_id=?', [result.insertId, tenantId]);
            res.status(201).json(newExpense);
        }
        catch (error) {
            console.error('Create expense error:', error);
            res.status(500).json({ error: 'Failed to create expense' });
        }
    });
    // Update expense
    router.put('/:id', async (req, res) => {
        try {
            const { description, amount, category, date, time } = req.body;
            if (amount !== undefined && !isValidMoney(amount)) {
                return res.status(400).json({ error: 'Amount must be a non-negative number' });
            }
            const updates = [];
            const values = [];
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
            if (!scope)
                return;
            // The tenant predicate confines the mutation to the caller's own
            // tenant rows; a foreign id matches nothing and stays untouched.
            values.push(req.params.id, ...readClause(scope).params);
            await execute(`UPDATE expenses SET ${updates.join(', ')} WHERE id = ?${readClause(scope).sql}`, values);
            const updatedExpense = await queryOne(`SELECT * FROM expenses WHERE id = ?${readClause(scope).sql}`, [req.params.id, ...readClause(scope).params]);
            if (!updatedExpense) {
                return res.status(404).json({ error: 'Expense not found' });
            }
            res.json(updatedExpense);
        }
        catch (error) {
            console.error('Update expense error:', error);
            res.status(500).json({ error: 'Failed to update expense' });
        }
    });
    // Delete expense
    router.delete('/:id', async (req, res) => {
        try {
            // Writes need the same owner authority; a principal without it is
            // denied before any data access.
            const scope = await resolveWriteScope(req, res);
            if (!scope)
                return;
            const result = await execute(`DELETE FROM expenses WHERE id = ?${readClause(scope).sql}`, [req.params.id, ...readClause(scope).params]);
            if (result.affectedRows === 0) {
                return res.status(404).json({ error: 'Expense not found' });
            }
            res.json({ message: 'Expense deleted successfully' });
        }
        catch (error) {
            console.error('Delete expense error:', error);
            res.status(500).json({ error: 'Failed to delete expense' });
        }
    });
    return router;
};
exports.createExpensesRouter = createExpensesRouter;
const productionDb = { query: db_1.query, queryOne: db_1.queryOne, execute: db_1.execute };
exports.default = (0, exports.createExpensesRouter)({
    db: productionDb,
    authenticate: auth_1.authenticateToken,
    authorize: (0, auth_1.requireRoles)('admin', 'instructor', 'teacher', 'staff'),
});
