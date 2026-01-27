import mysql from 'mysql2/promise';

async function checkStudentRelation() {
    const connection = await mysql.createConnection({
        host: 'localhost',
        user: 'root',
        password: '123580',
        database: 'Freelance',
        timezone: '+02:00'
    });

    try {
        console.log('🔍 Checking student relation...\n');

        // Check the student with this user_id
        const [userResult] = await connection.execute(`
      SELECT id, name, phone FROM users WHERE id = 'd27da5fc-0da9-4b73-8485-2598f6c1eb00'
    `);
        console.log('👤 User:', userResult);

        // Check if there's a student record
        const [studentResult] = await connection.execute(`
      SELECT * FROM students WHERE id = 'd27da5fc-0da9-4b73-8485-2598f6c1eb00'
    `);
        console.log('\n🎓 Student record (using user id):', studentResult);

        // Check student_id column structure in exam_attempts
        const [columns] = await connection.execute(`
      SHOW COLUMNS FROM exam_attempts WHERE Field = 'student_id'
    `);
        console.log('\n📋 exam_attempts.student_id column:', columns);

        // Check students table structure
        const [studentColumns] = await connection.execute(`
      SHOW COLUMNS FROM students
    `);
        console.log('\n📋 students table columns:');
        studentColumns.forEach((col) => {
            console.log(`  - ${col.Field}: ${col.Type}`);
        });

    } catch (error) {
        console.error('❌ Error:', error);
    } finally {
        await connection.end();
    }
}

checkStudentRelation().catch(console.error);
