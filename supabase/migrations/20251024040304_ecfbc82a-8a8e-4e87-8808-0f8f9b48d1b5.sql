-- Add is_offline field to students table to distinguish offline from online students
ALTER TABLE public.students 
ADD COLUMN IF NOT EXISTS is_offline BOOLEAN DEFAULT false;

-- Add password_hash field for offline students authentication
ALTER TABLE public.students 
ADD COLUMN IF NOT EXISTS password_hash TEXT;

-- Add unique constraint on email to ensure each student has unique email
ALTER TABLE public.students 
DROP CONSTRAINT IF EXISTS students_email_key;

ALTER TABLE public.students 
ADD CONSTRAINT students_email_key UNIQUE (email);

-- Create index for faster queries on is_offline
CREATE INDEX IF NOT EXISTS idx_students_is_offline ON public.students(is_offline);

-- Update RLS policies to allow offline students to view their own data
DROP POLICY IF EXISTS "Offline students can view their own data" ON public.students;
CREATE POLICY "Offline students can view their own data"
ON public.students
FOR SELECT
USING (
  is_offline = true 
  AND email = current_setting('request.jwt.claims', true)::json->>'email'
);

-- Allow offline students to update their own profile
DROP POLICY IF EXISTS "Offline students can update their own data" ON public.students;
CREATE POLICY "Offline students can update their own data"
ON public.students
FOR UPDATE
USING (
  is_offline = true 
  AND email = current_setting('request.jwt.claims', true)::json->>'email'
);