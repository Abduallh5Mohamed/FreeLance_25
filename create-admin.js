import bcrypt from 'bcryptjs';
import mysql from 'mysql2/promise';

async function createAdmin() {
    try {
        // Hash the password: 11223344
        const passwordHash = await bcrypt.hash('11223344', 10);
        console.log('Password hash generated:', passwordHash);

        // Connect to database
        const connection = await mysql.createConnection({
            host: 'localhost',
            user: 'root',
            password: '123580',
            database: 'Freelance'
        });

        console.log('Connected to database');

        // Insert admin user
        const [result] = await connection.execute(
            `INSERT INTO users (id, phone, password_hash, name, role, is_active, phone_verified, created_at, updated_at)
             VALUES (UUID(), ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
            ['01095336760', passwordHash, 'Admin User', 'admin', true, true]
        );

        console.log('✅ Admin user created successfully');
        console.log('📱 Phone: 01095336760');
        console.log('🔑 Password: 11223344');

        await connection.end();
    } catch (error) {
        console.error('❌ Error:', error.message);
        process.exit(1);
    }
}

createAdmin();
