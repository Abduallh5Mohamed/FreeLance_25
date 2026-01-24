# نظام الرسائل - دليل الاستخدام

## ✅ تم الإنجاز بنجاح!

تم إنشاء نظام رسائل كامل بين المدرسين والطلاب مع جميع المميزات المطلوبة.

## 🎯 المميزات المُنفذة

### 1. إرسال الرسائل النصية ✅
- إرسال رسائل نصية بين المدرسين والطلاب
- عرض الرسائل في الوقت الفعلي (Real-time)

### 2. إرسال الصور ✅
- رفع وإرسال الصور
- عرض الصور في المحادثة
- حد أقصى لحجم الصورة: 5MB

### 3. حالة الأونلاين/الأوفلاين ✅
- عرض حالة المستخدم (متصل/غير متصل)
- عرض آخر ظهور للمستخدم
- تحديث الحالة تلقائياً

### 4. حالة قراءة الرسالة ✅
- ✓ تم الإرسال (علامة واحدة رمادية)
- ✓✓ تم التوصيل (علامتان رماديتان)
- ✓✓ تم القراءة (علامتان زرقاوات)

### 5. حالة التوصيل ✅
- تتبع حالة توصيل كل رسالة
- تحديث الحالة تلقائياً

### 6. التخزين في قاعدة البيانات ✅
- تخزين جميع الرسائل في MySQL
- تخزين حالة القراءة والتوصيل
- تخزين حالة الأونلاين/الأوفلاين

### 7. تعديل الرسالة ✅
- إمكانية تعديل الرسائل المُرسلة
- عرض علامة "معدلة" على الرسائل المُعدلة

### 8. حذف الرسالة ✅
- إمكانية حذف الرسائل (Soft Delete)
- إخفاء الرسالة من المحادثة

## 📊 قاعدة البيانات

تم إنشاء 4 جداول جديدة:

### 1. messages
```sql
- id: INT (Primary Key)
- sender_id: CHAR(36) (Foreign Key -> users.id)
- receiver_id: CHAR(36) (Foreign Key -> users.id)
- message_type: ENUM('text', 'image')
- content: TEXT
- image_url: VARCHAR(500)
- is_edited: BOOLEAN
- edited_at: DATETIME
- is_deleted: BOOLEAN
- deleted_at: DATETIME
- created_at: DATETIME
- updated_at: DATETIME
```

### 2. message_status
```sql
- id: INT (Primary Key)
- message_id: INT (Foreign Key -> messages.id)
- is_delivered: BOOLEAN
- delivered_at: DATETIME
- is_read: BOOLEAN
- read_at: DATETIME
- created_at: DATETIME
- updated_at: DATETIME
```

### 3. user_online_status
```sql
- id: INT (Primary Key)
- user_id: CHAR(36) (Foreign Key -> users.id)
- is_online: BOOLEAN
- last_seen: DATETIME
- socket_id: VARCHAR(100)
- created_at: DATETIME
- updated_at: DATETIME
```

### 4. conversations
```sql
- id: INT (Primary Key)
- user1_id: CHAR(36) (Foreign Key -> users.id)
- user2_id: CHAR(36) (Foreign Key -> users.id)
- last_message_id: INT (Foreign Key -> messages.id)
- unread_count_user1: INT
- unread_count_user2: INT
- created_at: DATETIME
- updated_at: DATETIME
```

## 🚀 APIs المُنشأة

### Backend APIs (REST)

1. **GET /api/messages/conversations**
   - الحصول على جميع المحادثات للمستخدم الحالي

2. **GET /api/messages/:userId**
   - الحصول على الرسائل مع مستخدم معين

3. **POST /api/messages/send**
   - إرسال رسالة نصية جديدة

4. **POST /api/messages/upload-image**
   - رفع وإرسال صورة

5. **PUT /api/messages/:id/edit**
   - تعديل رسالة

6. **DELETE /api/messages/:id**
   - حذف رسالة

7. **PUT /api/messages/:id/mark-read**
   - تحديد رسالة كمقروءة

8. **GET /api/messages/users/available**
   - الحصول على المستخدمين المتاحين للمحادثة

### Socket.IO Events

#### Events من العميل للسيرفر:
- `user:connect` - الاتصال وتحديث حالة الأونلاين
- `message:send` - إرسال رسالة
- `message:read` - تحديد رسالة كمقروءة
- `message:edit` - تعديل رسالة
- `message:delete` - حذف رسالة
- `typing:start` - بدء الكتابة
- `typing:stop` - التوقف عن الكتابة

