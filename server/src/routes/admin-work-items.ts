import { randomUUID } from 'crypto';
import { Router, Response } from 'express';
import { query, queryOne, execute, getPool } from '../db';
import { authenticateToken, AuthRequest } from '../middleware/auth';
import { getAdminPermissions, requireAdminPermission } from '../security/admin-permissions';

const router = Router();
router.use(authenticateToken);

const priorities = new Set(['low', 'normal', 'high', 'urgent', 'critical']);
const statuses = new Set(['open', 'in_progress', 'waiting', 'blocked', 'pending_approval', 'escalated', 'resolved', 'closed', 'cancelled']);
const types = new Set(['instructor_onboarding', 'subscription_issue', 'payment_verification', 'payment_dispute', 'support_case', 'account_problem', 'security_issue', 'refund_request', 'financial_adjustment', 'technical_issue', 'content_issue', 'other']);

interface WorkItem {
  id: string;
  created_by: string;
  assigned_admin_id: string | null;
  assigned_team_id: string | null;
  status: string;
}

async function visibleItem(req: AuthRequest, id: string): Promise<WorkItem | null> {
  const permissions = await getAdminPermissions(req.user!.id);
  const rows = await query<WorkItem>(
    `SELECT w.id,w.created_by,w.assigned_admin_id,w.assigned_team_id,w.status
     FROM admin_work_items w WHERE w.id = ? AND
       (? = 1 OR w.created_by = ? OR w.assigned_admin_id = ? OR
        EXISTS (SELECT 1 FROM admin_team_memberships tm
                WHERE tm.team_id = w.assigned_team_id AND tm.user_id = ?))`,
    [id, permissions.includes('admin_roles.manage') ? 1 : 0, req.user!.id, req.user!.id, req.user!.id]
  );
  return rows[0] ?? null;
}

router.get('/', requireAdminPermission('task.read'), async (req: AuthRequest, res: Response) => {
  try {
    const page = Math.max(1, Number.parseInt(String(req.query.page ?? '1'), 10) || 1);
    const limit = Math.min(100, Math.max(1, Number.parseInt(String(req.query.limit ?? '25'), 10) || 25));
    const status = typeof req.query.status === 'string' && statuses.has(req.query.status) ? req.query.status : null;
    const permissions = await getAdminPermissions(req.user!.id);
    const rows = await query(
      `SELECT w.id,w.type,w.title,w.priority,w.status,w.tenant_id,w.resource_type,w.resource_id,
              w.assigned_team_id,w.assigned_admin_id,w.due_at,w.created_at,w.updated_at
       FROM admin_work_items w
       WHERE (? = 1 OR w.created_by = ? OR w.assigned_admin_id = ? OR
              EXISTS (SELECT 1 FROM admin_team_memberships tm WHERE tm.team_id=w.assigned_team_id AND tm.user_id=?))
         AND (? IS NULL OR w.status = ?)
       ORDER BY w.created_at DESC LIMIT ${limit} OFFSET ${(page - 1) * limit}`,
      [permissions.includes('admin_roles.manage') ? 1 : 0, req.user!.id, req.user!.id, req.user!.id,
        status, status]
    );
    return res.json({ data: rows, page, limit });
  } catch (error) {
    console.error('List admin work items error:', error);
    return res.status(500).json({ error: 'Failed to load work items' });
  }
});

