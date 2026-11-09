"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseOfflineSetup = parseOfflineSetup;
exports.createStudentOfflineSetupRouter = createStudentOfflineSetupRouter;
const express_1 = require("express");
const crypto_1 = require("crypto");
const suspension_predicate_1 = require("../security/suspension-predicate");
const offline_student_courses_1 = require("../lib/offline-student-courses");
const audit_log_1 = require("../services/audit-log");
const uuid = (x) => typeof x === 'string' && /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(x);
const exact = (x, keys) => !!x && typeof x === 'object' && !Array.isArray(x) && Object.keys(x).sort().join(',') === keys.slice().sort().join(',');
const digest = (x) => (0, crypto_1.createHash)('sha256').update(JSON.stringify(x)).digest('hex');
const text = (x) => typeof x === 'string' && !!x.trim() && x.length <= 255;
class Refusal extends Error {
    constructor(status, code) {
        super(code);
        this.status = status;
        this.code = code;
    }
}
function refuse(status, code) { throw new Refusal(status, code); }
function parseOfflineSetup(raw, apply = false) {
    if (!exact(raw, ['student_id', 'group_id', 'course_id', ...(apply ? ['review_token', 'operation_id', 'confirmed'] : [])]) || ![raw.student_id, raw.group_id, raw.course_id].every(uuid)
        || apply && (!uuid(raw.operation_id) || typeof raw.review_token !== 'string' || !/^[a-f\d]{64}$/.test(raw.review_token) || raw.confirmed !== true))
        refuse(400, 'OFFLINE_SETUP_INPUT');
    return { student_id: String(raw.student_id).toLowerCase(), group_id: String(raw.group_id).toLowerCase(), course_id: String(raw.course_id).toLowerCase(), ...apply ? { operation_id: String(raw.operation_id).toLowerCase(), review_token: String(raw.review_token), confirmed: true } : {} };
}
const ELIGIBLE = "s.user_id IS NULL AND s.group_id IS NULL AND s.branch_id IS NULL AND s.is_offline IN (0,1) AND s.is_active=1 AND (s.approval_status IS NULL OR s.approval_status='approved') AND (s.enrollment_status IS NULL OR s.enrollment_status='active') AND (s.enrollment_start_date IS NULL OR s.enrollment_start_date<=UTC_TIMESTAMP()) AND (s.enrollment_end_date IS NULL OR s.enrollment_end_date>UTC_TIMESTAMP())";
function createStudentOfflineSetupRouter(deps) {
    const router = (0, express_1.Router)();
    const handler = async (req, res) => {
        res.set('Cache-Control', 'no-store');
        const p = req.user;
        if (!p)
            return res.status(401).json({ code: 'SESSION_REQUIRED' });
        if (p.role === 'student' || p.identitySource === 'staff' || p.billingOnly || req.impersonation || req.headers['x-impersonation'] !== undefined)
            return res.status(403).json({ code: 'OFFLINE_SETUP_OWNER_REQUIRED' });
        if (!p.tenantId)
            return res.status(404).json({ code: 'OFFLINE_SETUP_NOT_FOUND' });
        const route = req.url.split('?')[0], applying = route === '/offline-setup/apply', preview = route === '/offline-setup/review', status = !!req.params.operationId, students = route === '/offline-setup/students';
        const tenant = p.tenantId, actor = p.id;
        let input = null;
        try {
            if (['x-tenant-id', 'x-student-id', 'x-enrollment-id', 'x-instructor-id'].some(k => req.headers[k] !== undefined))
                refuse(400, 'OFFLINE_SETUP_INPUT');
            if (preview || applying) {
                if (Object.keys(req.query).length)
                    refuse(400, 'OFFLINE_SETUP_INPUT');
                input = parseOfflineSetup(req.body, applying);
            }
            else if (req.body != null && !exact(req.body, []) || Object.keys(req.query).some(k => k !== 'cursor') || status && Object.keys(req.query).length || req.query.cursor !== undefined && !uuid(req.query.cursor) || status && !uuid(req.params.operationId))
                refuse(400, 'OFFLINE_SETUP_INPUT');
        }
        catch {
            return res.status(400).json({ code: 'OFFLINE_SETUP_INPUT' });
        }
        let c = null, started = false, commitAttempted = false, discard = false;
        try {
            c = await deps.getConnection();
            await c.beginTransaction();
            started = true;
            const conn = c;
            async function rows(sql, params = []) { const [r] = await conn.execute(sql, params); if (!Array.isArray(r))
                throw Error('Invalid rows'); return r; }
            const owners = await rows(`SELECT t.owner_user_id FROM tenants t JOIN users u ON u.id=t.owner_user_id WHERE t.id=? AND t.owner_user_id=? AND t.status='active' AND u.is_active=1 AND u.token_version=? AND NOT ${suspension_predicate_1.ACTIVE_SUSPENSION_PREDICATE_SQL.replace(/suspended_until/g, 'u.suspended_until')} LIMIT 1 FOR UPDATE`, [tenant, actor, p.tokenVersion ?? 0]);
            if (owners.length !== 1 || owners[0].owner_user_id !== actor)
                refuse(403, 'OFFLINE_SETUP_OWNER_REQUIRED');
            const engines = await rows("SELECT TABLE_NAME AS name,ENGINE AS engine FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN ('student_offline_setup_operations','students','student_courses','groups','courses','audit_events','audit_chain_head') LIMIT 7");
            if (!['student_offline_setup_operations', 'students', 'student_courses', 'groups', 'courses', 'audit_events', 'audit_chain_head'].every(t => engines.some(r => r.name === t && r.engine === 'InnoDB')))
                refuse(503, 'OFFLINE_SETUP_UNAVAILABLE');
            const columns = await rows("SELECT COLUMN_NAME AS name,DATA_TYPE AS type,CHARACTER_MAXIMUM_LENGTH AS len,IS_NULLABLE AS nullable,COLLATION_NAME AS collation FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='student_offline_setup_operations' LIMIT 9");
            const fields = { tenant_id: ['varchar', 64], operation_id: ['char', 36], actor_user_id: ['varchar', 64], student_id: ['char', 36], group_id: ['char', 36], course_id: ['char', 36], request_hash: ['char', 64] };
            if (!Object.entries(fields).every(([name, [type, len]]) => columns.some(r => r.name === name && r.type === type && Number(r.len) === len && r.nullable === 'NO' && r.collation === 'utf8mb4_bin')) || !columns.some(r => r.name === 'created_at' && r.type === 'timestamp' && r.nullable === 'NO'))
                refuse(503, 'OFFLINE_SETUP_UNAVAILABLE');
            const indexes = await rows("SELECT INDEX_NAME AS name,COLUMN_NAME AS col,SEQ_IN_INDEX AS seq FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='student_offline_setup_operations' AND NON_UNIQUE=0 ORDER BY INDEX_NAME,SEQ_IN_INDEX LIMIT 6");
            for (const [name, cols] of [['PRIMARY', ['tenant_id', 'operation_id']], ['uq_offline_setup_student', ['tenant_id', 'student_id']]]) {
                const found = indexes.filter(r => r.name === name);
                if (found.length !== cols.length || cols.some((col, i) => found[i].col !== col || Number(found[i].seq) !== i + 1))
                    refuse(503, 'OFFLINE_SETUP_UNAVAILABLE');
            }
            const operationId = status ? String(req.params.operationId).toLowerCase() : input?.operation_id;
            if (operationId) {
                const ops = await rows('SELECT operation_id,actor_user_id,student_id,group_id,course_id,request_hash FROM student_offline_setup_operations WHERE tenant_id=? AND operation_id=? LIMIT 2', [tenant, operationId]);
                if (ops.length > 1)
                    throw Error('Invalid receipt');
                if (ops[0]) {
                    const op = ops[0];
                    if (op.actor_user_id !== actor)
                        refuse(status ? 404 : 409, 'OFFLINE_SETUP_CONFLICT');
                    if (applying && op.request_hash !== digest(input))
                        refuse(409, 'OFFLINE_SETUP_CONFLICT');
                    if (![op.operation_id, op.student_id, op.group_id, op.course_id].every(uuid) || typeof op.request_hash !== 'string' || !/^[a-f\d]{64}$/.test(op.request_hash))
                        throw Error('Invalid receipt');
                    return res.json({ operation: { operation_id: op.operation_id, student_id: op.student_id, group_id: op.group_id, course_id: op.course_id, state: 'offline_configured' } });
                }
                if (status)
                    return res.json({ operation: null });
            }
            if (!preview && !applying) {
                const cursor = req.query.cursor ?? '';
                const list = students ? await rows(`SELECT s.id,s.name FROM students s WHERE s.tenant_id=? AND ${ELIGIBLE} AND (s.instructor_id IS NULL OR s.instructor_id=?) AND NOT EXISTS(SELECT 1 FROM student_courses sc WHERE sc.student_id=s.id) AND NOT EXISTS(SELECT 1 FROM student_offline_setup_operations op WHERE op.tenant_id=s.tenant_id AND op.student_id=s.id) AND s.id>? ORDER BY s.id LIMIT 26`, [tenant, actor, cursor]) : await rows("SELECT g.id,g.name,g.course_id,c.name AS course_name FROM `groups` g JOIN courses c ON c.id=g.course_id WHERE c.tenant_id=? AND c.is_active=1 AND g.is_active=1 AND g.branch_scope='tenant' AND g.branch_id IS NULL AND g.id>? ORDER BY g.id LIMIT 26", [tenant, cursor]);
                if (list.length > 26 || list.some(r => !uuid(r.id) || !text(r.name) || !students && (!uuid(r.course_id) || !text(r.course_name))) || new Set(list.map(r => r.id)).size !== list.length)
                    throw Error('Invalid page');
                return res.json({ items: list.slice(0, 25), next_cursor: list.length > 25 ? list[24].id : null });
            }
            const s = (await rows(`SELECT s.id,s.name,s.user_id,s.group_id,s.branch_id,s.is_offline,s.instructor_id,s.grade_id,UNIX_TIMESTAMP(s.updated_at) AS updated_epoch FROM students s WHERE s.id=? AND s.tenant_id=? AND ${ELIGIBLE} AND (s.instructor_id IS NULL OR s.instructor_id=?) LIMIT 1 FOR UPDATE`, [input.student_id, tenant, actor]))[0];
            if (!s)
                refuse(409, 'OFFLINE_SETUP_STUDENT_CHANGED');
            if (!uuid(s.id) || !text(s.name))
                throw Error('Invalid student');
            if ((await rows('SELECT course_id FROM student_courses WHERE student_id=? LIMIT 1 FOR UPDATE', [s.id])).length || (await rows('SELECT operation_id FROM student_offline_setup_operations WHERE tenant_id=? AND student_id=? LIMIT 1', [tenant, s.id])).length)
                refuse(409, 'OFFLINE_SETUP_STUDENT_CHANGED');
            const g = (await rows("SELECT g.id,g.name,g.course_id,g.grade_id,g.max_students,c.name AS course_name FROM `groups` g JOIN courses c ON c.id=g.course_id WHERE g.id=? AND c.id=? AND c.tenant_id=? AND c.is_active=1 AND g.is_active=1 AND g.branch_scope='tenant' AND g.branch_id IS NULL LIMIT 1 FOR UPDATE", [input.group_id, input.course_id, tenant]))[0];
            if (!g)
                refuse(404, 'OFFLINE_SETUP_GROUP_NOT_FOUND');
            if (!uuid(g.id) || !uuid(g.course_id) || !text(g.name) || !text(g.course_name) || !Number.isInteger(g.max_students) || g.max_students < 1 || g.max_students > 1000000)
                refuse(409, 'OFFLINE_SETUP_CAPACITY');
            if (s.grade_id !== null && g.grade_id !== null && s.grade_id !== g.grade_id)
                refuse(409, 'OFFLINE_SETUP_GRADE_CHANGED');
            const roster = await rows("SELECT id FROM students WHERE tenant_id=? AND group_id=? AND is_active=1 AND (approval_status IS NULL OR approval_status='approved') AND (enrollment_status IS NULL OR enrollment_status='active') AND (enrollment_start_date IS NULL OR enrollment_start_date<=UTC_TIMESTAMP()) AND (enrollment_end_date IS NULL OR enrollment_end_date>UTC_TIMESTAMP()) ORDER BY id LIMIT 501 FOR UPDATE", [tenant, g.id]);
            if (roster.length > 500 || new Set(roster.map(r => r.id)).size !== roster.length)
                refuse(503, 'OFFLINE_SETUP_UNAVAILABLE');
            if (roster.length >= g.max_students)
                refuse(409, 'OFFLINE_SETUP_CAPACITY');
            const review = { student: { id: s.id, name: s.name }, group: { id: g.id, name: g.name, capacity: g.max_students, active_enrollments: roster.length }, course: { id: g.course_id, name: g.course_name }, effect: 'offline_without_login' };
            const reviewToken = digest([tenant, actor, s, g, roster.map(r => r.id), review]);
            if (preview)
                return res.json({ ...review, review_token: reviewToken });
            if (input.review_token !== reviewToken)
                refuse(409, 'OFFLINE_SETUP_REVIEW_CHANGED');
            const [updated] = await conn.execute('UPDATE students SET is_offline=1,group_id=?,instructor_id=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND tenant_id=? AND user_id IS NULL AND group_id IS NULL AND branch_id IS NULL', [g.id, actor, s.id, tenant]);
            if (Number(updated.affectedRows) !== 1)
                throw Error('Student write not confirmed');
            const assigned = await (0, offline_student_courses_1.applyOfflineCourseSelection)(s.id, [g.course_id], (0, offline_student_courses_1.createTransactionEnrollmentSeam)(conn), { tenantId: tenant, isAdmin: false });
            if (!assigned.ok)
                refuse(assigned.status, 'OFFLINE_SETUP_COURSE_CHANGED');
            const linked = await rows('SELECT course_id,status FROM student_courses WHERE student_id=? LIMIT 2 FOR UPDATE', [s.id]);
            if (linked.length !== 1 || linked[0].course_id !== g.course_id || linked[0].status !== 'active')
                throw Error('Course assignment not confirmed');
            await (0, audit_log_1.recordSealedAuditEvent)({ query: rows, queryOne: async (sql, p) => (await rows(sql, p))[0] ?? null, execute: async (sql, p) => { const [r] = await conn.execute(sql, p); return { affectedRows: Number(r.affectedRows) }; } }, { actorUserId: actor, tenantId: tenant, action: 'student.offline_setup', resourceType: 'student', resourceId: s.id, newValue: { group_id: g.id, course_id: g.course_id, is_offline: true, account_created: false } });
            const [saved] = await conn.execute('INSERT INTO student_offline_setup_operations (tenant_id,operation_id,actor_user_id,student_id,group_id,course_id,request_hash) VALUES (?,?,?,?,?,?,?)', [tenant, operationId, actor, s.id, g.id, g.course_id, digest(input)]);
            if (Number(saved.affectedRows) !== 1)
                throw Error('Receipt not confirmed');
            commitAttempted = true;
            await conn.commit();
            return res.status(201).json({ operation: { operation_id: operationId, student_id: s.id, group_id: g.id, course_id: g.course_id, state: 'offline_configured' } });
        }
        catch (e) {
            if (commitAttempted) {
                discard = true;
                return res.status(500).json({ code: 'PERSISTENCE_UNCERTAIN' });
            }
            if (e instanceof Refusal)
                return res.status(e.status).json({ code: e.code });
            discard = true;
            return res.status(503).json({ code: 'OFFLINE_SETUP_UNAVAILABLE' });
        }
        finally {
            if (c) {
                if (started && !commitAttempted)
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
    router.get('/offline-setup/students', handler);
    router.get('/offline-setup/groups', handler);
    router.get('/offline-setup/operations/:operationId', handler);
    router.post('/offline-setup/review', handler);
    router.post('/offline-setup/apply', handler);
    return router;
}
