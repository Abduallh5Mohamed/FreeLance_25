const mysql = require('mysql2/promise');
require('dotenv').config();

async function fixExamTables() {
    const connection = await mysql.createConnection({
        host: process.env.DB_HOST || 'localhost',
        user: process.env.DB_USER || 'root',
        password: process.env.DB_PASSWORD || '',
        database: process.env.DB_NAME || 'freelance'
    });

    try {
        console.log('🔄 Creating missing exam tables...');

        // Create exam_attempts table
        await connection.execute(`
            CREATE TABLE IF NOT EXISTS exam_attempts (
                id VARCHAR(36) PRIMARY KEY,
                exam_id VARCHAR(36) NOT NULL,
                student_id VARCHAR(36) NOT NULL,
                status ENUM('in_progress', 'completed', 'expired') DEFAULT 'in_progress',
                score DECIMAL(10,2) DEFAULT 0,
                started_at TIMESTAMP NULL,
                completed_at TIMESTAMP NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                FOREIGN KEY (exam_id) REFERENCES exams(id) ON DELETE CASCADE,
                UNIQUE KEY unique_attempt (exam_id, student_id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);
        console.log('✅ exam_attempts table created/verified');

        // Create lectures table if not exists
        await connection.execute(`
            CREATE TABLE IF NOT EXISTS lectures (
                id VARCHAR(36) PRIMARY KEY DEFAULT (UUID()),
                course_id VARCHAR(36),
                grade_id VARCHAR(36),
                group_id VARCHAR(36),
                title VARCHAR(255) NOT NULL,
                description TEXT,
                video_url TEXT,
                is_published BOOLEAN DEFAULT TRUE,
                display_order INT DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                FOREIGN KEY (course_id) REFERENCES courses(id) ON DELETE SET NULL,
                FOREIGN KEY (grade_id) REFERENCES grades(id) ON DELETE SET NULL,
                FOREIGN KEY (group_id) REFERENCES \`groups\`(id) ON DELETE SET NULL
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);
        console.log('✅ lectures table created/verified');

        console.log('✅ All tables fixed!');
    } catch (error) {
        console.error('❌ Error:', error);
        throw error;
    } finally {
        await connection.end();
    }
}

fixExamTables().catch(console.error);
