USE Freelance;
SELECT 'Grades:' as info;
SELECT id, name, display_order FROM grades;
SELECT 'Groups:' as info;
SELECT id, name, grade_id FROM `groups`;
