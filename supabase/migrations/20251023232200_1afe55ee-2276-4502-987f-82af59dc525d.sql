-- Add grade_id column to courses table
ALTER TABLE public.courses 
ADD COLUMN grade_id uuid REFERENCES public.grades(id);

-- Add index for better performance
CREATE INDEX idx_courses_grade_id ON public.courses(grade_id);