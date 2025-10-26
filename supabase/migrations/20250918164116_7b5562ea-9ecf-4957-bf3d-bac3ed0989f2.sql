-- First, let's ensure the students table allows anonymous inserts for registration
DROP POLICY IF EXISTS "Students can create their own accounts" ON public.students;
DROP POLICY IF EXISTS "Anonymous users can create student accounts" ON public.students;
DROP POLICY IF EXISTS "Admins can manage all students" ON public.students;

-- Create a simple policy to allow anyone to insert new students (for registration)
CREATE POLICY "Allow student registration" 
ON public.students 
FOR INSERT 
WITH CHECK (true);

-- Allow students to view their own data
CREATE POLICY "Students can view own data" 
ON public.students 
FOR SELECT 
USING (true);

-- Allow students to update their own data  
CREATE POLICY "Students can update own data"
ON public.students 
FOR UPDATE 
USING (true);

-- Allow admins full access
CREATE POLICY "Admin full access to students" 
ON public.students 
FOR ALL 
USING (EXISTS (
  SELECT 1 FROM profiles 
  WHERE user_id = auth.uid() AND role = 'admin'
));

-- Ensure student_courses table exists and has proper policies
CREATE TABLE IF NOT EXISTS public.student_courses (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  student_id uuid NOT NULL REFERENCES public.students(id) ON DELETE CASCADE,
  course_id uuid NOT NULL REFERENCES public.courses(id) ON DELETE CASCADE,
  enrolled_at timestamp with time zone DEFAULT now(),
  UNIQUE(student_id, course_id)
);

ALTER TABLE public.student_courses ENABLE ROW LEVEL SECURITY;

-- Allow anyone to insert course enrollments (for registration)
DROP POLICY IF EXISTS "Allow course enrollment" ON public.student_courses;
CREATE POLICY "Allow course enrollment" 
ON public.student_courses 
FOR INSERT 
WITH CHECK (true);

-- Allow viewing course enrollments
DROP POLICY IF EXISTS "Allow viewing course enrollments" ON public.student_courses;
CREATE POLICY "Allow viewing course enrollments" 
ON public.student_courses 
FOR SELECT 
USING (true);