"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.gradingDelegationReady = gradingDelegationReady;
exports.proveGradingAssignment = proveGradingAssignment;
exports.assignedRubricPoints = assignedRubricPoints;
const grading_authority_1 = require("./grading-authority");
const grading_rubric_1 = require("./grading-rubric");
const suspension_predicate_1 = require("../security/suspension-predicate");
async function gradingDelegationReady(c) {
    const names = ['exam_grading_assignments', 'exam_rubric_awards', 'exam_grading_control_operations', 'exam_grading_rubrics', 'users', 'tenants', 'tenant_memberships', 'courses', 'exam_version_questions', 'exam_versions', 'exams', 'audit_events', 'audit_chain_head'];
    const rows = await c.query(`SELECT TABLE_NAME AS name,ENGINE AS engine FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN (${names.map(() => '?').join(',')}) LIMIT 13`, names);
    if (!names.every(n => rows.some(r => r.name === n && r.engine === 'InnoDB')))
        throw Error('Grading assignment schema unavailable');
    const cols = await c.query("SELECT TABLE_NAME AS name,COLUMN_NAME AS col,DATA_TYPE AS kind FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND ((TABLE_NAME='exam_rubric_awards' AND COLUMN_NAME='marks') OR (TABLE_NAME='exam_grading_control_operations' AND COLUMN_NAME='result') OR (TABLE_NAME='exam_grading_assignments' AND COLUMN_NAME='responsible_user_id')) LIMIT 3");
    if (cols.length !== 3 || !['exam_rubric_awards', 'exam_grading_control_operations'].every(n => cols.some(c => c.name === n && c.kind === 'json')) || !cols.some(c => c.name === 'exam_grading_assignments' && c.col === 'responsible_user_id' && c.kind === 'varchar'))
        throw Error('Grading assignment JSON unavailable');
    const ix = await c.query("SELECT TABLE_NAME AS name,INDEX_NAME AS ix,COLUMN_NAME AS col,SEQ_IN_INDEX AS seq FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN ('exam_grading_assignments','exam_rubric_awards','exam_grading_control_operations') AND NON_UNIQUE=0 ORDER BY TABLE_NAME,INDEX_NAME,SEQ_IN_INDEX LIMIT 20");
    for (const [table, keys] of [['exam_grading_assignments', ['id']], ['exam_grading_assignments', ['tenant_id', 'question_ref']], ['exam_rubric_awards', ['tenant_id', 'attempt_id', 'question_ref', 'revision']], ['exam_grading_control_operations', ['tenant_id', 'operation_id']]]) {
        if (!ix.some(i => i.name === table && Number(i.seq) === 1 && (() => { const parts = ix.filter(p => p.name === table && p.ix === i.ix); return parts.length === keys.length && keys.every((k, n) => parts[n].col === k && Number(parts[n].seq) === n + 1); })()))
            throw Error('Grading assignment index unavailable');
    }
}
async function proveGradingAssignment(c, actor, id) {
    const tenant = await (0, grading_authority_1.proveGradingIdentity)(c, actor);
    await gradingDelegationReady(c);
    const rows = await c.query(`SELECT a.id,a.question_ref,a.version,a.rubric_id,q.exam_version_id,q.points,r.criteria,r.total_points,c.instructor_id FROM exam_grading_assignments a JOIN exam_version_questions q ON q.id=a.question_ref AND q.tenant_id=a.tenant_id AND q.question_type='essay' JOIN exam_versions v ON v.id=q.exam_version_id AND v.tenant_id=q.tenant_id AND v.status='published' JOIN exams e ON e.id=v.exam_id JOIN courses c ON c.id=e.course_id AND c.tenant_id=a.tenant_id AND c.is_active=1 AND a.responsible_user_id=c.instructor_id JOIN users responsible ON responsible.id=c.instructor_id AND responsible.is_active=1 AND responsible.role IN ('teacher','instructor') AND responsible.center_account=0 AND NOT EXISTS (SELECT 1 FROM admin_user_roles platform_role WHERE platform_role.user_id=responsible.id) JOIN tenant_memberships tm ON tm.user_id=responsible.id AND tm.tenant_id=a.tenant_id AND tm.status='active' AND tm.role_key IN ('owner','instructor') JOIN exam_grading_rubrics r ON r.id=a.rubric_id AND r.tenant_id=a.tenant_id AND r.question_ref=q.id WHERE a.id=? AND a.tenant_id=? AND a.assignee_user_id=? AND a.status='active' LIMIT 1 FOR UPDATE`, [id, tenant, actor.id]);
    if (rows.length !== 1)
        throw new grading_authority_1.GradingAuthorityDenied(404);
    const r = rows[0];
    // The responsible teacher must still be live; suspension never delegates authority.
    const live = await c.query(`SELECT 1 AS ok FROM users WHERE id=? AND NOT ${suspension_predicate_1.ACTIVE_SUSPENSION_PREDICATE_SQL} LIMIT 1 FOR UPDATE`, [r.instructor_id]);
    if (live.length !== 1)
        throw new grading_authority_1.GradingAuthorityDenied(404);
    const rubric = (0, grading_rubric_1.parseGradingRubric)(typeof r.criteria === 'string' ? JSON.parse(r.criteria) : r.criteria, String(r.points));
    if (rubric.total_points !== Number(r.total_points).toFixed(2) || !Number.isSafeInteger(Number(r.version)))
        throw Error('Invalid assigned rubric');
    return { id: r.id, tenantId: tenant, questionRef: r.question_ref, versionId: r.exam_version_id, teacherId: r.instructor_id, version: Number(r.version), rubricId: r.rubric_id, rubric };
}
function assignedRubricPoints(scope, body) {
    if (body.assignment_version !== scope.version || body.question_ref !== scope.questionRef)
        throw new grading_authority_1.GradingAuthorityDenied(409);
    return (0, grading_rubric_1.scoreGradingRubric)(scope.rubric, body.marks);
}
