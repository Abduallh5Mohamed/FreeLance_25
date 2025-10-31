import mysql from 'mysql2/promise';
import bcrypt from 'bcryptjs';

async function addAdmin() {
  try {
    // Database connection
    const connection = await mysql.createConnection({
      host: 'localhost',
      user: 'root',
      password: '123580',
      database: 'Freelance'
    });

    console.log('✅ Connected to database');

    // Hash the password
    const password = 'Mtd#mora55';
    const hashedPassword = await bcrypt.hash(password, 10);
    
    console.log('✅ Password hashed');

    // Check if user already exists
    const [existing] = await connection.query(
      'SELECT id FROM users WHERE phone = ?',
      ['01024083057']
    );

    if (existing.length > 0) {
      // Update existing user
      await connection.query(
        `UPDATE users 
         SET password_hash = ?, 
             role = 'admin', 
             is_active = TRUE,
             phone_verified = TRUE
         WHERE phone = ?`,
        [hashedPassword, '01024083057']
      );
      console.log('✅ Updated existing user to admin');
    } else {
      // Insert new user
      await connection.query(
        `INSERT INTO users (
          phone, 
          password_hash, 
          name, 
          role, 
          is_active, 
          phone_verified
        ) VALUES (?, ?, ?, ?, ?, ?)`,
        ['01024083057', hashedPassword, 'Admin User', 'admin', true, true]
      );
      console.log('✅ Created new admin user');
    }

    // Show the user details
    const [users] = await connection.query(
      'SELECT id, phone, name, role, is_active FROM users WHERE phone = ?',
      ['01024083057']
    );

    console.log('\n📊 Admin User Details:');
    console.table(users);

    console.log('\n✅ Login credentials:');
    console.log('   Phone: 01024083057');
    console.log('   Password: Mtd#mora55');
    console.log('   Role: admin');

    await connection.end();
    process.exit(0);

  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  }
}

addAdmin();
