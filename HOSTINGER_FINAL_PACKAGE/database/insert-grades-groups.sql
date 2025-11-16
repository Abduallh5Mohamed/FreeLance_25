-- إضافة الصفوف الدراسية
INSERT INTO grades (name, display_order, is_active) VALUES
('الصف الأول الثانوي', 1, TRUE),
('الصف الثاني الثانوي', 2, TRUE),
('الصف الثالث الثانوي', 3, TRUE)
ON DUPLICATE KEY UPDATE name = VALUES(name);

-- إضافة المجموعات
INSERT INTO `groups` (name, description, max_students, is_active) VALUES
('المجموعة الأولى', 'مجموعة صباحية', 30, TRUE),
('المجموعة الثانية', 'مجموعة مسائية', 30, TRUE),
('المجموعة الثالثة', 'مجموعة نهاية الأسبوع', 25, TRUE),
('المجموعة الرابعة', 'مجموعة خاصة', 20, TRUE)
ON DUPLICATE KEY UPDATE name = VALUES(name);

-- عرض البيانات المضافة
SELECT 'Grades:' as '';
SELECT * FROM grades WHERE is_active = TRUE;

SELECT 'Groups:' as '';
SELECT * FROM `groups` WHERE is_active = TRUE;
