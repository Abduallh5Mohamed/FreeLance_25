USE Freelance;

-- Delete groups without grade_id
DELETE FROM `groups` WHERE grade_id IS NULL;

-- Get grade IDs
SET @grade1_id = (SELECT id FROM grades WHERE name = 'الصف الأول الثانوي' AND is_active = TRUE LIMIT 1);
SET @grade2_id = (SELECT id FROM grades WHERE name = 'الصف الثاني الثانوي' AND is_active = TRUE LIMIT 1);
SET @grade3_id = (SELECT id FROM grades WHERE name = 'الصف الثالث الثانوي' AND is_active = TRUE LIMIT 1);

-- Insert groups with proper grade_id
INSERT INTO `groups` (name, description, grade_id, is_active, max_students) VALUES
('مجموعة A - الصف الأول', 'المجموعة الأولى للصف الأول الثانوي', @grade1_id, TRUE, 30),
('مجموعة B - الصف الأول', 'المجموعة الثانية للصف الأول الثانوي', @grade1_id, TRUE, 30),
('مجموعة A - الصف الثاني', 'المجموعة الأولى للصف الثاني الثانوي', @grade2_id, TRUE, 30),
('مجموعة B - الصف الثاني', 'المجموعة الثانية للصف الثاني الثانوي', @grade2_id, TRUE, 30),
('مجموعة A - الصف الثالث', 'المجموعة الأولى للصف الثالث الثانوي', @grade3_id, TRUE, 30),
('مجموعة B - الصف الثالث', 'المجموعة الثانية للصف الثالث الثانوي', @grade3_id, TRUE, 30);

-- Verify
SELECT 'Groups created successfully!' as status;
SELECT 
    g.name as group_name,
    gr.name as grade_name,
    g.is_active
FROM `groups` g
INNER JOIN grades gr ON g.grade_id = gr.id
WHERE g.is_active = TRUE
ORDER BY gr.display_order, g.name;
