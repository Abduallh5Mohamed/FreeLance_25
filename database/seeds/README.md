# Database Seeds

## نظرة عامة
هذا المجلد يحتوي على البيانات الأساسية (seeds) التي يتم إضافتها تلقائياً إلى قاعدة البيانات.

## الملفات

### 1. `create-admin.js`
ينشئ يوزر الأدمن الافتراضي تلقائياً.

**بيانات الأدمن:**
- 📱 رقم الهاتف: `01024083057`
- 🔑 كلمة المرور: `Mtd#mora55`
- 👤 الدور: `admin`

### 2. `admin-user.sql`
ملف SQL للمرجع فقط (استخدم create-admin.js بدلاً منه).

---

## كيفية الاستخدام

### تشغيل Seeds يدوياً:

#### من مجلد المشروع الرئيسي:
```bash
node database/seeds/create-admin.js
```

#### من مجلد server:
```bash
cd server
npm run seed
```

### تشغيل تلقائي:
عند تشغيل `npm install` في السيرفر، سيتم إنشاء يوزر الأدمن تلقائياً.

---

## خطوات الـ Deployment

### 1️⃣ على سيرفر جديد:
```bash
# نسخ المشروع
git clone <repository-url>
cd FreeLance_25-1

# تثبيت dependencies والـ seed
cd server
npm install  # سيشغل create-admin.js تلقائياً

# بناء المشروع
npm run build

# تشغيل السيرفر
npm start
```

### 2️⃣ إذا كنت تريد تشغيل Seed منفصل:
```bash
cd server
npm run seed
```

### 3️⃣ باستخدام Docker (إذا كان متوفراً):
```bash
docker-compose up -d
# Seeds ستعمل تلقائياً
```

---

## الأمان ⚠️

### **مهم جداً للـ Production:**

1. **غير كلمة المرور فوراً** بعد أول تسجيل دخول
2. **لا تشارك** بيانات الأدمن مع أي شخص
3. **استخدم HTTPS** في الـ production
4. **فعّل Two-Factor Authentication** إذا أمكن
5. **احذف** ملفات seeds من السيرفر بعد الـ deployment

### توصيات إضافية:
- غيّر الـ `SESSION_SECRET` في ملف `.env`
- استخدم كلمة مرور قوية جداً للـ production
- راقب محاولات تسجيل الدخول الفاشلة

---

## ملاحظات

- ✅ السكريبت يستخدم `ON DUPLICATE KEY UPDATE` فلن يضيف أدمن مكرر
- ✅ إذا كان الأدمن موجود، سيحدث بياناته فقط
- ✅ كلمة المرور يتم hash باستخدام bcrypt (10 rounds)
- ✅ الـ UUID ثابت للأدمن: `b70636cb-b66b-11f0-b501-0a002700000f`

---

## استكشاف الأخطاء

### إذا فشل الـ seed:

1. **تأكد من تشغيل MySQL:**
```bash
mysql -u root -p -e "SELECT 1"
```

2. **تأكد من وجود قاعدة البيانات:**
```bash
mysql -u root -p -e "SHOW DATABASES LIKE 'Freelance'"
```

3. **تأكد من صحة بيانات الاتصال في `.env`:**
```env
DB_HOST=localhost
DB_PORT=3306
DB_USER=root
DB_PASSWORD=123580
DB_NAME=Freelance
```

4. **شغل الـ seed يدوياً:**
```bash
node database/seeds/create-admin.js
```

---

## الدعم

إذا واجهت أي مشكلة، تحقق من:
- Logs السيرفر
- صلاحيات قاعدة البيانات
- اتصال الشبكة بقاعدة البيانات
