import { Router, Response } from 'express';
import { execute, query, queryOne } from '../db';
import { authenticateToken, AuthRequest } from '../middleware/auth';
import {
  canDeliver,
  fetchPreferences,
  defaultPreferences,
  parsePreferencesInput,
  savePreferences,
} from '../services/notification-preferences';

const router = Router();
router.use(authenticateToken);

// Bounded read window for the append-heavy per-user feed.
const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 100;

// MySQL refuses bound LIMIT placeholders (ER_WRONG_ARGUMENTS), so the bound is
// validated here and interpolated only as a number — never raw request input.
const parseListLimit = (raw: unknown): number | null => {
  if (raw === undefined) return DEFAULT_LIST_LIMIT;
  const value = Array.isArray(raw) ? NaN : Number(raw);
  if (!Number.isInteger(value) || value < 1) return null;
  return Math.min(value, MAX_LIST_LIMIT);
};

// Notifications are keyed by (user_id, user_type): every producer persists a
// role-aligned user_type ('student' | 'admin' | 'instructor'). We bind that
// server-derived principal namespace on every owner-scoped query so a row from a
// different namespace can never be read or mutated, even when a (user_id,
// user_type) pair collides across the users/staff identity spaces. The
// namespace is taken from the authenticated principal's role (validated at token
// resolution), never from any client-supplied value. Roles outside the set
// actually emitted by producers fail closed.
const NOTIFICATION_NAMESPACES = new Set(['student', 'admin', 'instructor']);

const principalNotificationNamespace = (req: AuthRequest): string | null => {
  const role = req.user?.role;
  if (!role || !NOTIFICATION_NAMESPACES.has(role)) return null;
  return role;
};

const requireNotificationNamespace = (req: AuthRequest, res: Response): string | null => {
  const ns = principalNotificationNamespace(req);
  if (ns === null) {
    res.status(403).json({ error: 'Account type is not eligible for notifications' });
  }
  return ns;
};

// Per-user channel preferences (M6 P3). Owner-scoped by the server-derived
// (user_id, user_type) namespace; quiet defaults served when no row exists.
router.get('/preferences', async (req: AuthRequest, res: Response) => {
  try {
    const ns = requireNotificationNamespace(req, res);
    if (ns === null) return;

    const stored = await fetchPreferences(queryOne, req.user!.id, ns);
    res.json(stored ?? defaultPreferences());
  } catch (error) {
    console.error('Error fetching notification preferences:', error);
    res.status(500).json({ error: 'Failed to fetch notification preferences' });
  }
});

router.put('/preferences', async (req: AuthRequest, res: Response) => {
  try {
    const ns = requireNotificationNamespace(req, res);
    if (ns === null) return;

    const parsed = parsePreferencesInput(req.body);
    if (!parsed.ok) {
      return res.status(400).json({ error: parsed.error });
    }

    const saved = await savePreferences(execute, queryOne, req.user!.id, ns, parsed.value);
    res.json(saved);
  } catch (error) {
    console.error('Error updating notification preferences:', error);
    res.status(500).json({ error: 'Failed to update notification preferences' });
  }
});

// Get notifications for a user
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const { is_read } = req.query;

    const limit = parseListLimit(req.query.limit);
    if (limit === null) {
      return res.status(400).json({ error: 'limit must be a positive integer' });
    }

    const ns = requireNotificationNamespace(req, res);
    if (ns === null) return;

    // Server-side opt-out: an in_app=false preference suppresses the in-app
    // feed itself, so opting out stops delivery, not just display.
    const prefs = await fetchPreferences(queryOne, req.user!.id, ns);
    if (!canDeliver(prefs, 'in_app')) {
      return res.json([]);
    }

    let sql = 'SELECT * FROM notifications WHERE 1=1';
    const params: unknown[] = [];

    sql += ' AND user_id = ? AND user_type = ?';
    params.push(req.user!.id, ns);

    if (is_read !== undefined) {
      const filter = Array.isArray(is_read) ? undefined : is_read;
      if (filter !== 'true' && filter !== 'false') {
        return res.status(400).json({ error: 'is_read must be "true" or "false"' });
      }
      sql += ' AND is_read = ?';
      params.push(filter === 'true' ? 1 : 0);
    }

    sql += ' ORDER BY created_at DESC';
    sql += ` LIMIT ${limit}`;

    const notifications = await query(sql, params);
    res.json(notifications);
  } catch (error) {
    console.error('Error fetching notifications:', error);
    res.status(500).json({ error: 'Failed to fetch notifications' });
  }
});

// Mark notification as read (owner-scoped; foreign/unknown ids fail closed)
router.put('/:id/read', async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;

    const ns = requireNotificationNamespace(req, res);
    if (ns === null) return;

    const result = await execute(
      'UPDATE notifications SET is_read = TRUE WHERE id = ? AND user_id = ? AND user_type = ?',
      [id, req.user!.id, ns]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Notification not found' });
    }

    res.json({ message: 'Notification marked as read' });
  } catch (error) {
    console.error('Error updating notification:', error);
    res.status(500).json({ error: 'Failed to update notification' });
  }
});

// Mark all notifications as read for a user
router.put('/read-all', async (req: AuthRequest, res: Response) => {
  try {
    const ns = requireNotificationNamespace(req, res);
    if (ns === null) return;

    await query(
      'UPDATE notifications SET is_read = TRUE WHERE user_id = ? AND user_type = ?',
      [req.user!.id, ns]
    );
    
    res.json({ message: 'All notifications marked as read' });
  } catch (error) {
    console.error('Error updating notifications:', error);
    res.status(500).json({ error: 'Failed to update notifications' });
  }
});

// Get unread count
router.get('/unread-count', async (req: AuthRequest, res: Response) => {
  try {
    const ns = requireNotificationNamespace(req, res);
    if (ns === null) return;

    // Opted-out in-app channel reports zero instead of a stale badge count.
    const prefs = await fetchPreferences(queryOne, req.user!.id, ns);
    if (!canDeliver(prefs, 'in_app')) {
      return res.json({ count: 0 });
    }

    const result = await query(
      'SELECT COUNT(*) as count FROM notifications WHERE user_id = ? AND user_type = ? AND is_read = FALSE',
      [req.user!.id, ns]
    ) as unknown[];
    
    const count = Array.isArray(result) && result.length > 0 ? (result[0] as Record<string, unknown>).count : 0;
    res.json({ count });
  } catch (error) {
    console.error('Error fetching unread count:', error);
    res.status(500).json({ error: 'Failed to fetch unread count' });
  }
});

export default router;
