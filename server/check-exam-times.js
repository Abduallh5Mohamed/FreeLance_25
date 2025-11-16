const mysql = require('mysql2/promise');
require('dotenv').config();

async function checkExamTimes() {
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
        console.log('🕐 Checking exam times...\n');

        const [exams] = await pool.execute(`
            SELECT 
                id,
                title,
                start_time,
                end_time,
                is_active
            FROM exams
            WHERE is_active = 1
            ORDER BY start_time DESC
            LIMIT 5
        `);

        const now = new Date();
        console.log('Current Server Time:', now.toISOString());
        console.log('Current Local Time:', now.toLocaleString('ar-EG'));
        console.log('\n📋 Active Exams:\n');

        exams.forEach((exam, idx) => {
            console.log(`${idx + 1}. ${exam.title}`);
            console.log(`   ID: ${exam.id}`);
            console.log(`   Start Time (DB): ${exam.start_time}`);
            console.log(`   End Time (DB): ${exam.end_time}`);

            if (exam.start_time) {
                const startTime = new Date(exam.start_time);
                console.log(`   Start Time (Parsed): ${startTime.toISOString()}`);
                console.log(`   Start Time (Local): ${startTime.toLocaleString('ar-EG')}`);
                console.log(`   Is Started? ${now >= startTime ? '✅ YES' : '❌ NO'}`);
            }

            if (exam.end_time) {
                const endTime = new Date(exam.end_time);
                console.log(`   End Time (Parsed): ${endTime.toISOString()}`);
                console.log(`   End Time (Local): ${endTime.toLocaleString('ar-EG')}`);
                console.log(`   Is Ended? ${now >= endTime ? '✅ YES' : '❌ NO'}`);
            }

            console.log('');
        });

    } catch (error) {
        console.error('❌ Error:', error);
    } finally {
        await pool.end();
    }
}

checkExamTimes();
