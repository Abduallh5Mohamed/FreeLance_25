// Test auth directly without going through server
import dotenv from 'dotenv';
import bcrypt from 'bcryptjs';
import mysql from 'mysql2/promise';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load .env from server folder
dotenv.config({ path: path.join(__dirname, '.env') });

console.log('🔧 Testing auth logic directly...');
console.log('DB_HOST:', process.env.DB_HOST);
console.log('DB_USER:', process.env.DB_USER);
console.log('DB_PASSWORD:', process.env.DB_PASSWORD ? '***SET***' : 'EMPTY!');
console.log('DB_NAME:', process.env.DB_NAME);

async function testAuth() {
    try {
        const connection = await mysql.createConnection({
            host: process.env.DB_HOST || 'localhost',
            user: process.env.DB_USER || 'root',
            password: process.env.DB_PASSWORD || '',
            database: process.env.DB_NAME || 'Freelance'
        });

        console.log('\n✅ Connected to database');

        const phone = '01095336760';
        const password = '11223344';

        console.log(`\n🔍 Looking for user with phone: ${phone}`);

        const [rows] = await connection.execute(
            `SELECT id, email, phone, name, role, student_id, is_active, email_verified, phone_verified, password_hash 
             FROM users WHERE phone = ? AND is_active = 1`,
            [phone]
        );

        console.log('Query result rows:', rows.length);

        if (rows.length === 0) {
            console.log('❌ No user found!');
            await connection.end();
            return;
        }

        const user = rows[0];
        console.log('\n👤 User found:');
        console.log('   ID:', user.id);
        console.log('   Phone:', user.phone);
        console.log('   Name:', user.name);
        console.log('   Role:', user.role);
        console.log('   is_active:', user.is_active);
        console.log('   password_hash exists:', !!user.password_hash);

        if (!user.password_hash) {
            console.log('❌ No password hash!');
            await connection.end();
            return;
        }

        console.log(`\n🔑 Testing password: ${password}`);
        console.log('   Hash:', user.password_hash.substring(0, 30) + '...');

        const isValid = await bcrypt.compare(password, user.password_hash);
        console.log('   Password valid:', isValid ? '✅ YES' : '❌ NO');

        if (isValid) {
            console.log('\n✅ Authentication would succeed!');
        } else {
            console.log('\n❌ Authentication would fail - wrong password');
        }

        await connection.end();
    } catch (error) {
        console.error('❌ Error:', error);
    }
}

testAuth();
