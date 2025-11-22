import mysql from 'mysql2/promise';

async function checkAndFix() {
    const connection = await mysql.createConnection({
        host: '72.62.35.177',
        user: 'root',
        password: 'MyPass12345@',
        database: 'Freelance'
    });

    try {
        console.log('🔍 Checking guardian_phone column...\n');

        // Check column structure
        const [columns] = await connection.execute(
            `SHOW COLUMNS FROM students WHERE Field = 'guardian_phone'`
        );

        if (columns.length === 0) {
            console.log('❌ Column guardian_phone does NOT exist!');
            console.log('Creating column...\n');

            await connection.execute(
                `ALTER TABLE students ADD COLUMN guardian_phone VARCHAR(50) NULL AFTER phone`
            );

            console.log('✅ Column created successfully!\n');
        } else {
            console.log('✅ Column guardian_phone exists!');
            console.log(columns[0]);
            console.log('');
        }

        // Check sample data
        console.log('📋 Sample students data:\n');
        const [students] = await connection.execute(
            `SELECT id, name, phone, guardian_phone, is_offline 
             FROM students 
             WHERE is_offline = 1 
             LIMIT 5`
        );

        if (students.length === 0) {
            console.log('⚠ No offline students found in database');
        } else {
            students.forEach((student, idx) => {
                console.log(`${idx + 1}. ${student.name}`);
                console.log(`   Phone: ${student.phone || '❌'}`);
                console.log(`   Guardian Phone: ${student.guardian_phone || '❌ MISSING'}`);
                console.log(`   Offline: ${student.is_offline}`);
                console.log('');
            });
        }

        // Count students with missing guardian phones
        const [countResult] = await connection.execute(
            `SELECT 
                COUNT(*) as total,
                SUM(CASE WHEN guardian_phone IS NULL OR guardian_phone = '' THEN 1 ELSE 0 END) as missing
             FROM students 
             WHERE is_offline = 1`
        );

        console.log('📊 Statistics:');
        console.log(`   Total offline students: ${countResult[0].total}`);
        console.log(`   Missing guardian phone: ${countResult[0].missing}`);
        console.log('');

    } catch (error) {
        console.error('❌ Error:', error.message);
    } finally {
        await connection.end();
    }
}

checkAndFix();
