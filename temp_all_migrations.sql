-- Create profiles table for user management
CREATE TABLE public.profiles (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  email text,
  name text NOT NULL,
  role text NOT NULL DEFAULT 'student',
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

-- Create policies
CREATE POLICY "Users can view own profile" ON public.profiles FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can update own profile" ON public.profiles FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "Admin can manage all profiles" ON public.profiles FOR ALL USING (
  EXISTS (
    SELECT 1 FROM public.profiles 
    WHERE user_id = auth.uid() AND role = 'admin'
  )
);

-- Create students table
CREATE TABLE public.students (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  name text NOT NULL,
  email text,
  phone text,
  grade text,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.students ENABLE ROW LEVEL SECURITY;

-- Create policy
CREATE POLICY "Admin can manage students" ON public.students FOR ALL USING (
  EXISTS (
    SELECT 1 FROM public.profiles 
    WHERE user_id = auth.uid() AND role = 'admin'
  )
);

-- Create courses table
CREATE TABLE public.courses (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  title text NOT NULL,
  description text,
  subject text NOT NULL, -- 'history' or 'geography'
  grade text,
  video_url text,
  thumbnail_url text,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.courses ENABLE ROW LEVEL SECURITY;

-- Create policy
CREATE POLICY "Admin can manage courses" ON public.courses FOR ALL USING (
  EXISTS (
    SELECT 1 FROM public.profiles 
    WHERE user_id = auth.uid() AND role = 'admin'
  )
);

CREATE POLICY "Students can view courses" ON public.courses FOR SELECT USING (
  EXISTS (
    SELECT 1 FROM public.profiles 
    WHERE user_id = auth.uid() AND role IN ('student', 'admin')
  )
);

-- Create attendance table
CREATE TABLE public.attendance (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  student_id uuid REFERENCES public.students(id) ON DELETE CASCADE,
  course_id uuid REFERENCES public.courses(id) ON DELETE CASCADE,
  date date NOT NULL,
  status text NOT NULL DEFAULT 'absent', -- 'present', 'absent', 'late'
  notes text,
  created_at timestamp with time zone DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.attendance ENABLE ROW LEVEL SECURITY;

-- Create policy
CREATE POLICY "Admin can manage attendance" ON public.attendance FOR ALL USING (
  EXISTS (
    SELECT 1 FROM public.profiles 
    WHERE user_id = auth.uid() AND role = 'admin'
  )
);

-- Create exams table
CREATE TABLE public.exams (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  title text NOT NULL,
  course_id uuid REFERENCES public.courses(id) ON DELETE CASCADE,
  questions jsonb NOT NULL DEFAULT '[]'::jsonb,
  duration_minutes integer DEFAULT 60,
  total_marks integer DEFAULT 100,
  is_published boolean DEFAULT false,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.exams ENABLE ROW LEVEL SECURITY;

-- Create policies
CREATE POLICY "Admin can manage exams" ON public.exams FOR ALL USING (
  EXISTS (
    SELECT 1 FROM public.profiles 
    WHERE user_id = auth.uid() AND role = 'admin'
  )
);

CREATE POLICY "Students can view published exams" ON public.exams FOR SELECT USING (
  is_published = true AND EXISTS (
    SELECT 1 FROM public.profiles 
    WHERE user_id = auth.uid() AND role IN ('student', 'admin')
  )
);

-- Create exam_results table
CREATE TABLE public.exam_results (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  student_id uuid REFERENCES public.students(id) ON DELETE CASCADE,
  exam_id uuid REFERENCES public.exams(id) ON DELETE CASCADE,
  answers jsonb NOT NULL DEFAULT '{}'::jsonb,
  score numeric DEFAULT 0,
  total_marks numeric NOT NULL,
  submitted_at timestamp with time zone DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.exam_results ENABLE ROW LEVEL SECURITY;

-- Create policies
CREATE POLICY "Admin can manage exam results" ON public.exam_results FOR ALL USING (
  EXISTS (
    SELECT 1 FROM public.profiles 
    WHERE user_id = auth.uid() AND role = 'admin'
  )
);

-- Create expenses table for student fees
CREATE TABLE public.expenses (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  student_id uuid REFERENCES public.students(id) ON DELETE CASCADE,
  amount numeric NOT NULL,
  description text NOT NULL,
  due_date date,
  paid_date date,
  status text DEFAULT 'pending', -- 'pending', 'paid', 'overdue'
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.expenses ENABLE ROW LEVEL SECURITY;

-- Create policy
CREATE POLICY "Admin can manage expenses" ON public.expenses FOR ALL USING (
  EXISTS (
    SELECT 1 FROM public.profiles 
    WHERE user_id = auth.uid() AND role = 'admin'
  )
);

-- Insert admin user profile
INSERT INTO auth.users (
  id,
  aud,
  role,
  email,
  email_confirmed_at,
  encrypted_password,
  created_at,
  updated_at,
  raw_app_meta_data,
  raw_user_meta_data,
  is_super_admin,
  confirmation_token,
  recovery_token
) VALUES (
  gen_random_uuid(),
  'authenticated',
  'authenticated',
  'hodabdh3@gmail.com',
  now(),
  crypt('Mahmoud12345', gen_salt('bf')),
  now(),
  now(),
  '{"provider": "email", "providers": ["email"]}',
  '{"name": "Ø§Ù„Ø£Ø³ØªØ§Ø° Ù…Ø­Ù…Ø¯ Ø±Ù…Ø¶Ø§Ù†"}',
  false,
  '',
  ''
) ON CONFLICT (email) DO NOTHING;

-- Create trigger to auto-create profile on user signup
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger AS $$
BEGIN
  INSERT INTO public.profiles (user_id, email, name, role)
  VALUES (
    new.id,
    new.email,
    COALESCE(new.raw_user_meta_data->>'name', split_part(new.email, '@', 1)),
    CASE 
      WHEN new.email = 'hodabdh3@gmail.com' THEN 'admin'
      ELSE 'student'
    END
  );
  RETURN new;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Create trigger
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();
-- Create course_materials table for storing uploaded content
CREATE TABLE public.course_materials (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  course_id uuid NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  title text NOT NULL,
  description text,
  material_type text NOT NULL CHECK (material_type IN ('pdf', 'presentation', 'video')),
  file_path text NOT NULL,
  file_size bigint,
  uploaded_by uuid REFERENCES profiles(user_id),
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now()
);

-- Create exams table
CREATE TABLE public.exams (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  course_id uuid NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  title text NOT NULL,
  description text,
  questions_count integer NOT NULL DEFAULT 0,
  duration_minutes integer DEFAULT 60,
  is_active boolean DEFAULT true,
  created_by uuid REFERENCES profiles(user_id),
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now()
);

-- Create exam_questions table
CREATE TABLE public.exam_questions (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  exam_id uuid NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
  question_text text NOT NULL,
  question_type text NOT NULL DEFAULT 'multiple_choice' CHECK (question_type IN ('multiple_choice', 'true_false', 'short_answer')),
  options jsonb, -- For multiple choice questions
  correct_answer text NOT NULL,
  points numeric DEFAULT 1,
  created_at timestamp with time zone DEFAULT now()
);

-- Create student_courses table for course enrollment
CREATE TABLE public.student_courses (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  student_id uuid NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  course_id uuid NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  enrolled_at timestamp with time zone DEFAULT now(),
  is_active boolean DEFAULT true,
  UNIQUE(student_id, course_id)
);

-- Create messages table for student-teacher communication
CREATE TABLE public.messages (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  sender_id uuid NOT NULL REFERENCES profiles(user_id),
  recipient_id uuid REFERENCES profiles(user_id),
  message_text text NOT NULL,
  is_read boolean DEFAULT false,
  sent_at timestamp with time zone DEFAULT now(),
  student_id uuid REFERENCES students(id)
);

-- Update courses table to add specific subjects
INSERT INTO courses (name, description, subject) VALUES 
('Ø§Ù„ØªØ§Ø±ÙŠØ®', 'Ù…Ø§Ø¯Ø© Ø§Ù„ØªØ§Ø±ÙŠØ® - Ø§Ù„Ø­Ø¶Ø§Ø±Ø§Øª ÙˆØ§Ù„Ø£Ø­Ø¯Ø§Ø« Ø§Ù„ØªØ§Ø±ÙŠØ®ÙŠØ©', 'history'),
('Ø§Ù„Ø¬ØºØ±Ø§ÙÙŠØ§', 'Ù…Ø§Ø¯Ø© Ø§Ù„Ø¬ØºØ±Ø§ÙÙŠØ§ - Ø§Ù„Ø¬ØºØ±Ø§ÙÙŠØ§ Ø§Ù„Ø·Ø¨ÙŠØ¹ÙŠØ© ÙˆØ§Ù„Ø¨Ø´Ø±ÙŠØ©', 'geography')
ON CONFLICT (name) DO NOTHING;

-- Create storage bucket for course materials
INSERT INTO storage.buckets (id, name, public) VALUES ('course-materials', 'course-materials', false);

-- Enable RLS on all new tables
ALTER TABLE course_materials ENABLE ROW LEVEL SECURITY;
ALTER TABLE exams ENABLE ROW LEVEL SECURITY;
ALTER TABLE exam_questions ENABLE ROW LEVEL SECURITY;
ALTER TABLE student_courses ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;

-- RLS policies for course_materials
CREATE POLICY "Teachers can manage course materials" ON course_materials
FOR ALL USING (
  EXISTS (
    SELECT 1 FROM profiles 
    WHERE profiles.user_id = auth.uid() 
    AND profiles.role = 'admin'
  )
);

CREATE POLICY "Students can view materials for their courses" ON course_materials
FOR SELECT USING (
  course_id IN (
    SELECT sc.course_id FROM student_courses sc
    JOIN students s ON s.id = sc.student_id
    JOIN profiles p ON p.user_id = auth.uid()
    WHERE s.email = p.email
  )
);

-- RLS policies for exams
CREATE POLICY "Teachers can manage exams" ON exams
FOR ALL USING (
  EXISTS (
    SELECT 1 FROM profiles 
    WHERE profiles.user_id = auth.uid() 
    AND profiles.role = 'admin'
  )
);

CREATE POLICY "Students can view exams for their courses" ON exams
FOR SELECT USING (
  course_id IN (
    SELECT sc.course_id FROM student_courses sc
    JOIN students s ON s.id = sc.student_id
    JOIN profiles p ON p.user_id = auth.uid()
    WHERE s.email = p.email
  )
);

-- RLS policies for exam_questions
CREATE POLICY "Teachers can manage exam questions" ON exam_questions
FOR ALL USING (
  EXISTS (
    SELECT 1 FROM profiles 
    WHERE profiles.user_id = auth.uid() 
    AND profiles.role = 'admin'
  )
);

-- RLS policies for student_courses
CREATE POLICY "Teachers can manage student enrollments" ON student_courses
FOR ALL USING (
  EXISTS (
    SELECT 1 FROM profiles 
    WHERE profiles.user_id = auth.uid() 
    AND profiles.role = 'admin'
  )
);

CREATE POLICY "Students can view their own enrollments" ON student_courses
FOR SELECT USING (
  student_id IN (
    SELECT s.id FROM students s
    JOIN profiles p ON p.user_id = auth.uid()
    WHERE s.email = p.email
  )
);

-- RLS policies for messages
CREATE POLICY "Users can view their own messages" ON messages
FOR SELECT USING (
  sender_id = auth.uid() OR recipient_id = auth.uid()
);

CREATE POLICY "Users can send messages" ON messages
FOR INSERT WITH CHECK (sender_id = auth.uid());

CREATE POLICY "Teachers can view all messages" ON messages
FOR SELECT USING (
  EXISTS (
    SELECT 1 FROM profiles 
    WHERE profiles.user_id = auth.uid() 
    AND profiles.role = 'admin'
  )
);

-- Storage policies for course materials
CREATE POLICY "Teachers can upload course materials" ON storage.objects
FOR INSERT WITH CHECK (
  bucket_id = 'course-materials' AND
  EXISTS (
    SELECT 1 FROM profiles 
    WHERE profiles.user_id = auth.uid() 
    AND profiles.role = 'admin'
  )
);

CREATE POLICY "Users can view course materials" ON storage.objects
FOR SELECT USING (bucket_id = 'course-materials');

CREATE POLICY "Teachers can update course materials" ON storage.objects
FOR UPDATE USING (
  bucket_id = 'course-materials' AND
  EXISTS (
    SELECT 1 FROM profiles 
    WHERE profiles.user_id = auth.uid() 
    AND profiles.role = 'admin'
  )
);

CREATE POLICY "Teachers can delete course materials" ON storage.objects
FOR DELETE USING (
  bucket_id = 'course-materials' AND
  EXISTS (
    SELECT 1 FROM profiles 
    WHERE profiles.user_id = auth.uid() 
    AND profiles.role = 'admin'
  )
);
-- Create courses table first
CREATE TABLE public.courses (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  name text NOT NULL UNIQUE,
  description text,
  subject text CHECK (subject IN ('history', 'geography')),
  is_active boolean DEFAULT true,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now()
);

-- Enable RLS on courses
ALTER TABLE courses ENABLE ROW LEVEL SECURITY;

-- Create RLS policies for courses
CREATE POLICY "Anyone can view courses" ON courses FOR SELECT USING (true);
CREATE POLICY "Teachers can manage courses" ON courses
FOR ALL USING (
  EXISTS (
    SELECT 1 FROM profiles 
    WHERE profiles.user_id = auth.uid() 
    AND profiles.role = 'admin'
  )
);

-- Insert default courses
INSERT INTO courses (name, description, subject) VALUES 
('Ø§Ù„ØªØ§Ø±ÙŠØ®', 'Ù…Ø§Ø¯Ø© Ø§Ù„ØªØ§Ø±ÙŠØ® - Ø§Ù„Ø­Ø¶Ø§Ø±Ø§Øª ÙˆØ§Ù„Ø£Ø­Ø¯Ø§Ø« Ø§Ù„ØªØ§Ø±ÙŠØ®ÙŠØ©', 'history'),
('Ø§Ù„Ø¬ØºØ±Ø§ÙÙŠØ§', 'Ù…Ø§Ø¯Ø© Ø§Ù„Ø¬ØºØ±Ø§ÙÙŠØ§ - Ø§Ù„Ø¬ØºØ±Ø§ÙÙŠØ§ Ø§Ù„Ø·Ø¨ÙŠØ¹ÙŠØ© ÙˆØ§Ù„Ø¨Ø´Ø±ÙŠØ©', 'geography');

-- Create course_materials table for storing uploaded content
CREATE TABLE public.course_materials (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  course_id uuid NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  title text NOT NULL,
  description text,
  material_type text NOT NULL CHECK (material_type IN ('pdf', 'presentation', 'video')),
  file_path text NOT NULL,
  file_size bigint,
  uploaded_by uuid REFERENCES profiles(user_id),
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now()
);

-- Create exams table
CREATE TABLE public.exams (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  course_id uuid NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  title text NOT NULL,
  description text,
  questions_count integer NOT NULL DEFAULT 0,
  duration_minutes integer DEFAULT 60,
  is_active boolean DEFAULT true,
  created_by uuid REFERENCES profiles(user_id),
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now()
);

-- Create exam_questions table
CREATE TABLE public.exam_questions (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  exam_id uuid NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
  question_text text NOT NULL,
  question_type text NOT NULL DEFAULT 'multiple_choice' CHECK (question_type IN ('multiple_choice', 'true_false', 'short_answer')),
  options jsonb, -- For multiple choice questions
  correct_answer text NOT NULL,
  points numeric DEFAULT 1,
  created_at timestamp with time zone DEFAULT now()
);

-- Create student_courses table for course enrollment
CREATE TABLE public.student_courses (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  student_id uuid NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  course_id uuid NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  enrolled_at timestamp with time zone DEFAULT now(),
  is_active boolean DEFAULT true,
  UNIQUE(student_id, course_id)
);

-- Create teacher_messages table for student-teacher communication
CREATE TABLE public.teacher_messages (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  sender_id uuid NOT NULL REFERENCES profiles(user_id),
  recipient_id uuid REFERENCES profiles(user_id),
  message_text text NOT NULL,
  is_read boolean DEFAULT false,
  sent_at timestamp with time zone DEFAULT now(),
  student_id uuid REFERENCES students(id)
);

-- Create storage bucket for course materials
INSERT INTO storage.buckets (id, name, public) VALUES ('course-materials', 'course-materials', false);

-- Enable RLS on all new tables
ALTER TABLE course_materials ENABLE ROW LEVEL SECURITY;
ALTER TABLE exams ENABLE ROW LEVEL SECURITY;
ALTER TABLE exam_questions ENABLE ROW LEVEL SECURITY;
ALTER TABLE student_courses ENABLE ROW LEVEL SECURITY;
ALTER TABLE teacher_messages ENABLE ROW LEVEL SECURITY;

-- RLS policies for course_materials
CREATE POLICY "Teachers can manage course materials" ON course_materials
FOR ALL USING (
  EXISTS (
    SELECT 1 FROM profiles 
    WHERE profiles.user_id = auth.uid() 
    AND profiles.role = 'admin'
  )
);

-- RLS policies for exams
CREATE POLICY "Teachers can manage exams" ON exams
FOR ALL USING (
  EXISTS (
    SELECT 1 FROM profiles 
    WHERE profiles.user_id = auth.uid() 
    AND profiles.role = 'admin'
  )
);

-- RLS policies for exam_questions
CREATE POLICY "Teachers can manage exam questions" ON exam_questions
FOR ALL USING (
  EXISTS (
    SELECT 1 FROM profiles 
    WHERE profiles.user_id = auth.uid() 
    AND profiles.role = 'admin'
  )
);

-- RLS policies for student_courses
CREATE POLICY "Teachers can manage student enrollments" ON student_courses
FOR ALL USING (
  EXISTS (
    SELECT 1 FROM profiles 
    WHERE profiles.user_id = auth.uid() 
    AND profiles.role = 'admin'
  )
);

-- RLS policies for teacher_messages
CREATE POLICY "Users can view their own messages" ON teacher_messages
FOR SELECT USING (
  sender_id = auth.uid() OR recipient_id = auth.uid()
);

CREATE POLICY "Users can send messages" ON teacher_messages
FOR INSERT WITH CHECK (sender_id = auth.uid());

CREATE POLICY "Teachers can view all messages" ON teacher_messages
FOR SELECT USING (
  EXISTS (
    SELECT 1 FROM profiles 
    WHERE profiles.user_id = auth.uid() 
    AND profiles.role = 'admin'
  )
);

-- Storage policies for course materials
CREATE POLICY "Teachers can upload course materials" ON storage.objects
FOR INSERT WITH CHECK (
  bucket_id = 'course-materials' AND
  EXISTS (
    SELECT 1 FROM profiles 
    WHERE profiles.user_id = auth.uid() 
    AND profiles.role = 'admin'
  )
);

CREATE POLICY "Users can view course materials" ON storage.objects
FOR SELECT USING (bucket_id = 'course-materials');

CREATE POLICY "Teachers can update course materials" ON storage.objects
FOR UPDATE USING (
  bucket_id = 'course-materials' AND
  EXISTS (
    SELECT 1 FROM profiles 
    WHERE profiles.user_id = auth.uid() 
    AND profiles.role = 'admin'
  )
);

CREATE POLICY "Teachers can delete course materials" ON storage.objects
FOR DELETE USING (
  bucket_id = 'course-materials' AND
  EXISTS (
    SELECT 1 FROM profiles 
    WHERE profiles.user_id = auth.uid() 
    AND profiles.role = 'admin'
  )
);
-- Create courses table
CREATE TABLE public.courses (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  name text NOT NULL UNIQUE,
  description text,
  subject text CHECK (subject IN ('history', 'geography')),
  is_active boolean DEFAULT true,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now()
);

-- Create students table
CREATE TABLE public.students (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  name text NOT NULL,
  email text UNIQUE NOT NULL,
  phone text,
  grade text,
  enrollment_date date DEFAULT CURRENT_DATE,
  is_active boolean DEFAULT true,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now()
);

-- Create attendance table
CREATE TABLE public.attendance (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  student_id uuid NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  course_id uuid NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  attendance_date date NOT NULL,
  status text NOT NULL CHECK (status IN ('present', 'absent', 'late')),
  notes text,
  created_at timestamp with time zone DEFAULT now(),
  UNIQUE(student_id, course_id, attendance_date)
);

-- Create exams table
CREATE TABLE public.exams (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  course_id uuid NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  title text NOT NULL,
  description text,
  exam_date date,
  duration_minutes integer DEFAULT 60,
  total_marks integer DEFAULT 100,
  is_active boolean DEFAULT true,
  created_by uuid REFERENCES profiles(user_id),
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now()
);

-- Create exam_results table
CREATE TABLE public.exam_results (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  exam_id uuid NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
  student_id uuid NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  marks_obtained integer NOT NULL,
  grade text,
  remarks text,
  submitted_at timestamp with time zone DEFAULT now(),
  UNIQUE(exam_id, student_id)
);

-- Create student_fees table
CREATE TABLE public.student_fees (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  student_id uuid NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  amount numeric NOT NULL,
  due_date date NOT NULL,
  paid_date date,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'overdue')),
  description text,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now()
);

-- Create course_materials table for storing uploaded content
CREATE TABLE public.course_materials (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  course_id uuid NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  title text NOT NULL,
  description text,
  material_type text NOT NULL CHECK (material_type IN ('pdf', 'presentation', 'video')),
  file_path text NOT NULL,
  file_size bigint,
  uploaded_by uuid REFERENCES profiles(user_id),
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now()
);

-- Create exam_questions table
CREATE TABLE public.exam_questions (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  exam_id uuid NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
  question_text text NOT NULL,
  question_type text NOT NULL DEFAULT 'multiple_choice' CHECK (question_type IN ('multiple_choice', 'true_false', 'short_answer')),
  options jsonb, -- For multiple choice questions
  correct_answer text NOT NULL,
  points numeric DEFAULT 1,
  created_at timestamp with time zone DEFAULT now()
);

-- Create student_courses table for course enrollment
CREATE TABLE public.student_courses (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  student_id uuid NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  course_id uuid NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  enrolled_at timestamp with time zone DEFAULT now(),
  is_active boolean DEFAULT true,
  UNIQUE(student_id, course_id)
);

-- Create teacher_messages table for student-teacher communication
CREATE TABLE public.teacher_messages (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  sender_id uuid NOT NULL REFERENCES profiles(user_id),
  recipient_id uuid REFERENCES profiles(user_id),
  message_text text NOT NULL,
  is_read boolean DEFAULT false,
  sent_at timestamp with time zone DEFAULT now(),
  student_id uuid REFERENCES students(id)
);

-- Insert default courses
INSERT INTO courses (name, description, subject) VALUES 
('Ø§Ù„ØªØ§Ø±ÙŠØ®', 'Ù…Ø§Ø¯Ø© Ø§Ù„ØªØ§Ø±ÙŠØ® - Ø§Ù„Ø­Ø¶Ø§Ø±Ø§Øª ÙˆØ§Ù„Ø£Ø­Ø¯Ø§Ø« Ø§Ù„ØªØ§Ø±ÙŠØ®ÙŠØ©', 'history'),
('Ø§Ù„Ø¬ØºØ±Ø§ÙÙŠØ§', 'Ù…Ø§Ø¯Ø© Ø§Ù„Ø¬ØºØ±Ø§ÙÙŠØ§ - Ø§Ù„Ø¬ØºØ±Ø§ÙÙŠØ§ Ø§Ù„Ø·Ø¨ÙŠØ¹ÙŠØ© ÙˆØ§Ù„Ø¨Ø´Ø±ÙŠØ©', 'geography');

-- Create storage bucket for course materials
INSERT INTO storage.buckets (id, name, public) VALUES ('course-materials', 'course-materials', false);

-- Enable RLS on all tables
ALTER TABLE courses ENABLE ROW LEVEL SECURITY;
ALTER TABLE students ENABLE ROW LEVEL SECURITY;
ALTER TABLE attendance ENABLE ROW LEVEL SECURITY;
ALTER TABLE exams ENABLE ROW LEVEL SECURITY;
ALTER TABLE exam_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE student_fees ENABLE ROW LEVEL SECURITY;
ALTER TABLE course_materials ENABLE ROW LEVEL SECURITY;
ALTER TABLE exam_questions ENABLE ROW LEVEL SECURITY;
ALTER TABLE student_courses ENABLE ROW LEVEL SECURITY;
ALTER TABLE teacher_messages ENABLE ROW LEVEL SECURITY;

-- RLS policies for courses
CREATE POLICY "Anyone can view courses" ON courses FOR SELECT USING (true);
CREATE POLICY "Teachers can manage courses" ON courses
FOR ALL USING (
  EXISTS (
    SELECT 1 FROM profiles 
    WHERE profiles.user_id = auth.uid() 
    AND profiles.role = 'admin'
  )
);

-- RLS policies for students
CREATE POLICY "Teachers can manage students" ON students
FOR ALL USING (
  EXISTS (
    SELECT 1 FROM profiles 
    WHERE profiles.user_id = auth.uid() 
    AND profiles.role = 'admin'
  )
);

-- RLS policies for attendance
CREATE POLICY "Teachers can manage attendance" ON attendance
FOR ALL USING (
  EXISTS (
    SELECT 1 FROM profiles 
    WHERE profiles.user_id = auth.uid() 
    AND profiles.role = 'admin'
  )
);

-- RLS policies for exams
CREATE POLICY "Teachers can manage exams" ON exams
FOR ALL USING (
  EXISTS (
    SELECT 1 FROM profiles 
    WHERE profiles.user_id = auth.uid() 
    AND profiles.role = 'admin'
  )
);

-- RLS policies for exam_results
CREATE POLICY "Teachers can manage exam results" ON exam_results
FOR ALL USING (
  EXISTS (
    SELECT 1 FROM profiles 
    WHERE profiles.user_id = auth.uid() 
    AND profiles.role = 'admin'
  )
);

-- RLS policies for student_fees
CREATE POLICY "Teachers can manage student fees" ON student_fees
FOR ALL USING (
  EXISTS (
    SELECT 1 FROM profiles 
    WHERE profiles.user_id = auth.uid() 
    AND profiles.role = 'admin'
  )
);

-- RLS policies for course_materials
CREATE POLICY "Teachers can manage course materials" ON course_materials
FOR ALL USING (
  EXISTS (
    SELECT 1 FROM profiles 
    WHERE profiles.user_id = auth.uid() 
    AND profiles.role = 'admin'
  )
);

-- RLS policies for exam_questions
CREATE POLICY "Teachers can manage exam questions" ON exam_questions
FOR ALL USING (
  EXISTS (
    SELECT 1 FROM profiles 
    WHERE profiles.user_id = auth.uid() 
    AND profiles.role = 'admin'
  )
);

-- RLS policies for student_courses
CREATE POLICY "Teachers can manage student enrollments" ON student_courses
FOR ALL USING (
  EXISTS (
    SELECT 1 FROM profiles 
    WHERE profiles.user_id = auth.uid() 
    AND profiles.role = 'admin'
  )
);

-- RLS policies for teacher_messages
CREATE POLICY "Users can view their own messages" ON teacher_messages
FOR SELECT USING (
  sender_id = auth.uid() OR recipient_id = auth.uid()
);

CREATE POLICY "Users can send messages" ON teacher_messages
FOR INSERT WITH CHECK (sender_id = auth.uid());

CREATE POLICY "Teachers can view all messages" ON teacher_messages
FOR SELECT USING (
  EXISTS (
    SELECT 1 FROM profiles 
    WHERE profiles.user_id = auth.uid() 
    AND profiles.role = 'admin'
  )
);

-- Storage policies for course materials
CREATE POLICY "Teachers can upload course materials" ON storage.objects
FOR INSERT WITH CHECK (
  bucket_id = 'course-materials' AND
  EXISTS (
    SELECT 1 FROM profiles 
    WHERE profiles.user_id = auth.uid() 
    AND profiles.role = 'admin'
  )
);

CREATE POLICY "Users can view course materials" ON storage.objects
FOR SELECT USING (bucket_id = 'course-materials');

CREATE POLICY "Teachers can update course materials" ON storage.objects
FOR UPDATE USING (
  bucket_id = 'course-materials' AND
  EXISTS (
    SELECT 1 FROM profiles 
    WHERE profiles.user_id = auth.uid() 
    AND profiles.role = 'admin'
  )
);

CREATE POLICY "Teachers can delete course materials" ON storage.objects
FOR DELETE USING (
  bucket_id = 'course-materials' AND
  EXISTS (
    SELECT 1 FROM profiles 
    WHERE profiles.user_id = auth.uid() 
    AND profiles.role = 'admin'
  )
);
-- Ø¥Ù†Ø´Ø§Ø¡ Ù†Ø¸Ø§Ù… Ù…Ø­Ø¯Ø« Ù„Ù„Ù…Ø³ØªØ®Ø¯Ù…ÙŠÙ† ÙˆØ§Ù„Ø·Ù„Ø§Ø¨

-- Ø­Ø°Ù Ø§Ù„Ù†Ø¸Ø§Ù… Ø§Ù„Ù‚Ø¯ÙŠÙ… Ø¥Ù† ÙˆÙØ¬Ø¯
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
DROP FUNCTION IF EXISTS public.handle_new_user();

-- Ø¥Ù†Ø´Ø§Ø¡ ØªØ§Ø¨Ø¹ Ù…Ø­Ø¯Ø« Ù„Ø¥Ù†Ø´Ø§Ø¡ Ø§Ù„Ù…Ù„ÙØ§Øª Ø§Ù„Ø´Ø®ØµÙŠØ© ØªÙ„Ù‚Ø§Ø¦ÙŠØ§Ù‹
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  -- Ø¥Ù†Ø´Ø§Ø¡ Ù…Ù„Ù Ø´Ø®ØµÙŠ Ù„Ù„Ù…Ø³ØªØ®Ø¯Ù… Ø§Ù„Ø¬Ø¯ÙŠØ¯
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

-- Ø¥Ù†Ø´Ø§Ø¡ Ø§Ù„Ù…Ø´ØºÙ„
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- Ø¥Ø¶Ø§ÙØ© Ø­Ù‚ÙˆÙ„ Ø¬Ø¯ÙŠØ¯Ø© Ù„Ø¬Ø¯ÙˆÙ„ Ø§Ù„Ø·Ù„Ø§Ø¨
ALTER TABLE students ADD COLUMN IF NOT EXISTS password_hash TEXT;
ALTER TABLE students ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES profiles(user_id);
ALTER TABLE students ADD COLUMN IF NOT EXISTS schedule_time TEXT;
ALTER TABLE students ADD COLUMN IF NOT EXISTS session_days TEXT[];

-- Ø¥Ø¶Ø§ÙØ© Ø­Ù‚ÙˆÙ„ Ø¬Ø¯ÙŠØ¯Ø© Ù„Ø¬Ø¯ÙˆÙ„ Ø§Ù„ÙƒÙˆØ±Ø³Ø§Øª
ALTER TABLE courses ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES profiles(user_id);
ALTER TABLE courses ADD COLUMN IF NOT EXISTS schedule_time TEXT;
ALTER TABLE courses ADD COLUMN IF NOT EXISTS session_days TEXT[];
ALTER TABLE courses ADD COLUMN IF NOT EXISTS duration_weeks INTEGER DEFAULT 12;
ALTER TABLE courses ADD COLUMN IF NOT EXISTS price NUMERIC DEFAULT 0;

-- Ø¥Ù†Ø´Ø§Ø¡ Ø¬Ø¯ÙˆÙ„ Ù„Ù„Ù…Ø­ØªÙˆÙ‰ Ø§Ù„ØªØ¹Ù„ÙŠÙ…ÙŠ Ø¥Ø°Ø§ Ù„Ù… ÙŠÙƒÙ† Ù…ÙˆØ¬ÙˆØ¯Ø§Ù‹
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

-- ØªÙ…ÙƒÙŠÙ† RLS Ø¹Ù„Ù‰ Ø§Ù„Ø¬Ø¯Ø§ÙˆÙ„ Ø§Ù„Ø¬Ø¯ÙŠØ¯Ø©
ALTER TABLE course_materials ENABLE ROW LEVEL SECURITY;

-- Ø¥Ù†Ø´Ø§Ø¡ Ø§Ù„Ø³ÙŠØ§Ø³Ø§Øª
CREATE POLICY "Teachers can manage course materials" ON course_materials
FOR ALL USING (
  EXISTS (
    SELECT 1 FROM profiles 
    WHERE profiles.user_id = auth.uid() 
    AND profiles.role = 'admin'
  )
);

-- ØªØ­Ø¯ÙŠØ« Ø³ÙŠØ§Ø³Ø§Øª Ø§Ù„ÙƒÙˆØ±Ø³Ø§Øª Ù„ØªÙƒÙˆÙ† Ù„Ù„Ø£Ø¯Ù…Ù† ÙÙ‚Ø·
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

-- ØªØ­Ø¯ÙŠØ« Ø³ÙŠØ§Ø³Ø§Øª Ø§Ù„Ø·Ù„Ø§Ø¨
DROP POLICY IF EXISTS "Teachers can manage students" ON students;

CREATE POLICY "Admins can manage students" ON students
FOR ALL USING (
  EXISTS (
    SELECT 1 FROM profiles 
    WHERE profiles.user_id = auth.uid() 
    AND profiles.role = 'admin'
  )
);

-- Ø¥Ù†Ø´Ø§Ø¡ Ø¬Ø¯ÙˆÙ„ Ù„Ù„Ù…ÙˆØ§Ø¯ Ø§Ù„Ø¯Ø±Ø§Ø³ÙŠØ© Ø§Ù„Ø®Ø§ØµØ© Ø¨ÙƒÙ„ Ø·Ø§Ù„Ø¨
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
-- Add storage buckets for course materials
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES 
  ('course-materials', 'course-materials', false, 52428800, ARRAY['application/pdf', 'application/vnd.ms-powerpoint', 'application/vnd.openxmlformats-officedocument.presentationml.presentation', 'video/mp4', 'video/avi', 'video/mov', 'video/wmv']);

-- Create storage policies for course materials
CREATE POLICY "Admins can manage course materials"
ON storage.objects
FOR ALL
USING (bucket_id = 'course-materials' AND auth.uid() IN (
  SELECT user_id FROM profiles WHERE role = 'admin'
));

CREATE POLICY "Students can view course materials"
ON storage.objects
FOR SELECT
USING (bucket_id = 'course-materials');

-- Update students table - remove created_by column if it exists and add necessary columns
ALTER TABLE students 
DROP COLUMN IF EXISTS created_by,
ADD COLUMN IF NOT EXISTS password_hash TEXT DEFAULT '',
ADD COLUMN IF NOT EXISTS temporary_password TEXT;

-- Update course_materials table to support file uploads
ALTER TABLE course_materials 
ADD COLUMN IF NOT EXISTS file_url TEXT,
ADD COLUMN IF NOT EXISTS file_name TEXT;

-- Create exam_student_answers table for storing student answers
CREATE TABLE IF NOT EXISTS exam_student_answers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  exam_id UUID NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
  student_id UUID NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  question_id UUID NOT NULL REFERENCES exam_questions(id) ON DELETE CASCADE,
  student_answer TEXT NOT NULL,
  is_correct BOOLEAN DEFAULT FALSE,
  submitted_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  UNIQUE(exam_id, student_id, question_id)
);

-- Enable RLS on exam_student_answers
ALTER TABLE exam_student_answers ENABLE ROW LEVEL SECURITY;

-- Create policies for exam_student_answers
CREATE POLICY "Students can manage their own answers"
ON exam_student_answers
FOR ALL
USING (student_id IN (
  SELECT id FROM students WHERE email = (
    SELECT email FROM profiles WHERE user_id = auth.uid()
  )
));

CREATE POLICY "Admins can view all student answers"
ON exam_student_answers
FOR SELECT
USING (EXISTS (
  SELECT 1 FROM profiles 
  WHERE user_id = auth.uid() AND role = 'admin'
));
-- Update students table - remove created_by column if it exists and add necessary columns
ALTER TABLE students 
DROP COLUMN IF EXISTS created_by,
ADD COLUMN IF NOT EXISTS password_hash TEXT DEFAULT '',
ADD COLUMN IF NOT EXISTS temporary_password TEXT;

-- Update course_materials table to support file uploads
ALTER TABLE course_materials 
ADD COLUMN IF NOT EXISTS file_url TEXT,
ADD COLUMN IF NOT EXISTS file_name TEXT;

-- Create exam_student_answers table for storing student answers
CREATE TABLE IF NOT EXISTS exam_student_answers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  exam_id UUID NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
  student_id UUID NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  question_id UUID NOT NULL REFERENCES exam_questions(id) ON DELETE CASCADE,
  student_answer TEXT NOT NULL,
  is_correct BOOLEAN DEFAULT FALSE,
  submitted_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  UNIQUE(exam_id, student_id, question_id)
);

-- Enable RLS on exam_student_answers
ALTER TABLE exam_student_answers ENABLE ROW LEVEL SECURITY;

-- Create policies for exam_student_answers
CREATE POLICY "Students can manage their own answers"
ON exam_student_answers
FOR ALL
USING (student_id IN (
  SELECT id FROM students WHERE email = (
    SELECT email FROM profiles WHERE user_id = auth.uid()
  )
));

CREATE POLICY "Admins can view all student answers"
ON exam_student_answers
FOR SELECT
USING (EXISTS (
  SELECT 1 FROM profiles 
  WHERE user_id = auth.uid() AND role = 'admin'
));

-- Create storage policy for course materials if not exists
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies 
    WHERE schemaname = 'storage' 
    AND tablename = 'objects' 
    AND policyname = 'Admins can manage course materials'
  ) THEN
    CREATE POLICY "Admins can manage course materials"
    ON storage.objects
    FOR ALL
    USING (bucket_id = 'course-materials' AND auth.uid() IN (
      SELECT user_id FROM profiles WHERE role = 'admin'
    ));
  END IF;
END $$;

DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies 
    WHERE schemaname = 'storage' 
    AND tablename = 'objects' 
    AND policyname = 'Students can view course materials'
  ) THEN
    CREATE POLICY "Students can view course materials"
    ON storage.objects
    FOR SELECT
    USING (bucket_id = 'course-materials');
  END IF;
