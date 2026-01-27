import mysql from 'mysql2/promise';

async function deleteAttempt() {
    const connection = await mysql.createConnection({
        host: '127.0.0.1',
        user: 'root',
        password: '123580',
        database: 'Freelance'
    });

    try {
        // Delete the stuck attempt for the new exam
        const [result] = await connection.execute(
            'DELETE FROM exam_attempts WHERE exam_id = ? AND student_id = ?',
            ['8b9e72bb-faf9-11f0-aaf9-e89c254b7f9f', 'd27da5fc-0da9-4b73-8485-2598f6c1eb00']
        );

        console.log('✅ Deleted attempt:', result);

    } catch (error) {
        console.error('Error:', error.message);
    } finally {
        await connection.end();
    }
}

deleteAttempt();
