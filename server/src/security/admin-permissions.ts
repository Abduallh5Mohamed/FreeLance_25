import { Response, NextFunction } from 'express';
import { query } from '../db';
import { AuthRequest } from '../middleware/auth';

export async function isSuperAdmin(userId: string): Promise<boolean> {
  const rows = await query<{ user_id: string }>(
    `SELECT user_id FROM admin_user_roles
     WHERE user_id=? AND role_code='super_admin' LIMIT 1`, [userId]
  );
  return rows.length > 0;
}

export async function getAdminRoleCodes(userId: string): Promise<string[]> {
  const rows = await query<{ role_code: string }>(
    'SELECT role_code FROM admin_user_roles WHERE user_id=? ORDER BY role_code', [userId]
  );
  return rows.map(row => row.role_code);
}

export async function getAdminPermissions(userId: string): Promise<string[]> {
  const rows = await query<{ permission_key: string }>(
    `SELECT DISTINCT rp.permission_key
     FROM admin_user_roles ur
     INNER JOIN admin_role_permissions rp ON rp.role_code = ur.role_code
     INNER JOIN users u ON u.id = ur.user_id AND u.is_active = 1
     WHERE ur.user_id = ?`,
    [userId]
  );
  return rows.map((row) => row.permission_key);
}

export const requireAdminPermission = (permission: string) =>
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    try {
      if (await isSuperAdmin(req.user.id)) return next();
      const permissions = await getAdminPermissions(req.user.id);
      if (!permissions.includes(permission)) return res.status(403).json({ error: 'Forbidden' });
      next();
    } catch (error) {
      console.error('Admin permission lookup failed:', error);
      return res.status(503).json({ error: 'Admin permissions unavailable; apply the SaaS migration' });
    }
  };

export const requireSelfOrAdminPermission = (paramName: string, permission: string) =>
  (req: AuthRequest, res: Response, next: NextFunction) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    if (String(req.user.id) === String(req.params[paramName])) return next();
    return requireAdminPermission(permission)(req, res, next);
  };
