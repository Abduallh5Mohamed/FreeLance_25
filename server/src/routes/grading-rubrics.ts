import { Router } from 'express';
import { createHash, randomUUID } from 'node:crypto';
import type { AuthRequest } from '../middleware/auth';
import type { CourseLessonConnection } from './course-lessons';
import { centerDb, CenterDenied } from '../services/center-team';
import { proveGradingIdentity, GradingAuthorityDenied } from '../services/grading-authority';
import { parseGradingRubric } from '../services/grading-rubric';
import { recordSealedAuditEvent } from '../services/audit-log';

const uuid = (x: unknown): x is string => typeof x === 'string' && /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(x);
const exact = (x: any, keys: string[]) => !!x && typeof x === 'object' && !Array.isArray(x) && Object.keys(x).sort().join(',') === [...keys].sort().join(',');
const digest = (x: unknown) => createHash('sha256').update(JSON.stringify(x)).digest('hex');
class Conflict extends Error {}

export function createGradingRubricsRouter(deps: { getConnection(): Promise<CourseLessonConnection> }) {
  const router = Router();
  const handle = async (req: AuthRequest, res: any) => {
    res.set('Cache-Control', 'no-store'); res.set('Vary', 'Authorization');
    if (!req.user) return res.status(401).json({ code: 'SESSION_REQUIRED' });
    if (req.impersonation || req.user.billingOnly || req.user.identitySource === 'staff' || ['x-tenant-id', 'x-instructor-id', 'x-student-id', 'x-impersonation'].some(k => req.headers[k] !== undefined)) return res.status(403).json({ code: 'GRADING_TEACHER_REQUIRED' });
    const write = req.method === 'POST', recovery = !!req.params.operationId;
    if (Object.keys(req.query).length || !Object.values(req.params).filter(v => v !== undefined).every(uuid)) return res.status(400).json({ code: 'RUBRIC_INPUT' });
    const b = req.body;
    if (!write && b != null && !exact(b, [])) return res.status(400).json({ code: 'RUBRIC_INPUT' });
    if (write && (!exact(b, ['operation_id', 'expected_revision', 'criteria']) || !uuid(b.operation_id) || !Number.isSafeInteger(b.expected_revision) || b.expected_revision < 0 || b.expected_revision >= 2147483647)) return res.status(400).json({ code: 'RUBRIC_INPUT' });
    let connection: CourseLessonConnection | null = null, open = false, uncertain = false, reusable = true;
    try {
      connection = await deps.getConnection();
      await connection.beginTransaction(); open = true;
      const db = centerDb(connection), tenant = await proveGradingIdentity(db, req.user);
      const names = ['exam_grading_rubrics', 'exam_rubric_operations', 'exam_versions', 'exam_version_questions', 'exams', 'courses', 'audit_events', 'audit_chain_head', 'users', 'tenants'];
      const engines = await db.query(`SELECT TABLE_NAME AS name,ENGINE AS engine FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN (${names.map(() => '?').join(',')}) LIMIT 10`, names);
      if (!names.every(n => engines.some(t => t.name === n && t.engine === 'InnoDB'))) throw Error('Rubric schema unavailable');
      const columns = await db.query("SELECT TABLE_NAME AS name,COLUMN_NAME AS column_name,DATA_TYPE AS kind FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND ((TABLE_NAME='exam_grading_rubrics' AND COLUMN_NAME='criteria') OR (TABLE_NAME='exam_rubric_operations' AND COLUMN_NAME='result')) LIMIT 2");
      if (!['exam_grading_rubrics', 'exam_rubric_operations'].every(n => columns.some(c => c.name === n && c.kind === 'json'))) throw Error('Rubric JSON unavailable');
      const indexes = await db.query("SELECT TABLE_NAME AS name,INDEX_NAME AS index_name,COLUMN_NAME AS column_name,SEQ_IN_INDEX AS seq FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN ('exam_grading_rubrics','exam_rubric_operations') AND NON_UNIQUE=0 ORDER BY TABLE_NAME,INDEX_NAME,SEQ_IN_INDEX LIMIT 12");
      for (const [name, keys] of [['exam_grading_rubrics', ['id']], ['exam_grading_rubrics', ['tenant_id', 'question_ref', 'revision']], ['exam_rubric_operations', ['tenant_id', 'operation_id']]] as const) {
        if (!indexes.some(i => i.name === name && Number(i.seq) === 1 && (() => { const rows = indexes.filter(j => j.name === name && j.index_name === i.index_name); return rows.length === keys.length && keys.every((key, n) => rows[n].column_name === key && Number(rows[n].seq) === n + 1); })())) throw Error('Rubric identity unavailable');
      }
      if (recovery) {
        const rows = await db.query('SELECT o.result FROM exam_rubric_operations o JOIN exam_grading_rubrics r ON r.id=JSON_UNQUOTE(JSON_EXTRACT(o.result,"$.rubric_id")) JOIN exam_version_questions q ON q.id=r.question_ref JOIN exam_versions v ON v.id=q.exam_version_id AND v.tenant_id=r.tenant_id JOIN exams e ON e.id=v.exam_id JOIN courses c ON c.id=e.course_id AND c.tenant_id=r.tenant_id AND c.instructor_id=? AND c.is_active=1 WHERE o.tenant_id=? AND o.operation_id=? AND o.actor_user_id=? LIMIT 1', [req.user.id, tenant, req.params.operationId, req.user.id]);

        const result = rows.length ? decodeReceipt(rows[0].result) : null;
        if (result && result.operation_id !== req.params.operationId) throw Error('Mismatched rubric receipt');
        return res.json({ receipt: result });
      }
      const questions = await db.query(`SELECT q.id,q.points FROM exam_version_questions q INNER JOIN exam_versions v ON v.id=q.exam_version_id AND v.tenant_id=q.tenant_id AND v.status='published' INNER JOIN exams e ON e.id=v.exam_id INNER JOIN courses c ON c.id=e.course_id AND c.tenant_id=v.tenant_id AND c.is_active=1 AND c.instructor_id=? WHERE q.id=? AND q.tenant_id=? AND q.question_type='essay' LIMIT 1 FOR UPDATE`, [req.user.id, req.params.questionRef, tenant]);
      if (questions.length !== 1) throw new CenterDenied(404, 'RUBRIC_QUESTION_NOT_FOUND');
      const question = questions[0];
      const rows = await db.query('SELECT id,question_ref,revision,criteria,total_points FROM exam_grading_rubrics WHERE tenant_id=? AND question_ref=? ORDER BY revision DESC LIMIT 1', [tenant, question.id]);
      if (!write) return res.json({ rubric: rows.length ? projectRubric(rows[0], String(question.points)) : null });
      let rubric;
      try { rubric = parseGradingRubric(b.criteria, String(question.points)); } catch { throw new CenterDenied(400, 'RUBRIC_CRITERIA_INVALID'); }
      const hash = digest([question.id, b.expected_revision, rubric.criteria]);
      const operations = await db.query('SELECT actor_user_id,request_hash,result FROM exam_rubric_operations WHERE tenant_id=? AND operation_id=? LIMIT 1', [tenant, b.operation_id]);
      if (operations.length) {
        if (operations[0].actor_user_id !== req.user.id || operations[0].request_hash !== hash) throw new Conflict();
        const result = decodeReceipt(operations[0].result);
        if (result.operation_id !== b.operation_id || result.question_ref !== question.id) throw Error('Mismatched rubric receipt');
        return res.json({ receipt: result });
      }
      const revision = rows.length ? Number(rows[0].revision) : 0;
      if (!Number.isSafeInteger(revision) || revision !== b.expected_revision) throw new Conflict();
      const id = randomUUID(), result = { operation_id: b.operation_id, rubric_id: id, question_ref: question.id, revision: revision + 1 };
      const inserted = await db.execute('INSERT INTO exam_grading_rubrics(id,tenant_id,question_ref,revision,criteria,total_points,created_by) VALUES(?,?,?,?,?,?,?)', [id, tenant, question.id, result.revision, JSON.stringify(rubric.criteria), rubric.total_points, req.user.id]);
      if (inserted.affectedRows !== 1) throw Error('Rubric not confirmed');
      await recordSealedAuditEvent({ query: async <T>(s: string, p?: unknown[]) => await db.query(s, p) as T[], queryOne: async <T>(s: string, p?: unknown[]) => (await db.query(s, p))[0] as T ?? null, execute: (s, p) => db.execute(s, p) }, { actorUserId: req.user.id, tenantId: tenant, action: 'exam.rubric.create', resourceType: 'exam_question', resourceId: question.id, oldValue: { revision }, newValue: { rubric_id: id, revision: result.revision } });
      const recorded = await db.execute('INSERT INTO exam_rubric_operations(tenant_id,operation_id,actor_user_id,request_hash,result) VALUES(?,?,?,?,?)', [tenant, b.operation_id, req.user.id, hash, JSON.stringify(result)]);
      if (recorded.affectedRows !== 1) throw Error('Rubric receipt not confirmed');
      uncertain = true; await connection.commit(); open = false; uncertain = false;
      return res.status(201).json({ receipt: result });
    } catch (e) {
      if (uncertain) reusable = false;
      return res.status(e instanceof CenterDenied || e instanceof GradingAuthorityDenied ? e.status : e instanceof Conflict ? 409 : 503).json({ code: e instanceof GradingAuthorityDenied ? e.message : e instanceof CenterDenied ? e.code : e instanceof Conflict ? 'RUBRIC_STALE' : write ? 'RUBRIC_WRITE_UNCERTAIN' : 'RUBRIC_UNAVAILABLE' });
    } finally {
      if (connection) { if (open) try { await connection.rollback(); } catch { reusable = false; } if (reusable) connection.release(); else connection.destroy(); }
    }
  };
  router.get(['/grading/questions/:questionRef/rubric', '/grading/rubric-operations/:operationId'], handle);
  router.post('/grading/questions/:questionRef/rubric', handle);
  return router;
}

function decodeReceipt(raw: unknown) {
  const r = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!exact(r, ['operation_id', 'rubric_id', 'question_ref', 'revision']) || !uuid(r.operation_id) || !uuid(r.rubric_id) || !uuid(r.question_ref) || !Number.isSafeInteger(r.revision) || r.revision < 1) throw Error('Invalid rubric receipt');
  return r;
}
function projectRubric(row: any, points: string) {
  if (!uuid(row.id) || !uuid(row.question_ref) || !Number.isSafeInteger(Number(row.revision)) || Number(row.revision) < 1) throw Error('Invalid rubric');
  const r = parseGradingRubric(typeof row.criteria === 'string' ? JSON.parse(row.criteria) : row.criteria, points);
  if (r.total_points !== Number(row.total_points).toFixed(2)) throw Error('Invalid rubric total');
  return { id: row.id, question_ref: row.question_ref, revision: Number(row.revision), criteria: r.criteria, total_points: r.total_points };
}
