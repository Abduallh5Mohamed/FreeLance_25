/**
 * Private same-course saved lesson-package templates for the VERIFIED owner.
 *
 * Mounted separately from the course-lesson router so that no reserved lesson
 * file is edited. Every route re-verifies the server-selected tenant's real
 * owner, the course inside that tenant and (for destination actions) the exact
 * unit/lesson, all on the same transaction connection that performs the work.
 */
import { Router, Response } from 'express';
import type { AuthRequest } from '../middleware/auth';
import type { CourseLessonConnection } from './course-lessons';
import {
  manageLessonTemplateApplication,
  manageLessonTemplates,
  readLessonTemplateLibraryOperation,
  parseTemplateApplicationBody,
  parseTemplateArchiveBody,
  parseTemplateCreateBody,
  parseTemplateLimit,
  parseTemplateRevisionBody,
} from '../services/lesson-package-templates';

export interface LessonPackageTemplatesDeps {
  getConnection: () => Promise<CourseLessonConnection>;
}

const UUID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const SELECTOR_HEADERS = ['x-tenant-id', 'x-student-id', 'x-enrollment-id', 'x-instructor-id'];

type TxResult = { status: number; body: any; commit: boolean };

export const createLessonPackageTemplatesRouter = (deps: LessonPackageTemplatesDeps): Router => {
  const router = Router();
  const { getConnection } = deps;

  const denyBillingOnly = (req: AuthRequest, res: Response): boolean => {
    if (!req.user?.billingOnly) return false;
    res.status(403).json({
      error: 'Lesson template management is not available while the account is limited to billing and support',
      code: 'BILLING_ONLY',
    });
    return true;
  };

  const runInTransaction = async (
    label: string,
    res: Response,
    work: (connection: CourseLessonConnection) => Promise<TxResult>,
  ): Promise<Response> => {
    let connection: CourseLessonConnection | null = null;
    let transactionStarted = false;
    let commitAttempted = false;
    let disposal: 'release' | 'destroy' = 'release';
    const rollbackOrDiscard = async (): Promise<void> => {
      try {
        await connection!.rollback();
      } catch (rollbackError) {
        disposal = 'destroy';
        console.error(`Rollback ${label} error (connection will be discarded):`, rollbackError);
      }
    };
    try {
      connection = await getConnection();
      await connection.beginTransaction();
      transactionStarted = true;
      const result = await work(connection);
      if (!result.commit) {
        await rollbackOrDiscard();
        return res.status(result.status).json(result.body);
      }
      commitAttempted = true;
      await connection.commit();
      return res.status(result.status).json(result.body);
    } catch (error) {
      if (commitAttempted) {
        disposal = 'destroy';
        console.error(`${label} error after commit attempt (persistence uncertain):`, error);
      } else if (transactionStarted) {
        console.error(`${label} error:`, error);
        await rollbackOrDiscard();
      } else {
        disposal = 'destroy';
        console.error(`${label} error before transaction start:`, error);
      }
      return res.status(500).json({
        error: label,
        ...(commitAttempted ? { code: 'PERSISTENCE_UNCERTAIN' } : {}),
      });
    } finally {
      if (connection) {
        if (disposal === 'destroy') {
          try { connection.destroy(); } catch { /* connection already gone */ }
        } else {
          try { connection.release(); } catch { /* connection already released */ }
        }
      }
    }
  };

  const verifyTenantOwner = async (
    connection: CourseLessonConnection, userId: string, tenantId: string, lock: boolean,
  ): Promise<any | null> => {
    const [rows] = await connection.execute(
      `SELECT t.owner_user_id,t.status AS tenant_status,u.is_active AS caller_active
       FROM tenants t JOIN users u ON u.id=? WHERE t.id=?${lock ? ' FOR UPDATE' : ''}`,
      [userId, tenantId],
    );
    const row = (rows as any[])[0];
    if (!row || String(row.owner_user_id) !== userId || row.tenant_status !== 'active' || Number(row.caller_active) !== 1) return null;
    return row;
  };

  const resolveCourse = async (
    connection: CourseLessonConnection, courseId: string, tenantId: string, lock: boolean,
  ): Promise<any | null> => {
    const [rows] = await connection.execute(
      `SELECT c.id,c.tenant_id FROM courses c WHERE c.id=? AND c.tenant_id=? AND c.is_active=1${lock ? ' FOR UPDATE' : ''}`,
      [courseId, tenantId],
    );
    return (rows as any[])[0] ?? null;
  };

  const resolveUnit = async (
    connection: CourseLessonConnection, unitId: string, courseId: string, lock: boolean,
  ): Promise<any | null> => {
    const [rows] = await connection.execute(
      `SELECT u.id,u.course_id,u.display_order FROM course_units u WHERE u.id=? AND u.course_id=?${lock ? ' FOR UPDATE' : ''}`,
      [unitId, courseId],
    );
    return (rows as any[])[0] ?? null;
  };

  const selectorsRejected = (req: AuthRequest): boolean =>
    SELECTOR_HEADERS.some(key => req.headers[key] !== undefined);

  const templatePath = '/courses/:courseId/lesson-templates';
  const revisionPath = '/courses/:courseId/lesson-templates/:templateId/revisions';
  const applicationPath = '/courses/:courseId/units/:unitId/lessons/:lessonId/lesson-template-';

  router.get(templatePath+'/operations/:operationId',async(req:AuthRequest,res:Response)=>{
    res.set('Cache-Control','no-store'); if(denyBillingOnly(req,res))return;
    const {courseId,operationId}=req.params;
    if(![courseId,operationId].every(id=>typeof id==='string'&&UUID_PATTERN.test(id))||Object.keys(req.query??{}).length||selectorsRejected(req)
      ||req.body!=null&&(typeof req.body!=='object'||Array.isArray(req.body)||Object.keys(req.body).length))return res.status(400).json({error:'Invalid library operation selectors'});
    const userId=req.user?.id,tenantId=req.user?.tenantId;
    if(!userId||!tenantId)return res.status(404).json({error:'Tenant membership not found'});
    return runInTransaction('Failed to read lesson template operation',res,async connection=>{
      if(!await verifyTenantOwner(connection,userId,tenantId,true))return{status:403,body:{error:'Forbidden'},commit:false};
      if(!await resolveCourse(connection,courseId,tenantId,true))return{status:404,body:{error:'Course not found'},commit:false};
      return readLessonTemplateLibraryOperation(connection,{userId,tenantId,courseId,operationId:operationId.toLowerCase()});
    });
  });

  router.get(templatePath, async (req: AuthRequest, res: Response) => {
    res.set('Cache-Control', 'no-store');
    if (denyBillingOnly(req, res)) return;
    const courseId = String(req.params?.courseId ?? '');
    const limit = parseTemplateLimit(req.query?.limit);
    const cursor = req.query?.cursor;
    if (!UUID_PATTERN.test(courseId) || limit === null
      || (cursor !== undefined && (typeof cursor !== 'string' || cursor.length > 128))
      || Object.keys(req.query ?? {}).some(key => key !== 'limit' && key !== 'cursor')
      || selectorsRejected(req)) return res.status(400).json({ error: 'Invalid lesson template list request' });
    const userId = req.user?.id, tenantId = req.user?.tenantId;
    if (!userId || !tenantId) return res.status(404).json({ error: 'Tenant membership not found' });
    return runInTransaction('Failed to list lesson templates', res, async connection => {
      if (!await verifyTenantOwner(connection, userId, tenantId, false)) return { status: 403, body: { error: 'Forbidden' }, commit: false };
      if (!await resolveCourse(connection, courseId, tenantId, false)) return { status: 404, body: { error: 'Course not found' }, commit: false };
      return manageLessonTemplates(connection, { userId, tenantId, courseId, operation: 'list', cursor: cursor as string | undefined, limit });
    });
  });

  router.post(templatePath, async (req: AuthRequest, res: Response) => {
    res.set('Cache-Control', 'no-store');
    if (denyBillingOnly(req, res)) return;
    const courseId = String(req.params?.courseId ?? '');
    const body = parseTemplateCreateBody(req.body);
    if (!UUID_PATTERN.test(courseId) || !body || Object.keys(req.query ?? {}).length || selectorsRejected(req))
      return res.status(400).json({ error: 'Invalid lesson template request' });
    const userId = req.user?.id, tenantId = req.user?.tenantId;
    if (!userId || !tenantId) return res.status(404).json({ error: 'Tenant membership not found' });
    return runInTransaction('Failed to create lesson template', res, async connection => {
      if (!await verifyTenantOwner(connection, userId, tenantId, true)) return { status: 403, body: { error: 'Forbidden' }, commit: false };
      if (!await resolveCourse(connection, courseId, tenantId, true)) return { status: 404, body: { error: 'Course not found' }, commit: false };
      return manageLessonTemplates(connection, { userId, tenantId, courseId, operation: 'create', body });
    });
  });

  router.get(revisionPath, async (req: AuthRequest, res: Response) => {
    res.set('Cache-Control', 'no-store');
    if (denyBillingOnly(req, res)) return;
    const { courseId, templateId } = req.params;
    const limit = parseTemplateLimit(req.query?.limit);
    const cursor = req.query?.cursor;
    if (!UUID_PATTERN.test(String(courseId)) || !UUID_PATTERN.test(String(templateId)) || limit === null
      || (cursor !== undefined && (typeof cursor !== 'string' || cursor.length > 128))
      || Object.keys(req.query ?? {}).some(key => key !== 'limit' && key !== 'cursor')
      || selectorsRejected(req)) return res.status(400).json({ error: 'Invalid revision list request' });
    const userId = req.user?.id, tenantId = req.user?.tenantId;
    if (!userId || !tenantId) return res.status(404).json({ error: 'Tenant membership not found' });
    return runInTransaction('Failed to list lesson template revisions', res, async connection => {
      if (!await verifyTenantOwner(connection, userId, tenantId, false)) return { status: 403, body: { error: 'Forbidden' }, commit: false };
      if (!await resolveCourse(connection, courseId, tenantId, false)) return { status: 404, body: { error: 'Course not found' }, commit: false };
      return manageLessonTemplates(connection, {
        userId, tenantId, courseId, operation: 'revisions', templateId: String(templateId),
        cursor: cursor as string | undefined, limit,
      });
    });
  });

  router.post(revisionPath, async (req: AuthRequest, res: Response) => {
    res.set('Cache-Control', 'no-store');
    if (denyBillingOnly(req, res)) return;
    const { courseId, templateId } = req.params;
    const body = parseTemplateRevisionBody(req.body);
    if (!UUID_PATTERN.test(String(courseId)) || !UUID_PATTERN.test(String(templateId)) || !body
      || Object.keys(req.query ?? {}).length || selectorsRejected(req))
      return res.status(400).json({ error: 'Invalid template revision request' });
    const userId = req.user?.id, tenantId = req.user?.tenantId;
    if (!userId || !tenantId) return res.status(404).json({ error: 'Tenant membership not found' });
    return runInTransaction('Failed to revise lesson template', res, async connection => {
      if (!await verifyTenantOwner(connection, userId, tenantId, true)) return { status: 403, body: { error: 'Forbidden' }, commit: false };
      if (!await resolveCourse(connection, courseId, tenantId, true)) return { status: 404, body: { error: 'Course not found' }, commit: false };
      return manageLessonTemplates(connection, { userId, tenantId, courseId, operation: 'revise', templateId: String(templateId), body });
    });
  });

  router.patch('/courses/:courseId/lesson-templates/:templateId', async (req: AuthRequest, res: Response) => {
    res.set('Cache-Control', 'no-store');
    if (denyBillingOnly(req, res)) return;
    const { courseId, templateId } = req.params;
    const body = parseTemplateArchiveBody(req.body);
    if (!UUID_PATTERN.test(String(courseId)) || !UUID_PATTERN.test(String(templateId)) || !body
      || Object.keys(req.query ?? {}).length || selectorsRejected(req))
      return res.status(400).json({ error: 'Invalid lesson template archive request' });
    const userId = req.user?.id, tenantId = req.user?.tenantId;
    if (!userId || !tenantId) return res.status(404).json({ error: 'Tenant membership not found' });
    return runInTransaction('Failed to archive lesson template', res, async connection => {
      if (!await verifyTenantOwner(connection, userId, tenantId, true)) return { status: 403, body: { error: 'Forbidden' }, commit: false };
      if (!await resolveCourse(connection, courseId, tenantId, true)) return { status: 404, body: { error: 'Course not found' }, commit: false };
      return manageLessonTemplates(connection, { userId, tenantId, courseId, operation: 'archive', templateId: String(templateId), body });
    });
  });

  for (const operation of ['review', 'apply', 'status'] as const) {
    const path = operation === 'status'
      ? '/courses/:courseId/units/:unitId/lessons/:lessonId/lesson-template-operations/:operationId'
      : applicationPath + operation;
    router[operation === 'status' ? 'get' : 'post'](path, async (req: AuthRequest, res: Response) => {
      res.set('Cache-Control', 'no-store');
      if (denyBillingOnly(req, res)) return;
      const { courseId, unitId, lessonId, operationId } = req.params;
      if (![courseId, unitId, lessonId, ...(operation === 'status' ? [operationId] : [])]
        .every(id => typeof id === 'string' && UUID_PATTERN.test(id))
        || Object.keys(req.query ?? {}).length || selectorsRejected(req))
        return res.status(400).json({ error: 'Invalid lesson template application selectors' });
      const body = operation === 'status' ? null : parseTemplateApplicationBody(req.body, operation === 'apply');
      if (operation === 'status'
        ? req.body != null && (typeof req.body !== 'object' || Array.isArray(req.body) || Object.keys(req.body).length)
        : !body) return res.status(400).json({ error: 'Invalid lesson template application request' });
      const userId = req.user?.id, tenantId = req.user?.tenantId;
      if (!userId || !tenantId) return res.status(404).json({ error: 'Tenant membership not found' });
      return runInTransaction('Failed to apply lesson template', res, async connection => {
        if (!await verifyTenantOwner(connection, userId, tenantId, true)) return { status: 403, body: { error: 'Forbidden' }, commit: false };
        if (!await resolveCourse(connection, courseId, tenantId, true)
          || !await resolveUnit(connection, unitId, courseId, true))
          return { status: 404, body: { error: 'Lesson not found' }, commit: false };
        const [rows] = await connection.execute('SELECT l.id FROM course_lessons l WHERE l.id=? AND l.unit_id=? FOR UPDATE', [lessonId, unitId]);
        if (!(rows as any[])[0]) return { status: 404, body: { error: 'Lesson not found' }, commit: false };
        return manageLessonTemplateApplication(connection, {
          userId, tenantId, courseId, unitId, lessonId, operation,
          body: body ?? undefined, operationId: operationId?.toLowerCase(),
        });
      });
    });
  }

  return router;
};