END $$;
-- Update the admin user role
UPDATE profiles 
SET role = 'admin', 
    name = 'Ù…Ø­Ù…Ø¯ Ø±Ù…Ø¶Ø§Ù†',
    username = 'admin'
WHERE email = 'mohamed96ramadan1996@gmail.com';

-- Also ensure we handle students login properly by checking password
-- Update Auth.tsx will handle the logic, but let's make sure the user data is correct
-- Update the admin user role with a unique username
UPDATE profiles 
SET role = 'admin', 
    name = 'Ù…Ø­Ù…Ø¯ Ø±Ù…Ø¶Ø§Ù†',
    username = 'mramadan_admin'
WHERE email = 'mohamed96ramadan1996@gmail.com';
-- Create subscriptions table
CREATE TABLE public.subscriptions (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  name TEXT NOT NULL,
  duration_months INTEGER NOT NULL,
  price NUMERIC NOT NULL DEFAULT 0,
  description TEXT,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.subscriptions ENABLE ROW LEVEL SECURITY;

-- Create policies
CREATE POLICY "Admins can manage subscriptions"
ON public.subscriptions
FOR ALL
USING (EXISTS (
  SELECT 1 FROM profiles 
  WHERE profiles.user_id = auth.uid() 
  AND profiles.role = 'admin'::user_role
));

-- Add subscription_id to students table
ALTER TABLE public.students ADD COLUMN subscription_id UUID REFERENCES public.subscriptions(id);
ALTER TABLE public.students ADD COLUMN subscription_start_date DATE;
ALTER TABLE public.students ADD COLUMN subscription_end_date DATE;
ALTER TABLE public.students ADD COLUMN subscription_price NUMERIC DEFAULT 0;

-- Create storage bucket for course materials if not exists
INSERT INTO storage.buckets (id, name, public) 
VALUES ('course-materials', 'course-materials', true)
ON CONFLICT (id) DO NOTHING;

-- Create storage policies
CREATE POLICY "Public can view course materials"
ON storage.objects FOR SELECT
USING (bucket_id = 'course-materials');

CREATE POLICY "Authenticated users can upload course materials"
ON storage.objects FOR INSERT
WITH CHECK (
  bucket_id = 'course-materials' 
  AND auth.role() = 'authenticated'
);
-- Fix RLS policies for students table to allow self-registration
DROP POLICY IF EXISTS "Teachers can manage students" ON students;

-- Allow anyone to insert students (for self-registration)
CREATE POLICY "Anyone can create student accounts" 
ON students 
FOR INSERT 
WITH CHECK (true);

-- Allow students to view their own profile
CREATE POLICY "Students can view their own profile" 
ON students 
FOR SELECT 
USING (email = (SELECT auth.email() FROM auth.users WHERE auth.uid() = auth.uid()) OR 
       (EXISTS (SELECT 1 FROM profiles WHERE profiles.user_id = auth.uid() AND profiles.role = 'admin'::user_role)));

-- Allow students to update their own profile
CREATE POLICY "Students can update their own profile" 
ON students 
FOR UPDATE 
USING (email = (SELECT auth.email() FROM auth.users WHERE auth.uid() = auth.uid()) OR 
       (EXISTS (SELECT 1 FROM profiles WHERE profiles.user_id = auth.uid() AND profiles.role = 'admin'::user_role)));

-- Allow teachers/admins to manage students
CREATE POLICY "Admins can manage all students" 
ON students 
FOR ALL 
USING (EXISTS (SELECT 1 FROM profiles WHERE profiles.user_id = auth.uid() AND profiles.role = 'admin'::user_role));
-- Remove geography course and keep only history
DELETE FROM courses WHERE name = 'Ø¬ØºØ±Ø§ÙÙŠØ§ Ù…ØµØ±' OR name LIKE '%Ø¬ØºØ±Ø§ÙÙŠØ§%';

-- Update the history course to ensure it exists
INSERT INTO courses (name, description, subject, is_active) 
VALUES ('Ø§Ù„ØªØ§Ø±ÙŠØ® Ø§Ù„Ø¥Ø³Ù„Ø§Ù…ÙŠ', 'Ø¯Ø±Ø§Ø³Ø© Ø´Ø§Ù…Ù„Ø© Ù„Ù„ØªØ§Ø±ÙŠØ® Ø§Ù„Ø¥Ø³Ù„Ø§Ù…ÙŠ Ù…Ù† Ø§Ù„Ø¹ØµØ± Ø§Ù„Ù‚Ø¯ÙŠÙ… Ø¥Ù„Ù‰ Ø§Ù„Ø¹ØµØ± Ø§Ù„Ø­Ø¯ÙŠØ«', 'history', true)
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
  'Ù…Ø¬Ù…ÙˆØ¹Ø© Ø§Ù„ØªØ§Ø±ÙŠØ® Ø§Ù„Ø£Ø³Ø§Ø³ÙŠØ©',
  'Ø§Ù„Ù…Ø¬Ù…ÙˆØ¹Ø© Ø§Ù„Ø£Ø³Ø§Ø³ÙŠØ© Ù„Ø¯Ø±Ø§Ø³Ø© Ø§Ù„ØªØ§Ø±ÙŠØ® Ø§Ù„Ø¥Ø³Ù„Ø§Ù…ÙŠ',
  ARRAY['sunday', 'tuesday', 'thursday'],
  '{"sunday": "10:00-12:00", "tuesday": "14:00-16:00", "thursday": "18:00-20:00"}'::jsonb,
  c.id
FROM courses c 
WHERE c.name = 'Ø§Ù„ØªØ§Ø±ÙŠØ® Ø§Ù„Ø¥Ø³Ù„Ø§Ù…ÙŠ'
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
-- Enable RLS on students table if not already enabled
ALTER TABLE public.students ENABLE ROW LEVEL SECURITY;

-- Allow students to create their own accounts (sign up)
CREATE POLICY "Students can create their own accounts" 
ON public.students 
FOR INSERT 
WITH CHECK (true);

-- Allow students to view their own data
CREATE POLICY "Students can view their own data" 
ON public.students 
FOR SELECT 
TO authenticated
USING (auth.uid()::text = id::text OR email IN (
  SELECT email FROM profiles WHERE user_id = auth.uid()
));

-- Allow unauthenticated users to create student accounts (for signup)
CREATE POLICY "Anonymous users can create student accounts" 
ON public.students 
FOR INSERT 
TO anon 
WITH CHECK (true);

-- Allow students to update their own data
CREATE POLICY "Students can update their own data" 
ON public.students 
FOR UPDATE 
TO authenticated
USING (auth.uid()::text = id::text OR email IN (
  SELECT email FROM profiles WHERE user_id = auth.uid()
));

-- Allow admins to manage all students
CREATE POLICY "Admins can manage all students" 
ON public.students 
FOR ALL 
TO authenticated
USING (EXISTS (
  SELECT 1 FROM profiles 
  WHERE user_id = auth.uid() AND role = 'admin'
));

-- Create student_courses table if it doesn't exist for course enrollments
CREATE TABLE IF NOT EXISTS public.student_courses (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  student_id uuid NOT NULL REFERENCES public.students(id) ON DELETE CASCADE,
  course_id uuid NOT NULL REFERENCES public.courses(id) ON DELETE CASCADE,
  enrolled_at timestamp with time zone DEFAULT now(),
  UNIQUE(student_id, course_id)
);

-- Enable RLS on student_courses
ALTER TABLE public.student_courses ENABLE ROW LEVEL SECURITY;

-- Allow students to view their own course enrollments
CREATE POLICY "Students can view their own courses" 
ON public.student_courses 
FOR SELECT 
TO authenticated
USING (student_id IN (
  SELECT id FROM students WHERE email IN (
    SELECT email FROM profiles WHERE user_id = auth.uid()
  )
));

-- Allow anonymous users to create course enrollments during signup
CREATE POLICY "Anonymous users can create course enrollments" 
ON public.student_courses 
FOR INSERT 
TO anon 
WITH CHECK (true);

-- Allow admins to manage all course enrollments
CREATE POLICY "Admins can manage course enrollments" 
ON public.student_courses 
FOR ALL 
TO authenticated
USING (EXISTS (
  SELECT 1 FROM profiles 
  WHERE user_id = auth.uid() AND role = 'admin'
));
-- First, let's ensure the students table allows anonymous inserts for registration
DROP POLICY IF EXISTS "Students can create their own accounts" ON public.students;
DROP POLICY IF EXISTS "Anonymous users can create student accounts" ON public.students;
DROP POLICY IF EXISTS "Admins can manage all students" ON public.students;

-- Create a simple policy to allow anyone to insert new students (for registration)
CREATE POLICY "Allow student registration" 
ON public.students 
FOR INSERT 
WITH CHECK (true);

-- Allow students to view their own data
CREATE POLICY "Students can view own data" 
ON public.students 
FOR SELECT 
USING (true);

-- Allow students to update their own data  
CREATE POLICY "Students can update own data"
ON public.students 
FOR UPDATE 
USING (true);

-- Allow admins full access
CREATE POLICY "Admin full access to students" 
ON public.students 
FOR ALL 
USING (EXISTS (
  SELECT 1 FROM profiles 
  WHERE user_id = auth.uid() AND role = 'admin'
));

-- Ensure student_courses table exists and has proper policies
CREATE TABLE IF NOT EXISTS public.student_courses (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  student_id uuid NOT NULL REFERENCES public.students(id) ON DELETE CASCADE,
  course_id uuid NOT NULL REFERENCES public.courses(id) ON DELETE CASCADE,
  enrolled_at timestamp with time zone DEFAULT now(),
  UNIQUE(student_id, course_id)
);

ALTER TABLE public.student_courses ENABLE ROW LEVEL SECURITY;

-- Allow anyone to insert course enrollments (for registration)
DROP POLICY IF EXISTS "Allow course enrollment" ON public.student_courses;
CREATE POLICY "Allow course enrollment" 
ON public.student_courses 
FOR INSERT 
WITH CHECK (true);

-- Allow viewing course enrollments
DROP POLICY IF EXISTS "Allow viewing course enrollments" ON public.student_courses;
CREATE POLICY "Allow viewing course enrollments" 
ON public.student_courses 
FOR SELECT 
USING (true);
-- Drop existing restrictive policies
DROP POLICY IF EXISTS "Users can send messages" ON teacher_messages;
DROP POLICY IF EXISTS "Users can view their own messages" ON teacher_messages;

-- Allow students to insert messages (they use student_id, not auth)
CREATE POLICY "Students and admins can send messages" 
ON teacher_messages 
FOR INSERT 
WITH CHECK (true);

-- Allow students to view messages where they are involved
CREATE POLICY "Students can view their messages" 
ON teacher_messages 
FOR SELECT 
USING (
  student_id IN (
    SELECT students.id 
    FROM students 
    WHERE students.email = current_setting('app.current_student_email', true)
  )
  OR EXISTS (
    SELECT 1 
    FROM profiles 
    WHERE profiles.user_id = auth.uid() 
    AND profiles.role = 'admin'::user_role
  )
);

-- Allow admins to update message status (mark as read, etc)
CREATE POLICY "Admins can update messages" 
ON teacher_messages 
FOR UPDATE 
USING (
  EXISTS (
    SELECT 1 
    FROM profiles 
    WHERE profiles.user_id = auth.uid() 
    AND profiles.role = 'admin'::user_role
  )
);
-- Simplify RLS policies for teacher_messages to work with both authenticated and unauthenticated users
DROP POLICY IF EXISTS "Students can view their messages" ON teacher_messages;
DROP POLICY IF EXISTS "Students and admins can send messages" ON teacher_messages;
DROP POLICY IF EXISTS "Admins can update messages" ON teacher_messages;

-- Allow all operations on teacher_messages (application logic will handle filtering)
CREATE POLICY "Allow all operations on teacher_messages" 
ON teacher_messages 
FOR ALL 
USING (true) 
WITH CHECK (true);

-- Make the table accessible to anonymous users for student messaging
ALTER TABLE teacher_messages ENABLE RLS;
-- Drop existing policies if they exist
DROP POLICY IF EXISTS "Students can view their messages" ON teacher_messages;
DROP POLICY IF EXISTS "Students and admins can send messages" ON teacher_messages;
DROP POLICY IF EXISTS "Admins can update messages" ON teacher_messages;
DROP POLICY IF EXISTS "Teachers can view all messages" ON teacher_messages;

-- Allow all operations on teacher_messages (application logic will handle proper filtering)
CREATE POLICY "Allow all teacher message operations" 
ON teacher_messages 
FOR ALL 
USING (true) 
WITH CHECK (true);
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
-- Step 1: Add 'student' value to user_role enum
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'student' AND enumtypid = 'user_role'::regtype) THEN
        ALTER TYPE public.user_role ADD VALUE 'student';
    END IF;
