-- إضافة عمود صورة السؤال لجدول أسئلة الامتحانات
-- Add question_image column to exam_questions table

ALTER TABLE exam_questions
ADD COLUMN question_image LONGTEXT NULL AFTER question_text;

-- إضافة عمود صورة الإجابة لجدول محاولات الامتحان
-- Add answer_images column to exam_attempts table for storing student answer images
ALTER TABLE exam_attempts
ADD COLUMN answer_images LONGTEXT NULL AFTER answers;
