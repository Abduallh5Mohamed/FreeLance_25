-- إزالة القيد القديم وإضافة قيد جديد يسمح بالحذف
ALTER TABLE public.groups 
DROP CONSTRAINT IF EXISTS groups_course_id_fkey;

-- إضافة القيد الجديد مع ON DELETE SET NULL
-- هذا يعني عند حذف الكورس، سيتم تعيين course_id = NULL في المجموعات المرتبطة
ALTER TABLE public.groups 
ADD CONSTRAINT groups_course_id_fkey 
FOREIGN KEY (course_id) 
REFERENCES public.courses(id) 
ON DELETE SET NULL;

-- أيضاً نفعل نفس الشيء لجدول student_courses إذا كان موجود
ALTER TABLE IF EXISTS public.student_courses 
DROP CONSTRAINT IF EXISTS student_courses_course_id_fkey;

ALTER TABLE IF EXISTS public.student_courses 
ADD CONSTRAINT student_courses_course_id_fkey 
FOREIGN KEY (course_id) 
REFERENCES public.courses(id) 
ON DELETE CASCADE;