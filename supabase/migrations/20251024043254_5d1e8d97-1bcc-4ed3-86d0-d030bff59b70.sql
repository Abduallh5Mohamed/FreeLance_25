-- إضافة عمود نوع المجموعة (أوفلاين/أونلاين)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'group_type') THEN
    CREATE TYPE group_type AS ENUM ('offline', 'online');
  END IF;
END $$;

ALTER TABLE public.groups
ADD COLUMN IF NOT EXISTS type group_type DEFAULT 'offline';

-- حذف عمود الكورس من المجموعات (لأن المجموعة ستحتوي على عدة كورسات)
ALTER TABLE public.groups
DROP COLUMN IF EXISTS course_id;

-- حذف عمودي المواعيد من المجموعات (ستكون المواعيد لكل كورس على حدة)
ALTER TABLE public.groups
DROP COLUMN IF EXISTS schedule_days,
DROP COLUMN IF EXISTS schedule_times;

-- إنشاء جدول لربط المجموعات بالكورسات مع المواعيد
CREATE TABLE IF NOT EXISTS public.group_courses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id UUID NOT NULL REFERENCES public.groups(id) ON DELETE CASCADE,
  course_id UUID NOT NULL REFERENCES public.courses(id) ON DELETE CASCADE,
  schedule_days TEXT[] NOT NULL DEFAULT '{}',
  schedule_times JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  UNIQUE(group_id, course_id)
);

-- تفعيل RLS على الجدول الجديد
ALTER TABLE public.group_courses ENABLE ROW LEVEL SECURITY;

-- سياسات RLS للجدول الجديد
CREATE POLICY "Admins can manage group courses"
ON public.group_courses
FOR ALL
USING (
  EXISTS (
    SELECT 1 FROM public.profiles
    WHERE profiles.user_id = auth.uid() 
    AND profiles.role = 'admin'::user_role
  )
);

CREATE POLICY "Anyone can view group courses"
ON public.group_courses
FOR SELECT
USING (true);

-- تحديث trigger للـ updated_at
CREATE TRIGGER update_group_courses_updated_at
BEFORE UPDATE ON public.group_courses
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();

-- إنشاء index لتحسين الأداء
CREATE INDEX IF NOT EXISTS idx_group_courses_group_id ON public.group_courses(group_id);
CREATE INDEX IF NOT EXISTS idx_group_courses_course_id ON public.group_courses(course_id);