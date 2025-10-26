-- Create subscriptions table
CREATE TABLE public.subscriptions (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  name TEXT NOT NULL,
  duration_months INTEGER NOT NULL,
  price NUMERIC NOT NULL DEFAULT 0,
  description TEXT,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.subscriptions ENABLE ROW LEVEL SECURITY;

-- Create policies
CREATE POLICY "Admins can manage subscriptions"
ON public.subscriptions
FOR ALL
USING (EXISTS (
  SELECT 1 FROM profiles 
  WHERE profiles.user_id = auth.uid() 
  AND profiles.role = 'admin'::user_role
));

-- Add subscription_id to students table
ALTER TABLE public.students ADD COLUMN subscription_id UUID REFERENCES public.subscriptions(id);
ALTER TABLE public.students ADD COLUMN subscription_start_date DATE;
ALTER TABLE public.students ADD COLUMN subscription_end_date DATE;
ALTER TABLE public.students ADD COLUMN subscription_price NUMERIC DEFAULT 0;

-- Create storage bucket for course materials if not exists
INSERT INTO storage.buckets (id, name, public) 
VALUES ('course-materials', 'course-materials', true)
ON CONFLICT (id) DO NOTHING;

-- Create storage policies
CREATE POLICY "Public can view course materials"
ON storage.objects FOR SELECT
USING (bucket_id = 'course-materials');

CREATE POLICY "Authenticated users can upload course materials"
ON storage.objects FOR INSERT
WITH CHECK (
  bucket_id = 'course-materials' 
  AND auth.role() = 'authenticated'
);