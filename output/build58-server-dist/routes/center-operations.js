"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createCenterOperationsRouter = createCenterOperationsRouter;
const express_1 = require("express");
const suspension_predicate_1 = require("../security/suspension-predicate");
const uuid = (x) => typeof x === 'string' && /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(x);
const title = (x) => typeof x === 'string' && !!x.trim() && x.length <= 255;
const flag = (x) => { if (![0, 1, '0', '1', true, false].includes(x))
    throw Error('Invalid operations flag'); return x === 1 || x === '1' || x === true; };
const ownerSql = `SELECT t.id FROM tenants t INNER JOIN users u ON u.id=t.owner_user_id
 WHERE t.id=? AND t.owner_user_id=? AND t.status='active' AND u.is_active=1
 AND NOT ${suspension_predicate_1.ACTIVE_SUSPENSION_PREDICATE_SQL.replace(/suspended_until/g, 'u.suspended_until')} AND COALESCE(u.token_version,0)=? LIMIT 1`;
function createCenterOperationsRouter(deps) {
    const router = (0, express_1.Router)();
    router.get('/operations', async (req, res) => {
        res.set('Cache-Control', 'no-store');
        res.set('Vary', 'Authorization');
        if (!req.user)
            return res.status(401).json({ code: 'SESSION_REQUIRED' });
        if (req.user.billingOnly || req.user.identitySource === 'staff' || req.impersonation)
            return res.status(403).json({ code: 'CENTER_OWNER_REQUIRED' });
        const { tenantId, id: userId } = req.user, after = req.query.groups_after;
        if (Object.keys(req.query).some(k => k !== 'groups_after') || after !== undefined && !uuid(after) || Object.keys(req.body ?? {}).length
            || ['x-tenant-id', 'x-student-id', 'x-instructor-id', 'x-impersonation'].some(k => req.headers[k] !== undefined))
            return res.status(400).json({ code: 'CENTER_SELECTORS_DENIED' });
        if (!tenantId || !userId)
            return res.status(403).json({ code: 'CENTER_OWNER_REQUIRED' });
        let c = null;
        try {
            c = await deps.getConnection();
            const read = async (sql, p) => { const [rows] = await c.execute(sql, p); if (!Array.isArray(rows))
                throw Error('Invalid operations data'); return rows; };
            const owner = async () => (await read(ownerSql, [tenantId, userId, req.user.tokenVersion ?? 0])).some(r => r.id === tenantId);
            if (!await owner())
                return res.status(403).json({ code: 'CENTER_OWNER_REQUIRED' });
            const groups = await read(`SELECT g.id,g.name,g.is_active,c.name AS course_name,c.is_active AS course_active,
        g.branch_scope,g.branch_id,b.name AS branch_name,b.status AS branch_status
        FROM \`groups\` g INNER JOIN courses c ON c.id=g.course_id AND c.tenant_id=?
        LEFT JOIN branches b ON b.id=g.branch_id AND b.tenant_id=c.tenant_id
        WHERE g.id>? ORDER BY g.id LIMIT 26`, [tenantId, after ?? '']);
            if (groups.length > 26)
                throw Error('Unbounded groups');
            const projected = groups.map((g, i) => {
                if (!uuid(g.id) || !title(g.name) || !title(g.course_name) || g.id.toLowerCase() <= (i ? groups[i - 1].id.toLowerCase() : String(after ?? '').toLowerCase()))
                    throw Error('Invalid groups');
                const scope = g.branch_scope === 'tenant' && g.branch_id === null ? 'tenant' : g.branch_scope === 'branch' && g.branch_status === 'active' && title(g.branch_name) ? 'active_branch' : 'unavailable';
                return { id: g.id, name: g.name, active: flag(g.is_active), course_name: g.course_name, course_active: flag(g.course_active),
                    branch_scope: scope, branch_name: scope === 'active_branch' ? g.branch_name : null };
            });
            const members = await read(`SELECT m.user_id,m.role_key FROM tenant_memberships m
        INNER JOIN users u ON u.id=m.user_id AND u.is_active=1
        AND NOT ${suspension_predicate_1.ACTIVE_SUSPENSION_PREDICATE_SQL.replace(/suspended_until/g, 'u.suspended_until')}
        WHERE m.tenant_id=? AND m.status='active' ORDER BY m.user_id LIMIT 501`, [tenantId]);
            if (members.length > 500 || new Set(members.map(m => m.user_id)).size !== members.length || members.some(m => typeof m.user_id !== 'string' || !m.user_id || typeof m.role_key !== 'string' || !m.role_key || m.role_key.length > 64))
                throw Error('Invalid member evidence');
            const teaching = members.filter(m => ['owner', 'instructor'].includes(m.role_key)).length;
            if (!await owner())
                return res.status(403).json({ code: 'CENTER_OWNER_REQUIRED' });
            return res.json({ checked_at: new Date().toISOString(), groups: projected.slice(0, 25), next_cursor: projected.length > 25 ? projected[24].id : null,
                team: { active_memberships: members.length, teaching_memberships: teaching, other_memberships: members.length - teaching } });
        }
        catch {
            return res.status(503).json({ code: 'CENTER_OPERATIONS_UNAVAILABLE' });
        }
        finally {
            c?.release();
        }
    });
    return router;
}
