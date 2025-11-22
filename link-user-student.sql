-- Check user and link to student
SELECT u.id as user_id, u.phone, u.name, u.student_id, u.role
FROM users u
WHERE u.phone = '01029290728';

-- Check if student exists
SELECT id, name, phone
FROM students
WHERE phone = '01029290728';

-- Update user with student_id if missing
UPDATE users 
SET student_id = (SELECT id FROM students WHERE phone = '01029290728' LIMIT 1)
WHERE phone = '01029290728' AND (student_id IS NULL OR student_id = '');

-- Verify update
SELECT u.id as user_id, u.phone, u.name, u.student_id, u.role
FROM users u
WHERE u.phone = '01029290728';
