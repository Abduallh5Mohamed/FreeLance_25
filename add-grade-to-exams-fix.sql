-- Add grade_id column to exams table
ALTER TABLE exams 
ADD COLUMN grade_id CHAR(36) NULL AFTER course_id,
ADD INDEX idx_grade_id (grade_id),
ADD CONSTRAINT fk_exams_grade FOREIGN KEY (grade_id) REFERENCES grades(id) ON DELETE SET NULL;
