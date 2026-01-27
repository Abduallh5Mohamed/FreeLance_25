import mysql from 'mysql2/promise';

async function findStudentRecord() {
    const connection = await mysql.createConnection({
        host: 'localhost',
        user: 'root',
        password: '123580',
        database: 'Freelance',
        timezone: '+02:00'
    });

    try {
        console.log('🔍 Looking for student record by phone...\n');

        const [studentByPhone] = await connection.execute(`
      SELECT * FROM students WHERE phone = '01029290728'
    `);
        console.log('🎓 Student found by phone:', JSON.stringify(studentByPhone, null, 2));

        console.log('\n🔍 Checking users table for this ID...\n');
        const [user] = await connection.execute(`
      SELECT id, name, phone, role, student_id FROM users WHERE id = 'd27da5fc-0da9-4b73-8485-2598f6c1eb00'
    `);
        console.log('👤 User:', JSON.stringify(user, null, 2));

    } catch (error) {
        console.error('❌ Error:', error);
    } finally {
        await connection.end();
    }
}

findStudentRecord().catch(console.error);
