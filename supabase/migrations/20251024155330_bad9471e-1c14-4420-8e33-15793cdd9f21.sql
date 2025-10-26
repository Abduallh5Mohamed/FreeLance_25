-- Add subscription_id to courses table
ALTER TABLE public.courses 
ADD COLUMN subscription_id uuid REFERENCES public.subscriptions(id);

-- Add index for better performance
CREATE INDEX idx_courses_subscription_id ON public.courses(subscription_id);