# 🔧 دليل حل مشاكل الصفحات

## ❌ المشاكل التي واجهتها:

### 1. URL الخطأ ❌
```
❌ http://localhost:8080/student-lectures
❌ http://localhost:8080/student-content
❌ http://localhost:8080/student-exams
❌ http://localhost:8080/teacher-lectures
❌ http://localhost:8080/teacher-exams
```

### السبب:
**Port 8080 محتل** - الـ Frontend بشتغل على **Port 8081**

---

## ✅ الحل الصحيح:

### استخدم URL الصحيح:
```
✅ http://localhost:8081/student-lectures
✅ http://localhost:8081/student-content
✅ http://localhost:8081/student-exams
✅ http://localhost:8081/teacher-lectures
✅ http://localhost:8081/teacher-exams
```

---

## 🔐 تدفق تسجيل الدخول:

### 1. اذهب إلى صفحة تسجيل الدخول:
```
http://localhost:8081/auth
```

### 2. اختر الدور:
- **معلم/إدارة:** استخدم teacher/admin credentials
- **طالب:** استخدم student credentials

### 3. بعد التسجيل الناجح:
```
Teacher/Admin  → http://localhost:8081/teacher
               → http://localhost:8081/teacher-lectures
               → http://localhost:8081/teacher-exams

Student        → http://localhost:8081/student
               → http://localhost:8081/student-lectures
               → http://localhost:8081/student-content
               → http://localhost:8081/student-exams
```

---

## 🎯 سبب إعادة التوجيه إلى Auth:

### إذا كنت بدون تسجيل دخول:
جميع الصفحات المحمية **تفتش على `currentUser` في localStorage**

```javascript
const userStr = localStorage.getItem('currentUser');
if (!userStr) {
  navigate('/auth');  // ← إعادة توجيه
}
```

### الحل:
**تسجيل دخول أولاً** → ثم الوصول للصفحات

---

## 📊 جدول التحقق:

| الصفحة | URL الصحيح | الفحص المطلوب |
|-------|-----------|------------|
| StudentLectures | :8081/student-lectures | logged in as student ✅ |
| StudentContent | :8081/student-content | logged in as student ✅ |
| StudentExams | :8081/student-exams | logged in as student ✅ |
| TeacherLectures | :8081/teacher-lectures | logged in as teacher ✅ |
| TeacherExams | :8081/teacher-exams | logged in as teacher ✅ |

---

## 🚀 الخطوات الصحيحة:

### الخطوة 1: ابدأ الخوادم
```bash
# Terminal 1 - Backend
cd server
npm run dev
# ✅ Server running on http://localhost:3001

# Terminal 2 - Frontend
cd ../
npm start
# ✅ Frontend running on http://localhost:8081
```

### الخطوة 2: افتح المتصفح
```
http://localhost:8081/auth
```

### الخطوة 3: سجل دخول
```
Username: phone number
Password: password
Role: teacher or student
```

### الخطوة 4: اختبر الصفحات
```
✅ http://localhost:8081/teacher-lectures
✅ http://localhost:8081/teacher-exams
✅ http://localhost:8081/student-lectures
✅ http://localhost:8081/student-content
✅ http://localhost:8081/student-exams
```

---

## 📌 النقاط المهمة:

✅ **PORT 8081** - Frontend (not 8080)
✅ **PORT 3001** - Backend API
✅ **localStorage** - يحفظ `currentUser` عند تسجيل الدخول
✅ **كل صفحة محمية** - تفتش على `currentUser`
✅ **بدون تسجيل دخول** - إعادة توجيه آلية إلى `/auth`

---

## 🆘 إذا استمرت المشكلة:

### 1. افتح Developer Tools (F12)
   - انظر للـ Console للأخطاء
   - تحقق من localStorage بـ `currentUser`

### 2. تحقق من Network
   - تأكد من أن API calls تعمل
   - تحقق من Status 200 OK

### 3. حاول Clear Cache
   - Ctrl + Shift + Delete
   - امسح Cookies و Cache

### 4. أعد تشغيل الخوادم
```bash
npm start  # Frontend
npm run dev  # Backend (في terminal منفصل)
```

---

## ✨ الآن يجب أن تعمل جميع الصفحات!

**استخدم Port 8081 وسجل دخول أولاً** ✅
