const mysql = require('mysql2/promise');

(async () => {
    const connection = await mysql.createConnection({
        host: 'localhost',
        user: 'root',
        password: '123580',
        database: 'Freelance'
    });

    const [users] = await connection.execute(
        'SELECT id, phone, name, role FROM users WHERE role = ? LIMIT 3',
        ['student']
    );

    console.log('Sample users with role=student:');
    console.table(users);

    for (const u of users) {
        const [students] = await connection.execute(
            'SELECT id FROM students WHERE phone = ?',
            [u.phone]
        );
        console.log(`\nUser ${u.name} (${u.phone}):`);
        console.log(`  - Exists in students table: ${students.length > 0 ? 'YES ✅' : 'NO ❌'}`);
        if (students.length > 0) {
            console.log(`  - Student ID: ${students[0].id}`);
        }
    }

    await connection.end();
})();
