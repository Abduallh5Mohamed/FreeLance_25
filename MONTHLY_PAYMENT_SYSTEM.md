# نظام الدفع الشهري - Monthly Payment System

## التحديثات المنفذة ✅

### 1. تعديلات قاعدة البيانات (MySQL)

تم إضافة الحقول التالية لجدول `student_fees`:

```sql
- student_id CHAR(36)           -- معرف الطالب (مرتبط بجدول students)
- guardian_phone VARCHAR(50)     -- رقم تلفون ولي الأمر
- payment_year INT               -- سنة الدفع (مثل: 2025)
- payment_month INT              -- شهر الدفع (من 1 إلى 12)
```

#### Index الفريد لمنع التكرار:
```sql
UNIQUE KEY unique_student_month (student_id, payment_year, payment_month)
```

هذا الـ Index يضمن أن:
- **كل طالب لا يمكنه الدفع لنفس الشهر مرتين**
- إذا حاول الطالب الدفع مرة أخرى لنفس الشهر، سيظهر له رسالة: **"تم الدفع مسبقاً"**

### 2. منطق الدفع في الباك-إند

#### في ملف `server/src/routes/fees.ts`:

**قبل إضافة دفعة جديدة:**
```typescript
// فحص إذا كان الطالب دفع هذا الشهر
const existingPayment = await queryOne<Fee>(
    `SELECT * FROM student_fees 
     WHERE student_id = ? AND payment_year = ? AND payment_month = ? AND status = 'paid'`,
    [resolvedStudentId, finalPaymentYear, finalPaymentMonth]
);

if (existingPayment) {
    return res.status(400).json({ 
        error: 'تم الدفع مسبقاً',
        message: `الطالب ${resolvedStudentName} قام بالدفع بالفعل لشهر ${finalPaymentMonth}/${finalPaymentYear}`,
        existing_payment: existingPayment
    });
}
```

**عند الإدراج:**
```typescript
await execute(
    `INSERT INTO student_fees (
        student_id, student_name, phone, guardian_phone, 
        payment_year, payment_month, ...
    ) VALUES (?, ?, ?, ?, ?, ?, ...)`,
    [resolvedStudentId, resolvedStudentName, resolvedPhone, 
     resolvedGuardianPhone, finalPaymentYear, finalPaymentMonth, ...]
);
```

### 3. تعديلات الفرونت-إند

#### في ملف `src/pages/BarcodeAttendance.tsx`:

**فحص حالة الدفع الشهري:**
```typescript
const currentYear = new Date().getFullYear();
const currentMonth = new Date().getMonth() + 1;

const hasMonthlyPayment = feeResponse.data.some((fee: any) => {
    return fee.payment_year === currentYear && fee.payment_month === currentMonth;
});
```

#### في ملف `src/pages/Fees.tsx`:

**إضافة حقول جديدة:**
- `guardianPhone` - رقم ولي الأمر
- `payment_year` - تلقائياً من التاريخ الحالي
- `payment_month` - تلقائياً من التاريخ الحالي

```typescript
const feeData = {
    student_name: offlinePaymentData.studentName,
    phone: offlinePaymentData.phone,
    guardian_phone: offlinePaymentData.guardianPhone || null,
    // ... بقية الحقول
    payment_year: new Date().getFullYear(),
    payment_month: new Date().getMonth() + 1
};
```

## كيف يعمل النظام؟

### سيناريو 1: طالب يدفع لأول مرة في نوفمبر 2025
```
✅ الدفع يُقبل
- يتم إنشاء سجل جديد
- payment_year = 2025
- payment_month = 11
- status = 'paid'
```

### سيناريو 2: نفس الطالب يحاول الدفع مرة أخرى لنوفمبر 2025
```
❌ الدفع يُرفض
- رسالة: "تم الدفع مسبقاً"
- رسالة تفصيلية: "الطالب [اسم] قام بالدفع بالفعل لشهر 11/2025"
- يظهر السجل السابق للمستخدم
```

