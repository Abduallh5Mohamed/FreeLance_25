import mysql from 'mysql2/promise';
import bcrypt from 'bcryptjs';
import pkg from 'uuid';
const { v1: uuidv1 } = pkg;

async function createTestStudent() {
    const connection = await mysql.createConnection({
        host: 'localhost',
        user: 'root',
        password: '123580',
        database: 'Freelance',
    });

    try {
        // كلمة المرور للاختبار
        const password = '123456';
        const hashedPassword = await bcrypt.hash(password, 10);
        
        // معلومات الطالب
        const phone = '01111111111';
        const studentName = 'Test Student';
        const studentId = uuidv1();
        const userId = uuidv1();
        
        // التحقق من وجود الطالب
        const [existingUsers] = await connection.execute(
            'SELECT id FROM users WHERE phone = ?',
            [phone]
        );
        
        if (existingUsers.length > 0) {
            console.log('⚠️  الطالب موجود بالفعل، سأقوم بتحديث كلمة المرور والاسم...\n');
            
            await connection.execute(
                'UPDATE users SET password_hash = ?, name = ? WHERE phone = ?',
                [hashedPassword, studentName, phone]
            );
            
            console.log('✅ تم تحديث كلمة المرور بنجاح!');
        } else {
            console.log('📝 إنشاء طالب جديد...\n');
            
            // إنشاء سجل في جدول students
            await connection.execute(
                'INSERT INTO students (id, name, phone, created_at, updated_at) VALUES (?, ?, ?, NOW(), NOW())',
                [studentId, studentName, phone]
            );
            
            // إنشاء حساب مستخدم
            await connection.execute(
                `INSERT INTO users 
                (id, phone, name, password_hash, role, student_id, is_active, phone_verified, created_at, updated_at) 
                VALUES (?, ?, ?, ?, 'student', ?, 1, 1, NOW(), NOW())`,
                [userId, phone, studentName, hashedPassword, studentId]
            );
            
            console.log('✅ تم إنشاء الطالب بنجاح!');
        }
        
        console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('📱 رقم الهاتف: ' + phone);
        console.log('🔑 كلمة المرور: ' + password);
        console.log('👤 الاسم: ' + studentName);
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
        
    } catch (error) {
        console.error('❌ خطأ:', error.message);
    } finally {
        await connection.end();
    }
}

createTestStudent();
