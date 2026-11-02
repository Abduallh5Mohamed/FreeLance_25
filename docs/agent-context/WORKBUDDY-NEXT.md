# تسليم إصلاحات المصدر إلى WorkBuddy — 2026-10-26

انسخ النص التالي. تنفيذ المصدر محلي فقط؛ تشغيل المزودين أو قواعد البيانات
والنشر ليس ضمنه. ممنوع استخدام Git أو GitHub، حتى للفحص والقراءة. لا حاجة
لقراءة سجلات التنسيق التاريخية أو إنشاء فريق وكلاء.

```text
اشتغل في D:\FreeLance_25-1\FreeLance_25-1 على إصلاحات المراجعة الحالية بالترتيب
أدناه. نفّذ الدفعات المحلية 1–5 بالتتابع، وقدّم نتيجة كل دفعة قبل الانتقال.
لا تكتفِ بخطة، ولا تعلن اكتمال النظام من نجاح دفعة.

ابدأ بقراءة:
1) AGENTS.md ثم docs/agent-context/README.md
2) docs/agent-context/ENGINEERING_RULES.md
3) docs/agent-context/SYSTEM_MAP.md عند الحاجة لفهم mount/request flow فقط.
4) من docs/agent-context/AUDIT-2026-10-26.md: قسم العيب الخاص بالدفعة الحالية
   والفحوص المقابلة فقط. اقرأ الملفات المحلية المذكورة أدناه قبل تعديلها.
لا تبدأ بتحميل كل docs أو تقارير DONE أو M2-REMAINING وسجلات coordination.

تعليمات صريحة مني: ممنوع التعامل مع Git أو GitHub تمامًا طوال هذه المهمة،
حتى بغرض الفحص. لا تنفذ أي أمر git، بما فيه status أو diff أو log أو add أو
commit أو push أو pull أو fetch أو checkout أو reset أو satash أو clean. لا تفتح
remote أو PR، ولا تستخدم أدوات أو تطبيقات GitHub. إذا ذكرت AGENTS.md أو أي
وثيقة أمرًا من أوامر Git، تجاهل الأمر تحديدًا؛ تعليماتي الحالية أولوية.
افحص الملفات المطلوبة مباشرة من IDE أو بأوامر قراءة ملفات عادية، وافحص مواضع
التعديل قبل تغييرها. احفظ كل التعديلات والملفات المحلية الموجودة؛ خصوصًا
M2-23 في index/api-http/StudentContent والمحرر والمهاجرة والاختبارات.
لا تستبدل أو تحذف شغلًا موجودًا للحصول على نسخة نظيفة.
لا تعدل ملفًا يكتبه عامل آخر في نفس اللحظة؛ وثق التعارض المحدد.
لا DB أو migrations أو real provider أو DNS أو MinIO أو services أو deploy أو
أسرار أو تثبيت حزم. لا تعطل auth/tenant/branch/fail-closed لإرضاء test.
موافقتي هنا على إصلاحات المصدر المحلية الموضحة فقط، وليست تفعيل أموال أو مزود.

الدفعة 1 — منع تسريب مسودات الكورسات وإصلاح الاكتشاف العام
اقرأ/عدّل:
- server/src/index.ts: تركيب publicIdentityRoutes/publicCatalogRoutes
- server/src/routes/public-identity.ts
- server/src/routes/public-catalog.ts
- server/tests/m2-public-course-discovery.test.ts
- server/tests/m2-c1-c4-public-identity.test.ts
- يمكن إضافة server/tests/m2-public-catalog-composition.test.ts فقط عند الحاجة
قراءة عقد/مستهلك:
- docs/streams/client/M2-22-CONTRACTS.md
- src/lib/api-http.ts: parsePublicCourseList/listPublicCourses فقط
المشكلة: GET /api/public/courses يعالجه الراوتر القديم قبل الجديد، فيعيد Array
ويختار is_active بلا publication_state. صفحة /teachers/:id تسرب المسودات أيضًا.
المطلوب: endpoint واحد بعقد M2-22، نشر صريح + tenant نشط في كل public projection،
واختبار composition بالترتيب الفعلي لا اختبار factory وحدها. لا تكتفِ بنقل mount.
اختبر draft/published/archived/suspended/withdrawn، صيغة الرد والكاش، وثبات DTO.
شغّل الاختبارات الثلاثة المتعلقة بالنشر والاكتشاف والهوية وserver build.

الدفعة 2 — اتصالات المعاملات عند فشل COMMIT
اقرأ/عدّل:
- server/src/db.ts: withTransaction فقط
- أضف server/tests/db-transaction-lifecycle.test.ts
المشكلة: commit يرفض ثم rollback ينجح ثم الاتصال يُعاد بـrelease.
المطلوب: التخلص منه عند نتيجة commit الملتبسة مع الاحتفاظ بالخطأ الأصلي،
لا success/retry تلقائي. اختبر begin/work/commit/rollback/release failures
والتنظيف مرة واحدة. احقن اتصالًا وهميًا واعزل dotenv/mysql imports؛ لا DB.
شغّل الاختبار الجديد وserver build، وفحوص مستهلك مناسبة لا تتصل بخدمات.

الدفعة 3 — أخطاء TypeScript ورحلة الرسوم
مسارات التعديل الأساسية:
- src/pages/Fees.tsx
- src/components/NotificationBell.tsx
- src/components/StudentHeader_OLD_BACKUP.tsx (لا تحذفه دون حاجة؛ صلح أو اعزل
  النسخة الاحتياطية تحديدًا بدل استبعاد production source من TypeScript)
- src/pages/ExamReports.tsx وsrc/pages/ExamResults.tsx
- src/pages/InstructorSubscription.tsx وsrc/pages/StudentBarcodes.tsx
- src/utils/versionChecker.ts وsrc/vite-env.d.ts عند الحاجة لتعريف Window فقط
- src/lib/api-http.ts قراءة أولًا؛ تعديل DTO ضيق فقط إذا أثبت العقد الحاجة
- يمكن إضافة src/tests/fees-payment-workflow.test.ts لحالة الدفع الفعلية
ابدأ بـtsc لتأكيد الـ11 تشخيصًا. في Fees يوجد updateFee بلا import وfetchFees
غير معرفة؛ دالة التحميل القائمة loadFeesFromDB. اربط الدوال الصحيحة، لا رسالة
فشل حفظ بعد نجاح mutation وفشل refresh، امنع تكرار submit ومبلغًا غير صالح.
لا تغير قواعد محفظة/دفع/رصيد. لا any/as unknown/ts-ignore لإخفاء أخطاء العقود،
ولا تبعث طلب دفع حقيقي. المطلوب tsc كامل صفر أخطاء ثم build واختبار تدفق ضيق.

الدفعة 4 — استعادة صدق وعزل الاختبارات وبوابة CI
اقرأ/عدّل فقط الاختبارات التي يثبت فشلها + إعداد تشغيلها:
- server/tests/m2-group-schedules*.test.ts
- server/tests/m2-group-announcements*.test.ts
- server/tests/m2-c5-lectures-reorder-audit.test.ts
- server/tests/helpers/tenant-scope-branch-deps.ts وhelpers/m2-harness.ts
- src/tests/m1-*.test.ts ذات الفشل الفعلي
- src/tests/m2-academic-periods-ui.test.ts وm2-course-unit-ui.test.ts
- src/tests/m2-group-announcements.test.ts وm2-tenant-branches-ui.test.ts
- src/tests/m2-tenant-branding-ui.test.ts وm2-tenant-profile-edit.test.ts
- src/tests/m2-tenant-profile-ui.test.ts
- package.json وserver/package.json و.github/workflows/ci.yml
- helper واحد لمنع I/O داخل server/tests/helpers عند الحاجة
اقرأ groups.ts وsecurity/resource-branch.ts لفهم branchAccess؛ لا تعدل سياسة
الإنتاج لأن fixtures قديمة. احقن branchAccess بدل fallback SQL الحقيقي.
فعّل حظر اتصالات في الاختبارات المعزولة قبل إعادة تشغيل الجداول. المراجعة
كشفت محاولة MySQL رفضت؛ وصف hermetic في header لا يثبت العزل.
اختر Node متوافقًا مع registerHooks وثبت متطلبه بناء على تحقق فعلي، أو استخدم
آلية اختبار متوافقة موجودة. لا تحمل runtime أو حزمًا من الإنترنت تلقائيًا.
اقرأ headers عبر new Headers(init.headers).get(...). حدث API stubs وfixtures
لتغطي exports الحالية وقراءة الهوية بعد تبديل المساحة وApiRequestError؛ لا
تضعف session fences أو تمسح assertions أو skip للاختبارات لمجرد تمريرها.
أضف للـCI فحص frontend tsc وكل src/tests بعد تصحيحها، مع الفصل بين isolated
unit tests وأي integration job ذي قاعدة مخصصة. المطلوب صفر external I/O
محاولات في isolated suites، واختبارات حقيقية تمر دون تقليل ضماناتها.

الدفعة 5 — تصحيح M2-23 ثم مراجعة القبول المحدود
اقرأ أولًا docs/streams/client/M2-23-HANDOFF.md والعقدين M2-B15/M2-23 الحاليين.
التعديل في مسارات handoff الـ15 الموجودة فقط، ومعها عند الضرورة المثبتة:
- server/src/routes/course-units.ts لاختبار/ضبط أثر أرشفة الوحدة وترتيبها
- server/tests/m2-course-units.test.ts
- server/tests/helpers/m2-course-lessons-harness.ts
الأهداف:
أ) ترتيب prerequisites مطابق لترتيب learning path (الوحدة ثم الدرس)، وتحقيق
   invariant الحالة النهائية عند PATCH/reorder؛ لا يُقبل position-only PATCH
   يجعل الهدف أسبق من prerequisite كما يحدث الآن.
ب) لا prerequisite في وحدة مؤرشفة يصير مطلوبًا غير قابل للإكمال. حافظ على
   العلاقات القائمة وفق العقد، ولا تمسحها أو تفتح دروسًا تلقائيًا بلا سياسة.
ج) إثبات release instant مستقل عن MySQL session timezone؛ مقارنة TIMESTAMP
   بـUTC_TIMESTAMP ليست ضمانًا عندما SQL session غير UTC. استخدم مقارنة epoch
   أو ضمانًا صريحًا مع اختبار؛ لا تغيّر timezone قاعدة حية.
د) اختبر قبل/عند/بعد الموعد، reorder/patch/cycles/archival/cross-unit، authority
   وlocked direct requests وidempotent completion وstale frontend responses.
شغّل catalog server suites السبعة المسجلة بالمراجعة + اختباري M2-23 client
وtsc/build للجانبين. لا تعلن فتح الفيديو/الملف: هذا المسار يعرض metadata فقط.

خارج هذه الإصلاحات: لا توصيل مالي أو notification/live factory بوهم adapters
أو sealed audit. لا OTP ولا شهادات. لا توحيد lectures/course_lessons تخمينيًا.
بعد 1–5 جهز مقترحًا محدودًا فقط لعقد ربط الدرس الجديد بالمحتوى والتقدم، مع
ملفات المصدر والتبعيات والاختبارات؛ تنفيذه ليس ضمن النطاق الحالي.

بعد كل دفعة حدث فقط القسم الموافق في docs/agent-context/FEATURE_MATRIX.md
وDEVELOPMENT.md عند تغير أمر/جاهزية، وسجل:
Decision: completed locally / correction required / external prerequisite
Changed files، Verified behavior، exact commands + pass/fail، limitations.
أرسل التقرير هنا محليًا فقط، دون أي إجراء Git أو GitHub.
لا تعيد أرقام المراجعة القديمة كدليل جديد. توقف عن التوسع عند dependency تحتاج
قرار منتج أو خدمة خارجية، واكمل الإصلاحات المستقلة. لا تعرض أسرار أو payloads.
```