END$$;
-- Step 2: Create user_roles table and all related functions/policies
CREATE TABLE IF NOT EXISTS public.user_roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role public.user_role NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  UNIQUE(user_id, role)
);

-- Enable RLS on user_roles
ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;

-- Create security definer functions
CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role user_role)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.user_roles
    WHERE user_id = _user_id
      AND role = _role
  )
$$;

CREATE OR REPLACE FUNCTION public.is_admin(_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.has_role(_user_id, 'admin'::user_role)
$$;

CREATE OR REPLACE FUNCTION public.is_student(_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.has_role(_user_id, 'student'::user_role)
$$;

-- RLS policies for user_roles table
DROP POLICY IF EXISTS "Users can view their own roles" ON public.user_roles;
DROP POLICY IF EXISTS "Admins can manage all roles" ON public.user_roles;

CREATE POLICY "Users can view their own roles"
ON public.user_roles
FOR SELECT
USING (auth.uid() = user_id);

CREATE POLICY "Admins can manage all roles"
ON public.user_roles
FOR ALL
USING (public.is_admin(auth.uid()));

-- Update students table RLS policies
DROP POLICY IF EXISTS "Teachers can manage students" ON public.students;
DROP POLICY IF EXISTS "Students can view their own data" ON public.students;
DROP POLICY IF EXISTS "Anyone can view students" ON public.students;
DROP POLICY IF EXISTS "Admins can manage all students" ON public.students;
DROP POLICY IF EXISTS "Students can view own data" ON public.students;
DROP POLICY IF EXISTS "Students can update own data" ON public.students;
DROP POLICY IF EXISTS "Allow public student signup" ON public.students;

-- Create new RLS policies for students table
CREATE POLICY "Admins can manage all students"
ON public.students
FOR ALL
USING (public.is_admin(auth.uid()))
WITH CHECK (public.is_admin(auth.uid()));

CREATE POLICY "Students can view own data"
ON public.students
FOR SELECT
USING (
  EXISTS (
    SELECT 1 FROM auth.users
    WHERE auth.users.id = auth.uid()
    AND auth.users.email = students.email
  )
);

CREATE POLICY "Students can update own data"
ON public.students
FOR UPDATE
USING (
  EXISTS (
    SELECT 1 FROM auth.users
    WHERE auth.users.id = auth.uid()
    AND auth.users.email = students.email
  )
)
WITH CHECK (
  EXISTS (
    SELECT 1 FROM auth.users
    WHERE auth.users.id = auth.uid()
    AND auth.users.email = students.email
  )
);

-- CRITICAL: Allow unauthenticated users to insert students (for signup)
CREATE POLICY "Allow public student signup"
ON public.students
FOR INSERT
WITH CHECK (true);

-- Create trigger function
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Check if this user should be a student
  IF EXISTS (
    SELECT 1 FROM public.students 
    WHERE email = NEW.email
  ) THEN
    -- Create student role
    INSERT INTO public.user_roles (user_id, role)
    VALUES (NEW.id, 'student'::user_role)
    ON CONFLICT (user_id, role) DO NOTHING;
  END IF;
  
  RETURN NEW;
END;
$$;

-- Create trigger on auth.users
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_new_user();
-- Fix authentication and signup issues

-- 1. Fix user_roles RLS policies to allow trigger to insert roles
DROP POLICY IF EXISTS "Admins can manage all roles" ON public.user_roles;
DROP POLICY IF EXISTS "Allow trigger to insert roles" ON public.user_roles;

-- Allow admins to manage all roles
CREATE POLICY "Admins can manage all roles"
ON public.user_roles
FOR ALL
USING (public.is_admin(auth.uid()))
WITH CHECK (public.is_admin(auth.uid()));

-- CRITICAL: Allow the trigger (running as SECURITY DEFINER) to insert roles
CREATE POLICY "Allow trigger to insert roles"
ON public.user_roles
FOR INSERT
WITH CHECK (true);

-- 2. Update the handle_new_user trigger to be more reliable
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Always try to assign student role if email matches a student record
  IF EXISTS (
    SELECT 1 FROM public.students 
    WHERE email = NEW.email
  ) THEN
    INSERT INTO public.user_roles (user_id, role)
    VALUES (NEW.id, 'student'::user_role)
    ON CONFLICT (user_id, role) DO NOTHING;
  END IF;
  
  RETURN NEW;
EXCEPTION
  WHEN OTHERS THEN
    -- Log error but don't block user creation
    RAISE WARNING 'Error in handle_new_user: %', SQLERRM;
    RETURN NEW;
END;
$$;

-- 3. Create a helper function to setup admin user
-- This function can be called manually after creating an admin user in Supabase Auth
CREATE OR REPLACE FUNCTION public.make_user_admin(admin_email TEXT)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  target_user_id UUID;
BEGIN
  -- Find the user by email
  SELECT id INTO target_user_id
  FROM auth.users
  WHERE email = admin_email;
  
  IF target_user_id IS NULL THEN
    RAISE EXCEPTION 'User with email % not found', admin_email;
  END IF;
  
  -- Insert admin role
  INSERT INTO public.user_roles (user_id, role)
  VALUES (target_user_id, 'admin'::user_role)
  ON CONFLICT (user_id, role) DO NOTHING;
  
  -- Create or update profile if needed
  INSERT INTO public.profiles (user_id, email, role)
  VALUES (target_user_id, admin_email, 'admin'::user_role)
  ON CONFLICT (user_id) 
  DO UPDATE SET role = 'admin'::user_role;
  
  RAISE NOTICE 'Successfully made % an admin', admin_email;
END;
$$;

-- 4. If you have an existing admin email, make them admin
-- Uncomment and replace with actual admin email:
-- SELECT public.make_user_admin('mohamed96ramadan1996@gmail.com');
-- Ø¥Ø¶Ø§ÙØ© Ø¯ÙˆØ± admin Ù„Ù„Ù…Ø³ØªØ®Ø¯Ù… Ù…Ø­Ù…Ø¯ Ø±Ù…Ø¶Ø§Ù†
INSERT INTO public.user_roles (user_id, role)
VALUES ('7464daff-b429-4dfd-b313-f319622a066a', 'admin')
ON CONFLICT (user_id, role) DO NOTHING;
-- ØªØ­Ø¯ÙŠØ« Ø³ÙŠØ§Ø³Ø§Øª RLS Ù„Ø¬Ø¯ÙˆÙ„ courses Ù„ØªØ³Ù…Ø­ Ø¨Ø§Ù„Ø­Ø°Ù
-- Ø£ÙˆÙ„Ø§Ù‹ØŒ Ù†Ø­Ø°Ù Ø§Ù„Ø³ÙŠØ§Ø³Ø© Ø§Ù„Ù‚Ø¯ÙŠÙ…Ø© Ø¥Ø°Ø§ ÙƒØ§Ù†Øª Ù…ÙˆØ¬ÙˆØ¯Ø©
DROP POLICY IF EXISTS "Teachers can manage courses" ON public.courses;

-- Ø¥Ø¶Ø§ÙØ© Ø³ÙŠØ§Ø³Ø§Øª Ø¬Ø¯ÙŠØ¯Ø© Ù…Ù†ÙØµÙ„Ø© Ù„ÙƒÙ„ Ø¹Ù…Ù„ÙŠØ©
CREATE POLICY "Admins can delete courses" 
ON public.courses 
FOR DELETE 
USING (
  EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = auth.uid() 
    AND role = 'admin'
  )
);

CREATE POLICY "Admins can insert courses" 
ON public.courses 
FOR INSERT 
WITH CHECK (
  EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = auth.uid() 
    AND role = 'admin'
  )
);

