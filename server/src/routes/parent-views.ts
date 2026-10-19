/**
 * M6 P2 — read-only parent views.
 *
 * Every route is authenticated exclusively by a scoped parent view token (an
 * HMAC token over the dedicated PARENT_VIEW_SECRET). The token is bound to one
 * link id + tenant + enrollment + parent, and the verifier re-checks the link
 * and token revocation/expiry on EVERY request, so revoking a link or token
 * denies the next request immediately.
 *
 * These routes only ever expose the single linked child and published
 * aggregates: lesson-progress counts, attendance records and a grades summary.
 * They never mutate state, never select other children, and never return
 * contact details, addresses, notes, answer keys or any other student's data.
 * Every query is scoped by the token's tenant + enrollment.
 *
 * This module exports `createParentViewsRouter(deps)`; it is not mounted by
 * this task. No runtime DDL.
 */

import { Router, RequestHandler, Response } from 'express';
import { AuthRequest } from '../middleware/auth';
import {
    createParentViewVerifier,
    createSqlParentLinksStore,
    type ParentViewVerifier,
} from '../services/parent-links';

export interface ParentViewsDataAccess {
    query: <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<T[]>;
    queryOne: <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<T | null>;
    execute: (sql: string, params?: unknown[]) => Promise<{ insertId?: number; affectedRows?: number }>;
}

export interface ChildSummary {
    enrollment_id: string;
    name: string;
    grade: string | null;
    group: string | null;
    term: string | null;
    enrollment_status: string | null;
    enrolled_at: string | null;
}

export interface LessonProgressSummary {
    courses: Array<{ course_id: string; course_name: string; completed_lessons: number; total_lessons: number }>;
    totals: { completed_lessons: number; total_lessons: number };
}

export interface AttendanceRecordView {
    session_id: string;
    title: string;
    starts_at: string | null;
    state: string;
    marked_at: string | null;
}

export interface GradeSummary {
    courses: Array<{ course_id: string; course_name: string; total_score: number; total_max: number; items: number; last_recorded_at: string | null }>;
}

export interface ParentViewsStore {
    findChildSummary(tenantId: string, enrollmentId: string): Promise<ChildSummary | null>;
    lessonProgressSummary(tenantId: string, enrollmentId: string): Promise<LessonProgressSummary>;
    attendanceRecords(tenantId: string, enrollmentId: string, limit: number): Promise<AttendanceRecordView[]>;
    gradeSummary(tenantId: string, enrollmentId: string): Promise<GradeSummary>;
}

export interface ParentViewScope {
    linkId: string;
    tenantId: string;
    studentEnrollmentId: string;
    parentUserId: string;
}

export interface ParentViewRequest extends AuthRequest {
    parentView?: ParentViewScope;
}

export interface ParentViewsRouteDeps {
    store: ParentViewsStore;
    verifier: ParentViewVerifier;
}

const DEFAULT_ATTENDANCE_LIMIT = 100;
const MAX_ATTENDANCE_LIMIT = 200;

const parseAttendanceLimit = (raw: unknown): number | null => {
    if (raw === undefined) return DEFAULT_ATTENDANCE_LIMIT;
    const value = Array.isArray(raw) ? NaN : Number(raw);
    if (!Number.isInteger(value) || value < 1) return null;
    return Math.min(value, MAX_ATTENDANCE_LIMIT);
};

export const createParentViewAuth = (verifier: ParentViewVerifier): RequestHandler => async (req, res, next) => {
    try {
        const header = req.headers.authorization;
        const match = header ? /^Bearer\s+([^\s]+)$/i.exec(header) : null;
        if (!match) return res.status(401).json({ error: 'Authentication required' });
        const result = await verifier.verify(match[1]);
        if (!result.ok) {
            if (result.reason === 'secret-unavailable') return res.status(503).json({ error: 'Parent views are not available' });
            if (result.reason === 'expired') return res.status(401).json({ error: 'Parent view token expired' });
            if (result.reason === 'revoked-link' || result.reason === 'revoked-token') {
                return res.status(401).json({ error: 'Parent link is no longer active' });
            }
            return res.status(401).json({ error: 'Invalid parent view token' });
        }
        (req as ParentViewRequest).parentView = {
            linkId: result.claims.link_id,
            tenantId: result.claims.tenant_id,
            studentEnrollmentId: result.claims.student_enrollment_id,
            parentUserId: result.claims.parent_user_id,
        };
        next();
    } catch (error) {
        console.error('Parent view auth error:', error);
        res.status(500).json({ error: 'Failed to authenticate the parent view' });
    }
};

