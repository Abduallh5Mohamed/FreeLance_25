-- Create staff table for employee management
CREATE TABLE IF NOT EXISTS public.staff (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  phone TEXT,
  password TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'staff',
  accessible_pages JSONB DEFAULT '[]'::jsonb,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.staff ENABLE ROW LEVEL SECURITY;

-- RLS policies for staff
CREATE POLICY "Admins can manage staff"
ON public.staff
FOR ALL
TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM profiles
    WHERE profiles.user_id = auth.uid()
    AND profiles.role = 'admin'
  )
);

-- Create account_statement table for subscription fees collection
CREATE TABLE IF NOT EXISTS public.account_statement (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id UUID REFERENCES public.students(id) ON DELETE CASCADE,
  amount NUMERIC NOT NULL,
  payment_date DATE NOT NULL,
  description TEXT,
  subscription_id UUID REFERENCES public.subscriptions(id),
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.account_statement ENABLE ROW LEVEL SECURITY;

-- RLS policies
CREATE POLICY "Admins can manage account statements"
ON public.account_statement
FOR ALL
TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM profiles
    WHERE profiles.user_id = auth.uid()
    AND profiles.role = 'admin'
  )
);

-- Add total_questions and total_points to exams table
ALTER TABLE public.exams 
ADD COLUMN IF NOT EXISTS total_questions INTEGER DEFAULT 10,
ADD COLUMN IF NOT EXISTS questions_count INTEGER DEFAULT 0;

-- Create function to update questions count
CREATE OR REPLACE FUNCTION update_exam_questions_count()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE public.exams 
    SET questions_count = questions_count + 1 
    WHERE id = NEW.exam_id;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE public.exams 
    SET questions_count = GREATEST(0, questions_count - 1)
    WHERE id = OLD.exam_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create trigger for questions count
DROP TRIGGER IF EXISTS update_questions_count_trigger ON public.exam_questions;
CREATE TRIGGER update_questions_count_trigger
AFTER INSERT OR DELETE ON public.exam_questions
FOR EACH ROW
EXECUTE FUNCTION update_exam_questions_count();

-- Add email uniqueness constraint (remove if exists and recreate)
DROP INDEX IF EXISTS students_email_unique;
CREATE UNIQUE INDEX students_email_unique ON public.students(email) WHERE email IS NOT NULL AND email != '';