-- Update students table - remove created_by column if it exists and add necessary columns
ALTER TABLE students 
DROP COLUMN IF EXISTS created_by,
ADD COLUMN IF NOT EXISTS password_hash TEXT DEFAULT '',
ADD COLUMN IF NOT EXISTS temporary_password TEXT;

-- Update course_materials table to support file uploads
ALTER TABLE course_materials 
ADD COLUMN IF NOT EXISTS file_url TEXT,
ADD COLUMN IF NOT EXISTS file_name TEXT;

-- Create exam_student_answers table for storing student answers
CREATE TABLE IF NOT EXISTS exam_student_answers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  exam_id UUID NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
  student_id UUID NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  question_id UUID NOT NULL REFERENCES exam_questions(id) ON DELETE CASCADE,
  student_answer TEXT NOT NULL,
  is_correct BOOLEAN DEFAULT FALSE,
  submitted_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  UNIQUE(exam_id, student_id, question_id)
);

-- Enable RLS on exam_student_answers
ALTER TABLE exam_student_answers ENABLE ROW LEVEL SECURITY;

-- Create policies for exam_student_answers
CREATE POLICY "Students can manage their own answers"
ON exam_student_answers
FOR ALL
USING (student_id IN (
  SELECT id FROM students WHERE email = (
    SELECT email FROM profiles WHERE user_id = auth.uid()
  )
));

CREATE POLICY "Admins can view all student answers"
ON exam_student_answers
FOR SELECT
USING (EXISTS (
  SELECT 1 FROM profiles 
  WHERE user_id = auth.uid() AND role = 'admin'
));

-- Create storage policy for course materials if not exists
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies 
    WHERE schemaname = 'storage' 
    AND tablename = 'objects' 
    AND policyname = 'Admins can manage course materials'
  ) THEN
    CREATE POLICY "Admins can manage course materials"
    ON storage.objects
    FOR ALL
    USING (bucket_id = 'course-materials' AND auth.uid() IN (
      SELECT user_id FROM profiles WHERE role = 'admin'
    ));
  END IF;
END $$;

DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies 
    WHERE schemaname = 'storage' 
    AND tablename = 'objects' 
    AND policyname = 'Students can view course materials'
  ) THEN
    CREATE POLICY "Students can view course materials"
    ON storage.objects
    FOR SELECT
    USING (bucket_id = 'course-materials');
  END IF;
END $$;