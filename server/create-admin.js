const bcrypt = require('bcryptjs');
const mysql = require('mysql2/promise');
require('dotenv').config();

async function createAdmin() {
    try {
        // إنشاء الاتصال بقاعدة البيانات
        const connection = await mysql.createConnection({
            host: process.env.DB_HOST || 'localhost',
            user: process.env.DB_USER || 'root',
            password: process.env.DB_PASSWORD || '',
            database: process.env.DB_NAME || 'Freelance',
            port: parseInt(process.env.DB_PORT || '3306')
        });

        console.log('✅ متصل بقاعدة البيانات');

        // تشفير كلمة المرور
        const username = 'admin';
        const password = 'admin123';
        const passwordHash = await bcrypt.hash(password, 10);

        console.log('🔐 تم تشفير كلمة المرور');

        // إضافة المستخدم
        const [result] = await connection.execute(
            `INSERT INTO users (phone, password_hash, name, role, is_active, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, NOW(), NOW())`,
            [username, passwordHash, 'Admin User', 'admin', true]
        );

        console.log('✅ تم إنشاء حساب الأدمن بنجاح!');
        console.log('📱 Username: admin');
        console.log('🔑 Password: admin123');

        await connection.end();
    } catch (error) {
        console.error('❌ خطأ:', error.message);
        process.exit(1);
    }
}

createAdmin();
