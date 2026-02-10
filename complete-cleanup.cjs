const { Client } = require('ssh2');

const password = 'NewSecureP@ssw0rd2025!';
const ADMIN_ID = '69fe1174-c98d-11f0-9d07-94e8d4b653c4';

const conn = new Client();

conn.on('ready', () => {
    console.log('🧹 Completing Database Cleanup...\n');
    
    const completeCleanup = `
        DB_PASS=$(grep DB_PASSWORD /var/www/alqaed-api/.env | cut -d '=' -f2)
        mysql -u root -p"$DB_PASS" freelance 2>/dev/null <<'EOF'
        
SET FOREIGN_KEY_CHECKS = 0;

-- Delete remaining data
DELETE FROM courses;
DELETE FROM groups;
DELETE FROM subscriptions;
DELETE FROM payments;
DELETE FROM payment_receipts;
DELETE FROM attendance;
DELETE FROM meetings;
DELETE FROM student_lecture_access;
DELETE FROM student_materials;
DELETE FROM student_notes;
DELETE FROM student_progress;
DELETE FROM student_registration_requests;
DELETE FROM guardian_phones;
DELETE FROM notifications;
DELETE FROM grades;
DELETE FROM student_reports;
DELETE FROM materials;
DELETE FROM files;
DELETE FROM security_logs;

-- Delete teachers (keep admin if teacher)
DELETE FROM teachers WHERE user_id != '${ADMIN_ID}';

-- Delete all students
DELETE FROM students;

-- Delete users (keep admin only)
DELETE FROM users WHERE id != '${ADMIN_ID}';

SET FOREIGN_KEY_CHECKS = 1;

-- Show result
SELECT '✅ Cleanup Complete!' as '';
SELECT '========================================' as '';
SELECT CONCAT('Users: ', COUNT(*)) as 'Final Count' FROM users
UNION ALL
SELECT CONCAT('Students: ', COUNT(*)) FROM students
UNION ALL
SELECT CONCAT('Teachers: ', COUNT(*)) FROM teachers
UNION ALL
SELECT CONCAT('Courses: ', COUNT(*)) FROM courses
UNION ALL
SELECT CONCAT('Lectures: ', COUNT(*)) FROM lectures
UNION ALL
SELECT CONCAT('Exams: ', COUNT(*)) FROM exams
UNION ALL
SELECT CONCAT('Messages: ', COUNT(*)) FROM messages
UNION ALL
SELECT CONCAT('Subscriptions: ', COUNT(*)) FROM subscriptions
UNION ALL
SELECT CONCAT('Payments: ', COUNT(*)) FROM payments;

SELECT '========================================' as '';
SELECT 'Admin User (Preserved):' as '';
SELECT name, phone, role FROM users WHERE id = '${ADMIN_ID}';
SELECT '========================================' as '';

EOF
    `;
    
    conn.exec(completeCleanup, (err, stream) => {
        if (err) {
            console.error('❌ Error:', err);
            conn.end();
            return;
        }
        
        stream.on('data', (data) => {
            process.stdout.write(data.toString());
        }).on('close', () => {
            console.log('\n✅ Database cleanup completed!');
            console.log('🎯 Database is clean and ready for client!\n');
            conn.end();
        });
    });
}).connect({
    host: '72.62.35.177',
    port: 22,
    username: 'root',
    password: password
});