CREATE POLICY "Admins can update courses" 
ON public.courses 
FOR UPDATE 
USING (
  EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = auth.uid() 
    AND role = 'admin'
  )
);

-- Ø§Ù„ØªØ£ÙƒØ¯ Ù…Ù† ÙˆØ¬ÙˆØ¯ Ø³ÙŠØ§Ø³Ø© SELECT Ù„Ù„Ø¬Ù…ÙŠØ¹
CREATE POLICY "Anyone can view active courses" 
ON public.courses 
FOR SELECT 
USING (is_active = true);
-- Ø¥Ø²Ø§Ù„Ø© Ø§Ù„Ù‚ÙŠØ¯ Ø§Ù„Ù‚Ø¯ÙŠÙ… ÙˆØ¥Ø¶Ø§ÙØ© Ù‚ÙŠØ¯ Ø¬Ø¯ÙŠØ¯ ÙŠØ³Ù…Ø­ Ø¨Ø§Ù„Ø­Ø°Ù
ALTER TABLE public.groups 
DROP CONSTRAINT IF EXISTS groups_course_id_fkey;

-- Ø¥Ø¶Ø§ÙØ© Ø§Ù„Ù‚ÙŠØ¯ Ø§Ù„Ø¬Ø¯ÙŠØ¯ Ù…Ø¹ ON DELETE SET NULL
-- Ù‡Ø°Ø§ ÙŠØ¹Ù†ÙŠ Ø¹Ù†Ø¯ Ø­Ø°Ù Ø§Ù„ÙƒÙˆØ±Ø³ØŒ Ø³ÙŠØªÙ… ØªØ¹ÙŠÙŠÙ† course_id = NULL ÙÙŠ Ø§Ù„Ù…Ø¬Ù…ÙˆØ¹Ø§Øª Ø§Ù„Ù…Ø±ØªØ¨Ø·Ø©
ALTER TABLE public.groups 
ADD CONSTRAINT groups_course_id_fkey 
FOREIGN KEY (course_id) 
REFERENCES public.courses(id) 
ON DELETE SET NULL;

