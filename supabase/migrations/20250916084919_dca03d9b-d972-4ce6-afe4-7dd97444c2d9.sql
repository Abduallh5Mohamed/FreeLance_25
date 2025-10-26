-- إنشاء نظام محدث للمستخدمين والطلاب

-- حذف النظام القديم إن وُجد
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
DROP FUNCTION IF EXISTS public.handle_new_user();

-- إنشاء تابع محدث لإنشاء الملفات الشخصية تلقائياً
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  -- إنشاء ملف شخصي للمستخدم الجديد
  INSERT INTO public.profiles (
    user_id,
    name,
    username,
    code,
    role,
    email
  ) VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data->>'name', SPLIT_PART(NEW.email, '@', 1)),
    CASE 
      WHEN NEW.email = 'mohamed96ramadan1996@gmail.com' THEN 'admin'
      ELSE SPLIT_PART(NEW.email, '@', 1)
    END,
    CASE 
      WHEN NEW.email = 'mohamed96ramadan1996@gmail.com' THEN 'ADMIN001'
      ELSE 'USER' || EXTRACT(EPOCH FROM NOW())::TEXT
    END,
    CASE 
      WHEN NEW.email = 'mohamed96ramadan1996@gmail.com' THEN 'admin'::user_role
      ELSE 'student'::user_role
    END,
    NEW.email
  );
  
  RETURN NEW;
END;
$$;

-- إنشاء المشغل
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- إضافة حقول جديدة لجدول الطلاب
ALTER TABLE students ADD COLUMN IF NOT EXISTS password_hash TEXT;
ALTER TABLE students ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES profiles(user_id);
ALTER TABLE students ADD COLUMN IF NOT EXISTS schedule_time TEXT;
ALTER TABLE students ADD COLUMN IF NOT EXISTS session_days TEXT[];

-- إضافة حقول جديدة لجدول الكورسات
ALTER TABLE courses ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES profiles(user_id);
ALTER TABLE courses ADD COLUMN IF NOT EXISTS schedule_time TEXT;
ALTER TABLE courses ADD COLUMN IF NOT EXISTS session_days TEXT[];
ALTER TABLE courses ADD COLUMN IF NOT EXISTS duration_weeks INTEGER DEFAULT 12;
ALTER TABLE courses ADD COLUMN IF NOT EXISTS price NUMERIC DEFAULT 0;

-- إنشاء جدول للمحتوى التعليمي إذا لم يكن موجوداً
CREATE TABLE IF NOT EXISTS course_materials (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id UUID NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  material_type TEXT NOT NULL CHECK (material_type IN ('pdf', 'presentation', 'video')),
  file_path TEXT NOT NULL,
  file_size BIGINT,
  uploaded_by UUID REFERENCES profiles(user_id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- تمكين RLS على الجداول الجديدة
ALTER TABLE course_materials ENABLE ROW LEVEL SECURITY;

-- إنشاء السياسات
CREATE POLICY "Teachers can manage course materials" ON course_materials
FOR ALL USING (
  EXISTS (
    SELECT 1 FROM profiles 
    WHERE profiles.user_id = auth.uid() 
    AND profiles.role = 'admin'
  )
);

-- تحديث سياسات الكورسات لتكون للأدمن فقط
DROP POLICY IF EXISTS "Teachers can manage courses" ON courses;
DROP POLICY IF EXISTS "Anyone can view courses" ON courses;

CREATE POLICY "Admins can manage courses" ON courses
FOR ALL USING (
  EXISTS (
    SELECT 1 FROM profiles 
    WHERE profiles.user_id = auth.uid() 
    AND profiles.role = 'admin'
  )
);

CREATE POLICY "Students can view active courses" ON courses
FOR SELECT USING (is_active = true);

-- تحديث سياسات الطلاب
DROP POLICY IF EXISTS "Teachers can manage students" ON students;

CREATE POLICY "Admins can manage students" ON students
FOR ALL USING (
  EXISTS (
    SELECT 1 FROM profiles 
    WHERE profiles.user_id = auth.uid() 
    AND profiles.role = 'admin'
  )
);

-- إنشاء جدول للمواد الدراسية الخاصة بكل طالب
CREATE TABLE IF NOT EXISTS student_materials (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id UUID NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  material_id UUID NOT NULL REFERENCES course_materials(id) ON DELETE CASCADE,
  accessed_at TIMESTAMPTZ,
  progress NUMERIC DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(student_id, material_id)
);

ALTER TABLE student_materials ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Students can access their materials" ON student_materials
FOR SELECT USING (
  student_id IN (
    SELECT s.id FROM students s 
    JOIN profiles p ON p.email = s.email 
    WHERE p.user_id = auth.uid()
  )
);

CREATE POLICY "Admins can manage student materials" ON student_materials
FOR ALL USING (
  EXISTS (
    SELECT 1 FROM profiles 
    WHERE profiles.user_id = auth.uid() 
    AND profiles.role = 'admin'
  )
);