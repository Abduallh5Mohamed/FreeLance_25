import { Router } from 'express';
import type { AuthRequest } from '../middleware/auth';
import type { CourseLessonConnection } from './course-lessons';
import { lessonPackageReferenceSchema, packageKinds, readLessonPackageBindings, readLessonPackageSource } from '../services/lesson-package-reuse';
import { manageLessonQuizVersion } from '../services/lesson-quiz-versions';
import { renderReleaseInstant } from '../services/lesson-package-timing';
import { listPreparationGroups, parseLearningWindow, readLessonLearning } from '../services/lesson-learning-evidence';
import { proveTeachingIdentity, proveTeachingCourse, TeachingAuthorityDenied } from '../services/teaching-authority';

const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(value);
const same = (a: unknown, b: string) => typeof a === 'string' && a.toLowerCase() === b.toLowerCase();
const unavailable = () => ({ status: 503, body: { code: 'LESSON_PREPARATION_UNAVAILABLE', error: 'Preparation evidence is unavailable' } });

/** Read-only responsible-teacher preparation; no ownership/admin grant. */
export function createLessonPreparationRouter(deps: { getConnection(): Promise<CourseLessonConnection> }) {
  const router = Router();
  const path='/courses/:courseId/units/:unitId/lessons/:lessonId/preparation';
  router.get([path,path+'/groups',path+'/learning'], async (req: AuthRequest, res) => {
    res.set('Cache-Control', 'no-store');
    if (req.user?.billingOnly) return res.status(403).json({ code: 'BILLING_ONLY', error: 'Forbidden' });
    const { courseId, unitId, lessonId } = req.params;
    const learning=req.url.split('?')[0].endsWith('/learning'), groups=req.url.split('?')[0].endsWith('/groups');
    const window=learning?parseLearningWindow(req.query):null;
    const groupCursor=typeof req.query?.cursor==='string'?req.query.cursor:'';
    const validQuery=learning?window!==null:groups?Object.keys(req.query??{}).every(key=>key==='cursor')&&(req.query?.cursor===undefined||uuid(req.query.cursor)):Object.keys(req.query??{}).length===0;
    if (![courseId, unitId, lessonId].every(uuid) || !validQuery
      || ['x-tenant-id', 'x-student-id', 'x-enrollment-id', 'x-instructor-id'].some(key => req.headers[key] !== undefined)
      || req.body != null && (typeof req.body !== 'object' || Array.isArray(req.body) || Object.keys(req.body).length))
      return res.status(400).json({ error: 'Invalid preparation selectors' });
    const userId = req.user?.id, tenantId = req.user?.tenantId;
    if (!userId || !tenantId) return res.status(404).json({ error: 'Tenant membership not found' });
    let connection: CourseLessonConnection | null = null, started = false, discard = false;
    try {
      connection = await deps.getConnection();
      await connection.beginTransaction(); started = true;
      await proveTeachingIdentity(connection, req);
      await proveTeachingCourse(connection, req, courseId);
      const [parents] = await connection.execute(`SELECT l.id,l.unit_id,l.title,l.status,UNIX_TIMESTAMP(l.release_at) AS release_at_epoch,u.status AS unit_status
        FROM course_lessons l INNER JOIN course_units u ON u.id=l.unit_id WHERE l.id=? AND l.unit_id=? AND u.course_id=? LIMIT 2 FOR UPDATE`, [lessonId, unitId, courseId]);
      const lesson = (parents as any[])[0];
      if ((parents as any[]).length !== 1 || !same(lesson.id, lessonId) || !same(lesson.unit_id, unitId)) return res.status(404).json({ error: 'Lesson not found' });
      if (!['active', 'archived'].includes(lesson.status) || !['active', 'archived'].includes(lesson.unit_status)
        || typeof lesson.title !== 'string' || !lesson.title.trim() || lesson.title.length > 255 || lesson.release_at_epoch === undefined) throw Error('Invalid preparation lesson');
      const release = renderReleaseInstant(lesson.release_at_epoch);
      if (release === undefined) throw Error('Invalid preparation release');
      if (!await lessonPackageReferenceSchema(connection)) { const response = unavailable(); return res.status(response.status).json(response.body); }
      if (groups || learning) {
        const response=groups?await listPreparationGroups(connection,courseId,tenantId,groupCursor):await readLessonLearning(connection,{userId,tenantId,courseId,lessonId,window:window!});
        return res.status(response.status).json(response.body);
      }
      const bindings = await readLessonPackageBindings(connection, lessonId);
      const items: any[] = [];
      for (const binding of bindings) {
        const source = await readLessonPackageSource(connection, binding, courseId, tenantId);
        let quizVersion: 'published' | 'missing' | 'unavailable' | null = null;
        if (source && binding.kind === 'quiz') {
          const version = await manageLessonQuizVersion(connection, { userId, tenantId, courseId, lessonId, contentId: binding.id, operation: 'read' });
          if (version.status !== 200) { const response = unavailable(); return res.status(response.status).json(response.body); }
          quizVersion = version.body.pin?.status ?? 'missing';
          if (!['published', 'missing', 'unavailable'].includes(quizVersion!)) throw Error('Invalid preparation quiz version');
        }
        const issue = !source ? 'source_unavailable' : binding.kind === 'quiz' && quizVersion !== 'published' ? 'quiz_version_required'
          : source.state === 'draft' ? 'draft_source' : source.audience === 'restricted' ? 'restricted_audience' : null;
        items.push({ binding_id: binding.id, kind: binding.kind, title: source?.title ?? null, display_order: binding.display_order,
          source_state: source?.state ?? 'unavailable', audience: source?.audience ?? null, quiz_version: quizVersion, issue });
      }
      items.sort((a, b) => packageKinds.indexOf(a.kind) - packageKinds.indexOf(b.kind) || a.binding_id.localeCompare(b.binding_id));
      // No raw source facts, bodies, group/student identifiers or URLs leave here.
      return res.json({ context: { course_id: courseId.toLowerCase(), unit_id: unitId.toLowerCase(), lesson_id: lessonId.toLowerCase() },
        checked_at: new Date().toISOString(), lesson: { title: lesson.title, status: lesson.status, unit_status: lesson.unit_status, release_at: release },
        rule_version: 'preparation-v1', items, learning_evidence: 'insufficient' });
    } catch (error: any) {
      if (error instanceof TeachingAuthorityDenied) return res.status(error.status).json({ code: 'COURSE_TEACHER_REQUIRED' });
      discard = true;
      if (['ER_NO_SUCH_TABLE', 'ER_BAD_FIELD_ERROR', 'ER_CANT_OPEN_TABLE', 'ER_UNKNOWN_TABLE'].includes(error?.code)) {
        const response = unavailable(); return res.status(response.status).json(response.body);
      }
      return res.status(500).json({ error: 'Could not verify preparation evidence' });
    } finally {
      if (connection) {
        // Read-only transaction, always rollback. A failed cleanup must never
        // recycle an open transaction, even when the response was already sent.
        if (started) { try { await connection.rollback(); } catch { discard = true; } }
        try { if (discard) connection.destroy(); else connection.release(); } catch { /* discarded/closed */ }
      }
    }
  });
  return router;
}
