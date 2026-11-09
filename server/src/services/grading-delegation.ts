import type { AuthRequest } from '../middleware/auth';
import type { ExamGradingSqlConnection } from './exam-manual-grading-sql';
import { proveGradingIdentity, GradingAuthorityDenied } from './grading-authority';
import { parseGradingRubric, scoreGradingRubric } from './grading-rubric';
import { ACTIVE_SUSPENSION_PREDICATE_SQL } from '../security/suspension-predicate';
export interface GradingAssignmentScope {
    id: string;
    tenantId: string;
    questionRef: string;
    versionId: string;
    teacherId: string;
    version: number;
    rubricId: string;
    rubric: ReturnType<typeof parseGradingRubric>;
}
export async function gradingDelegationReady(c: ExamGradingSqlConnection) {
    const names = ['exam_grading_assignments', 'exam_rubric_awards', 'exam_grading_control_operations', 'exam_grading_rubrics', 'users', 'tenants', 'tenant_memberships', 'courses', 'exam_version_questions', 'exam_versions', 'exams', 'audit_events', 'audit_chain_head'];
    const rows = await c.query<{
        name: string;
        engine: string;
    }>(`SELECT TABLE_NAME AS name,ENGINE AS engine FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN (${names.map(() => '?').join(',')}) LIMIT 13`, names);
    if (!names.every(n => rows.some(r => r.name === n && r.engine === 'InnoDB')))
        throw Error('Grading assignment schema unavailable');
    const cols = await c.query<{
        name: string;
        col: string;
        kind: string;
    }>("SELECT TABLE_NAME AS name,COLUMN_NAME AS col,DATA_TYPE AS kind FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND ((TABLE_NAME='exam_rubric_awards' AND COLUMN_NAME='marks') OR (TABLE_NAME='exam_grading_control_operations' AND COLUMN_NAME='result') OR (TABLE_NAME='exam_grading_assignments' AND COLUMN_NAME='responsible_user_id')) LIMIT 3");
    if (cols.length !== 3 || !['exam_rubric_awards', 'exam_grading_control_operations'].every(n => cols.some(c => c.name === n && c.kind === 'json')) || !cols.some(c => c.name === 'exam_grading_assignments' && c.col === 'responsible_user_id' && c.kind === 'varchar'))
        throw Error('Grading assignment JSON unavailable');
    const ix = await c.query<{
        name: string;
        ix: string;
        col: string;
        seq: number;
    }>("SELECT TABLE_NAME AS name,INDEX_NAME AS ix,COLUMN_NAME AS col,SEQ_IN_INDEX AS seq FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN ('exam_grading_assignments','exam_rubric_awards','exam_grading_control_operations') AND NON_UNIQUE=0 ORDER BY TABLE_NAME,INDEX_NAME,SEQ_IN_INDEX LIMIT 20");
    for (const [table, keys] of [['exam_grading_assignments', ['id']], ['exam_grading_assignments', ['tenant_id', 'question_ref']], ['exam_rubric_awards', ['tenant_id', 'attempt_id', 'question_ref', 'revision']], ['exam_grading_control_operations', ['tenant_id', 'operation_id']]] as const) {
        if (!ix.some(i => i.name === table && Number(i.seq) === 1 && (() => { const parts = ix.filter(p => p.name === table && p.ix === i.ix); return parts.length === keys.length && keys.every((k, n) => parts[n].col === k && Number(parts[n].seq) === n + 1); })()))
            throw Error('Grading assignment index unavailable');
    }
}
export async function proveGradingAssignment(c: ExamGradingSqlConnection, actor: NonNullable<AuthRequest['user']>, id: string): Promise<GradingAssignmentScope> {
    const tenant = await proveGradingIdentity(c, actor);
    await gradingDelegationReady(c);
    return proveScopedAssignment(c, actor, tenant, id);
}

