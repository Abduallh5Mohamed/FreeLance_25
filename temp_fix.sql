USE Freelance;

-- Check and add guardian_phone to students
SELECT CONCAT('Checking students table for guardian_phone column...') as step;

ALTER TABLE students 
ADD COLUMN IF NOT EXISTS guardian_phone VARCHAR(50) NULL AFTER phone;

-- Backfill from parent_phone
UPDATE students 
SET guardian_phone = parent_phone 
WHERE guardian_phone IS NULL AND parent_phone IS NOT NULL;

-- Check and add guardian_phone to student_registration_requests
SELECT CONCAT('Checking student_registration_requests table...') as step;

ALTER TABLE student_registration_requests 
ADD COLUMN IF NOT EXISTS guardian_phone VARCHAR(50) NULL AFTER phone;

-- Add is_offline column
ALTER TABLE student_registration_requests 
ADD COLUMN IF NOT EXISTS is_offline BOOLEAN DEFAULT FALSE AFTER requested_courses;

-- Verify
SELECT CONCAT('âœ… Migration completed!') as status;

-- Show results
SELECT 
    COUNT(*) as total_students,
    SUM(CASE WHEN guardian_phone IS NOT NULL THEN 1 ELSE 0 END) as with_guardian,
    SUM(CASE WHEN guardian_phone IS NULL THEN 1 ELSE 0 END) as without_guardian
FROM students;

SELECT 
    name,
    phone,
    guardian_phone,
    is_offline
FROM students 
ORDER BY created_at DESC 
LIMIT 5;
