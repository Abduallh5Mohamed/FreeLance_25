-- تحديث RLS policy لجدول course_materials لإضافة صلاحيات للـ admin
DROP POLICY IF EXISTS "Teachers can manage course materials" ON public.course_materials;

-- إنشاء policy يسمح للـ admin بإدارة المحتوى
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

-- تحديث policy جدول material_groups
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

-- إضافة policy للطلاب لعرض المحتوى الخاص بهم
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