### سيناريو 3: نفس الطالب يدفع لشهر ديسمبر 2025
```
✅ الدفع يُقبل
- سجل جديد مستقل
- payment_year = 2025
- payment_month = 12
```

## الميزات الإضافية

### 1. Backfill للسجلات القديمة
عند تشغيل السيرفر لأول مرة، يتم:
```sql
UPDATE student_fees 
SET payment_year = YEAR(payment_date),
    payment_month = MONTH(payment_date)
WHERE payment_date IS NOT NULL 
  AND (payment_year IS NULL OR payment_month IS NULL)
```

### 2. حفظ رقم ولي الأمر
- يتم حفظ `guardian_phone` مع كل دفعة
- يظهر في سجل الحضور
- يمكن استخدامه لإرسال رسائل WhatsApp

### 3. عرض حالة الدفع في صفحة الباركود
```
عمود "حالة الدفع":
✅ مدفوع - للطالب الذي دفع هذا الشهر
❌ غير مدفوع - للطالب الذي لم يدفع
```

## البيانات المحفوظة لكل دفعة

```typescript
{
    id: "uuid",                    // معرف فريد
    student_id: "uuid",            // معرف الطالب
    student_name: "محمد أحمد",     // اسم الطالب
    phone: "01012345678",          // رقم الطالب
    guardian_phone: "01087654321", // رقم ولي الأمر
    grade_id: "uuid",              // معرف الصف
    grade_name: "الصف الثالث",     // اسم الصف
    group_id: "uuid",              // معرف المجموعة
    group_name: "مجموعة A",        // اسم المجموعة
    barcode: "ABC123...",          // باركود الطالب
    amount: 500.00,                // المبلغ المستحق
    paid_amount: 500.00,           // المبلغ المدفوع
    status: "paid",                // الحالة
    payment_method: "cash",        // طريقة الدفع
    payment_year: 2025,            // ⭐ سنة الدفع
    payment_month: 11,             // ⭐ شهر الدفع
    payment_date: "2025-11-22",    // تاريخ الدفع الكامل
    notes: "ملاحظات...",          // ملاحظات
    created_at: "2025-11-22 ..."   // وقت الإنشاء
}
```

## اختبار النظام

### 1. دفع طالب جديد:
```bash
POST /api/fees
{
    "student_name": "أحمد محمد",
    "phone": "01012345678",
    "guardian_phone": "01087654321",
    "barcode": "STUDENT001",
    "amount": 500,
    "paid_amount": 500,
    "status": "paid"
}

✅ Response: 201 Created
```

### 2. محاولة الدفع مرة أخرى لنفس الشهر:
```bash
POST /api/fees
{
    "student_name": "أحمد محمد",
    "phone": "01012345678",
    ...
}

❌ Response: 400 Bad Request
{
    "error": "تم الدفع مسبقاً",
    "message": "الطالب أحمد محمد قام بالدفع بالفعل لشهر 11/2025",
    "existing_payment": { ... }
}
```

### 3. التحقق من حالة الدفع:
```bash
GET /api/fees?phone=01012345678&status=paid

Response: [
    {
        "student_name": "أحمد محمد",
        "payment_year": 2025,
        "payment_month": 11,
        "status": "paid",
        ...
    }
]
```

## ملاحظات مهمة

1. **للطلاب الأونلاين والأوفلاين**: النظام يعمل لكليهما
2. **منع التكرار**: تلقائياً عبر UNIQUE INDEX
3. **الشهر الجديد**: تلقائياً يمكن الدفع للشهر الجديد
4. **السجلات القديمة**: تم backfill تلقائياً من `payment_date`
5. **عرض البيانات**: يظهر في صفحة BarcodeAttendance وصفحة Fees

## الملفات المعدلة

1. ✅ `server/src/routes/fees.ts` - منطق الدفع والـ schema
2. ✅ `src/pages/BarcodeAttendance.tsx` - فحص حالة الدفع
3. ✅ `src/pages/Fees.tsx` - إضافة حقول جديدة

---

**تم التنفيذ بنجاح في:** 22 نوفمبر 2025
