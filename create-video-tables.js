import mysql from 'mysql2/promise';

async function createVideoTables() {
    let connection;
    try {
        connection = await mysql.createConnection({
            host: 'localhost',
            user: 'root',
            password: '123580',
            database: 'Freelance'  // Capital F to match server config
        });

        console.log('Connected to database...');

        // Create videos table
        await connection.execute(`
            CREATE TABLE IF NOT EXISTS videos (
                id VARCHAR(36) PRIMARY KEY,
                
                -- Ownership
                course_id VARCHAR(36) NOT NULL,
                lecture_id VARCHAR(36),
                material_id VARCHAR(36),
                uploaded_by VARCHAR(36) NOT NULL,
                
                -- Video Info
                title VARCHAR(255) NOT NULL,
                description TEXT,
                duration_seconds INT,
                file_size_bytes BIGINT,
                
                -- Storage Paths (MinIO)
                original_key VARCHAR(500),
                hls_key VARCHAR(500),
                thumbnail_key VARCHAR(500),
                
                -- Processing Status
                status ENUM('uploading', 'processing', 'ready', 'failed') DEFAULT 'uploading',
                processing_progress INT DEFAULT 0,
                processing_error TEXT,
                
                -- Quality Options Generated
                qualities_available JSON,
                
                -- Security
                is_drm_protected BOOLEAN DEFAULT FALSE,
                
                -- Timestamps
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                processed_at TIMESTAMP NULL,
                
                -- Indexes
                INDEX idx_videos_course (course_id),
                INDEX idx_videos_status (status),
                INDEX idx_videos_lecture (lecture_id),
                INDEX idx_videos_material (material_id),
                INDEX idx_videos_uploaded_by (uploaded_by)
            )
        `);
        console.log('✅ Created videos table');

        // Create video_upload_chunks table
        await connection.execute(`
            CREATE TABLE IF NOT EXISTS video_upload_chunks (
                id VARCHAR(36) PRIMARY KEY,
                video_id VARCHAR(36) NOT NULL,
                upload_id VARCHAR(100) NOT NULL,
                chunk_number INT NOT NULL,
                chunk_size BIGINT NOT NULL,
                etag VARCHAR(100),
                status ENUM('pending', 'uploaded', 'failed') DEFAULT 'pending',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                
                UNIQUE KEY unique_chunk (video_id, chunk_number),
                INDEX idx_chunks_video (video_id),
                INDEX idx_chunks_upload (upload_id),
                FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE
            )
        `);
        console.log('✅ Created video_upload_chunks table');

        // Create video_access_logs table
        await connection.execute(`
            CREATE TABLE IF NOT EXISTS video_access_logs (
                id BIGINT AUTO_INCREMENT PRIMARY KEY,
                video_id VARCHAR(36) NOT NULL,
                user_id VARCHAR(36) NOT NULL,
                accessed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                watch_duration_seconds INT DEFAULT 0,
                ip_address VARCHAR(45),
                user_agent VARCHAR(500),
                
                INDEX idx_access_video (video_id),
                INDEX idx_access_user (user_id),
                INDEX idx_access_time (accessed_at)
            )
        `);
        console.log('✅ Created video_access_logs table');

        // Create video_processing_queue table
        await connection.execute(`
            CREATE TABLE IF NOT EXISTS video_processing_queue (
                id VARCHAR(36) PRIMARY KEY,
                video_id VARCHAR(36) NOT NULL,
                priority INT DEFAULT 0,
                status ENUM('pending', 'processing', 'completed', 'failed') DEFAULT 'pending',
                started_at TIMESTAMP NULL,
                completed_at TIMESTAMP NULL,
                error_message TEXT,
                worker_id VARCHAR(100),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                
                UNIQUE KEY unique_queue_video (video_id),
                INDEX idx_queue_status (status, priority DESC),
                FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE
            )
        `);
        console.log('✅ Created video_processing_queue table');

        console.log('\n🎉 All video system tables created successfully!');

    } catch (error) {
        console.error('❌ Error:', error.message);
    } finally {
        if (connection) {
            await connection.end();
        }
    }
}

createVideoTables();
