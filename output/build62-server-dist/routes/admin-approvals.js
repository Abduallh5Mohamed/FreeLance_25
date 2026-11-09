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
exports.createAdminApprovalsRouter = void 0;
const crypto_1 = require("crypto");
const express_1 = require("express");
const sensitive_action_mfa_production_1 = require("../security/sensitive-action-mfa-production");
const async_route_boundary_1 = require("../security/async-route-boundary");
const auth_1 = require("../middleware/auth");
const admin_permissions_1 = require("../security/admin-permissions");
const service_credit_1 = require("../services/service-credit");
const createAdminApprovalsRouter = (deps) => {
    const router = (0, express_1.Router)();
    const query = (sql, params) => deps.db.query(sql, params);
    const queryOne = (sql, params) => deps.db.queryOne(sql, params);
    const getConnection = () => deps.db.getConnection();
    router.use((0, async_route_boundary_1.asyncRouteBoundary)(deps.authenticate));
    router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
    const pass = (_req, _res, next) => next();
    const requestStepUp = deps.requestStepUp ? (0, async_route_boundary_1.asyncRouteBoundary)(deps.requestStepUp) : pass;
    const decisionStepUp = deps.decisionStepUp ? (0, async_route_boundary_1.asyncRouteBoundary)(deps.decisionStepUp) : pass;
    const requireOne = (result) => {
        if (!result || typeof result !== 'object' || result.affectedRows !== 1) {
            throw new Error('Approval transition was not confirmed');
        }
    };
    router.get('/', deps.approvalRead, (0, async_route_boundary_1.asyncRouteBoundary)(async (req, res) => {
        try {
            const statusValue = req.query.status;
            const allowedStatuses = ['pending', 'approved', 'rejected'];
            if (statusValue !== undefined && (typeof statusValue !== 'string' || !allowedStatuses.includes(statusValue))) {
                return res.status(400).json({ error: 'Invalid approval status' });
            }
            const status = typeof statusValue === 'string' ? statusValue : 'pending';
            return res.json(await query(`SELECT a.id,a.action_key,a.resource_type,a.resource_id,a.requested_value,a.reason,a.status,
                a.requested_by,a.decided_by,a.created_at,a.decided_at
         FROM admin_approval_requests a WHERE a.status=? ORDER BY a.created_at DESC LIMIT 100`, [status]));
        }
        catch (error) {
            console.error('List approvals error:');
            return res.status(500).json({ error: 'Failed to load approvals' });
        }
    }));
    router.post('/', deps.creditAdjust, requestStepUp, (0, async_route_boundary_1.asyncRouteBoundary)(async (req, res) => {
        try {
            for (const key of ['action_key', 'instructor_id', 'amount', 'reason']) {
                if (typeof req.body?.[key] !== 'string')
                    return res.status(400).json({ error: 'Invalid approval fields' });
            }
            const action = String(req.body?.action_key ?? '');
            const instructorId = String(req.body?.instructor_id ?? '');
            const amount = String(req.body?.amount ?? '').trim();
            const reason = String(req.body?.reason ?? '').trim();
            if (!['service_credit.credit', 'service_credit.debit'].includes(action) ||
                !/^[0-9a-f-]{36}$/i.test(instructorId) ||
                !/^(?:0|[1-9]\d{0,9})(?:\.\d{1,2})?$/.test(amount) || Number(amount) <= 0 ||
                reason.length < 3 || reason.length > 500) {
                return res.status(400).json({ error: 'Valid instructor, action, amount and reason are required' });
            }
            const instructor = await queryOne('SELECT id FROM users WHERE id=? AND role=?', [instructorId, 'instructor']);
            if (!instructor)
                return res.status(404).json({ error: 'Instructor not found' });
            const id = (0, crypto_1.randomUUID)();
            const connection = await getConnection();
            try {
                await connection.beginTransaction();
                await connection.execute(`INSERT INTO admin_approval_requests
           (id,action_key,resource_type,resource_id,requested_value,reason,requested_by)
           VALUES (?,?,?,?,?,?,?)`, [id, action, 'instructor', instructorId, JSON.stringify({ amount }), reason, req.user.id]);
                await connection.execute(`INSERT INTO audit_events (id,actor_user_id,action,resource_type,resource_id,new_value,reason)
           VALUES (?,?,?,?,?,?,?)`, [(0, crypto_1.randomUUID)(), req.user.id, 'approval.requested', 'approval', id,
                    JSON.stringify({ action, instructor_id: instructorId, amount }), reason]);
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
            return res.status(201).json({ id, status: 'pending' });
        }
        catch (error) {
            console.error('Create approval error:');
            return res.status(500).json({ error: 'Failed to create approval' });
        }
    }));
    router.post('/:id/approve', deps.approvalApprove, decisionStepUp, (0, async_route_boundary_1.asyncRouteBoundary)(async (req, res) => {
        const connection = await getConnection();
        try {
            await connection.beginTransaction();
            const [rows] = await connection.execute('SELECT id,action_key,resource_type,resource_id,requested_value,reason,status,requested_by FROM admin_approval_requests WHERE id=? FOR UPDATE', [req.params.id]);
            const approval = rows[0];
            if (!approval) {
                await connection.rollback();
                return res.status(404).json({ error: 'Approval not found' });
            }
            if (approval.status !== 'pending') {
                await connection.rollback();
                return res.status(409).json({ error: 'Approval already decided' });
            }
            if (approval.requested_by === req.user.id && !(await deps.isSuperAdmin(req.user.id))) {
                await connection.rollback();
                return res.status(403).json({ error: 'Requester cannot approve own action' });
            }
            if (approval.resource_type !== 'instructor' || !['service_credit.credit', 'service_credit.debit'].includes(approval.action_key)) {
                await connection.rollback();
                return res.status(400).json({ error: 'Unsupported approval action' });
            }
            const decodedValue = typeof approval.requested_value === 'string'
                ? JSON.parse(approval.requested_value)
                : approval.requested_value;
            if (typeof decodedValue !== 'object' || decodedValue === null || !('amount' in decodedValue) ||
                typeof decodedValue.amount !== 'string' ||
                !/^(?:0|[1-9]\d{0,9})(?:\.\d{1,2})?$/.test(decodedValue.amount) || Number(decodedValue.amount) <= 0) {
                await connection.rollback();
                return res.status(409).json({ error: 'Approval contains an invalid adjustment amount' });
            }
            // Re-prove the financial target on this connection before any effect.
            const [targets] = await connection.execute('SELECT id FROM users WHERE id=? AND role=? AND is_active=1 FOR UPDATE', [approval.resource_id, 'instructor']);
            if (!Array.isArray(targets) || targets.length !== 1) {
                await connection.rollback();
                return res.status(409).json({ error: 'Adjustment target is no longer active' });
            }
            const newBalance = await (0, service_credit_1.postServiceCreditAdjustment)(connection, {
                instructorId: approval.resource_id, actorId: req.user.id,
                type: approval.action_key === 'service_credit.credit' ? 'credit' : 'debit',
                amount: decodedValue.amount, reason: approval.reason,
            });
            const [decision] = await connection.execute(`UPDATE admin_approval_requests SET status='approved',decided_by=?,decided_at=UTC_TIMESTAMP() WHERE id=? AND status='pending'`, [req.user.id, approval.id]);
            requireOne(decision);
            await connection.execute(`INSERT INTO audit_events
         (id,actor_user_id,action,resource_type,resource_id,new_value,reason)
         VALUES (?,?,?,?,?,?,?)`, [(0, crypto_1.randomUUID)(), req.user.id, 'service_credit.approved', 'approval', approval.id,
                JSON.stringify({ instructor_id: approval.resource_id, new_balance: newBalance }), approval.reason]);
            await connection.commit();
            return res.json({ status: 'approved', new_balance: newBalance });
        }
        catch (error) {
            try {
                await connection.rollback();
            }
            catch { /* Original failure stays primary. */ }
            if (error instanceof service_credit_1.CreditAdjustmentError)
                return res.status(error.status).json({ error: error.message });
            console.error('Approve adjustment error:');
            return res.status(500).json({ error: 'Failed to approve adjustment' });
        }
        finally {
            connection.release();
        }
    }));
    router.post('/:id/reject', deps.approvalApprove, decisionStepUp, (0, async_route_boundary_1.asyncRouteBoundary)(async (req, res) => {
        const reason = String(req.body?.reason ?? '').trim();
        if (reason.length < 3 || reason.length > 1000)
            return res.status(400).json({ error: 'Rejection reason is required' });
        const connection = await getConnection();
        try {
            await connection.beginTransaction();
            const [rows] = await connection.execute('SELECT id,status,requested_by FROM admin_approval_requests WHERE id=? FOR UPDATE', [req.params.id]);
            const approval = rows[0];
            if (!approval) {
                await connection.rollback();
                return res.status(404).json({ error: 'Approval not found' });
            }
            if (approval.status !== 'pending') {
                await connection.rollback();
                return res.status(409).json({ error: 'Approval already decided' });
            }
            if (approval.requested_by === req.user.id && !(await deps.isSuperAdmin(req.user.id))) {
                await connection.rollback();
                return res.status(403).json({ error: 'Requester cannot decide own action' });
            }
            const [decision] = await connection.execute(`UPDATE admin_approval_requests SET status='rejected',decided_by=?,decided_at=UTC_TIMESTAMP(),decision_reason=? WHERE id=? AND status='pending'`, [req.user.id, reason, approval.id]);
            requireOne(decision);
            await connection.execute('INSERT INTO audit_events (id,actor_user_id,action,resource_type,resource_id,reason) VALUES (?,?,?,?,?,?)', [(0, crypto_1.randomUUID)(), req.user.id, 'approval.rejected', 'approval', approval.id, reason]);
            await connection.commit();
            return res.json({ status: 'rejected' });
        }
        catch (error) {
            try {
                await connection.rollback();
            }
            catch { /* Original failure stays primary. */ }
            console.error('Reject approval error:');
            return res.status(500).json({ error: 'Failed to reject approval' });
        }
        finally {
            connection.release();
        }
    }));
    return router;
};
exports.createAdminApprovalsRouter = createAdminApprovalsRouter;
let dbModule;
const loadDb = () => {
    dbModule ?? (dbModule = Promise.resolve().then(() => __importStar(require('../db'))).catch(error => { dbModule = undefined; throw error; }));
    return dbModule;
};
exports.default = (0, exports.createAdminApprovalsRouter)({
    db: {
        query: async (sql, params) => (await loadDb()).query(sql, params),
        queryOne: async (sql, params) => (await loadDb()).queryOne(sql, params),
        getConnection: async () => (await loadDb()).getPool().getConnection(),
    },
    authenticate: auth_1.authenticateToken,
    approvalRead: (0, admin_permissions_1.requireAdminPermission)('approval.read'),
    creditAdjust: (0, admin_permissions_1.requireAdminPermission)('service_credit.adjust'),
    approvalApprove: (0, admin_permissions_1.requireAdminPermission)('approval.approve'),
    isSuperAdmin: admin_permissions_1.isSuperAdmin,
    requestStepUp: process.env.AUTH_LOGIN_SESSIONS_ENABLED === 'true'
        ? (0, sensitive_action_mfa_production_1.createProductionSensitiveActionMfa)({ permission: 'service_credit.adjust' }) : undefined,
    decisionStepUp: process.env.AUTH_LOGIN_SESSIONS_ENABLED === 'true'
        ? (0, sensitive_action_mfa_production_1.createProductionSensitiveActionMfa)({ permission: 'approval.approve' }) : undefined,
});
