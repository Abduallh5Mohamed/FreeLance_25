/**
 * سكريبت لإنشاء جداول الحصص المدفوعة
 * npm run create-premium-tables
 */

const mysql = require('mysql2/promise');
require('dotenv').config();

const sql = `
-- جدول الحصص المدفوعة
CREATE TABLE IF NOT EXISTS premium_lectures (
    id VARCHAR(36) PRIMARY KEY,
    title VARCHAR(255) NOT NULL,
    description TEXT,
    video_url VARCHAR(500) NOT NULL,
    thumbnail_url VARCHAR(500),
    duration_minutes INT DEFAULT 0,
    price DECIMAL(10, 2) NOT NULL DEFAULT 0,
    grade_id VARCHAR(36),
    group_id VARCHAR(36),
    is_published BOOLEAN DEFAULT FALSE,
    created_by VARCHAR(36),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- جدول طلبات الدفع للحصص المدفوعة
CREATE TABLE IF NOT EXISTS premium_lecture_payments (
    id VARCHAR(36) PRIMARY KEY,
    student_id VARCHAR(36) NOT NULL,
    premium_lecture_id VARCHAR(36) NOT NULL,
    receipt_image_url VARCHAR(500) NOT NULL,
    amount DECIMAL(10, 2) NOT NULL,
    status ENUM('pending', 'approved', 'rejected') DEFAULT 'pending',
    notes TEXT,
    rejection_reason TEXT,
    reviewed_by VARCHAR(36),
    reviewed_at TIMESTAMP NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- جدول وصول الطلاب للحصص المدفوعة
CREATE TABLE IF NOT EXISTS premium_lecture_access (
    id VARCHAR(36) PRIMARY KEY,
    student_id VARCHAR(36) NOT NULL,
    premium_lecture_id VARCHAR(36) NOT NULL,
    payment_id VARCHAR(36) NOT NULL,
    granted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY unique_student_lecture (student_id, premium_lecture_id)
);
`;

async function createTables() {
    let connection;
    try {
        connection = await mysql.createConnection({
            host: process.env.DB_HOST || 'localhost',
            user: process.env.DB_USER || 'root',
            password: process.env.DB_PASSWORD || '',
            database: process.env.DB_NAME || 'freelance',
            multipleStatements: true
        });

        console.log('📦 إنشاء جداول الحصص المدفوعة...');
        
        const statements = sql.split(';').filter(s => s.trim());
        
        for (const statement of statements) {
            if (statement.trim()) {
                try {
                    await connection.execute(statement);
                    console.log('✅ تم تنفيذ:', statement.substring(0, 50) + '...');
                } catch (err) {
                    if (err.code !== 'ER_TABLE_EXISTS_ERROR') {
                        console.error('❌ خطأ:', err.message);
                    }
                }
            }
        }

        console.log('✅ تم إنشاء جداول الحصص المدفوعة بنجاح!');
        
    } catch (error) {
        console.error('❌ خطأ في الاتصال:', error.message);
    } finally {
        if (connection) {
            await connection.end();
        }
    }
}

createTables();
