// Run staff migration script
const mysql = require('mysql2/promise');
require('dotenv').config({ path: './server/.env' });

async function runMigration() {
    const connection = await mysql.createConnection({
        host: process.env.DB_HOST || 'localhost',
        user: process.env.DB_USER || 'root',
        password: process.env.DB_PASSWORD || '',
        database: process.env.DB_NAME || 'Freelance',
        port: parseInt(process.env.DB_PORT || '3306')
    });

    console.log('🔌 Connected to database');

    try {
        // Check if password_hash column exists
        const [columns] = await connection.query(
            `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS 
             WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'staff' AND COLUMN_NAME = 'password_hash'`,
            [process.env.DB_NAME]
        );

        if (columns.length === 0) {
            console.log('➕ Adding password_hash column...');
            await connection.query(`ALTER TABLE staff ADD COLUMN password_hash VARCHAR(255) NULL AFTER phone`);
            console.log('✅ password_hash column added');
        } else {
            console.log('✓ password_hash column already exists');
        }

        // Check if accessible_pages column exists
        const [accessColumns] = await connection.query(
            `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS 
             WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'staff' AND COLUMN_NAME = 'accessible_pages'`,
            [process.env.DB_NAME]
        );

        if (accessColumns.length === 0) {
            console.log('➕ Adding accessible_pages column...');
            await connection.query(`ALTER TABLE staff ADD COLUMN accessible_pages TEXT NULL`);
            console.log('✅ accessible_pages column added');
        } else {
            console.log('✓ accessible_pages column already exists');
        }

        // Check if index exists
        const [indexes] = await connection.query(
            `SHOW INDEX FROM staff WHERE Key_name = 'idx_staff_phone'`
        );

        if (indexes.length === 0) {
            console.log('➕ Adding phone index...');
            try {
                await connection.query(`CREATE INDEX idx_staff_phone ON staff(phone)`);
                console.log('✅ Phone index added');
            } catch (err) {
                // Index may already exist with different name
                console.log('⚠️ Could not add index (may already exist)');
            }
        } else {
            console.log('✓ Phone index already exists');
        }

        // Update null accessible_pages
        const [result] = await connection.query(
            `UPDATE staff SET accessible_pages = '[]' WHERE accessible_pages IS NULL`
        );
        console.log(`✅ Updated ${result.affectedRows} rows with null accessible_pages`);

        console.log('\n✅ Migration completed successfully!');

        // Show current staff table structure
        const [structure] = await connection.query(`DESCRIBE staff`);
        console.log('\n📋 Current staff table structure:');
        structure.forEach(col => {
            console.log(`  - ${col.Field}: ${col.Type} ${col.Null === 'YES' ? '(nullable)' : '(required)'}`);
        });

    } catch (error) {
        console.error('❌ Migration error:', error.message);
    } finally {
        await connection.end();
        console.log('\n🔌 Connection closed');
    }
}

runMigration();
