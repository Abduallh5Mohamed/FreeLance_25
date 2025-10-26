-- Enable RLS on students table if not already enabled
ALTER TABLE public.students ENABLE ROW LEVEL SECURITY;

-- Allow students to create their own accounts (sign up)
CREATE POLICY "Students can create their own accounts" 
ON public.students 
FOR INSERT 
WITH CHECK (true);

-- Allow students to view their own data
CREATE POLICY "Students can view their own data" 
ON public.students 
FOR SELECT 
TO authenticated
USING (auth.uid()::text = id::text OR email IN (
  SELECT email FROM profiles WHERE user_id = auth.uid()
));

-- Allow unauthenticated users to create student accounts (for signup)
CREATE POLICY "Anonymous users can create student accounts" 
ON public.students 
FOR INSERT 
TO anon 
WITH CHECK (true);

-- Allow students to update their own data
CREATE POLICY "Students can update their own data" 
ON public.students 
FOR UPDATE 
TO authenticated
USING (auth.uid()::text = id::text OR email IN (
  SELECT email FROM profiles WHERE user_id = auth.uid()
));

-- Allow admins to manage all students
CREATE POLICY "Admins can manage all students" 
ON public.students 
FOR ALL 
TO authenticated
USING (EXISTS (
  SELECT 1 FROM profiles 
  WHERE user_id = auth.uid() AND role = 'admin'
));

-- Create student_courses table if it doesn't exist for course enrollments
CREATE TABLE IF NOT EXISTS public.student_courses (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  student_id uuid NOT NULL REFERENCES public.students(id) ON DELETE CASCADE,
  course_id uuid NOT NULL REFERENCES public.courses(id) ON DELETE CASCADE,
  enrolled_at timestamp with time zone DEFAULT now(),
  UNIQUE(student_id, course_id)
);

-- Enable RLS on student_courses
ALTER TABLE public.student_courses ENABLE ROW LEVEL SECURITY;

-- Allow students to view their own course enrollments
CREATE POLICY "Students can view their own courses" 
ON public.student_courses 
FOR SELECT 
TO authenticated
USING (student_id IN (
  SELECT id FROM students WHERE email IN (
    SELECT email FROM profiles WHERE user_id = auth.uid()
  )
));

-- Allow anonymous users to create course enrollments during signup
CREATE POLICY "Anonymous users can create course enrollments" 
ON public.student_courses 
FOR INSERT 
TO anon 
WITH CHECK (true);

-- Allow admins to manage all course enrollments
CREATE POLICY "Admins can manage course enrollments" 
ON public.student_courses 
FOR ALL 
TO authenticated
USING (EXISTS (
  SELECT 1 FROM profiles 
  WHERE user_id = auth.uid() AND role = 'admin'
));