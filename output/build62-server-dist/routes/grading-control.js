"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createGradingControlRouter = createGradingControlRouter;
const express_1 = require("express");
const node_crypto_1 = require("node:crypto");
const grading_authority_1 = require("../services/grading-authority");
const grading_delegation_1 = require("../services/grading-delegation");
const suspension_predicate_1 = require("../security/suspension-predicate");
const audit_log_1 = require("../services/audit-log");
const gradebook_1 = require("../services/gradebook");
const exam_grading_1 = require("../services/exam-grading");
const grading_projection_1 = require("../services/grading-projection");
const question_grading_1 = require("./question-grading");
// These binary keys have one spelling: case aliases must not create two grants.
const uuid = (x) => typeof x === 'string' && /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/.test(x);
const exact = (x, keys) => x && typeof x === 'object' && !Array.isArray(x) && Object.keys(x).sort().join(',') === [...keys].sort().join(',');
const hash = (x) => (0, node_crypto_1.createHash)('sha256').update(JSON.stringify(x)).digest('hex');
const version = (x) => Number.isSafeInteger(x) && x >= 0 && x <= 2147483647;
const live = (alias) => `NOT ${suspension_predicate_1.ACTIVE_SUSPENSION_PREDICATE_SQL.replace(/suspended_until/g, alias + '.suspended_until')}`;
const sqlConnection = (c) => ({ query: async (s, p = []) => {
        const [r] = await c.execute(s, [...p]);
        if (!Array.isArray(r))
            throw Error('Invalid rows');
        return r;
    }, execute: async (s, p = []) => { const [r] = await c.execute(s, [...p]); return r; } });
