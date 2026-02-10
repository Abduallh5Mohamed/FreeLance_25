const { Client } = require('ssh2');

const password = 'NewSecureP@ssw0rd2025!';
const ADMIN_ID = '69fe1174-c98d-11f0-9d07-94e8d4b653c4';

const conn = new Client();

conn.on('ready', () => {
    console.log('🔍 Checking Database Status...\n');
    
    const checkSQL = `
        DB_PASS=$(grep DB_PASSWORD /var/www/alqaed-api/.env | cut -d '=' -f2)
        mysql -u root -p"$DB_PASS" freelance 2>/dev/null <<'EOF'
SELECT '📊 Current Database Status:' as '';
SELECT '========================================' as '';
SELECT CONCAT('Users: ', COUNT(*)) as '' FROM users;
SELECT CONCAT('Students: ', COUNT(*)) as '' FROM students;
SELECT CONCAT('Teachers: ', COUNT(*)) as '' FROM teachers;
SELECT CONCAT('Courses: ', COUNT(*)) as '' FROM courses;
SELECT CONCAT('Lectures: ', COUNT(*)) as '' FROM lectures;
SELECT CONCAT('Exams: ', COUNT(*)) as '' FROM exams;
SELECT CONCAT('Messages: ', COUNT(*)) as '' FROM messages;
SELECT CONCAT('Subscriptions: ', COUNT(*)) as '' FROM subscriptions;
SELECT CONCAT('Payments: ', COUNT(*)) as '' FROM payments;
SELECT '========================================' as '';
SELECT 'Remaining Users:' as '';
SELECT id, name, phone, role FROM users;
SELECT '========================================' as '';
EOF
    `;
    
    conn.exec(checkSQL, (err, stream) => {
        if (err) {
            console.error('❌ Error:', err);
            conn.end();
            return;
        }
        
        stream.on('data', (data) => {
            process.stdout.write(data.toString());
        }).on('close', () => {
            console.log('\n');
            conn.end();
        });
    });
}).connect({
    host: '72.62.35.177',
    port: 22,
    username: 'root',
    password: password
});
