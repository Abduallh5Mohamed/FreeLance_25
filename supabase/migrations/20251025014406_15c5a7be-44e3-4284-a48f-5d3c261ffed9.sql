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