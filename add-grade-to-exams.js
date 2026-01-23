import mysql from 'mysql2/promise';

async function addGradeToExams() {
    const pool = mysql.createPool({
        host: 'localhost',
        user: 'root',
        password: '123580',
        database: 'Freelance',
        waitForConnections: true,
        connectionLimit: 10
    });

    try {
        console.log('\n🔧 Adding grade_id to exams table...\n');

        // 1. Check if column already exists
        const [columns] = await pool.query(`
            SELECT COLUMN_NAME 
            FROM INFORMATION_SCHEMA.COLUMNS 
            WHERE TABLE_SCHEMA = 'Freelance' 
            AND TABLE_NAME = 'exams' 
            AND COLUMN_NAME = 'grade_id'
        `);

        if (columns.length > 0) {
            console.log('✅ grade_id column already exists in exams table');
        } else {
            // 2. Add grade_id column
            await pool.query(`
                ALTER TABLE exams 
                ADD COLUMN grade_id VARCHAR(255) NULL AFTER course_id
            `);
            console.log('✅ Added grade_id column to exams table');

            // 3. Add index for performance
            await pool.query(`
                ALTER TABLE exams 
                ADD INDEX idx_grade_id (grade_id)
            `);
            console.log('✅ Added index on grade_id');
        }

        // 4. Check if exams have group_id column (they might not)
        const [examColumns] = await pool.query(`
            SELECT COLUMN_NAME 
            FROM INFORMATION_SCHEMA.COLUMNS 
            WHERE TABLE_SCHEMA = 'Freelance' 
            AND TABLE_NAME = 'exams'
        `);
        const hasGroupId = examColumns.some(col => col.COLUMN_NAME === 'group_id');
        
        if (hasGroupId) {
            // Update existing exams with grade_id from their groups
            const [updated] = await pool.query(`
                UPDATE exams e
                INNER JOIN \`groups\` g ON e.group_id = g.id
                SET e.grade_id = g.grade_id
                WHERE e.grade_id IS NULL AND e.group_id IS NOT NULL
            `);
            console.log(`✅ Updated ${updated.affectedRows} existing exams with grade_id from their groups`);
        } else {
            console.log('ℹ️  exams table does not have group_id column - skipping auto-update');
        }

        // 5. Show current status
        const [exams] = await pool.query(`
            SELECT e.id, e.title, e.grade_id, e.course_id,
                   gr.name as grade_name, c.name as course_name
            FROM exams e
            LEFT JOIN grades gr ON e.grade_id = gr.id
            LEFT JOIN courses c ON e.course_id = c.id
            ORDER BY e.created_at DESC
            LIMIT 10
        `);

        console.log('\n📊 Latest exams status:');
        exams.forEach(exam => {
            console.log(`   - ${exam.title}`);
            console.log(`     Grade: ${exam.grade_name || 'NULL'} (${exam.grade_id || 'NULL'})`);
            console.log(`     Course: ${exam.course_name || 'NULL'}`);
        });

        console.log('\n✅ Migration completed successfully!');
        console.log('\n📝 Summary:');
        console.log('   - grade_id column added to exams table');
        console.log('   - Index added for performance');
        console.log('\n🎯 Now exams can be filtered by grade_id!');
        console.log('   Teachers should select grade when creating exams.');
        console.log('   Students will only see exams for their grade.');

    } catch (error) {
        console.error('❌ Error:', error);
        throw error;
    } finally {
        await pool.end();
    }
}

// Run migration
addGradeToExams()
    .then(() => {
        console.log('\n✅ Done!');
        process.exit(0);
    })
    .catch((error) => {
        console.error('\n❌ Error:', error);
        process.exit(1);
    });
