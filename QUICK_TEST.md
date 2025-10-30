# 🧪 اختبار الاتصال السريع

## ✅ تحقق من أن كل شيء يعمل:

### 1️⃣ اختبر Backend Health:
```bash
curl http://localhost:3001/health
```
**النتيجة المتوقعة:**
```json
{
  "status": "ok",
  "timestamp": "2024-10-29T..."
}
```

### 2️⃣ اختبر جلب الطلاب:
```bash
curl http://localhost:3001/api/students
```
**النتيجة المتوقعة:**
```json
[
  {
    "id": "uuid-here",
    "name": "اسم الطالب",
    "phone": "201234567890",
    "grade": "الصف الثاني",
    ...
  },
  ...
]
```

### 3️⃣ اختبر جلب الكورسات:
```bash
curl http://localhost:3001/api/courses
```
**النتيجة المتوقعة:**
```json
[
  {
    "id": "uuid-here",
    "name": "اسم الكورس",
    "subject": "التاريخ",
    "description": "...",
    ...
  },
  ...
]
```

### 4️⃣ اختبر تسجيل الدخول:
```bash
curl -X POST http://localhost:3001/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"phone":"201234567890","password":"password123"}'
```
**النتيجة المتوقعة:**
```json
{
  "user": {
    "id": "uuid",
    "name": "اسم المستخدم",
    "role": "teacher",
    ...
  },
  "token": "eyJ0eXAiOiJKV1QiLCJhbGc..."
}
```

---

## 🌐 اختبر الـ Frontend:

### اختبر Auth Page:
```
رابط: http://localhost:8081/auth
توقع: صفحة login بـ fields للهاتف وكلمة المرور ✅
```

### اختبر Teacher Dashboard:
```
رابط: http://localhost:8081/teacher
توقع 1 (بدون login): إعادة توجيه إلى /auth ✅
توقع 2 (مع login كمعلم): عرض الإحصائيات من DB ✅
```

### اختبر Student Dashboard:
```
رابط: http://localhost:8081/student
توقع 1 (بدون login): إعادة توجيه إلى /auth ✅
توقع 2 (مع login كطالب): عرض معلومات الطالب ✅
```

---

## 🛠️ في حالة حدوث مشاكل:

### Backend لا يرد:
```bash
# تحقق من الـ log
# تأكد من أن port 3001 متاح
lsof -i :3001  # on Mac/Linux
Get-NetTCPConnection -LocalPort 3001  # on Windows

# أعد تشغيل الـ backend
cd server && npm run build && npm start
```

### Frontend يعطي أخطاء:
```bash
# افتح Developer Console (F12)
# اضغط على Console tab
# ابحث عن الأخطاء الحمراء
# اقرأ رسالة الخطأ وابدأ بـ البحث عنها
```

### Database لا تستجيب:
```bash
# تأكد من أن MySQL يعمل
mysql -u root -p

# اختبر الاتصال من الـ backend
curl http://localhost:3001/health
```

---

## ✅ Checklist النهائي:

- [ ] Backend يعمل على 3001
- [ ] Frontend يعمل على 8080/8081
- [ ] MySQL متصل
- [ ] curl لـ /health يرد "ok"
- [ ] curl لـ /api/students يرد البيانات
- [ ] /auth page تحمل بدون أخطاء
- [ ] /teacher page تعيد التوجيه إلى login (عند بدء الجلسة)
- [ ] /student page تعيد التوجيه إلى login (عند بدء الجلسة)
- [ ] Login يعمل بشكل صحيح
- [ ] Dashboard تحمل مع البيانات الحقيقية

---

## 📊 Performance Tips:

- Browsers cache: تأكد من عدم تعطيل caching
- Network tab: استخدمه للبحث عن slow requests
- Console: تحقق من الأخطاء والـ warnings
- Sources tab: استخدمه للـ debugging إذا لزم الأمر

---

**جاهز للاختبار! 🚀**
