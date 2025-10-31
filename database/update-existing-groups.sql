USE Freelance;

-- Delete all groups without grade_id
DELETE FROM `groups` WHERE grade_id IS NULL;

-- Insert sample groups with grade_id
INSERT INTO `groups` (name, description, grade_id, is_active, max_students) VALUES
('مجموعة السبت - الصف الأول', 'مجموعة يوم السبت للصف الأول الثانوي', 'cd4cd109-b2ff-11f0-9695-0a002700000f', TRUE, 30),
('مجموعة الأحد - الصف الأول', 'مجموعة يوم الأحد للصف الأول الثانوي', 'cd4cd109-b2ff-11f0-9695-0a002700000f', TRUE, 30),
('مجموعة السبت - الصف الثاني', 'مجموعة يوم السبت للصف الثاني الثانوي', 'cd4cf8f4-b2ff-11f0-9695-0a002700000f', TRUE, 30),
('مجموعة الأحد - الصف الثاني', 'مجموعة يوم الأحد للصف الثاني الثانوي', 'cd4cf8f4-b2ff-11f0-9695-0a002700000f', TRUE, 30),
('مجموعة السبت - الصف الثالث', 'مجموعة يوم السبت للصف الثالث الثانوي', 'cd4cfa4e-b2ff-11f0-9695-0a002700000f', TRUE, 30),
('مجموعة الأحد - الصف الثالث', 'مجموعة يوم الأحد للصف الثالث الثانوي', 'cd4cfa4e-b2ff-11f0-9695-0a002700000f', TRUE, 30);

-- Verify
SELECT 'Groups with grade_id created!' as status;
SELECT 
    g.name as group_name,
    gr.name as grade_name
FROM `groups` g
INNER JOIN grades gr ON g.grade_id = gr.id
WHERE g.is_active = TRUE
ORDER BY gr.display_order, g.name;
