const mysql = require('mysql2/promise');

async function addEncryptionColumns() {
    let connection;
    try {
        connection = await mysql.createConnection({
            host: 'localhost',
            user: 'root',
            password: '123580',
            database: 'Freelance',
            port: 3306
        });

        console.log('✅ Connected to database');

        // Check if columns already exist
        const [columns] = await connection.query(`
            SELECT COLUMN_NAME 
            FROM INFORMATION_SCHEMA.COLUMNS 
            WHERE TABLE_SCHEMA = 'Freelance' 
            AND TABLE_NAME = 'videos'
            AND COLUMN_NAME IN ('encryption_key', 'encryption_iv', 'is_encrypted')
        `);

        const existingColumns = columns.map(c => c.COLUMN_NAME);
        console.log('Existing encryption columns:', existingColumns);

        // Add missing columns
        if (!existingColumns.includes('encryption_key')) {
            await connection.query(`
                ALTER TABLE videos 
                ADD COLUMN encryption_key VARCHAR(64) DEFAULT NULL COMMENT 'AES-128 encryption key (hex)'
            `);
            console.log('✅ Added encryption_key column');
        } else {
            console.log('⏭️  encryption_key already exists');
        }

        if (!existingColumns.includes('encryption_iv')) {
            await connection.query(`
                ALTER TABLE videos 
                ADD COLUMN encryption_iv VARCHAR(64) DEFAULT NULL COMMENT 'Initialization vector (hex)'
            `);
            console.log('✅ Added encryption_iv column');
        } else {
            console.log('⏭️  encryption_iv already exists');
        }

        if (!existingColumns.includes('is_encrypted')) {
            await connection.query(`
                ALTER TABLE videos 
                ADD COLUMN is_encrypted TINYINT(1) DEFAULT 0 COMMENT 'Whether video is encrypted'
            `);
            console.log('✅ Added is_encrypted column');
        } else {
            console.log('⏭️  is_encrypted already exists');
        }

        // Show final structure
        const [structure] = await connection.query('DESCRIBE videos');
        console.log('\n📋 Videos table structure:');
        console.table(structure);

        console.log('\n✅ All encryption columns are ready!');

    } catch (error) {
        console.error('❌ Error:', error.message);
        throw error;
    } finally {
        if (connection) {
            await connection.end();
            console.log('🔌 Database connection closed');
        }
    }
}

addEncryptionColumns();
