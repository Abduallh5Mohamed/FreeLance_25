# M2-03 — إدارة محتوى المقررات القائمة

**القبول النهائي074 —2026-10-18:** أُغلقت M2-03 بعد مراجعة المصدر والمعمارية والتحقق المستقل:511 اختبار عميل ناجح، واختبارات070/072 الثلاثة ناجحة، صفر أخطاء أنواع بالنطاق و11 خارجيًا موثقًا. [القبول وحدوده074](coordination/supervisor/074-final-m2-03-material-management-acceptance.md). أوقفت جدولة الدفعة عند الإغلاق؛ التعديلات غير مودعة أو منشورة. النص أدناه سجل النطاق، لا تفويض بإعادته أو بدء مرحلة جديدة. رفع/تشغيل الفيديو والعقود الأوسع لا تعتبر مكتملة، وM2 كاملة ما زالت مفتوحة مع تأجيل OTP.

2026-10-18، codex/human-client. استمرار بطلب المستخدم متابعة بقية M2 واستبعاد
OTP مؤقتًا. المشرف وصف هذه الشريحة في المحادثة قبل إنشاء المهمة؛ التفويض لا
ينقل ملكية الخادم/العقود المشتركة ولا يجيز خدمات أو دفعات أخرى دون تحديد نطاقها.
المصدر C5 من17؛ الجرد الكامل في M2-REMAINING.md. M1/039 و055 و067 لا تعاد.

## الهدف والسلوك قبل/بعد

CourseContentManager.tsx: loadMaterials يكتب بلا generation أو تحقق course/session؛
تغيير course إلى فارغ لا يمسح القائمة السابقة؛ save يعتمد React loading لا قفل
فوري، والتحويل يسبق awaitcreate فتغيير الهدف خلالها قد يخلط نموذجًا جديدًا؛
الحذف بلا single-flight، وفشل refresh غير منفصل عن نجاح الكتابة، duration
يستعمل parseInt جزئيًا. المصدر دليل، لا اختبار خدمات.

المطلوب: ردود مرتبطة بعمر course/session/form/operation عبر النجاح والفشل
والتخلص، منع التكرار، حفظ النموذج/الهدف عند الفشل، تمييز loading/empty/error،
عدم مسح نموذج جديد أو قائمة نطاق جديد، وعدم إعادة الإنشاء بعد فشل refresh.
تحقق من duration والأهداف/grade/group وفق العقد الحالي دون اختراع سياسة نشر.

## أربعة ملفات فقط

- src/pages/CourseContentManager.tsx
- src/features/catalog/material-management.ts — أصغر seam إنتاج تستعمله الصفحة
- src/tests/m2-material-management.test.ts
- docs/streams/client/M2-03-CONTRACTS.md

قراءة غير سرية ضرورية فقط: api/api-http/session-events والأنواع، routes/materials
وcourses/groups/grades وما يلزم لتثبيت العقود. لا env/.qa/credentials/traces أو
ملفات claim خاصة. لا تعديل مشترك/API/auth/router/player/backend/package/config
أو schema/migrations أو ملفات الدفعات المقبولة. إذا احتجت shared contract بلّغ
بدليل محدد ولا تصلحه خارج الملكية. ابدأ inventory scoped diff ولا تكتب من الصفر.

## العقود والحدود

getMaterials(courseId) يقرأ /materials?course_id؛ createMaterial POST يعيد صف
المادة؛ deleteMaterial DELETE **يلغي النشر** is_published=false ولا يحذف فعليًا.
الخادم مصدر الحقيقة للنشر/الهوية. ثبّت read scope وطرق الكتابة/الفشل من المصدر.
Grade/group associations الحالية تحفظ؛ لا audience أو entitlement من العميل.

المصدر materials.ts يرفض فيديو خارجي ويتطلب video:// للفيديو؛ الصفحة تعرض
Google Drive افتراضيًا. بلّغ هذا التعارض بوضوح وأظهر رفضًا صادقًا وفق العقد؛
لا تخترع upload/video id أو bypass أو خدمة/مزود/روابط حماية. تحويل الرابط الحالي
إن استعملته يمر بنفس transport، mocks في الاختبار فقط. لا player/رفع/DRM منM3.
لا إزالة دعم ملفات غير الفيديو الصحيح أو بيانات النموذج/المجموعات بصورة صامتة.
لا وحدات/دروس/reorder/drip أو إعدادات نشر جديدة لمجرد أن C5 يذكرها.

لا migrations/نقل بيانات/تشغيل DB/network/browser/provider/Docker أو installs
أو Git writes/commit/push/deploy. عند تشغيل المنتج لاحقًا تبقى الكتابات create
وunpublish الحالية فقط، لا خدمات جديدة أو تسعير/checkout/OTP. روابط/توكنات
خاصة لا تطبع أو تسجل؛ read scope داخلي دقيق، لا بصمة32بت أو سجل جلسات تاريخي.

## الاختبار والانتهاء

- اختبارات hermetic على إنتاج فعلي تستعمله الصفحة مع dependencies محقونة،
  لا نسخ implementation بالاختبارات. لا helper إنتاج منفصل فقط لإرضاء اختبار.
- reverse reads/courseA→B→A/empty/session/logout/unmount؛ create عبر conversion
  pending وتغيير النموذج/الهدف، failed conversion/save/delete وإعادة محاولة؛
  duplicate قبل render؛ success+refresh failure؛ finally القديم لا يفك busy أحدث.
- duration جزئي/nonfinite/invalid وفق العقد والفراغ القائم، لا تغيير policy؛
  إلغاء نشر موثق، الحفاظ على grade/group، serverرفض/401/403 حسب transport الفعلي.
- RTL/labels/keyboard من المكونات القائمة؛ لا ادعاء renderedDOM دون اختبار.
- baseline469 اختبارات عميل و11 نوع خارجي من067، شغّل المحلي المعزول وtsc
  الموجودين بعد التغيير؛ لا dependencies أو tests importing DB/dotenv.
- checkpoint بمعالم فعلية ضمن15دقيقة، معرفات native حقيقية إن توفرت، stop قبل
  report ثم قبول المشرف. لا مدة مصطنعة أو مرحلة جديدة أو self-acceptance.
- guard أو429: توقف مرة وبلغ disk state، لا retry أو حساب/model بديل.

WorkBuddy منفذ أصلي عبر MCP، Codex مشرف لا يسحب بدله. انتظار الفحص الساعي
طبيعي ولا يثبت liveness؛ مراجعة المشرف كل15دقيقة تنتهي عند إغلاق الدفعة.
