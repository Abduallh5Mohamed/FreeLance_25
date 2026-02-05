#!/bin/bash

# ============================================
# DATABASE CLEANUP SCRIPT
# Keep only admin: 01024083057
# ============================================

echo "=========================================="
echo "Starting Database Cleanup..."
echo "=========================================="

MYSQL_PWD='NewSecureP@ssw0rd2025!' mysql -u root freelance << 'MYSQL_SCRIPT'

-- Disable foreign key checks
SET FOREIGN_KEY_CHECKS = 0;

-- Get admin info before cleanup
SELECT 'Admin user info:' as info;
SELECT id, phone, name, role FROM users WHERE phone = '01024083057';

-- Clean all data tables (TRUNCATE for speed)
TRUNCATE TABLE IF EXISTS exam_attempts;
TRUNCATE TABLE IF EXISTS exam_answers;
TRUNCATE TABLE IF EXISTS exam_questions;
TRUNCATE TABLE IF EXISTS exams;

TRUNCATE TABLE IF EXISTS student_lectures;
TRUNCATE TABLE IF EXISTS lecture_materials;
TRUNCATE TABLE IF EXISTS lectures;

TRUNCATE TABLE IF EXISTS notifications;

TRUNCATE TABLE IF EXISTS video_access_logs;
TRUNCATE TABLE IF EXISTS video_processing_queue;
TRUNCATE TABLE IF EXISTS videos;

TRUNCATE TABLE IF EXISTS payments;
TRUNCATE TABLE IF EXISTS payment_receipts;

TRUNCATE TABLE IF EXISTS meetings;
TRUNCATE TABLE IF EXISTS meeting_attendance;

TRUNCATE TABLE IF EXISTS messages;
TRUNCATE TABLE IF EXISTS chats;
TRUNCATE TABLE IF EXISTS chat_messages;

TRUNCATE TABLE IF EXISTS security_logs;
TRUNCATE TABLE IF EXISTS sessions;
TRUNCATE TABLE IF EXISTS registration_requests;

-- Delete all students
DELETE FROM students;

-- Delete all guardians
DELETE FROM guardians;

-- Delete all users EXCEPT admin
DELETE FROM users WHERE phone != '01024083057';

-- Update admin with new password hash
-- Password: Mtd#mora55
UPDATE users SET 
    password = '$2b$10$d49pUjJJ9Pxb37R/Z832m.Loy2U6WHJCOEu7DR5ZfF1UuQFItjPHe',
    role = 'admin',
    is_active = 1,
    updated_at = NOW()
WHERE phone = '01024083057';

-- Re-enable foreign key checks
SET FOREIGN_KEY_CHECKS = 1;

-- Show final status
SELECT '========== CLEANUP COMPLETE ==========' as status;
SELECT 'Users remaining:' as table_name, COUNT(*) as count FROM users
UNION ALL SELECT 'Students remaining:', COUNT(*) FROM students
UNION ALL SELECT 'Exams remaining:', COUNT(*) FROM exams
UNION ALL SELECT 'Lectures remaining:', COUNT(*) FROM lectures
UNION ALL SELECT 'Videos remaining:', COUNT(*) FROM videos
UNION ALL SELECT 'Payments remaining:', COUNT(*) FROM payments;

SELECT '========== ADMIN INFO ==========' as status;
SELECT id, phone, name, role, is_active FROM users;

MYSQL_SCRIPT

echo "=========================================="
echo "Database cleanup complete!"
echo "=========================================="
