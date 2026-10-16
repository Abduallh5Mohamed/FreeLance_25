import { randomUUID } from 'crypto';
import { Router, Response, RequestHandler } from 'express';
import type { PoolConnection } from 'mysql2/promise';
import { getPool, query, queryOne } from '../db';
import { authenticateToken, AuthRequest } from '../middleware/auth';
import { isSuperAdmin, requireAdminPermission } from '../security/admin-permissions';
import { CreditAdjustmentError, postServiceCreditAdjustment } from '../services/service-credit';

/**
 * Data-access seam for the admin approvals router. Production binds ../db;
 * hermetic tests inject isolated fixtures through the same boundary so the
 * real authorization logic runs without a database.
 */
export interface AdminApprovalsDataAccess {
    query: typeof query;
    queryOne: typeof queryOne;
    getConnection: () => Promise<PoolConnection>;
}

/**
 * Injectable seams for the admin approvals router. The default export binds
 * the production SQL adapters, the real authentication middleware, the real
 * permission guards, and the server-verified super-admin lookup. Tests inject
 * fixtures through this boundary instead of bypassing production
 * authorization.
 *
 * Access policy: `service_credit.adjust` requests an adjustment,
 * `approval.approve` decides one, and `approval.read` lists the queue. Every
 * decision re-reads the request row FOR UPDATE and only a `pending` row may be
 * decided, so duplicate approve/reject transitions fail closed with 409; the
 * requester cannot decide their own action unless they are a server-verified
 * Super Admin. A JWT role claim alone never satisfies any guard.
 */
export interface AdminApprovalsRouterDeps {
    db: AdminApprovalsDataAccess;
    authenticate: RequestHandler;
    approvalRead: RequestHandler;
    creditAdjust: RequestHandler;
    approvalApprove: RequestHandler;
    isSuperAdmin: (userId: string) => Promise<boolean>;
}

