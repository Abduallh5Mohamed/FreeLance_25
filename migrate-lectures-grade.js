import mysql from 'mysql2/promise';
import dotenv from 'dotenv';

// Load .env from server directory
dotenv.config({ path: './server/.env' });

async function addGradeToLectures() {
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
        console.log('🚀 Adding grade_id column to lectures table...');

        // Check if column exists
        const [columns] = await pool.query(`
            SELECT COLUMN_NAME 
            FROM INFORMATION_SCHEMA.COLUMNS 
            WHERE TABLE_SCHEMA = DATABASE() 
            AND TABLE_NAME = 'lectures' 
            AND COLUMN_NAME = 'grade_id'
        `);

        if (columns.length === 0) {
            // Add grade_id column
            await pool.query(`
                ALTER TABLE lectures 
                ADD COLUMN grade_id VARCHAR(36) DEFAULT NULL AFTER course_id
            `);
            console.log('✅ Added grade_id column to lectures');

            // Add index
            try {
                await pool.query(`
                    ALTER TABLE lectures 
                    ADD INDEX idx_grade_id (grade_id)
                `);
                console.log('✅ Added index on grade_id');
            } catch (err) {
                console.log('ℹ️ Index may already exist, continuing...');
            }

            // Auto-populate grade_id from groups
            await pool.query(`
                UPDATE lectures l
                INNER JOIN \`groups\` g ON l.group_id = g.id
                SET l.grade_id = g.grade_id
                WHERE l.grade_id IS NULL AND g.grade_id IS NOT NULL
            `);
            console.log('✅ Populated grade_id from existing groups');

            const [result] = await pool.query(`
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
        await pool.end();
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
