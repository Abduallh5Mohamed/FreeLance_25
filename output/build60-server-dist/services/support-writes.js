"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.supportWriteId = supportWriteId;
exports.createSupportWriteService = createSupportWriteService;
const crypto_1 = require("crypto");
const suspension_predicate_1 = require("../security/suspension-predicate");
const support_lesson_context_1 = require("./support-lesson-context");
const support_private_notes_1 = require("./support-private-notes");
const support_assignment_1 = require("./support-assignment");
const support_followup_1 = require("./support-followup");
const categories = new Set(['technical', 'account', 'billing', 'content', 'exam', 'video', 'other']);
const statuses = new Set(['open', 'waiting_on_support', 'waiting_on_user', 'resolved', 'closed']);
const uuid = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
class Stop extends Error {
    constructor(result) {
        super('Support write refused');
        this.result = result;
    }
}
const stop = (status, error, code) => { throw new Stop({ status, body: { error, code } }); };
const text = (value) => typeof value === 'string' ? value.trim() : '';
const ticketFields = 'id,ticket_number,user_id,category,subject,description,status,priority,created_at,updated_at';
const ticketDto = (row) => ({ id: row.id, ticket_number: row.ticket_number, user_id: row.user_id, category: row.category, subject: row.subject,
    description: row.description, status: row.status, priority: row.priority, created_at: row.created_at, updated_at: row.updated_at });