export const createAdminApprovalsRouter = (deps: AdminApprovalsRouterDeps): Router => {
  const router = Router();
  const { query, queryOne, getConnection } = deps.db;
  router.use(deps.authenticate);

  router.get('/', deps.approvalRead, async (req: AuthRequest, res: Response) => {
    try {
      const status = req.query.status === 'approved' || req.query.status === 'rejected' ? req.query.status : 'pending';
      return res.json(await query(
        `SELECT a.id,a.action_key,a.resource_type,a.resource_id,a.requested_value,a.reason,a.status,
                a.requested_by,a.decided_by,a.created_at,a.decided_at
         FROM admin_approval_requests a WHERE a.status=? ORDER BY a.created_at DESC LIMIT 100`, [status]
      ));
    } catch (error) { console.error('List approvals error:', error); return res.status(500).json({ error: 'Failed to load approvals' }); }
  });

  router.post('/', deps.creditAdjust, async (req: AuthRequest, res: Response) => {
    try {
      const action = String(req.body.action_key ?? '');
      const instructorId = String(req.body.instructor_id ?? '');
      const amount = String(req.body.amount ?? '').trim();
      const reason = String(req.body.reason ?? '').trim();
      if (!['service_credit.credit', 'service_credit.debit'].includes(action) ||
          !/^[0-9a-f-]{36}$/i.test(instructorId) ||
          !/^(?:0|[1-9]\d{0,9})(?:\.\d{1,2})?$/.test(amount) || Number(amount) <= 0 ||
          reason.length < 3 || reason.length > 500) {
        return res.status(400).json({ error: 'Valid instructor, action, amount and reason are required' });
      }
      const instructor = await queryOne('SELECT id FROM users WHERE id=? AND role=?', [instructorId, 'instructor']);
      if (!instructor) return res.status(404).json({ error: 'Instructor not found' });
      const id = randomUUID();
      const connection = await getConnection();
      try {
        await connection.beginTransaction();
        await connection.execute(
          `INSERT INTO admin_approval_requests
           (id,action_key,resource_type,resource_id,requested_value,reason,requested_by)
           VALUES (?,?,?,?,?,?,?)`,
          [id, action, 'instructor', instructorId, JSON.stringify({ amount }), reason, req.user!.id]
        );
        await connection.execute(
          `INSERT INTO audit_events (id,actor_user_id,action,resource_type,resource_id,new_value,reason)
           VALUES (?,?,?,?,?,?,?)`,
          [randomUUID(), req.user!.id, 'approval.requested', 'approval', id,
            JSON.stringify({ action, instructor_id: instructorId, amount }), reason]
        );
        await connection.commit();
      } catch (error) { await connection.rollback(); throw error; }
      finally { connection.release(); }
      return res.status(201).json({ id, status: 'pending' });
    } catch (error) { console.error('Create approval error:', error); return res.status(500).json({ error: 'Failed to create approval' }); }
  });

  router.post('/:id/approve', deps.approvalApprove, async (req: AuthRequest, res: Response) => {
    const connection = await getConnection();
    try {
      await connection.beginTransaction();
      const [rows] = await connection.execute(
        'SELECT id,action_key,resource_type,resource_id,requested_value,reason,status,requested_by FROM admin_approval_requests WHERE id=? FOR UPDATE',
        [req.params.id]
      );
      const approval = (rows as Array<{
        id: string; action_key: string; resource_type: string; resource_id: string;
        requested_value: { amount: string } | string; reason: string; status: string; requested_by: string;
      }>)[0];
      if (!approval) { await connection.rollback(); return res.status(404).json({ error: 'Approval not found' }); }
      if (approval.status !== 'pending') { await connection.rollback(); return res.status(409).json({ error: 'Approval already decided' }); }
      if (approval.requested_by === req.user!.id && !(await deps.isSuperAdmin(req.user!.id))) {
        await connection.rollback(); return res.status(403).json({ error: 'Requester cannot approve own action' });
      }
      if (approval.resource_type !== 'instructor' || !['service_credit.credit', 'service_credit.debit'].includes(approval.action_key)) {
        await connection.rollback(); return res.status(400).json({ error: 'Unsupported approval action' });
      }
      const value = typeof approval.requested_value === 'string' ? JSON.parse(approval.requested_value) : approval.requested_value;
      const newBalance = await postServiceCreditAdjustment(connection, {
        instructorId: approval.resource_id, actorId: req.user!.id,
        type: approval.action_key === 'service_credit.credit' ? 'credit' : 'debit',
        amount: value.amount, reason: approval.reason,
      });
      await connection.execute(
        `UPDATE admin_approval_requests SET status='approved',decided_by=?,decided_at=UTC_TIMESTAMP() WHERE id=?`,
        [req.user!.id, approval.id]
      );
      await connection.execute(
        `INSERT INTO audit_events
         (id,actor_user_id,action,resource_type,resource_id,new_value,reason)
         VALUES (?,?,?,?,?,?,?)`,
        [randomUUID(), req.user!.id, 'service_credit.approved', 'approval', approval.id,
          JSON.stringify({ instructor_id: approval.resource_id, new_balance: newBalance }), approval.reason]
      );
      await connection.commit();
      return res.json({ status: 'approved', new_balance: newBalance });
    } catch (error) {
      await connection.rollback();
      if (error instanceof CreditAdjustmentError) return res.status(error.status).json({ error: error.message });
      console.error('Approve adjustment error:', error);
      return res.status(500).json({ error: 'Failed to approve adjustment' });
    } finally { connection.release(); }
  });

  router.post('/:id/reject', deps.approvalApprove, async (req: AuthRequest, res: Response) => {
    const reason = String(req.body.reason ?? '').trim();
    if (reason.length < 3 || reason.length > 1000) return res.status(400).json({ error: 'Rejection reason is required' });
    const connection = await getConnection();
    try {
      await connection.beginTransaction();
      const [rows] = await connection.execute(
        'SELECT id,status,requested_by FROM admin_approval_requests WHERE id=? FOR UPDATE', [req.params.id]
      );
      const approval = (rows as Array<{ id: string; status: string; requested_by: string }>)[0];
      if (!approval) { await connection.rollback(); return res.status(404).json({ error: 'Approval not found' }); }
      if (approval.status !== 'pending') { await connection.rollback(); return res.status(409).json({ error: 'Approval already decided' }); }
      if (approval.requested_by === req.user!.id && !(await deps.isSuperAdmin(req.user!.id))) {
        await connection.rollback(); return res.status(403).json({ error: 'Requester cannot decide own action' });
      }
      await connection.execute(
        `UPDATE admin_approval_requests SET status='rejected',decided_by=?,decided_at=UTC_TIMESTAMP(),decision_reason=? WHERE id=?`,
        [req.user!.id, reason, approval.id]
      );
      await connection.execute(
        'INSERT INTO audit_events (id,actor_user_id,action,resource_type,resource_id,reason) VALUES (?,?,?,?,?,?)',
        [randomUUID(), req.user!.id, 'approval.rejected', 'approval', approval.id, reason]
      );
      await connection.commit();
      return res.json({ status: 'rejected' });
    } catch (error) { await connection.rollback(); console.error('Reject approval error:', error); return res.status(500).json({ error: 'Failed to reject approval' }); }
    finally { connection.release(); }
  });

  return router;
};

export default createAdminApprovalsRouter({
  db: { query, queryOne, getConnection: () => getPool().getConnection() },
  authenticate: authenticateToken,
  approvalRead: requireAdminPermission('approval.read'),
  creditAdjust: requireAdminPermission('service_credit.adjust'),
  approvalApprove: requireAdminPermission('approval.approve'),
  isSuperAdmin,
});