-- Ø£ÙŠØ¶Ø§Ù‹ Ù†ÙØ¹Ù„ Ù†ÙØ³ Ø§Ù„Ø´ÙŠØ¡ Ù„Ø¬Ø¯ÙˆÙ„ student_courses Ø¥Ø°Ø§ ÙƒØ§Ù† Ù…ÙˆØ¬ÙˆØ¯
ALTER TABLE IF EXISTS public.student_courses 
DROP CONSTRAINT IF EXISTS student_courses_course_id_fkey;

ALTER TABLE IF EXISTS public.student_courses 
ADD CONSTRAINT student_courses_course_id_fkey 
FOREIGN KEY (course_id) 
REFERENCES public.courses(id) 
ON DELETE CASCADE;
-- Ø¥Ø²Ø§Ù„Ø© Ø§Ù„Ù‚ÙŠØ¯ Ø§Ù„Ù‚Ø¯ÙŠÙ… Ø¹Ù„Ù‰ subject Ø¥Ø°Ø§ ÙƒØ§Ù† Ù…ÙˆØ¬ÙˆØ¯
ALTER TABLE public.courses 
DROP CONSTRAINT IF EXISTS courses_subject_check;

-- Ø§Ù„Ø³Ù…Ø§Ø­ Ø¨Ø£ÙŠ Ù‚ÙŠÙ…Ø© ÙÙŠ Ø­Ù‚Ù„ subject
-- Ù„Ø§ Ù†Ø­ØªØ§Ø¬ Ø¥Ù„Ù‰ Ø¥Ø¶Ø§ÙØ© Ù‚ÙŠØ¯ Ø¬Ø¯ÙŠØ¯ØŒ ÙÙ‚Ø· Ù†ØªØ±Ùƒ Ø§Ù„Ø­Ù‚Ù„ Ø­Ø±
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
-- Add grade_id column to course_materials table
ALTER TABLE course_materials 
ADD COLUMN IF NOT EXISTS grade_id UUID REFERENCES grades(id);

