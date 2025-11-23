import mysql from 'mysql2/promise';
import dotenv from 'dotenv';

dotenv.config({ path: './server/.env' });

async function checkStudentLectures() {
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
        const studentPhone = '01029290728';

        console.log('\n🔍 Checking student data for phone:', studentPhone);

        // 1. Get student info
        const [students] = await pool.query(`
            SELECT s.*, g.name as grade_name, gr.name as group_name
            FROM students s
            LEFT JOIN grades g ON s.grade_id = g.id
            LEFT JOIN \`groups\` gr ON s.group_id = gr.id
            WHERE s.phone = ?
        `, [studentPhone]);

        if (students.length === 0) {
            console.log('❌ Student not found!');
            await pool.end();
            return;
        }

        const student = students[0];
        console.log('\n📋 Student Info:');
        console.log('   ID:', student.id);
        console.log('   Name:', student.name);
        console.log('   Grade ID:', student.grade_id);
        console.log('   Grade Name:', student.grade_name);
        console.log('   Group ID:', student.group_id);
        console.log('   Group Name:', student.group_name);

        // 2. Check all lectures
        const [allLectures] = await pool.query(`
            SELECT l.id, l.title, l.grade_id, l.group_id, l.course_id,
                   g.name as grade_name, gr.name as group_name, c.name as course_name
            FROM lectures l
            LEFT JOIN grades g ON l.grade_id = g.id
            LEFT JOIN \`groups\` gr ON l.group_id = gr.id
            LEFT JOIN courses c ON l.course_id = c.id
        `);

        console.log('\n📚 All Lectures in Database:', allLectures.length);
        allLectures.forEach(lec => {
            console.log(`   - ${lec.title}`);
            console.log(`     Grade: ${lec.grade_name || 'NULL'} (${lec.grade_id || 'NULL'})`);
            console.log(`     Group: ${lec.group_name || 'NULL'} (${lec.group_id || 'NULL'})`);
            console.log(`     Course: ${lec.course_name || 'NULL'}`);
        });

        // 3. Check lectures that SHOULD appear for this student
        const [matchingLectures] = await pool.query(`
            SELECT l.id, l.title, l.grade_id, l.group_id,
                   g.name as grade_name, gr.name as group_name,
                   CASE 
                       WHEN l.grade_id = ? THEN 'grade_match'
                       WHEN l.group_id = ? THEN 'group_match'
                       ELSE 'no_match'
                   END as match_type
            FROM lectures l
            LEFT JOIN grades g ON l.grade_id = g.id
            LEFT JOIN \`groups\` gr ON l.group_id = gr.id
            WHERE l.grade_id = ? OR l.group_id = ?
        `, [student.grade_id, student.group_id, student.grade_id, student.group_id]);

        console.log('\n✅ Lectures that SHOULD appear for this student:', matchingLectures.length);
        matchingLectures.forEach(lec => {
            console.log(`   - ${lec.title} (${lec.match_type})`);
            console.log(`     Grade: ${lec.grade_name || 'NULL'}`);
            console.log(`     Group: ${lec.group_name || 'NULL'}`);
        });

        // 4. Check what backend endpoint returns
        console.log('\n🔍 Testing backend query logic...');
        const [backendResult] = await pool.query(`
            SELECT DISTINCT l.*, 
                   g.name as grade_name,
                   gr.name as group_name,
                   c.name as course_name
            FROM lectures l
            LEFT JOIN grades g ON l.grade_id = g.id
            LEFT JOIN \`groups\` gr ON l.group_id = gr.id
            LEFT JOIN courses c ON l.course_id = c.id
            WHERE l.grade_id = ? OR l.group_id = ?
            ORDER BY l.uploaded_at DESC
        `, [student.grade_id, student.group_id]);

        console.log('📤 Backend would return:', backendResult.length, 'lectures');

        if (backendResult.length === 0) {
            console.log('\n⚠️ PROBLEM FOUND:');
            console.log('   Student has grade_id:', student.grade_id);
            console.log('   Student has group_id:', student.group_id);
            console.log('   But NO lectures match these IDs!');
            console.log('\n💡 Solution: Create lectures with the correct grade_id or group_id');
        }

    } catch (error) {
        console.error('❌ Error:', error);
    } finally {
        await pool.end();
    }
}

checkStudentLectures();
