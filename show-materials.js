import mysql from 'mysql2/promise';
import dotenv from 'dotenv';

dotenv.config({ path: './server/.env' });

async function showMaterials() {
    const pool = mysql.createPool({
        host: process.env.DB_HOST || 'localhost',
        user: process.env.DB_USER || 'root',
        password: process.env.DB_PASSWORD || '',
        database: process.env.DB_NAME || 'freelance',
        port: parseInt(process.env.DB_PORT || '3306')
    });

    try {
        const [mats] = await pool.query('SELECT id, title, file_url FROM course_materials');
        console.table(mats);
    } catch (error) {
        console.error('Error:', error);
    } finally {
        await pool.end();
    }
}

showMaterials();
