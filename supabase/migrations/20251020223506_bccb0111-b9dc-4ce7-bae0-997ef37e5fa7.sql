-- تحديث سياسات RLS لجدول courses لتسمح بالحذف
-- أولاً، نحذف السياسة القديمة إذا كانت موجودة
DROP POLICY IF EXISTS "Teachers can manage courses" ON public.courses;

-- إضافة سياسات جديدة منفصلة لكل عملية
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

-- التأكد من وجود سياسة SELECT للجميع
CREATE POLICY "Anyone can view active courses" 
ON public.courses 
FOR SELECT 
USING (is_active = true);