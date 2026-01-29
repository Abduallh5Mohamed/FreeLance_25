const mysql = require('mysql2/promise');

async function main() {
    const conn = await mysql.createConnection({
        host: 'localhost',
        user: 'root',
        password: '123580',
        database: 'Freelance'
    });

    try {
        // Check what tables exist
        const [tables] = await conn.query("SHOW TABLES LIKE '%video%'");
        console.log('Video tables:', tables);

        // Check videos table structure
        const [videosDesc] = await conn.query("DESCRIBE videos");
        console.log('\nvideos table columns:');
        videosDesc.forEach(col => console.log(`  ${col.Field} - ${col.Type}`));

        // Check if video_processing_queue exists
        const [queueExists] = await conn.query("SHOW TABLES LIKE 'video_processing_queue'");
        console.log('\nvideo_processing_queue exists:', queueExists.length > 0);

        if (queueExists.length === 0) {
            console.log('\nCreating video_processing_queue table...');
            await conn.query(`
                CREATE TABLE video_processing_queue (
                    id VARCHAR(36) PRIMARY KEY,
                    video_id VARCHAR(36) NOT NULL,
                    status ENUM('pending', 'processing', 'completed', 'failed') DEFAULT 'pending',
                    attempts INT DEFAULT 0,
                    error_message TEXT,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    started_at TIMESTAMP NULL,
                    completed_at TIMESTAMP NULL,
                    FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE
                )
            `);
            console.log('Created video_processing_queue table!');
        }

    } catch (error) {
        console.error('Error:', error.message);
    } finally {
        await conn.end();
    }
}

main();
