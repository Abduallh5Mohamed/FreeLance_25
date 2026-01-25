import mysql from 'mysql2/promise';

async function fixQualities() {
    const connection = await mysql.createConnection({
        host: 'localhost',
        user: 'root',
        password: '123580',
        database: 'Freelance'
    });

    await connection.execute(
        `UPDATE videos SET qualities_available = ? WHERE id = ?`,
        ['["360p"]', 'e0acff5d-f093-4307-8792-eadeccc2683e']
    );

    console.log('✅ Fixed qualities_available');
    await connection.end();
}

fixQualities();
