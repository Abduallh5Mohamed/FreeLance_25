import mysql from 'mysql2/promise';
import dotenv from 'dotenv';

dotenv.config({ path: './server/.env' });

async function checkStudentMaterials() {
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

        console.log('\n🔍 Checking materials for student:', studentPhone);

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
        console.log('   Group ID:', student.group_id);
        console.log('   Group Name:', student.group_name);

        // 2. Check all materials in database
        const [allMaterials] = await pool.query(`
            SELECT cm.id, cm.title, cm.material_type, cm.course_id,
                   c.name as course_name
            FROM course_materials cm
            LEFT JOIN courses c ON cm.course_id = c.id
            WHERE cm.is_published = TRUE
        `);

        console.log('\n📚 All Materials in Database:', allMaterials.length);
        for (const mat of allMaterials) {
            console.log(`   - ${mat.title} (${mat.material_type})`);
            console.log(`     Course: ${mat.course_name || 'NULL'}`);

            // Check which groups this material is assigned to
            const [groups] = await pool.query(`
                SELECT mg.group_id, g.name as group_name
                FROM material_groups mg
                LEFT JOIN \`groups\` g ON mg.group_id = g.id
                WHERE mg.material_id = ?
            `, [mat.id]);

            if (groups.length > 0) {
                console.log(`     Assigned to groups:`, groups.map(g => g.group_name).join(', '));
            } else {
                console.log(`     ⚠️ NOT assigned to any group!`);
            }
        }

        // 3. Check materials that SHOULD appear for this student
        const [matchingMaterials] = await pool.query(`
            SELECT DISTINCT
                cm.*,
                c.name as course_name
            FROM course_materials cm
            LEFT JOIN courses c ON cm.course_id = c.id
            INNER JOIN material_groups mg ON cm.id = mg.material_id
            WHERE cm.is_published = TRUE
                AND mg.group_id = ?
            ORDER BY cm.display_order ASC, cm.created_at DESC
        `, [student.group_id]);

        console.log('\n✅ Materials that SHOULD appear for this student:', matchingMaterials.length);
        matchingMaterials.forEach(mat => {
            console.log(`   - ${mat.title} (${mat.material_type})`);
            console.log(`     Course: ${mat.course_name || 'NULL'}`);
            console.log(`     File URL: ${mat.file_url || 'NULL'}`);
        });

        if (matchingMaterials.length === 0) {
            console.log('\n⚠️ PROBLEM FOUND:');
            console.log('   Student has group_id:', student.group_id);
            console.log('   But NO materials are assigned to this group!');
            console.log('\n💡 Solution: When uploading material, make sure to select the student\'s group');
        }

    } catch (error) {
        console.error('❌ Error:', error);
    } finally {
        await pool.end();
    }
}

checkStudentMaterials();
