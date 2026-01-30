// Run premium lectures migration
const mysql = require('mysql2/promise');
require('dotenv').config({ path: './server/.env' });

async function runMigration() {
    const connection = await mysql.createConnection({
        host: process.env.DB_HOST || 'localhost',
        user: process.env.DB_USER || 'root',
        password: process.env.DB_PASSWORD || '',
        database: process.env.DB_NAME || 'Freelance',
        port: parseInt(process.env.DB_PORT || '3306'),
        multipleStatements: true
    });

    console.log('🔌 Connected to database');

    try {
        // Create premium_lectures table
        console.log('📦 Creating premium_lectures table...');
        await connection.query(`
            CREATE TABLE IF NOT EXISTS premium_lectures (
                id VARCHAR(36) PRIMARY KEY,
                title VARCHAR(255) NOT NULL,
                description TEXT,
                video_url VARCHAR(500),
                thumbnail_url VARCHAR(500),
                duration_minutes INT DEFAULT 0,
                price DECIMAL(10, 2) NOT NULL DEFAULT 0,
                grade_id VARCHAR(36),
                group_id VARCHAR(36),
                is_published BOOLEAN DEFAULT FALSE,
                created_by VARCHAR(36),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                FOREIGN KEY (grade_id) REFERENCES grades(id) ON DELETE SET NULL,
                FOREIGN KEY (group_id) REFERENCES \`groups\`(id) ON DELETE SET NULL
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);
        console.log('✅ premium_lectures table created');

        // Create premium_lecture_payments table
        console.log('📦 Creating premium_lecture_payments table...');
        await connection.query(`
            CREATE TABLE IF NOT EXISTS premium_lecture_payments (
                id VARCHAR(36) PRIMARY KEY,
                student_id VARCHAR(36) NOT NULL,
                premium_lecture_id VARCHAR(36) NOT NULL,
                receipt_image VARCHAR(500),
                amount DECIMAL(10, 2) NOT NULL,
                status ENUM('pending', 'approved', 'rejected') DEFAULT 'pending',
                notes TEXT,
                rejection_reason TEXT,
                reviewed_by VARCHAR(36),
                reviewed_at TIMESTAMP NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE,
                FOREIGN KEY (premium_lecture_id) REFERENCES premium_lectures(id) ON DELETE CASCADE
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);
        console.log('✅ premium_lecture_payments table created');

        // Create premium_lecture_access table
        console.log('📦 Creating premium_lecture_access table...');
        await connection.query(`
            CREATE TABLE IF NOT EXISTS premium_lecture_access (
                id VARCHAR(36) PRIMARY KEY,
                student_id VARCHAR(36) NOT NULL,
                premium_lecture_id VARCHAR(36) NOT NULL,
                payment_id VARCHAR(36),
                granted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                granted_by VARCHAR(36),
                FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE,
                FOREIGN KEY (premium_lecture_id) REFERENCES premium_lectures(id) ON DELETE CASCADE,
                UNIQUE KEY unique_student_lecture (student_id, premium_lecture_id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);
        console.log('✅ premium_lecture_access table created');

        // Create indexes (ignore errors if they already exist)
        console.log('📦 Creating indexes...');
        try {
            await connection.query('CREATE INDEX idx_premium_lectures_grade ON premium_lectures(grade_id)');
        } catch (e) { /* Index may already exist */ }
        try {
            await connection.query('CREATE INDEX idx_premium_lectures_group ON premium_lectures(group_id)');
        } catch (e) { /* Index may already exist */ }
        try {
            await connection.query('CREATE INDEX idx_premium_payments_student ON premium_lecture_payments(student_id)');
        } catch (e) { /* Index may already exist */ }
        try {
            await connection.query('CREATE INDEX idx_premium_payments_lecture ON premium_lecture_payments(premium_lecture_id)');
        } catch (e) { /* Index may already exist */ }
        try {
            await connection.query('CREATE INDEX idx_premium_payments_status ON premium_lecture_payments(status)');
        } catch (e) { /* Index may already exist */ }
        try {
            await connection.query('CREATE INDEX idx_premium_access_student ON premium_lecture_access(student_id)');
        } catch (e) { /* Index may already exist */ }
        console.log('✅ Indexes created');

        console.log('\n✅ Premium Lectures tables migration completed successfully!');

        // Show tables
        const [tables] = await connection.query("SHOW TABLES LIKE 'premium%'");
        console.log('\n📋 Premium tables in database:');
        tables.forEach(t => {
            const tableName = Object.values(t)[0];
            console.log(`  ✓ ${tableName}`);
        });

    } catch (error) {
        console.error('❌ Migration error:', error.message);
    } finally {
        await connection.end();
        console.log('\n🔌 Connection closed');
    }
}

runMigration();
