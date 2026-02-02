const mysql = require('mysql2/promise');

async function fixReceiptColumn() {
    let connection;
    try {
        connection = await mysql.createConnection({
            host: 'localhost',
            user: 'root',
            password: '123580',
            database: 'Freelance',
            port: 3306
        });

        console.log('✅ Connected to database\n');

        // Check current column name
        const [columns] = await connection.query(`
            SELECT COLUMN_NAME 
            FROM INFORMATION_SCHEMA.COLUMNS 
            WHERE TABLE_SCHEMA = 'Freelance' 
            AND TABLE_NAME = 'premium_lecture_payments'
            AND COLUMN_NAME LIKE 'receipt%'
        `);

        console.log('Current receipt columns:', columns.map(c => c.COLUMN_NAME));

        if (columns.some(c => c.COLUMN_NAME === 'receipt_image')) {
            console.log('\n🔄 Renaming receipt_image to receipt_image_url...');

            await connection.query(`
                ALTER TABLE premium_lecture_payments 
                CHANGE COLUMN receipt_image receipt_image_url VARCHAR(500)
            `);

            console.log('✅ Column renamed successfully!');
        } else if (columns.some(c => c.COLUMN_NAME === 'receipt_image_url')) {
            console.log('\n✅ Column already named correctly (receipt_image_url)');
        } else {
            console.log('\n⚠️  No receipt column found, adding receipt_image_url...');

            await connection.query(`
                ALTER TABLE premium_lecture_payments 
                ADD COLUMN receipt_image_url VARCHAR(500) AFTER premium_lecture_id
            `);

            console.log('✅ Column added successfully!');
        }

        // Show final structure
        const [structure] = await connection.query('DESCRIBE premium_lecture_payments');
        console.log('\n📋 Final table structure:');
        console.table(structure);

        console.log('\n✅ Fix completed!');

    } catch (error) {
        console.error('❌ Error:', error.message);
        throw error;
    } finally {
        if (connection) {
            await connection.end();
            console.log('\n🔌 Database connection closed');
        }
    }
}

fixReceiptColumn();