#### Events من السيرفر للعميل:
- `message:new` - رسالة جديدة واردة
- `message:sent` - تأكيد إرسال الرسالة
- `message:read` - تم قراءة الرسالة
- `message:edited` - تم تعديل الرسالة
- `message:deleted` - تم حذف الرسالة
- `user:status` - تحديث حالة المستخدم
- `typing:start` - المستخدم الآخر يكتب
- `typing:stop` - المستخدم الآخر توقف عن الكتابة

## 💻 واجهة الفرونت إند

تم إنشاء صفحة `/src/pages/Messages.tsx` بالمميزات التالية:

### الواجهة
- **Sidebar**: عرض المحادثات والمستخدمين المتاحين
- **Chat Area**: منطقة المحادثة الرئيسية
- **Input Area**: إدخال الرسائل ورفع الصور

### المميزات
- ✅ عرض المحادثات مع عدد الرسائل غير المقروءة
- ✅ عرض آخر رسالة في كل محادثة
- ✅ عرض حالة الأونلاين/الأوفلاين لكل مستخدم
- ✅ عرض مؤشر "يكتب..." عند الكتابة
- ✅ عرض الرسائل مع التواريخ والأوقات
- ✅ عرض حالة القراءة (✓✓) بألوان مختلفة
- ✅ إمكانية تعديل وحذف الرسائل
- ✅ رفع وعرض الصور
- ✅ تصميم responsive وجميل

## 🔧 كيفية الاستخدام

### 1. تشغيل النظام
```bash
npm run dev
```

سيتم تشغيل:
- Frontend على: http://localhost:8081
- Backend على: http://localhost:3001
- Socket.IO على: http://localhost:3001

### 2. الوصول إلى صفحة الرسائل
- افتح المتصفح على: http://localhost:8081/messages
- يجب تسجيل الدخول أولاً

### 3. إرسال رسالة
1. اختر مستخدم من القائمة الجانبية
2. اكتب الرسالة في حقل الإدخال
3. اضغط Enter أو زر الإرسال

### 4. إرسال صورة
1. اختر مستخدم
2. اضغط على أيقونة الصورة
3. اختر الصورة من جهازك

### 5. تعديل رسالة
1. اضغط على أيقونة القلم بجانب الرسالة
2. عدل النص
3. اضغط Enter أو زر الإرسال

### 6. حذف رسالة
1. اضغط على أيقونة سلة المهملات بجانب الرسالة
2. سيتم حذف الرسالة فوراً

## 📦 المكتبات المُستخدمة

### Backend
- `socket.io` - للرسائل الفورية
- `multer` - لرفع الصور
- `express` - للـ REST APIs
- `mysql2` - للتعامل مع قاعدة البيانات

### Frontend
- `socket.io-client` - للاتصال بالسيرفر
- `axios` - للـ HTTP requests
- `react-router-dom` - للتنقل
- `shadcn/ui` - لمكونات الواجهة

## ⚙️ الإعدادات

### Backend (.env)
```env
PORT=3001
DB_HOST=localhost
DB_USER=root
DB_PASSWORD=123580
DB_NAME=Freelance
JWT_SECRET=your-secret-key
```

### Frontend
```typescript
const API_URL = 'http://localhost:3001/api';
const SOCKET_URL = 'http://localhost:3001';
```

## 🎨 التصميم

- تصميم عربي (RTL)
- ألوان متناسقة
- رسوم متحركة سلسة
- responsive على جميع الشاشات
- أيقونات واضحة

## 🔒 الأمان

- ✅ Authentication middleware على جميع المسارات
- ✅ التحقق من صلاحيات المستخدم
- ✅ منع المستخدمين من تعديل/حذف رسائل الآخرين
- ✅ رفع الصور بحجم محدود (5MB)
- ✅ فلترة أنواع الملفات المسموحة

## 📝 ملاحظات

1. **الرسائل المحذوفة**: يتم استخدام Soft Delete (is_deleted = TRUE)
2. **الصور**: يتم حفظها في `server/uploads/messages/`
3. **الرسائل الفورية**: تعمل عبر Socket.IO
4. **التوافق**: المدرسون يمكنهم التحدث مع الطلاب والعكس

## 🐛 التعامل مع الأخطاء

النظام يتعامل مع:
- فشل الاتصال بالسيرفر
- فشل رفع الصور
- الرسائل الفاشلة
- انقطاع الاتصال
- أخطاء قاعدة البيانات

## 🚀 التطوير المستقبلي (اختياري)

- [ ] إرسال ملفات PDF/Word
- [ ] رسائل صوتية
- [ ] رسائل فيديو
- [ ] رسائل جماعية
- [ ] أرشفة المحادثات
- [ ] بحث في الرسائل
- [ ] إشعارات push
- [ ] رسائل مجدولة

---

**تم الإنجاز بنجاح! ✅**

النظام جاهز للاستخدام على: http://localhost:8081/messages
