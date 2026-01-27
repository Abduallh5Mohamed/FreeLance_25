import mysql from 'mysql2/promise';

async function checkStatusEnum() {
    const connection = await mysql.createConnection({
        host: 'localhost',
        user: 'root',
        password: '123580',
        database: 'Freelance',
        timezone: '+02:00'
    });

    try {
        const [rows] = await connection.execute(
            "SHOW COLUMNS FROM exam_attempts WHERE Field = 'status'"
        );
        console.log('Current status column:');
        console.log(JSON.stringify(rows[0], null, 2));
    } finally {
        await connection.end();
    }
}

checkStatusEnum().catch(console.error);
