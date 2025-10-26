-- Add grade_id column to course_materials table
ALTER TABLE course_materials 
ADD COLUMN IF NOT EXISTS grade_id UUID REFERENCES grades(id);

-- Create index for better performance
CREATE INDEX IF NOT EXISTS idx_course_materials_grade_id 
ON course_materials(grade_id);