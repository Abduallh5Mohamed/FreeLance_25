import { Router, Response } from 'express';
import { randomUUID } from 'crypto';
import bcrypt from 'bcryptjs';
import { getPool, query } from '../db';
import { authenticateToken, AuthRequest } from '../middleware/auth';
import { isSuperAdmin, requireAdminPermission } from '../security/admin-permissions';

const router = Router();
router.use(authenticateToken);

const teamForRole: Record<string, string> = {
  super_admin: 'management', operations_admin: 'operations', billing_admin: 'billing',
  support_admin: 'support', security_admin: 'security', analyst: 'management',
};

router.get('/roles', requireAdminPermission('admin_roles.manage'), async (_req, res: Response) => {
  try { return res.json(await query('SELECT code,name FROM admin_roles ORDER BY code')); }
  catch (error) { console.error('List admin roles error:', error); return res.status(500).json({ error: 'Failed to load admin roles' }); }
});

router.get('/', requireAdminPermission('admin_roles.manage'), async (_req, res: Response) => {
  try {
    return res.json(await query(
      `SELECT u.id,u.name,u.email,u.phone,u.is_active,GROUP_CONCAT(ar.role_code ORDER BY ar.role_code) AS roles
       FROM admin_user_roles ar INNER JOIN users u ON u.id=ar.user_id
       GROUP BY u.id,u.name,u.email,u.phone,u.is_active ORDER BY u.name`
    ));
  } catch (error) { console.error('List admin members error:', error); return res.status(500).json({ error: 'Failed to load admin members' }); }
});

// Only the Super Admin creates administrative login accounts.
router.post('/', requireAdminPermission('admin_roles.manage'), async (req: AuthRequest, res: Response) => {
  if (!(await isSuperAdmin(req.user!.id))) return res.status(403).json({ error: 'Super Admin only' });
  const name = String(req.body.name ?? '').trim();
  const phone = String(req.body.phone ?? '').trim();
  const email = String(req.body.email ?? '').trim().toLowerCase() || null;
  const password = String(req.body.password ?? '');
  const roleCode = String(req.body.role_code ?? '').trim();
  if (name.length < 3 || name.length > 255 || phone.length < 6 || phone.length > 50 || password.length < 8 || password.length > 128 ||
      (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))) {
    return res.status(400).json({ error: 'الاسم والهاتف وكلمة مرور من 8 أحرف على الأقل مطلوبة' });
  }
  const connection = await getPool().getConnection();
  try {
    await connection.beginTransaction();
    const [roleRows] = await connection.execute('SELECT code FROM admin_roles WHERE code=?', [roleCode]);
    if (!(roleRows as unknown[]).length) { await connection.rollback(); return res.status(400).json({ error: 'الدور الإداري غير معروف' }); }
    const [duplicateRows] = await connection.execute(
      'SELECT id FROM users WHERE phone=? OR (? IS NOT NULL AND email=?) LIMIT 1', [phone, email, email]
    );
    if ((duplicateRows as unknown[]).length) { await connection.rollback(); return res.status(409).json({ error: 'رقم الهاتف أو البريد مستخدم بالفعل' }); }
    const id = randomUUID();
    const passwordHash = await bcrypt.hash(password, 10);
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
    console.error('Create admin account error:', error);
    return res.status(500).json({ error: 'تعذر إنشاء حساب المسؤول' });
  } finally { connection.release(); }
});

router.patch('/:id', requireAdminPermission('admin_roles.manage'), async (req: AuthRequest, res: Response) => {
  if (!(await isSuperAdmin(req.user!.id))) return res.status(403).json({ error: 'Super Admin only' });
  const roleCode = req.body.role_code === undefined ? null : String(req.body.role_code).trim();
  const active = req.body.is_active === undefined ? null : Boolean(req.body.is_active);
  const password = req.body.password === undefined ? '' : String(req.body.password);
  if (!roleCode && active === null && !password) return res.status(400).json({ error: 'لا توجد تغييرات' });
  if (password && (password.length < 8 || password.length > 128)) return res.status(400).json({ error: 'كلمة المرور يجب ألا تقل عن 8 أحرف' });
  if (req.params.id === req.user!.id && (active === false || (roleCode && roleCode !== 'super_admin'))) {
    return res.status(409).json({ error: 'لا يمكنك تعطيل حساب الـSuper Admin الحالي أو إزالة دوره' });
  }
  const connection = await getPool().getConnection();
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
    if (password) await connection.execute('UPDATE users SET password_hash=? WHERE id=?', [await bcrypt.hash(password, 10), target.id]);
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
    console.error('Update admin account error:', error);
    return res.status(500).json({ error: 'تعذر تحديث حساب المسؤول' });
  } finally { connection.release(); }
});

// Explicitly promote an existing staff identity; no bulk/automatic promotion.
router.post('/staff/:id/roles', requireAdminPermission('admin_roles.manage'), async (req: AuthRequest, res: Response) => {
  const roleCode = String(req.body.role_code ?? '').trim();
  const connection = await getPool().getConnection();
  try {
    await connection.beginTransaction();
    const [roleRows] = await connection.execute('SELECT code FROM admin_roles WHERE code=?', [roleCode]);
    if (!Array.isArray(roleRows) || roleRows.length === 0) { await connection.rollback(); return res.status(400).json({ error: 'Unknown admin role' }); }
    const [staffRows] = await connection.execute(
      'SELECT id,name,email,phone,password_hash,is_active FROM staff WHERE id=? FOR UPDATE', [req.params.id]
    );
    const staff = (staffRows as Array<{ id: string; name: string; email: string | null; phone: string | null; password_hash: string; is_active: number }>)[0];
    if (!staff || !staff.is_active || !staff.password_hash) { await connection.rollback(); return res.status(404).json({ error: 'Active staff member not found' }); }
    const [existingRows] = await connection.execute('SELECT id,role FROM users WHERE id=?', [staff.id]);
    const existing = (existingRows as Array<{ id: string; role: string }>)[0];
    if (existing && existing.role !== 'staff') { await connection.rollback(); return res.status(409).json({ error: 'Identity conflict requires manual review' }); }
    if (!existing) {
      const [contactRows] = await connection.execute(
        'SELECT id FROM users WHERE (phone IS NOT NULL AND phone=?) OR (email IS NOT NULL AND email=?) LIMIT 1',
        [staff.phone, staff.email]
      );
      if (Array.isArray(contactRows) && contactRows.length) { await connection.rollback(); return res.status(409).json({ error: 'Contact conflict requires manual review' }); }
      await connection.execute(
        `INSERT INTO users (id,name,email,phone,password_hash,role,is_active)
         VALUES (?,?,?,?,?,'staff',1)`,
        [staff.id, staff.name, staff.email, staff.phone, staff.password_hash]
      );
    }
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
    console.error('Appoint staff admin error:', error);
    return res.status(500).json({ error: 'Failed to appoint admin member' });
  } finally { connection.release(); }
});

export default router;
