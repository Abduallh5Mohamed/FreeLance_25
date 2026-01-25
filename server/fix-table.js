const mysql = require('mysql2/promise');
require('dotenv').config();

async function fixTable() {
    const connection = await mysql.createConnection({
        host: process.env.DB_HOST || 'localhost',
        user: process.env.DB_USER || 'root',
        password: process.env.DB_PASSWORD || '123580',
        database: process.env.DB_NAME || 'Freelance',
        port: process.env.DB_PORT || 3306,
    });

    try {
        console.log('Connected to database...');
        
        // Fix student_registration_requests table
        console.log('\n--- Fixing student_registration_requests table ---');
        const [regColumns] = await connection.query(`
            SELECT COLUMN_NAME 
            FROM INFORMATION_SCHEMA.COLUMNS 
            WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'student_registration_requests'
        `, [process.env.DB_NAME || 'Freelance']);
        
        const regColumnNames = regColumns.map(c => c.COLUMN_NAME);
        console.log('Existing columns:', regColumnNames);
        
        if (!regColumnNames.includes('guardian_phone')) {
            console.log('Adding guardian_phone column...');
            await connection.query(`
                ALTER TABLE student_registration_requests 
                ADD COLUMN guardian_phone VARCHAR(50) NULL
            `);
            console.log('✅ Added guardian_phone column');
        } else {
            console.log('✅ guardian_phone column already exists');
        }
        
        if (!regColumnNames.includes('is_offline')) {
            console.log('Adding is_offline column...');
            await connection.query(`
                ALTER TABLE student_registration_requests 
                ADD COLUMN is_offline BOOLEAN DEFAULT FALSE
            `);
            console.log('✅ Added is_offline column');
        } else {
            console.log('✅ is_offline column already exists');
        }
        
        // Fix students table
        console.log('\n--- Fixing students table ---');
        const [studColumns] = await connection.query(`
            SELECT COLUMN_NAME 
            FROM INFORMATION_SCHEMA.COLUMNS 
            WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'students'
        `, [process.env.DB_NAME || 'Freelance']);
        
        const studColumnNames = studColumns.map(c => c.COLUMN_NAME);
        console.log('Existing columns:', studColumnNames);
        
        if (!studColumnNames.includes('guardian_phone')) {
            console.log('Adding guardian_phone column to students...');
            await connection.query(`
                ALTER TABLE students 
                ADD COLUMN guardian_phone VARCHAR(50) NULL
            `);
            console.log('✅ Added guardian_phone column to students');
        } else {
            console.log('✅ guardian_phone column already exists in students');
        }
        
        console.log('\nDone!');
    } catch (error) {
        console.error('Error:', error.message);
    } finally {
        await connection.end();
    }
}

fixTable();
