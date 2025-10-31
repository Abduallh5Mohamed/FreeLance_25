USE Freelance;

-- Check teachers table structure
DESCRIBE teachers;

-- Check current teachers
SELECT 
    id,
    name,
    subject,
    phone,
    is_active
FROM teachers 
LIMIT 5;

-- Check if teachers have group assignments
SELECT 
    COLUMN_NAME,
    DATA_TYPE
FROM INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_SCHEMA = 'Freelance' 
    AND TABLE_NAME = 'teachers'
    AND COLUMN_NAME LIKE '%group%';
