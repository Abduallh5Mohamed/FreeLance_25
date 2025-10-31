USE Freelance;

-- Check student's group assignment
SELECT 
    u.name as user_name,
    u.role,
    s.id as student_id,
    s.group_id,
    g.name as group_name
FROM users u
LEFT JOIN students s ON u.student_id = s.id
LEFT JOIN `groups` g ON s.group_id = g.id
WHERE u.role = 'student';

-- Check lectures and their group assignments
SELECT 
    l.id,
    l.title,
    l.group_id,
    g.name as group_name,
    l.is_published
FROM lectures l
LEFT JOIN `groups` g ON l.group_id = g.id
ORDER BY l.created_at DESC
LIMIT 5;

-- Check materials and their group assignments  
SELECT 
    cm.id,
    cm.title,
    mg.group_id,
    g.name as group_name,
    cm.is_published
FROM course_materials cm
LEFT JOIN material_groups mg ON cm.id = mg.material_id
LEFT JOIN `groups` g ON mg.group_id = g.id
ORDER BY cm.created_at DESC
LIMIT 5;
