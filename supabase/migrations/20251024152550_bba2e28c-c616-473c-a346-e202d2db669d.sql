-- Add approval fields to students table
ALTER TABLE public.students 
ADD COLUMN IF NOT EXISTS approval_status text DEFAULT 'pending' CHECK (approval_status IN ('pending', 'approved', 'rejected')),
ADD COLUMN IF NOT EXISTS approved_by uuid REFERENCES auth.users(id),
ADD COLUMN IF NOT EXISTS approved_at timestamp with time zone;

-- Create index for faster approval queries
CREATE INDEX IF NOT EXISTS idx_students_approval_status ON public.students(approval_status);

-- Create a table for student registration requests (pending approvals)
CREATE TABLE IF NOT EXISTS public.student_registration_requests (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  name text NOT NULL,
  email text NOT NULL UNIQUE,
  phone text NOT NULL,
  grade_id uuid REFERENCES public.grades(id),
  group_id uuid REFERENCES public.groups(id),
  password_hash text NOT NULL,
  requested_courses uuid[] DEFAULT '{}',
  status text DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  reviewed_by uuid REFERENCES auth.users(id),
  reviewed_at timestamp with time zone,
  rejection_reason text,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now()
);

-- Enable RLS on student_registration_requests
ALTER TABLE public.student_registration_requests ENABLE ROW LEVEL SECURITY;

-- RLS Policies for student_registration_requests
CREATE POLICY "Admins can manage registration requests"
ON public.student_registration_requests
FOR ALL
USING (
  EXISTS (
    SELECT 1 FROM profiles
    WHERE profiles.user_id = auth.uid() AND profiles.role = 'admin'
  )
);

CREATE POLICY "Anyone can create registration requests"
ON public.student_registration_requests
FOR INSERT
WITH CHECK (true);

-- Create function to auto-update updated_at
CREATE OR REPLACE FUNCTION update_student_registration_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_student_registration_requests_updated_at
BEFORE UPDATE ON public.student_registration_requests
FOR EACH ROW
EXECUTE FUNCTION update_student_registration_updated_at();