import { Router, Request, Response, RequestHandler } from 'express';
import { query, queryOne } from '../db';
import { optionalAuth, authenticateToken, instructorScopeId, AuthRequest } from '../middleware/auth';
import { isSuperAdmin } from '../security/admin-permissions';

/**
 * Data-access seam for the exam-results router. Production binds ../db;
 * hermetic tests inject isolated fixtures through the same boundary so the
 * real authorization logic runs without a database.
 */
export interface ExamResultsDataAccess {
    query: typeof query;
    queryOne: typeof queryOne;
}

/**
 * Injectable seams for the exam-results router. Production binds the real SQL
 * adapters and the real optional/strict authentication middleware; tests
 * inject fixtures through this boundary instead of bypassing production auth.
 */
export interface ExamResultsRouterDeps {
    db: ExamResultsDataAccess;
    optionalAuthenticate: RequestHandler;
    authenticate: RequestHandler;
    isPlatformAdmin?: (userId: string) => Promise<boolean>;
    hasActiveInstructorMembership?: (userId: string, tenantId: string) => Promise<boolean>;
}

interface ExamResult {
    id: string;
    exam_id: string;
    exam_title: string;
    student_id: string; // user id
    student_name: string;
    grade_id?: string | null;
    group_id?: string | null;
    grade_name?: string | null;
    group_name?: string | null;
    score: number;
    total_marks: number;
    passing_marks?: number;
    status: 'pending' | 'graded' | 'submitted';
    submitted_at: string;
    graded_at?: string;
}

