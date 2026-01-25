-- Add missing columns to student_registration_requests table
ALTER TABLE student_registration_requests 
ADD COLUMN IF NOT EXISTS guardian_phone VARCHAR(50) NULL,
ADD COLUMN IF NOT EXISTS is_offline BOOLEAN DEFAULT FALSE;
