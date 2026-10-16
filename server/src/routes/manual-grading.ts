import express, { Request, Response, RequestHandler } from 'express';
import { query, queryOne, execute } from '../db';
import { optionalAuth, authenticateToken, instructorScopeId, AuthRequest } from '../middleware/auth';

/**
 * Data-access seam for the manual-grading router. Production binds ../db;
 * hermetic tests inject isolated fixtures through the same boundary so the
 * real authorization logic runs without a database.
 */
export interface ManualGradingDataAccess {
    query: typeof query;
    queryOne: typeof queryOne;
    execute: typeof execute;
}

/**
 * Injectable seams for the manual-grading router. Production binds the real SQL
 * adapters and the real optional/strict authentication middleware; tests
 * inject fixtures through this boundary instead of bypassing production auth.
 */
export interface ManualGradingRouterDeps {
    db: ManualGradingDataAccess;
    optionalAuthenticate: RequestHandler;
    authenticate: RequestHandler;
}

export const createManualGradingRouter = (deps: ManualGradingRouterDeps): express.Router => {
    const router = express.Router();
    const { query, queryOne, execute } = deps.db;

    router.use(deps.optionalAuthenticate);

    const isAdmin = (req: AuthRequest): boolean => req.user?.role === 'admin';

    // An exam is owned by an instructor when it is linked to at least one of
    // the instructor's groups (same verified rule as the exams router).
    const isExamInScope = async (examId: string, scopeId: string): Promise<boolean> => {
        const row = await queryOne(
            `SELECT eg.exam_id
             FROM exam_groups eg
             INNER JOIN \`groups\` g ON eg.group_id = g.id
             WHERE eg.exam_id = ? AND g.instructor_id = ?
             LIMIT 1`,
            [examId, scopeId]
        );
        return !!row;
    };

    // Get pending essay grading attempts by grade and group
    router.get('/pending', deps.authenticate, async (req: AuthRequest, res: Response) => {
        try {
            const { grade_id, group_id } = req.query;
            const scopeId = instructorScopeId(req);

            // Teacher/admin only: manual grading exposes student essay answers,
            // so an anonymous or non-teaching principal is denied outright.
            if (!scopeId && !isAdmin(req)) {
                return res.status(403).json({ error: 'Forbidden' });
            }

            console.log('🔍 Manual Grading - Get pending attempts');
            console.log('📝 Grade ID:', grade_id);
            console.log('📝 Group ID:', group_id);

            if (!grade_id) {
                return res.status(400).json({ error: 'Grade ID is required' });
            }

            const groupId = typeof group_id === 'string' ? group_id : undefined;
            const hasGroupFilter = !!groupId && groupId !== 'all';

            // Get all pending attempts for students in this grade (and optionally group)
            // NOTE: Removed ORDER BY to avoid MySQL sort buffer overflow - results sorted in memory
            const sql = `
      SELECT 
        ea.exam_id,
        ea.student_id,
        ea.score as auto_score,
        ea.answers,
        ea.completed_at as submitted_at,
        e.title as exam_title,
        e.total_marks,
        u.name as student_name,
        s.grade_id,
        s.group_id
      FROM exam_attempts ea
      INNER JOIN exams e ON e.id = ea.exam_id
      INNER JOIN users u ON u.id = ea.student_id
      INNER JOIN students s ON s.phone = u.phone
      WHERE ea.status = 'pending_review'
        AND s.grade_id = ?
        ${hasGroupFilter ? 'AND s.group_id = ?' : ''}
        ${scopeId ? `AND e.id IN (SELECT eg.exam_id FROM exam_groups eg INNER JOIN \`groups\` g ON eg.group_id = g.id WHERE g.instructor_id = ?)` : ''}
      LIMIT 1000
    `;

            console.log('🔍 Executing SQL query...');
            const params: any[] = hasGroupFilter ? [grade_id, groupId] : [grade_id];
            if (scopeId) params.push(scopeId);
            const attempts = await query<any>(sql, params);
            console.log('✅ Found attempts:', attempts.length);
            console.log('📊 Attempts data:', JSON.stringify(attempts, null, 2));

            // For each attempt, get essay questions with student answers
            const results = await Promise.all(attempts.map(async (attempt: any) => {
                // Get essay questions for this exam
                const questions = await query<any>(
                    `SELECT id, question_text, points, question_type 
         FROM exam_questions 
         WHERE exam_id = ? AND question_type = 'essay'
         ORDER BY display_order`,
                    [attempt.exam_id]
                );

                // Parse answers JSON safely (handle string or object)
                let answersData: any = attempt.answers || {};
                if (typeof answersData === 'string') {
                    try {
                        answersData = JSON.parse(answersData);
                    } catch (err) {
                        console.error('Failed to parse answers JSON:', err);
                        answersData = {};
                    }
                }
                const essayAnswers = answersData.essay || {};
                const imageAnswers = answersData.images || {};

                // Build essay questions array with student answers
                const essayQuestions = questions.map((q: any) => ({
                    id: q.id,
                    question_text: q.question_text,
                    points: q.points,
                    student_answer: essayAnswers[q.id] || '',
                    student_image: imageAnswers[q.id] || ''
                }));

                return {
                    student_id: attempt.student_id,
                    student_name: attempt.student_name,
                    exam_id: attempt.exam_id,
                    exam_title: attempt.exam_title,
                    auto_score: attempt.auto_score || 0,
                    total_marks: attempt.total_marks,
                    essay_questions: essayQuestions,
                    status: 'pending_review',
                    submitted_at: attempt.submitted_at
                };
            }));

            res.json(results);
        } catch (error) {
            console.error('Get pending attempts error:', error);
            res.status(500).json({
                error: 'Failed to fetch pending attempts',
                details: error instanceof Error ? error.message : 'Unknown error'
            });
        }
    });

    // Submit manual grading scores
    router.post('/submit', deps.authenticate, async (req: AuthRequest, res: Response) => {
        try {
            const { exam_id, student_id, essay_scores, total_score } = req.body;
            const scopeId = instructorScopeId(req);

            // Grading write: only a teacher who owns the exam (or an admin) may
            // grade; the client-supplied identity is not authority.
            if (scopeId) {
                if (!exam_id || !(await isExamInScope(exam_id, scopeId))) {
                    return res.status(404).json({ error: 'Exam not found' });
                }
            } else if (!isAdmin(req)) {
                return res.status(403).json({ error: 'Forbidden' });
            }

            console.log('🔍 Manual Grading - Submit grades');
            console.log('📝 Exam ID:', exam_id);
            console.log('👤 Student ID (user_id):', student_id);
            console.log('📊 Essay Scores:', essay_scores);
            console.log('📊 Total Score:', total_score);

            // ✅ Get actual student.id from students table using phone
            console.log('🔍 Getting actual student.id from students table...');

            // First get user phone
            const [userRecord] = await query<any>(
                'SELECT phone FROM users WHERE id = ?',
                [student_id]
            );

            if (!userRecord || !userRecord.phone) {
                return res.status(404).json({ error: 'User not found or has no phone' });
            }

            // Then get student by phone
            const studentRecord = await query<any>(
                'SELECT id FROM students WHERE phone = ?',
                [userRecord.phone]
            );

            const actualStudentId = studentRecord[0]?.id || student_id;
            console.log(`📊 User ID: ${student_id}`);
            console.log(`📊 User Phone: ${userRecord.phone}`);
            console.log(`📊 Actual Student ID: ${actualStudentId}`);

            if (!exam_id || !student_id || !essay_scores || total_score === undefined) {
                return res.status(400).json({ error: 'Missing required fields' });
            }

            // Get exam info
            console.log('🔍 Getting exam info...');
            const exam = await queryOne<any>(
                'SELECT passing_marks FROM exams WHERE id = ?',
                [exam_id]
            );

            if (!exam) {
                return res.status(404).json({ error: 'Exam not found' });
            }

            console.log('✅ Exam found, passing marks:', exam.passing_marks);

            // ✅ State integrity: only an attempt awaiting manual review may be
            // graded. A completed/absent attempt is never (re)graded here.
            const attemptRow = await queryOne<any>(
                'SELECT id, status FROM exam_attempts WHERE exam_id = ? AND student_id = ?',
                [exam_id, student_id]
            );
            if (!attemptRow) {
                return res.status(404).json({ error: 'Exam attempt not found' });
            }
            if (attemptRow.status !== 'pending_review') {
                return res.status(409).json({ error: 'This attempt is not awaiting manual grading' });
            }

            // Determine if student passed
            const passed = total_score >= exam.passing_marks;
            const status = passed ? 'passed' : 'failed';

            console.log('📊 Student status:', status, '(passed:', passed, ')');

            // Update exam_attempts with final score and status — guarded on the
            // pending_review state so a duplicate grading cannot overwrite it.
            console.log('🔄 Updating exam_attempts...');
            const gradedResult = await execute(
                `UPDATE exam_attempts 
       SET score = ?, 
           status = ?,
           essay_scores = ?
       WHERE exam_id = ? AND student_id = ? AND status = 'pending_review'`,
                [total_score, status, JSON.stringify(essay_scores), exam_id, student_id]
            );

            if (gradedResult.affectedRows === 0) {
                return res.status(409).json({ error: 'This attempt is not awaiting manual grading' });
            }

            console.log('✅ exam_attempts updated');

            // ✅ Update exam_results with grade and grading info
            console.log('🔄 Updating exam_results with final grade...');

            // Calculate percentage and determine grade
            // ⚠️ IMPORTANT: exam_results.student_id references users.id, NOT students.id
            const [examResult] = await query<any>(
                `SELECT total_marks FROM exam_results WHERE exam_id = ? AND student_id = ?`,
                [exam_id, student_id]
            );

            const totalMarks = examResult?.total_marks || 100;
            const percentage = (total_score / totalMarks) * 100;
            let grade = 'F';
            if (percentage >= 90) grade = 'A+';
            else if (percentage >= 85) grade = 'A';
            else if (percentage >= 80) grade = 'B+';
            else if (percentage >= 75) grade = 'B';
            else if (percentage >= 70) grade = 'C+';
            else if (percentage >= 65) grade = 'C';
            else if (percentage >= 60) grade = 'D';

            await execute(
                `UPDATE exam_results 
             SET marks_obtained = ?,
                 grade = ?,
                 graded_at = NOW(),
                 graded_by = ?
             WHERE exam_id = ? AND student_id = ?`,
                [total_score, grade, null, exam_id, student_id]
            );

            console.log('✅ exam_results updated with grade:', grade);

            // ✅ Update exam_student_answers for essay questions with points earned
            console.log('🔄 Updating exam_student_answers with essay scores...');
            console.log('📊 essay_scores object:', JSON.stringify(essay_scores, null, 2));
            console.log('📊 exam_id:', exam_id);
            console.log('📊 student_id (actual):', actualStudentId);

            for (const [question_id, grading] of Object.entries(essay_scores)) {
                // essay_scores can be either { score: number, feedback?: string } or just number
                const score = typeof grading === 'object' && grading !== null ? (grading as any).score : grading;

                console.log(`📝 Processing question ${question_id}:`);
                console.log(`   - grading type: ${typeof grading}`);
                console.log(`   - grading value: ${JSON.stringify(grading)}`);
                console.log(`   - extracted score: ${score}`);
                console.log(`   - Parameters: [${score}, ${exam_id}, ${actualStudentId}, ${question_id}]`);

                if (score === undefined || exam_id === undefined || actualStudentId === undefined || question_id === undefined) {
                    console.error('❌ Found undefined parameter! Skipping this question.');
                    continue;
                }

                await execute(
                    `UPDATE exam_student_answers 
                 SET points_earned = ?,
                     is_correct = 1
                 WHERE exam_id = ? AND student_id = ? AND question_id = ?`,
                    [score, exam_id, actualStudentId, question_id]
                );

                console.log(`✅ Question ${question_id} updated`);
            }

            console.log('✅ exam_student_answers updated with essay scores');

            // ⚠️ Note: The first exam_results update already used the correct student_id (user_id)
            // This final check is redundant but kept for safety - using correct student_id (user_id)
            console.log('🔄 Final exam_results check...');
            await execute(
                `UPDATE exam_results 
       SET marks_obtained = ?
       WHERE exam_id = ? AND student_id = ?`,
                [total_score, exam_id, student_id]  // ✅ Use student_id (user_id), NOT actualStudentId
            );

            console.log('✅ Grading complete');
            console.log('✅ Manual grading submitted successfully!');

            res.json({
                success: true,
                total_score,
                status,
                passed
            });
        } catch (error) {
            console.error('❌ Submit manual grading error:', error);
            console.error('❌ Error stack:', (error as Error).stack);
            res.status(500).json({
                error: 'Failed to submit grades',
                details: error instanceof Error ? error.message : 'Unknown error'
            });
        }
    });

    return router;
};

/** Production wiring: real pool and real auth middleware. */
export default createManualGradingRouter({
    db: { query, queryOne, execute },
    optionalAuthenticate: optionalAuth,
    authenticate: authenticateToken,
});