router.post('/', requireAdminPermission('task.create'), async (req: AuthRequest, res: Response) => {
  try {
    const type = String(req.body.type ?? 'other');
    const title = String(req.body.title ?? '').trim();
    const description = String(req.body.description ?? '').trim();
    const priority = String(req.body.priority ?? 'normal');
    if (!types.has(type) || !priorities.has(priority) || title.length < 3 || title.length > 200 || description.length > 10000) {
      return res.status(400).json({ error: 'Invalid work item fields' });
    }
    const assignedTeamId = req.body.assigned_team_id || null;
    if (assignedTeamId) {
      const permissions = await getAdminPermissions(req.user!.id);
      if (!permissions.includes('task.assign')) return res.status(403).json({ error: 'Task assignment is not allowed' });
      const member = await queryOne('SELECT team_id FROM admin_team_memberships WHERE team_id=? AND user_id=?', [assignedTeamId, req.user!.id]);
      if (!member && !permissions.includes('admin_roles.manage')) return res.status(403).json({ error: 'Team assignment is not allowed' });
    }
    const id = randomUUID();
    const connection = await getPool().getConnection();
    try {
      await connection.beginTransaction();
      await connection.execute(
        `INSERT INTO admin_work_items
         (id,type,title,description,priority,created_by,assigned_team_id,tenant_id,resource_type,resource_id,due_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        [id, type, title, description || null, priority, req.user!.id, assignedTeamId,
          req.body.tenant_id || null, req.body.resource_type || null, req.body.resource_id || null, req.body.due_at || null]
      );
      await connection.execute(
        'INSERT INTO admin_work_item_events (id,work_item_id,actor_user_id,event_type) VALUES (?,?,?,?)',
        [randomUUID(), id, req.user!.id, 'created']
      );
      await connection.commit();
    } catch (error) { await connection.rollback(); throw error; }
    finally { connection.release(); }
    return res.status(201).json({ id });
  } catch (error) {
    console.error('Create admin work item error:', error);
    return res.status(500).json({ error: 'Failed to create work item' });
  }
});

router.get('/:id', requireAdminPermission('task.read'), async (req: AuthRequest, res: Response) => {
  try {
    if (!(await visibleItem(req, req.params.id))) return res.status(404).json({ error: 'Work item not found' });
    const item = await queryOne('SELECT * FROM admin_work_items WHERE id=?', [req.params.id]);
    const events = await query(
      'SELECT id,actor_user_id,event_type,body,old_value,new_value,created_at FROM admin_work_item_events WHERE work_item_id=? ORDER BY created_at',
      [req.params.id]
    );
    return res.json({ item, events });
  } catch (error) {
    console.error('Get admin work item error:', error);
    return res.status(500).json({ error: 'Failed to load work item' });
  }
});

router.post('/:id/comments', requireAdminPermission('task.read'), async (req: AuthRequest, res: Response) => {
  try {
    if (!(await visibleItem(req, req.params.id))) return res.status(404).json({ error: 'Work item not found' });
    const body = String(req.body.body ?? '').trim();
    if (body.length < 1 || body.length > 10000) return res.status(400).json({ error: 'Invalid comment' });
    const id = randomUUID();
    await execute(
      'INSERT INTO admin_work_item_events (id,work_item_id,actor_user_id,event_type,body) VALUES (?,?,?,?,?)',
      [id, req.params.id, req.user!.id, 'internal_comment', body]
    );
    return res.status(201).json({ id });
  } catch (error) {
    console.error('Comment on admin work item error:', error);
    return res.status(500).json({ error: 'Failed to add comment' });
  }
});

router.patch('/:id/assign', requireAdminPermission('task.assign'), async (req: AuthRequest, res: Response) => {
  try {
    const item = await visibleItem(req, req.params.id);
    if (!item) return res.status(404).json({ error: 'Work item not found' });
    const reason = String(req.body.reason ?? '').trim();
    const teamId = req.body.assigned_team_id || null;
    const adminId = req.body.assigned_admin_id || null;
    if (reason.length < 3 || reason.length > 1000 || (!teamId && !adminId)) return res.status(400).json({ error: 'Assignment and reason are required' });
    const permissions = await getAdminPermissions(req.user!.id);
    if (teamId && !permissions.includes('admin_roles.manage')) {
      const member = await queryOne('SELECT team_id FROM admin_team_memberships WHERE team_id=? AND user_id=?', [teamId, req.user!.id]);
      if (!member) return res.status(403).json({ error: 'Cross-team handoff requires management' });
    }
    if (adminId) {
      const target = await queryOne('SELECT user_id FROM admin_user_roles WHERE user_id=? LIMIT 1', [adminId]);
      if (!target) return res.status(400).json({ error: 'Assignee is not an admin member' });
      if (!permissions.includes('admin_roles.manage')) {
        const sharedTeam = await queryOne(
          `SELECT target.team_id FROM admin_team_memberships mine
           INNER JOIN admin_team_memberships target ON target.team_id=mine.team_id
           WHERE mine.user_id=? AND target.user_id=? AND (? IS NULL OR target.team_id=?) LIMIT 1`,
          [req.user!.id, adminId, teamId, teamId]
        );
        if (!sharedTeam) return res.status(403).json({ error: 'Assignee must belong to your team' });
      }
    }
    const connection = await getPool().getConnection();
    try {
      await connection.beginTransaction();
      await connection.execute('UPDATE admin_work_items SET assigned_team_id=?,assigned_admin_id=? WHERE id=?', [teamId, adminId, item.id]);
      await connection.execute(
        `INSERT INTO admin_work_item_events (id,work_item_id,actor_user_id,event_type,body,old_value,new_value)
         VALUES (?,?,?,?,?,?,?)`,
        [randomUUID(), item.id, req.user!.id, 'handoff', reason,
          JSON.stringify({ team_id: item.assigned_team_id, admin_id: item.assigned_admin_id }),
          JSON.stringify({ team_id: teamId, admin_id: adminId })]
      );
      await connection.commit();
    } catch (error) { await connection.rollback(); throw error; }
    finally { connection.release(); }
    return res.json({ success: true });
  } catch (error) {
    console.error('Assign admin work item error:', error);
    return res.status(500).json({ error: 'Failed to assign work item' });
  }
});

export default router;
