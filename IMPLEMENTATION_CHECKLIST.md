# ملخص التطبيق - سير عمل تسجيل الطلاب الأونلاين

## ✅ التحديثات المكتملة

### 1️⃣ Frontend (React)

#### Auth.tsx - صفحة التسجيل/تسجيل الدخول
- ✅ إضافة state `studentType` (online/offline)
- ✅ إضافة أزرار اختيار نوع الطالب (🌐 أونلاين vs 📍 أوفلاين)
- ✅ تمرير `is_offline` إلى API عند الإرسال
- ✅ مسح حقل `studentType` بعد التسجيل الناجح

**المسار:** `src/pages/Auth.tsx`
**المنطق:**
- عند اختيار "أونلاين": `is_offline: false`
- عند اختيار "أوفلاين": `is_offline: true`

#### api-http.ts - دالة API
- ✅ إضافة معامل `is_offline?: boolean` إلى دالة `createRegistrationRequest`
- ✅ تمرير المعامل إلى الـ backend

**المسار:** `src/lib/api-http.ts`

#### StudentRegistrationRequests.tsx - صفحة عرض الطلبات
- ✅ إضافة خاصية `is_offline` إلى Interface `RegistrationRequest`
- ✅ تصفية الطلبات لإظهار الأونلاين فقط (WHERE is_offline = 0)
- ✅ جلب الطلبات المعلقة فقط

**المسار:** `src/pages/StudentRegistrationRequests.tsx`

---

### 2️⃣ Backend (Node.js/Express)

#### registration-requests.ts - API Routes
- ✅ استقبال معامل `is_offline` في POST endpoint
- ✅ حفظ `is_offline` في قاعدة البيانات
- ✅ دعم فلترة `?is_offline=true/false` في GET endpoint
- ✅ دعم فلترة الحالة `?status=pending` في GET endpoint

**المسار:** `server/src/routes/registration-requests.ts`

**Endpoints:**
```
POST /api/registration-requests
  ├── تقبل معامل: is_offline
  └── يحفظ في الـ DB

GET /api/registration-requests?is_offline=false&status=pending
  ├── يرجع الطلبات الأونلاين المعلقة فقط
  └── للعرض على صفحة StudentRegistrationRequests.tsx
```

---

### 3️⃣ قاعدة البيانات

#### جدول: student_registration_requests
- ✅ العمود `is_offline` موجود بالفعل (TINYINT(1) DEFAULT 0)
- ✅ القيمة 0 = أونلاين
- ✅ القيمة 1 = أوفلاين

---

## 🔄 سير العملية الكامل

```
┌─────────────────────────────────────────────────────────────┐
│ 1. الطالب يفتح صفحة التسجيل                               │
│    http://localhost:8080/auth                              │
└────────────────────────┬────────────────────────────────────┘
                         │
┌────────────────────────▼────────────────────────────────────┐
│ 2. اختيار نوع التسجيل:                                    │
│    🌐 أونلاين (is_offline: false)  ← الخيار الافتراضي   │
│    📍 أوفلاين (is_offline: true)   ← قريباً              │
└────────────────────────┬────────────────────────────────────┘
                         │
┌────────────────────────▼────────────────────────────────────┐
│ 3. ملء البيانات المطلوبة:                                 │
│    - اسم الطالب ✓                                         │
│    - رقم الهاتف ✓                                         │
│    - كلمة المرور ✓                                       │
│    - الصف الدراسي ✓                                      │
│    - المجموعة (اختياري)                                  │
│    - الكورسات المسجلة ✓                                  │
└────────────────────────┬────────────────────────────────────┘
                         │
┌────────────────────────▼────────────────────────────────────┐
│ 4. الإرسال                                                 │
│    createRegistrationRequest({                             │
│      ...data,                                              │
│      is_offline: false  // ← تحديد نوع الطالب            │
│    })                                                       │
└────────────────────────┬────────────────────────────────────┘
                         │
┌────────────────────────▼────────────────────────────────────┐
│ 5. API Backend                                              │
│    POST /api/registration-requests                         │
│    └── INSERT INTO student_registration_requests (         │
│        ..., is_offline=0, status='pending', ...)          │
└────────────────────────┬────────────────────────────────────┘
                         │
┌────────────────────────▼────────────────────────────────────┐
│ 6. الرسالة: "تم إرسال طلب التسجيل بنجاح"                 │
│    تحويل إلى صفحة تسجيل الدخول                            │
└────────────────────────┬────────────────────────────────────┘
                         │
┌────────────────────────▼────────────────────────────────────┐
│ 7. الإدارة تفتح صفحة الطلبات                               │
│    http://localhost:8080/registration-requests            │
│                                                             │
│    GET /api/registration-requests                         │
│    ?status=pending&is_offline=false                       │
└────────────────────────┬────────────────────────────────────┘
                         │
┌────────────────────────▼────────────────────────────────────┐
│ 8. عرض الطلب مع المعلومات:                                │
│    - اسم الطالب                                           │
│    - رقم الهاتف                                           │
│    - الصف والمجموعة                                      │
│    - الكورسات المطلوبة                                   │
│    - تاريخ الطلب                                         │
└────────────────────────┬────────────────────────────────────┘
                         │
                    ┌────┴────┐
                    │          │
        ┌───────────▼───┐  ┌───▼──────────┐
        │ اختيار "قبول" │  │ اختيار "رفض"│
        └───────┬───────┘  └───┬──────────┘
                │              │
     ┌──────────▼─────────┐    │
     │ POST /approve     │    │
     │ → إنشاء حساب     │    │
     │ → يظهر في       │    │
     │   /students      │    │
     │ → حالة=approved  │    │
     └──────────────────┘    │
                             │
                   ┌─────────▼──────┐
                   │ POST /reject   │
                   │ مع سبب الرفض   │
                   │ → حالة=rejected│
                   │ → لا حساب      │
                   └────────────────┘
```

