const mysql = require('mysql2/promise');

(async () => {
    try {
        const conn = await mysql.createConnection({
            host: 'localhost',
            user: 'root',
            password: '123580',
            database: 'Freelance'
        });

        console.log('📦 Creating subscription_requests table...');

        const createTableSQL = `
            CREATE TABLE IF NOT EXISTS subscription_requests (
                id VARCHAR(36) PRIMARY KEY,
                student_name VARCHAR(255) NOT NULL,
                phone VARCHAR(20) NOT NULL,
                grade_id VARCHAR(36) NULL,
                grade_name VARCHAR(100) NULL,
                group_id VARCHAR(36) NULL,
                group_name VARCHAR(100) NULL,
                amount DECIMAL(10, 2) NOT NULL DEFAULT 0,
                notes TEXT NULL,
                receipt_image_url TEXT NULL,
                status ENUM('pending', 'approved', 'rejected') NOT NULL DEFAULT 'pending',
                rejection_reason TEXT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                approved_at TIMESTAMP NULL,
                approved_by VARCHAR(36) NULL,
                INDEX idx_phone (phone),
                INDEX idx_status (status),
                INDEX idx_grade_id (grade_id),
                INDEX idx_group_id (group_id),
                INDEX idx_created_at (created_at)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `;

        await conn.execute(createTableSQL);
        console.log('✅ Table created successfully!');

        const [tables] = await conn.execute('SHOW TABLES LIKE "subscription_requests"');
        console.log('✅ Verification:', tables);

        await conn.end();
        console.log('🎉 Done!');
    } catch (error) {
        console.error('❌ Error:', error);
        process.exit(1);
    }
})();
