# إنشاء حساب Admin

لحل مشكلة `403 Forbidden - Admin access required`، محتاج تسجل دخول بحساب admin.

## الطريقة 1: إنشاء Admin من الـ Database مباشرة

افتح MySQL وشغل الكود ده:

```sql
USE Freelance;

-- Check if admin exists
SELECT * FROM users WHERE role = 'admin';

-- If no admin exists, create one
-- Password will be: admin123 (hashed)
INSERT INTO users (email, phone, password_hash, name, role, is_active, phone_verified, created_at)
VALUES (
    'admin@alqaed.com',
    '01000000000',
    '$2a$10$rOvXvgzqN0gQY6YE3YvJPeKN.X/QcYgB5YHr7yXvE1BNGq8eZJH7m', -- admin123
    'المسؤول',
    'admin',
    1,
    1,
    NOW()
);
```

## الطريقة 2: تحديث مستخدم موجود ليصبح Admin

```sql
USE Freelance;

-- عرض جميع المستخدمين
SELECT id, name, phone, email, role FROM users;

-- تحديث مستخدم معين ليصبح admin (غير رقم 1 برقم المستخدم اللي عايزه)
UPDATE users SET role = 'admin' WHERE id = 1;
```

## الطريقة 3: إنشاء Admin من خلال API

استخدم Postman أو أي HTTP client وأرسل:

**POST** `http://localhost:3001/api/auth/register`

**Body:**
```json
{
    "phone": "01000000000",
    "password": "admin123",
    "name": "المسؤول",
    "role": "admin",
    "email": "admin@alqaed.com"
}
```

ثم سجل دخول:

**POST** `http://localhost:3001/api/auth/login`

**Body:**
```json
{
    "phone": "01000000000",
    "password": "admin123"
}
```

## بعد إنشاء الـ Admin:

1. افتح `http://localhost:8080/auth`
2. سجل دخول برقم الهاتف: `01000000000`
3. كلمة المرور: `admin123`
4. بعد تسجيل الدخول، افتح `http://localhost:8080/registration-requests`
5. المفروض تشوف صفحة طلبات التسجيل بدون أخطاء

## ملاحظة مهمة:

الباسورد المشفر في المثال الأول هو hash لـ `admin123` باستخدام bcrypt.
لو عايز تغير الباسورد، استخدم الطريقة 3 أو 2.
