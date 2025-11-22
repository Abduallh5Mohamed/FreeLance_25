-- Fix guardian_phone columns in database
-- Execute this on server: mysql -u Freelance -p'MyPass12345@' Freelance < this_file.sql

-- Add guardian_phone to students table
ALTER TABLE students 
ADD COLUMN guardian_phone VARCHAR(50) NULL AFTER phone;

CREATE INDEX idx_students_guardian_phone 
ON students(guardian_phone);

-- Add guardian_phone to student_registration_requests table
ALTER TABLE student_registration_requests 
ADD COLUMN guardian_phone VARCHAR(50) NULL AFTER phone;

CREATE INDEX idx_registration_requests_guardian_phone 
ON student_registration_requests(guardian_phone);

-- Verify
SELECT 'Columns created successfully!' AS Status;
SHOW COLUMNS FROM students LIKE 'guardian_phone';
SHOW COLUMNS FROM student_registration_requests LIKE 'guardian_phone';
