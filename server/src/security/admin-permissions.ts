import { Response, NextFunction } from 'express';
import { AuthRequest } from '../middleware/auth';

/**
 * `../db` is loaded lazily (and cached) so importing this module never runs
 * db.ts: no dotenv side effect and no pool creation at import time. The pool
 * is created on the first real query.
 */
let dbModule: typeof import('../db') | null = null;
const loadDb = async (): Promise<typeof import('../db')> => {
    dbModule ??= await import('../db');
    return dbModule;
};

export async function isSuperAdmin(userId: string): Promise<boolean> {
  const { query } = await loadDb();
  const rows = await query<{ user_id: string }>(
    `SELECT ur.user_id FROM admin_user_roles ur
     INNER JOIN users u ON u.id=ur.user_id AND u.is_active=1
     WHERE ur.user_id=? AND ur.role_code='super_admin' LIMIT 1`, [userId]
  );
  return rows.length > 0;
}

export async function getAdminRoleCodes(userId: string): Promise<string[]> {
  const { query } = await loadDb();
  const rows = await query<{ role_code: string }>(
    'SELECT role_code FROM admin_user_roles WHERE user_id=? ORDER BY role_code', [userId]
  );
  return rows.map(row => row.role_code);
}

export async function getAdminPermissions(userId: string): Promise<string[]> {
  const { query } = await loadDb();
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

/**
 * Server-side lookup boundary for platform-admin verification. Production
 * wiring passes the SQL-backed functions below; hermetic tests inject
 * isolated fixtures through createRequireAdminPermission, so the real guard
 * is exercised without a database.
 */
export interface AdminPermissionLookup {
  isSuperAdmin: (userId: string) => Promise<boolean>;
  getAdminPermissions: (userId: string) => Promise<string[]>;
}

const defaultAdminPermissionLookup: AdminPermissionLookup = {
  isSuperAdmin,
  getAdminPermissions,
};

/**
 * Guard factory: a principal reaches the wrapped route only when it is a
 * verified, active super_admin (admin_user_roles row against an active users
 * row) or holds the required platform permission key. A JWT role claim alone
 * never satisfies this guard: deny-by-default for every other identity,
 * including tenant admins. Lookup failures deny (503) instead of failing
 * open; a missing permission key denies with 403.
 */
export const createRequireAdminPermission = (
  permission: string,
  lookup: AdminPermissionLookup = defaultAdminPermissionLookup,
) =>
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    try {
      if (await lookup.isSuperAdmin(req.user.id)) return next();
      const permissions = await lookup.getAdminPermissions(req.user.id);
      if (!permissions.includes(permission)) return res.status(403).json({ error: 'Forbidden' });
      next();
    } catch (error) {
      console.error('Admin permission lookup failed:', error);
      return res.status(503).json({ error: 'Admin permissions unavailable; apply the SaaS migration' });
    }
  };

export const requireAdminPermission = (permission: string) =>
  createRequireAdminPermission(permission);

/**
 * Inline platform-capability predicate for handlers that must authorize an
 * action without owning the response (e.g. inside a video or socket handler).
 * Same verified rule as the guard: a server-verified active super_admin or a
 * holder of the permission key. A JWT role claim alone never satisfies it.
 */
export const createPlatformPermissionCheck = (
  permission: string,
  lookup: AdminPermissionLookup = defaultAdminPermissionLookup,
) =>
  async (userId: string): Promise<boolean> => {
    if (await lookup.isSuperAdmin(userId)) return true;
    const permissions = await lookup.getAdminPermissions(userId);
    return permissions.includes(permission);
  };

export const hasVerifiedPlatformPermission = (permission: string, userId: string): Promise<boolean> =>
  createPlatformPermissionCheck(permission)(userId);

export const requireSelfOrAdminPermission = (paramName: string, permission: string) =>
  (req: AuthRequest, res: Response, next: NextFunction) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    if (String(req.user.id) === String(req.params[paramName])) return next();
    return requireAdminPermission(permission)(req, res, next);
  };
