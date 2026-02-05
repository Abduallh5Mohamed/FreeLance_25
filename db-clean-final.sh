#!/bin/bash

echo "=========================================="
echo "Database Cleanup - Keep Admin Only"
echo "=========================================="

MYSQL_PWD='NewSecureP@ssw0rd2025!' mysql -u root freelance << 'EOF'

SET FOREIGN_KEY_CHECKS = 0;

-- Show admin before cleanup
SELECT 'Admin info before cleanup:' as info;
SELECT id, phone, name, role FROM users WHERE phone = '01024083057';

-- Clean all data tables
TRUNCATE TABLE account_statement;
TRUNCATE TABLE ai_chat_history;
TRUNCATE TABLE attendance;
TRUNCATE TABLE attendance_qr_codes;
TRUNCATE TABLE conversations;
TRUNCATE TABLE course_materials;
TRUNCATE TABLE course_statistics;
TRUNCATE TABLE courses;
TRUNCATE TABLE exam_attempts;
TRUNCATE TABLE exam_groups;
TRUNCATE TABLE exam_questions;
TRUNCATE TABLE exam_results;
TRUNCATE TABLE exam_student_answers;
TRUNCATE TABLE exams;
TRUNCATE TABLE expenses;
TRUNCATE TABLE financial_summary;
TRUNCATE TABLE grades;
TRUNCATE TABLE group_courses;
TRUNCATE TABLE groups;
TRUNCATE TABLE import_items;
TRUNCATE TABLE imports;
TRUNCATE TABLE lecture_purchases;
TRUNCATE TABLE lectures;
TRUNCATE TABLE material_groups;
TRUNCATE TABLE message_status;
TRUNCATE TABLE messages;
TRUNCATE TABLE online_meetings;
TRUNCATE TABLE premium_lecture_access;
TRUNCATE TABLE premium_lecture_payments;
TRUNCATE TABLE premium_lectures;
TRUNCATE TABLE staff;
TRUNCATE TABLE student_courses;
TRUNCATE TABLE student_fees;
TRUNCATE TABLE student_materials;
TRUNCATE TABLE student_registration_requests;
TRUNCATE TABLE student_statistics;
TRUNCATE TABLE students;
TRUNCATE TABLE subscription_plans;
TRUNCATE TABLE subscription_requests;
TRUNCATE TABLE subscriptions;
TRUNCATE TABLE teacher_messages;
TRUNCATE TABLE user_online_status;
TRUNCATE TABLE video_access_logs;
TRUNCATE TABLE video_processing_queue;
TRUNCATE TABLE video_uploads;
TRUNCATE TABLE videos;

-- Delete all users except admin
DELETE FROM users WHERE phone != '01024083057';

-- Update admin password: Mtd#mora55
UPDATE users SET 
    password = '$2b$10$d49pUjJJ9Pxb37R/Z832m.Loy2U6WHJCOEu7DR5ZfF1UuQFItjPHe',
    role = 'admin',
    is_active = 1,
    updated_at = NOW()
WHERE phone = '01024083057';

SET FOREIGN_KEY_CHECKS = 1;

-- Show results
SELECT '========== CLEANUP COMPLETE ==========' as status;
SELECT 'Remaining counts:' as info;
SELECT 'users' as tbl, COUNT(*) as cnt FROM users
UNION ALL SELECT 'students', COUNT(*) FROM students
UNION ALL SELECT 'exams', COUNT(*) FROM exams
UNION ALL SELECT 'lectures', COUNT(*) FROM lectures
UNION ALL SELECT 'videos', COUNT(*) FROM videos
UNION ALL SELECT 'messages', COUNT(*) FROM messages;

SELECT '========== ADMIN INFO ==========' as status;
SELECT id, phone, name, role, is_active FROM users;

EOF

echo "=========================================="
echo "Database cleanup complete!"
echo "=========================================="