export const createExamResultsRouter = (deps: ExamResultsRouterDeps): Router => {
    const router = Router();
    const { query, queryOne } = deps.db;

    router.use(deps.optionalAuthenticate);

    const isPlatformAdmin = deps.isPlatformAdmin ?? isSuperAdmin;
    const isAdmin = async (req: AuthRequest): Promise<boolean> => {
        const user = req.user;
        if (!user || user.role !== 'admin' || !user.tenantId) return false;
        const owner = await queryOne(
            `SELECT t.id FROM tenants t
             INNER JOIN users u ON u.id = t.owner_user_id
             WHERE t.id = ? AND t.owner_user_id = ? AND t.status = 'active'
               AND u.is_active = 1 AND u.role = 'admin'`,
            [user.tenantId, user.id],
        );
        return !!owner;
    };
    const hasActiveInstructorMembership = deps.hasActiveInstructorMembership
        ?? (async (userId: string, tenantId: string) => !!(await queryOne(
            `SELECT m.user_id FROM tenant_memberships m
             INNER JOIN tenants t ON t.id = m.tenant_id AND t.status = 'active'
             INNER JOIN users u ON u.id = m.user_id AND u.is_active = 1
             WHERE m.user_id = ? AND m.tenant_id = ? AND m.status = 'active'
               AND m.role_key IN ('owner','instructor')`,
            [userId, tenantId],
        )));
    // Schema binds exam_results.student_id to students.id (enrollment ID).
    // Never guess a student row by matching either users.id or phone.
    const studentJoinSql = 'INNER JOIN students s ON s.id = er.student_id';

    // Get all exam results with filters
    router.get('/', deps.authenticate, async (req: AuthRequest, res: Response) => {
        try {
            const { exam_id, student_id } = req.query;
            const scopeId = instructorScopeId(req);
            const user = req.user;
            const platformAdmin = user?.role === 'admin' ? await isPlatformAdmin(user.id) : false;
            const admin = platformAdmin || await isAdmin(req);

            if ((!scopeId && !admin) || (!platformAdmin && !user?.tenantId)) {
                return res.status(403).json({ error: 'Forbidden' });
            }
            if (scopeId && !platformAdmin) {
                const tenantId = user?.tenantId;
                if (!user || !tenantId || !(await hasActiveInstructorMembership(user.id, tenantId))) {
                    return res.status(403).json({ error: 'Instructor workspace access required' });
                }
            }

            let sql = `
                SELECT
                    er.id,
                    er.exam_id,
                    e.title AS exam_title,
                    er.student_id,
                    COALESCE(u.name, s.name, 'طالب غير معروف') AS student_name,
                    s.grade_id,
                    s.group_id,
                    gr.name AS grade_name,
                    grp.name AS group_name,
                    er.marks_obtained AS score,
                    er.total_marks,
                    e.passing_marks,
                    'graded' AS status,
                    er.submitted_at,
                    er.graded_at
                FROM exam_results er
                INNER JOIN exams e ON e.id = er.exam_id
                LEFT JOIN users u ON u.id = s.user_id AND u.role = 'student'
                ${studentJoinSql}
                LEFT JOIN grades gr ON gr.id = s.grade_id
                LEFT JOIN \`groups\` grp ON grp.id = s.group_id
                WHERE 1=1
            `;
            const params: string[] = [];
            if (!platformAdmin) {
                const selectedTenantId = user?.tenantId;
                if (!selectedTenantId) return res.status(403).json({ error: 'Forbidden' });
                sql += ' AND s.tenant_id = ?';
                params.push(selectedTenantId);
            }

            if (exam_id) {
                sql += ' AND er.exam_id = ?';
                params.push(exam_id as string);
            }

            if (student_id) {
                sql += ' AND er.student_id = ?';
                params.push(student_id as string);
            }

            if (scopeId && !platformAdmin) {
                const selectedTenantId = user?.tenantId;
                if (!selectedTenantId) return res.status(403).json({ error: 'Forbidden' });
                sql += ` AND (s.instructor_id = ?
                          OR s.group_id IN (SELECT g.id FROM \`groups\` g
                              INNER JOIN courses c ON c.id = g.course_id
                              WHERE g.instructor_id = ? AND c.tenant_id = ?)
                          OR EXISTS (SELECT 1 FROM exam_groups eg
                              INNER JOIN \`groups\` g2 ON eg.group_id = g2.id
                              INNER JOIN courses c2 ON c2.id = g2.course_id
                              WHERE eg.exam_id = er.exam_id AND g2.id = s.group_id
                                AND g2.instructor_id = ? AND c2.tenant_id = ?))`;
                params.push(scopeId, scopeId, selectedTenantId, scopeId, selectedTenantId);
            }

            sql += ' ORDER BY er.submitted_at DESC';

            const results = await query<ExamResult>(sql, params);
            res.json(results);
        } catch {
            console.error('Get exam results failed');
            res.status(500).json({ error: 'Failed to fetch exam results' });
        }
    });

    // Get all results for a specific student
    router.get('/student/:studentId', deps.authenticate, async (req: AuthRequest, res: Response) => {
        try {
            const { studentId } = req.params;

            const platformAdmin = req.user?.role === 'admin' ? await isPlatformAdmin(req.user.id) : false;
            const admin = platformAdmin || await isAdmin(req);
            const studentSelf = req.user?.role === 'student';
            if (!studentSelf && !admin) {
                return res.status(403).json({ error: 'Student workspace access required' });
            }
            const tenantId = admin && !platformAdmin ? req.user?.tenantId : undefined;
            if (admin && !platformAdmin && !tenantId) {
                return res.status(403).json({ error: 'Workspace access required' });
            }
            const selectedTenantId = studentSelf ? req.user?.tenantId : tenantId;
            if (studentSelf && !selectedTenantId) return res.status(404).json({ error: 'Student not found' });

            let enrollmentIds: string[];
            if (studentSelf) {
                const userId = req.user?.id as string;
                const rows = studentId === userId
                    ? await query<{ id: string }>(
                        `SELECT id FROM students WHERE user_id = ? AND tenant_id = ? AND is_active = 1`,
                        [userId, selectedTenantId],
                    )
                    : await query<{ id: string }>(
                        `SELECT id FROM students WHERE id = ? AND user_id = ? AND tenant_id = ? AND is_active = 1`,
                        [studentId, userId, selectedTenantId],
                    );
                enrollmentIds = rows.map(({ id }) => id);
                if (enrollmentIds.length === 0 && studentId !== userId) {
                    return res.status(403).json({ error: 'Student workspace access required' });
                }
                if (studentId === userId && enrollmentIds.length > 1) {
                    return res.status(404).json({ error: 'Student enrollment is ambiguous' });
                }
            } else {
                const idRows = await query<{ id: string }>(
                    `SELECT id FROM students WHERE id = ?${tenantId ? ' AND tenant_id = ?' : ''}`,
                    tenantId ? [studentId, tenantId] : [studentId],
                );
                const userRows = await query<{ id: string }>(
                    `SELECT id FROM students WHERE user_id = ?${tenantId ? ' AND tenant_id = ?' : ''}`,
                    tenantId ? [studentId, tenantId] : [studentId],
                );
                if (idRows.length && userRows.some(({ id }) => idRows[0].id !== id)) {
                    return res.status(404).json({ error: 'Student not found' });
                }
                enrollmentIds = idRows.length ? [idRows[0].id] : userRows.map(({ id }) => id);
            }
            if (enrollmentIds.length === 0) return res.status(404).json({ error: 'Student not found' });
            const enrollmentSelector = `s.id IN (${enrollmentIds.map(() => '?').join(', ')})`;
            const tenantClause = selectedTenantId ? ' AND s.tenant_id = ?' : '';
            const params: unknown[] = [...enrollmentIds];
            if (selectedTenantId) params.push(selectedTenantId);
            params.push(...enrollmentIds);
            if (selectedTenantId) params.push(selectedTenantId);

            // Map both sources through their FK enrollment, then to its user.
            // A user may have multiple valid enrollments, so return each exact
            // enrollment row instead of selecting an arbitrary LIMIT 1 match.
            const sql = `
                SELECT
                    er.id AS id,
                    er.exam_id AS exam_id,
                    e.title AS exam_title,
                    s.user_id AS student_id,
                    er.marks_obtained AS score,
                    er.total_marks AS total_marks,
                    e.passing_marks,
                    'graded' AS status,
                    er.submitted_at AS submitted_at,
                    er.graded_at AS graded_at,
                    er.remarks AS feedback,
                    'exam_results' AS source
                FROM exam_results er
                INNER JOIN students s ON s.id = er.student_id
                INNER JOIN exams e ON e.id = er.exam_id
                WHERE ${enrollmentSelector}${tenantClause}
                UNION ALL
                SELECT
                    ea.id AS id,
                    ea.exam_id AS exam_id,
                    e.title AS exam_title,
                    s.user_id AS student_id,
                    ea.score AS score,
                    e.total_marks AS total_marks,
                    e.passing_marks,
                    ea.status AS status,
                    COALESCE(ea.completed_at, ea.created_at) AS submitted_at,
                    ea.completed_at AS graded_at,
                    NULL AS feedback,
                    'exam_attempts' AS source
                FROM exam_attempts ea
                INNER JOIN students s ON s.id = ea.student_id
                INNER JOIN exams e ON e.id = ea.exam_id
                WHERE ea.status IN ('completed', 'passed', 'failed', 'pending_review')
                  AND ${enrollmentSelector}${tenantClause}
                ORDER BY submitted_at DESC
            `;

            const results = await query<Record<string, unknown>>(sql, params);
            res.json(results);
        } catch {
            console.error('Get student exam results failed');
            res.status(500).json({ error: 'Failed to fetch student exam results' });
        }
    });

    // Get exam result by ID
    router.get('/:id', deps.authenticate, async (req: AuthRequest, res: Response) => {
        try {
            const { id } = req.params;
            const scopeId = instructorScopeId(req);
            const user = req.user;
            const platformAdmin = user?.role === 'admin' ? await isPlatformAdmin(user.id) : false;
            const admin = platformAdmin || await isAdmin(req);
            const studentSelf = user?.role === 'student';
            if (!scopeId && !admin && !studentSelf) {
                return res.status(403).json({ error: 'Forbidden' });
            }
            if (scopeId && !platformAdmin) {
                const tenantId = user?.tenantId;
                if (!user || !tenantId || !(await hasActiveInstructorMembership(user.id, tenantId))) {
                    return res.status(403).json({ error: 'Instructor workspace access required' });
                }
            }

            const sql = `
                SELECT
                    er.id,
                    er.exam_id,
                    e.title AS exam_title,
                    er.student_id,
                    COALESCE(u.name, s.name, 'طالب غير معروف') AS student_name,
                    s.grade_id,
                    s.group_id,
                    gr.name AS grade_name,
                    grp.name AS group_name,
                    er.marks_obtained AS score,
                    er.total_marks,
                    e.passing_marks,
                    'graded' AS status,
                    NULL AS answers,
                    er.submitted_at,
                    er.graded_at,
                    er.graded_by,
                    er.remarks AS feedback
                FROM exam_results er
                INNER JOIN exams e ON e.id = er.exam_id
                LEFT JOIN users u ON u.id = s.user_id AND u.role = 'student'
                ${studentJoinSql}
                LEFT JOIN grades gr ON gr.id = s.grade_id
                LEFT JOIN \`groups\` grp ON grp.id = s.group_id
                WHERE er.id = ?
            `;
            const params: unknown[] = [id];
            let scopedSql = sql;
            if (!platformAdmin) {
                const tenantId = user?.tenantId;
                if (!tenantId) return res.status(403).json({ error: 'Workspace access required' });
                scopedSql += ' AND s.tenant_id = ?';
                params.push(tenantId);
                if (scopeId) {
                    scopedSql += ` AND (s.instructor_id = ?
                        OR EXISTS (SELECT 1 FROM \`groups\` g
                            INNER JOIN courses c ON c.id = g.course_id
                            WHERE g.id = s.group_id AND g.instructor_id = ? AND c.tenant_id = ?)
                        OR EXISTS (SELECT 1 FROM exam_groups eg
                            INNER JOIN \`groups\` g2 ON eg.group_id = g2.id
                            INNER JOIN courses c2 ON c2.id = g2.course_id
                            WHERE eg.exam_id = er.exam_id AND g2.id = s.group_id
                              AND g2.instructor_id = ? AND c2.tenant_id = ?))`;
                    params.push(scopeId, scopeId, tenantId, scopeId, tenantId);
                } else if (studentSelf) {
                    scopedSql += ' AND (er.student_id = ? OR s.user_id = ?)';
                    params.push(user?.id, user?.id);
                }
            }

            const results = await query<Record<string, unknown>>(scopedSql, params);
            if (results.length === 0) {
                return res.status(404).json({ error: 'Exam result not found' });
            }

            res.json(results[0]);
        } catch {
            console.error('Get exam result failed');
            res.status(500).json({ error: 'Failed to fetch exam result' });
        }
    });

    return router;
};

/** Production wiring: real pool and real auth middleware. */
export default createExamResultsRouter({
    db: { query, queryOne },
    optionalAuthenticate: optionalAuth,
    authenticate: authenticateToken,
});
