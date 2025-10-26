-- Fix authentication and signup issues

-- 1. Fix user_roles RLS policies to allow trigger to insert roles
DROP POLICY IF EXISTS "Admins can manage all roles" ON public.user_roles;
DROP POLICY IF EXISTS "Allow trigger to insert roles" ON public.user_roles;

-- Allow admins to manage all roles
CREATE POLICY "Admins can manage all roles"
ON public.user_roles
FOR ALL
USING (public.is_admin(auth.uid()))
WITH CHECK (public.is_admin(auth.uid()));

-- CRITICAL: Allow the trigger (running as SECURITY DEFINER) to insert roles
CREATE POLICY "Allow trigger to insert roles"
ON public.user_roles
FOR INSERT
WITH CHECK (true);

-- 2. Update the handle_new_user trigger to be more reliable
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Always try to assign student role if email matches a student record
  IF EXISTS (
    SELECT 1 FROM public.students 
    WHERE email = NEW.email
  ) THEN
    INSERT INTO public.user_roles (user_id, role)
    VALUES (NEW.id, 'student'::user_role)
    ON CONFLICT (user_id, role) DO NOTHING;
  END IF;
  
  RETURN NEW;
EXCEPTION
  WHEN OTHERS THEN
    -- Log error but don't block user creation
    RAISE WARNING 'Error in handle_new_user: %', SQLERRM;
    RETURN NEW;
END;
$$;

-- 3. Create a helper function to setup admin user
-- This function can be called manually after creating an admin user in Supabase Auth
CREATE OR REPLACE FUNCTION public.make_user_admin(admin_email TEXT)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  target_user_id UUID;
BEGIN
  -- Find the user by email
  SELECT id INTO target_user_id
  FROM auth.users
  WHERE email = admin_email;
  
  IF target_user_id IS NULL THEN
    RAISE EXCEPTION 'User with email % not found', admin_email;
  END IF;
  
  -- Insert admin role
  INSERT INTO public.user_roles (user_id, role)
  VALUES (target_user_id, 'admin'::user_role)
  ON CONFLICT (user_id, role) DO NOTHING;
  
  -- Create or update profile if needed
  INSERT INTO public.profiles (user_id, email, role)
  VALUES (target_user_id, admin_email, 'admin'::user_role)
  ON CONFLICT (user_id) 
  DO UPDATE SET role = 'admin'::user_role;
  
  RAISE NOTICE 'Successfully made % an admin', admin_email;
END;
$$;

-- 4. If you have an existing admin email, make them admin
-- Uncomment and replace with actual admin email:
-- SELECT public.make_user_admin('mohamed96ramadan1996@gmail.com');