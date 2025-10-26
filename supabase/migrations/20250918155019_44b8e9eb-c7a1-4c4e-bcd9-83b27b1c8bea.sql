-- Remove geography course and keep only history
DELETE FROM courses WHERE name = 'جغرافيا مصر' OR name LIKE '%جغرافيا%';

-- Update the history course to ensure it exists
INSERT INTO courses (name, description, subject, is_active) 
VALUES ('التاريخ الإسلامي', 'دراسة شاملة للتاريخ الإسلامي من العصر القديم إلى العصر الحديث', 'history', true)
ON CONFLICT (name) DO UPDATE SET 
  description = EXCLUDED.description,
  subject = EXCLUDED.subject,
  is_active = true;

-- Create groups table
CREATE TABLE IF NOT EXISTS public.groups (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  schedule_days TEXT[] NOT NULL DEFAULT '{}', -- Array of days like ['sunday', 'tuesday']
  schedule_times JSONB NOT NULL DEFAULT '{}', -- JSON with time ranges
  max_students INTEGER DEFAULT 50,
  current_students INTEGER DEFAULT 0,
  is_active BOOLEAN DEFAULT true,
  course_id UUID REFERENCES public.courses(id),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- Enable RLS on groups table
ALTER TABLE public.groups ENABLE ROW LEVEL SECURITY;

-- Create policies for groups
CREATE POLICY "Anyone can view active groups" 
ON public.groups 
FOR SELECT 
USING (is_active = true);

CREATE POLICY "Admins can manage groups" 
ON public.groups 
FOR ALL 
USING (EXISTS (
  SELECT 1 FROM profiles 
  WHERE profiles.user_id = auth.uid() 
  AND profiles.role = 'admin'::user_role
));

-- Add group_id to students table
ALTER TABLE public.students ADD COLUMN IF NOT EXISTS group_id UUID REFERENCES public.groups(id);
ALTER TABLE public.students ADD COLUMN IF NOT EXISTS study_type TEXT DEFAULT 'online'; -- online or offline
ALTER TABLE public.students ADD COLUMN IF NOT EXISTS registration_form_url TEXT;

-- Add group_id to exams table
ALTER TABLE public.exams ADD COLUMN IF NOT EXISTS group_id UUID REFERENCES public.groups(id);

-- Insert default history group
INSERT INTO public.groups (name, description, schedule_days, schedule_times, course_id)
SELECT 
  'مجموعة التاريخ الأساسية',
  'المجموعة الأساسية لدراسة التاريخ الإسلامي',
  ARRAY['sunday', 'tuesday', 'thursday'],
  '{"sunday": "10:00-12:00", "tuesday": "14:00-16:00", "thursday": "18:00-20:00"}'::jsonb,
  c.id
FROM courses c 
WHERE c.name = 'التاريخ الإسلامي'
LIMIT 1;

-- Create attendance QR codes table
CREATE TABLE IF NOT EXISTS public.attendance_qr_codes (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  group_id UUID NOT NULL REFERENCES public.groups(id),
  session_date DATE NOT NULL DEFAULT CURRENT_DATE,
  expires_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT (now() + interval '24 hours'),
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- Enable RLS on attendance QR codes
ALTER TABLE public.attendance_qr_codes ENABLE ROW LEVEL SECURITY;

-- Create policies for QR codes
CREATE POLICY "Admins can manage QR codes" 
ON public.attendance_qr_codes 
FOR ALL 
USING (EXISTS (
  SELECT 1 FROM profiles 
  WHERE profiles.user_id = auth.uid() 
  AND profiles.role = 'admin'::user_role
));

CREATE POLICY "Students can view active QR codes" 
ON public.attendance_qr_codes 
FOR SELECT 
USING (is_active = true AND expires_at > now());