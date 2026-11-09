import { Router } from 'express';
import type { AuthRequest } from '../middleware/auth';
import type { CourseLessonConnection } from './course-lessons';
import { proveTeachingIdentity, proveTeachingCourse, TeachingAuthorityDenied } from '../services/teaching-authority';

const uuid = (x: unknown): x is string => typeof x === 'string' && /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/.test(x);
const title = (x: unknown): x is string => typeof x === 'string' && !!x.trim() && x.length <= 255;

/** Discovery only: no owner management endpoints, access writes or student identities. */
export function createTeachingWorkspaceRouter(deps: { getConnection(): Promise<CourseLessonConnection> }) {
  const router = Router();
  router.get(['/teaching/courses', '/teaching/courses/:courseId/lessons'], async (req: AuthRequest, res) => {
    res.set('Cache-Control', 'no-store');
    const courseId = req.params.courseId?.toLowerCase(), cursor = req.query.cursor ?? '';
    if (courseId !== undefined && !uuid(courseId) || typeof cursor !== 'string' || cursor !== '' && !uuid(cursor)
      || Object.keys(req.query).some(k => k !== 'cursor')
      || ['x-tenant-id', 'x-instructor-id', 'x-student-id', 'x-enrollment-id'].some(k => req.headers[k] !== undefined)
      || req.body != null && (typeof req.body !== 'object' || Array.isArray(req.body) || Object.keys(req.body).length))
      return res.status(400).json({ code: 'TEACHING_INPUT' });
    if (!req.user) return res.status(401).json({ code: 'SESSION_REQUIRED' });
    let c: CourseLessonConnection | null = null, open = false, discard = false;
    try {
      c = await deps.getConnection(); await c.beginTransaction(); open = true;
      await proveTeachingIdentity(c, req);
      if (courseId) await proveTeachingCourse(c, req, courseId);
      const [rows] = courseId
        ? await c.execute(`SELECT l.id,l.unit_id,l.title FROM course_lessons l
            JOIN course_units u ON u.id=l.unit_id
            WHERE u.course_id=? AND u.status='active' AND l.status='active' AND l.id>?
            ORDER BY l.id LIMIT 26`, [courseId, cursor])
        : await c.execute(`SELECT c.id,c.name FROM courses c WHERE c.tenant_id=? AND c.instructor_id=?
            AND c.is_active=1 AND c.id>? ORDER BY c.id LIMIT 26`, [req.user.tenantId, req.user.id, cursor]);
      if (!Array.isArray(rows) || rows.length > 26 || rows.some(r => !uuid(r.id) || !title(courseId ? r.title : r.name)
        || courseId && !uuid(r.unit_id)) || new Set(rows.map(r => r.id)).size !== rows.length
        || rows.some((r, i) => r.id <= (i ? rows[i - 1].id : cursor))) throw Error('Invalid teaching choices');
      const items = rows.slice(0, 25).map(r => courseId ? { id: r.id, unit_id: r.unit_id, title: r.title } : { id: r.id, name: r.name });
      return res.json({ items, next_cursor: rows.length > 25 ? rows[24].id : null });
    } catch (e) {
      if (e instanceof TeachingAuthorityDenied) return res.status(e.status).json({ code: 'COURSE_TEACHER_REQUIRED' });
      discard = true; return res.status(503).json({ code: 'TEACHING_UNAVAILABLE' });
    } finally {
      if (c) {
        if (open) try { await c.rollback(); } catch { discard = true; }
        try { if (discard) c.destroy(); else c.release(); } catch { try { c.destroy(); } catch { /* closed */ } }
      }
    }
  });
  return router;
}
