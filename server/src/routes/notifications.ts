import { Router, Response } from 'express';
import { query } from '../db';
import { authenticateToken, AuthRequest } from '../middleware/auth';

const router = Router();
router.use(authenticateToken);

// Get notifications for a user
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const { is_read } = req.query;
    
    let sql = 'SELECT * FROM notifications WHERE 1=1';
    const params: unknown[] = [];
    
    sql += ' AND user_id = ?';
    params.push(req.user!.id);
    
    if (is_read !== undefined) {
      sql += ' AND is_read = ?';
      params.push(is_read === 'true' ? 1 : 0);
    }
    
    sql += ' ORDER BY created_at DESC';
    
    const notifications = await query(sql, params);
    res.json(notifications);
  } catch (error) {
    console.error('Error fetching notifications:', error);
    res.status(500).json({ error: 'Failed to fetch notifications' });
  }
});

// Mark notification as read
router.put('/:id/read', async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    
    await query(
      'UPDATE notifications SET is_read = TRUE WHERE id = ? AND user_id = ?',
      [id, req.user!.id]
    );
    
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
