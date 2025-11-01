const bcrypt = require('bcryptjs');
const mysql = require('mysql2/promise');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

async function createAdminUser() {
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '123580',
    database: process.env.DB_NAME || 'Freelance',
    port: parseInt(process.env.DB_PORT || '3306')
  });

  try {
    console.log('🔐 Creating admin user...');

    // Hash the password: Mtd#mora55
    const passwordHash = await bcrypt.hash('Mtd#mora55', 10);

    // Insert or update admin user
    const [result] = await connection.execute(`
      INSERT INTO users (
        id,
        phone,
        password_hash,
        name,
        role,
        is_active,
        phone_verified,
        email_verified,
        created_at,
        updated_at
      ) VALUES (
        'b70636cb-b66b-11f0-b501-0a002700000f',
        '01024083057',
        ?,
        'Admin User',
        'admin',
        1,
        1,
        0,
        NOW(),
        NOW()
      ) ON DUPLICATE KEY UPDATE
        password_hash = VALUES(password_hash),
        name = VALUES(name),
        role = VALUES(role),
        is_active = VALUES(is_active),
        updated_at = NOW()
    `, [passwordHash]);

    console.log('✅ Admin user created/updated successfully!');
    console.log('');
    console.log('═══════════════════════════════════════');
    console.log('📱 Phone: 01024083057');
    console.log('🔑 Password: Mtd#mora55');
    console.log('👤 Role: admin');
    console.log('═══════════════════════════════════════');
    console.log('');

  } catch (error) {
    console.error('❌ Error creating admin user:', error.message);
    throw error;
  } finally {
    await connection.end();
  }
}

// Run if called directly
if (require.main === module) {
  createAdminUser()
    .then(() => {
      console.log('✅ Seed completed successfully!');
      process.exit(0);
    })
    .catch((error) => {
      console.error('❌ Seed failed:', error.message);
      process.exit(1);
    });
}

module.exports = { createAdminUser };
