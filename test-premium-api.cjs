const mysql = require('mysql2/promise');
require('dotenv').config({ path: './server/.env' });

async function testPremiumAPI() {
  console.log('🔍 Testing Premium Lectures API endpoints locally...\n');

  const connection = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'alqaed'
  });

  try {
    // Simulate GET /api/premium-lectures
    console.log('📡 Simulating GET /api/premium-lectures\n');
    
    const sql = `
      SELECT 
        pl.*,
        gr.name as grade_name,
        g.name as group_name,
        (SELECT COUNT(*) FROM premium_lecture_access WHERE premium_lecture_id = pl.id) as enrolled_count,
        (SELECT COUNT(*) FROM premium_lecture_payments WHERE premium_lecture_id = pl.id AND status = 'pending') as pending_payments
      FROM premium_lectures pl
      LEFT JOIN grades gr ON pl.grade_id = gr.id
      LEFT JOIN \`groups\` g ON pl.group_id = g.id
      WHERE 1=1
      ORDER BY pl.created_at DESC
    `;

    const [lectures] = await connection.query(sql);
    console.log(`✅ Found ${lectures.length} premium lectures`);
    console.log(JSON.stringify(lectures, null, 2));

    console.log('\n\n📡 Simulating GET /api/premium-lectures/payments\n');
    
    const paymentsSql = `
      SELECT 
        plp.*,
        pl.title as lecture_title,
        pl.price as lecture_price,
        s.name as student_name,
        s.phone as student_phone,
        gr.name as grade_name,
        g.name as group_name
      FROM premium_lecture_payments plp
      JOIN premium_lectures pl ON plp.premium_lecture_id = pl.id
      JOIN students s ON plp.student_id = s.id
      LEFT JOIN grades gr ON s.grade_id = gr.id
      LEFT JOIN \`groups\` g ON s.group_id = g.id
      WHERE 1=1
      ORDER BY plp.created_at DESC
    `;

    const [payments] = await connection.query(paymentsSql);
    console.log(`✅ Found ${payments.length} payments`);
    console.log(JSON.stringify(payments, null, 2));

    console.log('\n\n📡 Simulating GET /api/premium-lectures/payments/pending\n');
    
    const pendingSql = `
      SELECT 
        plp.*,
        pl.title as lecture_title,
        pl.price as lecture_price,
        s.name as student_name,
        s.phone as student_phone,
        gr.name as grade_name,
        g.name as group_name
      FROM premium_lecture_payments plp
      JOIN premium_lectures pl ON plp.premium_lecture_id = pl.id
      JOIN students s ON plp.student_id = s.id
      LEFT JOIN grades gr ON s.grade_id = gr.id
      LEFT JOIN \`groups\` g ON s.group_id = g.id
      WHERE plp.status = 'pending'
      ORDER BY plp.created_at ASC
    `;

    const [pending] = await connection.query(pendingSql);
    console.log(`✅ Found ${pending.length} pending payments`);
    console.log(JSON.stringify(pending, null, 2));

  } catch (error) {
    console.error('❌ Error:', error);
    console.error('Error message:', error.message);
    console.error('Error stack:', error.stack);
  } finally {
    await connection.end();
  }
}

testPremiumAPI().catch(console.error);
