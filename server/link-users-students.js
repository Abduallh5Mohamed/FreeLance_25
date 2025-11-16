const mysql = require('mysql2/promise');
require('dotenv').config();

async function linkUsersToStudents() {
    const pool = mysql.createPool({
        host: process.env.DB_HOST || 'localhost',
        user: process.env.DB_USER || 'root',
        password: process.env.DB_PASSWORD || '',
        database: process.env.DB_NAME || 'freelance',
        waitForConnections: true,
        connectionLimit: 10,
        queueLimit: 0
    });

    try {
        console.log('🔄 Linking users to students by phone...');

        // Link users to students
        const [result] = await pool.execute(`
            UPDATE users u
            JOIN students s ON s.phone = u.phone
            SET u.student_id = s.id
            WHERE u.role = 'student' 
              AND u.student_id IS NULL
              AND s.phone IS NOT NULL
        `);

        console.log(`✅ Updated ${result.affectedRows} users`);

        // Show results
        const [users] = await pool.execute(`
            SELECT 
                u.id as user_id,
                u.name as user_name,
                u.phone,
                u.student_id,
                s.name as student_name
            FROM users u
            LEFT JOIN students s ON s.id = u.student_id
            WHERE u.role = 'student'
        `);

        console.log('\n📋 Student Users:');
        console.table(users);

    } catch (error) {
        console.error('❌ Error:', error);
    } finally {
        await pool.end();
    }
}

linkUsersToStudents();
