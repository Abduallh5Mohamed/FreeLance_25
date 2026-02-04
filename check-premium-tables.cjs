const mysql = require('mysql2/promise');
require('dotenv').config({ path: './server/.env' });

async function checkTables() {
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'alqaed'
  });

  try {
    console.log('🔍 Checking premium lectures tables...\n');

    // Check if tables exist
    const tables = ['premium_lectures', 'premium_lecture_payments', 'premium_lecture_access'];
    
    for (const table of tables) {
      try {
        const [result] = await connection.query(`SHOW TABLES LIKE '${table}'`);
        if (result.length > 0) {
          console.log(`✅ Table ${table} exists`);
          
          // Get count
          const [count] = await connection.query(`SELECT COUNT(*) as count FROM ${table}`);
          console.log(`   Records: ${count[0].count}`);
          
          // Show structure
          const [columns] = await connection.query(`DESCRIBE ${table}`);
          console.log(`   Columns: ${columns.map(c => c.Field).join(', ')}\n`);
        } else {
          console.log(`❌ Table ${table} does NOT exist\n`);
        }
      } catch (error) {
        console.error(`❌ Error checking ${table}:`, error.message, '\n');
      }
    }

    // Test the query from the route
    console.log('\n🧪 Testing the main query from /api/premium-lectures...\n');
    try {
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
      console.log(`✅ Query successful! Found ${lectures.length} lectures`);
      console.log('Sample data:', JSON.stringify(lectures[0], null, 2));
    } catch (error) {
      console.error('❌ Query failed:', error.message);
      console.error('Error details:', error);
    }

    // Test payments query
    console.log('\n🧪 Testing payments query from /api/premium-lectures/payments...\n');
    try {
      const sql = `
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
      
      const [payments] = await connection.query(sql);
      console.log(`✅ Payments query successful! Found ${payments.length} payments`);
    } catch (error) {
      console.error('❌ Payments query failed:', error.message);
      console.error('Error details:', error);
    }

  } catch (error) {
    console.error('❌ Error:', error);
  } finally {
    await connection.end();
  }
}

checkTables().catch(console.error);
