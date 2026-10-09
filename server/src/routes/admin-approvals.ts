import { randomUUID } from 'crypto';
import { Router, Response } from 'express';
import { getPool, query, queryOne } from '../db';
import { authenticateToken, AuthRequest } from '../middleware/auth';
import { isSuperAdmin, requireAdminPermission } from '../security/admin-permissions';
import { CreditAdjustmentError, postServiceCreditAdjustment } from '../services/service-credit';

const router = Router();
router.use(authenticateToken);

router.get('/', requireAdminPermission('approval.read'), async (req: AuthRequest, res: Response) => {
  try {
    const status = req.query.status === 'approved' || req.query.status === 'rejected' ? req.query.status : 'pending';
    return res.json(await query(
      `SELECT a.id,a.action_key,a.resource_type,a.resource_id,a.requested_value,a.reason,a.status,
              a.requested_by,a.decided_by,a.created_at,a.decided_at
       FROM admin_approval_requests a WHERE a.status=? ORDER BY a.created_at DESC LIMIT 100`, [status]
    ));
  } catch (error) { console.error('List approvals error:', error); return res.status(500).json({ error: 'Failed to load approvals' }); }
});

router.post('/', requireAdminPermission('service_credit.adjust'), async (req: AuthRequest, res: Response) => {
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
    const connection = await getPool().getConnection();
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

router.post('/:id/approve', requireAdminPermission('approval.approve'), async (req: AuthRequest, res: Response) => {
  const connection = await getPool().getConnection();
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
    if (approval.requested_by === req.user!.id && !(await isSuperAdmin(req.user!.id))) {
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

router.post('/:id/reject', requireAdminPermission('approval.approve'), async (req: AuthRequest, res: Response) => {
  const reason = String(req.body.reason ?? '').trim();
  if (reason.length < 3 || reason.length > 1000) return res.status(400).json({ error: 'Rejection reason is required' });
  const connection = await getPool().getConnection();
  try {
    await connection.beginTransaction();
    const [rows] = await connection.execute(
      'SELECT id,status,requested_by FROM admin_approval_requests WHERE id=? FOR UPDATE', [req.params.id]
    );
    const approval = (rows as Array<{ id: string; status: string; requested_by: string }>)[0];
    if (!approval) { await connection.rollback(); return res.status(404).json({ error: 'Approval not found' }); }
    if (approval.status !== 'pending') { await connection.rollback(); return res.status(409).json({ error: 'Approval already decided' }); }
    if (approval.requested_by === req.user!.id && !(await isSuperAdmin(req.user!.id))) {
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

export default router;
