# منصة القائد - Al-Qaed Platform

## 📚 نظام إدارة التعليم المتكامل

---

## 🎯 الميزات الرئيسية:

### 👨‍🏫 لوحة المعلم:
- 📊 إحصائيات حقيقية من قاعدة البيانات
- 👥 إدارة الطلاب
- 📖 إدارة الكورسات
- 📄 إدارة المحتوى التعليمي
- 📋 تسجيل الحضور
- 💰 إدارة المصروفات والأرباح
- 📈 التقارير والإحصائيات

### 🎓 لوحة الطالب:
- 📚 عرض الكورسات المسجلة
- 📄 الوصول للمحتوى التعليمي
- 📝 الواجبات والتكليفات
- 📊 النتائج والدرجات
- 💬 الرسائل والإخطارات
- 📅 الجدول الزمني

### 🛡️ نظام الأمان:
- 🔐 مصادقة بـ JWT
- 🔒 تشفير كلمات المرور بـ bcryptjs
- 👥 نظام الأدوار والصلاحيات
- 🚫 حماية من نسخ الشاشة (للطلاب)

---

## 🚀 البدء السريع:

### المتطلبات:
```bash
✅ Node.js (v16+)
✅ npm (v8+)
✅ MySQL (v8+)
```

### التثبيت:

#### 1️⃣ استنساخ المشروع:
```bash
git clone https://github.com/your-repo/FreeLance_25.git
cd FreeLance_25
```

#### 2️⃣ تثبيت البيانات الأساسية:
```bash
npm install
```

#### 3️⃣ إعداد قاعدة البيانات:
```bash
# اختر أحد الخيارات:

# الخيار 1: MySQL Command Line
mysql -u root -p < database/mysql-schema.sql

# الخيار 2: MySQL Workbench
# افتح database/mysql-schema.sql وشغّله
```

#### 4️⃣ تشغيل Backend:
```bash
cd server
npm install
npm run build
npm start
```

**النتيجة المتوقعة:**
```
╔════════════════════════════════════════════════╗
║   🚀 Al-Qaed Backend API Server                ║
║   📡 Server running on: http://localhost:3001  ║
║   🗄️  Database: MySQL (Freelance)              ║
╚════════════════════════════════════════════════╝
```

#### 5️⃣ تشغيل Frontend (في terminal جديد):
```bash
npm run dev
```

**النتيجة المتوقعة:**
```
  VITE v5.4.19  ready in 366 ms
  ➜  Local:   http://localhost:8080/
  ➜  Network: http://192.168.1.10:8080/
```

---

## 📍 الروابط المهمة:

| الصفحة | الرابط |
|--------|--------|
| الصفحة الرئيسية | http://localhost:8080/ |
| تسجيل الدخول | http://localhost:8080/auth |
| لوحة المعلم | http://localhost:8080/teacher |
| لوحة الطالب | http://localhost:8080/student |
| Backend API | http://localhost:3001/api |
| Health Check | http://localhost:3001/health |

---

## 🔗 API Endpoints:

### المصادقة:
```
POST   /api/auth/login             - تسجيل الدخول
POST   /api/auth/register          - التسجيل الجديد
GET    /api/auth/me                - بيانات المستخدم الحالي
```

### الطلاب:
```
GET    /api/students               - جميع الطلاب
GET    /api/students/:id           - طالب معين
GET    /api/students/phone/:phone  - البحث برقم الهاتف
POST   /api/students               - إضافة طالب
PUT    /api/students/:id           - تعديل طالب
DELETE /api/students/:id           - حذف طالب
```

### الكورسات:
```
GET    /api/courses                - جميع الكورسات
GET    /api/courses/:id            - كورس معين
POST   /api/courses                - إنشاء كورس
PUT    /api/courses/:id            - تعديل كورس
DELETE /api/courses/:id            - حذف كورس
```

### المجموعات:
```
GET    /api/groups                 - جميع المجموعات
POST   /api/groups                 - إنشاء مجموعة
PUT    /api/groups/:id             - تعديل مجموعة
DELETE /api/groups/:id             - حذف مجموعة
```

### الصفوف:
```
GET    /api/grades                 - جميع الصفوف
POST   /api/grades                 - إنشاء صف
PUT    /api/grades/:id             - تعديل صف
DELETE /api/grades/:id             - حذف صف
```

### المحتوى التعليمي:
```
GET    /api/materials              - جميع المواد
GET    /api/materials/:id          - مادة معينة
POST   /api/materials              - إضافة مادة
PUT    /api/materials/:id          - تعديل مادة
DELETE /api/materials/:id          - حذف مادة
```

### طلبات التسجيل:
```
GET    /api/registration-requests  - جميع الطلبات
POST   /api/registration-requests  - إنشاء طلب
POST   /api/registration-requests/:id/approve - قبول الطلب
POST   /api/registration-requests/:id/reject  - رفض الطلب
```

---

## 🗂️ هيكل المشروع:

```
FreeLance_25/
├── src/
│   ├── components/          # React Components
│   ├── pages/               # Page Components
│   │   ├── Auth.tsx        # صفحة تسجيل الدخول
│   │   ├── TeacherDashboard.tsx
│   │   ├── StudentDashboard.tsx
│   │   └── ...
│   ├── lib/
│   │   ├── api-http.ts     # HTTP API Client
│   │   └── api.ts          # API Exports
│   ├── hooks/              # Custom React Hooks
│   ├── App.tsx             # Main App Component
│   └── main.tsx            # Entry Point
│
├── server/
│   ├── src/
│   │   ├── routes/         # API Routes
│   │   │   ├── auth.ts
│   │   │   ├── students.ts
│   │   │   ├── courses.ts
│   │   │   └── ...
│   │   ├── db.ts           # Database Connection
│   │   └── index.ts        # Server Entry Point
│   ├── dist/               # Compiled JavaScript
│   └── package.json
│
├── database/
│   └── mysql-schema.sql    # Schema Definition
│
└── docs/                   # Documentation Files
    ├── START_HERE.md
    ├── QUICK_TEST.md
    ├── CONNECTION_SUMMARY.md
    └── ...
```

