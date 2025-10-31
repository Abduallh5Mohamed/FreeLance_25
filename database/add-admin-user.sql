USE Freelance;

-- Add new admin user
INSERT INTO users (
    phone_number,
    password_hash,
    full_name,
    role,
    is_active,
    email_verified,
    phone_verified
) VALUES (
    '01024083057',
    '$2b$10$YourHashedPasswordHere',  -- سيتم تحديثه
    'Admin User',
    'admin',
    TRUE,
    TRUE,
    TRUE
);

-- Get the user ID
SELECT id, phone_number, full_name, role FROM users WHERE phone_number = '01024083057';
