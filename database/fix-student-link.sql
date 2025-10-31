USE Freelance;

-- Update the user to link with the existing student record
UPDATE users 
SET student_id = (
    SELECT id FROM students 
    WHERE name = 'Baraa wael' 
    LIMIT 1
)
WHERE name = 'Baraa wael' AND role = 'student';

-- Check the result
SELECT 
    u.name as user_name,
    u.role,
    u.student_id,
    s.id as student_id_from_table,
    s.group_id,
    g.name as group_name
FROM users u
LEFT JOIN students s ON u.student_id = s.id
LEFT JOIN `groups` g ON s.group_id = g.id
WHERE u.role = 'student';