export const createParentViewsRouter = (deps: ParentViewsRouteDeps): Router => {
    const router = Router();
    router.use(createParentViewAuth(deps.verifier));

    const scope = (req: ParentViewRequest): ParentViewScope | null => req.parentView ?? null;

    router.get('/child', async (req: ParentViewRequest, res: Response) => {
        const view = scope(req);
        if (!view) return res.status(401).json({ error: 'Authentication required' });
        try {
            const child = await deps.store.findChildSummary(view.tenantId, view.studentEnrollmentId);
            if (!child) return res.status(404).json({ error: 'Child not found' });
            res.json(child);
        } catch (error) {
            console.error('Parent child view error:', error);
            res.status(500).json({ error: 'Failed to load the child summary' });
        }
    });

    router.get('/lesson-progress', async (req: ParentViewRequest, res: Response) => {
        const view = scope(req);
        if (!view) return res.status(401).json({ error: 'Authentication required' });
        try {
            res.json(await deps.store.lessonProgressSummary(view.tenantId, view.studentEnrollmentId));
        } catch (error) {
            console.error('Parent lesson progress error:', error);
            res.status(500).json({ error: 'Failed to load lesson progress' });
        }
    });

    router.get('/attendance', async (req: ParentViewRequest, res: Response) => {
        const view = scope(req);
        if (!view) return res.status(401).json({ error: 'Authentication required' });
        const limit = parseAttendanceLimit(req.query.limit);
        if (limit === null) return res.status(400).json({ error: 'limit must be a positive integer' });
        try {
            res.json(await deps.store.attendanceRecords(view.tenantId, view.studentEnrollmentId, limit));
        } catch (error) {
            console.error('Parent attendance view error:', error);
            res.status(500).json({ error: 'Failed to load attendance records' });
        }
    });

    router.get('/grades', async (req: ParentViewRequest, res: Response) => {
        const view = scope(req);
        if (!view) return res.status(401).json({ error: 'Authentication required' });
        try {
            res.json(await deps.store.gradeSummary(view.tenantId, view.studentEnrollmentId));
        } catch (error) {
            console.error('Parent grades view error:', error);
            res.status(500).json({ error: 'Failed to load the grades summary' });
        }
    });

    return router;
};