---

## 👥 نظام الأدوار:

### الأدوار المدعومة:

#### 1️⃣ Student (طالب):
- الوصول إلى `/student`
- عرض الكورسات المسجل فيها
- تحميل الواجبات
- عرض الدرجات
- الرسائل

#### 2️⃣ Teacher (معلم):
- الوصول إلى `/teacher`
- إدارة الطلاب
- إدارة الكورسات
- رفع المحتوى التعليمي
- تسجيل الحضور
- عرض الإحصائيات

#### 3️⃣ Admin (مسؤول):
- الوصول الكامل إلى جميع الصفحات
- إدارة المستخدمين
- إدارة النظام
- التقارير المتقدمة

---

## 🔐 المصادقة والتفويض:

### Login Flow:
```
1. User enters credentials (phone/email + password)
2. Backend validates and returns JWT token
3. Token stored in localStorage
4. Subsequent requests include token in Authorization header
5. Backend validates token for each request
```

### localStorage Structure:
```javascript
{
  "currentUser": {
    "id": "uuid",
    "name": "User Name",
    "email": "user@example.com",
    "phone": "201234567890",
    "role": "student|teacher|admin",
    "is_active": true
  },
  "currentStudent": {
    "id": "uuid",
    "name": "Student Name",
    "phone": "201234567890",
    "grade": "الصف الثاني",
    "approval_status": "approved"
  },
  "authToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
}
```

---

## 🛠️ Technology Stack:

### Frontend:
- **React 18** - UI Framework
- **TypeScript** - Type Safety
- **Vite** - Build Tool
- **Tailwind CSS** - Styling
- **Shadcn UI** - Component Library
- **Framer Motion** - Animations
- **React Router** - Navigation
- **Axios** - HTTP Client

### Backend:
- **Node.js** - Runtime
- **Express.js** - Web Framework
- **TypeScript** - Type Safety
- **mysql2/promise** - Database Driver
- **JWT** - Authentication
- **bcryptjs** - Password Hashing

### Database:
- **MySQL 8+**
- **UUID** Primary Keys
- **Normalized Schema**
- **Proper Indexing**

---

## 📊 Database Schema:

### Main Tables:

#### users
```sql
id (UUID) - Primary Key
email - Email Address
phone - Phone Number (primary login field)
name - Full Name
password_hash - Encrypted Password
role - admin | teacher | student
is_active - Boolean
created_at - Timestamp
updated_at - Timestamp
```

#### students
```sql
id (UUID) - Primary Key
name - Student Name
email - Email
phone - Phone Number
grade - Grade Name
grade_id (FK) - Grade ID
group_id (FK) - Group ID
barcode - Student Barcode
is_offline - Boolean
approval_status - approved | pending | rejected
created_at - Timestamp
```

#### courses
```sql
id (UUID) - Primary Key
name - Course Name
subject - Subject
description - Course Description
grade - Grade Level
price - Course Price
is_active - Boolean
created_at - Timestamp
```

#### materials (course_materials)
```sql
id (UUID) - Primary Key
course_id (FK) - Course ID
title - Material Title
description - Material Description
material_type - pdf | video | presentation | link
file_url - File URL
file_size - File Size
is_published - Boolean
created_at - Timestamp
```

---

## 🐛 Troubleshooting:

### Backend Connection Error:
```
❌ Error: Cannot connect to database
✅ Fix: Ensure MySQL is running on port 3306
```

### Frontend Not Loading:
```
❌ Error: Blank white screen
✅ Fix: 
   1. Press F12 to open Developer Console
   2. Check Console tab for errors
   3. Check Network tab to see API calls
```

### Login Failed:
```
❌ Error: Invalid credentials
✅ Fix:
   1. Check phone number format (must match DB)
   2. Verify password in database
   3. Ensure user account is active (is_active = TRUE)
```

### Slow Performance:
```
❌ Problem: Slow loading times
✅ Solution:
   1. Check Network tab in DevTools
   2. Verify database indexes
   3. Check backend logs for slow queries
```

---

## 📚 المستندات الإضافية:

- `START_HERE.md` - بدء سريع
- `QUICK_TEST.md` - اختبار الاتصالات
- `CONNECTION_SUMMARY.md` - ملخص الاتصالات
- `INTEGRATION_COMPLETE.md` - التكامل الكامل
- `DASHBOARD_INTEGRATION.md` - تفاصيل التكامل
- `DASHBOARD_CONNECTION_COMPLETE.md` - دليل استخدام الـ Dashboards

---

## 🤝 المساهمة:

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit changes (`git commit -m 'Add amazing feature'`)
4. Push to branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

---

## 📄 الترخيص:

هذا المشروع مرخص تحت `MIT License`

---

## 📞 التواصل والدعم:

- 📧 البريد الإلكتروني: support@qaed.com
- 🌐 الموقع: https://qaed.com
- 💬 Slack: qaed-team

---

## 🎉 شكراً لاستخدامك منصة القائد!

**تم تطويره بـ ❤️ من قبل فريق القائد**

---

**آخر تحديث:** 29 أكتوبر 2024 ✅
