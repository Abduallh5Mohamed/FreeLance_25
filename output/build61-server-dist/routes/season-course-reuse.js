"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.seasonDate = seasonDate;
exports.seasonInput = seasonInput;
exports.seasonReview = seasonReview;
exports.createSeasonCourseReuseRouter = createSeasonCourseReuseRouter;
const express_1 = require("express");
const teaching_authority_1 = require("../services/teaching-authority");
const crypto_1 = require("crypto");
const suspension_predicate_1 = require("../security/suspension-predicate");
const audit_log_1 = require("../services/audit-log");
const uuid = (x) => typeof x === 'string' && /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(x);
const exact = (x, keys) => !!x && typeof x === 'object' && !Array.isArray(x) && Object.keys(x).sort().join(',') === keys.slice().sort().join(',');
const hash = (x) => (0, crypto_1.createHash)('sha256').update(JSON.stringify(x)).digest('hex');
class Refusal extends Error {
    constructor(status, code) {
        super(code);
        this.status = status;
        this.code = code;
    }
}
function refuse(status, code) { throw new Refusal(status, code); }
function seasonDate(x) { if (typeof x !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(x) || x < '1000-01-01' || x > '9999-12-31')
    return false; const d = new Date(x + 'T00:00:00Z'); return !Number.isNaN(d.valueOf()) && d.toISOString().slice(0, 10) === x; }
const label = (x) => typeof x === 'string' && x.trim().length > 0 && x.trim().length <= 255;
function seasonInput(raw, apply = false) {
    const keys = ['period_id', 'source_course_id', 'target_name', 'rights_confirmed', ...(apply ? ['operation_id', 'review_token'] : [])];
    if (!exact(raw, keys) || !uuid(raw.period_id) || !uuid(raw.source_course_id) || !label(raw.target_name) || raw.rights_confirmed !== true || apply && (!uuid(raw.operation_id) || typeof raw.review_token !== 'string' || !/^[a-f\d]{64}$/.test(raw.review_token)))
        refuse(400, 'SEASON_INPUT');
    return { period_id: raw.period_id.toLowerCase(), source_course_id: raw.source_course_id.toLowerCase(), target_name: raw.target_name.trim(), rights_confirmed: true, ...apply ? { operation_id: String(raw.operation_id).toLowerCase(), review_token: String(raw.review_token) } : {} };
}
function parsePeriod(p) { if (!uuid(p.id) || !label(p.name) || !seasonDate(p.starts_on) || !seasonDate(p.ends_on) || p.starts_on > p.ends_on)
    throw Error('Invalid period'); return { id: p.id, name: p.name, starts_on: p.starts_on, ends_on: p.ends_on }; }
function parseSource(s) { if (!uuid(s.id) || !label(s.name) || ![['subject', 100], ['description', 20000], ['grade', 100]].every(([k, max]) => s[k] === null || typeof s[k] === 'string' && s[k].length <= max))
    throw Error('Invalid course config'); return { id: s.id, name: s.name, subject: s.subject, description: s.description, grade: s.grade }; }
