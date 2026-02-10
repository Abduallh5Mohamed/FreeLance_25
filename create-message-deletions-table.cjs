const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');

async function createTable() {
    console.log('=== Creating message_deletions table ===\n');

    // Read .env file
    const envPath = path.join(__dirname, '.env');
    if (!fs.existsSync(envPath)) {
        console.error('❌ .env file not found!');
        process.exit(1);
    }

    const envContent = fs.readFileSync(envPath, 'utf8');
    const env = {};
    envContent.split('\n').forEach(line => {
        const [key, ...values] = line.split('=');
        if (key && values.length) {
            env[key.trim()] = values.join('=').trim();
        }
    });

    console.log(`Database: ${env.DB_NAME}`);
    console.log(`User: ${env.DB_USER}`);
    console.log(`Host: ${env.DB_HOST}\n`);

    const connection = await mysql.createConnection({
        host: env.DB_HOST || 'localhost',
        user: env.DB_USER || 'root',
        password: env.DB_PASSWORD || '',
        database: env.DB_NAME || 'Freelance'
    });

    console.log('✅ Connected to database\n');

    // Drop table if exists (for clean start)
    try {
        await connection.execute('DROP TABLE IF EXISTS message_deletions');
        console.log('🗑️  Dropped existing table\n');
    } catch (err) {
        console.log('No existing table to drop\n');
    }

    // Create table
    const createTableSQL = `
    CREATE TABLE message_deletions (
      id INT AUTO_INCREMENT PRIMARY KEY,
      message_id INT NOT NULL,
      user_id VARCHAR(36) NOT NULL,
      deleted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY unique_message_user (message_id, user_id),
      FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `;

    await connection.execute(createTableSQL);
    console.log('✅ Table created successfully!\n');

    // Verify
    const [rows] = await connection.execute('DESCRIBE message_deletions');
    console.log('Table structure:');
    console.table(rows);

    await connection.end();
    console.log('\n✅ Done!');
}

createTable().catch(err => {
    console.error('❌ Error:', err.message);
    process.exit(1);
});
