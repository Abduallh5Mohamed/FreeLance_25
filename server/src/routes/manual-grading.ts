import express, { Response, RequestHandler } from 'express';
import { query, queryOne, execute, getPool } from '../db';
import { optionalAuth, authenticateToken, instructorScopeId, AuthRequest } from '../middleware/auth';
import { isSuperAdmin } from '../security/admin-permissions';

/**
 * Data-access seam for the manual-grading router. Production binds ../db;
 * hermetic tests inject isolated fixtures through the same boundary so the
 * real authorization logic runs without a database.
 */
export interface ManualGradingDataAccess {
    query: typeof query;
    queryOne: typeof queryOne;
    execute: typeof execute;
    withTransaction: <T>(
        work: (tx: Pick<ManualGradingDataAccess, 'query' | 'queryOne' | 'execute'>) => Promise<T>,
    ) => Promise<T>;
}

type ManualGradingPool = Pick<ReturnType<typeof getPool>, 'getConnection'>;

/** Create the production transaction seam; on rollback failure destroy the
 * connection so mysql2 cannot return an indeterminate transaction to the pool. */
export const createManualGradingTransactionAdapter = (getPoolAdapter: () => ManualGradingPool): NonNullable<ManualGradingDataAccess['withTransaction']> =>
    async <T>(work: (tx: Pick<ManualGradingDataAccess, 'query' | 'queryOne' | 'execute'>) => Promise<T>): Promise<T> => {
        const pool = getPoolAdapter();
        const connection = await pool.getConnection();
        let transactionStarted = false;
        let reusable = true;
        let primaryFailure = false;
        try {
            await connection.beginTransaction();
            transactionStarted = true;
            const tx: Pick<ManualGradingDataAccess, 'query' | 'queryOne' | 'execute'> = {
                query: async <R>(sql: string, params?: unknown[]): Promise<R[]> => {
                    const [rows] = await connection.execute(sql, params as Parameters<typeof execute>[1]);
                    return rows as R[];
                },
                queryOne: async <R>(sql: string, params?: unknown[]): Promise<R | null> => {
                    const [rows] = await connection.execute(sql, params as Parameters<typeof execute>[1]);
                    const list = rows as R[];
                    return list.length ? list[0] : null;
                },
                execute: async (sql: string, params?: unknown[]) => {
                    const [result] = await connection.execute(sql, params as Parameters<typeof execute>[1]);
                    return result as Awaited<ReturnType<typeof execute>>;
                },
            };
            const result = await work(tx);
            await connection.commit();
            transactionStarted = false;
            return result;
        } catch (primaryError) {
            primaryFailure = true;
            if (transactionStarted) {
                try {
                    await connection.rollback();
                } catch {
                    reusable = false;
                    try { connection.destroy(); } catch { /* preserve primary failure */ }
                }
            }
            throw primaryError;
        } finally {
            if (reusable) {
                try {
                    connection.release();
                } catch (releaseError) {
                    if (!primaryFailure) throw releaseError;
                }
            }
        }
    };

/**
 * Injectable seams for the manual-grading router. Production binds the real SQL
 * adapters and the real optional/strict authentication middleware; tests
 * inject fixtures through this boundary instead of bypassing production auth.
 */
export interface ManualGradingRouterDeps {
    db: ManualGradingDataAccess;
    optionalAuthenticate: RequestHandler;
    authenticate: RequestHandler;
    isPlatformAdmin?: (userId: string) => Promise<boolean>;
    hasActiveInstructorMembership?: (userId: string, tenantId: string) => Promise<boolean>;
}

interface GradingStudent {
    id: string;
}

interface PendingAttempt {
    exam_id: string;
    student_id: string;
    auto_score: number | string | null;
    answers: unknown;
    submitted_at: string | Date | null;
    exam_title: string;
    total_marks: number | string;
    student_name: string | null;
    grade_id: string;
    group_id: string | null;
}

interface EssayQuestion {
    id: string;
    question_text: string;
    points: number | string;
    question_type: string;
}

interface GradingAttempt {
    id: string;
    status: string;
    score: number | string | null;
}

