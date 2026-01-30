const mysql = require('mysql2/promise');
require('dotenv').config({ path: './server/.env' });

async function checkPremiumLectures() {
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'alqaed'
  });

  try {
    console.log('🔍 فحص الحصص المدفوعة...\n');

    const [lectures] = await connection.query(`
      SELECT 
        pl.*,
        g.name as grade_name,
        gr.name as group_name,
        u.name as teacher_name
      FROM premium_lectures pl
      LEFT JOIN grades g ON pl.grade_id = g.id
      LEFT JOIN \`groups\` gr ON pl.group_id = gr.id
      LEFT JOIN users u ON pl.created_by = u.id
      ORDER BY pl.created_at DESC
    `);

    if (lectures.length === 0) {
      console.log('❌ لا توجد حصص مدفوعة في الداتابيز');
      return;
    }

    console.log(`✅ عدد الحصص المدفوعة: ${lectures.length}\n`);

    lectures.forEach((lecture, index) => {
      console.log(`\n📌 حصة رقم ${index + 1}:`);
      console.log(`   - العنوان: ${lecture.title}`);
      console.log(`   - الوصف: ${lecture.description || 'لا يوجد'}`);
      console.log(`   - رابط الفيديو: ${lecture.video_url || '❌ فاضي!'}`);
      console.log(`   - الصورة المصغرة: ${lecture.thumbnail_url || 'لا توجد'}`);
      console.log(`   - المدة: ${lecture.duration_minutes} دقيقة`);
      console.log(`   - السعر: ${lecture.price} جنيه`);
      console.log(`   - الصف: ${lecture.grade_name || 'غير محدد'}`);
      console.log(`   - المجموعة: ${lecture.group_name || 'غير محدد'}`);
      console.log(`   - منشورة: ${lecture.is_published ? '✅ نعم' : '❌ لا'}`);
      console.log(`   - المدرس: ${lecture.teacher_name || 'غير معروف'}`);
      console.log(`   - تاريخ الإنشاء: ${lecture.created_at}`);
    });

  } catch (error) {
    console.error('❌ خطأ:', error.message);
  } finally {
    await connection.end();
  }
}

checkPremiumLectures();
