import { Router, Response } from 'express';
import { query, queryOne } from '../db';
import { AuthRequest, optionalAuth } from '../middleware/auth';

export interface PublicIdentityDeps {
    query: typeof query;
    queryOne: typeof queryOne;
}
const defaultDeps: PublicIdentityDeps = { query, queryOne };

export interface PublicPagination {
    limit: number;
    offset: number;
}

/** Bounded pagination for public listings. Never throws; hard-caps at 100. */
export function parsePublicPagination(input: unknown): PublicPagination {
    const rec = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>;
    const num = (v: unknown): number | null => {
        if (typeof v === 'number' && Number.isInteger(v)) return v;
        if (typeof v === 'string' && v.trim() !== '' && Number.isInteger(Number(v))) return Number(v);
        return null;
    };
    let limit = num(rec['limit']) ?? 24;
    if (limit < 1) limit = 1;
    if (limit > 100) limit = 100;
    const page = num(rec['page']);
    const rawOffset = num(rec['offset']);
    let offset = page !== null && page >= 1 ? (page - 1) * limit : rawOffset ?? 0;
    if (offset < 0) offset = 0;
    if (offset > 100000) offset = 100000;
    return { limit, offset };
}

/**
 * C1/C4 public identity + published discovery.
 *
 * Every projection here is deliberately narrow: only non-private fields are
 * SELECTed (no phone/email/finance/secrets/staff flags), the tenant/teacher is
 * server-resolved (never caller authority), and no unpublished file/video
 * keys/URLs/session tokens are ever returned. Drafts/archived resources are
 * hidden by the is_active / published gates.
 */
export const createPublicIdentityRouter = (deps: PublicIdentityDeps = defaultDeps) => {
    const router = Router();
    router.use(optionalAuth);

    // Teacher/center public page. The teacher id is their public user uuid; the
    // center name comes from their active owned tenant. Only published
    // (is_active) courses are returned, via the same safe projection the
    // authenticated catalog uses.
    router.get('/teachers/:id', async (req: AuthRequest, res: Response) => {
        try {
            const teacherId = String(req.params.id || '');
            if (!/^[0-9a-fA-F-]{36}$/.test(teacherId)) return res.status(404).json({ error: 'Not found' });
            const teacher = await deps.queryOne<{ id: string; name: string | null }>(
                `SELECT u.id, u.name FROM users u WHERE u.id=? AND u.is_active=1 AND u.role IN ('instructor','teacher') LIMIT 1`,
                [teacherId],
            );
            if (!teacher) return res.status(404).json({ error: 'Not found' });
            const tenant = await deps.queryOne<{ id: string; business_name: string }>(
                `SELECT t.id, t.business_name FROM tenants t WHERE t.owner_user_id=? AND t.status='active' LIMIT 1`,
                [teacherId],
            );
            const courses = await deps.query<{
                id: string; name: string; subject: string | null; description: string | null;
                grade: string | null; price: number;
            }>(
                `SELECT c.id,c.name,c.subject,c.description,c.grade,c.price
                 FROM courses c INNER JOIN tenants ct ON ct.id=c.tenant_id
                 WHERE c.is_active=1 AND ct.status='active' AND (c.instructor_id=? OR ct.owner_user_id=?)
                 ORDER BY c.name LIMIT 100`,
                [teacherId, teacherId],
            );
            res.set('Cache-Control', 'public, max-age=60');
            res.json({
                id: teacher.id,
                name: teacher.name,
                center: tenant ? { id: tenant.id, business_name: tenant.business_name } : null,
                published_courses: courses,
            });
        } catch {
            return res.status(500).json({ error: 'Failed to load teacher page' });
        }
    });

    // Published-course discovery. Server-resolved: every caller (including
    // anonymous) sees only published (is_active) courses of active tenants. No
    // private fields, no video/file keys, bounded pagination + filter/search.
    router.get('/courses', async (req: AuthRequest, res: Response) => {
        try {
            const { limit, offset } = parsePublicPagination(req.query);
            const clauses = [`c.is_active=1`, `t.status='active'`];
            const params: unknown[] = [];
            const grade = typeof req.query.grade === 'string' ? req.query.grade.trim() : '';
            const subject = typeof req.query.subject === 'string' ? req.query.subject.trim() : '';
            const search = typeof req.query.search === 'string' ? req.query.search.trim().slice(0, 64) : '';
            if (grade) {
                clauses.push('c.grade=?');
                params.push(grade);
            }
            if (subject) {
                clauses.push('c.subject=?');
                params.push(subject);
            }
            if (search) {
                clauses.push('(c.name LIKE ? OR c.description LIKE ?)');
                params.push(`%${search}%`, `%${search}%`);
            }
            const sql = `SELECT c.id,c.name,c.subject,c.description,c.grade,c.price
                         FROM courses c INNER JOIN tenants t ON t.id=c.tenant_id
                         WHERE ${clauses.join(' AND ')} ORDER BY c.name LIMIT ? OFFSET ?`;
            const courses = await deps.query(sql, [...params, String(limit), String(offset)]);
            res.set('Cache-Control', 'public, max-age=60');
            res.json(courses);
        } catch (error) {
            console.error('Public course discovery error:', error);
            res.status(500).json({ error: 'Failed to load courses' });
        }
    });

    return router;
};

const router = createPublicIdentityRouter();
export default router;
