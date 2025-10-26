-- Update the admin user role
UPDATE profiles 
SET role = 'admin', 
    name = 'محمد رمضان',
    username = 'admin'
WHERE email = 'mohamed96ramadan1996@gmail.com';

-- Also ensure we handle students login properly by checking password
-- Update Auth.tsx will handle the logic, but let's make sure the user data is correct