import bcrypt from 'bcryptjs';
import mysql from 'mysql2/promise';
import dotenv from 'dotenv';

dotenv.config({ path: './server/.env' });

async function createAdmin() {
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'Freelance',
    port: process.env.DB_PORT || 3306
  });

  try {
    // بيانات الأدمن
    const adminPhone = '01000000000';
    const adminPassword = 'admin123';
    const adminName = 'المسؤول';

    // تشفير الباسورد
    const passwordHash = await bcrypt.hash(adminPassword, 10);

    // حذف المستخدم القديم إذا كان موجود
    await connection.execute('DELETE FROM users WHERE phone = ?', [adminPhone]);

    // إنشاء المستخدم الجديد
    const [result] = await connection.execute(
      `INSERT INTO users (id, phone, password_hash, name, role, phone_verified, is_active) 
       VALUES (UUID(), ?, ?, ?, 'admin', TRUE, TRUE)`,
      [adminPhone, passwordHash, adminName]
    );

    console.log('✅ تم إنشاء مستخدم Admin بنجاح!');
    console.log('');
    console.log('📱 رقم التليفون: 01000000000');
    console.log('🔑 كلمة المرور: admin123');
    console.log('');
    console.log('⚠️  تأكد من تغيير كلمة المرور بعد أول تسجيل دخول!');

    // عرض بيانات المستخدم
    const [users] = await connection.execute(
      'SELECT id, phone, name, role, is_active, created_at FROM users WHERE phone = ?',
      [adminPhone]
    );

    console.log('');
    console.log('📊 بيانات المستخدم:');
    console.table(users);

  } catch (error) {
    console.error('❌ خطأ في إنشاء المستخدم:', error.message);
  } finally {
    await connection.end();
  }
}

createAdmin();