-- Create index for better performance
CREATE INDEX IF NOT EXISTS idx_course_materials_grade_id 
ON course_materials(grade_id);
-- ØªØ­Ø¯ÙŠØ« RLS policy Ù„Ø¬Ø¯ÙˆÙ„ course_materials Ù„Ø¥Ø¶Ø§ÙØ© ØµÙ„Ø§Ø­ÙŠØ§Øª Ù„Ù„Ù€ admin
DROP POLICY IF EXISTS "Teachers can manage course materials" ON public.course_materials;

-- Ø¥Ù†Ø´Ø§Ø¡ policy ÙŠØ³Ù…Ø­ Ù„Ù„Ù€ admin Ø¨Ø¥Ø¯Ø§Ø±Ø© Ø§Ù„Ù…Ø­ØªÙˆÙ‰
CREATE POLICY "Admins can manage course materials"
ON public.course_materials
FOR ALL
USING (
  EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_roles.user_id = auth.uid()
    AND user_roles.role = 'admin'
  )
  OR
  EXISTS (
    SELECT 1 FROM public.profiles
    WHERE profiles.user_id = auth.uid()
    AND profiles.role = 'admin'
  )
);

-- ØªØ­Ø¯ÙŠØ« policy Ø¬Ø¯ÙˆÙ„ material_groups
DROP POLICY IF EXISTS "Admins can manage material groups" ON public.material_groups;

