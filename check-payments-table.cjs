const mysql = require('mysql2/promise');

async function checkPaymentsTable() {
    let connection;
    try {
        connection = await mysql.createConnection({
            host: 'localhost',
            user: 'root',
            password: '123580',
            database: 'Freelance',
            port: 3306
        });

        console.log('✅ Connected to database\n');

        // Check if table exists
        const [tables] = await connection.query(`
            SELECT TABLE_NAME 
            FROM INFORMATION_SCHEMA.TABLES 
            WHERE TABLE_SCHEMA = 'Freelance' 
            AND TABLE_NAME = 'premium_lecture_payments'
        `);

        if (tables.length === 0) {
            console.log('❌ Table premium_lecture_payments does NOT exist!');
            console.log('Creating table...\n');

            await connection.query(`
                CREATE TABLE premium_lecture_payments (
                    id VARCHAR(36) PRIMARY KEY,
                    student_id VARCHAR(36) NOT NULL,
                    premium_lecture_id VARCHAR(36) NOT NULL,
                    receipt_image_url VARCHAR(500),
                    amount DECIMAL(10,2) DEFAULT 0,
                    notes TEXT,
                    status ENUM('pending', 'approved', 'rejected') DEFAULT 'pending',
                    reviewed_by VARCHAR(36),
                    reviewed_at TIMESTAMP NULL,
                    rejection_reason TEXT,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                    FOREIGN KEY (student_id) REFERENCES users(id) ON DELETE CASCADE,
                    FOREIGN KEY (premium_lecture_id) REFERENCES premium_lectures(id) ON DELETE CASCADE,
                    FOREIGN KEY (reviewed_by) REFERENCES users(id) ON DELETE SET NULL,
                    INDEX idx_student_status (student_id, status),
                    INDEX idx_lecture_status (premium_lecture_id, status),
                    INDEX idx_status (status)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
            `);

            console.log('✅ Table created successfully!\n');
        } else {
            console.log('✅ Table premium_lecture_payments EXISTS\n');
        }

        // Show structure
        const [structure] = await connection.query('DESCRIBE premium_lecture_payments');
        console.log('📋 Table structure:');
        console.table(structure);

        // Check premium_lectures table
        const [premiumLectures] = await connection.query(`
            SELECT TABLE_NAME 
            FROM INFORMATION_SCHEMA.TABLES 
            WHERE TABLE_SCHEMA = 'Freelance' 
            AND TABLE_NAME = 'premium_lectures'
        `);

        if (premiumLectures.length === 0) {
            console.log('\n❌ Table premium_lectures does NOT exist!');
            console.log('Creating table...\n');

            await connection.query(`
                CREATE TABLE premium_lectures (
                    id VARCHAR(36) PRIMARY KEY,
                    title VARCHAR(255) NOT NULL,
                    description TEXT,
                    video_url VARCHAR(500) NOT NULL,
                    thumbnail_url VARCHAR(500),
                    duration_minutes INT DEFAULT 0,
                    price DECIMAL(10,2) NOT NULL DEFAULT 0,
                    grade_id VARCHAR(36),
                    group_id VARCHAR(36),
                    is_published BOOLEAN DEFAULT false,
                    created_by VARCHAR(36) NOT NULL,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                    FOREIGN KEY (grade_id) REFERENCES grades(id) ON DELETE SET NULL,
                    FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE SET NULL,
                    FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE CASCADE,
                    INDEX idx_published (is_published),
                    INDEX idx_grade (grade_id),
                    INDEX idx_group (group_id)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
            `);

            console.log('✅ premium_lectures table created successfully!\n');
        }

        console.log('\n✅ All tables are ready!');

    } catch (error) {
        console.error('❌ Error:', error.message);
        console.error(error);
        throw error;
    } finally {
        if (connection) {
            await connection.end();
            console.log('\n🔌 Database connection closed');
        }
    }
}

checkPaymentsTable();
