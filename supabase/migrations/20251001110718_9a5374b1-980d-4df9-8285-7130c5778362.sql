-- Add group_id and password to students table
ALTER TABLE public.students 
ADD COLUMN IF NOT EXISTS group_id uuid REFERENCES public.groups(id) ON DELETE SET NULL,
ADD COLUMN IF NOT EXISTS password text;

-- Create material_groups junction table to link materials with groups
CREATE TABLE IF NOT EXISTS public.material_groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  material_id uuid NOT NULL REFERENCES public.course_materials(id) ON DELETE CASCADE,
  group_id uuid NOT NULL REFERENCES public.groups(id) ON DELETE CASCADE,
  created_at timestamptz DEFAULT now(),
  UNIQUE(material_id, group_id)
);

-- Enable RLS on material_groups
ALTER TABLE public.material_groups ENABLE ROW LEVEL SECURITY;

-- RLS policy for admins to manage material_groups
CREATE POLICY "Admins can manage material groups"
ON public.material_groups
FOR ALL
USING (
  EXISTS (
    SELECT 1 FROM profiles
    WHERE profiles.user_id = auth.uid()
    AND profiles.role = 'admin'
  )
);

-- RLS policy for students to view their group materials
CREATE POLICY "Students can view their group materials"
ON public.material_groups
FOR SELECT
USING (
  group_id IN (
    SELECT students.group_id
    FROM students
    WHERE students.email = (
      SELECT profiles.email FROM profiles WHERE profiles.user_id = auth.uid()
    )
  )
);

-- Add index for better performance
CREATE INDEX IF NOT EXISTS idx_students_group_id ON public.students(group_id);
CREATE INDEX IF NOT EXISTS idx_material_groups_material_id ON public.material_groups(material_id);
CREATE INDEX IF NOT EXISTS idx_material_groups_group_id ON public.material_groups(group_id);