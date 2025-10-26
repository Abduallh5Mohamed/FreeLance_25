-- حذف الـ policy القديمة وإنشاء واحدة جديدة تعمل بشكل صحيح
DROP POLICY IF EXISTS "Authenticated users can upload course materials" ON storage.objects;

-- إنشاء policy جديدة للرفع باستخدام auth.uid() بدلاً من auth.role()
CREATE POLICY "Authenticated users can upload course materials"
ON storage.objects
FOR INSERT
TO authenticated
WITH CHECK (
  bucket_id = 'course-materials' 
  AND auth.uid() IS NOT NULL
);

-- تحديث policy الحذف
DROP POLICY IF EXISTS "Teachers can delete course materials" ON storage.objects;
CREATE POLICY "Authenticated users can delete course materials"
ON storage.objects
FOR DELETE
TO authenticated
USING (
  bucket_id = 'course-materials' 
  AND auth.uid() IS NOT NULL
);

-- تحديث policy التحديث
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