-- إصلاح مشكلة عدم ظهور المحتوى التعليمي
-- Fix materials not showing on student content page

-- 1. نشر جميع المواد التعليمية (تفعيل is_published)
UPDATE course_materials 
SET is_published = 1 
WHERE is_published = 0;

-- 2. ربط المستخدمين بالطلاب باستخدام رقم الهاتف
UPDATE users u
INNER JOIN students s ON u.phone = s.phone
SET u.student_id = s.id
WHERE u.role = 'student' 
  AND u.student_id IS NULL;

-- 3. التحقق من النتائج
SELECT 
    'Materials Published' as check_type,
    COUNT(*) as total_materials,
    SUM(is_published) as published_materials
FROM course_materials

UNION ALL

SELECT 
    'Students Linked' as check_type,
    COUNT(*) as total_users,
    SUM(CASE WHEN student_id IS NOT NULL THEN 1 ELSE 0 END) as linked_users
FROM users
WHERE role = 'student';

-- 4. عرض المواد مع المجموعات
SELECT 
    cm.id,
    cm.title,
    cm.material_type,
    cm.is_published,
    c.name as course_name,
    GROUP_CONCAT(mg.group_id) as group_ids
FROM course_materials cm
LEFT JOIN courses c ON cm.course_id = c.id
LEFT JOIN material_groups mg ON cm.id = mg.material_id
GROUP BY cm.id
LIMIT 10;

-- 5. عرض الطلاب مع مجموعاتهم
SELECT 
    s.id as student_id,
    s.name as student_name,
    s.phone,
    s.group_id,
    g.name as group_name,
    u.id as user_id
FROM students s
LEFT JOIN `groups` g ON s.group_id = g.id
LEFT JOIN users u ON s.id = u.student_id
WHERE s.is_active = 1
LIMIT 10;
