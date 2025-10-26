-- إزالة القيد القديم على subject إذا كان موجود
ALTER TABLE public.courses 
DROP CONSTRAINT IF EXISTS courses_subject_check;

-- السماح بأي قيمة في حقل subject
-- لا نحتاج إلى إضافة قيد جديد، فقط نترك الحقل حر