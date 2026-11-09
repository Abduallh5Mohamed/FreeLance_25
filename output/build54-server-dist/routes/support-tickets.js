"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const db_1 = require("../db");
const auth_1 = require("../middleware/auth");
const admin_permissions_1 = require("../security/admin-permissions");
const support_writes_1 = require("../services/support-writes");
const router = (0, express_1.Router)();
const writes = (0, support_writes_1.createSupportWriteService)({ getConnection: () => (0, db_1.getPool)().getConnection() });
const categories = new Set(['technical', 'account', 'billing', 'content', 'exam', 'video', 'other']);
const statuses = new Set(['open', 'waiting_on_support', 'waiting_on_user', 'resolved', 'closed']);
// Administrative actions on any ticket require the same verified platform
// capability the queue guard enforces (active super_admin or holder of the
// permission key); a JWT role claim alone never satisfies it.
const isAdmin = async (req) => !!req.user && (await (0, admin_permissions_1.hasVerifiedPlatformPermission)('support.read', req.user.id));
// Bounded page size for ticket listings. MySQL refuses bound LIMIT
// placeholders, so the bound is validated here and interpolated only as a
// number — never raw request input.
const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 100;
const parseListLimit = (raw) => {
    if (raw === undefined)
        return DEFAULT_LIST_LIMIT;
    const value = Array.isArray(raw) ? NaN : Number(raw);
    if (!Number.isInteger(value) || value < 1)
        return null;
    return Math.min(value, MAX_LIST_LIMIT);
};
async function getVisibleTicket(req, id) {
    const ticket = await (0, db_1.queryOne)('SELECT id, ticket_number, user_id, status FROM support_tickets WHERE id = ?', [id]);
    if (!ticket)
        return null;
    if (!(await isAdmin(req)) && ticket.user_id !== req.user?.id)
        return null;
    return ticket;
}
// The cursor is an existing reply selector, never authority. Both anchor and
// page are constrained to the freshly authorized ticket; dates stay in SQL.
async function replyPage(ticketId, before) {
    const rows = await (0, db_1.query)(`SELECT r.id, r.body, r.created_at, r.sender_id, u.name AS sender_name, u.role AS sender_role
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
router.use(auth_1.authenticateToken);
router.get('/follow-up', async (req, res) => {
    if (!req.user)
        return res.status(401).json({ error: 'Unauthorized' });
    if (req.user.billingOnly || req.impersonation || req.headers['x-impersonation'] !== undefined)
        return res.status(403).json({ code: 'SUPPORT_FOLLOWUP_DIRECT_SESSION_REQUIRED' });
    if (req.body != null && (typeof req.body !== 'object' || Array.isArray(req.body) || Object.keys(req.body).length) || ['x-tenant-id', 'x-assignee-id', 'x-user-id'].some(k => req.headers[k] !== undefined))
        return res.status(400).json({ code: 'SUPPORT_FOLLOWUP_INPUT' });
    const result = await writes.followup(req.user, req.query);
    return res.status(result.status).json(result.body);
});
router.get('/assigned', async (req, res) => {
    if (!req.user)
        return res.status(401).json({ error: 'Unauthorized' });
    if (Object.keys(req.query).some(key => key !== 'after'))
        return res.status(400).json({ error: 'Unexpected assigned queue selector' });
    const result = await writes.assigned(req.user, req.query.after);
    return res.status(result.status).json(result.body);
});
router.get('/:id/assignment/candidates', async (req, res) => {
    if (!req.user)
        return res.status(401).json({ error: 'Unauthorized' });
    if (Object.keys(req.query).some(key => key !== 'after'))
        return res.status(400).json({ error: 'Unexpected recipient selector' });
    const result = await writes.assignmentCandidates(req.user, req.params.id, req.query.after);
    return res.status(result.status).json(result.body);
});
router.get('/:id/assignment', async (req, res) => {
    if (!req.user)
        return res.status(401).json({ error: 'Unauthorized' });
    if (Object.keys(req.query).length)
        return res.status(400).json({ error: 'Unexpected assignment selector' });
    const result = await writes.assignment(req.user, req.params.id);
    return res.status(result.status).json(result.body);
});
router.post('/:id/assignment', async (req, res) => {
    if (!req.user)
        return res.status(401).json({ error: 'Unauthorized' });
    if (Object.keys(req.query).length)
        return res.status(400).json({ error: 'Unexpected assignment selector' });
    const result = await writes.assign(req.user, req.params.id, req.headers['idempotency-key'], req.body);
    return res.status(result.status).json(result.body);
});
router.get('/:id/assignment/attempts/:requestId', async (req, res) => {
    if (!req.user)
        return res.status(401).json({ error: 'Unauthorized' });
    if (Object.keys(req.query).length)
        return res.status(400).json({ error: 'Unexpected assignment selector' });
    const result = await writes.reconcileAssignment(req.user, req.params.id, req.params.requestId);
    return res.status(result.status).json(result.body);
});
router.get('/:id/private-notes', async (req, res) => {
    if (!req.user)
        return res.status(401).json({ error: 'Unauthorized' });
    if (Object.keys(req.query).some(key => key !== 'before'))
        return res.status(400).json({ error: 'Unexpected private note selector' });
    const result = await writes.privateNotes(req.user, req.params.id, req.query.before);
    return res.status(result.status).json(result.body);
});
router.post('/:id/private-notes', async (req, res) => {
    if (!req.user)
        return res.status(401).json({ error: 'Unauthorized' });
    if (Object.keys(req.query).length)
        return res.status(400).json({ error: 'Unexpected private note selector' });
    const result = await writes.addPrivateNote(req.user, req.params.id, req.headers['idempotency-key'], req.body);
    return res.status(result.status).json(result.body);
});
router.get('/:id/private-notes/attempts/:requestId', async (req, res) => {
    if (!req.user)
        return res.status(401).json({ error: 'Unauthorized' });
    if (Object.keys(req.query).length)
        return res.status(400).json({ error: 'Unexpected private note selector' });
    const result = await writes.reconcilePrivateNote(req.user, req.params.id, req.params.requestId);
    return res.status(result.status).json(result.body);
});
router.post('/', async (req, res) => {
    if (!req.user)
        return res.status(401).json({ error: 'Unauthorized' });
    const result = await writes.create(req.user, req.headers['idempotency-key'], req.body);
    return res.status(result.status).json(result.body);
});
router.get('/attempts/:operation/:requestId', async (req, res) => {
    if (!req.user)
        return res.status(401).json({ error: 'Unauthorized' });
    if (Object.keys(req.query).length)
        return res.status(400).json({ error: 'Unexpected support attempt selector' });
    const result = await writes.reconcile(req.user, req.params.operation, req.params.requestId);
    return res.status(result.status).json(result.body);
});
router.get('/mine', async (req, res) => {
    try {
        const limit = parseListLimit(req.query.limit);
        if (limit === null) {
            return res.status(400).json({ error: 'limit must be a positive integer' });
        }
        const tickets = await (0, db_1.query)(`SELECT id, ticket_number, category, subject, status, priority, created_at, updated_at
       FROM support_tickets
       WHERE user_id = ?
       ORDER BY updated_at DESC
       LIMIT ${limit}`, [req.user?.id]);
        return res.json(tickets);
    }
    catch (error) {
        console.error('List own support tickets error:', error);
        return res.status(500).json({ error: 'Failed to load support tickets' });
    }
});
router.get('/', (0, admin_permissions_1.requireAdminPermission)('support.read'), async (req, res) => {
    try {
        const filters = [];
        const params = [];
        const status = typeof req.query.status === 'string' ? req.query.status : undefined;
        const category = typeof req.query.category === 'string' ? req.query.category : undefined;
        if (status && statuses.has(status)) {
            filters.push('t.status = ?');
            params.push(status);
        }
        if (category && categories.has(category)) {
            filters.push('t.category = ?');
            params.push(category);
        }
        const tickets = await (0, db_1.query)(`SELECT t.id, t.ticket_number, t.category, t.subject, t.status, t.priority,
              t.created_at, t.updated_at, u.name AS user_name, u.phone AS user_phone
       FROM support_tickets t
       INNER JOIN users u ON u.id = t.user_id
       ${filters.length ? `WHERE ${filters.join(' AND ')}` : ''}
       ORDER BY FIELD(t.priority, 'urgent', 'high', 'normal', 'low'), t.updated_at DESC
       LIMIT 250`, params);
        return res.json(tickets);
    }
    catch (error) {
        console.error('List support queue error:', error);
        return res.status(500).json({ error: 'Failed to load support queue' });
    }
});
router.get('/:id/replies', async (req, res) => {
    try {
        const visible = await getVisibleTicket(req, req.params.id);
        if (!visible)
            return res.status(404).json({ error: 'Support ticket not found' });
        const before = req.query.before;
        if (Object.keys(req.query).some(key => key !== 'before') || typeof before !== 'string' || !/^[a-zA-Z0-9-]{1,64}$/.test(before)) {
            return res.status(400).json({ error: 'Invalid reply cursor' });
        }
        const anchor = await (0, db_1.queryOne)('SELECT id FROM support_ticket_replies WHERE ticket_id = ? AND id = ? LIMIT 1', [visible.id, before]);
        if (!anchor)
            return res.status(400).json({ error: 'Invalid reply cursor' });
        return res.json(await replyPage(visible.id, before));
    }
    catch {
        return res.status(500).json({ error: 'Failed to load older support replies' });
    }
});
router.get('/:id/context', async (req, res) => {
    if (!req.user)
        return res.status(401).json({ error: 'Unauthorized' });
    if (Object.keys(req.query).length)
        return res.status(400).json({ error: 'Unexpected support context selector' });
    const result = await writes.context(req.user, req.params.id);
    return res.status(result.status).json(result.body);
});
router.get('/:id', async (req, res) => {
    try {
        const visible = await getVisibleTicket(req, req.params.id);
        if (!visible)
            return res.status(404).json({ error: 'Support ticket not found' });
        const admin = await isAdmin(req);
        const ticket = await (0, db_1.queryOne)(`SELECT t.id,t.ticket_number,t.user_id,t.category,t.subject,t.description,t.status,t.priority,
              t.created_at,t.updated_at,u.name AS user_name
       FROM support_tickets t
       INNER JOIN users u ON u.id = t.user_id
       WHERE t.id = ?${admin ? '' : ' AND t.user_id = ?'} LIMIT 1`, admin ? [visible.id] : [visible.id, req.user?.id]);
        if (!ticket)
            return res.status(404).json({ error: 'Support ticket not found' });
        const page = await replyPage(visible.id);
        return res.json({ ticket, ...page, has_more_replies: page.next_cursor !== null });
    }
    catch (error) {
        console.error('Get support ticket error:', error);
        return res.status(500).json({ error: 'Failed to load support ticket' });
    }
});
router.post('/:id/replies', async (req, res) => {
    if (!req.user)
        return res.status(401).json({ error: 'Unauthorized' });
    const result = await writes.reply(req.user, req.params.id, req.headers['idempotency-key'], req.body);
    return res.status(result.status).json(result.body);
});
router.patch('/:id/status', async (req, res) => {
    if (!req.user)
        return res.status(401).json({ error: 'Unauthorized' });
    const result = await writes.status(req.user, req.params.id, req.body);
    return res.status(result.status).json(result.body);
});
exports.default = router;
