-- Add explanation column to exam_questions table
ALTER TABLE public.exam_questions 
ADD COLUMN IF NOT EXISTS explanation TEXT;