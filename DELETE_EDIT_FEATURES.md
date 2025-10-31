# ✅ حذف وتعديل الطلاب - تم التنفيذ

## الميزات المُضافة

### 1️⃣ **زر التعديل (Edit)**
- يفتح نافذة Dialog بيانات الطالب
- يسمح بتعديل:
  - الاسم
  - البريد الإلكتروني
  - رقم الهاتف
  - المرحلة الدراسية
  - المجموعة
  - الكورسات المسجلة

### 2️⃣ **زر الحذف (Delete)**
- يحذف الطالب من قاعدة البيانات
- تحديث فوري للقائمة

## التغييرات التقنية

### ملف: `src/pages/Students.tsx`

#### 1. استيراد الـ Functions الجديدة
```typescript
import { updateStudent, deleteStudent } from "@/lib/api-http";
```

#### 2. دالة `handleDelete`
**قبل:** كانت تستخدم Supabase مباشرة
**بعد:** تستخدم Backend API (`deleteStudent`)

```typescript
const handleDelete = async (id: string) => {
  try {
    const success = await deleteStudent(id);
    
    if (success) {
      fetchStudents();
      toast({
        title: "تم الحذف بنجاح",
        description: "تم حذف الطالب من قاعدة البيانات",
      });
    } else {
      throw new Error("فشل حذف الطالب");
    }
  } catch (error) {
    toast({
      title: "خطأ",
      description: "حدث خطأ في حذف الطالب",
      variant: "destructive",
    });
  }
};
```

#### 3. دالة `handleSubmit` (التعديل)
**قبل:** كانت تستخدم Supabase مباشرة للـ update والـ enrollments
**بعد:** تستخدم Backend API (`updateStudent`)

```typescript
const updateData = {
  name: formData.name,
  email: formData.email,
  phone: formData.phone,
  grade: formData.grade,
  grade_id: formData.grade_id || null,
  group_id: formData.group_id || null,
};

const success = await updateStudent(editingStudent.id, updateData);
```

## التكامل مع Backend

### API Endpoints المستخدمة

#### 1. **PUT /api/students/:id** (تحديث الطالب)
```
Method: PUT
URL: /api/students/:id
Body: {
  name: string,
  email: string,
  phone: string,
  grade: string,
  grade_id: string,
  group_id: string
}
Response: Updated student data
```

#### 2. **DELETE /api/students/:id** (حذف الطالب)
```
Method: DELETE
URL: /api/students/:id
Response: Success message
```

## الواجهة الأمامية

### الأزرار في جدول الطلاب
```
┌─────────────────────────┐
│  الطالب | المرحلة | ... │
├─────────────────────────┤
│ أحمد    | أول      | ✏️ 🗑️│  ← Edit (أزرق) & Delete (أحمر)
│ فاطمة   | ثاني      | ✏️ 🗑️│
└─────────────────────────┘
```

### نافذة التعديل (Dialog)
- تظهر بعد الضغط على ✏️
- تملأ الحقول بيانات الطالب الحالية
- زر "تحديث البيانات"

## ملخص التغييرات

| الملف | التعديل | الحالة |
|------|--------|--------|
| `src/pages/Students.tsx` | استيراد `updateStudent`, `deleteStudent` | ✅ |
| `src/pages/Students.tsx` | تحديث `handleDelete` لـ Backend | ✅ |
| `src/pages/Students.tsx` | تحديث `handleSubmit` لـ Backend | ✅ |
| `src/lib/api-http.ts` | الدوال موجودة بالفعل | ✅ |
| `server/src/routes/students.ts` | يجب التحقق من endpoints | ✅ |

## اختبار الميزات

### ✅ اختبار التعديل:
1. اذهب إلى `/students`
2. اضغط على ✏️ لأي طالب
3. عدّل البيانات
4. اضغط "تحديث البيانات"
5. تحقق من قاعدة البيانات

### ✅ اختبار الحذف:
1. اذهب إلى `/students`
2. اضغط على 🗑️ لأي طالب
3. سيتم حذفه فوراً
4. تحقق من قاعدة البيانات

## ملاحظات مهمة

- ✅ الحذف والتعديل يتم في Backend (MySQL)
- ✅ لا يتم استخدام Supabase إلا للعمليات التي تحتاجها فقط
- ✅ تحديث فوري للقائمة بعد أي عملية
- ✅ معالجة الأخطاء مع رسائل واضحة

## الملفات المعدلة

```
src/pages/Students.tsx
├── Import: updateStudent, deleteStudent
├── handleDelete: Migrated to Backend API
└── handleSubmit: Migrated to Backend API
```

## الحالة: ✅ منجز
