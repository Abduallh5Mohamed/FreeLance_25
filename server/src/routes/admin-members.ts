import { Router, Response, RequestHandler } from 'express';
import { randomUUID } from 'crypto';
import bcrypt from 'bcryptjs';
import type { PoolConnection } from 'mysql2/promise';
import type { query } from '../db';

let dbModule: Promise<typeof import('../db')> | undefined;
const loadDb = () => {
  dbModule ??= import('../db').catch(error => { dbModule = undefined; throw error; });
  return dbModule;
};
import { authenticateToken, AuthRequest } from '../middleware/auth';
import { isSuperAdmin, requireAdminPermission } from '../security/admin-permissions';
import { createProductionSensitiveActionMfa } from '../security/sensitive-action-mfa-production';
import { asyncRouteBoundary } from '../security/async-route-boundary';

/**
 * Data-access seam for the admin members router. Production binds ../db;
 * hermetic tests inject isolated fixtures through the same boundary so the
 * real authorization logic runs without a database.
 */
export interface AdminMembersDataAccess {
    query: typeof query;
    getConnection: () => Promise<PoolConnection>;
}

/**
 * Injectable seams for the admin members router. The default export binds the
 * production SQL adapters, the real authentication middleware, the real
 * permission guard, the server-verified super-admin lookup, and bcrypt.
 * Tests inject fixtures through this boundary instead of bypassing
 * production authorization.
 *
 * Access policy: the `admin_roles.manage` permission is the coarse gate, and
 * every handler that creates, modifies, or promotes an administrative login
 * account additionally requires a Super Admin verified server-side through
 * `admin_user_roles` joined against an active users row. A JWT role claim
 * alone never satisfies either check.
 */
export interface AdminMembersRouterDeps {
    /** Additional step-up gate; existing permission and Super Admin checks stay. */
    sensitiveAction?: RequestHandler;
    db: AdminMembersDataAccess;
    authenticate: RequestHandler;
    manageRoles: RequestHandler;
    isSuperAdmin: (userId: string) => Promise<boolean>;
    hashPassword: (password: string) => Promise<string>;
}

const teamForRole: Record<string, string> = {
  super_admin: 'management', operations_admin: 'operations', billing_admin: 'billing',
  support_admin: 'support', security_admin: 'security', analyst: 'management',
};

