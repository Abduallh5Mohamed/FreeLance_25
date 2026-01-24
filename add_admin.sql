-- Add Admin User
-- Phone: 01024083057
-- Password: Mtd#mora55 (bcrypt hashed)

INSERT INTO users (id, phone, name, password_hash, role, is_active, phone_verified, created_at, updated_at) 
VALUES (
    UUID(), 
    '01024083057', 
    'مدير النظام', 
    '$2b$10$frrR7FrNuEhZqso6GkALauyAjdQRpAlKT3CNO5YHcM22uOcpjgl12',
    'admin', 
    1, 
    1, 
    NOW(), 
    NOW()
);
