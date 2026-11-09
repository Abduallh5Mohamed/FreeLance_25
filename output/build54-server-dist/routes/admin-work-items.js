"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.createAdminWorkItemsRouter = void 0;
const crypto_1 = require("crypto");
const express_1 = require("express");
const async_route_boundary_1 = require("../security/async-route-boundary");
const auth_1 = require("../middleware/auth");
const admin_permissions_1 = require("../security/admin-permissions");
const priorities = new Set(['low', 'normal', 'high', 'urgent', 'critical']);
const statuses = new Set(['open', 'in_progress', 'waiting', 'blocked', 'pending_approval', 'escalated', 'resolved', 'closed', 'cancelled']);
const types = new Set(['instructor_onboarding', 'subscription_issue', 'payment_verification', 'payment_dispute', 'support_case', 'account_problem', 'security_issue', 'refund_request', 'financial_adjustment', 'technical_issue', 'content_issue', 'other']);
const createAdminWorkItemsRouter = (deps) => {
    const router = (0, express_1.Router)();
    const query = (sql, params) => deps.db.query(sql, params);
    const queryOne = (sql, params) => deps.db.queryOne(sql, params);
    const getAdminPermissions = deps.getAdminPermissions;
    router.use((0, async_route_boundary_1.asyncRouteBoundary)(deps.authenticate));
    router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
    async function atomic(fn) {
        const connection = await deps.db.getConnection();
        try {
            await connection.beginTransaction();
            const access = {
                query: async (sql, params) => {
                    const [rows] = await connection.execute(sql, params);
                    return rows;
                },
                queryOne: async (sql, params) => {
                    const [rows] = await connection.execute(sql, params);
                    return rows[0] ?? null;
                },
            };
            const result = await fn(connection, access);
            await connection.commit();
            return result;
        }
        catch (error) {
            try {
                await connection.rollback();
            }
            catch { /* Keep original failure. */ }
            throw error;
        }
        finally {
            connection.release();
        }
    }
    async function visibleItem(req, id, access = deps.db, lock = false) {
        const permissions = await getAdminPermissions(req.user.id);
        const management = permissions.includes('admin_roles.manage');
        const rows = await access.query(`SELECT w.*
       FROM admin_work_items w WHERE w.id = ? AND
         (? = 1 OR w.created_by = ? OR w.assigned_admin_id = ? OR
          EXISTS (SELECT 1 FROM admin_team_memberships tm
                  WHERE tm.team_id = w.assigned_team_id AND tm.user_id = ?))
       ${lock ? 'FOR UPDATE' : ''}`, [id, management ? 1 : 0, req.user.id, req.user.id, req.user.id]);
        const item = rows[0] ?? null;
        if (item && lock && !management && item.created_by !== req.user.id && item.assigned_admin_id !== req.user.id) {
            // FOR UPDATE on the outer item does not lock a nested EXISTS proof.
            // Re-read and hold the exact membership used for access on this unit.
            const member = await access.queryOne('SELECT team_id FROM admin_team_memberships WHERE team_id=? AND user_id=? FOR UPDATE', [item.assigned_team_id, req.user.id]);
            if (!member)
                return null;
        }
        return item;
    }
    router.get('/', deps.taskRead, (0, async_route_boundary_1.asyncRouteBoundary)(async (req, res) => {
        try {
            const parsePage = (value, fallback, max) => {
                if (value === undefined)
                    return fallback;
                if (typeof value !== 'string' || !/^\d+$/.test(value))
                    return null;
                const number = Number(value);
                return Number.isSafeInteger(number) && number >= 1 && number <= max ? number : null;
            };
            const page = parsePage(req.query.page, 1, 10000);
            const limit = parsePage(req.query.limit, 25, 100);
            if (page === null || limit === null)
                return res.status(400).json({ error: 'Invalid pagination' });
            if (req.query.status !== undefined && (typeof req.query.status !== 'string' || !statuses.has(req.query.status))) {
                return res.status(400).json({ error: 'Invalid status' });
            }
            const status = typeof req.query.status === 'string' && statuses.has(req.query.status) ? req.query.status : null;
            const permissions = await getAdminPermissions(req.user.id);
            const rows = await query(`SELECT w.id,w.type,w.title,w.priority,w.status,w.tenant_id,w.resource_type,w.resource_id,
                w.assigned_team_id,w.assigned_admin_id,w.due_at,w.created_at,w.updated_at
         FROM admin_work_items w
         WHERE (? = 1 OR w.created_by = ? OR w.assigned_admin_id = ? OR
                EXISTS (SELECT 1 FROM admin_team_memberships tm WHERE tm.team_id=w.assigned_team_id AND tm.user_id=?))
           AND (? IS NULL OR w.status = ?)
         ORDER BY w.created_at DESC LIMIT ${limit} OFFSET ${(page - 1) * limit}`, [permissions.includes('admin_roles.manage') ? 1 : 0, req.user.id, req.user.id, req.user.id,
                status, status]);
            return res.json({ data: rows, page, limit });
        }
        catch (error) {
            console.error('List admin work items error:');
            return res.status(500).json({ error: 'Failed to load work items' });
        }
    }));
    router.post('/', deps.taskCreate, (0, async_route_boundary_1.asyncRouteBoundary)(async (req, res) => {
        try {
            for (const key of ['type', 'title', 'description', 'priority']) {
                if (req.body?.[key] !== undefined && typeof req.body[key] !== 'string')
                    return res.status(400).json({ error: 'Invalid work item fields' });
            }
            const type = String(req.body?.type ?? 'other');
            const title = String(req.body?.title ?? '').trim();
            const description = String(req.body?.description ?? '').trim();
            const priority = String(req.body?.priority ?? 'normal');
            if (!types.has(type) || !priorities.has(priority) || title.length < 3 || title.length > 200 || description.length > 10000) {
                return res.status(400).json({ error: 'Invalid work item fields' });
            }
            const assignedTeamId = req.body?.assigned_team_id ?? null;
            if (assignedTeamId !== null && (typeof assignedTeamId !== 'string' || !assignedTeamId || assignedTeamId.length > 36 || assignedTeamId.trim() !== assignedTeamId)) {
                return res.status(400).json({ error: 'Invalid assigned team' });
            }
            if (assignedTeamId) {
                const permissions = await getAdminPermissions(req.user.id);
                if (!permissions.includes('task.assign'))
                    return res.status(403).json({ error: 'Task assignment is not allowed' });
                // User-controlled target ID: the team must exist server-side before it
                // is written (fail closed instead of failing on the FK deep in the DB).
                const team = await queryOne('SELECT id FROM admin_teams WHERE id=?', [assignedTeamId]);
                if (!team)
                    return res.status(400).json({ error: 'Assigned team not found' });
                const member = await queryOne('SELECT team_id FROM admin_team_memberships WHERE team_id=? AND user_id=?', [assignedTeamId, req.user.id]);
                if (!member && !permissions.includes('admin_roles.manage'))
                    return res.status(403).json({ error: 'Team assignment is not allowed' });
            }
            for (const key of ['resource_type', 'resource_id', 'due_at']) {
                const value = req.body?.[key];
                if (value !== undefined && value !== null && (typeof value !== 'string' || value.length > 255)) {
                    return res.status(400).json({ error: 'Invalid work item metadata' });
                }
            }
            const id = (0, crypto_1.randomUUID)();
            const connection = await deps.db.getConnection();
            try {
                await connection.beginTransaction();
                if (assignedTeamId) {
                    const [teams] = await connection.execute('SELECT id FROM admin_teams WHERE id=? FOR UPDATE', [assignedTeamId]);
                    const permissions = await getAdminPermissions(req.user.id);
                    if (!Array.isArray(teams) || teams.length !== 1) {
                        await connection.rollback();
                        return res.status(400).json({ error: 'Assigned team not found' });
                    }
                    if (!permissions.includes('task.assign')) {
                        await connection.rollback();
                        return res.status(403).json({ error: 'Task assignment is not allowed' });
                    }
                    if (!permissions.includes('admin_roles.manage')) {
                        const [members] = await connection.execute('SELECT team_id FROM admin_team_memberships WHERE team_id=? AND user_id=? FOR UPDATE', [assignedTeamId, req.user.id]);
                        if (!Array.isArray(members) || members.length !== 1) {
                            await connection.rollback();
                            return res.status(403).json({ error: 'Team assignment is not allowed' });
                        }
                    }
                }
                await connection.execute(`INSERT INTO admin_work_items
           (id,type,title,description,priority,created_by,assigned_team_id,tenant_id,resource_type,resource_id,due_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)`, [id, type, title, description || null, priority, req.user.id, assignedTeamId,
                    null, req.body?.resource_type || null, req.body?.resource_id || null, req.body?.due_at || null]);
                await connection.execute('INSERT INTO admin_work_item_events (id,work_item_id,actor_user_id,event_type) VALUES (?,?,?,?)', [(0, crypto_1.randomUUID)(), id, req.user.id, 'created']);
                await connection.commit();
            }
            catch (error) {
                try {
                    await connection.rollback();
                }
                catch { /* Original failure stays primary. */ }
                throw error;
            }
            finally {
                connection.release();
            }
            return res.status(201).json({ id });
        }
        catch (error) {
            console.error('Create admin work item error:');
            return res.status(500).json({ error: 'Failed to create work item' });
        }
    }));
    router.get('/:id', deps.taskRead, (0, async_route_boundary_1.asyncRouteBoundary)(async (req, res) => {
        try {
            const result = await atomic(async (_connection, access) => {
                const item = await visibleItem(req, req.params.id, access, true);
                if (!item)
                    return null;
                const events = await access.query('SELECT id,actor_user_id,event_type,body,old_value,new_value,created_at FROM admin_work_item_events WHERE work_item_id=? ORDER BY created_at', [item.id]);
                return { item, events };
            });
            if (!result)
                return res.status(404).json({ error: 'Work item not found' });
            return res.json(result);
        }
        catch {
            return res.status(500).json({ error: 'Failed to load work item' });
        }
    }));
    router.post('/:id/comments', deps.taskRead, (0, async_route_boundary_1.asyncRouteBoundary)(async (req, res) => {
        try {
            const body = typeof req.body?.body === 'string' ? req.body?.body.trim() : '';
            if (body.length < 1 || body.length > 10000)
                return res.status(400).json({ error: 'Invalid comment' });
            const id = (0, crypto_1.randomUUID)();
            const applied = await atomic(async (connection, access) => {
                const item = await visibleItem(req, req.params.id, access, true);
                if (!item)
                    return false;
                const [result] = await connection.execute('INSERT INTO admin_work_item_events (id,work_item_id,actor_user_id,event_type,body) VALUES (?,?,?,?,?)', [id, item.id, req.user.id, 'internal_comment', body]);
                if (result.affectedRows !== 1)
                    throw new Error('Comment write unconfirmed');
                return true;
            });
            if (!applied)
                return res.status(404).json({ error: 'Work item not found' });
            return res.status(201).json({ id });
        }
        catch {
            return res.status(500).json({ error: 'Failed to add comment' });
        }
    }));
    router.patch('/:id/assign', deps.taskAssign, (0, async_route_boundary_1.asyncRouteBoundary)(async (req, res) => {
        try {
            const reason = typeof req.body?.reason === 'string' ? req.body?.reason.trim() : '';
            const selector = (value) => {
                if (value === undefined || value === null || value === '')
                    return null;
                return typeof value === 'string' && value.trim() === value && value.length <= 36 ? value : undefined;
            };
            const teamId = selector(req.body?.assigned_team_id);
            const adminId = selector(req.body?.assigned_admin_id);
            if (reason.length < 3 || reason.length > 1000 || teamId === undefined || adminId === undefined || (!teamId && !adminId)) {
                return res.status(400).json({ error: 'Assignment and reason are required' });
            }
            const outcome = await atomic(async (connection, access) => {
                const item = await visibleItem(req, req.params.id, access, true);
                if (!item)
                    return { status: 404, error: 'Work item not found' };
                const permissions = await getAdminPermissions(req.user.id);
                const management = permissions.includes('admin_roles.manage');
                if (teamId) {
                    const team = await access.queryOne('SELECT id FROM admin_teams WHERE id=? FOR UPDATE', [teamId]);
                    if (!team)
                        return { status: 400, error: 'Assigned team not found' };
                    if (!management) {
                        const member = await access.queryOne('SELECT team_id FROM admin_team_memberships WHERE team_id=? AND user_id=? FOR UPDATE', [teamId, req.user.id]);
                        if (!member)
                            return { status: 403, error: 'Cross-team handoff requires management' };
                    }
                }
                if (adminId) {
                    const target = await access.queryOne('SELECT u.id FROM users u INNER JOIN admin_user_roles r ON r.user_id=u.id WHERE u.id=? AND u.is_active=1 LIMIT 1 FOR UPDATE', [adminId]);
                    if (!target)
                        return { status: 400, error: 'Assignee is not an active admin member' };
                    if (!management) {
                        const shared = await access.queryOne('SELECT target.team_id FROM admin_team_memberships mine INNER JOIN admin_team_memberships target ON target.team_id=mine.team_id WHERE mine.user_id=? AND target.user_id=? AND (? IS NULL OR target.team_id=?) LIMIT 1 FOR UPDATE', [req.user.id, adminId, teamId, teamId]);
                        if (!shared)
                            return { status: 403, error: 'Assignee must belong to your team' };
                    }
                }
                await connection.execute('UPDATE admin_work_items SET assigned_team_id=?,assigned_admin_id=? WHERE id=?', [teamId, adminId, item.id]);
                const [event] = await connection.execute('INSERT INTO admin_work_item_events (id,work_item_id,actor_user_id,event_type,body,old_value,new_value) VALUES (?,?,?,?,?,?,?)', [(0, crypto_1.randomUUID)(), item.id, req.user.id, 'handoff', reason, JSON.stringify({ team_id: item.assigned_team_id, admin_id: item.assigned_admin_id }), JSON.stringify({ team_id: teamId, admin_id: adminId })]);
                if (event.affectedRows !== 1)
                    throw new Error('Handoff event unconfirmed');
                return { status: 200 };
            });
            return res.status(outcome.status).json(outcome.error ? { error: outcome.error } : { success: true });
        }
        catch {
            return res.status(500).json({ error: 'Failed to assign work item' });
        }
    }));
    return router;
};
exports.createAdminWorkItemsRouter = createAdminWorkItemsRouter;
let dbModule;
const loadDb = () => {
    dbModule ?? (dbModule = Promise.resolve().then(() => __importStar(require('../db'))).catch(error => { dbModule = undefined; throw error; }));
    return dbModule;
};
exports.default = (0, exports.createAdminWorkItemsRouter)({
    db: {
        query: async (sql, params) => (await loadDb()).query(sql, params),
        queryOne: async (sql, params) => (await loadDb()).queryOne(sql, params),
        execute: async (sql, params) => (await loadDb()).execute(sql, params),
        getConnection: async () => (await loadDb()).getPool().getConnection(),
    },
    authenticate: auth_1.authenticateToken,
    taskRead: (0, admin_permissions_1.requireAdminPermission)('task.read'),
    taskCreate: (0, admin_permissions_1.requireAdminPermission)('task.create'),
    taskAssign: (0, admin_permissions_1.requireAdminPermission)('task.assign'),
    getAdminPermissions: admin_permissions_1.getAdminPermissions,
});
