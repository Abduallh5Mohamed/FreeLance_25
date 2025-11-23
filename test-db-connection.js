require('dotenv').config();
const mysql = require('mysql2/promise');

(async () => {
  try {
    console.log('Env:', {
      host: process.env.DB_HOST,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD ? '***' : 'EMPTY',
      database: process.env.DB_NAME,
      port: process.env.DB_PORT
    });

    const connection = await mysql.createConnection({
      host: process.env.DB_HOST || 'localhost',
      user: process.env.DB_USER || 'root',
      password: process.env.DB_PASSWORD || '',
      database: process.env.DB_NAME || 'freelance',
      port: parseInt(process.env.DB_PORT || '3306')
    });

    await connection.ping();
    console.log('✅ MySQL connection successful!');
    await connection.end();
  } catch (error) {
    console.error('❌ Connection failed:', error.message);
    process.exit(1);
  }
})();