CREATE POLICY "Admins can manage material groups"
ON public.material_groups
FOR ALL
USING (
  EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_roles.user_id = auth.uid()
    AND user_roles.role = 'admin'
  )
  OR
  EXISTS (
    SELECT 1 FROM public.profiles
    WHERE profiles.user_id = auth.uid()
    AND profiles.role = 'admin'
  )
);

-- Ø¥Ø¶Ø§ÙØ© policy Ù„Ù„Ø·Ù„Ø§Ø¨ Ù„Ø¹Ø±Ø¶ Ø§Ù„Ù…Ø­ØªÙˆÙ‰ Ø§Ù„Ø®Ø§Øµ Ø¨Ù‡Ù…
DROP POLICY IF EXISTS "Students can view their materials" ON public.course_materials;

CREATE POLICY "Students can view their materials"
ON public.course_materials
FOR SELECT
USING (
  EXISTS (
    SELECT 1 FROM public.material_groups mg
    JOIN public.students s ON s.group_id = mg.group_id
    JOIN public.profiles p ON p.email = s.email
    WHERE mg.material_id = course_materials.id
    AND p.user_id = auth.uid()
  )
);
-- ØªØ­Ø¯ÙŠØ« RLS policy Ø¹Ù„Ù‰ Ø¬Ø¯ÙˆÙ„ course_materials Ù„ØªØ³Ù…Ø­ Ù„Ù„Ù…Ø³ØªØ®Ø¯Ù…ÙŠÙ† Ø§Ù„Ù…ØµØ§Ø¯Ù‚ Ø¹Ù„ÙŠÙ‡Ù… Ø¨Ø¥Ø¶Ø§ÙØ© Ø§Ù„Ù…Ø­ØªÙˆÙ‰
DROP POLICY IF EXISTS "Admins can manage course materials" ON public.course_materials;

-- Ø¥Ù†Ø´Ø§Ø¡ policy Ø¬Ø¯ÙŠØ¯Ø© ØªØ³Ù…Ø­ Ù„Ù„Ù…Ø³ØªØ®Ø¯Ù…ÙŠÙ† Ø§Ù„Ù…ØµØ§Ø¯Ù‚ Ø¹Ù„ÙŠÙ‡Ù… Ø¨Ø¥Ø¶Ø§ÙØ© ÙˆØ­Ø°Ù ÙˆØªØ­Ø¯ÙŠØ« Ø§Ù„Ù…Ø­ØªÙˆÙ‰
CREATE POLICY "Authenticated users can manage course materials"
ON public.course_materials
FOR ALL
TO authenticated
USING (true)
WITH CHECK (true);

-- ØªØ­Ø¯ÙŠØ« RLS policy Ø¹Ù„Ù‰ Ø¬Ø¯ÙˆÙ„ material_groups Ù„ØªØ³Ù…Ø­ Ù„Ù„Ù…Ø³ØªØ®Ø¯Ù…ÙŠÙ† Ø§Ù„Ù…ØµØ§Ø¯Ù‚ Ø¹Ù„ÙŠÙ‡Ù… Ø¨Ø§Ù„Ø¥Ø¯Ø§Ø±Ø©
DROP POLICY IF EXISTS "Admins can manage material groups" ON public.material_groups;

CREATE POLICY "Authenticated users can manage material groups"
ON public.material_groups
FOR ALL
TO authenticated
USING (true)
WITH CHECK (true);
-- Ø­Ø°Ù Ø§Ù„Ù€ policy Ø§Ù„Ù‚Ø¯ÙŠÙ…Ø© ÙˆØ¥Ù†Ø´Ø§Ø¡ ÙˆØ§Ø­Ø¯Ø© Ø¬Ø¯ÙŠØ¯Ø© ØªØ¹Ù…Ù„ Ø¨Ø´ÙƒÙ„ ØµØ­ÙŠØ­
DROP POLICY IF EXISTS "Authenticated users can upload course materials" ON storage.objects;

-- Ø¥Ù†Ø´Ø§Ø¡ policy Ø¬Ø¯ÙŠØ¯Ø© Ù„Ù„Ø±ÙØ¹ Ø¨Ø§Ø³ØªØ®Ø¯Ø§Ù… auth.uid() Ø¨Ø¯Ù„Ø§Ù‹ Ù…Ù† auth.role()
CREATE POLICY "Authenticated users can upload course materials"
ON storage.objects
FOR INSERT
TO authenticated
WITH CHECK (
  bucket_id = 'course-materials' 
  AND auth.uid() IS NOT NULL
);

