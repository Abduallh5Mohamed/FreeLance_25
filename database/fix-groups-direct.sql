USE Freelance;

-- Delete all existing groups
DELETE FROM `groups`;

-- Insert groups with direct grade_id values
INSERT INTO `groups` (name, description, grade_id, is_active, max_students) VALUES
('مجموعة A - الصف الأول', 'المجموعة الأولى للصف الأول الثانوي', 'cd4cd109-b2ff-11f0-9695-0a002700000f', TRUE, 30),
('مجموعة B - الصف الأول', 'المجموعة الثانية للصف الأول الثانوي', 'cd4cd109-b2ff-11f0-9695-0a002700000f', TRUE, 30),
('مجموعة A - الصف الثاني', 'المجموعة الأولى للصف الثاني الثانوي', 'cd4cf8f4-b2ff-11f0-9695-0a002700000f', TRUE, 30),
('مجموعة B - الصف الثاني', 'المجموعة الثانية للصف الثاني الثانوي', 'cd4cf8f4-b2ff-11f0-9695-0a002700000f', TRUE, 30),
('مجموعة A - الصف الثالث', 'المجموعة الأولى للصف الثالث الثانوي', 'cd4cfa4e-b2ff-11f0-9695-0a002700000f', TRUE, 30),
('مجموعة B - الصف الثالث', 'المجموعة الثانية للصف الثالث الثانوي', 'cd4cfa4e-b2ff-11f0-9695-0a002700000f', TRUE, 30);

-- Verify
SELECT 'SUCCESS: Groups with grade_id created!' as status;
SELECT 
    g.name as group_name,
    gr.name as grade_name,
    g.grade_id,
    g.is_active
FROM `groups` g
INNER JOIN grades gr ON g.grade_id = gr.id
WHERE g.is_active = TRUE
ORDER BY gr.display_order, g.name;
