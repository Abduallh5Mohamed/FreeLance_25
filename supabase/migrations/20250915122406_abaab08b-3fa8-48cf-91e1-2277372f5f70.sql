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
('التاريخ', 'مادة التاريخ - الحضارات والأحداث التاريخية', 'history'),
('الجغرافيا', 'مادة الجغرافيا - الجغرافيا الطبيعية والبشرية', 'geography');

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