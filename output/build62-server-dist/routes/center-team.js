"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createCenterTeamRouter = createCenterTeamRouter;
const express_1 = require("express");
const bcryptjs_1 = __importDefault(require("bcryptjs"));
const node_crypto_1 = require("node:crypto");
const phone_1 = require("../security/phone");
const center_team_1 = require("../services/center-team");
const attendance_records_1 = require("./attendance-records");
const exact = (b, keys) => b && typeof b === 'object' && !Array.isArray(b) && Object.keys(b).sort().join(',') === [...keys].sort().join(',');
const integer = (v) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const text = (v, max) => typeof v === 'string' && !!v.trim() && v.length <= max;
const parseBranches = (v) => { if (!Array.isArray(v) || !v.length || v.length > 20 || v.some(x => !(0, center_team_1.centerUuid)(x)) || new Set(v).size !== v.length)
    throw new center_team_1.CenterDenied(400, 'INVALID_CENTER_BRANCHES'); return [...v].sort(); };
const inputPermissions = (v) => { try {
    const p = (0, center_team_1.centerPermissions)(v);
    if (p.includes('attendance.mark') && !p.includes('groups.read'))
        throw Error('Attendance requires group discovery');
    return p;
}
catch {
    throw new center_team_1.CenterDenied(400, 'INVALID_CENTER_PERMISSIONS');
} };
function createCenterTeamRouter(deps) {
    const router = (0, express_1.Router)();
    router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); res.set('Vary', 'Authorization'); next(); });
    const route = (write, fn) => async (req, res) => {
        if (!req.user)
            return res.status(401).json({ code: 'SESSION_REQUIRED' });
        if (req.impersonation || req.user.identitySource === 'staff' || req.user.billingOnly || ['x-tenant-id', 'x-instructor-id', 'x-impersonation', 'x-student-id'].some(k => req.headers[k] !== undefined))
            return res.status(403).json({ code: 'DIRECT_CENTER_SESSION_REQUIRED' });
        if (write && Object.keys(req.query).length || Object.keys(req.query).some(k => k !== 'after') || req.query.after !== undefined && !(0, center_team_1.centerUuid)(req.query.after))
            return res.status(400).json({ code: 'INVALID_CENTER_QUERY' });
        let c = null, began = false, committing = false, reusable = true;
        try {
            c = await deps.getConnection();
            await (0, center_team_1.centerTeamReady)((0, center_team_1.centerDb)(c));
            if (write) {
                await c.beginTransaction();
                began = true;
            }
            const result = await fn(req, (0, center_team_1.centerDb)(c));
            if (write) {
                committing = true;
                await c.commit();
                began = false;
            }
            return res.json(result);
        }
        catch (error) {
            if (began && c) {
                try {
                    await c.rollback();
                }
                catch {
                    reusable = false;
                }
            }
            if (committing)
                reusable = false;
            return res.status(error instanceof center_team_1.CenterDenied ? error.status : error instanceof center_team_1.CenterConflict ? 409 : 503).json({ code: error instanceof center_team_1.CenterDenied ? error.code : error instanceof center_team_1.CenterConflict ? 'CENTER_VERSION_CONFLICT' : write ? 'CENTER_WRITE_UNCERTAIN' : 'CENTER_UNAVAILABLE' });
        }
        finally {
            if (c) {
                if (!reusable) {
                    try {
                        c.destroy();
                    }
                    catch { }
                }
                else
                    c.release();
            }
        }
    };
    async function operation(req, db, tenantId, kind, input, work) {
        const key = req.headers['idempotency-key'];
        if (!(0, center_team_1.centerUuid)(key))
            throw new center_team_1.CenterDenied(400, 'CENTER_REQUEST_KEY_REQUIRED');
        const fingerprint = (0, node_crypto_1.createHash)('sha256').update(JSON.stringify(input)).digest('hex');
        const old = await db.query('SELECT actor_user_id,tenant_id,kind,fingerprint,result FROM center_team_operations WHERE id=? LIMIT 1 FOR UPDATE', [key]);
        if (old.length) {
            const row = old[0];
            if (row.actor_user_id !== req.user.id || row.tenant_id !== tenantId || row.kind !== kind || row.fingerprint !== fingerprint)
                throw new center_team_1.CenterConflict();
            return { receipt: typeof row.result === 'string' ? JSON.parse(row.result) : row.result, replay: true };
        }
        const result = await work();
        if (result?.ok === false)
            return { receipt: result, replay: false };
        await (0, center_team_1.centerAudit)(db, req.user.id, tenantId, 'center.' + kind, result.id ?? result.outcome?.id, result);
        await db.execute('INSERT INTO center_team_operations(id,tenant_id,actor_user_id,kind,fingerprint,result) VALUES(?,?,?,?,?,?)', [key, tenantId, req.user.id, kind, fingerprint, JSON.stringify(result)]);
        return { receipt: result, replay: false };
    }
    async function memberForOwner(db, tenant, id, lock = false) {
        if (!(0, center_team_1.centerUuid)(id))
            throw new center_team_1.CenterDenied();
        const rows = await db.query(`SELECT m.id,m.user_id,m.permissions,m.status,m.version,u.name FROM center_team_members m INNER JOIN users u ON u.id=m.user_id WHERE m.id=? AND m.tenant_id=? LIMIT 1${lock ? ' FOR UPDATE' : ''}`, [id, tenant]);
        if (rows.length !== 1)
            throw new center_team_1.CenterDenied();
        return rows[0];
    }
    async function validateBranches(db, tenant, ids, active = true) {
        for (const id of ids)
            if ((await db.query("SELECT id FROM branches WHERE id=? AND tenant_id=?" + (active ? " AND status='active'" : "") + " LIMIT 1 FOR UPDATE", [id, tenant])).length !== 1)
                throw new center_team_1.CenterDenied(400, 'CENTER_BRANCH_UNAVAILABLE');
    }
    router.get('/team/owner', route(false, async (req, db) => {
        const tenant = await (0, center_team_1.proveCenterOwner)(db, req.user);
        const members = await db.query('SELECT m.id,u.name,m.permissions,m.status,m.version FROM center_team_members m INNER JOIN users u ON u.id=m.user_id WHERE m.tenant_id=? ORDER BY m.id LIMIT 101', [tenant]);
        const branches = await db.query("SELECT id,name FROM branches WHERE tenant_id=? AND status='active' ORDER BY id LIMIT 101", [tenant]);
        const links = await db.query('SELECT mb.member_id,mb.branch_id FROM center_team_branches mb INNER JOIN center_team_members m ON m.id=mb.member_id WHERE m.tenant_id=? ORDER BY mb.member_id,mb.branch_id LIMIT 2001', [tenant]);
        if (members.length > 100 || branches.length > 100 || links.length > 2000)
            throw Error('Center list cap');
        await (0, center_team_1.proveCenterOwner)(db, req.user);
        return { members: members.map(m => ({ id: m.id, name: m.name, permissions: (0, center_team_1.centerPermissions)(m.permissions), status: m.status, version: Number(m.version), branch_ids: links.filter(b => b.member_id === m.id).map(b => b.branch_id) })), branches };
    }));
    router.post('/team/members', route(true, async (req, db) => {
        const tenant = await (0, center_team_1.proveCenterOwner)(db, req.user, true), b = req.body;
        if (!exact(b, ['name', 'phone', 'password', 'permissions', 'branch_ids']) || !text(b.name, 100) || typeof b.phone !== 'string' || typeof b.password !== 'string' || b.password.length < 12 || b.password.length > 128)
            throw new center_team_1.CenterDenied(400, 'INVALID_CENTER_ACCOUNT');
        const phone = (0, phone_1.normalizeEgyptianPhone)(b.phone);
        if (!phone)
            throw new center_team_1.CenterDenied(400, 'INVALID_CENTER_PHONE');
        const permissions = inputPermissions(b.permissions), branches = parseBranches(b.branch_ids);
        // Password is never persisted in an operation marker/fingerprint/receipt. A key replay cannot reset it.
        return operation(req, db, tenant, 'member.created', [b.name.trim(), phone, permissions, branches], async () => {
            await validateBranches(db, tenant, branches);
            const candidates = (0, phone_1.phoneLookupCandidates)(phone), marks = candidates.map(() => '?').join(',');
            if ((await db.query(`SELECT id FROM users WHERE phone IN (${marks}) LIMIT 1 FOR UPDATE`, candidates)).length || (await db.query(`SELECT id FROM staff WHERE phone IN (${marks}) LIMIT 1 FOR UPDATE`, candidates)).length)
                throw new center_team_1.CenterConflict();
            const user = (0, node_crypto_1.randomUUID)(), id = (0, node_crypto_1.randomUUID)(), hash = await bcryptjs_1.default.hash(b.password, 12);
            await db.execute("INSERT INTO users(id,name,phone,password_hash,role,is_active,token_version,center_account) VALUES(?,?,?,?,'staff',1,0,1)", [user, b.name.trim(), phone, hash]);
            await db.execute("INSERT INTO center_team_members(id,tenant_id,user_id,permissions,status) VALUES(?,?,?,?,'active')", [id, tenant, user, JSON.stringify(permissions)]);
            for (const branch of branches)
                await db.execute('INSERT INTO center_team_branches(member_id,branch_id) VALUES(?,?)', [id, branch]);
            return { id, version: 0, status: 'active', kind: 'member.created' };
        });
    }));
    router.post('/team/members/:id/access', route(true, async (req, db) => {
        const tenant = await (0, center_team_1.proveCenterOwner)(db, req.user, true), b = req.body;
        if (!exact(b, ['expected_version', 'status', 'permissions', 'branch_ids']) || !integer(b.expected_version) || !['active', 'suspended'].includes(b.status))
            throw new center_team_1.CenterDenied(400, 'INVALID_CENTER_ACCESS');
        const permissions = inputPermissions(b.permissions), branches = parseBranches(b.branch_ids), m = await memberForOwner(db, tenant, req.params.id, true);
        return operation(req, db, tenant, 'member.access', [m.id, b.expected_version, b.status, permissions, branches], async () => {
            if (Number(m.version) !== b.expected_version)
                throw new center_team_1.CenterConflict();
            await validateBranches(db, tenant, branches, b.status === 'active');
            await db.execute('UPDATE center_team_members SET permissions=?,status=?,version=version+1 WHERE id=? AND version=?', [JSON.stringify(permissions), b.status, m.id, b.expected_version]);
            await db.execute('DELETE FROM center_team_branches WHERE member_id=?', [m.id]);
            for (const branch of branches)
                await db.execute('INSERT INTO center_team_branches(member_id,branch_id) VALUES(?,?)', [m.id, branch]);
            await db.execute('UPDATE users SET token_version=COALESCE(token_version,0)+1 WHERE id=?', [m.user_id]);
            return { id: m.id, version: b.expected_version + 1, status: b.status, kind: 'member.access' };
        });
    }));
    router.post('/team/members/:id/password', route(true, async (req, db) => {
        const tenant = await (0, center_team_1.proveCenterOwner)(db, req.user, true), b = req.body;
        if (!exact(b, ['expected_version', 'password']) || !integer(b.expected_version) || typeof b.password !== 'string' || b.password.length < 12 || b.password.length > 128)
            throw new center_team_1.CenterDenied(400, 'INVALID_CENTER_PASSWORD');
        const m = await memberForOwner(db, tenant, req.params.id, true);
        return operation(req, db, tenant, 'member.password', [m.id, b.expected_version], async () => { if (Number(m.version) !== b.expected_version)
            throw new center_team_1.CenterConflict(); const hash = await bcryptjs_1.default.hash(b.password, 12); await db.execute('UPDATE users SET password_hash=?,token_version=COALESCE(token_version,0)+1 WHERE id=?', [hash, m.user_id]); await db.execute('UPDATE center_team_members SET version=version+1 WHERE id=? AND version=?', [m.id, b.expected_version]); return { id: m.id, version: b.expected_version + 1, status: m.status, kind: 'member.password' }; });
    }));
    router.get('/team/workspaces', route(false, async (req, db) => {
        const rows = await db.query("SELECT m.id,t.business_name FROM center_team_members m INNER JOIN tenants t ON t.id=m.tenant_id AND t.status='active' WHERE m.user_id=? AND m.status='active' ORDER BY m.id LIMIT 26", [req.user.id]);
        if (rows.length > 25)
            throw Error('Workspace cap');
        const workspaces = [];
        for (const row of rows) {
            const m = await (0, center_team_1.proveCenterMember)(db, req.user, row.id);
            workspaces.push({ id: m.id, name: row.business_name, permissions: m.permissions });
        }
        return { workspaces };
    }));
    router.get('/team/work/:memberId/groups', route(false, async (req, db) => {
        const m = await (0, center_team_1.proveCenterMember)(db, req.user, req.params.memberId, 'groups.read');
        const groups = await db.query(`SELECT g.id,g.name,b.name AS branch_name FROM \`groups\` g INNER JOIN courses c ON c.id=g.course_id AND c.tenant_id=? AND c.is_active=1
      INNER JOIN branches b ON b.id=g.branch_id AND b.tenant_id=c.tenant_id AND b.status='active'
      INNER JOIN center_team_branches mb ON mb.branch_id=b.id AND mb.member_id=? WHERE g.branch_scope='branch' AND g.is_active=1 AND g.id>? ORDER BY g.id LIMIT 26`, [m.tenant_id, m.id, req.query.after ?? '']);
        await (0, center_team_1.proveCenterMember)(db, req.user, m.id, 'groups.read');
        return { groups: groups.slice(0, 25), next_cursor: groups.length > 25 ? groups[24].id : null };
    }));
    const taskSql = "SELECT q.id,q.branch_id,q.assigned_member_id,q.title,q.status,q.version,DATE_FORMAT(q.due_at,'%Y-%m-%dT%H:%i:%s.000Z') AS due_at,(q.status<>'resolved' AND q.due_at<UTC_TIMESTAMP()) AS overdue FROM center_team_tasks q";
    router.get('/team/tasks', route(false, async (req, db) => { const tenant = await (0, center_team_1.proveCenterOwner)(db, req.user); const rows = await db.query(taskSql + ' WHERE q.tenant_id=? AND q.id>? ORDER BY q.id LIMIT 26', [tenant, req.query.after ?? '']); await (0, center_team_1.proveCenterOwner)(db, req.user); return { tasks: rows.slice(0, 25).map(r => ({ ...r, overdue: Boolean(r.overdue) })), next_cursor: rows.length > 25 ? rows[24].id : null }; }));
    router.get('/team/work/:memberId/tasks', route(false, async (req, db) => {
        const m = await (0, center_team_1.proveCenterMember)(db, req.user, req.params.memberId, 'tasks.manage');
        const rows = await db.query(taskSql + " INNER JOIN center_team_branches mb ON mb.member_id=q.assigned_member_id AND mb.branch_id=q.branch_id INNER JOIN branches b ON b.id=q.branch_id AND b.tenant_id=q.tenant_id AND b.status='active' WHERE q.tenant_id=? AND q.assigned_member_id=? AND q.id>? ORDER BY q.id LIMIT 26", [m.tenant_id, m.id, req.query.after ?? '']);
        await (0, center_team_1.proveCenterMember)(db, req.user, m.id, 'tasks.manage');
        return { tasks: rows.slice(0, 25).map(r => ({ ...r, overdue: Boolean(r.overdue) })), next_cursor: rows.length > 25 ? rows[24].id : null };
    }));
    router.post('/team/tasks', route(true, async (req, db) => {
        const tenant = await (0, center_team_1.proveCenterOwner)(db, req.user, true), b = req.body;
        if (!exact(b, ['title', 'member_id', 'branch_id', 'due_at']) || !text(b.title, 200) || !(0, center_team_1.centerUuid)(b.member_id) || !(0, center_team_1.centerUuid)(b.branch_id) || b.due_at !== null && (typeof b.due_at !== 'string' || !Number.isFinite(Date.parse(b.due_at)) || new Date(b.due_at).toISOString() !== b.due_at))
            throw new center_team_1.CenterDenied(400, 'INVALID_CENTER_TASK');
        return operation(req, db, tenant, 'task.created', [b.title.trim(), b.member_id, b.branch_id, b.due_at], async () => { const m = await memberForOwner(db, tenant, b.member_id, true); if (m.status !== 'active' || !(0, center_team_1.centerPermissions)(m.permissions).includes('tasks.manage'))
            throw new center_team_1.CenterDenied(); await (0, center_team_1.proveCenterBranch)(db, tenant, m.id, b.branch_id, true); const id = (0, node_crypto_1.randomUUID)(); await db.execute('INSERT INTO center_team_tasks(id,tenant_id,branch_id,assigned_member_id,title,due_at) VALUES(?,?,?,?,?,?)', [id, tenant, b.branch_id, m.id, b.title.trim(), b.due_at === null ? null : b.due_at.slice(0, 19).replace('T', ' ')]); return { id, version: 0, status: 'open', kind: 'task.created' }; });
    }));
    router.post('/team/work/:memberId/tasks/:id/status', route(true, async (req, db) => {
        const m = await (0, center_team_1.proveCenterMember)(db, req.user, req.params.memberId, 'tasks.manage', true), b = req.body;
        if (!exact(b, ['expected_version', 'status']) || !integer(b.expected_version) || !['in_progress', 'resolved'].includes(b.status))
            throw new center_team_1.CenterDenied(400, 'INVALID_CENTER_TASK_STATUS');
        const rows = await db.query('SELECT id,branch_id,status,version FROM center_team_tasks WHERE id=? AND tenant_id=? AND assigned_member_id=? LIMIT 1 FOR UPDATE', [req.params.id, m.tenant_id, m.id]);
        if (rows.length !== 1)
            throw new center_team_1.CenterDenied();
        const q = rows[0];
        await (0, center_team_1.proveCenterBranch)(db, m.tenant_id, m.id, q.branch_id, true);
        return operation(req, db, m.tenant_id, 'task.status', [req.params.id, b.expected_version, b.status], async () => { if (Number(q.version) !== b.expected_version || q.status === 'resolved' || b.status === 'in_progress' && q.status !== 'open')
            throw new center_team_1.CenterConflict(); await db.execute('UPDATE center_team_tasks SET status=?,version=version+1,updated_at=UTC_TIMESTAMP() WHERE id=? AND version=?', [b.status, q.id, b.expected_version]); return { id: q.id, version: b.expected_version + 1, status: b.status, kind: 'task.status' }; });
    }));
    router.post('/team/tasks/:id/assign', route(true, async (req, db) => {
        const tenant = await (0, center_team_1.proveCenterOwner)(db, req.user, true), b = req.body;
        if (!exact(b, ['expected_version', 'member_id']) || !integer(b.expected_version) || !(0, center_team_1.centerUuid)(b.member_id))
            throw new center_team_1.CenterDenied(400, 'INVALID_CENTER_ASSIGNMENT');
        return operation(req, db, tenant, 'task.assigned', [req.params.id, b.expected_version, b.member_id], async () => { const rows = await db.query('SELECT id,branch_id,status,version FROM center_team_tasks WHERE id=? AND tenant_id=? LIMIT 1 FOR UPDATE', [req.params.id, tenant]); if (rows.length !== 1)
            throw new center_team_1.CenterDenied(); const q = rows[0], m = await memberForOwner(db, tenant, b.member_id, true); if (m.status !== 'active' || !(0, center_team_1.centerPermissions)(m.permissions).includes('tasks.manage'))
            throw new center_team_1.CenterDenied(); await (0, center_team_1.proveCenterBranch)(db, tenant, m.id, q.branch_id, true); if (Number(q.version) !== b.expected_version || q.status === 'resolved')
            throw new center_team_1.CenterConflict(); await db.execute('UPDATE center_team_tasks SET assigned_member_id=?,version=version+1,updated_at=UTC_TIMESTAMP() WHERE id=? AND version=?', [m.id, q.id, b.expected_version]); return { id: q.id, version: b.expected_version + 1, status: q.status, kind: 'task.assigned' }; });
    }));
    router.get('/team/operations/:key', route(false, async (req, db) => { if (!(0, center_team_1.centerUuid)(req.params.key))
        throw new center_team_1.CenterDenied(400); const rows = await db.query('SELECT tenant_id,kind,result FROM center_team_operations WHERE id=? AND actor_user_id=? LIMIT 1', [req.params.key, req.user.id]); if (!rows.length)
        return { receipt: null }; const r = rows[0]; if (req.user.tenantId === r.tenant_id)
        await (0, center_team_1.proveCenterOwner)(db, req.user);
    else {
        const ms = await db.query('SELECT id FROM center_team_members WHERE user_id=? AND tenant_id=? LIMIT 1', [req.user.id, r.tenant_id]);
        if (ms.length !== 1)
            throw new center_team_1.CenterDenied();
        await proveWorkerReceipt(db, req.user, ms[0].id, r);
    } return { receipt: typeof r.result === 'string' ? JSON.parse(r.result) : r.result }; }));
    router.post('/team/operations/:key/retire', route(true, async (req, db) => {
        if (!(0, center_team_1.centerUuid)(req.params.key) || !exact(req.body, []))
            throw new center_team_1.CenterDenied(400);
        let tenant;
        if (req.user.tenantId)
            tenant = await (0, center_team_1.proveCenterOwner)(db, req.user, true);
        else {
            const ms = await db.query('SELECT id FROM center_team_members WHERE user_id=? LIMIT 1', [req.user.id]);
            if (ms.length !== 1)
                throw new center_team_1.CenterDenied();
            tenant = (await (0, center_team_1.proveCenterMember)(db, req.user, ms[0].id, undefined, true)).tenant_id;
        }
        const rows = await db.query('SELECT actor_user_id,tenant_id,kind,result FROM center_team_operations WHERE id=? LIMIT 1 FOR UPDATE', [req.params.key]);
        if (rows.length) {
            const r = rows[0];
            if (r.actor_user_id !== req.user.id || r.tenant_id !== tenant)
                throw new center_team_1.CenterDenied();
            if (!req.user.tenantId) {
                const ms = await db.query('SELECT id FROM center_team_members WHERE user_id=? LIMIT 1', [req.user.id]);
                if (ms.length !== 1)
                    throw new center_team_1.CenterDenied();
                await proveWorkerReceipt(db, req.user, ms[0].id, r);
            }
            return { receipt: typeof r.result === 'string' ? JSON.parse(r.result) : r.result };
        }
        const result = { id: req.params.key, version: 0, status: 'retired', kind: 'operation.retired' };
        await (0, center_team_1.centerAudit)(db, req.user.id, tenant, 'center.operation.retired', req.params.key, result);
        await db.execute('INSERT INTO center_team_operations(id,tenant_id,actor_user_id,kind,fingerprint,result) VALUES(?,?,?,?,?,?)', [req.params.key, tenant, req.user.id, 'operation.retired', '0'.repeat(64), JSON.stringify(result)]);
        return { receipt: result };
    }));
    async function groupProof(db, m, groupId, lock = false) {
        if (!(0, center_team_1.centerUuid)(groupId))
            throw new center_team_1.CenterDenied();
        const rows = await db.query(`SELECT g.id,g.branch_id FROM \`groups\` g INNER JOIN courses c ON c.id=g.course_id AND c.tenant_id=? AND c.is_active=1
      INNER JOIN branches b ON b.id=g.branch_id AND b.tenant_id=c.tenant_id AND b.status='active'
      INNER JOIN center_team_branches mb ON mb.branch_id=b.id AND mb.member_id=?
      WHERE g.id=? AND g.is_active=1 AND g.branch_scope='branch' LIMIT 1${lock ? ' FOR UPDATE' : ''}`, [m.tenant_id, m.id, groupId]);
        if (rows.length !== 1)
            throw new center_team_1.CenterDenied();
        return rows[0];
    }
    async function proveWorkerReceipt(db, actor, memberId, row) {
        if (!['attendance.mark', 'task.status', 'operation.retired'].includes(row.kind))
            throw new center_team_1.CenterDenied();
        const m = await (0, center_team_1.proveCenterMember)(db, actor, memberId, row.kind === 'attendance.mark' ? 'attendance.mark' : row.kind === 'task.status' ? 'tasks.manage' : undefined), result = typeof row.result === 'string' ? JSON.parse(row.result) : row.result;
        if (row.kind === 'attendance.mark') {
            const rows = await db.query("SELECT ss.group_id FROM attendance_records a INNER JOIN schedule_sessions ss ON ss.id=a.session_id AND ss.tenant_id=a.tenant_id WHERE a.id=? AND a.tenant_id=? AND ss.audience='group' AND ss.status='scheduled' LIMIT 1", [result.outcome?.id, m.tenant_id]);
            if (rows.length !== 1)
                throw new center_team_1.CenterDenied();
            await groupProof(db, m, rows[0].group_id);
        }
        if (row.kind === 'task.status') {
            const rows = await db.query('SELECT branch_id FROM center_team_tasks WHERE id=? AND tenant_id=? AND assigned_member_id=? LIMIT 1', [result.id, m.tenant_id, m.id]);
            if (rows.length !== 1)
                throw new center_team_1.CenterDenied();
            await (0, center_team_1.proveCenterBranch)(db, m.tenant_id, m.id, rows[0].branch_id);
        }
    }
    router.get('/team/work/:memberId/groups/:groupId/sessions', route(false, async (req, db) => {
        const m = await (0, center_team_1.proveCenterMember)(db, req.user, req.params.memberId, 'groups.read');
        await groupProof(db, m, req.params.groupId);
        const rows = await db.query(`SELECT id,title,DATE_FORMAT(starts_at,'%Y-%m-%dT%H:%i:%s.000Z') AS starts_at,DATE_FORMAT(ends_at,'%Y-%m-%dT%H:%i:%s.000Z') AS ends_at
      FROM schedule_sessions WHERE tenant_id=? AND group_id=? AND audience='group' AND status='scheduled'
      AND starts_at>=DATE_SUB(UTC_TIMESTAMP(),INTERVAL 7 DAY) AND starts_at<DATE_ADD(UTC_TIMESTAMP(),INTERVAL 7 DAY)
      AND id>? ORDER BY id LIMIT 26`, [m.tenant_id, req.params.groupId, req.query.after ?? '']);
        await (0, center_team_1.proveCenterMember)(db, req.user, m.id, 'groups.read');
        await groupProof(db, m, req.params.groupId);
        return { sessions: rows.slice(0, 25), next_cursor: rows.length > 25 ? rows[24].id : null };
    }));
    router.get('/team/work/:memberId/sessions/:sessionId/students', route(false, async (req, db) => {
        const m = await (0, center_team_1.proveCenterMember)(db, req.user, req.params.memberId, 'attendance.mark');
        const sessions = await db.query("SELECT group_id FROM schedule_sessions WHERE id=? AND tenant_id=? AND audience='group' AND status='scheduled' LIMIT 1", [req.params.sessionId, m.tenant_id]);
        if (sessions.length !== 1)
            throw new center_team_1.CenterDenied();
        await groupProof(db, m, sessions[0].group_id);
        const rows = await db.query(`SELECT s.id,s.name,a.state FROM students s LEFT JOIN attendance_records a ON a.session_id=? AND a.student_id=s.id AND a.tenant_id=s.tenant_id
      WHERE s.tenant_id=? AND s.group_id=? AND s.is_active=1 AND (s.approval_status IS NULL OR s.approval_status='approved')
      AND (s.enrollment_status IS NULL OR s.enrollment_status='active') AND (s.enrollment_start_date IS NULL OR s.enrollment_start_date<=UTC_TIMESTAMP())
      AND (s.enrollment_end_date IS NULL OR s.enrollment_end_date>UTC_TIMESTAMP()) AND s.id>? ORDER BY s.id LIMIT 26`, [req.params.sessionId, m.tenant_id, sessions[0].group_id, req.query.after ?? '']);
        await (0, center_team_1.proveCenterMember)(db, req.user, m.id, 'attendance.mark');
        await groupProof(db, m, sessions[0].group_id);
        return { students: rows.slice(0, 25), next_cursor: rows.length > 25 ? rows[24].id : null };
    }));
    router.use('/team/work/:memberId/attendance', async (req, res, next) => {
        const memberId = req.params.memberId, match = /^\/sessions\/([a-f\d-]{36})\/records\/?$/i.exec(req.path);
        if (req.method !== 'POST' || !match || !(0, center_team_1.centerUuid)(match[1]) || Object.keys(req.query).length || !req.user || req.impersonation || req.user.billingOnly || req.user.identitySource === 'staff' || ['x-tenant-id', 'x-instructor-id', 'x-student-id', 'x-impersonation'].some(k => req.headers[k] !== undefined))
            return res.status(404).json({ code: 'CENTER_SCOPE_DENIED' });
        const actor = req.user, sessionId = match[1];
        if (!exact(req.body, ['student_id', 'state', 'reason']))
            return res.status(400).json({ code: 'INVALID_CENTER_ATTENDANCE' });
        const read = async (work) => { const c = await deps.getConnection(); try {
            return await work((0, center_team_1.centerDb)(c));
        }
        finally {
            c.release();
        } };
        const pool = { query: (s, p) => read(db => db.query(s, p)), queryOne: async (s, p) => (await read(db => db.query(s, p)))[0] ?? null, execute: async () => { throw Error('Attendance writes require transaction'); } };
        const engine = (0, attendance_records_1.createAttendanceRecordsRouter)({ db: pool, authenticate: (_r, _s, n) => n(), loadActiveTenantAuthority: async () => null,
            delegation: { resolve: async () => read(async (db) => { await (0, center_team_1.centerTeamReady)(db); await (0, center_team_1.centerAttendanceReady)(db); const m = await (0, center_team_1.proveCenterMember)(db, actor, memberId, 'attendance.mark'); return { tenantId: m.tenant_id, userId: actor.id }; }).catch(() => null), authorizeSession: async (tx, session) => { try {
                    const db = tx, m = await (0, center_team_1.proveCenterMember)(db, actor, memberId, 'attendance.mark', true);
                    if (session.tenant_id !== m.tenant_id || session.audience !== 'group' || !session.group_id)
                        return false;
                    await groupProof(db, m, session.group_id, true);
                    return true;
                }
                catch {
                    return false;
                } } },
            transaction: async (work) => {
                const c = await deps.getConnection();
                let committing = false, reusable = true;
                try {
                    await c.beginTransaction();
                    const db = (0, center_team_1.centerDb)(c);
                    await (0, center_team_1.centerAttendanceReady)(db);
                    const m = await (0, center_team_1.proveCenterMember)(db, actor, memberId, 'attendance.mark', true);
                    const scope = await db.query("SELECT group_id FROM schedule_sessions WHERE id=? AND tenant_id=? AND audience='group' AND status='scheduled' LIMIT 1 FOR UPDATE", [sessionId, m.tenant_id]);
                    if (scope.length !== 1)
                        throw new center_team_1.CenterDenied();
                    await groupProof(db, m, scope[0].group_id, true);
                    const out = await operation(req, db, m.tenant_id, 'attendance.mark', [memberId, sessionId, req.body], async () => work({ ...db, queryOne: async (s, p) => (await db.query(s, p))[0] ?? null }));
                    committing = true;
                    await c.commit();
                    return out.replay && out.receipt?.ok ? { ...out.receipt, outcome: { ...out.receipt.outcome, outcome: 'unchanged' } } : out.receipt;
                }
                catch (error) {
                    try {
                        await c.rollback();
                    }
                    catch {
                        reusable = false;
                    }
                    if (committing)
                        reusable = false;
                    if (!committing && (error instanceof center_team_1.CenterDenied || error instanceof center_team_1.CenterConflict))
                        return { ok: false, status: error instanceof center_team_1.CenterDenied ? error.status : 409, body: { code: error instanceof center_team_1.CenterDenied ? error.code : 'CENTER_VERSION_CONFLICT' } };
                    throw error;
                }
                finally {
                    if (reusable)
                        c.release();
                    else
                        c.destroy();
                }
            }
        });
        try {
            return engine(req, res, next);
        }
        catch {
            return res.status(503).json({ code: 'CENTER_UNAVAILABLE' });
        }
    });
    return router;
}
