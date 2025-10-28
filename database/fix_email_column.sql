-- Fix email column in student_registration_requests table
USE Freelance;

-- Make email column nullable (or remove it completely)
ALTER TABLE student_registration_requests MODIFY COLUMN email VARCHAR(255) NULL;

-- Verify the change
DESCRIBE student_registration_requests;
