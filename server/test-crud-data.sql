-- Test CRUD operations with Arabic data
USE freelance;

-- Test: Create a course
INSERT INTO courses (id, name, subject, description, grade, price, is_active, created_at, updated_at)
VALUES (UUID(), 'رياضيات الصف الأول', 'رياضيات', 'دورة الرياضيات للصف الأول الثانوي', 'الصف الأول الثانوي', 500.00, TRUE, NOW(), NOW());

-- Test: Create a student
INSERT INTO students (id, name, email, phone, grade, is_offline, approval_status, created_at, updated_at)
VALUES (UUID(), 'أحمد محمد علي', 'ahmed@test.com', '01234567890', 'الصف الأول الثانوي', FALSE, 'approved', NOW(), NOW());

-- Test: Create attendance record
SET @student_id = (SELECT id FROM students WHERE email = 'ahmed@test.com' LIMIT 1);
INSERT INTO attendance (id, student_id, attendance_date, status, notes, created_at)
VALUES (UUID(), @student_id, CURDATE(), 'present', 'حضور منتظم', NOW());

-- Test: Create an exam
SET @course_id = (SELECT id FROM courses WHERE name = 'رياضيات الصف الأول' LIMIT 1);
INSERT INTO exams (id, title, description, course_id, duration_minutes, total_marks, passing_marks, is_active, created_at, updated_at)
VALUES (UUID(), 'اختبار الوحدة الأولى', 'اختبار تجريبي على الوحدة الأولى', @course_id, 60, 50, 25, TRUE, NOW(), NOW());

-- Verify data
SELECT 'Courses:' as table_name;
SELECT id, name, subject FROM courses;

SELECT 'Students:' as table_name;
SELECT id, name, email, grade FROM students;

SELECT 'Attendance:' as table_name;
SELECT a.id, s.name as student_name, a.attendance_date, a.status FROM attendance a
LEFT JOIN students s ON a.student_id = s.id;

SELECT 'Exams:' as table_name;
SELECT e.id, e.title, c.name as course_name, e.total_marks FROM exams e
LEFT JOIN courses c ON e.course_id = c.id;
