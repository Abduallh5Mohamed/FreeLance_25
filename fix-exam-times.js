import mysql from 'mysql2/promise';

const dbConfig = {
    host: 'localhost',
    user: 'root',
    password: '123580',
    database: 'Freelance',
    timezone: '+02:00'
};

async function fixExamTimes() {
    const connection = await mysql.createConnection(dbConfig);

    try {
        console.log('🔍 Checking for exams with invalid time ranges...\n');

        // Find exams where end_time <= start_time
        const [exams] = await connection.execute(
            `SELECT id, title, start_time, end_time, duration_minutes 
       FROM exams 
       WHERE start_time IS NOT NULL 
         AND end_time IS NOT NULL 
         AND end_time <= start_time`
        );

        if (exams.length === 0) {
            console.log('✅ No exams with invalid time ranges found!');
            return;
        }

        console.log(`⚠️  Found ${exams.length} exam(s) with invalid time ranges:\n`);

        let fixedCount = 0;

        for (const exam of exams) {
            console.log(`📝 Exam: ${exam.title}`);
            console.log(`   ID: ${exam.id}`);
            console.log(`   ❌ Current start_time: ${exam.start_time}`);
            console.log(`   ❌ Current end_time: ${exam.end_time}`);

            const startDate = new Date(exam.start_time);
            const duration = exam.duration_minutes || 60; // Default 60 minutes

            // Calculate new end_time by adding duration to start_time
            const newEndDate = new Date(startDate.getTime() + duration * 60000);

            // Format as MySQL DATETIME (YYYY-MM-DD HH:MM:SS)
            const newEndTime = newEndDate.toISOString().slice(0, 19).replace('T', ' ');

            console.log(`   ✅ New end_time: ${newEndTime} (start + ${duration} minutes)`);

            // Update the exam
            await connection.execute(
                'UPDATE exams SET end_time = ?, updated_at = NOW() WHERE id = ?',
                [newEndTime, exam.id]
            );

            fixedCount++;
            console.log(`   ✅ Fixed!\n`);
        }

        console.log(`✅ Successfully fixed ${fixedCount} exam(s)!`);

    } catch (error) {
        console.error('❌ Error:', error);
    } finally {
        await connection.end();
    }
}

fixExamTimes();
