-- Fix RLS policies for students table to allow self-registration
DROP POLICY IF EXISTS "Teachers can manage students" ON students;

-- Allow anyone to insert students (for self-registration)
CREATE POLICY "Anyone can create student accounts" 
ON students 
FOR INSERT 
WITH CHECK (true);

-- Allow students to view their own profile
CREATE POLICY "Students can view their own profile" 
ON students 
FOR SELECT 
USING (email = (SELECT auth.email() FROM auth.users WHERE auth.uid() = auth.uid()) OR 
       (EXISTS (SELECT 1 FROM profiles WHERE profiles.user_id = auth.uid() AND profiles.role = 'admin'::user_role)));

-- Allow students to update their own profile
CREATE POLICY "Students can update their own profile" 
ON students 
FOR UPDATE 
USING (email = (SELECT auth.email() FROM auth.users WHERE auth.uid() = auth.uid()) OR 
       (EXISTS (SELECT 1 FROM profiles WHERE profiles.user_id = auth.uid() AND profiles.role = 'admin'::user_role)));

-- Allow teachers/admins to manage students
CREATE POLICY "Admins can manage all students" 
ON students 
FOR ALL 
USING (EXISTS (SELECT 1 FROM profiles WHERE profiles.user_id = auth.uid() AND profiles.role = 'admin'::user_role));