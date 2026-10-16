import { Router, Request, Response, RequestHandler } from 'express';
import { query, queryOne } from '../db';
import { optionalAuth, authenticateToken, instructorScopeId, AuthRequest } from '../middleware/auth';

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

    const isAdmin = (req: AuthRequest): boolean => req.user?.role === 'admin';
    const isStudentSelf = (req: AuthRequest, id: unknown): boolean =>
        req.user?.role === 'student' && String(req.user.id) === String(id);

    // Get all exam results with filters
    router.get('/', deps.authenticate, async (req: AuthRequest, res: Response) => {
        try {
            const { exam_id, student_id } = req.query;
            const scopeId = instructorScopeId(req);

            // Teacher/admin listing: a bare student (or any other principal that
            // is neither an owning instructor nor an admin) is denied instead
            // of receiving an unscoped cross-tenant view.
            if (!scopeId && !isAdmin(req)) {
                return res.status(403).json({ error: 'Forbidden' });
            }

            let sql = `
                SELECT
                    er.id,
                    er.exam_id,
                    e.title AS exam_title,
                    er.student_id,
                    COALESCE(u.name, 'طالب غير معروف') AS student_name,
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
                LEFT JOIN users u ON u.id = er.student_id AND u.role = 'student'
                /* Match student by phone since users table doesn't have student_id */
                LEFT JOIN students s ON s.phone = u.phone
                LEFT JOIN grades gr ON gr.id = s.grade_id
                LEFT JOIN \`groups\` grp ON grp.id = s.group_id
                WHERE 1=1
            `;
            const params: string[] = [];

            if (exam_id) {
                sql += ' AND er.exam_id = ?';
                params.push(exam_id as string);
            }

            if (student_id) {
                sql += ' AND er.student_id = ?';
                params.push(student_id as string);
            }

            if (scopeId) {
                // Instructors only see results of their students / their own exams
                sql += ` AND (s.instructor_id = ?
                          OR s.group_id IN (SELECT id FROM \`groups\` WHERE instructor_id = ?)
                          OR er.exam_id IN (SELECT eg.exam_id FROM exam_groups eg INNER JOIN \`groups\` g2 ON eg.group_id = g2.id WHERE g2.instructor_id = ?))`;
                params.push(scopeId, scopeId, scopeId);
            }

            sql += ' ORDER BY er.submitted_at DESC';

            const results = await query<ExamResult>(sql, params);
            res.json(results);
        } catch (error) {
            console.error('Get exam results error:', error);
            res.status(500).json({ error: 'Failed to fetch exam results', details: error instanceof Error ? error.message : 'Unknown error' });
        }
    });

    // Get all results for a specific student
    router.get('/student/:studentId', deps.authenticate, async (req: AuthRequest, res: Response) => {
        try {
            const { studentId } = req.params;

            // Own-workspace access only: the student may read their own
            // results; a platform admin is trusted. Any other principal is
            // denied before any data access (no forged studentId enumeration).
            if (!isStudentSelf(req, studentId) && !isAdmin(req)) {
                return res.status(403).json({ error: 'Student workspace access required' });
            }

            console.log('📊 Fetching exam results for student:', studentId);

            // Get results from BOTH exam_results AND exam_attempts
            const sql = `
                SELECT
                    COALESCE(er.id, ea.id) AS id,
                    COALESCE(er.exam_id, ea.exam_id) AS exam_id,
                    e.title AS exam_title,
                    COALESCE(er.student_id, ea.student_id) AS student_id,
                    COALESCE(er.marks_obtained, ea.score) AS score,
                    COALESCE(er.total_marks, e.total_marks) AS total_marks,
                    e.passing_marks,
                    COALESCE(ea.status,
                        CASE
                            WHEN COALESCE(er.marks_obtained, ea.score) >= e.passing_marks THEN 'passed'
                            ELSE 'failed'
                        END
                    ) AS status,
                    COALESCE(er.submitted_at, ea.completed_at, ea.created_at) AS submitted_at,
                    COALESCE(er.graded_at, ea.completed_at) AS graded_at,
                    er.remarks AS feedback,
                    CASE WHEN er.id IS NOT NULL THEN 'exam_results' ELSE 'exam_attempts' END AS source
                FROM exams e
                LEFT JOIN exam_results er ON er.exam_id = e.id AND er.student_id = ?
                LEFT JOIN exam_attempts ea ON ea.exam_id = e.id AND ea.student_id = ? AND ea.status IN ('completed', 'passed', 'failed', 'pending_review')
                WHERE (er.id IS NOT NULL OR ea.id IS NOT NULL)
                ORDER BY COALESCE(er.submitted_at, ea.completed_at, ea.created_at) DESC
            `;

            const results = await query<any>(sql, [studentId, studentId]);

            console.log(`📊 Found ${results.length} exam results (from both tables)`);
            console.log('Results:', results.map((r: any) => ({
                exam_title: r.exam_title,
                score: r.score,
                status: r.status,
                source: r.source
            })));

            res.json(results);
        } catch (error) {
            console.error('Get student exam results error:', error);
            res.status(500).json({ error: 'Failed to fetch student exam results', details: error instanceof Error ? error.message : 'Unknown error' });
        }
    });

    // Get exam result by ID
    router.get('/:id', deps.authenticate, async (req: AuthRequest, res: Response) => {
        try {
            const { id } = req.params;
            const scopeId = instructorScopeId(req);

            const sql = `
                SELECT
                    er.id,
                    er.exam_id,
                    e.title AS exam_title,
                    er.student_id,
                    COALESCE(u.name, 'طالب غير معروف') AS student_name,
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
                LEFT JOIN users u ON u.id = er.student_id AND u.role = 'student'
                LEFT JOIN students s ON s.phone = u.phone
                LEFT JOIN grades gr ON gr.id = s.grade_id
                LEFT JOIN \`groups\` grp ON grp.id = s.group_id
                WHERE er.id = ?
            `;

            const results = await query<any>(sql, [id]);
            if (results.length === 0) {
                return res.status(404).json({ error: 'Exam result not found' });
            }
            if (scopeId) {
                const r = results[0];
                // Results join users by er.student_id; resolve the user's phone to
                // check the student belongs to the instructor
                const userRow = await queryOne('SELECT phone FROM users WHERE id = ?', [r.student_id]);
                const own = await queryOne(
                    `SELECT s.id FROM students s LEFT JOIN \`groups\` g ON s.group_id = g.id
                     WHERE s.phone = ? AND (s.instructor_id = ? OR g.instructor_id = ?)`,
                    [userRow?.phone ?? null, scopeId, scopeId]
                );
                const ownExam = await queryOne(
                    `SELECT eg.exam_id FROM exam_groups eg INNER JOIN \`groups\` g2 ON eg.group_id = g2.id
                     WHERE eg.exam_id = ? AND g2.instructor_id = ? LIMIT 1`,
                    [r.exam_id, scopeId]
                );
                if (!own && !ownExam) {
                    return res.status(404).json({ error: 'Exam result not found' });
                }
            } else if (!isAdmin(req)) {
                // Non-instructor, non-admin principals get no cross-tenant
                // result detail (fail closed).
                return res.status(403).json({ error: 'Forbidden' });
            }

            res.json(results[0]);
        } catch (error) {
            console.error('Get exam result error:', error);
            res.status(500).json({ error: 'Failed to fetch exam result', details: error instanceof Error ? error.message : 'Unknown error' });
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
