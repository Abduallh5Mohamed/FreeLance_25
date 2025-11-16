# 🚀 البدء السريع - 5 دقائق

## الخطوات الأساسية فقط:

### 1. رفع الملفات
- `public_html/*` → ارفع لـ public_html في Hostinger
- `api/*` → ارفع لمجلد api في الـ root

### 2. قاعدة البيانات
```
1. أنشئ MySQL database
2. أنشئ user واربطه بـ database
3. استورد: database/mysql-schema.sql
```

### 3. ملف .env
عدّل `api/.env`:
```env
DB_USER=u123456_user        # من Hostinger
DB_PASSWORD=your_password
DB_NAME=u123456_database
JWT_SECRET=random_string_here
SESSION_SECRET=random_string_here
```

### 4. تثبيت المكتبات
```bash
ssh u123456@yourdomain.com
cd ~/api
npm install --production
```

### 5. تشغيل التطبيق
```bash
pm2 start index.js --name api
pm2 save
```

## تسجيل الدخول:
- **Phone**: 01024083057
- **Password**: Mtd#mora55

✅ **خلصنا!** افتح https://yourdomain.com

---

📖 للتفاصيل الكاملة: اقرأ `دليل_الرفع_الكامل.md`
