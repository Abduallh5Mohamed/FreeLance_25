-- Update the admin user role with a unique username
UPDATE profiles 
SET role = 'admin', 
    name = 'محمد رمضان',
    username = 'mramadan_admin'
WHERE email = 'mohamed96ramadan1996@gmail.com';