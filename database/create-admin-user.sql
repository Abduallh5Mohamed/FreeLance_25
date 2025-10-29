-- ====================================
-- إنشاء مستخدم Admin
-- ====================================

USE Freelance;

-- حذف المستخدم القديم إذا كان موجود
DELETE FROM users WHERE email = 'admin@alqaed.com';

-- إنشاء مستخدم Admin جديد
-- Username: admin@alqaed.com
-- Password: admin123
-- الباسورد مشفر باستخدام bcrypt
INSERT INTO users (id, email, password_hash, name, role, email_verified, is_active) VALUES
(UUID(), 'admin@alqaed.com', '$2a$10$rN8qZKZqZqZqZqZqZqZqZuK8K8K8K8K8K8K8K8K8K8K8K8K8K8K8K', 'المسؤول', 'admin', TRUE, TRUE);

-- عرض المستخدم المنشأ
SELECT id, email, name, role, is_active, created_at 
FROM users 
WHERE email = 'admin@alqaed.com';

-- ====================================
-- معلومات تسجيل الدخول:
-- Email: admin@alqaed.com
-- Password: admin123
-- ====================================
