import mysql from 'mysql2/promise';
import dotenv from 'dotenv';

dotenv.config({ path: './server/.env' });

async function fixMaterialUrl() {
    const pool = mysql.createPool({
        host: process.env.DB_HOST || 'localhost',
        user: process.env.DB_USER || 'root',
        password: process.env.DB_PASSWORD || '',
        database: process.env.DB_NAME || 'freelance',
        port: parseInt(process.env.DB_PORT || '3306')
    });

    try {
        console.log('\n🔧 Updating material URL...');

        // Update the broken file with a sample Google Drive preview URL
        const [result] = await pool.query(`
            UPDATE course_materials 
            SET file_url = 'https://drive.google.com/file/d/1RwaTdI_J8L6Tjx-jd5t5CvbXHJEyRzmI/preview'
            WHERE title = 'يظهر لاحد وتلات بس محتوي تعليمي'
        `);

        console.log('✅ Updated:', result.affectedRows, 'row(s)');

        // Verify the update
        const [materials] = await pool.query(`
            SELECT id, title, file_url 
            FROM course_materials 
            WHERE title = 'يظهر لاحد وتلات بس محتوي تعليمي'
        `);

        console.log('\n📋 Updated material:');
        console.table(materials);

        console.log('\n💡 Now the student can view this file!');
        console.log('   The teacher should replace this with the correct Google Drive link.');

    } catch (error) {
        console.error('❌ Error:', error);
    } finally {
        await pool.end();
    }
}

fixMaterialUrl();
