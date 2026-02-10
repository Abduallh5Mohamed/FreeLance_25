const { Client } = require('ssh2');
const password = 'NewSecureP@ssw0rd2025!';

const conn = new Client();

conn.on('ready', () => {
    console.log('🧹 Final Database Cleanup...\n');
    
    const sql = `mysql -u root -p$(grep DB_PASSWORD /var/www/alqaed-api/.env | cut -d '=' -f2) freelance 2>/dev/null <<'EOF'

SET FOREIGN_KEY_CHECKS = 0;

-- Clean all tables (use TRUNCATE for speed)
TRUNCATE TABLE message_status;
TRUNCATE TABLE messages;
TRUNCATE TABLE conversations;
TRUNCATE TABLE teacher_messages;
TRUNCATE TABLE exam_attempts;
TRUNCATE TABLE exam_results;
TRUNCATE TABLE exam_questions;
TRUNCATE TABLE exams;
DELETE FROM video_access_logs;
TRUNCATE TABLE lectures;
TRUNCATE TABLE courses;
TRUNCATE TABLE groups;
DELETE FROM student_groups;
TRUNCATE TABLE subscriptions;
DELETE FROM subscription_history;
TRUNCATE TABLE payments;
DELETE FROM payment_receipts;
TRUNCATE TABLE attendance;
TRUNCATE TABLE meetings;
DELETE FROM student_lecture_access;
DELETE FROM student_materials;
DELETE FROM student_notes;
DELETE FROM student_progress;
DELETE FROM student_registration_requests;
DELETE FROM guardian_phones;
TRUNCATE TABLE notifications;
TRUNCATE TABLE grades;
DELETE FROM student_reports;
TRUNCATE TABLE materials;
DELETE FROM files;
DELETE FROM security_logs;
TRUNCATE TABLE students;
DELETE FROM teachers;

SET FOREIGN_KEY_CHECKS = 1;

-- Show final status
SELECT '============================================' as '';
SELECT '📊 FINAL DATABASE STATUS' as '';
SELECT '============================================' as '';
SELECT CONCAT('Users: ', COUNT(*)) as 'Table' FROM users
UNION ALL SELECT CONCAT('Students: ', COUNT(*)) FROM students
UNION ALL SELECT CONCAT('Teachers: ', COUNT(*)) FROM teachers  
UNION ALL SELECT CONCAT('Courses: ', COUNT(*)) FROM courses
UNION ALL SELECT CONCAT('Lectures: ', COUNT(*)) FROM lectures
UNION ALL SELECT CONCAT('Exams: ', COUNT(*)) FROM exams
UNION ALL SELECT CONCAT('Messages: ', COUNT(*)) FROM messages
UNION ALL SELECT CONCAT('Conversations: ', COUNT(*)) FROM conversations
UNION ALL SELECT CONCAT('Subscriptions: ', COUNT(*)) FROM subscriptions
UNION ALL SELECT CONCAT('Payments: ', COUNT(*)) FROM payments
UNION ALL SELECT CONCAT('Attendance: ', COUNT(*)) FROM attendance
UNION ALL SELECT CONCAT('Materials: ', COUNT(*)) FROM materials
UNION ALL SELECT CONCAT('Notifications: ', COUNT(*)) FROM notifications;
SELECT '============================================' as '';
SELECT '👤 Remaining User:' as '';
SELECT name, phone, role, created_at FROM users;
SELECT '============================================' as '';
SELECT '✅ Database is clean and ready for client!' as '';

EOF
`;
    
    conn.exec(sql, (err, stream) => {
        stream.on('data', (data) => {
            process.stdout.write(data.toString());
        }).on('close', () => {
            console.log('\n🎯 All done!\n');
            conn.end();
        });
    });
}).connect({
    host: '72.62.35.177',
    port: 22,
    username: 'root',
    password: password
});
