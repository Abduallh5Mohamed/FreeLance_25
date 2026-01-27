import mysql from 'mysql2/promise';

async function checkAttempts() {
    const connection = await mysql.createConnection({
        host: '127.0.0.1',
        user: 'root',
        password: '123580',
        database: 'Freelance'
    });

    try {
        // Check attempts for the new exam
        const [attempts] = await connection.execute(
            'SELECT * FROM exam_attempts WHERE exam_id = ? ORDER BY started_at DESC LIMIT 5',
            ['3f70d4c2-faf8-11f0-aaf9-e89c254b7f9f']
        );

        console.log('=== Exam Attempts (jv) ===');
        console.log(JSON.stringify(attempts, null, 2));

        // Check exam_results table
        const [results] = await connection.execute(
            'SELECT * FROM exam_results WHERE exam_id = ?',
            ['3f70d4c2-faf8-11f0-aaf9-e89c254b7f9f']
        );

        console.log('\n=== Exam Results ===');
        console.log(JSON.stringify(results, null, 2));

    } catch (error) {
        console.error('Error:', error.message);
    } finally {
        await connection.end();
    }
}

checkAttempts();
