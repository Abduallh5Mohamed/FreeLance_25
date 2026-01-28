const mysql = require('mysql2/promise');

(async () => {
    const connection = await mysql.createConnection({
        host: 'localhost',
        user: 'root',
        password: '123580',
        database: 'Freelance'
    });

    const sql = `
        CREATE TABLE IF NOT EXISTS exam_attempts (
            id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
            exam_id CHAR(36) NOT NULL,
            student_id CHAR(36) NOT NULL,
            status ENUM('in_progress', 'completed', 'passed', 'failed', 'pending_review') DEFAULT 'in_progress',
            score DECIMAL(5,2) NULL,
            answers JSON NULL,
            started_at DATETIME NULL,
            completed_at DATETIME NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            FOREIGN KEY (exam_id) REFERENCES exams(id) ON DELETE CASCADE,
            UNIQUE KEY unique_attempt (exam_id, student_id)
        )
    `;

    await connection.execute(sql);
    console.log('✅ exam_attempts table created successfully!');
    
    await connection.end();
})();
