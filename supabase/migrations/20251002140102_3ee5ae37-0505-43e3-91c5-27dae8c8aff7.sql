-- Add exam_groups junction table for many-to-many relationship
CREATE TABLE IF NOT EXISTS public.exam_groups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  exam_id UUID NOT NULL REFERENCES public.exams(id) ON DELETE CASCADE,
  group_id UUID NOT NULL REFERENCES public.groups(id) ON DELETE CASCADE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  UNIQUE(exam_id, group_id)
);

-- Add indexes for performance
CREATE INDEX IF NOT EXISTS idx_exam_groups_exam_id ON public.exam_groups(exam_id);
CREATE INDEX IF NOT EXISTS idx_exam_groups_group_id ON public.exam_groups(group_id);

-- Enable RLS
ALTER TABLE public.exam_groups ENABLE ROW LEVEL SECURITY;

-- RLS Policies for exam_groups
CREATE POLICY "Admins can manage exam groups"
ON public.exam_groups
FOR ALL
TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.profiles
    WHERE profiles.user_id = auth.uid()
    AND profiles.role = 'admin'
  )
)
WITH CHECK (
  EXISTS (
    SELECT 1 FROM public.profiles
    WHERE profiles.user_id = auth.uid()
    AND profiles.role = 'admin'
  )
);

CREATE POLICY "Students can view their group exams"
ON public.exam_groups
FOR SELECT
TO authenticated
USING (
  group_id IN (
    SELECT students.group_id
    FROM public.students
    WHERE students.email = (
      SELECT profiles.email
      FROM public.profiles
      WHERE profiles.user_id = auth.uid()
    )
  )
);

-- Add exam_code and exam_time columns to exams table
ALTER TABLE public.exams ADD COLUMN IF NOT EXISTS exam_code TEXT;
ALTER TABLE public.exams ADD COLUMN IF NOT EXISTS exam_time TIME;

-- Add index on exam_code for quick lookups
CREATE INDEX IF NOT EXISTS idx_exams_exam_code ON public.exams(exam_code);