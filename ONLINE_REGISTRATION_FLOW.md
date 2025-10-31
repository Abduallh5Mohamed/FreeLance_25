# سير العمل لتسجيل الطلاب الأونلاين

## نظرة عامة
يتم السماح للطلاب الجدد بإنشاء حسابات جديدة من خلال صفحة التسجيل. عند اختيار نوع الطالب **أونلاين**، يتم إرسال طلب تسجيل للمسؤول للمراجعة والموافقة.

## مراحل السير

### 1️⃣ المرحلة الأولى: إنشاء حساب وإرسال طلب تسجيل
**الصفحة:** `http://localhost:8080/auth`

الطالب يقوم بـ:
1. النقر على **"إنشاء حساب جديد"**
2. اختيار **"🌐 أونلاين"** (أو بقاء الخيار الافتراضي على أونلاين)
3. إدخال البيانات التالية:
   - اسم الطالب ✓
   - رقم الهاتف ✓
   - كلمة المرور ✓
   - الصف الدراسي ✓
   - المجموعة (اختياري)
   - الكورسات المسجلة ✓
4. النقر على **"إنشاء حساب جديد"**

**العملية في الخلفية:**
```
Frontend (Auth.tsx)
  ↓
createRegistrationRequest({
  name: "أحمد محمد",
  phone: "01012345678",
  password: "password123",
  grade_id: "grade-1",
  group_id: "group-1",
  requested_courses: ["course-1", "course-2"],
  is_offline: false  ← تحديد أن الطالب أونلاين
})
  ↓
POST /api/registration-requests
  ↓
Backend (registration-requests.ts)
  ↓
INSERT INTO student_registration_requests
  (name, phone, password_hash, grade_id, group_id, 
   requested_courses, status='pending', is_offline=0, ...)
```

**النتيجة:**
- ✅ تظهر رسالة نجاح: "تم إرسال طلب التسجيل بنجاح"
- ✅ يتم إنشاء سجل طلب تسجيل جديد في قاعدة البيانات
- ✅ حالة الطلب = `pending` (قيد الانتظار)
- ✅ يتم إعادة توجيه الطالب إلى صفحة تسجيل الدخول

---

### 2️⃣ المرحلة الثانية: مراجعة ومعالجة الطلبات من الإدارة
**الصفحة:** `http://localhost:8080/registration-requests`

المسؤول يمكنه:
1. عرض جميع طلبات التسجيل الأونلاين المنتظرة
2. رؤية المعلومات التالية لكل طالب:
   - اسم الطالب
   - رقم الهاتف
   - الصف الدراسي
   - المجموعة
   - الكورسات المسجلة
   - تاريخ الطلب

#### ✅ خيار القبول (Approve):
**العملية:**
```
Admin يضغط "قبول"
  ↓
POST /api/registration-requests/{id}/approve
  ↓
Backend يقوم بـ:
1. إنشاء مستخدم (user) جديد:
   INSERT INTO users (phone, password_hash, role='student', ...)
   
2. إنشاء سجل طالب (student):
   INSERT INTO students 
   (user_id, name, phone, grade_id, group_id, is_offline=0, 
    approval_status='approved', ...)
   
3. تسجيل الكورسات:
   INSERT INTO student_courses (student_id, course_id, ...)
   
4. تحديث حالة طلب التسجيل:
   UPDATE student_registration_requests 
   SET status='approved' WHERE id=...
```

**النتيجة:**
- ✅ يتم إنشاء حساب الطالب بنجاح
- ✅ يظهر الطالب في صفحة `/students`
- ✅ يمكن للطالب الآن تسجيل الدخول برقم هاتفه وكلمة المرور
- ✅ يتم نقل الطلب إلى تبويب "مقبول"

#### ❌ خيار الرفض (Reject):
**العملية:**
```
Admin يضغط "رفض" ويدخل سبب الرفض
  ↓
POST /api/registration-requests/{id}/reject
  {
    reason: "البيانات غير صحيحة أو سبب آخر"
  }
  ↓
Backend يقوم بـ:
1. تحديث حالة الطلب:
   UPDATE student_registration_requests 
   SET status='rejected', rejection_reason='سبب الرفض'
   WHERE id=...
   
2. لا يتم إنشاء حساب للطالب
```

**النتيجة:**
- ✅ يتم حفظ سبب الرفض في قاعدة البيانات
- ✅ لا يتم إنشاء حساب للطالب
- ✅ يتم نقل الطلب إلى تبويب "مرفوض"
- ❌ لا يمكن للطالب تسجيل الدخول

---

## قاعدة البيانات

