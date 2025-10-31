USE Freelance;

SELECT 'GRADES TABLE:' as info;
SELECT id, name, is_active FROM grades WHERE is_active = TRUE;

SELECT 'GROUPS TABLE:' as info;
SELECT id, name, grade_id, is_active FROM `groups`;

SELECT 'GROUPS WITH GRADE NAMES:' as info;
SELECT 
    g.id,
    g.name as group_name,
    g.grade_id,
    gr.name as grade_name,
    g.is_active
FROM `groups` g
LEFT JOIN grades gr ON g.grade_id = gr.id;