function seasonReview(tenant, actor, period, source, targetName) {
    const p = parsePeriod(period), s = parseSource(source);
    const review = { period: p, source: s, target: { name: targetName, subject: s.subject, description: s.description, grade: s.grade, publication_state: 'draft', price: '0.00', schedule: 'not_created', templates: 'not_copied' } };
    return { ...review, review_token: hash([tenant, actor, review]) };
}
function createSeasonCourseReuseRouter(deps) {
    const router = (0, express_1.Router)();
    const handler = async (req, res) => {
        res.set('Cache-Control', 'no-store');
        if (!req.user)
            return res.status(401).json({ code: 'SESSION_REQUIRED' });
        if (!['teacher', 'instructor'].includes(req.user.role) || req.user.identitySource === 'staff' || req.user.billingOnly || req.impersonation || req.headers['x-impersonation'] !== undefined)
            return res.status(403).json({ code: 'SEASON_OWNER_REQUIRED' });
        const tenant = req.user.tenantId, actor = req.user.id;
        if (!tenant)
            return res.status(404).json({ code: 'SEASON_NOT_FOUND' });
        const route = req.url.split('?')[0], applying = route === '/season-reuse/apply', writing = applying, reviewing = route === '/season-reuse/review';
        if (Object.values(req.params).filter(x => x !== undefined).some(x => !uuid(x)) || Object.keys(req.query).some(k => k !== 'after') || req.query.after !== undefined && !uuid(req.query.after) || (req.method === 'POST' || req.params.operationId) && Object.keys(req.query).length || ['x-tenant-id', 'x-student-id', 'x-instructor-id'].some(k => req.headers[k] !== undefined))
            return res.status(400).json({ code: 'SEASON_INPUT' });
        let input = null;
        try {
            if (req.method === 'POST')
                input = seasonInput(req.body, applying);
            else if (req.body != null && !exact(req.body, []))
                refuse(400, 'SEASON_INPUT');
        }
        catch {
            return res.status(400).json({ code: 'SEASON_INPUT' });
        }
        let conn = null, open = false, commitAttempted = false, discard = false;
        try {
            conn = await deps.getConnection();
            await conn.beginTransaction();
            open = true;
            const c = conn;
            try {
                await (0, teaching_authority_1.proveTeachingIdentity)(c, req);
            }
            catch (e) {
                if (e instanceof teaching_authority_1.TeachingAuthorityDenied)
                    refuse(e.status, 'SEASON_OWNER_REQUIRED');
                throw e;
            }
            async function rows(sql, p = []) { const [r] = await c.execute(sql, p); if (!Array.isArray(r))
                throw Error('Invalid rows'); return r; }
            const owners = await rows(`SELECT t.owner_user_id FROM tenants t JOIN users u ON u.id=t.owner_user_id WHERE t.id=? AND t.owner_user_id=? AND t.status='active' AND u.is_active=1 AND u.token_version=? AND NOT ${suspension_predicate_1.ACTIVE_SUSPENSION_PREDICATE_SQL.replace(/suspended_until/g, 'u.suspended_until')} LIMIT 1 FOR UPDATE`, [tenant, actor, req.user.tokenVersion ?? 0]);
            if (owners.length !== 1 || owners[0].owner_user_id !== actor)
                refuse(403, 'SEASON_OWNER_REQUIRED');
            const tables = ['courses', 'academic_periods', 'season_course_reuse_operations', 'audit_events', 'audit_chain_head'];
            const engines = await rows('SELECT TABLE_NAME AS name,ENGINE AS engine FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN (?,?,?,?,?) LIMIT 5', tables);
            if (!tables.every(t => engines.some(r => r.name === t && r.engine === 'InnoDB')))
                refuse(503, 'SEASON_UNAVAILABLE');
            const columns = await rows("SELECT COLUMN_NAME AS name FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='courses' AND COLUMN_NAME IN ('publication_state','published_at') LIMIT 2");
            if (columns.length !== 2)
                refuse(503, 'SEASON_UNAVAILABLE');
            const indices = await rows("SELECT INDEX_NAME AS name,COLUMN_NAME AS col,SEQ_IN_INDEX AS seq FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='season_course_reuse_operations' AND NON_UNIQUE=0 LIMIT 10");
            for (const [name, fields] of [['PRIMARY', ['tenant_id', 'operation_id']], ['uq_season_course_source', ['tenant_id', 'period_id', 'source_course_id']], ['uq_season_target', ['target_course_id']]]) {
                const index = indices.filter(r => r.name === name).sort((a, b) => a.seq - b.seq);
                if (index.length !== fields.length || fields.some((f, i) => index[i].col !== f || Number(index[i].seq) !== i + 1))
                    refuse(503, 'SEASON_UNAVAILABLE');
            }
            const operationId = req.params.operationId?.toLowerCase() ?? input?.operation_id;
            const requestHash = applying ? hash([input.period_id, input.source_course_id, input.target_name, true, input.review_token]) : null;
            if (operationId) {
                const ops = await rows('SELECT actor_user_id,operation_id,period_id,source_course_id,target_course_id,request_hash FROM season_course_reuse_operations WHERE tenant_id=? AND operation_id=? LIMIT 1', [tenant, operationId]);
                if (ops.length) {
                    const op = ops[0];
                    if (op.actor_user_id !== actor)
                        refuse(applying ? 409 : 404, 'SEASON_OPERATION_CONFLICT');
                    if (applying && op.request_hash !== requestHash)
                        refuse(409, 'SEASON_OPERATION_CONFLICT');
                    const out = { operation_id: op.operation_id, period_id: op.period_id, source_course_id: op.source_course_id, target_course_id: op.target_course_id, state: 'draft_created' };
                    if (![out.operation_id, out.period_id, out.source_course_id, out.target_course_id].every(uuid))
                        throw Error('Invalid receipt');
                    return res.json({ operation: out });
                }
                if (!applying)
                    return res.json({ operation: null });
            }
            const after = req.query.after ?? '';
            if (req.method === 'GET') {
                if (route === '/season-reuse/history') {
                    const all = await rows("SELECT operation_id,period_id,source_course_id,target_course_id,target_name,period_name,DATE_FORMAT(starts_on,'%Y-%m-%d') AS starts_on,DATE_FORMAT(ends_on,'%Y-%m-%d') AS ends_on FROM season_course_reuse_operations WHERE tenant_id=? AND operation_id>? ORDER BY operation_id LIMIT 26", [tenant, after]);
                    const list = all.map(r => { if (![r.operation_id, r.period_id, r.source_course_id, r.target_course_id].every(uuid) || !label(r.target_name) || !label(r.period_name) || !seasonDate(r.starts_on) || !seasonDate(r.ends_on) || r.starts_on > r.ends_on)
                        throw Error('Invalid season history'); return { operation_id: r.operation_id, period_id: r.period_id, source_course_id: r.source_course_id, target_course_id: r.target_course_id, target_name: r.target_name, period_name: r.period_name, starts_on: r.starts_on, ends_on: r.ends_on }; });
                    if (new Set(list.map(r => r.operation_id)).size !== list.length)
                        throw Error('Duplicate history');
                    return res.json({ items: list.slice(0, 25), next_cursor: list.length > 25 ? list[24].operation_id : null });
                }
                if (route === '/season-reuse/periods') {
                    const all = await rows("SELECT id,name,DATE_FORMAT(starts_on,'%Y-%m-%d') AS starts_on,DATE_FORMAT(ends_on,'%Y-%m-%d') AS ends_on FROM academic_periods WHERE tenant_id=? AND is_archived=0 AND id>? ORDER BY id LIMIT 26", [tenant, after]);
                    const list = all.map(parsePeriod);
                    return res.json({ items: list.slice(0, 25), next_cursor: list.length > 25 ? list[24].id : null });
                }
                const all = await rows('SELECT id,name,subject,description,grade FROM courses WHERE tenant_id=? AND is_active=1 AND id>? ORDER BY id LIMIT 26', [tenant, after]);
                const list = all.map(parseSource);
                return res.json({ items: list.slice(0, 25), next_cursor: list.length > 25 ? list[24].id : null });
            }
            const periods = await rows("SELECT id,name,DATE_FORMAT(starts_on,'%Y-%m-%d') AS starts_on,DATE_FORMAT(ends_on,'%Y-%m-%d') AS ends_on FROM academic_periods WHERE id=? AND tenant_id=? AND is_archived=0 LIMIT 1 FOR UPDATE", [input.period_id, tenant]);
            const sources = await rows('SELECT id,name,subject,description,grade FROM courses WHERE id=? AND tenant_id=? AND is_active=1 LIMIT 1 FOR UPDATE', [input.source_course_id, tenant]);
            if (periods.length !== 1 || sources.length !== 1)
                refuse(404, 'SEASON_NOT_FOUND');
            const preview = seasonReview(tenant, actor, periods[0], sources[0], input.target_name);
            if (reviewing)
                return res.json(preview);
            if (input.review_token !== preview.review_token)
                refuse(409, 'SEASON_REVIEW_STALE');
            const existing = await rows('SELECT target_course_id FROM season_course_reuse_operations WHERE tenant_id=? AND period_id=? AND source_course_id=? LIMIT 1', [tenant, input.period_id, input.source_course_id]);
            if (existing.length)
                refuse(409, 'SEASON_SOURCE_ALREADY_REUSED');
            const target = (0, crypto_1.randomUUID)();
            await c.execute("INSERT INTO courses (id,tenant_id,instructor_id,name,subject,description,grade,is_active,price,publication_state,published_at) VALUES (?,?,?,?,?,?,?,1,0,'draft',NULL)", [target, tenant, actor, preview.target.name, preview.target.subject, preview.target.description, preview.target.grade]);
            await (0, audit_log_1.recordSealedAuditEvent)({ query: rows, queryOne: async (sql, p) => (await rows(sql, p))[0] ?? null, execute: async (sql, p) => { const [r] = await c.execute(sql, p); return { affectedRows: Number(r.affectedRows) }; } }, { actorUserId: actor, tenantId: tenant, action: 'season.course_reuse', resourceType: 'course', resourceId: target, newValue: { source_course_id: input.source_course_id, period_id: input.period_id, publication_state: 'draft', rights_confirmed: true, templates_copied: false } });
            await c.execute('INSERT INTO season_course_reuse_operations (tenant_id,operation_id,actor_user_id,period_id,source_course_id,target_course_id,request_hash,target_name,period_name,starts_on,ends_on) VALUES (?,?,?,?,?,?,?,?,?,?,?)', [tenant, operationId, actor, input.period_id, input.source_course_id, target, requestHash, preview.target.name, preview.period.name, preview.period.starts_on, preview.period.ends_on]);
            const result = { operation_id: operationId, period_id: input.period_id, source_course_id: input.source_course_id, target_course_id: target, state: 'draft_created' };
            commitAttempted = true;
            await c.commit();
            open = false;
            return res.status(201).json({ operation: result });
        }
        catch (e) {
            if (commitAttempted) {
                discard = true;
                open = false;
                return res.status(503).json({ code: 'PERSISTENCE_UNCERTAIN' });
            }
            if (e instanceof Refusal)
                return res.status(e.status).json({ code: e.code });
            return res.status(503).json({ code: writing ? 'PERSISTENCE_UNCERTAIN' : 'SEASON_UNAVAILABLE' });
        }
        finally {
            if (conn) {
                if (open)
                    try {
                        await conn.rollback();
                    }
                    catch {
                        discard = true;
                    }
                try {
                    if (discard)
                        conn.destroy();
                    else
                        conn.release();
                }
                catch {
                    try {
                        conn.destroy();
                    }
                    catch { }
                }
            }
        }
    };
    router.get(['/season-reuse/periods', '/season-reuse/courses', '/season-reuse/history', '/season-reuse/operations/:operationId'], handler);
    router.post(['/season-reuse/review', '/season-reuse/apply'], handler);
    return router;
}
