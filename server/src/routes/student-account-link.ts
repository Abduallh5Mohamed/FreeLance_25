import { Router, type RequestHandler } from 'express';
import { createHash } from 'crypto';
import type { AuthRequest } from '../middleware/auth';
import type { TenantSelfConnection } from './tenant-self';
import { ACTIVE_SUSPENSION_PREDICATE_SQL } from '../security/suspension-predicate';
import { normalizeEgyptianPhone } from '../security/phone';
import { IdentityOtpService, type OtpChallengeRow } from '../security/identity-otp';
import { recordSealedAuditEvent } from '../services/audit-log';
import { rateLimit } from '../middleware/rate-limit';
const id = (x: unknown): x is string => typeof x === 'string' && /^[a-f\d]{8}(-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(x);
const exact = (x: unknown, keys: string[]): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x) && Object.keys(x).sort().join(',') === keys.slice().sort().join(',');
const hash = (x: unknown) => createHash('sha256').update(JSON.stringify(x)).digest('hex');
const hex = (x: unknown): x is string => typeof x === 'string' && /^[a-f\d]{64}$/.test(x);
const token = (x: unknown): x is string => typeof x === 'string' && /^[a-f\d]{64}$/i.test(x);
const liveUser = `is_active=1 AND NOT ${ACTIVE_SUSPENSION_PREDICATE_SQL}`;
const ELIGIBLE = "s.user_id IS NULL AND s.group_id IS NULL AND s.branch_id IS NULL AND s.is_active=1 AND s.is_offline IN (0,1) AND (s.approval_status IS NULL OR s.approval_status='approved') AND (s.enrollment_status IS NULL OR s.enrollment_status='active') AND (s.enrollment_start_date IS NULL OR s.enrollment_start_date<=UTC_TIMESTAMP()) AND (s.enrollment_end_date IS NULL OR s.enrollment_end_date>UTC_TIMESTAMP())";
class Denied extends Error {
    constructor(readonly status: number, readonly code: string) { super(code); }
}
function deny(status: number, code: string): never { throw new Denied(status, code); }
type Rows = <T = any>(sql: string, p?: unknown[]) => Promise<T[]>;
interface Deps {
    getConnection(): Promise<TenantSelfConnection>;
    otpKey(): string | undefined;
    enabled?(): boolean;
}
export const isStudentAccountLinkEnabled = (value = process.env.STUDENT_ACCOUNT_LINK_ENABLED) => value === 'true';
const linkingEnabled = (deps: Deps) => deps.enabled ? deps.enabled() === true : isStudentAccountLinkEnabled();
interface Context {
    c: TenantSelfConnection;
    rows: Rows;
    principal: NonNullable<AuthRequest['user']>;
}
/** All authorization, proof consumption, domain writes and seals use one connection. */
function route(deps: Deps, work: (req: AuthRequest, ctx: Context) => Promise<{
    body: unknown;
    status?: number;
    write?: boolean;
}>, schemaRequired = true): RequestHandler {
    return async (req: AuthRequest, res) => {
        res.set('Cache-Control', 'no-store');
        if (!req.user)
            return void res.status(401).json({ code: 'SESSION_REQUIRED' });
        if (req.user.identitySource === 'staff' || req.user.billingOnly || req.impersonation || req.headers['x-impersonation'] !== undefined)
            return void res.status(403).json({ code: 'LINK_IDENTITY_DENIED' });
        if (['x-tenant-id', 'x-student-id', 'x-enrollment-id', 'x-instructor-id'].some(k => req.headers[k] !== undefined))
            return void res.status(400).json({ code: 'LINK_INPUT' });
        const path = req.url.split('?')[0];
        if (!linkingEnabled(deps) && ((req.method === 'POST' && !path.endsWith('/withdraw')) || path === '/account-link/requests' || path === '/account-link/students'))
            return void res.status(409).json({ code: 'ACCOUNT_LINK_DEFERRED' });
        let c: TenantSelfConnection | null = null, begun = false, committing = false, discard = false;
        try {
            c = await deps.getConnection();
            await c.beginTransaction();
            begun = true;
            const connection = c;
            const rows: Rows = async (sql, p = []) => {
                const [r] = await connection.execute(sql, p);
                if (!Array.isArray(r))
                    throw Error('Invalid rowset');
                return r;
            };
            if (schemaRequired)
                await checkSchema(rows);
            const result = await work(req, { c, rows, principal: req.user });
            if (result.write) {
                committing = true;
                await c.commit();
            }
            res.status(result.status ?? 200).json(result.body);
        }
        catch (e) {
            if (committing) {
                discard = true;
                res.status(500).json({ code: 'PERSISTENCE_UNCERTAIN' });
            }
            else if (e instanceof Denied)
                res.status(e.status).json({ code: e.code });
            else {
                discard = true;
                res.status(503).json({ code: 'ACCOUNT_LINK_UNAVAILABLE' });
            }
        }
        finally {
            if (c) {
                if (begun && !committing)
                    try {
                        await c.rollback();
                    }
                    catch {
                        discard = true;
                    }
                try {
                    if (discard)
                        c.destroy();
                    else
                        c.release();
                }
                catch { }
            }
        }
    };
}
async function checkSchema(rows: Rows) {
    const tables = ['student_account_link_requests', 'student_account_link_operations', 'identity_otp_challenges', 'student_enrollment_invites', 'students', 'users', 'tenants', 'student_courses', 'audit_events', 'audit_chain_head'];
    const engines = await rows("SELECT TABLE_NAME AS name,ENGINE AS engine FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN ('student_account_link_requests','student_account_link_operations','identity_otp_challenges','student_enrollment_invites','students','users','tenants','student_courses','audit_events','audit_chain_head') LIMIT 10");
    if (!tables.every(name => engines.some(r => r.name === name && r.engine === 'InnoDB')))
        deny(503, 'ACCOUNT_LINK_UNAVAILABLE');
    const fields = await rows("SELECT TABLE_NAME AS tbl,COLUMN_NAME AS name,DATA_TYPE AS type,CHARACTER_MAXIMUM_LENGTH AS len,IS_NULLABLE AS nullable,COLLATION_NAME AS collation FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN ('student_account_link_requests','student_account_link_operations') LIMIT 21");
    const expected = { student_account_link_requests: { id: ['char', 36], tenant_id: ['varchar', 64], user_id: ['varchar', 64], invite_id: ['char', 36], challenge_id: ['varchar', 64], contact_hash: ['char', 64], request_hash: ['char', 64], status: ['enum', null], expires_at: ['datetime', null], created_at: ['timestamp', null] }, student_account_link_operations: { tenant_id: ['varchar', 64], operation_id: ['char', 36], actor_user_id: ['varchar', 64], request_id: ['char', 36], student_id: ['char', 36], user_id: ['varchar', 64], request_hash: ['char', 64], created_at: ['timestamp', null] } };
    for (const [tbl, columns] of Object.entries(expected))
        for (const [name, [type, len]] of Object.entries(columns))
            if (!fields.some(r => r.tbl === tbl && r.name === name && r.type === type && r.nullable === 'NO' && (len === null || Number(r.len) === len && r.collation === 'utf8mb4_bin')))
                deny(503, 'ACCOUNT_LINK_UNAVAILABLE');
    const keys = await rows("SELECT TABLE_NAME AS tbl,INDEX_NAME AS name,COLUMN_NAME AS col,SEQ_IN_INDEX AS seq FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN ('student_account_link_requests','student_account_link_operations','students') AND NON_UNIQUE=0 ORDER BY TABLE_NAME,INDEX_NAME,SEQ_IN_INDEX LIMIT 32");
    for (const [tbl, name, cols] of [
        ['student_account_link_requests', 'PRIMARY', ['id']], ['student_account_link_requests', 'uq_account_link_challenge', ['challenge_id']],
        ['student_account_link_operations', 'PRIMARY', ['tenant_id', 'operation_id']], ['student_account_link_operations', 'uq_account_link_request', ['tenant_id', 'request_id']], ['student_account_link_operations', 'uq_account_link_student', ['tenant_id', 'student_id']],
        ['students', 'uq_students_tenant_user', ['tenant_id', 'user_id']],
    ] as const) {
        const found = keys.filter(r => r.tbl === tbl && r.name === name);
        if (found.length !== cols.length || cols.some((col, i) => found[i].col !== col || Number(found[i].seq) !== i + 1))
            deny(503, 'ACCOUNT_LINK_UNAVAILABLE');
    }
}
async function seal(ctx: Context, tenant: string, action: string, resourceId: string, value: Record<string, unknown>) {
    await recordSealedAuditEvent({ query: ctx.rows, queryOne: async <T>(sql: string, p?: unknown[]): Promise<T | null> => (await ctx.rows<T>(sql, p))[0] ?? null, execute: async (sql, p) => { const [r] = await ctx.c.execute(sql, p); return { affectedRows: Number(r.affectedRows) }; } }, { actorUserId: ctx.principal.id, tenantId: tenant, action, resourceType: 'student_account_link', resourceId, newValue: value });
}
async function owner(ctx: Context) {
    const p = ctx.principal;
    if (p.role === 'student' || !p.tenantId)
        deny(403, 'LINK_OWNER_REQUIRED');
    const owners = await ctx.rows(`SELECT t.owner_user_id FROM tenants t JOIN users u ON u.id=t.owner_user_id WHERE t.id=? AND t.owner_user_id=? AND t.status='active' AND u.token_version=? AND u.is_active=1 AND NOT ${ACTIVE_SUSPENSION_PREDICATE_SQL.replace(/suspended_until/g, 'u.suspended_until')} LIMIT 1 FOR UPDATE`, [p.tenantId, p.id, p.tokenVersion ?? 0]);
    if (owners.length !== 1 || owners[0].owner_user_id !== p.id)
        deny(403, 'LINK_OWNER_REQUIRED');
    return p.tenantId;
}
function otpFor(ctx: Context, key: string) {
    return new IdentityOtpService({
        findChallengeById: async (challengeId) => (await ctx.rows<OtpChallengeRow>('SELECT id,contact_hash,purpose,tenant_id,identity_id,code_hash,attempts,max_attempts,resend_available_at,expires_at,consumed_at,submitted_at FROM identity_otp_challenges WHERE id=? FOR UPDATE', [challengeId]))[0] ?? null,
        consumeSubmission: async (challengeId, now) => { const [r] = await ctx.c.execute('UPDATE identity_otp_challenges SET submitted_at=? WHERE id=? AND consumed_at IS NOT NULL AND submitted_at IS NULL', [now, challengeId]); return Number(r.affectedRows); },
        // This adapter can only validate an already consumed challenge, never issue one.
        insertChallenge: async () => { throw Error('Issuance forbidden'); }, consumeChallenge: async () => { throw Error('Verification forbidden'); }, findLatestActiveChallenge: async () => null, incrementAttempts: async () => { throw Error('Verification forbidden'); }, countRecentChallenges: async () => 0,
    }, key, null);
}
export function createStudentAccountLinkRequestRouter(deps: Deps & {
    authenticate: RequestHandler;
}) {
    const router = Router();
    router.get('/account-link-capabilities', (req, res) => {
        res.set('Cache-Control', 'no-store');
        if (Object.keys(req.query).length || req.body != null && !exact(req.body, []))
            return void res.status(400).json({ code: 'LINK_INPUT' });
        res.json({ state: linkingEnabled(deps) ? 'verification_required' : 'deferred' });
    });
    const work = async (req: AuthRequest, ctx: Context) => {
        if (ctx.principal.role !== 'student')
            deny(403, 'LINK_STUDENT_REQUIRED');
        const invitation = req.params.token;
        if (!token(invitation))
            deny(404, 'LINK_INVITE_NOT_FOUND');
        const current = req.method === 'GET' && !req.params.operationId, withdrawing = req.method === 'POST' && !!req.params.operationId, writing = req.method === 'POST' && !withdrawing;
        if (!writing && !withdrawing && req.body != null && !exact(req.body, []))
            deny(400, 'LINK_INPUT');
        if (Object.keys(req.query).length || withdrawing && (!exact(req.body, ['confirmed']) || req.body.confirmed !== true) || writing && (!exact(req.body, ['operation_id', 'otp_challenge_id', 'confirmed']) || !id(req.body.operation_id) || typeof req.body.otp_challenge_id !== 'string' || !/^[a-f\d]{32}$/i.test(req.body.otp_challenge_id) || req.body.confirmed !== true) || !writing && !current && !id(req.params.operationId))
            deny(400, 'LINK_INPUT');
        const [invite] = await ctx.rows('SELECT i.id,i.tenant_id,t.owner_user_id,(i.expires_at>UTC_TIMESTAMP()) AS expires_live,i.revoked_at FROM student_enrollment_invites i JOIN tenants t ON t.id=i.tenant_id WHERE i.token_hash=? AND t.status=\'active\' AND t.owner_user_id=i.instructor_id LIMIT 1 FOR UPDATE', [createHash('sha256').update(invitation).digest('hex')]);
        if (!invite)
            deny(404, 'LINK_INVITE_NOT_FOUND');
        const [user] = await ctx.rows(`SELECT id,phone,role,name FROM users WHERE id=? AND token_version=? AND ${liveUser} LIMIT 1 FOR UPDATE`, [ctx.principal.id, ctx.principal.tokenVersion ?? 0]);
        if (!user || user.role !== 'student')
            deny(403, 'LINK_STUDENT_REQUIRED');
        const requestState = (request: any) => request.status === 'pending' && (invite.revoked_at || Number(invite.expires_live) !== 1 || Number(request.expires_live) !== 1) ? 'expired' : request.status;
        if (current) {
            const [request] = await ctx.rows('SELECT id,status,(expires_at>UTC_TIMESTAMP()) AS expires_live FROM student_account_link_requests WHERE tenant_id=? AND user_id=? AND invite_id=? ORDER BY created_at DESC,id DESC LIMIT 1', [invite.tenant_id, user.id, invite.id]);
            return { body: { request: request ? { id: request.id, state: requestState(request) } : null } };
        }
        const operationId = writing ? String(req.body.operation_id).toLowerCase() : req.params.operationId.toLowerCase();
        const [existing] = await ctx.rows('SELECT id,user_id,invite_id,request_hash,status,(expires_at>UTC_TIMESTAMP()) AS expires_live FROM student_account_link_requests WHERE id=? AND tenant_id=? LIMIT 1 FOR UPDATE', [operationId, invite.tenant_id]);
        const fingerprint = writing ? hash({ operation_id: operationId, otp_challenge_id: req.body.otp_challenge_id, confirmed: true }) : null;
        if (existing) {
            if (existing.user_id !== user.id || existing.invite_id !== invite.id || writing && existing.request_hash !== fingerprint)
                deny(409, 'LINK_REQUEST_CONFLICT');
            if (withdrawing) {
                if (existing.status === 'linked')
                    deny(409, 'LINK_ALREADY_COMPLETED');
                if (existing.status === 'pending') {
                    const [changed] = await ctx.c.execute("UPDATE student_account_link_requests SET status='withdrawn' WHERE id=? AND user_id=? AND status='pending'", [operationId, user.id]);
                    if (Number(changed.affectedRows) !== 1)
                        throw Error('Withdrawal not confirmed');
                    await seal(ctx, invite.tenant_id, 'student.account_link.withdrawn', operationId, {});
                    return { write: true, body: { request: { id: operationId, state: 'withdrawn' } } };
                }
            }
            return { body: { request: { id: existing.id, state: requestState(existing) } } };
        }
        if (withdrawing)
            deny(404, 'LINK_REQUEST_NOT_FOUND');
        if (!writing)
            return { body: { request: null } };
        if (invite.revoked_at || Number(invite.expires_live) !== 1)
            deny(404, 'LINK_INVITE_NOT_FOUND');
        const key = deps.otpKey();
        if (!key || Buffer.byteLength(key, 'utf8') < 32)
            deny(503, 'CONTACT_VERIFICATION_UNAVAILABLE');
        const phone = normalizeEgyptianPhone(user.phone);
        if (!phone)
            deny(403, 'CONTACT_VERIFICATION_REQUIRED');
        const [enrollment] = await ctx.rows('SELECT id FROM students WHERE tenant_id=? AND user_id=? LIMIT 1 FOR UPDATE', [invite.tenant_id, user.id]);
        if (enrollment)
            deny(409, 'LINK_EXISTING_ENROLLMENT');
        const pending = await ctx.rows("SELECT r.id FROM student_account_link_requests r JOIN student_enrollment_invites i ON i.id=r.invite_id AND i.revoked_at IS NULL AND i.expires_at>UTC_TIMESTAMP() WHERE r.tenant_id=? AND r.user_id=? AND r.status='pending' AND r.expires_at>UTC_TIMESTAMP() LIMIT 2 FOR UPDATE", [invite.tenant_id, user.id]);
        if (pending.length)
            deny(409, 'LINK_PENDING_REQUEST');
        const otp = otpFor(ctx, key);
        if (!await otp.assertConsumed({ challengeId: req.body.otp_challenge_id, contact: phone, purpose: 'enrollment_join', tenantId: invite.tenant_id }))
            deny(403, 'CONTACT_VERIFICATION_REQUIRED');
        const [written] = await ctx.c.execute("INSERT INTO student_account_link_requests (id,tenant_id,user_id,invite_id,challenge_id,contact_hash,request_hash,status,expires_at) SELECT ?,?,?,?,?,?,?,'pending',LEAST(i.expires_at,DATE_ADD(UTC_TIMESTAMP(),INTERVAL 1 DAY)) FROM student_enrollment_invites i WHERE i.id=? AND i.tenant_id=? AND i.revoked_at IS NULL AND i.expires_at>UTC_TIMESTAMP()", [operationId, invite.tenant_id, user.id, invite.id, req.body.otp_challenge_id, otp.contactHash(phone), fingerprint, invite.id, invite.tenant_id]);
        if (Number(written.affectedRows) !== 1)
            throw Error('Request not confirmed');
        await seal(ctx, invite.tenant_id, 'student.account_link.requested', operationId, { user_id: user.id });
        return { status: 201, write: true, body: { request: { id: operationId, state: 'pending' } } };
    };
    const handler = route(deps, work);
    router.post('/join/:token/account-link', deps.authenticate, rateLimit('student-account-link', 8, 3600000), handler);
    router.post('/join/:token/account-link/:operationId/withdraw', deps.authenticate, handler);
    router.get('/join/:token/account-link', deps.authenticate, handler);
    router.get('/join/:token/account-link/:operationId', deps.authenticate, handler);
    return router;
}
export function createStudentAccountLinkOwnerRouter(deps: Deps) {
    const router = Router();
    router.get('/account-link/capabilities', route(deps, async (req, ctx) => {
        if (Object.keys(req.query).length || req.body != null && !exact(req.body, []))
            deny(400, 'LINK_INPUT');
        await owner(ctx);
        return { body: { state: linkingEnabled(deps) ? 'verification_required' : 'deferred' } };
    }, false));
    const handler = route(deps, async (req, ctx) => {
        const tenant = await owner(ctx), path = req.url.split('?')[0], writing = path === '/account-link/apply', reviewing = path === '/account-link/review', readingReceipt = !!req.params.operationId;
        if (writing || reviewing) {
            if (Object.keys(req.query).length || !exact(req.body, ['student_id', 'request_id', ...(writing ? ['operation_id', 'review_token', 'confirmed'] : [])]) || ![req.body.student_id, req.body.request_id].every(id) || writing && (!id(req.body.operation_id) || !hex(req.body.review_token) || req.body.confirmed !== true))
                deny(400, 'LINK_INPUT');
        }
        else if (req.body != null && !exact(req.body, []) || Object.keys(req.query).some(k => k !== 'cursor') || req.query.cursor !== undefined && !id(req.query.cursor) || readingReceipt && (!id(req.params.operationId) || Object.keys(req.query).length))
            deny(400, 'LINK_INPUT');
        const operationId = readingReceipt ? req.params.operationId : writing ? req.body.operation_id : null;
        const requestHash = writing ? hash({ student_id: req.body.student_id, request_id: req.body.request_id, operation_id: req.body.operation_id, review_token: req.body.review_token, confirmed: true }) : null;
        if (operationId) {
            const [op] = await ctx.rows('SELECT operation_id,actor_user_id,request_id,student_id,user_id,request_hash FROM student_account_link_operations WHERE tenant_id=? AND operation_id=? LIMIT 1', [tenant, operationId]);
            if (op) {
                if (op.actor_user_id !== ctx.principal.id || writing && op.request_hash !== requestHash)
                    deny(409, 'LINK_OPERATION_CONFLICT');
                return { body: { operation: { operation_id: op.operation_id, request_id: op.request_id, student_id: op.student_id, state: 'account_linked' } } };
            }
            if (readingReceipt)
                return { body: { operation: null } };
        }
        const key = deps.otpKey();
        if (!key || Buffer.byteLength(key, 'utf8') < 32)
            deny(503, 'CONTACT_VERIFICATION_UNAVAILABLE');
        if (!writing && !reviewing) {
            const cursor = req.query.cursor ?? '';
            const items = path === '/account-link/requests' ? await ctx.rows("SELECT r.id,u.name FROM student_account_link_requests r JOIN users u ON u.id=r.user_id JOIN student_enrollment_invites i ON i.id=r.invite_id AND i.tenant_id=r.tenant_id AND i.revoked_at IS NULL AND i.expires_at>UTC_TIMESTAMP() WHERE r.tenant_id=? AND r.status='pending' AND r.expires_at>UTC_TIMESTAMP() AND r.id>? ORDER BY r.id LIMIT 26", [tenant, cursor]) : await ctx.rows(`SELECT s.id,s.name FROM students s WHERE s.tenant_id=? AND ${ELIGIBLE} AND (s.instructor_id IS NULL OR s.instructor_id=?) AND s.phone IS NOT NULL AND NOT EXISTS(SELECT 1 FROM student_courses sc WHERE sc.student_id=s.id) AND NOT EXISTS(SELECT 1 FROM student_account_link_operations op WHERE op.tenant_id=s.tenant_id AND op.student_id=s.id) AND s.id>? ORDER BY s.id LIMIT 26`, [tenant, ctx.principal.id, cursor]);
            return { body: { items: items.slice(0, 25), next_cursor: items.length > 25 ? items[24].id : null } };
        }
        const [request] = await ctx.rows("SELECT r.id,r.user_id,r.contact_hash,TIMESTAMPDIFF(SECOND,'1970-01-01 00:00:00',r.expires_at) AS expires_epoch,u.name,u.phone,u.token_version FROM student_account_link_requests r JOIN users u ON u.id=r.user_id JOIN student_enrollment_invites i ON i.id=r.invite_id AND i.tenant_id=r.tenant_id AND i.revoked_at IS NULL AND i.expires_at>UTC_TIMESTAMP() WHERE r.id=? AND r.tenant_id=? AND r.status='pending' AND r.expires_at>UTC_TIMESTAMP() AND u.role='student' AND u.is_active=1 AND NOT " + ACTIVE_SUSPENSION_PREDICATE_SQL.replace(/suspended_until/g, 'u.suspended_until') + ' LIMIT 1 FOR UPDATE', [req.body.request_id, tenant]);
        if (!request)
            deny(409, 'LINK_REQUEST_CHANGED');
        const [student] = await ctx.rows(`SELECT s.id,s.name,s.phone,s.is_offline,UNIX_TIMESTAMP(s.updated_at) AS updated_epoch FROM students s WHERE s.id=? AND s.tenant_id=? AND ${ELIGIBLE} AND (s.instructor_id IS NULL OR s.instructor_id=?) LIMIT 1 FOR UPDATE`, [req.body.student_id, tenant, ctx.principal.id]);
        if (!student)
            deny(409, 'LINK_STUDENT_CHANGED');
        const phone = normalizeEgyptianPhone(request.phone), studentPhone = normalizeEgyptianPhone(student.phone), contact = otpFor(ctx, key);
        if (!phone || phone !== studentPhone || contact.contactHash(phone) !== request.contact_hash)
            deny(409, 'LINK_CONTACT_CHANGED');
        if ((await ctx.rows('SELECT id FROM students WHERE tenant_id=? AND user_id=? LIMIT 1 FOR UPDATE', [tenant, request.user_id])).length || (await ctx.rows('SELECT course_id FROM student_courses WHERE student_id=? LIMIT 1 FOR UPDATE', [student.id])).length)
            deny(409, 'LINK_ENROLLMENT_CHANGED');
        const reviewToken = hash([tenant, ctx.principal.id, request, student]);
        const preview = { student: { id: student.id, name: student.name }, request: { id: request.id, name: request.name }, effect: 'identity_only' as const, review_token: reviewToken };
        if (reviewing)
            return { body: preview };
        if (req.body.review_token !== reviewToken)
            deny(409, 'LINK_REVIEW_CHANGED');
        const [updated] = await ctx.c.execute('UPDATE students SET user_id=?,is_offline=0,instructor_id=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND tenant_id=? AND user_id IS NULL AND group_id IS NULL AND branch_id IS NULL', [request.user_id, ctx.principal.id, student.id, tenant]);
        if (Number(updated.affectedRows) !== 1)
            throw Error('Link not confirmed');
        const [decided] = await ctx.c.execute("UPDATE student_account_link_requests SET status='linked' WHERE id=? AND tenant_id=? AND status='pending'", [request.id, tenant]);
        if (Number(decided.affectedRows) !== 1)
            throw Error('Request not decided');
        await seal(ctx, tenant, 'student.account_link.approved', student.id, { user_id: request.user_id, request_id: request.id, course_grants: 0 });
        const [saved] = await ctx.c.execute('INSERT INTO student_account_link_operations (tenant_id,operation_id,actor_user_id,request_id,student_id,user_id,request_hash) VALUES (?,?,?,?,?,?,?)', [tenant, operationId, ctx.principal.id, request.id, student.id, request.user_id, requestHash]);
        if (Number(saved.affectedRows) !== 1)
            throw Error('Receipt not confirmed');
        return { status: 201, write: true, body: { operation: { operation_id: operationId, request_id: request.id, student_id: student.id, state: 'account_linked' } } };
    });
    router.get('/account-link/requests', handler);
    router.get('/account-link/students', handler);
    router.get('/account-link/operations/:operationId', handler);
    router.post('/account-link/review', handler);
    router.post('/account-link/apply', handler);
    return router;
}
