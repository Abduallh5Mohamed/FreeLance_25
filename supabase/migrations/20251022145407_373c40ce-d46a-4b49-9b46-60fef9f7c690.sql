-- تحديث RLS policy على جدول course_materials لتسمح للمستخدمين المصادق عليهم بإضافة المحتوى
DROP POLICY IF EXISTS "Admins can manage course materials" ON public.course_materials;

-- إنشاء policy جديدة تسمح للمستخدمين المصادق عليهم بإضافة وحذف وتحديث المحتوى
CREATE POLICY "Authenticated users can manage course materials"
ON public.course_materials
FOR ALL
TO authenticated
USING (true)
WITH CHECK (true);

-- تحديث RLS policy على جدول material_groups لتسمح للمستخدمين المصادق عليهم بالإدارة
DROP POLICY IF EXISTS "Admins can manage material groups" ON public.material_groups;

CREATE POLICY "Authenticated users can manage material groups"
ON public.material_groups
FOR ALL
TO authenticated
USING (true)
WITH CHECK (true);