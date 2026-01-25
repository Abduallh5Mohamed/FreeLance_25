const mysql = require('mysql2/promise');
require('dotenv').config();

async function updateExamSchema() {
    const connection = await mysql.createConnection({
        host: process.env.DB_HOST || 'localhost',
        user: process.env.DB_USER || 'root',
        password: process.env.DB_PASSWORD || '',
        database: process.env.DB_NAME || 'freelance'
    });

    try {
        console.log('🔄 Updating exam questions schema...');

        // Add question_image column
        try {
            await connection.execute(`
                ALTER TABLE exam_questions 
                ADD COLUMN question_image TEXT AFTER question_text
            `);
            console.log('✅ Added question_image column');
        } catch (err) {
            if (err.code === 'ER_DUP_FIELDNAME') {
                console.log('⚠️  question_image column already exists');
            } else {
                throw err;
            }
        }

        // Create exam_answers table for essay/image answers
        try {
            await connection.execute(`
                CREATE TABLE IF NOT EXISTS exam_answers (
                    id VARCHAR(36) PRIMARY KEY DEFAULT (UUID()),
                    exam_id VARCHAR(36) NOT NULL,
                    question_id VARCHAR(36) NOT NULL,
                    student_id VARCHAR(36) NOT NULL,
                    answer_text TEXT,
                    answer_image TEXT,
                    marks_obtained DECIMAL(5,2) DEFAULT 0,
                    graded BOOLEAN DEFAULT FALSE,
                    teacher_feedback TEXT,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                    FOREIGN KEY (exam_id) REFERENCES exams(id) ON DELETE CASCADE,
                    FOREIGN KEY (question_id) REFERENCES exam_questions(id) ON DELETE CASCADE,
                    INDEX idx_student_exam (student_id, exam_id),
                    INDEX idx_question (question_id)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
            `);
            console.log('✅ Created exam_answers table');
        } catch (err) {
            console.log('⚠️  exam_answers table already exists or error:', err.message);
        }

        console.log('✅ Schema update completed!');
    } catch (error) {
        console.error('❌ Error updating schema:', error);
        throw error;
    } finally {
        await connection.end();
    }
}

updateExamSchema().catch(console.error);
