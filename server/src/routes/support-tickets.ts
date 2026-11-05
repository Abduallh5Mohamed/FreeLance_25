import { Router, Response } from 'express';
import { getPool, query, queryOne } from '../db';
import { authenticateToken, AuthRequest } from '../middleware/auth';
import { requireAdminPermission, hasVerifiedPlatformPermission } from '../security/admin-permissions';
import { createSupportWriteService } from '../services/support-writes';

const router = Router();
const writes = createSupportWriteService({ getConnection: () => getPool().getConnection() });

const categories = new Set(['technical', 'account', 'billing', 'content', 'exam', 'video', 'other']);
const statuses = new Set(['open', 'waiting_on_support', 'waiting_on_user', 'resolved', 'closed']);

interface TicketRecord {
  id: string;
  ticket_number: string;
  user_id: string;
  status: string;
}

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

// The cursor is an existing reply selector, never authority. Both anchor and
// page are constrained to the freshly authorized ticket; dates stay in SQL.
async function replyPage(ticketId: string, before?: string) {
  const rows = await query(
    `SELECT r.id, r.body, r.created_at, r.sender_id, u.name AS sender_name, u.role AS sender_role
     FROM support_ticket_replies r
     INNER JOIN users u ON u.id = r.sender_id
     ${before ? 'INNER JOIN support_ticket_replies anchor ON anchor.id = ? AND anchor.ticket_id = r.ticket_id' : ''}
     WHERE r.ticket_id = ?
     ${before ? 'AND (r.created_at < anchor.created_at OR (r.created_at = anchor.created_at AND r.id < anchor.id))' : ''}
     ORDER BY r.created_at DESC, r.id DESC LIMIT 101`, before ? [before, ticketId] : [ticketId]);
  const page = rows.slice(0, 100);
  return { replies: page.reverse(), next_cursor: rows.length > 100 ? String(rows[99].id) : null };
}

router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
router.use(authenticateToken);

router.post('/', async (req: AuthRequest, res: Response) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  const result = await writes.create(req.user, req.headers['idempotency-key'], req.body);
  return res.status(result.status).json(result.body);
});
router.get('/attempts/:operation/:requestId', async (req: AuthRequest, res: Response) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  if (Object.keys(req.query).length) return res.status(400).json({ error: 'Unexpected support attempt selector' });
  const result = await writes.reconcile(req.user, req.params.operation, req.params.requestId);
  return res.status(result.status).json(result.body);
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

router.get('/:id/replies', async (req: AuthRequest, res: Response) => {
  try {
    const visible = await getVisibleTicket(req, req.params.id);
    if (!visible) return res.status(404).json({ error: 'Support ticket not found' });
    const before = req.query.before;
    if (Object.keys(req.query).some(key => key !== 'before') || typeof before !== 'string' || !/^[a-zA-Z0-9-]{1,64}$/.test(before)) {
      return res.status(400).json({ error: 'Invalid reply cursor' });
    }
    const anchor = await queryOne('SELECT id FROM support_ticket_replies WHERE ticket_id = ? AND id = ? LIMIT 1', [visible.id, before]);
    if (!anchor) return res.status(400).json({ error: 'Invalid reply cursor' });
    return res.json(await replyPage(visible.id, before));
  } catch {
    return res.status(500).json({ error: 'Failed to load older support replies' });
  }
});
router.get('/:id/context', async (req:AuthRequest,res:Response) => {
  if(!req.user)return res.status(401).json({error:'Unauthorized'});
  if(Object.keys(req.query).length)return res.status(400).json({error:'Unexpected support context selector'});
  const result=await writes.context(req.user,req.params.id);return res.status(result.status).json(result.body);
});

router.get('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const visible = await getVisibleTicket(req, req.params.id);
    if (!visible) return res.status(404).json({ error: 'Support ticket not found' });
    const admin = await isAdmin(req);
    const ticket = await queryOne(
      `SELECT t.id,t.ticket_number,t.user_id,t.category,t.subject,t.description,t.status,t.priority,
              t.created_at,t.updated_at,u.name AS user_name
       FROM support_tickets t
       INNER JOIN users u ON u.id = t.user_id
       WHERE t.id = ?${admin ? '' : ' AND t.user_id = ?'} LIMIT 1`,
      admin ? [visible.id] : [visible.id, req.user?.id]
    );
    if (!ticket) return res.status(404).json({ error: 'Support ticket not found' });
    const page = await replyPage(visible.id);
    return res.json({ ticket, ...page, has_more_replies: page.next_cursor !== null });
  } catch (error) {
    console.error('Get support ticket error:', error);
    return res.status(500).json({ error: 'Failed to load support ticket' });
  }
});

router.post('/:id/replies', async (req: AuthRequest, res: Response) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  const result = await writes.reply(req.user, req.params.id, req.headers['idempotency-key'], req.body);
  return res.status(result.status).json(result.body);
});

router.patch('/:id/status', async (req: AuthRequest, res: Response) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  const result = await writes.status(req.user, req.params.id, req.body);
  return res.status(result.status).json(result.body);
});

export default router;
