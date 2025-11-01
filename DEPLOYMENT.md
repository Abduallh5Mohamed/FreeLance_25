# 🚀 دليل الـ Deployment - منصة القائد التعليمية

## 📋 المتطلبات

### البرامج المطلوبة:
- ✅ Node.js (v18 أو أحدث)
- ✅ MySQL Server (v8.0 أو أحدث)
- ✅ npm أو yarn
- ✅ Git (اختياري)

---

## 🎯 خطوات الـ Deployment السريع

### الطريقة الأوتوماتيكية (موصى بها):

#### على Windows:
```powershell
.\deploy.ps1
```

#### على Linux/Mac:
```bash
chmod +x deploy.sh
./deploy.sh
```

---

## 📝 خطوات الـ Deployment اليدوي

### 1️⃣ إعداد قاعدة البيانات

```bash
# تسجيل الدخول إلى MySQL
mysql -u root -p

# إنشاء قاعدة البيانات
CREATE DATABASE IF NOT EXISTS Freelance CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

# الخروج
exit
```

### 2️⃣ تثبيت المشروع

```bash
# الانتقال إلى مجلد المشروع
cd FreeLance_25-1

# تثبيت dependencies الـ frontend
npm install

# الانتقال إلى مجلد السيرفر
cd server

# تثبيت dependencies الـ backend
# ⚠️ سيقوم تلقائياً بإنشاء يوزر الأدمن
npm install
```

### 3️⃣ إعداد ملف `.env`

```bash
# نسخ ملف المثال
cp ../.env.example .env

# تعديل الملف بالقيم الصحيحة
# استخدم أي محرر نصوص (nano, vim, notepad)
nano .env
```

**محتوى ملف `.env` المطلوب:**
```env
# MySQL Database
DB_HOST=localhost
DB_PORT=3306
DB_USER=root
DB_PASSWORD=your_mysql_password
DB_NAME=Freelance

# JWT
JWT_SECRET=change_this_to_very_long_random_string_in_production
JWT_EXPIRES_IN=7d

# Application
NODE_ENV=production
PORT=3001
CORS_ORIGIN=http://your-domain.com
```

### 4️⃣ تشغيل Database Migrations

```bash
# تنفيذ جميع الـ migrations
mysql -u root -p Freelance < ../database/migrations/001_create_tables.sql
mysql -u root -p Freelance < ../database/migrations/002_add_features.sql
# ... إلخ (نفذ جميع ملفات الـ migrations بالترتيب)
```

### 5️⃣ إنشاء يوزر الأدمن

```bash
# إذا لم يتم إنشاؤه تلقائياً
cd server
npm run seed
```

**بيانات الأدمن الافتراضية:**
```
📱 الهاتف: 01024083057
🔑 كلمة المرور: Mtd#mora55
👤 الدور: admin
```

### 6️⃣ بناء المشروع

```bash
# في مجلد server
npm run build

# في مجلد frontend (الرئيسي)
cd ..
npm run build
```

### 7️⃣ تشغيل السيرفر

```bash
# Development mode
cd server
npm run dev

# Production mode
npm start
```

---

## 🌐 Deployment على خادم Production

### باستخدام PM2 (موصى به):

```bash
# تثبيت PM2 عالمياً
npm install -g pm2

# الانتقال إلى مجلد السيرفر
cd server

# تشغيل السيرفر مع PM2
pm2 start dist/index.js --name "alqaed-backend"

# حفظ قائمة العمليات
pm2 save

# إعداد التشغيل التلقائي عند إعادة تشغيل السيرفر
pm2 startup
```

### إدارة PM2:

```bash
# عرض حالة العمليات
pm2 status

# عرض اللوجات
pm2 logs alqaed-backend

# إعادة تشغيل
pm2 restart alqaed-backend

# إيقاف
pm2 stop alqaed-backend

# حذف من PM2
pm2 delete alqaed-backend
```

---

## 🔒 الأمان

