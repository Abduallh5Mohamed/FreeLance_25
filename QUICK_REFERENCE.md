# ⚡ أوامر سريعة لتشغيل النظام

## 🚀 البدء السريع

### الخطوة 1: تثبيت البرامج المطلوبة
```bash
# Frontend
npm install

# Backend
cd server
npm install
```

### الخطوة 2: تشغيل MySQL
```bash
# Windows - إذا كان MySQL مثبت
net start MySQL80  # أو إصدارك من MySQL

# أو استخدم Docker
docker run --name mysql -e MYSQL_ROOT_PASSWORD=password -p 3306:3306 -d mysql:latest
```

### الخطوة 3: تشغيل الخادم الخلفي
```bash
cd server
npm run dev
# ✅ Backend running on http://localhost:3001
```

### الخطوة 4: تشغيل التطبيق الأمامي
```bash
# في نافذة terminal جديدة
npm run dev
# ✅ Frontend running on http://localhost:8082 (أو port آخر)
```

---

## 🔗 الروابط المهمة

| الرابط | الوصف |
|-------|-------|
| `http://localhost:3001/api/students` | قائمة الطلاب |
| `http://localhost:3001/api/attendance` | سجل الحضور |
| `http://localhost:8082/student-barcodes` | إدارة الباركودات |
| `http://localhost:8082/barcode-attendance` | تسجيل الحضور |

---

## 🧪 أوامر الاختبار

### اختبار الـ API
```bash
# جلب الطلاب
curl http://localhost:3001/api/students

# إنشاء حضور
curl -X POST http://localhost:3001/api/attendance \
  -H "Content-Type: application/json" \
  -d '{"student_id": "STU001", "attendance_date": "2024-12-06"}'
```

### اختبار البناء
```bash
# Frontend build
npm run build

# Backend build
cd server
npm run build
npm start
```

---

## 📊 قواعد البيانات

### جداول مطلوبة في MySQL
```sql
-- إذا كانت الجداول غير موجودة، أنشئها:

CREATE TABLE IF NOT EXISTS students (
    id VARCHAR(36) PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    email VARCHAR(255),
    phone VARCHAR(20),
    grade VARCHAR(100),
    grade_id VARCHAR(36),
    group_id VARCHAR(36),
    barcode VARCHAR(50),
    is_offline BOOLEAN DEFAULT FALSE,
    approval_status ENUM('pending', 'approved', 'rejected') DEFAULT 'approved',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS attendance_records (
    id VARCHAR(36) PRIMARY KEY,
    student_id VARCHAR(36) NOT NULL,
    attendance_date DATE NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE,
    UNIQUE KEY unique_attendance (student_id, attendance_date)
);

-- إضافة أسطر تجريبية
INSERT INTO students (id, name, email, grade, barcode) VALUES
('STU001', 'محمد أحمد', 'student1@example.com', 'الثالث الثانوي', NULL),
('STU002', 'فاطمة علي', 'student2@example.com', 'الثالث الثانوي', NULL),
('STU003', 'حسن محمود', 'student3@example.com', 'الثالث الثانوي', NULL);
```

---

## 🔍 استكشاف الأخطاء

### الخادم لا يبدأ
```bash
# تحقق من المنافذ المستخدمة
netstat -ano | findstr :3001

# قتل العملية القديمة (Windows)
taskkill /PID <PID> /F

# أو تغيير المنفذ في .env
PORT=3002
```

### قاعدة البيانات غير متصلة
```bash
# تحقق من MySQL
netstat -ano | findstr :3306

# أو أعد تشغيل MySQL
net stop MySQL80
net start MySQL80
```

### الـ Frontend لا يرى الـ Backend
```bash
# تحقق من CORS في server
# في src/index.ts يجب أن يكون:
app.use(cors());

# أو محدد الأصول:
app.use(cors({ origin: 'http://localhost:8082' }));
```

---

## 📋 قائمة الفحص

قبل الإطلاق:
- [ ] MySQL يعمل
- [ ] Backend يعمل على 3001
- [ ] Frontend يعمل على 8082
- [ ] الجداول موجودة
- [ ] بيانات تجريبية موجودة
- [ ] لا توجد أخطاء في Console
- [ ] Network requests تعمل

---

## 🎯 أوامر مفيدة

### تنظيف البيانات
```bash
# مسح جميع البارکودات
UPDATE students SET barcode = NULL;

# مسح سجل الحضور لهذا اليوم
DELETE FROM attendance_records WHERE attendance_date = CURDATE();
```

### حفظ البيانات
```bash
# Backup قاعدة البيانات
mysqldump -u root -p database_name > backup.sql

# استعادة البيانات
mysql -u root -p database_name < backup.sql
```

### مراقبة الأداء
```bash
# فحص حجم الجداول
SELECT table_name, ROUND(((data_length + index_length) / 1024 / 1024), 2) AS size_mb
FROM information_schema.tables
WHERE table_schema = 'database_name';

# عدد الطلاب
SELECT COUNT(*) FROM students;

# عدد الحضور اليوم
SELECT COUNT(*) FROM attendance_records WHERE attendance_date = CURDATE();
```

---

## 🔐 أمان الكود

### متغيرات البيئة (.env)
```bash
# Backend .env
PORT=3001
DB_HOST=localhost
DB_USER=root
DB_PASSWORD=your_password
DB_NAME=database_name
JWT_SECRET=your_secret_key

# Frontend .env
VITE_API_URL=http://localhost:3001/api
```

### لا تنسى
- ❌ لا تضع كلمات المرور في الكود
- ❌ لا تنشر ملفات .env
- ✅ استخدم متغيرات البيئة
- ✅ قيّم الإدخال دائماً

---

## 📚 موارد إضافية

### التوثيق
- [Express Docs](https://expressjs.com/)
- [React Docs](https://react.dev/)
- [TypeScript Docs](https://www.typescriptlang.org/)
- [MySQL Docs](https://dev.mysql.com/doc/)

### أدوات مفيدة
- **Postman** - اختبار API
- **DBeaver** - إدارة قاعدة البيانات
- **DevTools** - تطوير الـ Frontend
- **VS Code** - محرر الأكواد

---

## 🎓 الخطوات التالية

1. ✅ شغّل النظام بالكامل
2. ✅ اختبر إنشاء الباركودات
3. ✅ اختبر تسجيل الحضور
4. ✅ تحقق من البيانات في Database
5. 📝 وثّق أي مشاكل
6. 🚀 اطلب ميزات جديدة

---

## 💬 نصائح وحيل

### تسريع التطوير
```bash
# استخدم npm scripts
npm run dev          # تطوير
npm run build        # بناء
npm run preview      # معاينة الإنتاج
npm run lint         # فحص الأخطاء
```

### تصحيح الأخطاء
```typescript
// أضف console.log للتصحيح
console.log('Students:', students);
console.log('Error:', error);

// استخدم debugger
debugger; // سيتوقف البرنامج عند هذا السطر
```

### تحسين الأداء
```typescript
// استخدم React.memo
const StudentRow = React.memo(({ student }) => ...);

// استخدم useCallback
const handleClick = useCallback(() => {...}, []);

// استخدم useMemo
const filtered = useMemo(() => students.filter(...), [students]);
```

---

## 📞 طلب الدعم

إذا احتجت للمساعدة:
1. افتح ملف GitHub issue
2. اذكر الخطأ بالتفصيل
3. أرفق screenshot
4. أرفق Network logs

---

**استمتع بالتطوير! 🚀**
