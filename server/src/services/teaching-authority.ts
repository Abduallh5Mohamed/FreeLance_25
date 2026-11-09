import type { AuthRequest } from '../middleware/auth';
import { lockAcademicTenant } from './academic-lock-order';
import type { CourseLessonConnection } from '../routes/course-lessons';
import { ACTIVE_SUSPENSION_PREDICATE_SQL } from '../security/suspension-predicate';

export class TeachingAuthorityDenied extends Error {
  constructor(public status = 403) { super('COURSE_TEACHER_REQUIRED'); }
}

/** A workspace selector/ownership alone never grants academic responsibility. */
export async function proveTeachingIdentity(c: CourseLessonConnection, req: AuthRequest): Promise<void> {
  const actor = req.user;
  if (!actor || !actor.tenantId || !['teacher', 'instructor'].includes(actor.role)
    || actor.identitySource === 'staff' || actor.billingOnly || req.impersonation
    || req.headers['x-impersonation'] !== undefined) throw new TeachingAuthorityDenied();
  if (!await lockAcademicTenant({ query: async (sql, params) => { const [rows] = await c.execute(sql, params); return rows; } }, actor.tenantId))
    throw new TeachingAuthorityDenied();
  const [rows] = await c.execute(`SELECT u.id AS teaching_user_id FROM users u
    JOIN tenant_memberships m ON m.user_id=u.id AND m.tenant_id=? AND m.status='active' AND m.role_key IN ('owner','instructor')
    JOIN tenants t ON t.id=m.tenant_id AND t.status='active'
    WHERE u.id=? AND u.role IN ('teacher','instructor') AND u.center_account=0
    AND NOT EXISTS (SELECT 1 FROM admin_user_roles platform_role WHERE platform_role.user_id=u.id)
    AND u.is_active=1 AND u.token_version=? AND NOT ${ACTIVE_SUSPENSION_PREDICATE_SQL.replace(/suspended_until/g, 'u.suspended_until')}
    LIMIT 1 FOR UPDATE`, [actor.tenantId, actor.id, actor.tokenVersion ?? 0]);
  if (!Array.isArray(rows) || rows.length !== 1 || rows[0].teaching_user_id !== actor.id) throw new TeachingAuthorityDenied();
}

export async function proveTeachingCourse(c: CourseLessonConnection, req: AuthRequest, courseId: string): Promise<void> {
  const [rows] = await c.execute(`SELECT c.id AS teaching_course_id FROM courses c
    WHERE c.id=? AND c.tenant_id=? AND c.instructor_id=? AND c.is_active=1 LIMIT 1 FOR UPDATE`,
    [courseId, req.user!.tenantId, req.user!.id]);
  if (!Array.isArray(rows) || rows.length !== 1 || typeof rows[0].teaching_course_id !== 'string'
    || rows[0].teaching_course_id.toLowerCase() !== courseId.toLowerCase()) throw new TeachingAuthorityDenied(404);
}
