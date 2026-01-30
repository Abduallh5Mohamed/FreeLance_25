const mysql = require('mysql2/promise');

async function createTables() {
    const pool = mysql.createPool({
        host: 'localhost',
        user: 'root',
        password: '123580',
        database: 'Freelance'
    });
    
    try {
        // Create videos table
        await pool.query(`
            CREATE TABLE IF NOT EXISTS videos (
                id VARCHAR(36) PRIMARY KEY,
                course_id VARCHAR(36) NOT NULL,
                lecture_id VARCHAR(36) NULL,
                material_id VARCHAR(36) NULL,
                title VARCHAR(255) NOT NULL,
                description TEXT NULL,
                file_size_bytes BIGINT NULL,
                original_key VARCHAR(500) NULL,
                hls_key VARCHAR(500) NULL,
                thumbnail_key VARCHAR(500) NULL,
                duration_seconds INT NULL,
                status ENUM('uploading', 'processing', 'ready', 'error') DEFAULT 'uploading',
                uploaded_by VARCHAR(36) NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                INDEX idx_course (course_id),
                INDEX idx_lecture (lecture_id),
                INDEX idx_status (status)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);
        console.log('✅ Videos table created successfully!');
        
        // Create lectures table if not exists
        await pool.query(`
            CREATE TABLE IF NOT EXISTS lectures (
                id VARCHAR(36) PRIMARY KEY,
                course_id VARCHAR(36) NOT NULL,
                title VARCHAR(255) NOT NULL,
                description TEXT NULL,
                video_url VARCHAR(500) NULL,
                video_id VARCHAR(36) NULL,
                duration_minutes INT DEFAULT 0,
                order_index INT DEFAULT 0,
                is_published BOOLEAN DEFAULT FALSE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                INDEX idx_course (course_id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);
        console.log('✅ Lectures table created/verified!');
        
    } catch (e) {
        console.error('Error:', e.message);
    }
    
    await pool.end();
}

createTables();
