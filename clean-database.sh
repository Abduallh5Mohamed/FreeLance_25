#!/bin/bash
set -e

echo "🧹 Cleaning database - keeping only admin user..."

mysql -u root -p123580 Freelance <<'SQL'
-- Disable foreign key checks temporarily
SET FOREIGN_KEY_CHECKS = 0;

-- Delete all data from tables
DELETE FROM account_statement;
DELETE FROM attendance;
DELETE FROM attendance_qr_codes;
DELETE FROM course_materials;
DELETE FROM exam_groups;
DELETE FROM exam_questions;
DELETE FROM exam_results;
DELETE FROM exam_student_answers;
DELETE FROM exams;
DELETE FROM expenses;
DELETE FROM group_courses;
DELETE FROM import_items;
DELETE FROM imports;
DELETE FROM lectures;
DELETE FROM material_groups;
DELETE FROM online_meetings;
DELETE FROM staff;
DELETE FROM student_courses;
DELETE FROM student_fees;
DELETE FROM student_materials;
DELETE FROM student_registration_requests;
DELETE FROM subscription_requests;
DELETE FROM subscriptions;
DELETE FROM teacher_messages;

-- Delete students
DELETE FROM students;

-- Delete all users except admin
DELETE FROM users WHERE phone != '01024083057';

-- Re-enable foreign key checks
SET FOREIGN_KEY_CHECKS = 1;

-- Verify admin user still exists
SELECT 'Admin user:' as '', id, name, phone, role FROM users WHERE phone = '01024083057';

-- Show counts
SELECT 
  (SELECT COUNT(*) FROM users) as users_count,
  (SELECT COUNT(*) FROM students) as students_count,
  (SELECT COUNT(*) FROM exams) as exams_count,
  (SELECT COUNT(*) FROM lectures) as lectures_count,
  (SELECT COUNT(*) FROM materials) as materials_count;

SQL

echo ""
echo "✅ Database cleaned successfully!"
echo "✅ Admin user preserved: 01024083057 / Mtd#mora55"
