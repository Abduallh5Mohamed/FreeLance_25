import mysql from 'mysql2/promise';

(async () => {
  console.log('جاري الاتصال بقاعدة البيانات...');
  
  try {
    const connection = await mysql.createConnection({
      host: 'localhost',
      port: 3306,
      user: 'root',
      password: 'Omarmor@2005',
      database: 'Freelance',
    });

    console.log('✅ تم الاتصال بنجاح!');
    
    // اختبار بسيط - عرض الوقت من السيرفر
    const [rows] = await connection.query('SELECT NOW() as server_time');
    console.log('⏰ وقت السيرفر:', rows[0].server_time);
    
    // عرض عدد الجداول
    const [tables] = await connection.query('SHOW TABLES');
    console.log(`📊 عدد الجداول: ${tables.length}`);
    
    // عرض عدد المستخدمين
    const [users] = await connection.query('SELECT COUNT(*) as count FROM users');
    console.log(`👥 عدد المستخدمين: ${users[0].count}`);
    
    // عرض عدد الطلاب
    const [students] = await connection.query('SELECT COUNT(*) as count FROM students');
    console.log(`🎓 عدد الطلاب: ${students[0].count}`);
    
    await connection.end();
    console.log('\n✅ تم إغلاق الاتصال بنجاح');
    process.exit(0);
    
  } catch (error) {
    console.error('❌ خطأ في الاتصال:', error.message);
    console.error('تفاصيل:', error.code);
    
    if (error.code === 'ECONNREFUSED') {
      console.log('\n💡 تأكد من تشغيل MySQL على المنفذ 3306');
    } else if (error.code === 'ER_ACCESS_DENIED_ERROR') {
      console.log('\n💡 اسم المستخدم أو كلمة المرور غير صحيحة');
    } else if (error.code === 'ER_BAD_DB_ERROR') {
      console.log('\n💡 قاعدة البيانات Freelance غير موجودة - قم بتشغيل السكيما أولاً');
    }
    
    process.exit(1);
  }
})();
