# Dashboard Integration Guide - منصة القائد

## ✅ التكامل الكامل للمعلم و الطالب

### 1️⃣ صفحة المعلم (`/teacher`)

#### المتطلبات:
- يجب أن يكون المستخدم مسجل دخول مع دور `admin` أو `teacher`
- البيانات تُجلب من MySQL Backend

#### البيانات المعروضة:
- ✅ **إجمالي الطلاب**: يُحسب من جدول `students` 
- ✅ **الكورسات النشطة**: يُحسب من جدول `courses`
- ✅ **المحتوى التعليمي**: يُحسب من جدول `course_materials`
- ✅ **معدل الحضور**: قابل للتوسع (يحتاج API جديدة)

#### API Endpoints المستخدمة:
```
GET /api/students              - جلب جميع الطلاب
GET /api/courses               - جلب جميع الكورسات
GET /api/materials             - جلب جميع المحتوى التعليمي
```

#### الكود الأساسي:
```typescript
// التحقق من التفويض
const userStr = localStorage.getItem('currentUser');
const user = JSON.parse(userStr) as User;
if (user.role !== 'admin' && user.role !== 'teacher') {
  navigate('/auth');
}

// جلب البيانات
const students = await getStudents();
const courses = await getCourses();
const materials = await getMaterials();
```

---

### 2️⃣ صفحة الطالب (`/student`)

#### المتطلبات:
- يجب أن يكون المستخدم مسجل دخول مع دور `student`
- الطالب يجب أن يكون معتمد (`approval_status = 'approved'`)
- البيانات تُجلب من MySQL Backend

#### البيانات المعروضة:
- ✅ **معلومات الطالب الشخصية**: من `students` table
- ✅ **الكورسات المسجلة**: من `courses` table
- ✅ **مجموعة الطالب**: من `groups` table  
- ✅ **المحتوى التعليمي**: من `course_materials` table

#### API Endpoints المستخدمة:
```
GET /api/students              - جلب بيانات الطالب
GET /api/courses               - جلب الكورسات المتاحة
GET /api/groups                - جلب المجموعات
GET /api/materials             - جلب المحتوى التعليمي
```

#### الكود الأساسي:
```typescript
// التحقق من التفويض
const userStr = localStorage.getItem('currentUser');
const user = JSON.parse(userStr) as User;
if (user.role !== 'student') {
  navigate('/auth');
}

// جلب بيانات الطالب
const students = await getStudents();
const student = students?.find(s => s.id === user.id);

// جلب الكورسات والمحتوى
const courses = await getCourses();
const materials = await getMaterials();
const groups = await getGroups();
```

---

## 🔐 نظام التفويض

### localStorage Structure:
```json
{
  "currentUser": {
    "id": "uuid",
    "name": "اسم المستخدم",
    "email": "email@example.com",
    "phone": "201234567890",
    "role": "student|teacher|admin",
    "is_active": true
  },
  "currentStudent": {
    "id": "uuid",
    "name": "اسم الطالب",
    "phone": "201234567890",
    "grade": "الصف الثاني الثانوي",
    "grade_id": "uuid",
    "group_id": "uuid",
    "approval_status": "approved|pending|rejected"
  },
  "authToken": "jwt-token-here"
}
```

---

## 🔗 Backend API الضرورية

### طلب إضافة (اختياري):

#### 1. معدل الحضور اليوم:
```
GET /api/attendance?date=YYYY-MM-DD
```

#### 2. الاختبارات النشطة:
```
GET /api/exams?status=active
```

#### 3. الرسائل/الإخطارات:
```
GET /api/messages
```

---

## ✅ قائمة التحقق

- [x] تصفية المستخدمين غير المخول لهم
- [x] جلب بيانات الطلاب من البيانات الحقيقية
- [x] جلب بيانات الكورسات من البيانات الحقيقية
- [x] جلب المحتوى التعليمي من البيانات الحقيقية
- [x] عرض اسم المستخدم الفعلي
- [x] معالجة الأخطاء بشكل صحيح
- [x] إعادة التوجيه للـ login عند الحاجة

---

## 🚀 كيفية الاختبار

### 1️⃣ اختبار المعلم:
```bash
1. اذهب إلى http://localhost:8081/teacher
2. يجب أن ترى صفحة login (إذا لم تكن مسجل دخول)
3. سجل دخول بحساب معلم:
   - البريد: teacher@qaed.com
   - كلمة المرور: teacher123
4. ستظهر لوحة التحكم مع الإحصائيات الحقيقية
```

### 2️⃣ اختبار الطالب:
```bash
1. اذهب إلى http://localhost:8081/student
2. يجب أن ترى صفحة login (إذا لم تكن مسجل دخول)
3. سجل دخول بحساب طالب معتمد:
   - الهاتف: 01234567890
   - كلمة المرور: student123
4. ستظهر لوحة التحكم مع الكورسات والمحتوى الحقيقي
```

---

## 📊 مصادر البيانات

| الصفحة | المصدر | الجدول | الحقول |
|--------|-------|---------|--------|
| Teacher | MySQL | `students` | id, name, phone, grade |
| Teacher | MySQL | `courses` | id, name, subject, description |
| Teacher | MySQL | `course_materials` | id, title, material_type |
| Student | MySQL | `students` | id, name, phone, grade, group_id |
| Student | MySQL | `courses` | id, name, subject, description |
| Student | MySQL | `groups` | id, name, description |
| Student | MySQL | `course_materials` | id, title, file_url |

---

## 🐛 معالجة الأخطاء

### الأخطاء الشائعة:

1. **"غير مسموح"** - لم تكن مسجل دخول أو الدور غير مناسب
2. **"حدث خطأ في تحميل البيانات"** - مشكلة في الـ backend أو قاعدة البيانات
3. **"لم يتم العثور على بيانات الطالب"** - الطالب غير موجود في النظام

---

## 🔄 تدفق المصادقة

```
1. تسجيل الدخول → Auth.tsx
2. إنشاء JWT Token → Backend
3. حفظ في localStorage → currentUser, authToken
4. الوصول إلى Dashboard → التحقق من دور المستخدم
5. جلب البيانات → API requests مع Authorization header
```

---

## 📝 ملاحظات هامة

- جميع الـ API requests تتضمن `Authorization: Bearer {token}` header
- الـ DISABLE_AUTH_DEV flag في `api-http.ts` مُعطل الآن (من الأفضل تفعيله للتطوير)
- الـ localStorage يُستخدم لتخزين بيانات الجلسة (لا تخزن كلمات المرور)
- جميع الـ timestamps بصيغة ISO 8601

---

## ✨ الميزات القادمة

- [ ] جلب معدل الحضور اليومي
- [ ] عرض الاختبارات النشطة
- [ ] نظام الرسائل المباشرة
- [ ] التنبيهات والإخطارات
- [ ] تقارير الأداء الأكاديمي