/** Private: caller holds the live actor/tenant locks and readiness proof in THIS transaction. */
async function proveScopedAssignment(c: ExamGradingSqlConnection, actor: NonNullable<AuthRequest['user']>, tenant: string, id: string): Promise<GradingAssignmentScope> {
    const rows = await c.query<any>(`SELECT a.id,a.question_ref,a.version,a.rubric_id,q.exam_version_id,q.points,r.criteria,r.total_points,c.instructor_id FROM exam_grading_assignments a JOIN exam_version_questions q ON q.id=a.question_ref AND q.tenant_id=a.tenant_id AND q.question_type='essay' JOIN exam_versions v ON v.id=q.exam_version_id AND v.tenant_id=q.tenant_id AND v.status='published' JOIN exams e ON e.id=v.exam_id JOIN courses c ON c.id=e.course_id AND c.tenant_id=a.tenant_id AND c.is_active=1 AND a.responsible_user_id=c.instructor_id JOIN users responsible ON responsible.id=c.instructor_id AND responsible.is_active=1 AND responsible.role IN ('teacher','instructor') AND responsible.center_account=0 AND NOT EXISTS (SELECT 1 FROM admin_user_roles platform_role WHERE platform_role.user_id=responsible.id) JOIN tenant_memberships tm ON tm.user_id=responsible.id AND tm.tenant_id=a.tenant_id AND tm.status='active' AND tm.role_key IN ('owner','instructor') JOIN exam_grading_rubrics r ON r.id=a.rubric_id AND r.tenant_id=a.tenant_id AND r.question_ref=q.id WHERE a.id=? AND a.tenant_id=? AND a.assignee_user_id=? AND a.status='active' LIMIT 1 FOR UPDATE`, [id, tenant, actor.id]);
    if (rows.length !== 1)
        throw new GradingAuthorityDenied(404);
    const r = rows[0];
    // The responsible teacher must still be live; suspension never delegates authority.
    const live = await c.query<{
        ok: number;
    }>(`SELECT 1 AS ok FROM users WHERE id=? AND NOT ${ACTIVE_SUSPENSION_PREDICATE_SQL} LIMIT 1 FOR UPDATE`, [r.instructor_id]);
    if (live.length !== 1)
        throw new GradingAuthorityDenied(404);
    const rubric = parseGradingRubric(typeof r.criteria === 'string' ? JSON.parse(r.criteria) : r.criteria, String(r.points));
    if (rubric.total_points !== Number(r.total_points).toFixed(2) || !Number.isSafeInteger(Number(r.version)))
        throw Error('Invalid assigned rubric');
    return { id: r.id, tenantId: tenant, questionRef: r.question_ref, versionId: r.exam_version_id, teacherId: r.instructor_id, version: Number(r.version), rubricId: r.rubric_id, rubric };
}

/** Request-local proof reuse only. No cached identities, resource scopes or readiness across requests. */
export async function listGradingAssignments(c: ExamGradingSqlConnection, actor: NonNullable<AuthRequest['user']>, after = '') {
    const tenant = await proveGradingIdentity(c, actor);
    await gradingDelegationReady(c);
    const rows = await c.query<{ id: string }>("SELECT id FROM exam_grading_assignments WHERE tenant_id=? AND assignee_user_id=? AND status='active' AND id>? ORDER BY id LIMIT 26", [tenant, actor.id, after]);
    const uuid = (x: unknown): x is string => typeof x === 'string' && /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/.test(x);
    if (rows.length > 26 || rows.some((r, i) => !uuid(r.id) || r.id <= (i ? rows[i - 1].id : after)))
        throw Error('Invalid assignment discovery');
    const assignments = [];
    for (const row of rows.slice(0, 25)) {
        try {
            const scope = await proveScopedAssignment(c, actor, tenant, row.id);
            const q = await c.query<{ label: string }>('SELECT LEFT(question_text,180) AS label FROM exam_version_questions WHERE id=? AND tenant_id=? LIMIT 1', [scope.questionRef, tenant]);
            if (q.length !== 1 || typeof q[0].label !== 'string' || !q[0].label.trim() || q[0].label.length > 180)
                throw Error('Question unavailable');
            assignments.push({ id: scope.id, question_ref: scope.questionRef, version: scope.version, rubric_id: scope.rubricId, label: q[0].label, criteria: scope.rubric.criteria, total_points: scope.rubric.total_points });
        } catch (e) {
            // A withdrawn/handed-over resource can disappear from a candidate page.
            // Actor denial or unavailable/corrupt schema is never a partial success.
            if (e instanceof GradingAuthorityDenied && e.status === 404) continue;
            throw e;
        }
    }
    return { assignments, next_cursor: rows.length > 25 ? rows[24].id : null };
}
export function assignedRubricPoints(scope: GradingAssignmentScope, body: any) {
    if (body.assignment_version !== scope.version || body.question_ref !== scope.questionRef)
        throw new GradingAuthorityDenied(409);
    return scoreGradingRubric(scope.rubric, body.marks);
}
