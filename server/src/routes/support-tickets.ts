import { randomUUID, randomBytes } from 'crypto';
import { Router, Response } from 'express';
import { execute, query, queryOne } from '../db';
import { authenticateToken, AuthRequest } from '../middleware/auth';
import { requireAdminPermission, hasVerifiedPlatformPermission } from '../security/admin-permissions';

const router = Router();

const categories = new Set(['technical', 'account', 'billing', 'content', 'exam', 'video', 'other']);
const statuses = new Set(['open', 'waiting_on_support', 'waiting_on_user', 'resolved', 'closed']);

interface TicketRecord {
  id: string;
  ticket_number: string;
  user_id: string;
  status: string;
}

const ticketNumber = () => {
  const month = new Date().toISOString().slice(0, 7).replace('-', '');
  return `SUP-${month}-${randomBytes(3).toString('hex').toUpperCase()}`;
};

// Administrative actions on any ticket require the same verified platform
// capability the queue guard enforces (active super_admin or holder of the
// permission key); a JWT role claim alone never satisfies it.
const isAdmin = async (req: AuthRequest) =>
  !!req.user && (await hasVerifiedPlatformPermission('support.read', req.user.id));

// Bounded page size for ticket listings. MySQL refuses bound LIMIT
// placeholders, so the bound is validated here and interpolated only as a
// number — never raw request input.
const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 100;

const parseListLimit = (raw: unknown): number | null => {
  if (raw === undefined) return DEFAULT_LIST_LIMIT;
  const value = Array.isArray(raw) ? NaN : Number(raw);
  if (!Number.isInteger(value) || value < 1) return null;
  return Math.min(value, MAX_LIST_LIMIT);
};

async function getVisibleTicket(req: AuthRequest, id: string): Promise<TicketRecord | null> {
  const ticket = await queryOne<TicketRecord>(
    'SELECT id, ticket_number, user_id, status FROM support_tickets WHERE id = ?',
    [id]
  );
  if (!ticket) return null;
  if (!(await isAdmin(req)) && ticket.user_id !== req.user?.id) return null;
  return ticket;
}

router.use(authenticateToken);

router.post('/', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    const category = String(req.body.category || '');
    const subject = String(req.body.subject || '').trim();
    const description = String(req.body.description || '').trim();

    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    if (!categories.has(category)) return res.status(400).json({ error: 'Invalid support category' });
    if (subject.length < 3 || subject.length > 200) return res.status(400).json({ error: 'Subject must be between 3 and 200 characters' });
    if (description.length < 10 || description.length > 10000) return res.status(400).json({ error: 'Description must be between 10 and 10000 characters' });

    const id = randomUUID();
    const number = ticketNumber();
    await execute(
      `INSERT INTO support_tickets
        (id, ticket_number, user_id, category, subject, description, status, priority)
       VALUES (?, ?, ?, ?, ?, ?, 'open', 'normal')`,
      [id, number, userId, category, subject, description]
    );

    const created = await queryOne('SELECT * FROM support_tickets WHERE id = ?', [id]);
    return res.status(201).json(created);
  } catch (error) {
    console.error('Create support ticket error:', error);
    return res.status(500).json({ error: 'Failed to create support ticket' });
  }
});

router.get('/mine', async (req: AuthRequest, res: Response) => {
  try {
    const limit = parseListLimit(req.query.limit);
    if (limit === null) {
      return res.status(400).json({ error: 'limit must be a positive integer' });
    }

    const tickets = await query(
      `SELECT id, ticket_number, category, subject, status, priority, created_at, updated_at
       FROM support_tickets
       WHERE user_id = ?
       ORDER BY updated_at DESC
       LIMIT ${limit}`,
      [req.user?.id]
    );
    return res.json(tickets);
  } catch (error) {
    console.error('List own support tickets error:', error);
    return res.status(500).json({ error: 'Failed to load support tickets' });
  }
});

