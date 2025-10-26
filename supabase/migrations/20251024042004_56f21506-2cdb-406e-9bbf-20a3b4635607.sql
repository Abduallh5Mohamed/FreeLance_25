-- Drop the problematic policy that causes infinite recursion
DROP POLICY IF EXISTS "Admins can read all users" ON public.users;

-- Create a better policy that uses the profiles table instead
CREATE POLICY "Admins can read all users" 
ON public.users
FOR SELECT 
USING (
  EXISTS (
    SELECT 1 
    FROM public.profiles
    WHERE profiles.user_id = auth.uid() 
    AND profiles.role = 'admin'::user_role
  )
);

-- Also update the students policies that reference auth.users to avoid issues
DROP POLICY IF EXISTS "Students can update own data" ON public.students;
DROP POLICY IF EXISTS "Students can view own data" ON public.students;

-- Recreate simpler student policies
CREATE POLICY "Students can view own data" 
ON public.students
FOR SELECT 
USING (
  email = auth.email() 
  OR EXISTS (
    SELECT 1 FROM public.profiles 
    WHERE profiles.user_id = auth.uid() 
    AND profiles.role = 'admin'::user_role
  )
);

CREATE POLICY "Students can update own data" 
ON public.students
FOR UPDATE 
USING (
  email = auth.email()
  OR EXISTS (
    SELECT 1 FROM public.profiles 
    WHERE profiles.user_id = auth.uid() 
    AND profiles.role = 'admin'::user_role
  )
);