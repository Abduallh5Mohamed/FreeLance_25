USE Freelance;

SELECT 'Current Groups in Database:' as info;
SELECT 
    id,
    name,
    grade_id,
    is_active
FROM `groups`
WHERE is_active = TRUE;

SELECT 'Grades:' as info;
SELECT id, name FROM grades WHERE is_active = TRUE;

SELECT 'Groups with Grade Names:' as info;
SELECT 
    g.id as group_id,
    g.name as group_name,
    g.grade_id,
    gr.name as grade_name
FROM `groups` g
LEFT JOIN grades gr ON g.grade_id = gr.id
WHERE g.is_active = TRUE;