export const createAdminMembersRouter = (deps: AdminMembersRouterDeps): Router => {
  const router = Router();
  const { query, getConnection } = deps.db;
  const sensitiveAction: RequestHandler = deps.sensitiveAction
    ? asyncRouteBoundary(deps.sensitiveAction)
    : (_req, _res, next) => next();
  router.use(deps.authenticate);

  router.get('/roles', deps.manageRoles, asyncRouteBoundary(async (_req, res: Response) => {
    try { return res.json(await query('SELECT code,name FROM admin_roles ORDER BY code')); }
    catch (error) { console.error('List admin roles error:'); return res.status(500).json({ error: 'Failed to load admin roles' }); }
  }));

  router.get('/', deps.manageRoles, asyncRouteBoundary(async (_req, res: Response) => {
    try {
      return res.json(await query(
        `SELECT u.id,u.name,u.email,u.phone,u.is_active,GROUP_CONCAT(ar.role_code ORDER BY ar.role_code) AS roles
         FROM admin_user_roles ar INNER JOIN users u ON u.id=ar.user_id
         GROUP BY u.id,u.name,u.email,u.phone,u.is_active ORDER BY u.name`
      ));
    } catch (error) { console.error('List admin members error:'); return res.status(500).json({ error: 'Failed to load admin members' }); }
  }));

  // Only the Super Admin creates administrative login accounts.
  router.post('/', deps.manageRoles, sensitiveAction, asyncRouteBoundary(async (req: AuthRequest, res: Response) => {
    if (!(await deps.isSuperAdmin(req.user!.id))) return res.status(403).json({ error: 'Super Admin only' });
    const name = String(req.body.name ?? '').trim();
    const phone = String(req.body.phone ?? '').trim();
    const email = String(req.body.email ?? '').trim().toLowerCase() || null;
    const password = String(req.body.password ?? '');
    const roleCode = String(req.body.role_code ?? '').trim();
    if (name.length < 3 || name.length > 255 || phone.length < 6 || phone.length > 50 || password.length < 8 || password.length > 128 ||
        (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))) {
      return res.status(400).json({ error: 'الاسم والهاتف وكلمة مرور من 8 أحرف على الأقل مطلوبة' });
    }
    const connection = await getConnection();
    try {
      await connection.beginTransaction();
      const [roleRows] = await connection.execute('SELECT code FROM admin_roles WHERE code=?', [roleCode]);
      if (!(roleRows as unknown[]).length) { await connection.rollback(); return res.status(400).json({ error: 'الدور الإداري غير معروف' }); }
      const [duplicateRows] = await connection.execute(
        'SELECT id FROM users WHERE phone=? OR (? IS NOT NULL AND email=?) LIMIT 1', [phone, email, email]
      );
      if ((duplicateRows as unknown[]).length) { await connection.rollback(); return res.status(409).json({ error: 'رقم الهاتف أو البريد مستخدم بالفعل' }); }
      const id = randomUUID();
      const passwordHash = await deps.hashPassword(password);
      await connection.execute(
        `INSERT INTO users (id,name,email,phone,password_hash,role,is_active)
         VALUES (?,?,?,?,?,'staff',1)`, [id, name, email, phone, passwordHash]
      );
      await connection.execute(
        'INSERT INTO admin_user_roles (user_id,role_code,assigned_by) VALUES (?,?,?)', [id, roleCode, req.user!.id]
      );
      if (teamForRole[roleCode]) {
        await connection.execute(
          `INSERT IGNORE INTO admin_team_memberships (team_id,user_id)
           SELECT id,? FROM admin_teams WHERE code=?`, [id, teamForRole[roleCode]]
        );
      }
      await connection.execute(
        `INSERT INTO audit_events (id,actor_user_id,action,resource_type,resource_id,new_value,reason)
         VALUES (UUID(),?,'admin_account.created','user',?,?,?)`,
        [req.user!.id, id, JSON.stringify({ name, phone, email, role_code: roleCode }), 'Created directly by Super Admin']
      );
      await connection.commit();
      return res.status(201).json({ id, name, phone, role_code: roleCode });
    } catch (error) {
      await connection.rollback();
      console.error('Create admin account error:');
      return res.status(500).json({ error: 'تعذر إنشاء حساب المسؤول' });
    } finally { connection.release(); }
  }));

  router.patch('/:id', deps.manageRoles, sensitiveAction, asyncRouteBoundary(async (req: AuthRequest, res: Response) => {
    if (!(await deps.isSuperAdmin(req.user!.id))) return res.status(403).json({ error: 'Super Admin only' });
    const roleCode = req.body.role_code === undefined ? null : String(req.body.role_code).trim();
    // is_active must be a real boolean. Coercing with Boolean() would turn the
    // string "false" into true and silently reactivate a disabled account, so
    // reject any non-boolean input rather than acting on it.
    let active: boolean | null = null;
    if (req.body.is_active !== undefined) {
      if (typeof req.body.is_active !== 'boolean') {
        return res.status(400).json({ error: 'is_active يجب أن يكون قيمة منطقية (true/false)' });
      }
      active = req.body.is_active;
    }
    const password = req.body.password === undefined ? '' : String(req.body.password);
    if (!roleCode && active === null && !password) return res.status(400).json({ error: 'لا توجد تغييرات' });
    if (password && (password.length < 8 || password.length > 128)) return res.status(400).json({ error: 'كلمة المرور يجب ألا تقل عن 8 أحرف' });
    if (req.params.id === req.user!.id && (active === false || (roleCode && roleCode !== 'super_admin'))) {
      return res.status(409).json({ error: 'لا يمكنك تعطيل حساب الـSuper Admin الحالي أو إزالة دوره' });
    }
    const connection = await getConnection();
    try {
      await connection.beginTransaction();
      const [userRows] = await connection.execute(
        `SELECT u.id,u.is_active FROM users u WHERE u.id=?
         AND EXISTS(SELECT 1 FROM admin_user_roles r WHERE r.user_id=u.id) FOR UPDATE`, [req.params.id]
      );
      const target = (userRows as Array<{ id: string; is_active: number; roles?: string }>)[0];
      if (!target) { await connection.rollback(); return res.status(404).json({ error: 'حساب المسؤول غير موجود' }); }
      const [currentRoleRows] = await connection.execute('SELECT role_code FROM admin_user_roles WHERE user_id=?', [target.id]);
      target.roles = (currentRoleRows as Array<{ role_code: string }>).map(row => row.role_code).join(',');
      if (roleCode) {
        const [roleRows] = await connection.execute('SELECT code FROM admin_roles WHERE code=?', [roleCode]);
        if (!(roleRows as unknown[]).length) { await connection.rollback(); return res.status(400).json({ error: 'الدور الإداري غير معروف' }); }
        await connection.execute('DELETE FROM admin_team_memberships WHERE user_id=?', [target.id]);
        await connection.execute('DELETE FROM admin_user_roles WHERE user_id=?', [target.id]);
        await connection.execute('INSERT INTO admin_user_roles(user_id,role_code,assigned_by) VALUES (?,?,?)', [target.id, roleCode, req.user!.id]);
        if (teamForRole[roleCode]) {
          await connection.execute(
            `INSERT INTO admin_team_memberships(team_id,user_id) SELECT id,? FROM admin_teams WHERE code=?`,
            [target.id, teamForRole[roleCode]]
          );
        }
      }
      if (active !== null) await connection.execute('UPDATE users SET is_active=? WHERE id=?', [active ? 1 : 0, target.id]);
      if (password) await connection.execute('UPDATE users SET password_hash=? WHERE id=?', [await deps.hashPassword(password), target.id]);
      // Every explicit authority/credential transition invalidates previous login
      // tokens. This is in the same transaction as the change and its audit.
      await connection.execute(
        'UPDATE users SET token_version=COALESCE(token_version,0)+1 WHERE id=?', [target.id],
      );
      await connection.execute(
        `INSERT INTO audit_events(id,actor_user_id,action,resource_type,resource_id,old_value,new_value,reason)
         VALUES(UUID(),?,'admin_account.updated','user',?,?,?,?)`,
        [req.user!.id, target.id, JSON.stringify({ roles: target.roles, is_active: target.is_active }),
          JSON.stringify({ role_code: roleCode || target.roles, is_active: active === null ? Boolean(target.is_active) : active, password_reset: Boolean(password) }),
          String(req.body.reason || 'Admin account maintenance')]
      );
      await connection.commit();
      return res.json({ success: true });
    } catch (error) {
      await connection.rollback();
      console.error('Update admin account error:');
      return res.status(500).json({ error: 'تعذر تحديث حساب المسؤول' });
    } finally { connection.release(); }
  }));

  // Explicitly promote an existing staff identity; no bulk/automatic promotion.
  // Promotion creates an administrative login account, so it follows the same
  // Super Admin verification as direct creation and modification above.
  router.post('/staff/:id/roles', deps.manageRoles, sensitiveAction, asyncRouteBoundary(async (req: AuthRequest, res: Response) => {
    if (!(await deps.isSuperAdmin(req.user!.id))) return res.status(403).json({ error: 'Super Admin only' });
    const roleCode = String(req.body.role_code ?? '').trim();
    const connection = await getConnection();
    try {
      await connection.beginTransaction();
      const [roleRows] = await connection.execute('SELECT code FROM admin_roles WHERE code=?', [roleCode]);
      if (!Array.isArray(roleRows) || roleRows.length === 0) { await connection.rollback(); return res.status(400).json({ error: 'Unknown admin role' }); }
      const [staffRows] = await connection.execute(
        'SELECT id,name,email,phone,password_hash,is_active,token_version FROM staff WHERE id=? FOR UPDATE', [req.params.id]
      );
      const staff = (staffRows as Array<{ id: string; name: string; email: string | null; phone: string | null; password_hash: string; is_active: number; token_version: number | string | null }>)[0];
      if (!staff || !staff.is_active || !staff.password_hash) { await connection.rollback(); return res.status(404).json({ error: 'Active staff member not found' }); }
      const [existingRows] = await connection.execute('SELECT id,role,token_version FROM users WHERE id=? FOR UPDATE', [staff.id]);
      const existing = (existingRows as Array<{ id: string; role: string; token_version: number | string | null }>)[0];
      if (existing && existing.role !== 'staff') { await connection.rollback(); return res.status(409).json({ error: 'Identity conflict requires manual review' }); }
      // Keep both namespaces above every previously issued version, including
      // legacy JWTs that carry no session source. Never coerce corruption to zero.
      const versionOf = (value: number | string | null): number => {
        if (value === null) return 0;
        if (typeof value === 'string' && !/^\d+$/.test(value)) throw new Error('Invalid identity version');
        const version = Number(value);
        if (!Number.isSafeInteger(version) || version < 0) throw new Error('Invalid identity version');
        return version;
      };
      const nextVersion = Math.max(versionOf(staff.token_version), existing ? versionOf(existing.token_version) : 0) + 1;
      if (!Number.isSafeInteger(nextVersion)) throw new Error('Identity version exhausted');
      if (!existing) {
        const [contactRows] = await connection.execute(
          'SELECT id FROM users WHERE (phone IS NOT NULL AND phone=?) OR (email IS NOT NULL AND email=?) LIMIT 1',
          [staff.phone, staff.email]
        );
        if (Array.isArray(contactRows) && contactRows.length) { await connection.rollback(); return res.status(409).json({ error: 'Contact conflict requires manual review' }); }
        await connection.execute(
          `INSERT INTO users (id,name,email,phone,password_hash,role,is_active,token_version)
           VALUES (?,?,?,?,?,'staff',1,?)`,
          [staff.id, staff.name, staff.email, staff.phone, staff.password_hash, nextVersion]
        );
      }
      await connection.execute('UPDATE staff SET token_version=? WHERE id=?', [nextVersion, staff.id]);
      if (existing) await connection.execute('UPDATE users SET token_version=? WHERE id=?', [nextVersion, staff.id]);
      await connection.execute(
        'INSERT IGNORE INTO admin_user_roles (user_id,role_code,assigned_by) VALUES (?,?,?)',
        [staff.id, roleCode, req.user!.id]
      );
      if (teamForRole[roleCode]) {
        await connection.execute(
          `INSERT IGNORE INTO admin_team_memberships (team_id,user_id)
           SELECT id,? FROM admin_teams WHERE code=?`, [staff.id, teamForRole[roleCode]]
        );
      }
      await connection.execute(
        `INSERT INTO audit_events
         (id,actor_user_id,action,resource_type,resource_id,new_value,reason)
         VALUES (UUID(),?,'admin_role.assigned','user',?,?,?)`,
        [req.user!.id, staff.id, JSON.stringify({ role_code: roleCode }), String(req.body.reason ?? 'Explicit staff appointment')]
      );
      await connection.commit();
      return res.status(201).json({ user_id: staff.id, role_code: roleCode });
    } catch (error) {
      await connection.rollback();
      console.error('Appoint staff admin error:');
      return res.status(500).json({ error: 'Failed to appoint admin member' });
    } finally { connection.release(); }
  }));

  return router;
};

export default createAdminMembersRouter({
  db: {
    query: async <T>(sql: string, params?: unknown[]) => (await loadDb()).query<T>(sql, params),
    getConnection: async () => (await loadDb()).getPool().getConnection(),
  },
  authenticate: authenticateToken,
  manageRoles: requireAdminPermission('admin_roles.manage'),
  sensitiveAction: process.env.AUTH_LOGIN_SESSIONS_ENABLED === 'true'
    ? createProductionSensitiveActionMfa({ permission: 'admin_roles.manage' })
    : undefined,
  isSuperAdmin,
  hashPassword: (password) => bcrypt.hash(password, 10),
});
