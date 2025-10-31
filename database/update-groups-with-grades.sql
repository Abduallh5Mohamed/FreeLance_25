-- Update groups table to link with grades
-- This script adds grade_id to existing groups

USE Freelance;

-- Note: Run these commands one by one if there are errors
-- The column and FK might already exist from previous migrations

-- Update existing groups to link with grades
-- Match groups with grades by name

UPDATE `groups` g
INNER JOIN grades gr ON g.name LIKE CONCAT('%', gr.name, '%')
SET g.grade_id = gr.id
WHERE g.grade_id IS NULL;

-- Insert sample groups for each grade if they don't exist
-- Get grade IDs first
SET @grade1_id = (SELECT id FROM grades WHERE name = 'الصف الأول الثانوي' LIMIT 1);
SET @grade2_id = (SELECT id FROM grades WHERE name = 'الصف الثاني الثانوي' LIMIT 1);
SET @grade3_id = (SELECT id FROM grades WHERE name = 'الصف الثالث الثانوي' LIMIT 1);

-- Insert groups for Grade 1 if they don't exist
INSERT INTO `groups` (name, description, grade_id, is_active)
SELECT 'مجموعة أ - الصف الأول', 'المجموعة الأولى للصف الأول الثانوي', @grade1_id, TRUE
WHERE NOT EXISTS (SELECT 1 FROM `groups` WHERE name = 'مجموعة أ - الصف الأول');

INSERT INTO `groups` (name, description, grade_id, is_active)
SELECT 'مجموعة ب - الصف الأول', 'المجموعة الثانية للصف الأول الثانوي', @grade1_id, TRUE
WHERE NOT EXISTS (SELECT 1 FROM `groups` WHERE name = 'مجموعة ب - الصف الأول');

-- Insert groups for Grade 2 if they don't exist
INSERT INTO `groups` (name, description, grade_id, is_active)
SELECT 'مجموعة أ - الصف الثاني', 'المجموعة الأولى للصف الثاني الثانوي', @grade2_id, TRUE
WHERE NOT EXISTS (SELECT 1 FROM `groups` WHERE name = 'مجموعة أ - الصف الثاني');

INSERT INTO `groups` (name, description, grade_id, is_active)
SELECT 'مجموعة ب - الصف الثاني', 'المجموعة الثانية للصف الثاني الثانوي', @grade2_id, TRUE
WHERE NOT EXISTS (SELECT 1 FROM `groups` WHERE name = 'مجموعة ب - الصف الثاني');

-- Insert groups for Grade 3 if they don't exist
INSERT INTO `groups` (name, description, grade_id, is_active)
SELECT 'مجموعة أ - الصف الثالث', 'المجموعة الأولى للصف الثالث الثانوي', @grade3_id, TRUE
WHERE NOT EXISTS (SELECT 1 FROM `groups` WHERE name = 'مجموعة أ - الصف الثالث');

INSERT INTO `groups` (name, description, grade_id, is_active)
SELECT 'مجموعة ب - الصف الثالث', 'المجموعة الثانية للصف الثالث الثانوي', @grade3_id, TRUE
WHERE NOT EXISTS (SELECT 1 FROM `groups` WHERE name = 'مجموعة ب - الصف الثالث');

-- Verify the update
SELECT 
    g.name AS group_name,
    gr.name AS grade_name,
    g.is_active
FROM `groups` g
LEFT JOIN grades gr ON g.grade_id = gr.id
ORDER BY gr.display_order, g.name;
