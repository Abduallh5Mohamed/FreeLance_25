#!/bin/bash

# Fix nginx config
rm -f /etc/nginx/conf.d/security.conf
nginx -t && systemctl reload nginx
echo "Nginx fixed!"

# Database cleanup with correct syntax
echo "Starting database cleanup..."

MYSQL_PWD='NewSecureP@ssw0rd2025!' mysql -u root freelance -e "
SET FOREIGN_KEY_CHECKS = 0;

-- Show admin before cleanup
SELECT 'Admin info:' as info;
SELECT id, phone, name, role FROM users WHERE phone = '01024083057';

-- Clean tables
TRUNCATE TABLE exam_attempts;
TRUNCATE TABLE exam_answers;
TRUNCATE TABLE exam_questions;
TRUNCATE TABLE exams;
TRUNCATE TABLE student_lectures;
TRUNCATE TABLE lecture_materials;
TRUNCATE TABLE lectures;
TRUNCATE TABLE notifications;
TRUNCATE TABLE video_access_logs;
TRUNCATE TABLE video_processing_queue;
TRUNCATE TABLE videos;
TRUNCATE TABLE payments;
TRUNCATE TABLE payment_receipts;
TRUNCATE TABLE meetings;
TRUNCATE TABLE meeting_attendance;
TRUNCATE TABLE messages;
TRUNCATE TABLE chats;
TRUNCATE TABLE security_logs;
TRUNCATE TABLE sessions;
TRUNCATE TABLE registration_requests;

-- Delete students and guardians
DELETE FROM students;
DELETE FROM guardians;

-- Delete all users except admin
DELETE FROM users WHERE phone != '01024083057';

-- Update admin password
UPDATE users SET 
    password = '\$2b\$10\$d49pUjJJ9Pxb37R/Z832m.Loy2U6WHJCOEu7DR5ZfF1UuQFItjPHe',
    role = 'admin',
    is_active = 1,
    updated_at = NOW()
WHERE phone = '01024083057';

SET FOREIGN_KEY_CHECKS = 1;

SELECT '=== CLEANUP DONE ===' as status;
SELECT COUNT(*) as users_count FROM users;
SELECT id, phone, name, role FROM users;
"

echo "Database cleanup complete!"