class Refusal extends Error {
    constructor(status, code) {
        super(code);
        this.status = status;
        this.code = code;
    }
}
function deny(status, code) { throw new Refusal(status, code); }
function createGradingControlRouter(deps) {
    const router = (0, express_1.Router)();
    const handle = async (req, res) => {
        res.set('Cache-Control', 'no-store');
        res.set('Vary', 'Authorization');
        if (!req.user)
            return res.status(401).json({ code: 'SESSION_REQUIRED' });
        if (req.impersonation || ['x-tenant-id', 'x-instructor-id', 'x-student-id', 'x-impersonation'].some(k => req.headers[k] !== undefined))
            return res.status(403).json({ code: 'GRADING_TEACHER_REQUIRED' });
        if (Object.values(req.params).filter(x => x !== undefined).some(x => !uuid(x)) || Object.keys(req.query).some(k => k !== 'after') || req.query.after !== undefined && !uuid(req.query.after))
            return res.status(400).json({ code: 'GRADING_INPUT' });
        const writing = req.method === 'POST', b = req.body;
        if (!writing && b != null && !exact(b, []))
            return res.status(400).json({ code: 'GRADING_INPUT' });
        if (writing && (!uuid(b?.operation_id) || Object.keys(req.query).length))
            return res.status(400).json({ code: 'GRADING_INPUT' });
        let connection = null, open = false, committing = false, reusable = true;
        try {
            connection = await deps.getConnection();
            await connection.beginTransaction();
            open = true;
            const c = sqlConnection(connection), actor = req.user;
            if (!req.params.questionRef && !req.params.attemptId && !req.params.versionId && !req.params.operationId)
                return res.json(await (0, grading_delegation_1.listGradingAssignments)(c, actor, req.query.after));
            const tenant = await (0, grading_authority_1.proveGradingIdentity)(c, actor);
            await (0, grading_delegation_1.gradingDelegationReady)(c);
            if (req.params.operationId) {
                const ops = await c.query('SELECT actor_user_id,course_id,result FROM exam_grading_control_operations WHERE tenant_id=? AND operation_id=? LIMIT 1', [tenant, req.params.operationId]);
                if (!ops.length)
                    return res.json({ receipt: null });
                if (ops[0].actor_user_id !== actor.id)
                    deny(404, 'GRADING_NOT_FOUND');
                await (0, grading_authority_1.proveGradingCourse)(c, actor, ops[0].course_id);
                return res.json({ receipt: decode(ops[0].result, req.params.operationId) });
            }
            const resource = req.params.versionId ? await c.query("SELECT c.id AS course_id FROM exam_versions v JOIN exams e ON e.id=v.exam_id JOIN courses c ON c.id=e.course_id AND c.tenant_id=v.tenant_id WHERE v.id=? AND v.tenant_id=? AND v.status='published' AND c.instructor_id=? AND c.is_active=1 LIMIT 1 FOR UPDATE", [req.params.versionId, tenant, actor.id]) : req.params.questionRef ?
                await c.query("SELECT c.id AS course_id,q.points FROM exam_version_questions q JOIN exam_versions v ON v.id=q.exam_version_id AND v.tenant_id=q.tenant_id AND v.status='published' JOIN exams e ON e.id=v.exam_id JOIN courses c ON c.id=e.course_id AND c.tenant_id=q.tenant_id WHERE q.id=? AND q.tenant_id=? AND c.instructor_id=? AND c.is_active=1 AND q.question_type='essay' LIMIT 1 FOR UPDATE", [req.params.questionRef, tenant, actor.id]) :
                await c.query('SELECT c.id AS course_id FROM exam_versioned_attempts a JOIN exams e ON e.id=a.exam_id JOIN courses c ON c.id=e.course_id AND c.tenant_id=a.tenant_id WHERE a.id=? AND a.tenant_id=? AND c.instructor_id=? AND c.is_active=1 LIMIT 1 FOR UPDATE', [req.params.attemptId, tenant, actor.id]);
            if (resource.length !== 1)
                deny(404, 'GRADING_NOT_FOUND');
            const courseId = resource[0].course_id;
            if (req.params.versionId) {
                const rows = await c.query("SELECT a.id,a.score,a.version,s.name AS student_name,DATE_FORMAT(a.graded_at,'%Y-%m-%dT%H:%i:%s.000Z') AS graded_at FROM exam_versioned_attempts a LEFT JOIN students s ON s.id=a.student_enrollment_id AND s.tenant_id=a.tenant_id WHERE a.tenant_id=? AND a.exam_version_id=? AND a.status='graded' AND a.manual_required=1 AND a.id>? ORDER BY a.id LIMIT 26", [tenant, req.params.versionId, req.query.after ?? '']);
                return res.json({ items: rows.slice(0, 25).map(r => ({ ...r, score: String(r.score), version: Number(r.version) })), next_cursor: rows.length > 25 ? rows[24].id : null });
            }
            const requestHash = writing ? hash([req.path.replace(/\/$/, ''), b]) : null;
            if (writing) {
                const old = await c.query('SELECT actor_user_id,course_id,request_hash,result FROM exam_grading_control_operations WHERE tenant_id=? AND operation_id=? LIMIT 1', [tenant, b.operation_id]);
                if (old.length) {
                    if (old[0].actor_user_id !== actor.id || old[0].course_id !== courseId || old[0].request_hash !== requestHash)
                        deny(409, 'GRADING_OPERATION_CONFLICT');
                    return res.json({ receipt: decode(old[0].result, b.operation_id) });
                }
            }
            const audit = async (action, id, oldValue, newValue) => (0, audit_log_1.recordSealedAuditEvent)({ query: (s, p) => c.query(s, p), queryOne: async (s, p) => (await c.query(s, p))[0] ?? null, execute: async (s, p) => { const r = await c.execute(s, p); return { affectedRows: Number(r.affectedRows) }; } }, { actorUserId: actor.id, tenantId: tenant, action, resourceType: 'exam_grading', resourceId: id, oldValue, newValue });
            let result;
            if (req.params.questionRef) {
                const rows = await c.query('SELECT id,assignee_user_id,rubric_id,status,version,responsible_user_id FROM exam_grading_assignments WHERE tenant_id=? AND question_ref=? LIMIT 1 FOR UPDATE', [tenant, req.params.questionRef]), old = rows[0] ?? null;
                if (!writing) {
                    const candidates = await c.query(`SELECT u.id,u.name FROM users u JOIN tenant_memberships m ON m.user_id=u.id AND m.tenant_id=? AND m.status='active' AND m.role_key IN ('owner','instructor') WHERE u.is_active=1 AND u.role IN ('teacher','instructor') AND u.center_account=0 AND NOT EXISTS (SELECT 1 FROM admin_user_roles platform_role WHERE platform_role.user_id=u.id) AND ${live('u')} ORDER BY u.id LIMIT 101`, [tenant]);
                    if (candidates.length > 100)
                        deny(503, 'GRADING_CANDIDATE_CAP');
                    const rubrics = await c.query('SELECT id,revision FROM exam_grading_rubrics WHERE tenant_id=? AND question_ref=? ORDER BY revision DESC LIMIT 20', [tenant, req.params.questionRef]);
                    return res.json({ assignment: old ? { id: old.id, assignee_user_id: old.assignee_user_id, rubric_id: old.rubric_id, status: old.status, version: Number(old.version), authority_current: old.responsible_user_id === actor.id && old.status === 'active' } : null, candidates, rubrics: rubrics.map(r => ({ id: r.id, revision: Number(r.revision) })) });
                }
                const revoke = req.path.endsWith('/revoke');
                if (!exact(b, revoke ? ['operation_id', 'expected_version'] : ['operation_id', 'expected_version', 'assignee_user_id', 'rubric_id']) || !(b.expected_version === null || version(b.expected_version)))
                    deny(400, 'GRADING_INPUT');
                if (old ? Number(old.version) !== b.expected_version || Number(old.version) >= 2147483647 : b.expected_version !== null)
                    deny(409, 'GRADING_ASSIGNMENT_STALE');
                if (revoke) {
                    if (!old || old.status !== 'active')
                        deny(409, 'GRADING_ASSIGNMENT_STALE');
                    const changed = await c.execute("UPDATE exam_grading_assignments SET status='revoked',version=version+1 WHERE id=? AND version=?", [old.id, old.version]);
                    if (Number(changed.affectedRows) !== 1)
                        throw Error('Assignment revoke not confirmed');
                    result = { operation_id: b.operation_id, kind: 'assignment.revoked', question_ref: req.params.questionRef, resource_id: old.id, version: Number(old.version) + 1 };
                }
                else {
                    if (!uuid(b.assignee_user_id) || !uuid(b.rubric_id))
                        deny(400, 'GRADING_INPUT');
                    const target = await c.query(`SELECT u.id FROM users u JOIN tenant_memberships m ON m.user_id=u.id AND m.tenant_id=? AND m.status='active' AND m.role_key IN ('owner','instructor') WHERE u.id=? AND u.is_active=1 AND u.role IN ('teacher','instructor') AND u.center_account=0 AND NOT EXISTS (SELECT 1 FROM admin_user_roles platform_role WHERE platform_role.user_id=u.id) AND ${live('u')} LIMIT 1 FOR UPDATE`, [tenant, b.assignee_user_id]);
                    if (target.length !== 1)
                        deny(404, 'GRADING_ASSIGNEE_NOT_FOUND');
                    const rubric = await c.query('SELECT id FROM exam_grading_rubrics WHERE id=? AND tenant_id=? AND question_ref=? LIMIT 1 FOR UPDATE', [b.rubric_id, tenant, req.params.questionRef]);
                    if (rubric.length !== 1)
                        deny(404, 'GRADING_RUBRIC_NOT_FOUND');
                    const id = old?.id ?? (0, node_crypto_1.randomUUID)(), v = old ? Number(old.version) + 1 : 0;
                    let changed;
                    if (old)
                        changed = await c.execute("UPDATE exam_grading_assignments SET assignee_user_id=?,rubric_id=?,responsible_user_id=?,status='active',version=? WHERE id=? AND version=?", [b.assignee_user_id, b.rubric_id, actor.id, v, id, old.version]);
                    else
                        changed = await c.execute("INSERT INTO exam_grading_assignments(id,tenant_id,question_ref,assignee_user_id,rubric_id,responsible_user_id,status,version) VALUES(?,?,?,?,?,?,'active',0)", [id, tenant, req.params.questionRef, b.assignee_user_id, b.rubric_id, actor.id]);
                    if (Number(changed.affectedRows) !== 1)
                        throw Error('Assignment not confirmed');
                    result = { operation_id: b.operation_id, kind: 'assignment.saved', question_ref: req.params.questionRef, resource_id: id, version: v };
                }
                await audit('exam.' + result.kind, result.resource_id, old, { ...result, responsible_user_id: actor.id, assignee_user_id: revoke ? old.assignee_user_id : b.assignee_user_id, rubric_id: revoke ? old.rubric_id : b.rubric_id });
            }
            else {
                const preview = await reopenPreview(c, tenant, req.params.attemptId);
                if (!writing)
                    return res.json(preview.public);
                if (!exact(b, ['operation_id', 'expected_version', 'review_token', 'reason']) || !version(b.expected_version) || typeof b.reason !== 'string' || !b.reason.trim() || b.reason.length > 1000 || typeof b.review_token !== 'string')
                    deny(400, 'GRADING_INPUT');
                if (preview.public.version !== b.expected_version || preview.public.review_token !== b.review_token)
                    deny(409, 'GRADING_REOPEN_STALE');
                const a = preview.attempt;
                const changed = await c.execute("UPDATE exam_versioned_attempts SET status='pending_review',score=NULL,passed=NULL,reviewer_user_id=NULL,graded_at=NULL,version=version+1 WHERE id=? AND tenant_id=? AND status='graded' AND version=?", [a.id, tenant, b.expected_version]);
                if (Number(changed.affectedRows) !== 1)
                    deny(409, 'GRADING_REOPEN_STALE');
                if (preview.grade) {
                    const removed = await c.execute('DELETE FROM gradebook_scores WHERE id=? AND tenant_id=?', [preview.grade.id, tenant]);
                    if (Number(removed.affectedRows) !== 1)
                        throw Error('Gradebook withdrawal not confirmed');
                }
                result = { operation_id: b.operation_id, kind: 'attempt.reopened', resource_id: a.id, version: b.expected_version + 1, old_score: String(a.score), gradebook_withdrawn: !!preview.grade };
                await audit('exam.manual_reopen', a.id, { status: 'graded', version: a.version, score: String(a.score), passed: a.passed, reviewer_user_id: a.reviewer_user_id, graded_at: a.graded_at, gradebook: preview.grade }, { status: 'pending_review', version: result.version, score: null, reason: b.reason.trim(), gradebook_withdrawn: result.gradebook_withdrawn });
            }
            const receipt = await c.execute('INSERT INTO exam_grading_control_operations(tenant_id,operation_id,actor_user_id,course_id,request_hash,result) VALUES(?,?,?,?,?,?)', [tenant, b.operation_id, actor.id, courseId, requestHash, JSON.stringify(result)]);
            if (Number(receipt.affectedRows) !== 1)
                throw Error('Grading receipt not confirmed');
            committing = true;
            await connection.commit();
            open = false;
            return res.status(201).json({ receipt: result });
        }
        catch (e) {
            if (committing)
                reusable = false;
            return res.status(e instanceof Refusal ? e.status : e instanceof grading_authority_1.GradingAuthorityDenied ? e.status : 503).json({ code: e instanceof Refusal ? e.code : e instanceof grading_authority_1.GradingAuthorityDenied ? e.message : 'GRADING_CONTROL_UNAVAILABLE' });
        }
        finally {
            if (connection) {
                if (open)
                    try {
                        await connection.rollback();
                    }
                    catch {
                        reusable = false;
                    }
                if (reusable)
                    connection.release();
                else
                    connection.destroy();
            }
        }
    };
    router.get(['/grading/questions/:questionRef/assignment', '/grading/attempts/:attemptId/reopen-preview', '/grading/control-operations/:operationId', '/grading/versions/:versionId/finalized', '/grading-work/assignments'], handle);
    router.post(['/grading/questions/:questionRef/assignment', '/grading/questions/:questionRef/assignment/revoke', '/grading/attempts/:attemptId/reopen'], handle);
    router.use('/grading-work/:assignmentId', (req, res, next) => {
        if (!uuid(req.params.assignmentId) || !/^\/(?:questions\/[a-f\d-]{36}\/answers|attempts\/[a-f\d-]{36}\/grade|operations\/[a-f\d-]{36})(?:\?.*)?$/i.test(req.url))
            return res.status(404).json({ code: 'GRADING_ASSIGNMENT_ONLY' });
        return (0, question_grading_1.createQuestionGradingRouter)({ ...deps, assignmentId: req.params.assignmentId })(req, res, next);
    });
    return router;
}
function decode(raw, operationId) {
    const r = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const keys = r?.kind === 'attempt.reopened' ? ['operation_id', 'kind', 'resource_id', 'version', 'old_score', 'gradebook_withdrawn'] : ['operation_id', 'kind', 'question_ref', 'resource_id', 'version'];
    if (!exact(r, keys) || r.operation_id !== operationId || !['assignment.saved', 'assignment.revoked', 'attempt.reopened'].includes(r.kind) || !uuid(r.resource_id) || !version(r.version) || r.kind !== 'attempt.reopened' && !uuid(r.question_ref) || r.kind === 'attempt.reopened' && (typeof r.old_score !== 'string' || (0, exam_grading_1.toHundredths)(r.old_score) === null || typeof r.gradebook_withdrawn !== 'boolean'))
        throw Error('Invalid control receipt');
    return r;
}
async function reopenPreview(c, tenant, id) {
    const tables = await c.query("SELECT TABLE_NAME AS name,ENGINE AS engine FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN ('gradebook_scores','exam_versioned_attempts','exam_manual_operations','audit_events','audit_chain_head') LIMIT 5");
    if (tables.length !== 5 || tables.some(t => t.engine !== 'InnoDB'))
        throw Error('Reopen transaction unavailable');
    const ix = await c.query("SELECT COLUMN_NAME AS col,SEQ_IN_INDEX AS seq FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='exam_versioned_attempts' AND INDEX_NAME='uq_exam_attempt_student' AND NON_UNIQUE=0 ORDER BY SEQ_IN_INDEX LIMIT 3");
    if (ix.length !== 2 || ix[0].col !== 'exam_id' || ix[1].col !== 'student_enrollment_id')
        throw Error('Attempt projection identity unavailable');
    const rows = await c.query("SELECT a.id,a.exam_id,a.student_enrollment_id,a.status,a.score,a.passed,a.version,a.reviewer_user_id,DATE_FORMAT(a.graded_at,'%Y-%m-%dT%H:%i:%s.000Z') AS graded_at,v.total_points,e.course_id FROM exam_versioned_attempts a JOIN exam_versions v ON v.id=a.exam_version_id AND v.exam_id=a.exam_id AND v.tenant_id=a.tenant_id AND v.status='published' JOIN exams e ON e.id=a.exam_id WHERE a.id=? AND a.tenant_id=? AND a.manual_required=1 LIMIT 1 FOR UPDATE", [id, tenant]);
    const a = rows[0];
    if (rows.length !== 1 || a.status !== 'graded' || (!version(Number(a.version)) || Number(a.version) >= 2147483647) || (0, exam_grading_1.toHundredths)(a.score) === null)
        deny(409, 'GRADING_REOPEN_STATE');
    const operations = await c.query(`SELECT operation_id,actor_user_id,result FROM exam_manual_operations WHERE tenant_id=? AND attempt_id=? AND JSON_UNQUOTE(JSON_EXTRACT(result,'$.kind'))='finalize' AND CAST(JSON_UNQUOTE(JSON_EXTRACT(result,'$.attempt_version')) AS UNSIGNED)=? LIMIT 2`, [tenant, id, a.version]);
    if (operations.length !== 1)
        deny(409, 'GRADING_REOPEN_PROJECTION_UNPROVEN');
    const final = typeof operations[0].result === 'string' ? JSON.parse(operations[0].result) : operations[0].result;
    if (operations[0].actor_user_id !== a.reviewer_user_id || final.kind !== 'finalize' || final.attempt_id !== id || (0, exam_grading_1.toHundredths)(final.score) !== (0, exam_grading_1.toHundredths)(a.score) || typeof final.gradebook_linked !== 'boolean')
        deny(409, 'GRADING_REOPEN_PROJECTION_UNPROVEN');
    const scoreId = (0, gradebook_1.deterministicScoreId)({ tenantId: tenant, enrollmentId: a.student_enrollment_id, courseId: a.course_id, itemType: 'exam', itemId: a.exam_id });
    if (!scoreId)
        throw Error('Projection ID unavailable');
    const grades = await c.query("SELECT id,student_enrollment_id,course_id,item_type,item_id,category_id,weight,score,max_score,recorded_by,DATE_FORMAT(recorded_at,'%Y-%m-%dT%H:%i:%s.000Z') AS recorded_at FROM gradebook_scores WHERE id=? AND tenant_id=? LIMIT 1 FOR UPDATE", [scoreId, tenant]);
    const grade = grades[0] ?? null;
    if (final.gradebook_linked !== !!grade || grade && (grade.student_enrollment_id !== a.student_enrollment_id || grade.course_id !== a.course_id || grade.item_type !== 'exam' || grade.item_id !== a.exam_id || grade.category_id !== null || grade.weight !== null || (0, grading_projection_1.projectionHundredths)(grade.score) !== (0, exam_grading_1.toHundredths)(a.score) || (0, grading_projection_1.projectionHundredths)(grade.max_score) !== (0, exam_grading_1.toHundredths)(a.total_points) || grade.recorded_by !== a.reviewer_user_id))
        deny(409, 'GRADING_REOPEN_PROJECTION_CHANGED');
    const token = hash([a, grade, operations[0].operation_id]);
    return { attempt: a, grade, public: { attempt_id: id, version: Number(a.version), old_score: String(a.score), gradebook_will_withdraw: !!grade, review_token: token } };
}
