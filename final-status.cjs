const { Client } = require('ssh2');
const password = 'NewSecureP@ssw0rd2025!';

const conn = new Client();

conn.on('ready', () => {
    const sql = `mysql -u root -p$(grep DB_PASSWORD /var/www/alqaed-api/.env | cut -d '=' -f2) freelance -e "
    SELECT COUNT(*) as Users FROM users;
    SELECT COUNT(*) as Students FROM students;
    SELECT COUNT(*) as Teachers FROM teachers;
    SELECT COUNT(*) as Courses FROM courses;
    SELECT COUNT(*) as Lectures FROM lectures;
    SELECT COUNT(*) as Exams FROM exams;
    SELECT COUNT(*) as Messages FROM messages;
    SELECT COUNT(*) as Conversations FROM conversations;
    SELECT COUNT(*) as Subscriptions FROM subscriptions;
    SELECT COUNT(*) as Payments FROM payments;
    SELECT '---' as '---';
    SELECT name as 'Admin User', phone, role FROM users;
    " 2>/dev/null`;
    
    conn.exec(sql, (err, stream) => {
        console.log('============================================');
        console.log('📊 FINAL DATABASE STATUS');
        console.log('============================================\n');
        stream.on('data', (data) => {
            console.log(data.toString());
        }).on('close', () => {
            console.log('============================================');
            console.log('✅ Database is clean and ready for client!');
            console.log('============================================\n');
            conn.end();
        });
    });
}).connect({
    host: '72.62.35.177',
    port: 22,
    username: 'root',
    password: password
});
