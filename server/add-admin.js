const bcrypt = require('bcryptjs');
const mysql = require('mysql2/promise');
require('dotenv').config();

async function addAdmin() {
    try {
        // إنشاء الاتصال بقاعدة البيانات
        const connection = await mysql.createConnection({
            host: process.env.DB_HOST || 'localhost',
            user: process.env.DB_USER || 'root',
            password: process.env.DB_PASSWORD || 'Omarmor@2005',
            database: process.env.DB_NAME || 'Freelance',
            port: process.env.DB_PORT || 3306
        });

        console.log('متصل بقاعدة البيانات...');

        const phone = process.argv[2] || process.env.ADMIN_PHONE || '01000000000';
        const password = process.argv[3] || process.env.ADMIN_PASSWORD || 'admin123';

        // تشفير كلمة المرور
        const passwordHash = await bcrypt.hash(password, 10);

        console.log('كلمة المرور المشفرة:', passwordHash);

        // التحقق من وجود المستخدم
        const [existing] = await connection.execute(
            'SELECT id FROM users WHERE phone = ?',
            [phone]
        );

        if (existing.length > 0) {
            console.log('المستخدم موجود بالفعل، سيتم تحديث كلمة المرور...');
            await connection.execute(
                'UPDATE users SET password_hash = ?, role = ?, is_active = TRUE WHERE phone = ?',
                [passwordHash, 'admin', phone]
            );
            console.log('تم تحديث المستخدم بنجاح!');
        } else {
            // إضافة المستخدم الجديد (ID سيتم توليده تلقائياً كـ UUID)
            const [result] = await connection.execute(
                `INSERT INTO users (phone, password_hash, name, role, is_active)
                 VALUES (?, ?, ?, ?, TRUE)`,
                [phone, passwordHash, 'Admin User', 'admin']
            );

            console.log('تم إضافة المستخدم الأدمن بنجاح!');
            console.log('عدد الصفوف المضافة:', result.affectedRows);
        }

        console.log('\nبيانات تسجيل الدخول:');
        console.log(`رقم الهاتف: ${phone}`);
        console.log(`كلمة المرور: ${password}`);

        await connection.end();
    } catch (error) {
        console.error('حدث خطأ:', error);
        process.exit(1);
    }
}

addAdmin();
