-- Add guardian_phone columns
ALTER TABLE students ADD COLUMN IF NOT EXISTS guardian_phone VARCHAR(50) NULL AFTER phone;
ALTER TABLE student_registration_requests ADD COLUMN IF NOT EXISTS guardian_phone VARCHAR(50) NULL AFTER phone;

-- Add indexes
CREATE INDEX IF NOT EXISTS idx_students_guardian_phone ON students(guardian_phone);
CREATE INDEX IF NOT EXISTS idx_registration_requests_guardian_phone ON student_registration_requests(guardian_phone);

-- Show status
SELECT 'Migration completed successfully!' AS status;
SHOW COLUMNS FROM students LIKE 'guardian_phone';
SHOW COLUMNS FROM student_registration_requests LIKE 'guardian_phone';