const replyDto = (row) => ({ id: row.id, body: row.body, created_at: row.created_at, sender_id: row.sender_id, sender_name: row.sender_name, sender_role: row.sender_role });
// UUIDv8 namespace: stable per actor/operation/key. The random request key is
// not an authority token; every replay still proves live user/ticket access.
function supportWriteId(actorId, operation, requestId) {
    const bytes = (0, crypto_1.createHash)('sha256').update(JSON.stringify(['tabweb-support-v1', actorId, operation, requestId.toLowerCase()])).digest().subarray(0, 16);
    bytes[6] = (bytes[6] & 15) | 128;
    bytes[8] = (bytes[8] & 63) | 128;
    const hex = bytes.toString('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
function createSupportWriteService(deps) {
    const run = async (actor, work) => {
        let connection = null, open = false, committing = false, destroyed = false;
        const rollback = async () => { open = false; try {
            await connection.rollback();
        }
        catch {
            destroyed = true;
            throw Error('Support rollback failed');
        } };
        try {
            if (actor.identitySource === 'staff')
                stop(403, 'Support requires a user account', 'SUPPORT_IDENTITY_UNSUPPORTED');
            connection = await deps.getConnection();
            await connection.beginTransaction();
            open = true;
            const [tables] = await connection.execute(`SELECT TABLE_NAME AS table_name,ENGINE AS engine FROM information_schema.TABLES
        WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN ('users','support_tickets','support_ticket_replies','audit_events','admin_user_roles','admin_role_permissions') LIMIT 6`);
            const names = ['users', 'support_tickets', 'support_ticket_replies', 'audit_events'];
            if (![...names, 'admin_user_roles', 'admin_role_permissions'].every(name => tables.some(row => row.table_name === name && row.engine === 'InnoDB')))
                stop(503, 'Support storage unavailable', 'SUPPORT_WRITE_UNAVAILABLE');
            const [indexes] = await connection.execute(`SELECT TABLE_NAME AS table_name,COLUMN_NAME AS column_name,SEQ_IN_INDEX AS seq_in_index
        FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN ('users','support_tickets','support_ticket_replies','audit_events') AND INDEX_NAME='PRIMARY' LIMIT 8`);
            if (!names.every(name => { const rows = indexes.filter(row => row.table_name === name); return rows.length === 1 && rows[0].column_name === 'id' && Number(rows[0].seq_in_index) === 1; }))
                stop(503, 'Support storage unavailable', 'SUPPORT_WRITE_UNAVAILABLE');
            const [users] = await connection.execute(`SELECT id,is_active,token_version,${suspension_predicate_1.ACTIVE_SUSPENSION_PREDICATE_SQL} AS suspension_active FROM users WHERE id=? LIMIT 1 FOR UPDATE`, [actor.id]);
            const user = users[0];
            if (!user || Number(user.is_active) !== 1 || Number(user.suspension_active) !== 0 || Number(user.token_version ?? 0) !== Number(actor.tokenVersion ?? 0))
                stop(401, 'Session is no longer active', 'AUTH_REVOKED');
            const result = await work(connection, { ...actor, id: String(user.id) });
            if (result.write) {
                committing = true;
                await connection.commit();
                open = false;
            }
            else
                await rollback();
            return { status: result.status, body: result.body };
        }
        catch (error) {
            if (committing) {
                destroyed = true;
                return { status: 503, body: { error: 'Support save outcome uncertain; retry the same request', code: 'PERSISTENCE_UNCERTAIN' } };
            }
            if (connection && !open)
                destroyed = true;
            if (open) {
                try {
                    await rollback();
                }
                catch {
                    destroyed = true;
                }
            }
            if (error instanceof Stop)
                return error.result;
            if (error && typeof error === 'object' && 'code' in error && error.code === 'ER_DUP_ENTRY')
                return { status: 409, body: { error: 'Support request conflicts; retry the same request', code: 'SUPPORT_WRITE_CONFLICT' } };
            return { status: 503, body: { error: 'Support write unavailable; retry the same request', code: 'SUPPORT_WRITE_UNAVAILABLE' } };
        }
        finally {
            if (connection) {
                try {
                    if (destroyed)
                        connection.destroy();
                    else
                        connection.release();
                }
                catch { /* retain outcome */ }
            }
        }
    };
    const platformSupport = async (connection, actor) => {
        const [grants] = await connection.execute(`SELECT ur.user_id,rp.permission_key FROM admin_user_roles ur
      LEFT JOIN admin_role_permissions rp ON rp.role_code=ur.role_code AND rp.permission_key='support.read'
      WHERE ur.user_id=? AND (ur.role_code='super_admin' OR rp.permission_key='support.read') LIMIT 101 FOR UPDATE`, [actor.id]);
        if (grants.length > 100)
            stop(503, 'Support authorization unavailable', 'SUPPORT_WRITE_UNAVAILABLE');
        return grants.length > 0;
    };
    const authorizeTicket = async (connection, actor, ticketId) => {
        const [tickets] = await connection.execute(`SELECT ${ticketFields} FROM support_tickets WHERE id=? LIMIT 1 FOR UPDATE`, [ticketId]);
        const ticket = tickets[0];
        if (!ticket)
            stop(404, 'Support ticket not found', 'SUPPORT_TICKET_NOT_FOUND');
        const admin = await platformSupport(connection, actor);
        if (ticket.user_id !== actor.id && !admin)
            stop(404, 'Support ticket not found', 'SUPPORT_TICKET_NOT_FOUND');
        return { ticket, admin };
    };
    const audit = async (connection, actor, action, ticketId, oldStatus, newStatus, replyId, context, noteId) => {
        const [result] = await connection.execute(`INSERT INTO audit_events (id,actor_user_id,tenant_id,action,resource_type,resource_id,old_value,new_value)
      VALUES (?,?,NULL,?,'support_ticket',?,?,?)`, [(0, crypto_1.randomUUID)(), actor.id, action, ticketId, oldStatus === null ? null : JSON.stringify({ status: oldStatus }), JSON.stringify({ status: newStatus, ...(replyId ? { reply_id: replyId } : {}), ...(context ? { context: { kind: context.kind, course_id: context.course_id, lesson_id: context.lesson_id } } : {}), ...(noteId ? { note_id: noteId } : {}) })]);
        if (Number(result.affectedRows) !== 1)
            throw Error('Support audit not recorded');
    };
    const authorizeNotes = async (connection, actor, ticketId) => {
        const { ticket, admin } = await authorizeTicket(connection, actor, ticketId);
        if (!admin)
            stop(404, 'Private support notes not found', 'SUPPORT_NOTES_NOT_FOUND');
        if (!await (0, support_private_notes_1.verifyPrivateNotesSchema)(connection))
            stop(503, 'Private support notes unavailable', 'SUPPORT_NOTES_UNAVAILABLE');
        return ticket;
    };
    const authorizeAssignment = async (connection, actor, ticketId) => {
        const { ticket, admin } = await authorizeTicket(connection, actor, ticketId);
        if (!admin)
            stop(404, 'Support assignment not found', 'SUPPORT_ASSIGNMENT_NOT_FOUND');
        if (!await (0, support_assignment_1.supportAssignmentSchema)(connection))
            stop(503, 'Support assignment unavailable', 'SUPPORT_ASSIGNMENT_UNAVAILABLE');
        return ticket;
    };
    const proveAssignee = async (connection, id) => {
        const [users] = await connection.execute(`SELECT id,name,is_active,${suspension_predicate_1.ACTIVE_SUSPENSION_PREDICATE_SQL} AS suspension_active FROM users WHERE id=? LIMIT 1 FOR UPDATE`, [id]);
        const user = users[0];
        if (!user || Number(user.is_active) !== 1 || Number(user.suspension_active) !== 0)
            return null;
        const [grants] = await connection.execute(`SELECT ur.user_id,rp.permission_key FROM admin_user_roles ur
      LEFT JOIN admin_role_permissions rp ON rp.role_code=ur.role_code AND rp.permission_key='support.read'
      WHERE ur.user_id=? AND (ur.role_code='super_admin' OR rp.permission_key='support.read') LIMIT 101 FOR UPDATE`, [user.id]);
        if (grants.length > 100)
            stop(503, 'Support authorization unavailable', 'SUPPORT_WRITE_UNAVAILABLE');
        if (!grants.length)
            return null;
        if (typeof user.id !== 'string' || !user.id || user.id.length > 36 || typeof user.name !== 'string' || user.name.length > 255)
            throw Error('Invalid support assignee');
        return { id: user.id, name: user.name };
    };
    return {
        async followup(actor, raw) {
            const input = (0, support_followup_1.parseFollowupInput)(raw);
            if (!input)
                return { status: 400, body: { code: 'SUPPORT_FOLLOWUP_INPUT', error: 'Invalid follow-up filters or cursor' } };
            return run(actor, async (connection, verified) => {
                if (!await platformSupport(connection, verified))
                    stop(404, 'Follow-up queue not found', 'SUPPORT_FOLLOWUP_NOT_FOUND');
                if (!await (0, support_assignment_1.supportAssignmentSchema)(connection))
                    stop(503, 'Follow-up unavailable', 'SUPPORT_FOLLOWUP_UNAVAILABLE');
                const result = await (0, support_followup_1.readSupportFollowup)(connection, verified.id, input);
                return { ...result, write: false };
            });
        },
        async assigned(actor, after) {
            if (after !== undefined && (typeof after !== 'string' || !/^[a-zA-Z0-9-]{1,36}$/.test(after)))
                return { status: 400, body: { error: 'Invalid assigned queue cursor', code: 'SUPPORT_ASSIGNED_INPUT' } };
            return run(actor, async (connection, actor) => {
                if (!await platformSupport(connection, actor))
                    stop(404, 'Assigned support queue not found', 'SUPPORT_ASSIGNED_NOT_FOUND');
                if (!await (0, support_assignment_1.supportAssignmentSchema)(connection))
                    stop(503, 'Assigned support queue unavailable', 'SUPPORT_ASSIGNED_UNAVAILABLE');
                const [index] = await connection.execute(`SELECT COLUMN_NAME AS column_name,SEQ_IN_INDEX AS seq_in_index FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='support_tickets' AND INDEX_NAME='idx_support_assignee_id' ORDER BY SEQ_IN_INDEX LIMIT 3`);
                if (index.length !== 2 || !['assigned_to', 'id'].every((name, n) => index[n].column_name === name && Number(index[n].seq_in_index) === n + 1))
                    stop(503, 'Assigned support queue unavailable', 'SUPPORT_ASSIGNED_UNAVAILABLE');
                const [rows] = await connection.execute(`SELECT t.id,t.ticket_number,t.category,t.subject,t.status,t.priority,
          UNIX_TIMESTAMP(t.created_at) AS created_at_epoch,UNIX_TIMESTAMP(t.updated_at) AS updated_at_epoch
          FROM support_tickets t WHERE t.assigned_to=? ${after === undefined ? '' : 'AND t.id>?'} ORDER BY t.id ASC LIMIT 26`, after === undefined ? [actor.id] : [actor.id, after]);
                const instant = (value) => { if (!(typeof value === 'number' || typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value)) || !Number.isFinite(Number(value)) || Number(value) <= 0)
                    throw Error('Invalid assigned ticket instant'); return new Date(Number(value) * 1000).toISOString(); };
                const tickets = rows.slice(0, 25).map(row => {
                    if (typeof row.id !== 'string' || !/^[a-zA-Z0-9-]{1,36}$/.test(row.id) || typeof row.ticket_number !== 'string' || row.ticket_number.length > 32 || typeof row.subject !== 'string' || row.subject.length > 200 || !categories.has(row.category) || !statuses.has(row.status) || !['low', 'normal', 'high', 'urgent'].includes(row.priority))
                        throw Error('Invalid assigned ticket');
                    return { id: row.id, ticket_number: row.ticket_number, category: row.category, subject: row.subject, status: row.status, priority: row.priority, created_at: instant(row.created_at_epoch), updated_at: instant(row.updated_at_epoch) };
                });
                return { status: 200, body: { tickets, next_cursor: rows.length > 25 ? tickets[24].id : null }, write: false };
            });
        },
        async assignmentCandidates(actor, ticketId, after) {
            if (after !== undefined && (typeof after !== 'string' || !/^[a-zA-Z0-9-]{1,36}$/.test(after)))
                return { status: 400, body: { error: 'Invalid recipient cursor', code: 'SUPPORT_ASSIGNMENT_INPUT' } };
            return run(actor, async (connection, actor) => {
                await authorizeAssignment(connection, actor, ticketId);
                const [rows] = await connection.execute(`SELECT users.id,users.name FROM users
          WHERE users.is_active=1 AND NOT ${suspension_predicate_1.ACTIVE_SUSPENSION_PREDICATE_SQL.replace(/suspended_until/g, 'users.suspended_until')}
          ${after === undefined ? '' : 'AND users.id>?'}
          AND EXISTS (SELECT 1 FROM admin_user_roles ur WHERE ur.user_id=users.id AND (ur.role_code='super_admin'
            OR EXISTS (SELECT 1 FROM admin_role_permissions rp WHERE rp.role_code=ur.role_code AND rp.permission_key='support.read')))
          ORDER BY users.id ASC LIMIT 26`, after === undefined ? [] : [after]);
                const candidates = rows.slice(0, 25).map(row => {
                    if (typeof row.id !== 'string' || !/^[a-zA-Z0-9-]{1,36}$/.test(row.id) || typeof row.name !== 'string' || row.name.length > 255)
                        throw Error('Invalid recipient');
                    return { id: row.id, name: row.name };
                });
                return { status: 200, body: { candidates, next_cursor: rows.length > 25 ? candidates[24].id : null }, write: false };
            });
        },
        async assignment(actor, ticketId) {
            return run(actor, async (connection, actor) => {
                const ticket = await authorizeAssignment(connection, actor, ticketId), assignment = await (0, support_assignment_1.assignmentState)(connection, ticket.id);
                const person = assignment.assigned_to ? await proveAssignee(connection, assignment.assigned_to) : null;
                return { status: 200, body: { assignment, assignee: person }, write: false };
            });
        },
        async assign(actor, ticketId, requestId, input) {
            if (typeof requestId !== 'string' || !uuid.test(requestId))
                return { status: 400, body: { error: 'UUID Idempotency-Key required', code: 'SUPPORT_REQUEST_KEY' } };
            if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 2 || !Object.prototype.hasOwnProperty.call(input, 'assigned_to') || !Object.prototype.hasOwnProperty.call(input, 'expected_version')
                || !(input.assigned_to === null || typeof input.assigned_to === 'string' && /^[a-zA-Z0-9-]{1,36}$/.test(input.assigned_to))
                || !Number.isSafeInteger(input.expected_version) || input.expected_version < 0 || input.expected_version >= 2147483647)
                return { status: 400, body: { error: 'Invalid support assignment', code: 'SUPPORT_ASSIGNMENT_INPUT' } };
            return run(actor, async (connection, actor) => {
                const ticket = await authorizeAssignment(connection, actor, ticketId), id = supportWriteId(actor.id, 'assign', requestId);
                const prior = await (0, support_assignment_1.assignmentReceipt)(connection, id, ticket.id);
                if (prior) {
                    if (prior.actor_id !== actor.id || prior.expected_version !== input.expected_version || prior.assignment.assigned_to?.toLowerCase() !== input.assigned_to?.toLowerCase())
                        stop(409, 'Assignment key already used with different data', 'SUPPORT_WRITE_CONFLICT');
                    return { status: 200, body: { assignment: prior.assignment, changed: prior.changed, unchanged: true }, write: false };
                }
                const current = await (0, support_assignment_1.assignmentState)(connection, ticket.id);
                if (current.version !== input.expected_version)
                    stop(409, 'Assignment changed; refresh before a new decision', 'SUPPORT_ASSIGNMENT_STALE');
                if (ticket.status === 'closed')
                    stop(409, 'Closed ticket assignment cannot change', 'SUPPORT_TICKET_CLOSED');
                const person = input.assigned_to === null ? null : await proveAssignee(connection, input.assigned_to);
                if (input.assigned_to !== null && !person)
                    stop(409, 'Assignee is not currently eligible', 'SUPPORT_ASSIGNEE_UNAVAILABLE');
                const target = person?.id ?? null, changed = current.assigned_to !== target, version = current.version + (changed ? 1 : 0);
                if (changed) {
                    const [update] = await connection.execute('UPDATE support_tickets SET assigned_to=?,assignment_version=?,updated_at=updated_at WHERE id=? AND assignment_version=?', [target, version, ticket.id, current.version]);
                    if (Number(update.affectedRows) !== 1)
                        throw Error('Support assignment write failed');
                }
                const [receipt] = await connection.execute('INSERT INTO support_assignment_attempts (id,ticket_id,actor_user_id,assigned_to,expected_version,result_version,changed) VALUES (?,?,?,?,?,?,?)', [id, ticket.id, actor.id, target, current.version, version, changed ? 1 : 0]);
                if (Number(receipt.affectedRows) !== 1)
                    throw Error('Support assignment receipt failed');
                const [auditResult] = await connection.execute(`INSERT INTO audit_events (id,actor_user_id,tenant_id,action,resource_type,resource_id,old_value,new_value)
          VALUES (?,?,NULL,?,'support_ticket',?,?,?)`, [(0, crypto_1.randomUUID)(), actor.id, 'support_ticket.assign', ticket.id, JSON.stringify(current), JSON.stringify({ ticket_id: ticket.id, assigned_to: target, version, attempt_id: id })]);
                if (Number(auditResult.affectedRows) !== 1)
                    throw Error('Support assignment audit failed');
                return { status: 201, body: { assignment: { ticket_id: ticket.id, assigned_to: target, version }, changed, unchanged: false }, write: true };
            });
        },
        async reconcileAssignment(actor, ticketId, requestId) {
            if (typeof requestId !== 'string' || !uuid.test(requestId))
                return { status: 400, body: { error: 'Invalid assignment attempt', code: 'SUPPORT_REQUEST_KEY' } };
            return run(actor, async (connection, actor) => {
                const ticket = await authorizeAssignment(connection, actor, ticketId), receipt = await (0, support_assignment_1.assignmentReceipt)(connection, supportWriteId(actor.id, 'assign', requestId), ticket.id);
                if (!receipt || receipt.actor_id !== actor.id)
                    return stop(404, 'No confirmed assignment attempt found', 'SUPPORT_ATTEMPT_NOT_FOUND');
                return { status: 200, body: { assignment: receipt.assignment, changed: receipt.changed, unchanged: true }, write: false };
            });
        },
        async privateNotes(actor, ticketId, before) {
            if (before !== undefined && (typeof before !== 'string' || !uuid.test(before)))
                return { status: 400, body: { error: 'Invalid private note cursor', code: 'SUPPORT_NOTES_CURSOR' } };
            return run(actor, async (connection, actor) => {
                const ticket = await authorizeNotes(connection, actor, ticketId);
                if (before !== undefined) {
                    const anchor = await (0, support_private_notes_1.findPrivateNote)(connection, before, ticket.id);
                    if (!anchor || anchor.ticket_id !== ticket.id)
                        stop(400, 'Invalid private note cursor', 'SUPPORT_NOTES_CURSOR');
                }
                return { status: 200, body: await (0, support_private_notes_1.listPrivateNotes)(connection, ticket.id, before), write: false };
            });
        },
        async addPrivateNote(actor, ticketId, requestId, input) {
            if (typeof requestId !== 'string' || !uuid.test(requestId))
                return { status: 400, body: { error: 'UUID Idempotency-Key required', code: 'SUPPORT_REQUEST_KEY' } };
            const body = text(input?.body);
            if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 1 || !body || body.length > 10000)
                return { status: 400, body: { error: 'Invalid private note body', code: 'SUPPORT_INPUT' } };
            return run(actor, async (connection, actor) => {
                const ticket = await authorizeNotes(connection, actor, ticketId), id = supportWriteId(actor.id, 'note', requestId);
                const previous = await (0, support_private_notes_1.findPrivateNote)(connection, id, ticket.id, true);
                if (previous) {
                    if (previous.ticket_id !== ticket.id || previous.author_id !== actor.id || previous.body !== body)
                        stop(409, 'Request key already used with different private note', 'SUPPORT_WRITE_CONFLICT');
                    return { status: 200, body: { note: (0, support_private_notes_1.privateNoteDto)(previous), unchanged: true }, write: false };
                }
                const [insert] = await connection.execute('INSERT INTO support_ticket_private_notes (id,ticket_id,author_user_id,body) VALUES (?,?,?,?)', [id, ticket.id, actor.id, body]);
                if (Number(insert.affectedRows) !== 1)
                    throw Error('Private note insert failed');
                await audit(connection, actor, 'support_ticket.note', ticket.id, ticket.status, ticket.status, undefined, undefined, id);
                const row = await (0, support_private_notes_1.findPrivateNote)(connection, id, ticket.id);
                if (!row)
                    throw Error('Private note missing');
                return { status: 201, body: { note: (0, support_private_notes_1.privateNoteDto)(row), unchanged: false }, write: true };
            });
        },
        async reconcilePrivateNote(actor, ticketId, requestId) {
            if (typeof requestId !== 'string' || !uuid.test(requestId))
                return { status: 400, body: { error: 'Invalid private note request', code: 'SUPPORT_REQUEST_KEY' } };
            return run(actor, async (connection, actor) => {
                const ticket = await authorizeNotes(connection, actor, ticketId), row = await (0, support_private_notes_1.findPrivateNote)(connection, supportWriteId(actor.id, 'note', requestId), ticket.id);
                if (!row || row.ticket_id !== ticket.id || row.author_id !== actor.id)
                    stop(404, 'No confirmed private note attempt found', 'SUPPORT_ATTEMPT_NOT_FOUND');
                return { status: 200, body: { note: (0, support_private_notes_1.privateNoteDto)(row), unchanged: true }, write: false };
            });
        },
        async context(actor, ticketId) {
            return run(actor, async (connection, actor) => {
                const { ticket, admin } = await authorizeTicket(connection, actor, ticketId);
                if (!await (0, support_lesson_context_1.supportContextSchema)(connection))
                    return { status: 200, body: { state: 'unconfigured', context: null }, write: false };
                const stored = await (0, support_lesson_context_1.storedLessonContext)(connection, ticket.id);
                if (!stored)
                    return { status: 200, body: { state: 'none', context: null }, write: false };
                const unavailable = () => ({ status: 200, body: { state: 'unavailable', context: null }, write: false });
                if (!admin && (actor.role !== 'student' || actor.tenantId?.toLowerCase() !== stored.tenant_id.toLowerCase() || actor.studentEnrollmentId?.toLowerCase() !== stored.enrollment_id.toLowerCase()))
                    return unavailable();
                if (ticket.user_id !== actor.id) {
                    const [owners] = await connection.execute(`SELECT id,is_active,${suspension_predicate_1.ACTIVE_SUSPENSION_PREDICATE_SQL} AS suspension_active FROM users WHERE id=? LIMIT 1`, [ticket.user_id]);
                    const owner = owners[0];
                    if (!owner || Number(owner.is_active) !== 1 || Number(owner.suspension_active) !== 0)
                        return unavailable();
                }
                const proof = await (0, support_lesson_context_1.proveLessonSupportContext)(connection, { userId: ticket.user_id, tenantId: stored.tenant_id, enrollmentId: stored.enrollment_id }, stored);
                return proof.ok ? { status: 200, body: { state: 'available', context: proof.context }, write: false } : unavailable();
            });
        },
        async reconcile(actor, operation, requestId) {
            if (!['create', 'reply'].includes(operation) || typeof requestId !== 'string' || !uuid.test(requestId))
                return { status: 400, body: { error: 'Invalid support attempt', code: 'SUPPORT_REQUEST_KEY' } };
            return run(actor, async (connection, actor) => {
                const id = supportWriteId(actor.id, operation, requestId);
                if (operation === 'create') {
                    const [rows] = await connection.execute(`SELECT ${ticketFields} FROM support_tickets WHERE id=? LIMIT 1`, [id]);
                    const ticket = rows[0];
                    if (!ticket || ticket.user_id !== actor.id)
                        stop(404, 'No confirmed support attempt found; retry with the same key', 'SUPPORT_ATTEMPT_NOT_FOUND');
                    return { status: 200, body: { ticket: ticketDto(ticket), unchanged: true }, write: false };
                }
                const [rows] = await connection.execute('SELECT id,ticket_id,sender_id,body FROM support_ticket_replies WHERE id=? LIMIT 1', [id]);
                const row = rows[0];
                if (!row || row.sender_id !== actor.id)
                    stop(404, 'No confirmed support attempt found; retry with the same key', 'SUPPORT_ATTEMPT_NOT_FOUND');
                const { ticket } = await authorizeTicket(connection, actor, row.ticket_id);
                const [replies] = await connection.execute(`SELECT r.id,r.body,r.created_at,r.sender_id,u.name AS sender_name,u.role AS sender_role
          FROM support_ticket_replies r INNER JOIN users u ON u.id=r.sender_id WHERE r.id=? AND r.ticket_id=? LIMIT 1`, [id, row.ticket_id]);
                if (!replies[0])
                    throw Error('Reply missing');
                return { status: 200, body: { reply: replyDto(replies[0]), ticket_id: ticket.id, ticket_status: ticket.status, unchanged: true }, write: false };
            });
        },
        async create(actor, requestId, input) {
            if (typeof requestId !== 'string' || !uuid.test(requestId))
                return { status: 400, body: { error: 'UUID Idempotency-Key required', code: 'SUPPORT_REQUEST_KEY' } };
            const category = text(input?.category), subject = text(input?.subject), description = text(input?.description);
            if (!categories.has(category) || subject.length < 3 || subject.length > 200 || description.length < 10 || description.length > 10000)
                return { status: 400, body: { error: 'Invalid support ticket fields', code: 'SUPPORT_INPUT' } };
            let requested;
            try {
                requested = (0, support_lesson_context_1.parseLessonContextInput)(input?.context);
            }
            catch {
                return { status: 400, body: { error: 'Invalid lesson context selectors', code: 'SUPPORT_CONTEXT_INPUT' } };
            }
            if (requested && (actor.role !== 'student' || !actor.tenantId || !actor.studentEnrollmentId))
                return { status: 403, body: { error: 'A selected student workspace is required', code: 'SUPPORT_CONTEXT_FORBIDDEN' } };
            return run(actor, async (connection, actor) => {
                const contextReady = await (0, support_lesson_context_1.supportContextSchema)(connection);
                if (requested && !contextReady)
                    stop(503, 'Lesson support context unavailable', 'SUPPORT_CONTEXT_UNAVAILABLE');
                const id = supportWriteId(actor.id, 'create', requestId);
                const [existing] = await connection.execute(`SELECT ${ticketFields} FROM support_tickets WHERE id=? LIMIT 1 FOR UPDATE`, [id]);
                const previous = existing[0];
                if (previous) {
                    if (previous.user_id !== actor.id || previous.category !== category || previous.subject !== subject || previous.description !== description)
                        stop(409, 'Request key already used with different data', 'SUPPORT_WRITE_CONFLICT');
                    const stored = contextReady ? await (0, support_lesson_context_1.storedLessonContext)(connection, previous.id) : null;
                    const same = (a, b) => a.toLowerCase() === b.toLowerCase();
                    if (!!stored !== !!requested || stored && requested && (!same(stored.course_id, requested.course_id) || !same(stored.lesson_id, requested.lesson_id) || !same(stored.tenant_id, actor.tenantId) || !same(stored.enrollment_id, actor.studentEnrollmentId)))
                        stop(409, 'Request key already used with different lesson context', 'SUPPORT_WRITE_CONFLICT');
                    return { status: 200, body: { ticket: ticketDto(previous), unchanged: true }, write: false };
                }
                let context;
                if (requested) {
                    const proof = await (0, support_lesson_context_1.proveLessonSupportContext)(connection, { userId: actor.id, tenantId: actor.tenantId, enrollmentId: actor.studentEnrollmentId }, requested, true);
                    if (!proof.ok)
                        throw new Stop({ status: proof.status, body: proof.body });
                    context = { kind: 'catalog_lesson', tenant_id: proof.scope.tenantId, enrollment_id: proof.scope.enrollmentId, course_id: proof.context.course_id, lesson_id: proof.context.lesson_id };
                }
                const number = `SUP-${new Date().toISOString().slice(0, 7).replace('-', '')}-${(0, crypto_1.randomBytes)(3).toString('hex').toUpperCase()}`;
                const [insert] = await connection.execute(`INSERT INTO support_tickets (id,ticket_number,user_id,category,subject,description,status,priority)
          VALUES (?,?,?,?,?,?,'open','normal')`, [id, number, actor.id, category, subject, description]);
                if (Number(insert.affectedRows) !== 1)
                    throw Error('Support insert failed');
                if (context) {
                    const [bound] = await connection.execute(`UPDATE support_tickets SET context_kind='catalog_lesson',context_tenant_id=?,context_enrollment_id=?,context_course_id=?,context_lesson_id=? WHERE id=? AND user_id=?`, [context.tenant_id, context.enrollment_id, context.course_id, context.lesson_id, id, actor.id]);
                    if (Number(bound.affectedRows) !== 1)
                        throw Error('Support context binding failed');
                }
                await audit(connection, actor, 'support_ticket.create', id, null, 'open', undefined, context);
                const [rows] = await connection.execute(`SELECT ${ticketFields} FROM support_tickets WHERE id=? LIMIT 1`, [id]);
                if (!rows[0])
                    throw Error('Created ticket missing');
                return { status: 201, body: { ticket: ticketDto(rows[0]), unchanged: false }, write: true };
            });
        },
        async reply(actor, ticketId, requestId, input) {
            if (typeof requestId !== 'string' || !uuid.test(requestId))
                return { status: 400, body: { error: 'UUID Idempotency-Key required', code: 'SUPPORT_REQUEST_KEY' } };
            const body = text(input?.body);
            if (!body.length || body.length > 10000)
                return { status: 400, body: { error: 'Invalid reply body', code: 'SUPPORT_INPUT' } };
            return run(actor, async (connection, actor) => {
                const id = supportWriteId(actor.id, 'reply', requestId);
                const { ticket, admin } = await authorizeTicket(connection, actor, ticketId);
                const [prior] = await connection.execute('SELECT id,ticket_id,sender_id,body FROM support_ticket_replies WHERE id=? LIMIT 1 FOR UPDATE', [id]);
                const previous = prior[0];
                if (previous && (previous.ticket_id !== ticketId || previous.sender_id !== actor.id || previous.body !== body))
                    stop(409, 'Request key already used with different data', 'SUPPORT_WRITE_CONFLICT');
                if (!previous) {
                    if (ticket.status === 'closed')
                        stop(409, 'Closed tickets cannot receive replies', 'SUPPORT_TICKET_CLOSED');
                    const [insert] = await connection.execute('INSERT INTO support_ticket_replies (id,ticket_id,sender_id,body) VALUES (?,?,?,?)', [id, ticketId, actor.id, body]);
                    if (Number(insert.affectedRows) !== 1)
                        throw Error('Reply insert failed');
                    const status = admin ? 'waiting_on_user' : 'waiting_on_support';
                    const [update] = await connection.execute('UPDATE support_tickets SET status=?,updated_at=CURRENT_TIMESTAMP WHERE id=?', [status, ticketId]);
                    if (Number(update.affectedRows) !== 1 && !(Number(update.affectedRows) === 0 && ticket.status === status))
                        throw Error('Reply status failed');
                    await audit(connection, actor, 'support_ticket.reply', ticketId, ticket.status, status, id);
                    ticket.status = status;
                }
                const [rows] = await connection.execute(`SELECT r.id,r.body,r.created_at,r.sender_id,u.name AS sender_name,u.role AS sender_role
          FROM support_ticket_replies r INNER JOIN users u ON u.id=r.sender_id WHERE r.id=? AND r.ticket_id=? LIMIT 1`, [id, ticketId]);
                if (!rows[0])
                    throw Error('Reply missing');
                return { status: previous ? 200 : 201, body: { reply: replyDto(rows[0]), ticket_id: ticketId, ticket_status: ticket.status, unchanged: !!previous }, write: !previous };
            });
        },
        async status(actor, ticketId, input) {
            const next = text(input?.status);
            if (!statuses.has(next))
                return { status: 400, body: { error: 'Invalid support status', code: 'SUPPORT_INPUT' } };
            return run(actor, async (connection, actor) => {
                const { ticket, admin } = await authorizeTicket(connection, actor, ticketId);
                if (!admin && !['resolved', 'closed'].includes(next))
                    stop(403, 'Users can only resolve or close their own tickets', 'SUPPORT_STATUS_FORBIDDEN');
                if (ticket.status === next)
                    return { status: 200, body: { success: true, status: next, unchanged: true }, write: false };
                const [update] = await connection.execute(`UPDATE support_tickets SET status = ?,
          resolved_at = CASE WHEN ? = 'resolved' THEN CURRENT_TIMESTAMP ELSE resolved_at END,
          closed_at = CASE WHEN ? = 'closed' THEN CURRENT_TIMESTAMP ELSE closed_at END WHERE id = ?`, [next, next, next, ticketId]);
                if (Number(update.affectedRows) !== 1)
                    throw Error('Status update failed');
                await audit(connection, actor, 'support_ticket.status', ticketId, ticket.status, next);
                return { status: 200, body: { success: true, status: next, unchanged: false }, write: true };
            });
        },
    };
}
