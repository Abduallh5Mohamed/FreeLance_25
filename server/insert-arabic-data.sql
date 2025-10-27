-- Fix Arabic encoding and insert groups
USE freelance;

-- Delete old data
DELETE FROM `groups`;

-- Insert Arabic groups
INSERT INTO `groups` (id, name, description, is_active, created_at, updated_at) VALUES
(UUID(), 'الصف الأول الثانوي', 'مجموعة طلاب الصف الأول الثانوي', TRUE, NOW(), NOW()),
(UUID(), 'الصف الثاني الثانوي', 'مجموعة طلاب الصف الثاني الثانوي', TRUE, NOW(), NOW()),
(UUID(), 'الصف الثالث الثانوي', 'مجموعة طلاب الصف الثالث الثانوي', TRUE, NOW(), NOW());

-- Insert default grades
DELETE FROM grades;
INSERT INTO grades (id, name, display_order, is_active) VALUES
(UUID(), 'الصف الأول الثانوي', 1, TRUE),
(UUID(), 'الصف الثاني الثانوي', 2, TRUE),
(UUID(), 'الصف الثالث الثانوي', 3, TRUE);

-- Verify data
SELECT 'Groups:' as table_name;
SELECT id, name, description FROM `groups`;

SELECT 'Grades:' as table_name;
SELECT id, name, display_order FROM grades;
