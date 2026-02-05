# 🔔 نظام الإشعارات - Al Qaed Platform

## ✅ التحديثات المكتملة

### 1. قاعدة البيانات
- ✅ جدول `notifications` تم إنشاؤه بنجاح
- يحتوي على: ID, user_id, user_type, title, message, type, link, is_read, created_at

### 2. Backend API
- ✅ `GET /api/notifications` - جلب كل الإشعارات
- ✅ `GET /api/notifications/unread-count` - عدد الإشعارات غير المقروءة
- ✅ `PUT /api/notifications/:id/read` - تعليم إشعار كمقروء
- ✅ `PUT /api/notifications/read-all` - تعليم الكل كمقروء
- ✅ Helper functions في `utils/notifications.ts`

### 3. Frontend Components
- ✅ `NotificationBell` component - جرس الإشعارات مع badge
- ✅ تم إضافته في `Header.tsx` (للأدمن)
- ✅ تم إضافته في `StudentHeader.tsx` (للطلاب)

### 4. التكامل مع الأحداث
- ✅ إشعارات عند إرسال رسائل جديدة
- 📝 جاهز للإضافة: إشعارات عند تصحيح الامتحانات
- 📝 جاهز للإضافة: إشعارات عند الدفعات الجديدة

## 🧪 كيفية الاختبار

### 1. اختبار الإشعارات للأدمن
```bash
# 1. ادخل على لوحة التحكم
http://72.62.35.177/admin

# 2. ستجد جرس الإشعارات 🔔 بجانب زر تسجيل الخروج
# 3. إذا كان هناك إشعارات غير مقروءة، سيظهر badge أحمر بالعدد

# 4. اضغط على الجرس لفتح قائمة الإشعارات
# 5. اضغط على أي إشعار للذهاب للصفحة المرتبطة
```

### 2. اختبار الإشعارات للطلاب
```bash
# 1. ادخل كطالب
http://72.62.35.177/student

# 2. نفس الخطوات - ستجد جرس الإشعارات في الـ header
```

### 3. اختبار إشعارات الرسائل
```bash
# 1. من حساب طالب، أرسل رسالة للأدمن
# 2. افتح لوحة التحكم كأدمن
# 3. يجب أن تجد إشعار جديد 💬 "رسالة جديدة من [اسم الطالب]"
# 4. اضغط على الإشعار للذهاب لصفحة الرسائل
```

## 📋 API Endpoints

### Get Notifications
```http
GET /api/notifications?user_id={id}&user_type={admin|student}
```

### Get Unread Count
```http
GET /api/notifications/unread-count?user_id={id}&user_type={admin|student}
```

### Mark as Read
```http
PUT /api/notifications/:id/read
```

### Mark All as Read
```http
PUT /api/notifications/read-all
Body: { "user_id": "xxx", "user_type": "admin" }
```

## 🔧 إضافة إشعارات جديدة

لإضافة إشعار عند حدث معين، استخدم:

```typescript
import { 
  notifyExamGraded,
  notifyAdminNewMessage,
  notifyStudentMessageResponse 
} from '../utils/notifications';

// مثال: عند تصحيح امتحان
await notifyExamGraded(studentId, 'امتحان التاريخ', 85, 100);

// مثال: عند رسالة جديدة للأدمن
await notifyAdminNewMessage(adminId, 'أحمد محمد', 'محتاج مساعدة...');

// مثال: عند رد على رسالة طالب
await notifyStudentMessageResponse(studentId, 'تم الرد على استفسارك...');
```

## 🎨 Features

- 🔔 **Bell Icon** مع badge يظهر عدد الإشعارات غير المقروءة
- 📱 **Responsive** - يعمل على جميع الأجهزة
- ⏱️ **Real-time** - يتحدث تلقائياً كل 30 ثانية
- 🎯 **Smart Navigation** - كل إشعار له رابط للصفحة المناسبة
- ✅ **Mark as Read** - تعليم الإشعارات كمقروءة تلقائياً عند الضغط
- 🎨 **Arabic UI** - واجهة عربية كاملة
- 🕐 **Time Ago** - عرض الوقت بالعربية (منذ 5 دقائق)

## 📝 ملاحظات

1. **الإشعارات تُخزن في قاعدة البيانات** - لن تختفي عند إعادة التحميل
2. **Polling كل 30 ثانية** - يمكن تعديله في `NotificationBell.tsx`
3. **للتطوير المستقبلي**: يمكن إضافة WebSocket للإشعارات الفورية
4. **الإشعار التجريبي** تم إضافته للأدمن الأول في قاعدة البيانات

## 🚀 الخطوات التالية (اختياري)

- [ ] إضافة إشعارات عند تصحيح الامتحانات
- [ ] إضافة إشعارات عند تأكيد الدفعات
- [ ] إضافة إشعارات عند إضافة محاضرات جديدة
- [ ] إضافة WebSocket للإشعارات الفورية
- [ ] إضافة صوت notification sound
- [ ] إضافة صفحة "جميع الإشعارات"
