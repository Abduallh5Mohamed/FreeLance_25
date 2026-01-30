const mysql = require('mysql2/promise');
require('dotenv').config({ path: './server/.env' });

async function publishLecture() {
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'alqaed'
  });

  try {
    await connection.query('UPDATE premium_lectures SET is_published = 1 WHERE id = (SELECT id FROM (SELECT id FROM premium_lectures ORDER BY created_at DESC LIMIT 1) temp)');
    console.log('✅ تم نشر الحصة المدفوعة بنجاح!');
    
    const [lectures] = await connection.query('SELECT * FROM premium_lectures ORDER BY created_at DESC LIMIT 1');
    console.log('\n📌 بيانات الحصة بعد النشر:');
    console.log(lectures[0]);
  } catch (error) {
    console.error('❌ خطأ:', error.message);
  } finally {
    await connection.end();
  }
}

publishLecture();
