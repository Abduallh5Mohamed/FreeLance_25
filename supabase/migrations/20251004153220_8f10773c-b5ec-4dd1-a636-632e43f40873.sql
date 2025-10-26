-- Step 1: Add 'student' value to user_role enum
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'student' AND enumtypid = 'user_role'::regtype) THEN
        ALTER TYPE public.user_role ADD VALUE 'student';
    END IF;
END$$;