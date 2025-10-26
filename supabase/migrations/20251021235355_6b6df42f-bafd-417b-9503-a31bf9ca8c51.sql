-- Create update_updated_at_column function if not exists
CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create grades table
CREATE TABLE public.grades (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.grades ENABLE ROW LEVEL SECURITY;

-- Create policies
CREATE POLICY "Anyone can view active grades"
ON public.grades
FOR SELECT
USING (is_active = true);

CREATE POLICY "Admins can manage grades"
ON public.grades
FOR ALL
USING (
  EXISTS (
    SELECT 1 FROM profiles
    WHERE profiles.user_id = auth.uid()
    AND profiles.role = 'admin'
  )
);

-- Add grade_id to groups table
ALTER TABLE public.groups
ADD COLUMN grade_id UUID REFERENCES public.grades(id);

-- Add grade_id to students table
ALTER TABLE public.students
ADD COLUMN grade_id UUID REFERENCES public.grades(id);

-- Create trigger for updated_at
CREATE TRIGGER update_grades_updated_at
BEFORE UPDATE ON public.grades
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();