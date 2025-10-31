USE Freelance;

-- Check students table structure
DESCRIBE students;

-- Check student_groups table
SHOW TABLES LIKE 'student_groups';

-- Check if there's a group_id in students
SELECT 
    COLUMN_NAME, 
    DATA_TYPE,
    IS_NULLABLE,
    COLUMN_KEY
FROM INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_SCHEMA = 'Freelance'
    AND TABLE_NAME = 'students'
    AND COLUMN_NAME LIKE '%group%';
