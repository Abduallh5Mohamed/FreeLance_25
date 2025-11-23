import mysql from 'mysql2/promise';
import dotenv from 'dotenv';

dotenv.config({ path: './server/.env' });

async function checkSchema() {
    const pool = mysql.createPool({
        host: process.env.DB_HOST || 'localhost',
        user: process.env.DB_USER || 'root',
        password: process.env.DB_PASSWORD || '',
        database: process.env.DB_NAME || 'freelance',
        port: parseInt(process.env.DB_PORT || '3306'),
        charset: 'utf8mb4',
        timezone: '+00:00'
    });

    try {
        console.log('\n📋 Students Table Schema:');
        const [studentColumns] = await pool.query(`
            DESCRIBE students
        `);
        console.table(studentColumns);

        console.log('\n📋 Users Table Schema:');
        const [userColumns] = await pool.query(`
            DESCRIBE users
        `);
        console.table(userColumns);

        console.log('\n📋 Sample student data:');
        const [students] = await pool.query(`
            SELECT * FROM students LIMIT 3
        `);
        console.table(students);

        console.log('\n📋 Sample user with phone 01029290728:');
        const [users] = await pool.query(`
            SELECT * FROM users WHERE phone = '01029290728'
        `);
        console.table(users);

    } catch (error) {
        console.error('❌ Error:', error);
    } finally {
        await pool.end();
    }
}

checkSchema();
