#!/bin/bash

echo "🧹 Cleaning Database for Client Delivery..."
echo "============================================"
echo ""
echo "⚠️  Deleting ALL data except Admin user!"
echo "   Admin ID: 69fe1174-c98d-11f0-9d07-94e8d4b653c4"
echo ""

# Get database password
DB_PASS=$(grep DB_PASSWORD /var/www/alqaed-api/.env | cut -d '=' -f2)
ADMIN_ID="69fe1174-c98d-11f0-9d07-94e8d4b653c4"

echo ""
echo "Starting cleanup..."
echo "============================================"

mysql -u root -p"$DB_PASS" freelance <<EOF

-- Disable foreign key checks temporarily
SET FOREIGN_KEY_CHECKS = 0;

-- 1. Messages & Conversations
DELETE FROM message_status;
DELETE FROM messages;
DELETE FROM conversations;
DELETE FROM teacher_messages;
SELECT '✅ 1/15: Messages deleted' as status;

-- 2. Exams & Results
DELETE FROM exam_attempts;
DELETE FROM exam_results;
DELETE FROM exam_questions;
DELETE FROM exams;
SELECT '✅ 2/15: Exams deleted' as status;

-- 3. Lectures & Materials
DELETE FROM lecture_views;
DELETE FROM video_access_logs;
DELETE FROM lecture_materials;
DELETE FROM lectures;
SELECT '✅ 3/15: Lectures deleted' as status;

-- 4. Courses & Groups
DELETE FROM student_course_access;
DELETE FROM courses;
DELETE FROM student_groups;
DELETE FROM groups;
SELECT '✅ 4/15: Courses & Groups deleted' as status;

-- 5. Subscriptions & Payments
DELETE FROM subscription_history;
DELETE FROM subscriptions;
DELETE FROM payments;
DELETE FROM payment_receipts;
SELECT '✅ 5/15: Subscriptions deleted' as status;

-- 6. Attendance & Meetings
DELETE FROM attendance;
DELETE FROM meetings;
SELECT '✅ 6/15: Attendance deleted' as status;

-- 7. Student Data
DELETE FROM student_lecture_access;
DELETE FROM student_materials;
DELETE FROM student_notes;
DELETE FROM student_progress;
SELECT '✅ 7/15: Student data deleted' as status;

-- 8. Registration & Requests
DELETE FROM student_registration_requests;
DELETE FROM guardian_phones;
SELECT '✅ 8/15: Registration requests deleted' as status;

-- 9. Notifications
DELETE FROM notifications;
SELECT '✅ 9/15: Notifications deleted' as status;

-- 10. Grades & Reports
DELETE FROM grades;
DELETE FROM student_reports;
SELECT '✅ 10/15: Grades deleted' as status;

-- 11. Materials & Files
DELETE FROM materials;
DELETE FROM files;
SELECT '✅ 11/15: Materials deleted' as status;

-- 12. Teachers (keep only if admin is also teacher)
DELETE FROM teachers WHERE user_id != '$ADMIN_ID';
SELECT '✅ 12/15: Teachers deleted' as status;

-- 13. Students (delete all students)
DELETE FROM students;
SELECT '✅ 13/15: Students deleted' as status;

-- 14. Users (keep only admin)
DELETE FROM users WHERE id != '$ADMIN_ID';
SELECT '✅ 14/15: Users deleted (kept Admin only)' as status;

-- 15. Security & Logs
DELETE FROM security_logs;
DELETE FROM api_logs;
SELECT '✅ 15/15: Logs deleted' as status;

-- Re-enable foreign key checks
SET FOREIGN_KEY_CHECKS = 1;

-- Show final counts
SELECT '============================================' as '';
SELECT 'FINAL DATABASE STATUS:' as '';
SELECT '============================================' as '';

SELECT 'Users' as table_name, COUNT(*) as count FROM users
UNION ALL
SELECT 'Students', COUNT(*) FROM students
UNION ALL
SELECT 'Teachers', COUNT(*) FROM teachers
UNION ALL
SELECT 'Courses', COUNT(*) FROM courses
UNION ALL
SELECT 'Lectures', COUNT(*) FROM lectures
UNION ALL
SELECT 'Exams', COUNT(*) FROM exams
UNION ALL
SELECT 'Messages', COUNT(*) FROM messages
UNION ALL
SELECT 'Subscriptions', COUNT(*) FROM subscriptions
UNION ALL
SELECT 'Payments', COUNT(*) FROM payments
UNION ALL
SELECT 'Attendance', COUNT(*) FROM attendance;

SELECT '============================================' as '';
SELECT '✅ Cleanup Complete!' as '';
SELECT 'Admin user preserved:' as '';
SELECT id, name, phone, role FROM users WHERE id = '$ADMIN_ID';
SELECT '============================================' as '';

EOF

echo ""
echo "============================================"
echo "✅ Database cleanup completed successfully!"
echo "============================================"
echo ""
echo "📊 Summary:"
echo "   ✅ All student data deleted"
echo "   ✅ All courses and lectures deleted"
echo "   ✅ All exams and results deleted"
echo "   ✅ All messages deleted"
echo "   ✅ All subscriptions deleted"
echo "   ✅ Admin user preserved"
echo ""
echo "🎯 Database is clean and ready for client!"
echo "============================================"
