-- Link all users to their corresponding students by phone number
UPDATE users u
JOIN students s ON s.phone = u.phone
SET u.student_id = s.id
WHERE u.role = 'student' 
  AND u.student_id IS NULL
  AND s.phone IS NOT NULL;

-- Show results
SELECT 
    u.id as user_id,
    u.name as user_name,
    u.phone,
    u.student_id,
    s.name as student_name
FROM users u
LEFT JOIN students s ON s.id = u.student_id
WHERE u.role = 'student';
