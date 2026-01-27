import mysql from 'mysql2/promise';

async function fixExamDate() {
    const connection = await mysql.createConnection({
        host: 'localhost',
        user: 'root',
        password: '123580',
        database: 'Freelance',
        timezone: '+02:00',
        dateStrings: true
    });

    try {
        // جيب الامتحانات اللي اسمها "مقالي"
        const [exams] = await connection.execute(
            'SELECT * FROM exams WHERE title = ?',
            ['مقالي']
        );

        console.log(`✅ Found ${exams.length} exam(s) with title "مقالي"`);

        for (const exam of exams) {
            console.log('\n📝 Exam:', exam.id);
            console.log('   Start time:', exam.start_time);
            console.log('   End time:', exam.end_time);

            // لو وقت النهاية في شهر 2، صلحه لشهر 1
            if (exam.end_time && exam.end_time.includes('2026-02-')) {
                const newEndTime = exam.end_time.replace('2026-02-25', '2026-01-26');

                console.log(`🔄 Fixing end_time from ${exam.end_time} to ${newEndTime}`);

                await connection.execute(
                    'UPDATE exams SET end_time = ? WHERE id = ?',
                    [newEndTime, exam.id]
                );

                console.log('✅ Fixed!');
            }
        }

        // عرض النتيجة النهائية
        console.log('\n📊 Final state:');
        const [updatedExams] = await connection.execute(
            'SELECT id, title, start_time, end_time FROM exams WHERE title = ?',
            ['مقالي']
        );

        for (const exam of updatedExams) {
            console.log(`\n📝 ${exam.title} (${exam.id})`);
            console.log(`   Start: ${exam.start_time}`);
            console.log(`   End:   ${exam.end_time}`);
        }

    } catch (error) {
        console.error('❌ Error:', error);
    } finally {
        await connection.end();
    }
}

fixExamDate();
