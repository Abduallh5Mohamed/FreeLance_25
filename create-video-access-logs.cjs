const mysql = require('mysql2/promise');

async function main() {
    const conn = await mysql.createConnection({
        host: 'localhost',
        user: 'root',
        password: '123580',
        database: 'Freelance'
    });

    try {
        console.log('Creating video_access_logs table...');
        await conn.query(`
            CREATE TABLE IF NOT EXISTS video_access_logs (
                id INT AUTO_INCREMENT PRIMARY KEY,
                video_id VARCHAR(36) NOT NULL,
                user_id VARCHAR(36),
                ip_address VARCHAR(45),
                user_agent TEXT,
                accessed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                INDEX idx_video_id (video_id),
                INDEX idx_user_id (user_id),
                INDEX idx_accessed_at (accessed_at)
            )
        `);
        console.log('✅ Created video_access_logs table');

    } catch (error) {
        console.error('Error:', error.message);
    } finally {
        await conn.end();
    }
}

main();
