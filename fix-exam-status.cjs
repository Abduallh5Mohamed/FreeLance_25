const mysql = require('mysql2/promise');

async function fix() {
    const pool = mysql.createPool({
        host: 'localhost',
        user: 'root',
        password: '123580',
        database: 'Freelance'
    });
    
    try {
        await pool.query(`ALTER TABLE exam_attempts MODIFY COLUMN status ENUM('in_progress','completed','expired','passed','failed') DEFAULT 'in_progress'`);
        console.log('✅ Updated status enum');
    } catch (e) {
        console.log('Status error:', e.message);
    }
    
    await pool.end();
}

fix();
