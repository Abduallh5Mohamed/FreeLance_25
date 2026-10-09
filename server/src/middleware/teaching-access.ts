import { Response, NextFunction } from 'express';
import { queryOne } from '../db';
import { AuthRequest } from './auth';

const pageForArea: Record<string, string> = {
  students: 'students', lectures: 'courses', groups: 'groups', materials: 'courses', exams: 'courses', courses: 'courses',
};

/** Applies to teaching writes, not to student learning reads. */
export const requireTeachingWrite = (area: keyof typeof pageForArea) =>
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    try {
      if (req.user.role === 'teacher') return next();
      if (req.user.role === 'staff') {
        const staff = await queryOne<{ accessible_pages: string | string[]; is_active: number }>(
          'SELECT accessible_pages,is_active FROM staff WHERE id=?', [req.user.id]
        );
        let pages: string[] = [];
        if (staff?.accessible_pages) {
          pages = typeof staff.accessible_pages === 'string'
            ? JSON.parse(staff.accessible_pages) : staff.accessible_pages;
        }
        if (staff?.is_active && pages.includes(pageForArea[area])) return next();
        return res.status(403).json({ error: 'Staff page permission required' });
      }
      if (req.user.role !== 'instructor') return res.status(403).json({ error: 'Teaching access required' });
      const row = await queryOne<{ can_write: number }>(
        `SELECT CASE
           WHEN u.is_active<>1 OR t.status<>'active' OR m.status<>'active' THEN 0
           WHEN t.legacy_compat=1 THEN 1
           WHEN EXISTS (
             SELECT 1 FROM tenant_subscriptions s WHERE s.tenant_id=t.id
               AND s.status IN ('active','grace_period','past_due')
               AND s.starts_at<=UTC_TIMESTAMP()
               AND DATE_ADD(s.period_ends_at, INTERVAL 4 DAY)>UTC_TIMESTAMP()
           ) THEN 1 ELSE 0 END AS can_write
         FROM tenant_memberships m
         INNER JOIN tenants t ON t.id=m.tenant_id
         INNER JOIN users u ON u.id=m.user_id
         WHERE m.user_id=? AND m.role_key IN ('owner','instructor')
         LIMIT 1`, [req.user.id]
      );
      if (!row?.can_write) return res.status(403).json({ error: 'Instructor subscription is not active for teaching writes' });
      next();
    } catch (error) {
      console.error('Teaching entitlement check failed:', error);
      return res.status(503).json({ error: 'Teaching entitlement unavailable' });
    }
  };
