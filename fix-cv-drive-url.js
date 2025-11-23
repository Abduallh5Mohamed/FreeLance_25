import mysql from 'mysql2/promise';
import dotenv from 'dotenv';

dotenv.config({ path: './server/.env' });

async function fixCv() {
    const pool = mysql.createPool({
        host: process.env.DB_HOST || 'localhost',
        user: process.env.DB_USER || 'root',
        password: process.env.DB_PASSWORD || '',
        database: process.env.DB_NAME || 'freelance',
        port: parseInt(process.env.DB_PORT || '3306')
    });
    try {
        const driveUrl = 'https://drive.google.com/file/d/1ywjs7vHyy9_xfpZDWANVV4vSQq7Oxcv7/preview';
        const [r] = await pool.query("UPDATE course_materials SET file_url=? WHERE title='cv'", [driveUrl]);
        console.log('Rows affected:', r.affectedRows);
        const [row] = await pool.query("SELECT id,title,file_url FROM course_materials WHERE title='cv'");
        console.table(row);
    } catch (e) {
        console.error(e);
    } finally { await pool.end(); }
}

fixCv();
