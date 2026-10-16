import { Router, Response } from 'express';
import { execute, query } from '../db';
import { authenticateToken, AuthRequest } from '../middleware/auth';

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

// Get notifications for a user
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const { is_read } = req.query;

    const limit = parseListLimit(req.query.limit);
    if (limit === null) {
      return res.status(400).json({ error: 'limit must be a positive integer' });
    }

    let sql = 'SELECT * FROM notifications WHERE 1=1';
    const params: unknown[] = [];

    sql += ' AND user_id = ?';
    params.push(req.user!.id);

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

    const result = await execute(
      'UPDATE notifications SET is_read = TRUE WHERE id = ? AND user_id = ?',
      [id, req.user!.id]
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
    await query(
      'UPDATE notifications SET is_read = TRUE WHERE user_id = ?',
      [req.user!.id]
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
    const result = await query(
      'SELECT COUNT(*) as count FROM notifications WHERE user_id = ? AND is_read = FALSE',
      [req.user!.id]
    ) as unknown[];
    
    const count = Array.isArray(result) && result.length > 0 ? (result[0] as Record<string, unknown>).count : 0;
    res.json({ count });
  } catch (error) {
    console.error('Error fetching unread count:', error);
    res.status(500).json({ error: 'Failed to fetch unread count' });
  }
});

export default router;
