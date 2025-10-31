USE Freelance;

-- Check if users with role='teacher' exist
SELECT 
    id,
    name,
    role,
    is_active
FROM users
WHERE role = 'teacher'
LIMIT 5;

-- Check if there's a teachers table
SHOW TABLES LIKE 'teachers';
