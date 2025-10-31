USE Freelance;

-- Check users table
SELECT 
    COLUMN_NAME,
    DATA_TYPE
FROM INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_SCHEMA = 'Freelance' 
    AND TABLE_NAME = 'users'
    AND COLUMN_NAME IN ('id', 'student_id');

-- Check if user with role='student' has student_id
SELECT 
    id,
    name,
    role,
    student_id
FROM users
WHERE role = 'student'
LIMIT 5;
