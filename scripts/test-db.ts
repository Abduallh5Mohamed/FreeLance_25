import 'dotenv/config';
import db from '../src/lib/db';

async function testDatabaseConnection() {
    console.log('🔍 Testing MySQL connection...\n');

    try {
        // Test basic connection
        const connected = await db.testConnection();

        if (!connected) {
            console.error('❌ Failed to connect to database');
            process.exit(1);
        }

        // Test query
        console.log('📋 Testing queries...');
        const tables = await db.query(`
      SELECT TABLE_NAME 
      FROM information_schema.TABLES 
      WHERE TABLE_SCHEMA = DATABASE()
      ORDER BY TABLE_NAME
    `);

        console.log(`\n✅ Found ${tables.length} tables:`);
        tables.forEach((table: any) => {
            console.log(`   - ${table.TABLE_NAME}`);
        });

        // Test users table
        console.log('\n👥 Checking users table...');
        const userCount = await db.queryOne<{ count: number }>(
            'SELECT COUNT(*) as count FROM users'
        );
        console.log(`   Users count: ${userCount?.count || 0}`);

        // Test students table
        console.log('\n🎓 Checking students table...');
        const studentCount = await db.queryOne<{ count: number }>(
            'SELECT COUNT(*) as count FROM students'
        );
        console.log(`   Students count: ${studentCount?.count || 0}`);

        // Test courses table
        console.log('\n📚 Checking courses table...');
        const courseCount = await db.queryOne<{ count: number }>(
            'SELECT COUNT(*) as count FROM courses'
        );
        console.log(`   Courses count: ${courseCount?.count || 0}`);

        console.log('\n✅ All database tests passed!');
        console.log('🎉 Database is ready to use.\n');

        await db.closePool();
        process.exit(0);
    } catch (error) {
        console.error('\n❌ Database test failed:', error);
        await db.closePool();
        process.exit(1);
    }
}

testDatabaseConnection();
