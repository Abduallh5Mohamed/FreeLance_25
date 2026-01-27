import mysql from 'mysql2/promise';

async function checkPendingAttempts() {
    const connection = await mysql.createConnection({
        host: 'localhost',
        user: 'root',
        password: '123580',
        database: 'Freelance',
        timezone: '+02:00'
    });

    try {
        console.log('🔍 Checking exam_attempts with pending_review status...\n');

        const [attempts] = await connection.execute(`
      SELECT 
        ea.id,
        ea.exam_id,
        ea.student_id,
        ea.status,
        ea.score,
        ea.completed_at,
        e.title as exam_title,
        u.name as student_name,
        s.grade_id,
        s.group_id
      FROM exam_attempts ea
      LEFT JOIN exams e ON e.id = ea.exam_id
      LEFT JOIN students s ON s.id = ea.student_id
      LEFT JOIN users u ON u.id = s.id
      WHERE ea.status = 'pending_review'
      ORDER BY ea.completed_at DESC
    `);

        console.log(`✅ Found ${attempts.length} pending review attempts:`);
        console.log(JSON.stringify(attempts, null, 2));

        console.log('\n🔍 Checking ALL exam_attempts for student d27da5fc-0da9-4b73-8485-2598f6c1eb00...\n');

        const [studentAttempts] = await connection.execute(`
      SELECT 
        ea.id,
        ea.exam_id,
        ea.student_id,
        ea.status,
        ea.score,
        ea.completed_at,
        e.title as exam_title
      FROM exam_attempts ea
      LEFT JOIN exams e ON e.id = ea.exam_id
      WHERE ea.student_id = 'd27da5fc-0da9-4b73-8485-2598f6c1eb00'
      ORDER BY ea.completed_at DESC
      LIMIT 10
    `);

        console.log(`✅ Found ${studentAttempts.length} attempts for this student:`);
        console.log(JSON.stringify(studentAttempts, null, 2));

    } catch (error) {
        console.error('❌ Error:', error);
    } finally {
        await connection.end();
    }
}

checkPendingAttempts().catch(console.error);
