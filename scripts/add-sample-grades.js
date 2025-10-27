import mysql from 'mysql2/promise';

(async () => {
  console.log('🔄 جاري الاتصال بالداتابيز...');
  
  try {
    const connection = await mysql.createConnection({
      host: 'localhost',
      port: 3306,
      user: 'root',
      password: 'Omarmor@2005',
      database: 'Freelance',
    });

    console.log('✅ تم الاتصال بنجاح!\n');
    
    // حذف الصفوف القديمة
    await connection.query('DELETE FROM grades');
    console.log('🗑️  تم حذف الصفوف القديمة\n');
    
    // إضافة صفوف جديدة
    const grades = [
      { name: 'الصف الأول الثانوي', display_order: 1 },
      { name: 'الصف الثاني الثانوي', display_order: 2 },
      { name: 'الصف الثالث الثانوي', display_order: 3 }
    ];
    
    for (const grade of grades) {
      await connection.query(
        'INSERT INTO grades (name, display_order, is_active) VALUES (?, ?, TRUE)',
        [grade.name, grade.display_order]
      );
      console.log(`✅ تم إضافة: ${grade.name}`);
    }
    
    // عرض الصفوف
    console.log('\n📊 الصفوف الموجودة حالياً:');
    const [rows] = await connection.query('SELECT id, name, is_active FROM grades');
    console.table(rows);
    
    await connection.end();
    console.log('\n✅ تم الانتهاء بنجاح!');
    process.exit(0);
    
  } catch (error) {
    console.error('❌ خطأ:', error.message);
    process.exit(1);
  }
})();
