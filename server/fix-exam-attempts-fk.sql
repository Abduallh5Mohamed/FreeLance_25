-- Fix exam_attempts foreign key to reference users instead of students

-- Drop the old foreign key constraint
ALTER TABLE exam_attempts DROP FOREIGN KEY exam_attempts_ibfk_2;

-- Add new foreign key referencing users table
ALTER TABLE exam_attempts 
ADD CONSTRAINT exam_attempts_ibfk_2 
FOREIGN KEY (student_id) REFERENCES users(id) ON DELETE CASCADE;
