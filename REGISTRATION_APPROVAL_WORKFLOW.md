# Registration Approval Workflow Documentation

تم ربط صفحة طلبات التسجيل بالـ Backend والـ Database لتمكين الإدارة من قبول أو رفض طلبات التسجيل الجديدة.

## 📋 ملخص التعديلات

### 1. Backend Routes (server/src/routes/registration-requests.ts)
تم إنشاء ملف جديد للتعامل مع طلبات التسجيل:

#### Endpoints المتاحة:

- **POST /api/registration-requests**
  - إنشاء طلب تسجيل جديد
  - لا يتطلب authentication
  - يتحقق من عدم تكرار رقم الهاتف
  - يحفظ الباسورد كـ hash
  - يحفظ الطلب بحالة `pending`

- **GET /api/registration-requests**
  - جلب جميع طلبات التسجيل (admin only)
  - يمكن الفلترة حسب الحالة: `?status=pending`
  - يعرض بيانات الصف والمجموعة من خلال JOIN

- **POST /api/registration-requests/:id/approve**
  - قبول طلب التسجيل (admin only)
  - ينشئ حساب المستخدم في جدول `users`
  - ينشئ سجل الطالب في جدول `students`
  - إذا كان هناك كورسات مطلوبة، يضيفها في `student_courses`
  - يحدث حالة الطلب إلى `approved`
  - يستخدم Transaction للتأكد من تنفيذ جميع العمليات

- **POST /api/registration-requests/:id/reject**
  - رفض طلب التسجيل (admin only)
  - يحدث حالة الطلب إلى `rejected`
  - يحفظ سبب الرفض

### 2. Frontend API Client (src/lib/api-http.ts)

#### Interfaces الجديدة:
```typescript
export interface RegistrationRequest {
    id: string;
    name: string;
    phone: string;
    email?: string | null;
    password_hash?: string;
    grade_id?: string | null;
    group_id?: string | null;
    requested_courses?: string | null;
    status: 'pending' | 'approved' | 'rejected';
    rejection_reason?: string | null;
    created_at?: string;
    updated_at?: string;
    grade_name?: string;
    group_name?: string;
}
```

#### Functions الجديدة:
- `createRegistrationRequest()` - إنشاء طلب تسجيل
- `getRegistrationRequests()` - جلب الطلبات (مع فلترة اختيارية)
- `approveRegistrationRequest()` - قبول طلب
- `rejectRegistrationRequest()` - رفض طلب مع سبب

### 3. Auth Page (src/pages/Auth.tsx)

#### التعديل الأساسي:
- تم تغيير سلوك التسجيل من إنشاء user مباشرة إلى إنشاء `registration_request`
- عند التسجيل الجديد:
  ```typescript
  const result = await createRegistrationRequest({
    name: name.trim(),
    phone: phone.trim(),
    email: email.trim() || null,
    password,
    grade_id: gradeId,
    group_id: selectedGroup || null,
    requested_courses: selectedCourses.length > 0 ? selectedCourses : undefined,
  });
  ```
- رسالة النجاح تخبر المستخدم أن طلبه قيد المراجعة

### 4. Registration Requests Page (src/pages/StudentRegistrationRequests.tsx)

#### التعديلات:
- استبدال `getStudents()` بـ `getRegistrationRequests()`
- استخدام `approveRegistrationRequest()` بدلاً من `updateStudent()`
- استخدام `rejectRegistrationRequest()` مع سبب الرفض
- عرض البيانات من الـ API مباشرة
- معالجة `requested_courses` كـ JSON string

### 5. Server Configuration (server/src/index.ts)
- تم إضافة route جديد:
  ```typescript
  import registrationRequestsRoutes from './routes/registration-requests';
  app.use('/api/registration-requests', registrationRequestsRoutes);
  ```

## 🔄 سير العمل (Workflow)

### 1. الطالب يسجل حساب جديد:
```
Auth.tsx → createRegistrationRequest() → POST /api/registration-requests
→ INSERT into student_registration_requests (status='pending')
```

### 2. الأدمن يفتح صفحة طلبات التسجيل:
```
StudentRegistrationRequests.tsx → getRegistrationRequests() → GET /api/registration-requests
→ SELECT from student_registration_requests with JOINs
```

### 3. الأدمن يقبل الطلب:
```
approveRegistrationRequest(id) → POST /api/registration-requests/:id/approve
→ BEGIN TRANSACTION
  → INSERT into users (phone, password_hash, name, role='student')
  → INSERT into students (user_id, ...)
  → INSERT into student_courses (if courses requested)
  → UPDATE student_registration_requests SET status='approved'
→ COMMIT
```

### 4. الأدمن يرفض الطلب:
```
rejectRegistrationRequest(id, reason) → POST /api/registration-requests/:id/reject
→ UPDATE student_registration_requests SET status='rejected', rejection_reason=?
```

## 🗄️ Database Schema

الجدول المستخدم: `student_registration_requests`

```sql
CREATE TABLE student_registration_requests (
    id INT PRIMARY KEY AUTO_INCREMENT,
    name VARCHAR(255) NOT NULL,
    phone VARCHAR(50) NOT NULL,
    email VARCHAR(255),
    password_hash VARCHAR(255) NOT NULL,
    grade_id INT,
    group_id INT,
    requested_courses TEXT,
    status ENUM('pending', 'approved', 'rejected') DEFAULT 'pending',
    rejection_reason TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (grade_id) REFERENCES grades(id),
    FOREIGN KEY (group_id) REFERENCES groups(id)
);
```

## 🔐 Authentication & Authorization

- إنشاء طلب التسجيل: **لا يتطلب authentication** (متاح للجميع)
- عرض الطلبات: **يتطلب Admin** (middleware: `authenticateToken` + `requireAdmin`)
- قبول/رفض الطلبات: **يتطلب Admin**

## ✅ الميزات

1. ✅ الطالب يسجل ولا يستطيع الدخول حتى يوافق الأدمن
2. ✅ الأدمن يرى جميع الطلبات في صفحة واحدة
3. ✅ الأدمن يستطيع القبول بضغطة زر واحدة
4. ✅ الأدمن يستطيع الرفض مع كتابة السبب
5. ✅ عند القبول، يتم إنشاء user + student + courses تلقائياً
6. ✅ استخدام Transactions لضمان سلامة البيانات
7. ✅ عرض اسم الصف والمجموعة بدلاً من الـ IDs
8. ✅ تصنيف الطلبات حسب الحالة (pending/approved/rejected)

## 🧪 للاختبار

1. افتح صفحة التسجيل: `http://localhost:8080/auth`
2. سجل حساب جديد بأي بيانات
3. ستظهر رسالة "تم إرسال طلب التسجيل بنجاح"
4. سجل دخول كـ admin
5. افتح صفحة طلبات التسجيل: `http://localhost:8080/registration-requests`
6. ستجد الطلب في قائمة "قيد الانتظار"
7. اضغط "قبول" لإنشاء الحساب
8. أو اضغط "رفض" واكتب سبب الرفض

## 📝 ملاحظات

- الباسورد يحفظ كـ hash باستخدام bcrypt
- عند القبول، يتم نسخ الـ password_hash من الطلب إلى جدول users
- requested_courses يحفظ كـ JSON string في الـ database
- استخدام Transaction في عملية القبول لضمان عدم إنشاء بيانات ناقصة
