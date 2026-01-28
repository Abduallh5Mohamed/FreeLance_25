import bcrypt from 'bcryptjs';
import mysql from 'mysql2/promise';

async function testLogin() {
    try {
        console.log('🔍 Testing login for phone: 01095336760');
        
        // Connect to database
        const connection = await mysql.createConnection({
            host: 'localhost',
            user: 'root',
            password: '123580',
            database: 'Freelance'
        });

        console.log('✅ Connected to database');

        // Check if user exists
        const [users] = await connection.execute(
            `SELECT id, phone, password_hash, name, role, is_active, phone_verified FROM users WHERE phone = ?`,
            ['01095336760']
        );

        console.log('📦 Users found:', users.length);
        if (users.length > 0) {
            const user = users[0];
            console.log('👤 User details:');
            console.log('   ID:', user.id);
            console.log('   Phone:', user.phone);
            console.log('   Name:', user.name);
            console.log('   Role:', user.role);
            console.log('   Is Active:', user.is_active);
            console.log('   Phone Verified:', user.phone_verified);
            console.log('   Password Hash:', user.password_hash ? user.password_hash.substring(0, 20) + '...' : 'NULL');

            // Test password
            const password = '11223344';
            console.log('\n🔑 Testing password:', password);
            
            if (user.password_hash) {
                const isValid = await bcrypt.compare(password, user.password_hash);
                console.log('   Password valid:', isValid ? '✅ YES' : '❌ NO');
                
                if (!isValid) {
                    // Try generating a new hash to see what it should be
                    const newHash = await bcrypt.hash(password, 10);
                    console.log('\n📝 New hash for comparison:', newHash);
                    console.log('   Existing hash:', user.password_hash);
                }
            } else {
                console.log('   ⚠️ No password hash stored!');
            }
        } else {
            console.log('❌ User not found!');
        }

        await connection.end();
    } catch (error) {
        console.error('❌ Error:', error.message);
        console.error('Full error:', error);
        process.exit(1);
    }
}

testLogin();