interface ExamScoringConfig {
    total_marks: number | string;
    passing_marks: number | string;
}

const parseRecord = (value: unknown): Record<string, unknown> => {
    let candidate = value;
    if (typeof candidate === 'string') {
        try {
            candidate = JSON.parse(candidate) as unknown;
        } catch {
            return {};
        }
    }
    return typeof candidate === 'object' && candidate !== null && !Array.isArray(candidate)
        ? candidate as Record<string, unknown>
        : {};
};

const toHundredths = (value: unknown): number | null => {
    if (typeof value !== 'number' && typeof value !== 'string') return null;
    if (typeof value === 'string' && !/^\d+(?:\.\d{1,2})?$/.test(value.trim())) return null;
    const numeric = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(numeric) || numeric < 0) return null;
    const scaled = Math.round(numeric * 100);
    if (!Number.isSafeInteger(scaled) || Math.abs(numeric * 100 - scaled) > 1e-7) return null;
    return scaled;
};

const formatHundredths = (value: number): string =>
    `${Math.floor(value / 100)}.${String(value % 100).padStart(2, '0')}`;

export const createManualGradingRouter = (deps: ManualGradingRouterDeps): express.Router => {
    const router = express.Router();
    const { query, queryOne, execute } = deps.db;
    const runTransaction = deps.db.withTransaction;

    router.use(deps.optionalAuthenticate);

    const isPlatformAdmin = deps.isPlatformAdmin ?? isSuperAdmin;
    const resolveAdminScope = async (
        req: AuthRequest,
    ): Promise<{ platform: boolean; tenantId: string | null } | null> => {
        const user = req.user;
        if (!user) return null;
        if (user.role !== 'admin') return null;
        if (await isPlatformAdmin(user.id)) {
            return { platform: true, tenantId: user.tenantId ?? null };
        }
        if (!user.tenantId) return null;
        const owner = await queryOne(
            `SELECT t.id FROM tenants t
             INNER JOIN users u ON u.id = t.owner_user_id
             WHERE t.id = ? AND t.owner_user_id = ? AND t.status = 'active'
               AND u.is_active = 1 AND u.role = 'admin'`,
            [user.tenantId, user.id],
        );
        return owner ? { platform: false, tenantId: user.tenantId } : null;
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

    const isExamStudentInScope = async (
        data: Pick<ManualGradingDataAccess, 'queryOne'>,
        examId: string,
        student: GradingStudent,
        tenantId: string | null,
        instructorId: string | null,
    ): Promise<boolean> => {
        let sql = `SELECT eg.exam_id
                   FROM exam_groups eg
                   INNER JOIN \`groups\` g ON eg.group_id = g.id
                   INNER JOIN courses c ON c.id = g.course_id
                   INNER JOIN students s ON s.group_id = g.id
                   WHERE eg.exam_id = ?`;
        const params: unknown[] = [examId];
        if (instructorId) {
            sql += ' AND g.instructor_id = ?';
            params.push(instructorId);
        }
        sql += ' AND s.id = ?';
        params.push(student.id);
        if (tenantId) {
            sql += ' AND s.tenant_id = ? AND c.tenant_id = ?';
            params.push(tenantId, tenantId);
        }
        return !!(await data.queryOne(sql, params));
    };

    // Get pending essay grading attempts by grade and group
    router.get('/pending', deps.authenticate, async (req: AuthRequest, res: Response) => {
        try {
            const { grade_id, group_id } = req.query;
            const scopeId = instructorScopeId(req);
            const adminScope = await resolveAdminScope(req);
            const tenantId = scopeId ? req.user?.tenantId ?? null : adminScope?.tenantId ?? null;
            if (!scopeId && !adminScope) return res.status(403).json({ error: 'Forbidden' });
            if (scopeId && !tenantId) return res.status(403).json({ error: 'Workspace access required' });
            if (scopeId && req.user && tenantId
                && !(await hasActiveInstructorMembership(req.user.id, tenantId))) {
                return res.status(403).json({ error: 'Instructor workspace access required' });
            }
            if (typeof grade_id !== 'string' || grade_id.trim() === '') {
                return res.status(400).json({ error: 'Grade ID is required' });
            }

            const groupId = typeof group_id === 'string' && group_id !== 'all' ? group_id : undefined;
            if (group_id !== undefined && group_id !== 'all' && !groupId) {
                return res.status(400).json({ error: 'Invalid group ID' });
            }

            let sql = `
                SELECT ea.exam_id, ea.student_id, ea.score as auto_score, ea.answers,
                       ea.completed_at AS submitted_at, e.title AS exam_title, e.total_marks,
                       u.name AS student_name, s.grade_id, s.group_id
                FROM exam_attempts ea
                INNER JOIN exams e ON e.id = ea.exam_id
                INNER JOIN students s ON s.id = ea.student_id
                LEFT JOIN users u ON u.id = s.user_id AND u.role = 'student'
                WHERE ea.status = 'pending_review' AND s.grade_id = ?
                  AND EXISTS (
                      SELECT 1 FROM exam_groups eg
                      INNER JOIN \`groups\` g ON g.id = eg.group_id
                      INNER JOIN courses c ON c.id = g.course_id
                      WHERE eg.exam_id = ea.exam_id AND g.id = s.group_id
                  )`;
            const params: unknown[] = [grade_id.trim()];
            if (groupId) {
                sql += ' AND s.group_id = ?';
                params.push(groupId);
            }
            if (tenantId) {
                sql += ` AND s.tenant_id = ? AND EXISTS (
                    SELECT 1 FROM exam_groups eg
                    INNER JOIN \`groups\` g ON g.id = eg.group_id
                    INNER JOIN courses c ON c.id = g.course_id
                    WHERE eg.exam_id = ea.exam_id AND g.id = s.group_id AND c.tenant_id = ?`;
                params.push(tenantId, tenantId);
                if (scopeId) {
                    sql += ' AND g.instructor_id = ?';
                    params.push(scopeId);
                }
                sql += ')';
            }
            sql += ' ORDER BY ea.completed_at DESC LIMIT 1000';

            const attempts = await query<PendingAttempt>(sql, params);
            const results = await Promise.all(attempts.map(async (attempt) => {
                const questions = await query<EssayQuestion>(
                    `SELECT id, question_text, points, question_type
                     FROM exam_questions
                     WHERE exam_id = ? AND question_type = 'essay'
                     ORDER BY display_order`,
                    [attempt.exam_id]
                );
                const answers = parseRecord(attempt.answers);
                const essayAnswers = parseRecord(answers.essay);
                const imageAnswers = parseRecord(answers.images);
                const essayQuestions = questions.map((question) => ({
                    id: question.id,
                    question_text: question.question_text,
                    points: question.points,
                    student_answer: typeof essayAnswers[question.id] === 'string' ? essayAnswers[question.id] : '',
                    student_image: typeof imageAnswers[question.id] === 'string' ? imageAnswers[question.id] : '',
                }));

                return {
                    student_id: attempt.student_id,
                    student_name: attempt.student_name,
                    exam_id: attempt.exam_id,
                    exam_title: attempt.exam_title,
                    auto_score: attempt.auto_score ?? 0,
                    total_marks: attempt.total_marks,
                    essay_questions: essayQuestions,
                    status: 'pending_review',
                    submitted_at: attempt.submitted_at,
                };
            }));

            res.json(results);
        } catch {
            console.error('Get pending attempts failed');
            res.status(500).json({ error: 'Failed to fetch pending attempts' });
        }
    });

    // Submit manual grading scores
    router.post('/submit', deps.authenticate, async (req: AuthRequest, res: Response) => {
        try {
            const body = typeof req.body === 'object' && req.body !== null
                ? req.body as Record<string, unknown>
                : {};
            const examId = typeof body.exam_id === 'string' ? body.exam_id : '';
            const suppliedStudentId = typeof body.student_id === 'string' ? body.student_id : '';
            const essayScores = typeof body.essay_scores === 'object'
                && body.essay_scores !== null
                && !Array.isArray(body.essay_scores)
                ? body.essay_scores as Record<string, unknown>
                : null;
            const requestedTotal = toHundredths(body.total_score);
            if (!examId || !suppliedStudentId || !essayScores || requestedTotal === null) {
                return res.status(400).json({ error: 'Missing or invalid grading fields' });
            }

            const scopeId = instructorScopeId(req);
            const adminScope = await resolveAdminScope(req);
            if (!scopeId && !adminScope) return res.status(403).json({ error: 'Forbidden' });
            const tenantId = scopeId ? req.user?.tenantId ?? null : adminScope?.tenantId ?? null;
            if (scopeId && !tenantId) return res.status(403).json({ error: 'Workspace access required' });
            if (scopeId && req.user && tenantId
                && !(await hasActiveInstructorMembership(req.user.id, tenantId))) {
                return res.status(403).json({ error: 'Instructor workspace access required' });
            }
            const effectiveTenantId = adminScope?.platform ? null : tenantId;
            const effectiveInstructorId = adminScope?.platform ? null : scopeId;
            const graderId = req.user?.id;
            if (!graderId) return res.status(401).json({ error: 'Authentication required' });
            if (typeof runTransaction !== 'function') {
                return res.status(503).json({ error: 'Grading transaction service unavailable' });
            }

            const outcome = await runTransaction(async (tx) => {
                const tenantClause = effectiveTenantId ? ' AND tenant_id = ?' : '';
                const tenantParams = effectiveTenantId ? [effectiveTenantId] : [];
                const exactEnrollment = await tx.queryOne<GradingStudent>(
                    `SELECT id FROM students WHERE id = ? AND is_active = 1${tenantClause}`,
                    [suppliedStudentId, ...tenantParams],
                );
                const matchingEnrollments = exactEnrollment ? [] : await tx.query<GradingStudent>(
                    `SELECT id FROM students WHERE user_id = ? AND is_active = 1${tenantClause}`,
                    [suppliedStudentId, ...tenantParams],
                );
                const student = exactEnrollment
                    ?? (matchingEnrollments.length === 1 ? matchingEnrollments[0] : null);
                if (!student) return { status: 404, body: { error: 'Student not found' } };
                if (!(await isExamStudentInScope(
                    tx, examId, student, effectiveTenantId, effectiveInstructorId,
                ))) {
                    return { status: 404, body: { error: 'Exam attempt not found' } };
                }

                const attempt = await tx.queryOne<GradingAttempt>(
                    `SELECT ea.id, ea.status, ea.score
                     FROM exam_attempts ea
                     WHERE ea.exam_id = ? AND ea.student_id = ?
                     FOR UPDATE`,
                    [examId, student.id],
                );
                if (!attempt) return { status: 404, body: { error: 'Exam attempt not found' } };
                if (attempt.status !== 'pending_review') {
                    return { status: 409, body: { error: 'This attempt is not awaiting manual grading' } };
                }
                const scoringConfig = await tx.queryOne<ExamScoringConfig>(
                    'SELECT total_marks, passing_marks FROM exams WHERE id = ? FOR UPDATE',
                    [examId],
                );
                if (!scoringConfig) return { status: 409, body: { error: 'Exam scoring configuration is invalid' } };

                const questions = await tx.query<{ id: string; points: number | string }>(
                    `SELECT id, question_type as type, correct_answer, points FROM exam_questions
                     WHERE exam_id = ? AND question_type = 'essay'`,
                    [examId],
                );
                const questionPoints = new Map<string, number>();
                for (const question of questions) {
                    const points = toHundredths(question.points);
                    if (points === null) {
                        return { status: 409, body: { error: 'Exam scoring configuration is invalid' } };
                    }
                    questionPoints.set(question.id, points);
                }
                const submittedQuestionIds = Object.keys(essayScores);
                if (submittedQuestionIds.length !== questionPoints.size
                    || submittedQuestionIds.some((questionId) => !questionPoints.has(questionId))) {
                    return { status: 400, body: { error: 'Essay scores do not match the exam questions' } };
                }

                let essayTotal = 0;
                const normalizedScores: Record<string, { score: number; feedback?: string }> = {};
                const answerScores: Array<{ questionId: string; score: number; points: number }> = [];
                for (const questionId of submittedQuestionIds) {
                    const rawGrade = essayScores[questionId];
                    const gradeRecord = typeof rawGrade === 'object' && rawGrade !== null && !Array.isArray(rawGrade)
                        ? rawGrade as Record<string, unknown>
                        : null;
                    const score = toHundredths(gradeRecord ? gradeRecord.score : rawGrade);
                    const points = questionPoints.get(questionId);
                    const feedback = gradeRecord?.feedback;
                    if (score === null || points === undefined || score > points
                        || (feedback !== undefined && (typeof feedback !== 'string' || feedback.length > 2000))) {
                        return { status: 400, body: { error: 'Invalid essay score' } };
                    }
                    essayTotal += score;
                    normalizedScores[questionId] = {
                        score: score / 100,
                        ...(typeof feedback === 'string' ? { feedback } : {}),
                    };
                    answerScores.push({ questionId, score, points });
                }

                const autoScore = toHundredths(attempt.score);
                const totalMarks = toHundredths(scoringConfig.total_marks);
                const passingMarks = toHundredths(scoringConfig.passing_marks);
                if (autoScore === null || totalMarks === null || passingMarks === null || totalMarks === 0) {
                    return { status: 409, body: { error: 'Exam scoring configuration is invalid' } };
                }
                const computedTotal = autoScore + essayTotal;
                if (computedTotal !== requestedTotal || computedTotal > totalMarks) {
                    return { status: 400, body: { error: 'Total score does not match the validated scores' } };
                }

                const status = computedTotal >= passingMarks ? 'passed' : 'failed';
                const percentage = (computedTotal / totalMarks) * 100;
                let grade = 'F';
                if (percentage >= 90) grade = 'A+';
                else if (percentage >= 85) grade = 'A';
                else if (percentage >= 80) grade = 'B+';
                else if (percentage >= 75) grade = 'B';
                else if (percentage >= 70) grade = 'C+';
                else if (percentage >= 65) grade = 'C';
                else if (percentage >= 60) grade = 'D';

                const transition = await tx.execute(
                    `UPDATE exam_attempts
                     SET score = ?, status = ?, essay_scores = ?
                     WHERE exam_id = ? AND student_id = ? AND id = ? AND status = 'pending_review'`,
                    [formatHundredths(computedTotal), status, JSON.stringify(normalizedScores),
                        examId, student.id, attempt.id],
                );
                if (transition.affectedRows === 0) {
                    return { status: 409, body: { error: 'This attempt is not awaiting manual grading' } };
                }
                const resultTransition = await tx.execute(
                    `UPDATE exam_results
                     SET marks_obtained = ?, grade = ?, graded_at = NOW(), graded_by = ?
                     WHERE exam_id = ? AND student_id = ?`,
                    [formatHundredths(computedTotal), grade, graderId, examId, student.id],
                );
                if (resultTransition.affectedRows === 0) {
                    throw new Error('Exam result row missing for pending attempt');
                }
                for (const answer of answerScores) {
                    await tx.execute(
                        `UPDATE exam_student_answers
                         SET points_earned = ?, is_correct = ?
                         WHERE exam_id = ? AND student_id = ? AND question_id = ?`,
                        [formatHundredths(answer.score), answer.score === answer.points ? 1 : 0,
                            examId, student.id, answer.questionId],
                    );
                }

                return {
                    status: 200,
                    body: {
                        success: true,
                        total_score: computedTotal / 100,
                        status,
                        passed: status === 'passed',
                    },
                };
            });
            res.status(outcome.status).json(outcome.body);
        } catch {
            console.error('Submit manual grading failed');
            res.status(500).json({ error: 'Failed to submit grades' });
        }
    });

    return router;
};

/** Production transaction adapter: grading state and all derived writes commit together. */
const withTransaction = createManualGradingTransactionAdapter(() => getPool());

/** Production wiring: real pool and real auth middleware. */
export default createManualGradingRouter({
    db: { query, queryOne, execute, withTransaction },
    optionalAuthenticate: optionalAuth,
    authenticate: authenticateToken,
});