### ⚠️ مهم جداً للـ Production:

1. **غير كلمة مرور الأدمن فوراً:**
   - سجل دخول كأدمن
   - اذهب إلى الإعدادات
   - غير كلمة المرور إلى كلمة قوية جداً

2. **استخدم HTTPS:**
   - احصل على شهادة SSL (Let's Encrypt مجاني)
   - استخدم Nginx أو Apache كـ reverse proxy

3. **تأمين قاعدة البيانات:**
   ```bash
   mysql_secure_installation
   ```

4. **تحديث الـ Environment Variables:**
   - غير `JWT_SECRET` إلى قيمة عشوائية طويلة جداً
   - غير `SESSION_SECRET`
   - لا تستخدم القيم الافتراضية أبداً!

5. **صلاحيات الملفات:**
   ```bash
   chmod 600 server/.env
   chown www-data:www-data -R .
   ```

---

## 🔧 استكشاف الأخطاء

### المشكلة: "Cannot connect to MySQL"

**الحل:**
```bash
# تأكد من تشغيل MySQL
sudo systemctl status mysql

# تشغيل MySQL
sudo systemctl start mysql

# تحقق من بيانات الاتصال في .env
```

### المشكلة: "Admin user not found"

**الحل:**
```bash
cd server
npm run seed
```

### المشكلة: "Port 3001 already in use"

**الحل:**
```bash
# على Windows
netstat -ano | findstr :3001
taskkill /PID <PID> /F

# على Linux/Mac
lsof -i :3001
kill -9 <PID>
```

### المشكلة: "CORS error"

**الحل:**
- تأكد من تحديث `CORS_ORIGIN` في `.env`
- إذا كان الفرونت إند على نفس النطاق، استخدم:
  ```env
  CORS_ORIGIN=http://localhost:8080
  ```

---

## 📦 النسخ الاحتياطي

### نسخ احتياطي لقاعدة البيانات:

```bash
# إنشاء نسخة احتياطية
mysqldump -u root -p Freelance > backup_$(date +%Y%m%d_%H%M%S).sql

# استعادة النسخة الاحتياطية
mysql -u root -p Freelance < backup_20250102_120000.sql
```

### نسخ احتياطي تلقائي (Cron Job):

```bash
# فتح crontab
crontab -e

# إضافة سطر للنسخ الاحتياطي اليومي الساعة 2 صباحاً
0 2 * * * mysqldump -u root -p'your_password' Freelance > /path/to/backups/backup_$(date +\%Y\%m\%d).sql
```

---

## 🔄 التحديثات

### تحديث الكود:

```bash
# سحب آخر التحديثات
git pull origin main

# تثبيت dependencies الجديدة
cd server
npm install

# بناء المشروع
npm run build

# إعادة تشغيل PM2
pm2 restart alqaed-backend
```

---

## 📞 الدعم

إذا واجهت أي مشكلة:
1. تحقق من logs السيرفر: `pm2 logs alqaed-backend`
2. تحقق من logs قاعدة البيانات
3. تحقق من ملف `.env`
4. تحقق من صلاحيات الملفات

---

## ✅ Checklist قبل Production

- [ ] تم تثبيت جميع البرامج المطلوبة
- [ ] تم إنشاء قاعدة البيانات
- [ ] تم تنفيذ جميع الـ migrations
- [ ] تم تحديث ملف `.env` بالقيم الصحيحة
- [ ] تم تغيير `JWT_SECRET` و `SESSION_SECRET`
- [ ] تم إنشاء يوزر الأدمن
- [ ] تم تغيير كلمة مرور الأدمن
- [ ] تم تفعيل HTTPS
- [ ] تم تأمين قاعدة البيانات
- [ ] تم إعداد النسخ الاحتياطي التلقائي
- [ ] تم اختبار جميع الوظائف
- [ ] تم إعداد PM2 للتشغيل التلقائي

---

**🎉 مبروك! منصتك جاهزة للعمل!**