### جدول: `student_registration_requests`
```sql
CREATE TABLE student_registration_requests (
  id VARCHAR(36) PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  phone VARCHAR(20) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  grade_id VARCHAR(36),
  group_id VARCHAR(36),
  requested_courses JSON,
  status ENUM('pending', 'approved', 'rejected') DEFAULT 'pending',
  rejection_reason TEXT,
  is_offline TINYINT(1) DEFAULT 0,  ← 0 = أونلاين، 1 = أوفلاين
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);
```

### جدول: `students`
```sql
CREATE TABLE students (
  id VARCHAR(36) PRIMARY KEY,
  user_id VARCHAR(36),
  name VARCHAR(255),
  phone VARCHAR(20),
  email VARCHAR(255),
  grade_id VARCHAR(36),
  group_id VARCHAR(36),
  is_offline TINYINT(1) DEFAULT 0,  ← يتم نسخ من التسجيل
  approval_status ENUM('pending', 'approved', 'rejected') DEFAULT 'pending',
  approved_by VARCHAR(36),
  approved_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

---

## نقاط مهمة ⚠️

1. **الفرق بين الأونلاين والأوفلاين:**
   - **أونلاين (Online)**: يتم إرسال طلب تسجيل يحتاج إلى موافقة الإدارة
   - **أوفلاين (Offline)**: سيتم تطويره لاحقاً (يضيفه الإدارة مباشرة)

2. **التحقق من البيانات:**
   - يتم التحقق من عدم وجود رقم هاتف مكرر
   - يتم التحقق من أن اسم الطالب موجود
   - يتم التحقق من اختيار الصف الدراسي

3. **حالات الطلب:**
   - `pending`: قيد الانتظار - الطلب جديد
   - `approved`: مقبول - تم إنشاء حساب الطالب
   - `rejected`: مرفوض - لم يتم إنشاء حساب

4. **رسائل الخطأ الشائعة:**
   - "رقم الهاتف مسجل بالفعل" - إذا كان الهاتف موجود
   - "لديك طلب تسجيل قيد المراجعة بالفعل" - إذا كان لديه طلب معلق

---

## API Endpoints

### إنشاء طلب تسجيل جديد
```
POST /api/registration-requests
Content-Type: application/json

{
  "name": "أحمد محمد",
  "phone": "01012345678",
  "password": "password123",
  "grade_id": "grade-id-1",
  "group_id": "group-id-1",
  "requested_courses": ["course-1", "course-2"],
  "is_offline": false
}

Response: 201
{
  "id": "request-id",
  "message": "تم إرسال طلب التسجيل بنجاح"
}
```

### الحصول على طلبات التسجيل
```
GET /api/registration-requests?status=pending&is_offline=false
Authorization: Bearer {token}

Response: 200
[
  {
    "id": "request-id",
    "name": "أحمد محمد",
    "phone": "01012345678",
    "grade_id": "grade-1",
    "grade_name": "السادس الابتدائي",
    "status": "pending",
    "is_offline": 0,
    "created_at": "2025-10-31T10:00:00Z"
  }
]
```

### قبول طلب تسجيل
```
POST /api/registration-requests/{id}/approve
Authorization: Bearer {token}

Response: 201
{
  "user": { ... },
  "student": { ... },
  "message": "تم قبول الطلب وإنشاء حساب الطالب"
}
```

### رفض طلب تسجيل
```
POST /api/registration-requests/{id}/reject
Authorization: Bearer {token}
Content-Type: application/json

{
  "reason": "البيانات غير صحيحة"
}

Response: 200
{
  "message": "تم رفض الطلب"
}
```

---

## خطوات اختبار النظام

### 1. اختبار إنشاء طلب تسجيل
- 🌐 افتح `http://localhost:8080/auth`
- ✏️ اضغط "إنشاء حساب جديد"
- 🎯 اختر "أونلاين"
- 📝 ملأ البيانات
- ✅ اضغط "إنشاء حساب جديد"
- ✓ تحقق من رسالة النجاح

### 2. اختبار مراجعة الطلبات (كمسؤول)
- 🔑 سجل الدخول كمسؤول
- 🔗 افتح `http://localhost:8080/registration-requests`
- 👀 تحقق من ظهور الطلب الجديد
- ✅ اضغط "قبول" أو "رفض"

### 3. اختبار إنشاء الحساب
- 🔑 سجل الدخول برقم الهاتف وكلمة المرور
- 👨‍🎓 يجب أن يظهر الطالب في `/students`
- ✓ تحقق من تسجيل الدخول بنجاح

---

## ملاحظات مهمة
- ✅ جميع البيانات مشفرة (password_hash)
- ✅ جميع الطلبات تحتاج إلى موافقة يدوية من الإدارة
- ✅ لا يتم إنشاء حساب إلا بعد الموافقة
- ✅ الطالب المرفوض لا يمكنه تسجيل الدخول
