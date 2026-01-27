import express, { Request, Response } from 'express';
import { query, queryOne, execute } from '../db';

const router = express.Router();

// Get pending essay grading attempts by grade and group
router.get('/pending', async (req: Request, res: Response) => {
    try {
        const { grade_id, group_id } = req.query;

        console.log('🔍 Manual Grading - Get pending attempts');
        console.log('📝 Grade ID:', grade_id);
        console.log('📝 Group ID:', group_id);

        if (!grade_id || !group_id) {
            return res.status(400).json({ error: 'Grade ID and Group ID are required' });
        }

        // Get all pending attempts for students in this grade and group
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
        AND s.group_id = ?
      ORDER BY ea.completed_at DESC
    `;

        console.log('🔍 Executing SQL query...');
        const attempts = await query<any>(sql, [grade_id, group_id]);
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

            // Parse answers JSON (already parsed by mysql2, no need for JSON.parse)
            const answersData = attempt.answers || {};
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
router.post('/submit', async (req: Request, res: Response) => {
    try {
        const { exam_id, student_id, essay_scores, total_score } = req.body;

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

        // Determine if student passed
        const passed = total_score >= exam.passing_marks;
        const status = passed ? 'passed' : 'failed';

        console.log('📊 Student status:', status, '(passed:', passed, ')');

        // Update exam_attempts with final score and status
        console.log('🔄 Updating exam_attempts...');
        await execute(
            `UPDATE exam_attempts 
       SET score = ?, 
           status = ?,
           essay_scores = ?
       WHERE exam_id = ? AND student_id = ?`,
            [total_score, status, JSON.stringify(essay_scores), exam_id, student_id]
        );

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

        // Update exam_results table
        console.log('🔄 Final exam_results check...');
        await execute(
            `UPDATE exam_results 
       SET marks_obtained = ?
       WHERE exam_id = ? AND student_id = ?`,
            [total_score, exam_id, actualStudentId]
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

export default router;
