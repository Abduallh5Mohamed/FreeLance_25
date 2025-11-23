import mysql from 'mysql2/promise';

async function addGradeToLectures() {
    const connection = await mysql.createConnection({
        host: process.env.DB_HOST || 'localhost',
        user: process.env.DB_USER || 'root',
        password: process.env.DB_PASSWORD || '',
        database: process.env.DB_NAME || 'alqaed_platform'
    });

    try {
        console.log('🚀 Adding grade_id column to lectures table...');

        // Check if column exists
        const [columns] = await connection.query(`
            SELECT COLUMN_NAME 
            FROM INFORMATION_SCHEMA.COLUMNS 
            WHERE TABLE_SCHEMA = DATABASE() 
            AND TABLE_NAME = 'lectures' 
            AND COLUMN_NAME = 'grade_id'
        `);

        if (columns.length === 0) {
            // Add grade_id column
            await connection.query(`
                ALTER TABLE lectures 
                ADD COLUMN grade_id VARCHAR(36) DEFAULT NULL AFTER course_id
            `);
            console.log('✅ Added grade_id column to lectures');

            // Add foreign key if grades table exists
            await connection.query(`
                ALTER TABLE lectures 
                ADD CONSTRAINT fk_lectures_grade 
                FOREIGN KEY (grade_id) REFERENCES grades(id) 
                ON DELETE SET NULL
            `);
            console.log('✅ Added foreign key constraint');

            // Auto-populate grade_id from groups
            await connection.query(`
                UPDATE lectures l
                INNER JOIN \`groups\` g ON l.group_id = g.id
                SET l.grade_id = g.grade_id
                WHERE l.grade_id IS NULL AND g.grade_id IS NOT NULL
            `);
            console.log('✅ Populated grade_id from existing groups');

            const [result] = await connection.query(`
                SELECT COUNT(*) as count FROM lectures WHERE grade_id IS NOT NULL
            `);
            console.log(`✅ Updated ${result[0].count} lectures with grade_id`);
        } else {
            console.log('ℹ️ grade_id column already exists in lectures table');
        }

        console.log('✅ Migration completed successfully!');
    } catch (error) {
        console.error('❌ Migration failed:', error);
        throw error;
    } finally {
        await connection.end();
    }
}

// Run migration
addGradeToLectures()
    .then(() => {
        console.log('✅ Done!');
        process.exit(0);
    })
    .catch((error) => {
        console.error('❌ Error:', error);
        process.exit(1);
    });
