-- إضافة بيانات تجريبية للموقع
-- Run this on the server: mysql -u root -p'NewSecureP@ssw0rd2025!' freelance < seed-demo-data.sql

-- تحقق من وجود المراحل الدراسية
INSERT INTO grades (id, name, created_at) VALUES 
(UUID(), 'الصف الأول الثانوي', NOW()),
(UUID(), 'الصف الثاني الثانوي', NOW()),
(UUID(), 'الصف الثالث الثانوي', NOW())
ON DUPLICATE KEY UPDATE name=name;

-- احصل على ID المرحلة الأولى
SET @grade1_id = (SELECT id FROM grades WHERE name LIKE '%الأول%' LIMIT 1);
SET @grade2_id = (SELECT id FROM grades WHERE name LIKE '%الثاني%' LIMIT 1);
SET @grade3_id = (SELECT id FROM grades WHERE name LIKE '%الثالث%' LIMIT 1);

-- إنشاء مجموعات إذا لم تكن موجودة
INSERT INTO `groups` (id, name, grade_id, created_at) VALUES 
(UUID(), 'المجموعة A - أولى ثانوي', @grade1_id, NOW()),
(UUID(), 'المجموعة B - ثانية ثانوي', @grade2_id, NOW()),
(UUID(), 'المجموعة C - ثالثة ثانوي', @grade3_id, NOW())
ON DUPLICATE KEY UPDATE name=name;

-- احصل على group IDs
SET @group1_id = (SELECT id FROM `groups` WHERE name LIKE '%A%' LIMIT 1);
SET @group2_id = (SELECT id FROM `groups` WHERE name LIKE '%B%' LIMIT 1);
SET @group3_id = (SELECT id FROM `groups` WHERE name LIKE '%C%' LIMIT 1);

-- إنشاء كورس
INSERT INTO courses (id, name, description, grade_id, created_at) VALUES 
(UUID(), 'التاريخ - الصف الأول الثانوي', 'منهج التاريخ للصف الأول الثانوي', @grade1_id, NOW()),
(UUID(), 'التاريخ - الصف الثاني الثانوي', 'منهج التاريخ للصف الثاني الثانوي', @grade2_id, NOW()),
(UUID(), 'التاريخ - الصف الثالث الثانوي', 'منهج التاريخ للصف الثالث الثانوي', @grade3_id, NOW())
ON DUPLICATE KEY UPDATE name=name;

-- احصل على course IDs
SET @course1_id = (SELECT id FROM courses WHERE name LIKE '%الأول%' LIMIT 1);
SET @course2_id = (SELECT id FROM courses WHERE name LIKE '%الثاني%' LIMIT 1);
SET @course3_id = (SELECT id FROM courses WHERE name LIKE '%الثالث%' LIMIT 1);

-- إنشاء امتحانات
INSERT INTO exams (id, title, description, course_id, grade_id, duration_minutes, total_marks, passing_marks, is_active, created_at) VALUES 
(UUID(), 'امتحان الوحدة الأولى - التاريخ', 'امتحان شامل على الوحدة الأولى', @course1_id, @grade1_id, 60, 50, 25, TRUE, NOW()),
(UUID(), 'امتحان نصف العام - التاريخ', 'امتحان نصف العام الدراسي', @course1_id, @grade1_id, 90, 100, 50, TRUE, NOW()),
(UUID(), 'اختبار قصير - الحضارة المصرية', 'اختبار قصير على الحضارة المصرية القديمة', @course2_id, @grade2_id, 30, 20, 10, TRUE, NOW())
ON DUPLICATE KEY UPDATE title=title;

-- ربط الامتحانات بالمجموعات
INSERT INTO exam_groups (exam_id, group_id)
SELECT e.id, @group1_id FROM exams e WHERE e.grade_id = @grade1_id
ON DUPLICATE KEY UPDATE exam_id=exam_id;

INSERT INTO exam_groups (exam_id, group_id)
SELECT e.id, @group2_id FROM exams e WHERE e.grade_id = @grade2_id
ON DUPLICATE KEY UPDATE exam_id=exam_id;

INSERT INTO exam_groups (exam_id, group_id)
SELECT e.id, @group3_id FROM exams e WHERE e.grade_id = @grade3_id
ON DUPLICATE KEY UPDATE exam_id=exam_id;

-- إضافة أسئلة للامتحان الأول
SET @exam1_id = (SELECT id FROM exams WHERE title LIKE '%الوحدة الأولى%' LIMIT 1);

INSERT INTO exam_questions (id, exam_id, question_text, question_type, options, correct_answer, points, display_order, created_at) VALUES 
(UUID(), @exam1_id, 'متى بدأت الحضارة المصرية القديمة؟', 'multiple_choice', '["3000 قبل الميلاد","5000 قبل الميلاد","2000 قبل الميلاد","1000 قبل الميلاد"]', '3000 قبل الميلاد', 10, 1, NOW()),
(UUID(), @exam1_id, 'من هو أول ملك وحّد مصر؟', 'multiple_choice', '["مينا","رمسيس","توت عنخ آمون","خوفو"]', 'مينا', 10, 2, NOW()),
(UUID(), @exam1_id, 'ما هي عاصمة مصر في الدولة القديمة؟', 'multiple_choice', '["ممفيس","طيبة","الإسكندرية","القاهرة"]', 'ممفيس', 10, 3, NOW()),
(UUID(), @exam1_id, 'الهرم الأكبر بني للملك خوفو', 'true_false', '["صحيح","خطأ"]', 'صحيح', 10, 4, NOW()),
(UUID(), @exam1_id, 'اشرح أهمية نهر النيل للحضارة المصرية القديمة', 'essay', NULL, NULL, 10, 5, NOW())
ON DUPLICATE KEY UPDATE question_text=question_text;

-- عرض النتائج
SELECT 'تم إضافة البيانات التجريبية بنجاح!' as result;
SELECT COUNT(*) as grades_count FROM grades;
SELECT COUNT(*) as groups_count FROM `groups`;
SELECT COUNT(*) as courses_count FROM courses;
SELECT COUNT(*) as exams_count FROM exams;
SELECT COUNT(*) as questions_count FROM exam_questions;
