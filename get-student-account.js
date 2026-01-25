import mysql from 'mysql2/promise';
import dotenv from 'dotenv';
dotenv.config();

async function getStudentAccount() {
    const connection = await mysql.createConnection({
        host: 'localhost',
        user: 'root',
        password: '123580',
        database: 'Freelance',
    });

    try {
        const [users] = await connection.execute(`
            SELECT 
                u.id, 
                u.email, 
                u.phone, 
                u.role, 
                s.name as student_name
            FROM users u 
            LEFT JOIN students s ON u.student_id = s.id 
            WHERE u.role = 'student' 
            AND u.is_active = 1 
            LIMIT 1
        `);

        if (users.length > 0) {
            const student = users[0];
            console.log('\n✅ حساب طالب للتجربة:');
            console.log('========================');
            console.log(`📧 البريد الإلكتروني: ${student.email}`);
            console.log(`📱 رقم الهاتف: ${student.phone}`);
            console.log(`👤 الاسم: ${student.student_name || 'غير متوفر'}`);
            console.log(`🔑 الرول: ${student.role}`);
            console.log(`\n💡 للدخول استخدم:`);
            console.log(`   البريد/الهاتف: ${student.email || student.phone}`);
            console.log(`   كلمة المرور: يجب أن تكون معروفة من قبل (الافتراضية: 123456 أو password)`);
            console.log('========================\n');
        } else {
            console.log('❌ لا يوجد طلاب في قاعدة البيانات');
        }
    } catch (error) {
        console.error('❌ خطأ في الاتصال:', error.message);
    } finally {
        await connection.end();
    }
}

getStudentAccount();