---

## 📋 قائمة المتطلبات

### للإدارة:
- [ ] زيارة `http://localhost:8080/registration-requests`
- [ ] عرض جميع طلبات الأونلاين المعلقة
- [ ] الموافقة على الطلبات (إنشاء حساب)
- [ ] رفض الطلبات (مع سبب)

### للطالب:
- [ ] زيارة `http://localhost:8080/auth`
- [ ] اختيار "إنشاء حساب جديد"
- [ ] اختيار "🌐 أونلاين"
- [ ] ملء البيانات
- [ ] انتظار موافقة الإدارة

---

## 🧪 خطوات الاختبار

### 1. اختبار إنشاء طلب تسجيل أونلاين
```bash
curl -X POST http://localhost:3001/api/registration-requests \
  -H "Content-Type: application/json" \
  -d '{
    "name": "أحمد محمد",
    "phone": "01012345678",
    "password": "Password123!",
    "grade_id": "grade-1",
    "group_id": "group-1",
    "requested_courses": ["course-1", "course-2"],
    "is_offline": false
  }'
```

### 2. اختبار جلب الطلبات الأونلاين
```bash
curl -H "Authorization: Bearer $AUTH_TOKEN" \
  "http://localhost:3001/api/registration-requests?is_offline=false&status=pending"
```

### 3. اختبار قبول الطلب
```bash
curl -X POST http://localhost:3001/api/registration-requests/{REQUEST_ID}/approve \
  -H "Authorization: Bearer $AUTH_TOKEN"
```

### 4. اختبار رفض الطلب
```bash
curl -X POST http://localhost:3001/api/registration-requests/{REQUEST_ID}/reject \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $AUTH_TOKEN" \
  -d '{
    "reason": "البيانات غير صحيحة"
  }'
```

---

## 📝 ملاحظات مهمة

1. **الحالات الثلاث للطلب:**
   - `pending` - قيد الانتظار (جديد)
   - `approved` - مقبول (تم إنشاء حساب)
   - `rejected` - مرفوض (لم يتم إنشاء حساب)

2. **التحقق من البيانات:**
   - رقم الهاتف لا يمكن أن يكون مكرر
   - اسم الطالب مطلوب
   - الصف الدراسي مطلوب
   - كلمة المرور لا تقل عن 6 أحرف

3. **الأمان:**
   - كلمات المرور مشفرة باستخدام bcrypt
   - التوكنات تتحقق عند كل طلب API
   - الإدارة فقط يمكنها رؤية الطلبات

---

## 🔗 الملفات المعدلة

### Frontend:
- `src/pages/Auth.tsx` - إضافة عنصر اختيار studentType
- `src/lib/api-http.ts` - إضافة معامل is_offline
- `src/pages/StudentRegistrationRequests.tsx` - تصفية الطلبات الأونلاين

### Backend:
- `server/src/routes/registration-requests.ts` - دعم is_offline في POST و GET

### التوثيق:
- `ONLINE_REGISTRATION_FLOW.md` - التوثيق الشامل
- `IMPLEMENTATION_CHECKLIST.md` - هذا الملف

---

## ✨ الميزات الجديدة

✅ تمييز الطلاب الأونلاين عن الأوفلاين  
✅ تصفية الطلبات حسب النوع  
✅ واجهة مستخدم واضحة لاختيار النوع  
✅ API منفصل للطلبات الأونلاين فقط  
✅ دعم كامل في قاعدة البيانات  

---

## 📅 الخطوات التالية

- [ ] تطبيق نفس السير لطلاب الأوفلاين (الإضافة المباشرة من الإدارة)
- [ ] إضافة تنبيهات للطلاب عند الموافقة/الرفض
- [ ] تحسين واجهة عرض الطلبات
- [ ] إضافة إحصائيات الطلبات

---

تم الإنجاز في: 2025-10-31
