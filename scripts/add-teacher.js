import mysql from 'mysql2/promise';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';

async function addTeacher() {
  try {
    const connection = await mysql.createConnection({
      host: 'localhost',
      user: 'root',
      password: '123580',
      database: 'Freelance'
    });

    console.log('✅ Connected to database');

    // Hash the password
    const password = 'teacher123';
    const hashedPassword = await bcrypt.hash(password, 10);
    
    console.log('✅ Password hashed');

    // Check if teacher user already exists
    const [existing] = await connection.query(
      'SELECT id FROM users WHERE phone = ? OR role = "teacher"',
      ['01111111111']
    );

    if (existing.length > 0) {
      console.log('✅ Teacher user already exists');
    } else {
      // Insert new teacher user
      await connection.query(
        `INSERT INTO users (
          phone, 
          password_hash, 
          name, 
          role, 
          is_active, 
          phone_verified
        ) VALUES (?, ?, ?, ?, ?, ?)`,
        ['01111111111', hashedPassword, 'Teacher User', 'teacher', true, true]
      );
      console.log('✅ Created new teacher user');
    }

    // Show teacher details
    const [teachers] = await connection.query(
      'SELECT id, phone, name, role, is_active FROM users WHERE role = "teacher"'
    );

    console.log('\n📊 Teacher User Details:');
    console.table(teachers);

    console.log('\n✅ Login credentials:');
    console.log('   Phone: 01111111111');
    console.log('   Password: teacher123');
    console.log('   Role: teacher');

    await connection.end();
    process.exit(0);

  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  }
}

addTeacher();
