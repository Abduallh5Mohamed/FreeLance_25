const mysql = require('mysql2/promise');
require('dotenv').config();

async function fixExamsAndGroups() {
    const connection = await mysql.createConnection({
        host: process.env.DB_HOST || 'localhost',
        user: process.env.DB_USER || 'root',
        password: process.env.DB_PASSWORD || '123580',
        database: process.env.DB_NAME || 'Freelance',
        port: process.env.DB_PORT || 3306,
    });

    try {
        console.log('Connected to database...');
        
        // 1. Add grade_id to exams table if not exists
        console.log('\n--- Checking exams table ---');
        const [examColumns] = await connection.query(`
            SELECT COLUMN_NAME 
            FROM INFORMATION_SCHEMA.COLUMNS 
            WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'exams'
        `, [process.env.DB_NAME || 'Freelance']);
        
        const examColumnNames = examColumns.map(c => c.COLUMN_NAME);
        console.log('Existing columns in exams:', examColumnNames);
        
        if (!examColumnNames.includes('grade_id')) {
            console.log('Adding grade_id column to exams...');
            await connection.query(`
                ALTER TABLE exams 
                ADD COLUMN grade_id CHAR(36) NULL,
                ADD INDEX idx_grade_id (grade_id)
            `);
            console.log('✅ Added grade_id column to exams');
        } else {
            console.log('✅ grade_id column already exists in exams');
        }
        
        // 2. Create exam_groups table if not exists
        console.log('\n--- Checking exam_groups table ---');
        const [tables] = await connection.query(`
            SHOW TABLES LIKE 'exam_groups'
        `);
        
        if (tables.length === 0) {
            console.log('Creating exam_groups table...');
            await connection.query(`
                CREATE TABLE exam_groups (
                    id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
                    exam_id CHAR(36) NOT NULL,
                    group_id CHAR(36) NOT NULL,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (exam_id) REFERENCES exams(id) ON DELETE CASCADE,
                    FOREIGN KEY (group_id) REFERENCES \`groups\`(id) ON DELETE CASCADE,
                    UNIQUE KEY unique_exam_group (exam_id, group_id),
                    INDEX idx_exam_id (exam_id),
                    INDEX idx_group_id (group_id)
                ) ENGINE=InnoDB
            `);
            console.log('✅ Created exam_groups table');
        } else {
            console.log('✅ exam_groups table already exists');
        }
        
        console.log('\n✅ All done!');
    } catch (error) {
        console.error('Error:', error.message);
        throw error;
    } finally {
        await connection.end();
    }
}

fixExamsAndGroups();
