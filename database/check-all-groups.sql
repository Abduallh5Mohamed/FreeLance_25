USE Freelance;

SELECT 
    'All Groups in Database:' as info;

SELECT 
    id,
    name,
    grade_id,
    is_active,
    created_at
FROM `groups`
ORDER BY created_at DESC;

SELECT 
    'Groups with Grade Info:' as info;

SELECT 
    g.id,
    g.name as group_name,
    g.grade_id,
    gr.name as grade_name,
    g.is_active
FROM `groups` g
LEFT JOIN grades gr ON g.grade_id = gr.id
ORDER BY g.created_at DESC;