export function createSqlParentViewsStore(db: ParentViewsDataAccess): ParentViewsStore {
    const toIso = (value: unknown): string | null => {
        if (value === null || value === undefined) return null;
        const date = value instanceof Date ? value : new Date(String(value).includes('T') ? String(value) : String(value).replace(' ', 'T'));
        return Number.isFinite(date.getTime()) ? date.toISOString() : null;
    };
    const toNumber = (value: unknown): number => (value === null || value === undefined ? 0 : Number(value) || 0);

    return {
        findChildSummary: async (tenantId, enrollmentId) => db.queryOne<ChildSummary>(
            `SELECT s.id AS enrollment_id, s.name, g.name AS grade, grp.name AS \`group\`,
                    s.term, s.enrollment_status, s.created_at AS enrolled_at
             FROM students s
             LEFT JOIN grades g ON g.id = s.grade_id
             LEFT JOIN \`groups\` grp ON grp.id = s.group_id
             WHERE s.id = ? AND s.tenant_id = ? LIMIT 1`,
            [enrollmentId, tenantId],
        ),

        lessonProgressSummary: async (tenantId, enrollmentId) => {
            const rows = await db.query<{ course_id: string; course_name: string; total_lessons: number; completed_lessons: number }>(
                `SELECT c.id AS course_id, c.name AS course_name,
                        (SELECT COUNT(*) FROM lectures l
                          WHERE l.course_id = c.id AND l.is_published = 1 AND l.archived_at IS NULL) AS total_lessons,
                        (SELECT COUNT(*) FROM lesson_completions lc
                          JOIN lectures l2 ON l2.id = lc.lecture_id
                          WHERE lc.student_enrollment_id = ? AND lc.course_id = c.id
                            AND l2.is_published = 1 AND l2.archived_at IS NULL) AS completed_lessons
                 FROM courses c
                 WHERE c.tenant_id = ? AND c.is_active = 1
                   AND EXISTS (SELECT 1 FROM student_courses sc WHERE sc.student_id = ? AND sc.course_id = c.id)
                 ORDER BY c.name`,
                [enrollmentId, tenantId, enrollmentId],
            );
            const courses = rows.map((row) => ({
                course_id: String(row.course_id),
                course_name: String(row.course_name),
                completed_lessons: toNumber(row.completed_lessons),
                total_lessons: toNumber(row.total_lessons),
            }));
            return {
                courses,
                totals: {
                    completed_lessons: courses.reduce((sum, course) => sum + course.completed_lessons, 0),
                    total_lessons: courses.reduce((sum, course) => sum + course.total_lessons, 0),
                },
            };
        },

        attendanceRecords: async (tenantId, enrollmentId, limit) => db.query<AttendanceRecordView>(
            `SELECT a.session_id, ss.title, ss.starts_at, a.state, a.marked_at
             FROM attendance_records a
             JOIN schedule_sessions ss ON ss.id = a.session_id
             WHERE a.tenant_id = ? AND a.student_id = ?
             ORDER BY ss.starts_at DESC LIMIT ${limit}`,
            [tenantId, enrollmentId],
        ),

        gradeSummary: async (tenantId, enrollmentId) => {
            const rows = await db.query<{ course_id: string; course_name: string; total_score: number; total_max: number; items: number; last_recorded_at: unknown }>(
                `SELECT c.id AS course_id, c.name AS course_name,
                        SUM(gs.score) AS total_score, SUM(gs.max_score) AS total_max,
                        COUNT(*) AS items, MAX(gs.recorded_at) AS last_recorded_at
                 FROM gradebook_scores gs
                 JOIN courses c ON c.id = gs.course_id AND c.tenant_id = ?
                 WHERE gs.tenant_id = ? AND gs.student_enrollment_id = ?
                 GROUP BY c.id, c.name
                 ORDER BY c.name`,
                [tenantId, tenantId, enrollmentId],
            );
            return {
                courses: rows.map((row) => ({
                    course_id: String(row.course_id),
                    course_name: String(row.course_name),
                    total_score: toNumber(row.total_score),
                    total_max: toNumber(row.total_max),
                    items: toNumber(row.items),
                    last_recorded_at: toIso(row.last_recorded_at),
                })),
            };
        },
    };
}

let dbModule: typeof import('../db') | null = null;
const loadDb = async (): Promise<typeof import('../db')> => {
    dbModule ??= await import('../db');
    return dbModule;
};

const productionDb: ParentViewsDataAccess = {
    query: async <T = Record<string, unknown>>(sql: string, params?: unknown[]) => {
        const { query } = await loadDb();
        return query<T>(sql, params as never);
    },
    queryOne: async <T = Record<string, unknown>>(sql: string, params?: unknown[]) => {
        const { queryOne } = await loadDb();
        return queryOne<T>(sql, params as never);
    },
    execute: async (sql: string, params?: unknown[]) => {
        const { execute } = await loadDb();
        return execute(sql, params as never);
    },
};

export default createParentViewsRouter({
    store: createSqlParentViewsStore(productionDb),
    verifier: createParentViewVerifier({
        store: createSqlParentLinksStore(productionDb),
        getSecret: () => process.env.PARENT_VIEW_SECRET,
    }),
});
