-- Create online_meetings table
CREATE TABLE IF NOT EXISTS public.online_meetings (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  group_id UUID NOT NULL REFERENCES public.groups(id) ON DELETE CASCADE,
  meeting_link TEXT NOT NULL,
  meeting_type TEXT NOT NULL CHECK (meeting_type IN ('google_meet', 'zoom')),
  created_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  is_active BOOLEAN DEFAULT true
);

-- Enable RLS
ALTER TABLE public.online_meetings ENABLE ROW LEVEL SECURITY;

-- Create policies
CREATE POLICY "Admins can manage online meetings"
ON public.online_meetings
FOR ALL
USING (
  EXISTS (
    SELECT 1 FROM profiles
    WHERE profiles.user_id = auth.uid()
    AND profiles.role = 'admin'
  )
);

CREATE POLICY "Students can view meetings for their group"
ON public.online_meetings
FOR SELECT
USING (
  is_active = true
  AND group_id IN (
    SELECT students.group_id
    FROM students
    WHERE students.email = (
      SELECT profiles.email
      FROM profiles
      WHERE profiles.user_id = auth.uid()
    )
  )
);

-- Create updated_at trigger
CREATE TRIGGER update_online_meetings_updated_at
BEFORE UPDATE ON public.online_meetings
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();