router.get('/', requireAdminPermission('support.read'), async (req: AuthRequest, res: Response) => {
  try {
    const filters: string[] = [];
    const params: unknown[] = [];
    const status = typeof req.query.status === 'string' ? req.query.status : undefined;
    const category = typeof req.query.category === 'string' ? req.query.category : undefined;
    if (status && statuses.has(status)) { filters.push('t.status = ?'); params.push(status); }
    if (category && categories.has(category)) { filters.push('t.category = ?'); params.push(category); }

    const tickets = await query(
      `SELECT t.id, t.ticket_number, t.category, t.subject, t.status, t.priority,
              t.created_at, t.updated_at, u.name AS user_name, u.phone AS user_phone
       FROM support_tickets t
       INNER JOIN users u ON u.id = t.user_id
       ${filters.length ? `WHERE ${filters.join(' AND ')}` : ''}
       ORDER BY FIELD(t.priority, 'urgent', 'high', 'normal', 'low'), t.updated_at DESC
       LIMIT 250`,
      params
    );
    return res.json(tickets);
  } catch (error) {
    console.error('List support queue error:', error);
    return res.status(500).json({ error: 'Failed to load support queue' });
  }
});

router.get('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const visible = await getVisibleTicket(req, req.params.id);
    if (!visible) return res.status(404).json({ error: 'Support ticket not found' });

    const ticket = await queryOne(
      `SELECT t.*, u.name AS user_name, u.phone AS user_phone
       FROM support_tickets t
       INNER JOIN users u ON u.id = t.user_id
       WHERE t.id = ?`,
      [visible.id]
    );
    const replies = await query(
      `SELECT r.id, r.body, r.created_at, r.sender_id, u.name AS sender_name, u.role AS sender_role
       FROM support_ticket_replies r
       INNER JOIN users u ON u.id = r.sender_id
       WHERE r.ticket_id = ?
       ORDER BY r.created_at ASC`,
      [visible.id]
    );
    return res.json({ ticket, replies });
  } catch (error) {
    console.error('Get support ticket error:', error);
    return res.status(500).json({ error: 'Failed to load support ticket' });
  }
});

router.post('/:id/replies', async (req: AuthRequest, res: Response) => {
  try {
    const visible = await getVisibleTicket(req, req.params.id);
    if (!visible) return res.status(404).json({ error: 'Support ticket not found' });
    if (visible.status === 'closed') return res.status(409).json({ error: 'Closed tickets cannot receive replies' });

    const body = String(req.body.body || '').trim();
    if (body.length < 1 || body.length > 10000) return res.status(400).json({ error: 'Reply must be between 1 and 10000 characters' });

    const replyId = randomUUID();
    await execute(
      'INSERT INTO support_ticket_replies (id, ticket_id, sender_id, body) VALUES (?, ?, ?, ?)',
      [replyId, visible.id, req.user?.id, body]
    );
    await execute(
      'UPDATE support_tickets SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [(await isAdmin(req)) ? 'waiting_on_user' : 'waiting_on_support', visible.id]
    );
    const reply = await queryOne(
      `SELECT r.id, r.body, r.created_at, r.sender_id, u.name AS sender_name, u.role AS sender_role
       FROM support_ticket_replies r INNER JOIN users u ON u.id = r.sender_id WHERE r.id = ?`,
      [replyId]
    );
    return res.status(201).json(reply);
  } catch (error) {
    console.error('Reply to support ticket error:', error);
    return res.status(500).json({ error: 'Failed to send support reply' });
  }
});

router.patch('/:id/status', async (req: AuthRequest, res: Response) => {
  try {
    const visible = await getVisibleTicket(req, req.params.id);
    if (!visible) return res.status(404).json({ error: 'Support ticket not found' });
    const nextStatus = String(req.body.status || '');
    if (!statuses.has(nextStatus)) return res.status(400).json({ error: 'Invalid support status' });
    if (!(await isAdmin(req)) && !['resolved', 'closed'].includes(nextStatus)) {
      return res.status(403).json({ error: 'Users can only resolve or close their own tickets' });
    }

    await execute(
      `UPDATE support_tickets
       SET status = ?,
           resolved_at = CASE WHEN ? = 'resolved' THEN CURRENT_TIMESTAMP ELSE resolved_at END,
           closed_at = CASE WHEN ? = 'closed' THEN CURRENT_TIMESTAMP ELSE closed_at END
       WHERE id = ?`,
      [nextStatus, nextStatus, nextStatus, visible.id]
    );
    return res.json({ success: true, status: nextStatus });
  } catch (error) {
    console.error('Update support status error:', error);
    return res.status(500).json({ error: 'Failed to update support status' });
  }
});

export default router;
