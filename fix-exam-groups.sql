-- Fix exam_groups: Link exams to groups based on grade_id
-- Run: mysql -u root -p'NewSecureP@ssw0rd2025!' freelance < fix-exam-groups.sql

-- First, clear any existing invalid entries
DELETE FROM exam_groups WHERE exam_id IS NULL OR group_id IS NULL;

-- Link exams to groups that share the same grade_id
INSERT IGNORE INTO exam_groups (exam_id, group_id)
SELECT e.id, g.id
FROM exams e
INNER JOIN `groups` g ON e.grade_id = g.grade_id
WHERE e.is_active = 1 AND g.is_active = 1;

-- For exams without grade_id, link to all active groups
INSERT IGNORE INTO exam_groups (exam_id, group_id)
SELECT e.id, g.id
FROM exams e
CROSS JOIN `groups` g
WHERE e.grade_id IS NULL AND e.is_active = 1 AND g.is_active = 1;

-- Show results
SELECT 'Exam Groups Created:' as status;
SELECT eg.exam_id, e.title as exam_title, eg.group_id, g.name as group_name
FROM exam_groups eg
JOIN exams e ON e.id = eg.exam_id
JOIN `groups` g ON g.id = eg.group_id
ORDER BY e.title, g.name;
