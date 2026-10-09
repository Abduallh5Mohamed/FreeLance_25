# ADR-0001: احتواء مخاطر المصادقة والأسرار الحرجة

- **الحالة:** Accepted
- **التاريخ:** 2026-09-21
- **النطاق:** أول شريحة P0، بلا تغيير Schema وبلا حذف بيانات

## السياق

الفحص الأولي أثبت وجود أسرار مزود AI داخل Source وartifacts قابلة للنشر، وJWT fallback secrets متعددة، وتسجيل عام يقبل role من العميل، وSocket.IO يثق في user IDs يرسلها العميل، ومسارات إدارة Instructor والمحفظة والـmigrations غير محمية مركزيًا.

## القرار

1. `JWT_SECRET` إعداد إلزامي ويفشل مغلقًا عند غيابه؛ لا fallback secret.
2. استخدام middleware مشترك للتحقق من JWT، مع compatibility policies مؤقتة للأدوار والملكية إلى حين إدخال permission model.
3. التسجيل العام ينشئ `student` فقط مهما أرسل العميل. إنشاء الأدوار المميزة يبقى في مسارات الإدارة الموثقة.
4. حماية migration routes بدور admin، وحماية إدارة Instructors بدور admin، والسماح للـInstructor بقراءة بياناته ومحفظته فقط.
5. Socket.IO يتحقق من JWT في handshake ويستخرج sender/user identity من الـtoken، لا من event payload.
6. نقل استدعاء Groq إلى Backend فقط، واشتراط `GROQ_API_KEY` server-side. أزيلت القيمة المكشوفة من Source ومن artifacts النصية الحالية.
7. عدم تغيير URLs أو response shapes العامة في هذه الشريحة.

## أثر التوافق

- واجهة التسجيل الحالية تنشئ طلب تسجيل طالب، لذلك قصر `/auth/register` على student يطابق الـUX الحالي ويغلق تصعيدًا غير مقصود.
- Messages وStudentChat كانا يرسلان Socket token بالفعل. تم تحديث NotificationBell ليرسله أيضًا.
- AI يحتفظ بنفس تجربة المستخدم، لكن يتطلب مفتاحًا جديدًا صالحًا في Backend environment.
- admin يحتفظ بإدارة Instructors والمحافظ. Instructor يحتفظ بقراءة موارده الذاتية فقط.
- migration endpoints لم تعد عامة؛ URL والعقد لم يتغيرا.

## متطلبات التشغيل قبل النشر

1. إلغاء/تدوير مفتاح Groq المكشوف من لوحة المزود. تنظيف Git لا يبطل المفتاح القديم.
2. إضافة المفتاح الجديد إلى Backend كـ`GROQ_API_KEY` فقط، وعدم استخدام prefix `VITE_`.
3. التأكد من وجود `JWT_SECRET` قوي ومتطابق على كل نسخ Backend قبل restart/rolling deploy.
4. عدم طباعة القيمتين أو تضمينهما في build artifacts.

## ترتيب النشر الآمن

1. نشر الواجهة أولًا؛ النسخة الجديدة ترسل Socket token من NotificationBell وتستخدم Backend AI endpoint الموجود أصلًا.
2. Smoke test لتسجيل الدخول والمحادثات من الواجهة الجديدة على الخادم القديم.
3. نشر الخادم الجديد بعد تجهيز `JWT_SECRET` و`GROQ_API_KEY` الجديدين.
4. Smoke test لأدوار admin/instructor/student، وإدارة Instructor، والمحفظة، والمحادثات، والمساعد الذكي.
5. مراقبة 401/403 وSocket `connect_error` ومعدل أخطاء AI.

## Rollback

- يمكن الرجوع إلى نسخة التطبيق السابقة عند regression، لكن **لا** يعاد المفتاح المكشوف ولا JWT fallback إلى الكود.
- تبقى الأسرار الجديدة في environment.
- إذا تعذر AI مؤقتًا، يعاد 503 بدل تعريض المفتاح للمتصفح.
- لا توجد DB migration في هذا القرار، لذلك لا يوجد data rollback.

## الإثبات

- ثمانية اختبارات security policy/middleware/video-token تمر.
- Backend TypeScript build ينجح.
- Frontend production build ينجح.
- فحص المستودع العامل لا يجد قيمة Groq secret-shaped خارج الملفات المضغوطة الثنائية القديمة؛ يجب استبدال أي حزمة zip منشورة ببناء جديد.

## ما لم يحله القرار

- لا يمثل role compatibility layer نموذج الصلاحيات النهائي.
- لم تُحمَ بعد كل API modules؛ الترحيل endpoint-by-endpoint مستمر.
- لم يُطبق tenant model أو session revocation أو rate limiting بعد.
- لم يُنقل runtime DDL إلى migrations بعد؛ تم فقط منع الوصول العام إلى migration endpoints.
- CORS لم يُشدّد في هذه الشريحة لحين توثيق origins الفعلية لكل بيئة.