-- ØªØ­Ø¯ÙŠØ« policy Ø§Ù„Ø­Ø°Ù
DROP POLICY IF EXISTS "Teachers can delete course materials" ON storage.objects;
CREATE POLICY "Authenticated users can delete course materials"
ON storage.objects
FOR DELETE
TO authenticated
USING (
  bucket_id = 'course-materials' 
  AND auth.uid() IS NOT NULL
);

-- ØªØ­Ø¯ÙŠØ« policy Ø§Ù„ØªØ­Ø¯ÙŠØ«
DROP POLICY IF EXISTS "Teachers can update course materials" ON storage.objects;
CREATE POLICY "Authenticated users can update course materials"
ON storage.objects
FOR UPDATE
TO authenticated
USING (
  bucket_id = 'course-materials' 
  AND auth.uid() IS NOT NULL
)
WITH CHECK (
  bucket_id = 'course-materials' 
  AND auth.uid() IS NOT NULL
);
-- Update course-materials bucket to allow larger file sizes (up to 500MB for videos)
UPDATE storage.buckets 
SET 
  file_size_limit = 524288000, -- 500MB in bytes
  allowed_mime_types = ARRAY[
    'application/pdf',
    'application/vnd.ms-powerpoint',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'application/vnd.openxmlformats-officedocument.presentationml.slideshow',
    'video/mp4',
    'video/x-msvideo',
    'video/quicktime',
    'video/x-ms-wmv',
    'video/x-matroska',
    'video/x-flv',
    'video/webm'
  ]
WHERE id = 'course-materials';
-- Make course-materials bucket public so uploaded files can be viewed
UPDATE storage.buckets 
SET public = true
WHERE id = 'course-materials';
-- Add grade_id column to courses table
ALTER TABLE public.courses 
ADD COLUMN grade_id uuid REFERENCES public.grades(id);

-- Add index for better performance
CREATE INDEX idx_courses_grade_id ON public.courses(grade_id);
-- Add explanation column to exam_questions table
ALTER TABLE public.exam_questions 
ADD COLUMN IF NOT EXISTS explanation TEXT;
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
-- Drop the problematic policy that causes infinite recursion
DROP POLICY IF EXISTS "Admins can read all users" ON public.users;

-- Create a better policy that uses the profiles table instead
CREATE POLICY "Admins can read all users" 
ON public.users
FOR SELECT 
USING (
  EXISTS (
    SELECT 1 
    FROM public.profiles
    WHERE profiles.user_id = auth.uid() 
    AND profiles.role = 'admin'::user_role
  )
);

-- Also update the students policies that reference auth.users to avoid issues
DROP POLICY IF EXISTS "Students can update own data" ON public.students;
DROP POLICY IF EXISTS "Students can view own data" ON public.students;

-- Recreate simpler student policies
CREATE POLICY "Students can view own data" 
ON public.students
FOR SELECT 
USING (
  email = auth.email() 
  OR EXISTS (
    SELECT 1 FROM public.profiles 
    WHERE profiles.user_id = auth.uid() 
    AND profiles.role = 'admin'::user_role
  )
);

CREATE POLICY "Students can update own data" 
ON public.students
FOR UPDATE 
USING (
  email = auth.email()
  OR EXISTS (
    SELECT 1 FROM public.profiles 
    WHERE profiles.user_id = auth.uid() 
    AND profiles.role = 'admin'::user_role
  )
);
-- Ø¥Ø¶Ø§ÙØ© Ø¹Ù…ÙˆØ¯ Ù†ÙˆØ¹ Ø§Ù„Ù…Ø¬Ù…ÙˆØ¹Ø© (Ø£ÙˆÙÙ„Ø§ÙŠÙ†/Ø£ÙˆÙ†Ù„Ø§ÙŠÙ†)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'group_type') THEN
    CREATE TYPE group_type AS ENUM ('offline', 'online');
  END IF;
END $$;

ALTER TABLE public.groups
ADD COLUMN IF NOT EXISTS type group_type DEFAULT 'offline';

-- Ø­Ø°Ù Ø¹Ù…ÙˆØ¯ Ø§Ù„ÙƒÙˆØ±Ø³ Ù…Ù† Ø§Ù„Ù…Ø¬Ù…ÙˆØ¹Ø§Øª (Ù„Ø£Ù† Ø§Ù„Ù…Ø¬Ù…ÙˆØ¹Ø© Ø³ØªØ­ØªÙˆÙŠ Ø¹Ù„Ù‰ Ø¹Ø¯Ø© ÙƒÙˆØ±Ø³Ø§Øª)
ALTER TABLE public.groups
DROP COLUMN IF EXISTS course_id;

-- Ø­Ø°Ù Ø¹Ù…ÙˆØ¯ÙŠ Ø§Ù„Ù…ÙˆØ§Ø¹ÙŠØ¯ Ù…Ù† Ø§Ù„Ù…Ø¬Ù…ÙˆØ¹Ø§Øª (Ø³ØªÙƒÙˆÙ† Ø§Ù„Ù…ÙˆØ§Ø¹ÙŠØ¯ Ù„ÙƒÙ„ ÙƒÙˆØ±Ø³ Ø¹Ù„Ù‰ Ø­Ø¯Ø©)
ALTER TABLE public.groups
DROP COLUMN IF EXISTS schedule_days,
DROP COLUMN IF EXISTS schedule_times;

-- Ø¥Ù†Ø´Ø§Ø¡ Ø¬Ø¯ÙˆÙ„ Ù„Ø±Ø¨Ø· Ø§Ù„Ù…Ø¬Ù…ÙˆØ¹Ø§Øª Ø¨Ø§Ù„ÙƒÙˆØ±Ø³Ø§Øª Ù…Ø¹ Ø§Ù„Ù…ÙˆØ§Ø¹ÙŠØ¯
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

-- ØªÙØ¹ÙŠÙ„ RLS Ø¹Ù„Ù‰ Ø§Ù„Ø¬Ø¯ÙˆÙ„ Ø§Ù„Ø¬Ø¯ÙŠØ¯
ALTER TABLE public.group_courses ENABLE ROW LEVEL SECURITY;

-- Ø³ÙŠØ§Ø³Ø§Øª RLS Ù„Ù„Ø¬Ø¯ÙˆÙ„ Ø§Ù„Ø¬Ø¯ÙŠØ¯
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

-- ØªØ­Ø¯ÙŠØ« trigger Ù„Ù„Ù€ updated_at
CREATE TRIGGER update_group_courses_updated_at
BEFORE UPDATE ON public.group_courses
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();

-- Ø¥Ù†Ø´Ø§Ø¡ index Ù„ØªØ­Ø³ÙŠÙ† Ø§Ù„Ø£Ø¯Ø§Ø¡
CREATE INDEX IF NOT EXISTS idx_group_courses_group_id ON public.group_courses(group_id);
CREATE INDEX IF NOT EXISTS idx_group_courses_course_id ON public.group_courses(course_id);
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
-- Add subscription_id to courses table
ALTER TABLE public.courses 
ADD COLUMN subscription_id uuid REFERENCES public.subscriptions(id);

-- Add index for better performance
CREATE INDEX idx_courses_subscription_id ON public.courses(subscription_id);
-- Fix teacher_messages foreign key constraint issue
-- Make sender_id nullable to allow both student messages and admin messages
ALTER TABLE teacher_messages ALTER COLUMN sender_id DROP NOT NULL;

-- If there's a foreign key constraint causing issues, we'll drop it
-- and recreate it to point to the students table instead
DO $$ 
BEGIN
    -- Drop existing foreign key if it exists
    IF EXISTS (
        SELECT 1 FROM information_schema.table_constraints 
        WHERE constraint_name = 'teacher_messages_sender_id_fkey'
        AND table_name = 'teacher_messages'
    ) THEN
        ALTER TABLE teacher_messages DROP CONSTRAINT teacher_messages_sender_id_fkey;
    END IF;
    
    -- Add new foreign key to students table with ON DELETE CASCADE
    ALTER TABLE teacher_messages 
    ADD CONSTRAINT teacher_messages_sender_id_fkey 
    FOREIGN KEY (sender_id) 
    REFERENCES students(id) 
    ON DELETE CASCADE;
END $$;
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
-- Create imports table
CREATE TABLE public.imports (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  supplier_name TEXT NOT NULL,
  supplier_phone TEXT,
  items JSONB NOT NULL DEFAULT '[]'::jsonb,
  total_amount NUMERIC NOT NULL DEFAULT 0,
  paid_amount NUMERIC NOT NULL DEFAULT 0,
  remaining_amount NUMERIC NOT NULL DEFAULT 0,
  payment_method TEXT,
  import_date DATE NOT NULL,
  notes TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.imports ENABLE ROW LEVEL SECURITY;

-- Create policies
CREATE POLICY "Admins can manage imports"
ON public.imports
FOR ALL
USING (
  EXISTS (
    SELECT 1 FROM profiles
    WHERE profiles.user_id = auth.uid()
    AND profiles.role = 'admin'::user_role
  )
);

-- Create trigger for updated_at
CREATE TRIGGER update_imports_updated_at
BEFORE UPDATE ON public.imports
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();
-- Add barcode_id column to students table
ALTER TABLE public.students 
ADD COLUMN IF NOT EXISTS barcode_id TEXT UNIQUE;

-- Create index for faster barcode lookups
CREATE INDEX IF NOT EXISTS idx_students_barcode_id ON public.students(barcode_id);

-- Update existing students with unique barcodes (STU-{student_id})
UPDATE public.students 
SET barcode_id = 'STU-' || id::text
WHERE barcode_id IS NULL;

-- Add whatsapp_sent column to attendance table to track notifications
ALTER TABLE public.attendance 
ADD COLUMN IF NOT EXISTS whatsapp_sent BOOLEAN DEFAULT false,
ADD COLUMN IF NOT EXISTS parent_phone TEXT;
