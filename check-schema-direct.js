import mysql from 'mysql2/promise';

async function checkSchema() {
    let connection;
    try {
        connection = await mysql.createConnection({
            host: '72.62.35.177',
            user: 'Freelance',
            password: 'MyPass12345@',
            database: 'Freelance',
            connectTimeout: 20000
        });

        console.log('✅ Connected to database\n');

        // Check students table structure
        console.log('📋 Students table structure:\n');
        const [columns] = await connection.execute('SHOW COLUMNS FROM students');

        columns.forEach(col => {
            console.log(`   ${col.Field.padEnd(20)} | ${col.Type.padEnd(20)} | ${col.Null.padEnd(5)} | ${col.Key.padEnd(5)} | ${col.Default || 'NULL'}`);
        });

        console.log('\n==========================================\n');

        // Check for guardian_phone specifically
        const guardianColumn = columns.find(col => col.Field === 'guardian_phone');

        if (guardianColumn) {
            console.log('✅ guardian_phone column EXISTS');
            console.log(`   Type: ${guardianColumn.Type}`);
            console.log(`   Nullable: ${guardianColumn.Null}`);
            console.log(`   Default: ${guardianColumn.Default || 'NULL'}`);
        } else {
            console.log('❌ guardian_phone column DOES NOT EXIST!');
            console.log('\n🔧 Creating the column...\n');

            await connection.execute(
                `ALTER TABLE students ADD COLUMN guardian_phone VARCHAR(50) NULL AFTER phone`
            );

            console.log('✅ Column created successfully!');
        }

        console.log('\n==========================================\n');

        // Check student_registration_requests table
        console.log('📋 student_registration_requests table structure:\n');
        const [reqColumns] = await connection.execute('SHOW COLUMNS FROM student_registration_requests');

        reqColumns.forEach(col => {
            console.log(`   ${col.Field.padEnd(20)} | ${col.Type.padEnd(20)} | ${col.Null.padEnd(5)} | ${col.Key.padEnd(5)} | ${col.Default || 'NULL'}`);
        });

        const reqGuardianColumn = reqColumns.find(col => col.Field === 'guardian_phone');

        console.log('\n');
        if (reqGuardianColumn) {
            console.log('✅ guardian_phone column EXISTS in registration_requests');
        } else {
            console.log('❌ guardian_phone column MISSING in registration_requests!');
            console.log('\n🔧 Creating the column...\n');

            await connection.execute(
                `ALTER TABLE student_registration_requests ADD COLUMN guardian_phone VARCHAR(50) NULL AFTER phone`
            );

            console.log('✅ Column created successfully!');
        }

    } catch (error) {
        console.error('❌ Error:', error.message);
    } finally {
        if (connection) {
            await connection.end();
        }
    }
}

checkSchema();
