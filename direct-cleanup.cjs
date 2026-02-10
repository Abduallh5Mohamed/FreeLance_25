const { Client } = require('ssh2');

const password = 'NewSecureP@ssw0rd2025!';
const ADMIN_ID = '69fe1174-c98d-11f0-9d07-94e8d4b653c4';

const conn = new Client();

conn.on('ready', () => {
    console.log('🧹 Starting Database Cleanup...\n');
    
    const cleanupSQL = `
        mysql -u root -p\$(grep DB_PASSWORD /var/www/alqaed-api/.env | cut -d '=' -f2) freelance 2>/dev/null <<'SQLEOF'
        
SET FOREIGN_KEY_CHECKS = 0;

-- Messages
DELETE FROM message_status;
DELETE FROM messages;
DELETE FROM conversations;
DELETE FROM teacher_messages;
SELECT '✅ Messages deleted' as '';

-- Exams
DELETE FROM exam_attempts;
DELETE FROM exam_results;
DELETE FROM exam_questions;
DELETE FROM exams;
SELECT '✅ Exams deleted' as '';

-- Lectures
DELETE FROM lecture_views;
DELETE FROM video_access_logs;
DELETE FROM lecture_materials;
DELETE FROM lectures;
SELECT '✅ Lectures deleted' as '';

-- Courses & Groups
DELETE FROM student_course_access;
DELETE FROM courses;
DELETE FROM student_groups;
DELETE FROM groups;
SELECT '✅ Courses deleted' as '';

-- Subscriptions
DELETE FROM subscription_history;
DELETE FROM subscriptions;
DELETE FROM payments;
DELETE FROM payment_receipts;
SELECT '✅ Subscriptions deleted' as '';

-- Attendance
DELETE FROM attendance;
DELETE FROM meetings;
SELECT '✅ Attendance deleted' as '';

-- Student Data
DELETE FROM student_lecture_access;
DELETE FROM student_materials;
DELETE FROM student_notes;
DELETE FROM student_progress;
SELECT '✅ Student data deleted' as '';

-- Registration
DELETE FROM student_registration_requests;
DELETE FROM guardian_phones;
SELECT '✅ Registrations deleted' as '';

-- Notifications
DELETE FROM notifications;
SELECT '✅ Notifications deleted' as '';

-- Grades
DELETE FROM grades;
DELETE FROM student_reports;
SELECT '✅ Grades deleted' as '';

-- Materials
DELETE FROM materials;
DELETE FROM files;
SELECT '✅ Materials deleted' as '';

-- Teachers
DELETE FROM teachers WHERE user_id != '${ADMIN_ID}';
SELECT '✅ Teachers deleted' as '';

-- Students
DELETE FROM students;
SELECT '✅ Students deleted' as '';

-- Users (keep admin only)
DELETE FROM users WHERE id != '${ADMIN_ID}';
SELECT '✅ Users cleaned (Admin kept)' as '';

-- Logs
DELETE FROM security_logs;
SELECT '✅ Logs deleted' as '';

SET FOREIGN_KEY_CHECKS = 1;

-- Show final status
SELECT '========================================' as '';
SELECT 'FINAL COUNT:' as '';
SELECT CONCAT('Users: ', COUNT(*)) FROM users
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
SELECT CONCAT('Subscriptions: ', COUNT(*)) FROM subscriptions;

SELECT '========================================' as '';
SELECT 'Admin user:' as '';
SELECT name, phone, role FROM users WHERE id = '${ADMIN_ID}';
SELECT '========================================' as '';

SQLEOF
    `;
    
    conn.exec(cleanupSQL, (err, stream) => {
        if (err) {
            console.error('❌ Error:', err);
            conn.end();
            return;
        }
        
        let output = '';
        stream.on('data', (data) => {
            output += data.toString();
            process.stdout.write(data.toString());
        }).on('close', (code) => {
            console.log('\n============================================');
            if (code === 0) {
                console.log('✅ Database cleanup completed!');
                console.log('🎯 Database is clean and ready for client!');
            } else {
                console.log('⚠️  Exit code:', code);
            }
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
