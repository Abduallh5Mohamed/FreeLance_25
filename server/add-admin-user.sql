-- إضافة مستخدم أدمن جديد
-- رقم الهاتف: 01000000000
-- كلمة المرور: admin123
-- كلمة المرور المشفرة باستخدام bcrypt (10 rounds)

INSERT INTO users (phone, password_hash, name, role, is_active, created_at, updated_at)
VALUES (
    '01000000000',
    '$2a$10$YQ98P1vdVP6AH8H5Zx5xHOKJ5xGxJ5xGxJ5xGxJ5xGxJ5xGxJ5xGxO',
    'Admin User',
    'admin',
    TRUE,
    NOW(),
    NOW()
);
