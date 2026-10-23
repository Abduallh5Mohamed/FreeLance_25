import { randomUUID } from 'crypto';
import { Router, Response, RequestHandler } from 'express';
import type { PoolConnection } from 'mysql2/promise';
import type { query, queryOne, execute } from '../db';
import { asyncRouteBoundary } from '../security/async-route-boundary';
import { authenticateToken, AuthRequest } from '../middleware/auth';
import { getAdminPermissions, requireAdminPermission } from '../security/admin-permissions';

/**
 * Data-access seam for the admin work items router. Production binds ../db;
 * hermetic tests inject isolated fixtures through the same boundary so the
 * real authorization logic runs without a database.
 */
export interface AdminWorkItemsDataAccess {
    query: typeof query;
    queryOne: typeof queryOne;
    execute: typeof execute;
    getConnection: () => Promise<PoolConnection>;
}

/**
 * Injectable seams for the admin work items router. The default export binds
 * the production SQL adapters, the real authentication middleware, the real
 * permission guards, and the server-verified admin permission lookup. Tests
 * inject fixtures through this boundary instead of bypassing production
 * authorization.
 *
 * Access policy: `task.read` sees only items the caller created, is assigned
 * to, or shares a team with — unless the caller holds the verified
 * `admin_roles.manage` platform permission, which grants the management-wide
 * queue. Assignment additionally requires `task.assign`, and any
 * user-supplied assignment target (team or admin) is verified to exist
 * server-side before it is written: deny-by-default for unknown targets.
 */
export interface AdminWorkItemsRouterDeps {
    db: AdminWorkItemsDataAccess;
    authenticate: RequestHandler;
    taskRead: RequestHandler;
    taskCreate: RequestHandler;
    taskAssign: RequestHandler;
    getAdminPermissions: (userId: string) => Promise<string[]>;
}

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

