USE Freelance;

-- Clear existing data (optional - comment out if you want to keep existing data)
-- DELETE FROM `groups`;
-- DELETE FROM grades;

-- Insert grades if they don't exist
INSERT INTO grades (id, name, display_order, is_active) 
VALUES 
  (UUID(), 'الصف الأول الثانوي', 1, TRUE),
  (UUID(), 'الصف الثاني الثانوي', 2, TRUE),
  (UUID(), 'الصف الثالث الثانوي', 3, TRUE)
ON DUPLICATE KEY UPDATE name=name;

-- Get grade IDs
SET @grade1_id = (SELECT id FROM grades WHERE name = 'الصف الأول الثانوي' AND is_active = TRUE ORDER BY display_order LIMIT 1);
SET @grade2_id = (SELECT id FROM grades WHERE name = 'الصف الثاني الثانوي' AND is_active = TRUE ORDER BY display_order LIMIT 1);
SET @grade3_id = (SELECT id FROM grades WHERE name = 'الصف الثالث الثانوي' AND is_active = TRUE ORDER BY display_order LIMIT 1);

-- Insert groups for each grade
INSERT INTO `groups` (id, name, description, grade_id, is_active, max_students) 
VALUES 
  (UUID(), 'مجموعة A - الصف الأول', 'المجموعة الأولى للصف الأول الثانوي', @grade1_id, TRUE, 30),
  (UUID(), 'مجموعة B - الصف الأول', 'المجموعة الثانية للصف الأول الثانوي', @grade1_id, TRUE, 30),
  (UUID(), 'مجموعة A - الصف الثاني', 'المجموعة الأولى للصف الثاني الثانوي', @grade2_id, TRUE, 30),
  (UUID(), 'مجموعة B - الصف الثاني', 'المجموعة الثانية للصف الثاني الثانوي', @grade2_id, TRUE, 30),
  (UUID(), 'مجموعة A - الصف الثالث', 'المجموعة الأولى للصف الثالث الثانوي', @grade3_id, TRUE, 30),
  (UUID(), 'مجموعة B - الصف الثالث', 'المجموعة الثانية للصف الثالث الثانوي', @grade3_id, TRUE, 30)
ON DUPLICATE KEY UPDATE name=name;

-- Verify
SELECT 'Grades and Groups Created Successfully!' as status;
SELECT g.name as group_name, gr.name as grade_name, g.is_active
FROM `groups` g
LEFT JOIN grades gr ON g.grade_id = gr.id
WHERE g.is_active = TRUE
ORDER BY gr.display_order, g.name;
