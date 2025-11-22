-- Add guardian_phone column to students and student_registration_requests tables

-- Add guardian_phone to students table
ALTER TABLE students 
ADD COLUMN IF NOT EXISTS guardian_phone VARCHAR(50) NULL AFTER phone;

-- Add index for faster searches
CREATE INDEX IF NOT EXISTS idx_students_guardian_phone 
ON students(guardian_phone);

-- Add guardian_phone to student_registration_requests table  
ALTER TABLE student_registration_requests 
ADD COLUMN IF NOT EXISTS guardian_phone VARCHAR(50) NULL AFTER phone;

-- Add index for faster searches
CREATE INDEX IF NOT EXISTS idx_registration_requests_guardian_phone 
ON student_registration_requests(guardian_phone);

-- Show status
SELECT 'Migration completed: guardian_phone columns added' AS status;