export const createAdminWorkItemsRouter = (deps: AdminWorkItemsRouterDeps): Router => {
  const router = Router();
  const query = <T>(sql: string, params?: unknown[]) => deps.db.query<T>(sql, params);
  const queryOne = <T>(sql: string, params?: unknown[]) => deps.db.queryOne<T>(sql, params);
  const getAdminPermissions = deps.getAdminPermissions;
  router.use(asyncRouteBoundary(deps.authenticate));
  router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

  type ReadAccess = Pick<AdminWorkItemsDataAccess, 'query' | 'queryOne'>;
  async function atomic<T>(fn: (connection: PoolConnection, access: ReadAccess) => Promise<T>): Promise<T> {
    const connection = await deps.db.getConnection();
    try {
      await connection.beginTransaction();
      const access: ReadAccess = {
        query: async <Row>(sql: string, params?: unknown[]) => {
          const [rows] = await connection.execute(sql, params);
          return rows as Row[];
        },
        queryOne: async <Row>(sql: string, params?: unknown[]) => {
          const [rows] = await connection.execute(sql, params);
          return (rows as Row[])[0] ?? null;
        },
      };
      const result = await fn(connection, access);
      await connection.commit();
      return result;
    } catch (error) {
      try { await connection.rollback(); } catch { /* Keep original failure. */ }
      throw error;
    } finally { connection.release(); }
  }


  async function visibleItem(req: AuthRequest, id: string, access: ReadAccess = deps.db, lock = false): Promise<WorkItem | null> {
    const permissions = await getAdminPermissions(req.user!.id);
    const management = permissions.includes('admin_roles.manage');
    const rows = await access.query<WorkItem>(
      `SELECT w.*
       FROM admin_work_items w WHERE w.id = ? AND
         (? = 1 OR w.created_by = ? OR w.assigned_admin_id = ? OR
          EXISTS (SELECT 1 FROM admin_team_memberships tm
                  WHERE tm.team_id = w.assigned_team_id AND tm.user_id = ?))
       ${lock ? 'FOR UPDATE' : ''}`,
      [id, management ? 1 : 0, req.user!.id, req.user!.id, req.user!.id]
    );
    const item = rows[0] ?? null;
    if (item && lock && !management && item.created_by !== req.user!.id && item.assigned_admin_id !== req.user!.id) {
      // FOR UPDATE on the outer item does not lock a nested EXISTS proof.
      // Re-read and hold the exact membership used for access on this unit.
      const member = await access.queryOne(
        'SELECT team_id FROM admin_team_memberships WHERE team_id=? AND user_id=? FOR UPDATE',
        [item.assigned_team_id, req.user!.id],
      );
      if (!member) return null;
    }
    return item;
  }

  router.get('/', deps.taskRead, asyncRouteBoundary(async (req: AuthRequest, res: Response) => {
    try {
      const parsePage = (value: unknown, fallback: number, max: number): number | null => {
        if (value === undefined) return fallback;
        if (typeof value !== 'string' || !/^\d+$/.test(value)) return null;
        const number = Number(value);
        return Number.isSafeInteger(number) && number >= 1 && number <= max ? number : null;
      };
      const page = parsePage(req.query.page, 1, 10000);
      const limit = parsePage(req.query.limit, 25, 100);
      if (page === null || limit === null) return res.status(400).json({ error: 'Invalid pagination' });
      if (req.query.status !== undefined && (typeof req.query.status !== 'string' || !statuses.has(req.query.status))) {
        return res.status(400).json({ error: 'Invalid status' });
      }
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
      console.error('List admin work items error:');
      return res.status(500).json({ error: 'Failed to load work items' });
    }
  }));

  router.post('/', deps.taskCreate, asyncRouteBoundary(async (req: AuthRequest, res: Response) => {
    try {
      for (const key of ['type', 'title', 'description', 'priority']) {
        if (req.body?.[key] !== undefined && typeof req.body[key] !== 'string') return res.status(400).json({ error: 'Invalid work item fields' });
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
        const permissions = await getAdminPermissions(req.user!.id);
        if (!permissions.includes('task.assign')) return res.status(403).json({ error: 'Task assignment is not allowed' });
        // User-controlled target ID: the team must exist server-side before it
        // is written (fail closed instead of failing on the FK deep in the DB).
        const team = await queryOne('SELECT id FROM admin_teams WHERE id=?', [assignedTeamId]);
        if (!team) return res.status(400).json({ error: 'Assigned team not found' });
        const member = await queryOne('SELECT team_id FROM admin_team_memberships WHERE team_id=? AND user_id=?', [assignedTeamId, req.user!.id]);
        if (!member && !permissions.includes('admin_roles.manage')) return res.status(403).json({ error: 'Team assignment is not allowed' });
      }
      for (const key of ['resource_type', 'resource_id', 'due_at']) {
        const value: unknown = req.body?.[key];
        if (value !== undefined && value !== null && (typeof value !== 'string' || value.length > 255)) {
          return res.status(400).json({ error: 'Invalid work item metadata' });
        }
      }
      const id = randomUUID();
      const connection = await deps.db.getConnection();
      try {
        await connection.beginTransaction();
        if (assignedTeamId) {
          const [teams] = await connection.execute('SELECT id FROM admin_teams WHERE id=? FOR UPDATE', [assignedTeamId]);
          const permissions = await getAdminPermissions(req.user!.id);
          if (!Array.isArray(teams) || teams.length !== 1) { await connection.rollback(); return res.status(400).json({ error: 'Assigned team not found' }); }
          if (!permissions.includes('task.assign')) { await connection.rollback(); return res.status(403).json({ error: 'Task assignment is not allowed' }); }
          if (!permissions.includes('admin_roles.manage')) {
            const [members] = await connection.execute('SELECT team_id FROM admin_team_memberships WHERE team_id=? AND user_id=? FOR UPDATE', [assignedTeamId, req.user!.id]);
            if (!Array.isArray(members) || members.length !== 1) { await connection.rollback(); return res.status(403).json({ error: 'Team assignment is not allowed' }); }
          }
        }
        await connection.execute(
          `INSERT INTO admin_work_items
           (id,type,title,description,priority,created_by,assigned_team_id,tenant_id,resource_type,resource_id,due_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
          [id, type, title, description || null, priority, req.user!.id, assignedTeamId,
            null, req.body?.resource_type || null, req.body?.resource_id || null, req.body?.due_at || null]
        );
        await connection.execute(
          'INSERT INTO admin_work_item_events (id,work_item_id,actor_user_id,event_type) VALUES (?,?,?,?)',
          [randomUUID(), id, req.user!.id, 'created']
        );
        await connection.commit();
      } catch (error) { try { await connection.rollback(); } catch { /* Original failure stays primary. */ } throw error; }
      finally { connection.release(); }
      return res.status(201).json({ id });
    } catch (error) {
      console.error('Create admin work item error:');
      return res.status(500).json({ error: 'Failed to create work item' });
    }
  }));

  router.get('/:id', deps.taskRead, asyncRouteBoundary(async (req: AuthRequest, res: Response) => {
    try {
      const result = await atomic(async (_connection, access) => {
        const item = await visibleItem(req, req.params.id, access, true);
        if (!item) return null;
        const events = await access.query(
          'SELECT id,actor_user_id,event_type,body,old_value,new_value,created_at FROM admin_work_item_events WHERE work_item_id=? ORDER BY created_at', [item.id],
        );
        return { item, events };
      });
      if (!result) return res.status(404).json({ error: 'Work item not found' });
      return res.json(result);
    } catch { return res.status(500).json({ error: 'Failed to load work item' }); }
  }));

  router.post('/:id/comments', deps.taskRead, asyncRouteBoundary(async (req: AuthRequest, res: Response) => {
    try {
      const body = typeof req.body?.body === 'string' ? req.body?.body.trim() : '';
      if (body.length < 1 || body.length > 10000) return res.status(400).json({ error: 'Invalid comment' });
      const id = randomUUID();
      const applied = await atomic(async (connection, access) => {
        const item = await visibleItem(req, req.params.id, access, true);
        if (!item) return false;
        const [result] = await connection.execute(
          'INSERT INTO admin_work_item_events (id,work_item_id,actor_user_id,event_type,body) VALUES (?,?,?,?,?)',
          [id, item.id, req.user!.id, 'internal_comment', body],
        );
        if ((result as unknown as { affectedRows?: number }).affectedRows !== 1) throw new Error('Comment write unconfirmed');
        return true;
      });
      if (!applied) return res.status(404).json({ error: 'Work item not found' });
      return res.status(201).json({ id });
    } catch { return res.status(500).json({ error: 'Failed to add comment' }); }
  }));

  router.patch('/:id/assign', deps.taskAssign, asyncRouteBoundary(async (req: AuthRequest, res: Response) => {
    try {
      const reason = typeof req.body?.reason === 'string' ? req.body?.reason.trim() : '';
      const selector = (value: unknown): string | null | undefined => {
        if (value === undefined || value === null || value === '') return null;
        return typeof value === 'string' && value.trim() === value && value.length <= 36 ? value : undefined;
      };
      const teamId = selector(req.body?.assigned_team_id);
      const adminId = selector(req.body?.assigned_admin_id);
      if (reason.length < 3 || reason.length > 1000 || teamId === undefined || adminId === undefined || (!teamId && !adminId)) {
        return res.status(400).json({ error: 'Assignment and reason are required' });
      }
      const outcome = await atomic(async (connection, access): Promise<{ status: number; error?: string }> => {
        const item = await visibleItem(req, req.params.id, access, true);
        if (!item) return { status: 404, error: 'Work item not found' };
        const permissions = await getAdminPermissions(req.user!.id);
        const management = permissions.includes('admin_roles.manage');
        if (teamId) {
          const team = await access.queryOne('SELECT id FROM admin_teams WHERE id=? FOR UPDATE', [teamId]);
          if (!team) return { status: 400, error: 'Assigned team not found' };
          if (!management) {
            const member = await access.queryOne('SELECT team_id FROM admin_team_memberships WHERE team_id=? AND user_id=? FOR UPDATE', [teamId, req.user!.id]);
            if (!member) return { status: 403, error: 'Cross-team handoff requires management' };
          }
        }
        if (adminId) {
          const target = await access.queryOne(
            'SELECT u.id FROM users u INNER JOIN admin_user_roles r ON r.user_id=u.id WHERE u.id=? AND u.is_active=1 LIMIT 1 FOR UPDATE', [adminId],
          );
          if (!target) return { status: 400, error: 'Assignee is not an active admin member' };
          if (!management) {
            const shared = await access.queryOne(
              'SELECT target.team_id FROM admin_team_memberships mine INNER JOIN admin_team_memberships target ON target.team_id=mine.team_id WHERE mine.user_id=? AND target.user_id=? AND (? IS NULL OR target.team_id=?) LIMIT 1 FOR UPDATE',
              [req.user!.id, adminId, teamId, teamId],
            );
            if (!shared) return { status: 403, error: 'Assignee must belong to your team' };
          }
        }
        await connection.execute('UPDATE admin_work_items SET assigned_team_id=?,assigned_admin_id=? WHERE id=?', [teamId, adminId, item.id]);
        const [event] = await connection.execute(
          'INSERT INTO admin_work_item_events (id,work_item_id,actor_user_id,event_type,body,old_value,new_value) VALUES (?,?,?,?,?,?,?)',
          [randomUUID(), item.id, req.user!.id, 'handoff', reason, JSON.stringify({ team_id: item.assigned_team_id, admin_id: item.assigned_admin_id }), JSON.stringify({ team_id: teamId, admin_id: adminId })],
        );
        if ((event as unknown as { affectedRows?: number }).affectedRows !== 1) throw new Error('Handoff event unconfirmed');
        return { status: 200 };
      });
      return res.status(outcome.status).json(outcome.error ? { error: outcome.error } : { success: true });
    } catch { return res.status(500).json({ error: 'Failed to assign work item' }); }
  }));

  return router;
};

let dbModule: Promise<typeof import('../db')> | undefined;
const loadDb = () => {
  dbModule ??= import('../db').catch(error => { dbModule = undefined; throw error; });
  return dbModule;
};

export default createAdminWorkItemsRouter({
  db: {
    query: async <T>(sql: string, params?: unknown[]) => (await loadDb()).query<T>(sql, params),
    queryOne: async <T>(sql: string, params?: unknown[]) => (await loadDb()).queryOne<T>(sql, params),
    execute: async (sql, params) => (await loadDb()).execute(sql, params),
    getConnection: async () => (await loadDb()).getPool().getConnection(),
  },
  authenticate: authenticateToken,
  taskRead: requireAdminPermission('task.read'),
  taskCreate: requireAdminPermission('task.create'),
  taskAssign: requireAdminPermission('task.assign'),
  getAdminPermissions,
});
