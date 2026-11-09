# BUILD-45 — حصة الموسم من التطبيق إلى قراءة الطالب

هذه دفعة تشغيل كبيرة لربط J10 وJ02 وJ03، مع استكمال استرجاع عملية التطبيق بعد إعادة التحميل. التنفيذ على الديمو المصطنع المعزول فقط؛ ليس إغلاقًا للخطة أو قبولًا إنتاجيًا.

## النتيجة التي ثبتت

1. إنشاء مقرر موسم 2029 ووحدته وثلاث حصص عبر المسارات المركبة الحالية. استيراد قالب بمراجع مادة جديدة داخل المقرر، ثم تطبيقه بالمحرك الأصلي؛ لا تحويل معرف الدرس التاريخي إلى وجهة أو صلاحية.
2. عمليتا تطبيق متزامنتان بمراجعة واحدة أعطتا 201 و409، مع ربط مادة واحد وإيصال واحد. GET يعيد الإيصال دون إعادة الحفظ.
3. مكتبة القوالب تحفظ قبل POST علامة جلسة صغيرة خاصة بالحساب والمقرر: معرف العملية والوجهة والقالب والنسخة والعدد والتوقيت فقط. إعادة فتح تفاصيل المقرر تستعيد استعلام النتيجة تلقائيًا. لا محتوى ولا مفاتيح أو رمز دخول في العلامة؛ ليست نسخة احتياطية عبر المتصفحات أو بعد إنهاء جلسة المتصفح.
4. Chrome مرّر POST الحقيقي إلى الخادم ثم قطع الرد بعد 201؛ أعاد تحميل الصفحة وفتح المقرر واستعاد الإيصال بـGET، بعدد POST واحد. تلف العلامة أو اختلاف الوجهة أو تعذر الكتابة فيها يوقف الحفظ؛ تعذر مسحها بعد تأكيد الخادم لا يحوّل الحفظ المؤكد إلى فشل كتابة.
5. حساب طالب مصطنع مستقل يستطيع اختيار مساحته وقراءة مقرر الموسم المنشور ومادة الحصة. الطالب القديم غير المسجل يُرفض. موعد مستقبلي أو شرط غير مكتمل يمنع المحتوى؛ سحب المادة يخفيها، وسحب نشر المقرر يمنع القراءة التالية. الرؤوس no-store، وDTO لا يحتوي مفتاح تخزين أو رابط ملف.
6. واجهة الطالب تعرض أن فتح المادة غير متاح حاليًا دون زر تنزيل PDF. مسار الملف يرفض التسليم؛ لا ملف مرفوع أو فحص ناجح أو مزود تمثيلي يدّعي الجاهزية. القراءة لا تسجل إتمام الدرس.

## إصلاحان كشفهما التشغيل الحقيقي

**mysql2/MySQL:** معاملات JavaScript الرقمية تُربط كـDOUBLE، وMySQL 8 يرفض هذا النوع في LIMIT المحضّر. أُضيف تطبيع في طبقة mysql2 الأصلية للـpool والاتصال المحجوز: فقط الأعداد الصحيحة المحدودة في LIMIT/OFFSET النهائية لاستعلام SELECT تصبح نصوصًا عشرية. SQL يظل parameterized، ومعاملات الهوية والأموال والكتابة لا تتغير. المحلل يستبعد النصوص والـidentifiers والتعليقات؛ الفحوص تغطي مواضع المعاملات والحدود والـreceivers والمعاملة وrelease/destroy. الاتصالات المحقونة في route factories تحتفظ بعقدها؛ لا تغيير للاختبارات المحجوزة أو لمسارات WorkBuddy.

**اختيار مساحة الطالب:** ناقل الاختيار الأصلي يثبت `/students/me` بالرمز المرشح ويكتب الهوية كاملة قبل إعلان تبدل الرمز. AuthGuard يعيد تركيب الصفحة عند هذا الإعلان، فيتوقف controller القديم قبل الانتقال. ربط StudentSpaces يكمل الانتقال عند حد النقل المثبت نفسه بشرط `isCurrentSession()`؛ controller المتخلص منه لا يعيد قراءة/كتابة الهوية. اختبار الصفحة يغطي التخلص المتزامن، والرمز المتبدل، ورفض الهوية؛ وChrome يثبت المسار الحقيقي. لا تعديل لـapi-http.ts أو AuthGuard ولا الاعتماد على بيانات client كسلطة.

## الملفات التنفيذية

- `server/src/db.ts`، و`server/src/services/catalog-read-limit.ts`، و`server/tests/catalog-read-limit.test.ts`: ربط حدود القراءة عند السائق الأصلي.
- `src/features/catalog/lesson-package-templates.ts` و`LessonPackageTemplates.tsx`: العلامة المحدودة واستئناف GET وفصل الإيصال التاريخي عن الحالة الحالية.
- `src/pages/StudentSpaces.tsx` و`src/tests/student-space-navigation.test.ts`: إصلاح الانتقال بعد تحقق ناقل المساحة.
- `src/tests/template-application-recovery.test.ts` و`src/tests/lesson-package-template-panels.test.ts`: استرجاع وفشل التخزين وربط واجهة حقيقي، مع sessionStorage مصطنعة مستقلة لكل فحص.
- أدوات الديمو: `output/activate-demo-lesson-package.cjs`، و`verify-demo-lesson-journey.cjs`، و`verify-build45-browser.cjs`. ليست startup migrations أو إجراءات على قاعدة المصدر.
- العقود والسياق والقائمة المشار إليها أدناه؛ تحديث محدد لحالة الديمو والمهمة التالية.

## ما طُبق على الديمو بالضبط

قاعدة `tabweb_demo_20261107162429` فقط، بعد نسخة خاصة `LocalDemo/20261107-182429/before-build45-lesson-package.json`. الأداة تتحقق من loopback واسم الديمو المطابق للـlocator، وتحفظ hash وعدد العبارات المنجزة في `output/build45-demo-migration-journal.json`. DDL ليس معاملة قابلة للتراجع؛ الاستئناف يتبع حدود العبارات، لا ادعاء rollback.

- من `20261018_08_question_bank_assignments.sql`: قسم assignments فقط، من `SET @has_assignments =` حتى قبل `SET @has_submissions =`، مع تحديد DATABASE(). لا تطبيق لبنك أسئلة أو submissions من هذا الملف.
- كاملة: `20261103_01_course_lesson_contents.sql`، `20261104_01_course_material_files.sql`، `20261105_01_material_file_ingestion.sql`، `20261106_01_course_lesson_videos.sql`، `20261106_03_course_lesson_activities.sql`، `20261023_02_group_announcements.sql`، `20261106_07_course_lesson_announcements.sql`، `20261106_09_course_lesson_package_operations.sql`.
- من `20260922_00_tenant_media_and_subscription_requests.sql`: videos.tenant_id وفهرسه فقط، حتى قبل ALTER لـvideo_processing_queue. لا تفعيل اشتراكات/مدفوعات أو مزود.

فحوص البنية الأصلية على MySQL أعادت templates=true وvideos=ready وactivities=true وannouncements=true. هذه **جاهزية مخطط** وليست قبول تشغيل فيديو/واجب/كويز/إعلان أو ملف. المقرر الجديد نُشر صراحة بمسار النشر الحالي لأجل الطالب المصطنع؛ إعادة الاستخدام والتطبيق لا تنشر تلقائيًا. المجموعة والقيد والحساب والمادة fixture SQL معلنة، وليست دليلًا على اكتمال رحلة إدخال J01.

حساب الطالب الجديد أضيف إلى ملفات الدخول الخاصة دون طباعة بياناته ودون تغيير حسابات المستخدم القائمة؛ LOGIN.txt يحتوي تفاصيله. إجمالي الهويات المصطنعة ست. الخلفية الحالية PID **2292** والمنفذ **3001**، والواجهة PID **23012** والمنفذ **8081**. المتصفح http://localhost:8081؛ الجدولة وOpenCode متوقفان.

## التحقق والأوامر

كل أوامر Node التالية استعملت المثبت المتوافق **v24.19.0** في `C:/Users/BaraaWael/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe`؛ نرمز له هنا بـ`N24`.

```text
N24 --import ./node_modules/tsx/dist/loader.mjs --import ./server/tests/helpers/isolated-io-guard.ts --test --test-reporter=spec server/tests/catalog-read-limit.test.ts server/tests/lesson-package-templates.test.ts server/tests/lesson-package-reuse.test.ts server/tests/lesson-package-timing.test.ts server/tests/season-template-import.test.ts server/tests/m2-course-units.test.ts server/tests/m2-course-lessons.test.ts server/tests/m2-course-lessons-reorder.test.ts server/tests/m2-lesson-release.test.ts server/tests/m2-student-course-access.test.ts server/tests/lesson-material-delivery.test.ts
N24 --import ./node_modules/tsx/dist/loader.mjs --test --test-reporter=spec src/tests/*.test.ts src/auth/access-control.test.ts
N24 node_modules/typescript/bin/tsc -p tsconfig.app.json --noEmit
N24 server/node_modules/typescript/bin/tsc -p server/tsconfig.json --noEmit
N24 node_modules/vite/bin/vite.js build
N24 output/activate-demo-lesson-package.cjs
N24 --import ./node_modules/tsx/dist/loader.mjs output/verify-demo-lesson-journey.cjs
N24 output/verify-build45-browser.cjs
```

- Backend المحدد: **410 نجحت، صفر فشل**؛ `output/build45-backend.log`.
- Frontend كاملة: **2233 نجحت، صفر فشل**؛ `output/build45-frontend.log`.
- أنواع الواجهة والخادم والبناء exit 0؛ سجلات `build45-types-app.log`، `build45-types-server.log`، `build45-build.log`.
- MySQL **8.0.44**: تسعة فحوص رحلة HTTP/SQL نجحت؛ `output/build45-live-results.json`. سجل التدقيق المختوم الحالي صالح؛ **16 صفًا غير مختوم** موثقة من المحركات القديمة في وقت الفحص، ومنها تدقيق تطبيق القالب الأصلي. لا نصف تدقيق التطبيق القديم بأنه مختوم.
- Chrome **157.0.8103.38**، **1440×1100**: تجربتان ناجحتان؛ `output/build45-browser-results.json`، وصورتا `build45-application-recovery-browser.png` و`build45-student-browser.png`.
- تحذير bundle ما زال قائمًا: الملف الرئيسي **3910.99 kB / gzip 1114.76 kB**؛ لا ادعاء تحسن حمل أو زمن تحميل.

أول فحص واجهة الطالب كشف عطل الانتقال، ثم عطل حدود القراءة؛ فشلهما ليس قبولًا. الأرقام أعلاه من إعادة الفحوص بعد الإصلاحات. اختبار Chrome يضغط «عرض مواد الدرس»؛ العنوان وحده لا يفتح المادة.

## الحدود والخطوة التالية

تطبيق القالب صار يستعيد سياقه بعد إعادة التحميل؛ **إنشاء/تعديل/أرشفة القالب الأصلي ما زالت عملياتها غير المحسومة بذاكرة الصفحة فقط**. لا ندعي قبول كل أنواع المصادر أو المخطط في الإنتاج، ولا تشغيل مزود/وسائط/موبايل/حمل أو ربط أسرة أو سياسة نشر درجات. اختبار المحاضرات المدفوعة الفاشل سابقًا ما زال مفتوحًا؛ لم تُشغّل كل اختبارات الخادم ولا تدّعى نظافته الشاملة. لا Git/GitHub أو تثبيت/نشر/دفع أو تعديل قاعدة المصدر أو الملفات المحجوزة.

التالي دفعة تشغيل متكاملة لـ**J07 الرجوع بعد الغياب**: إثبات اعتمادياتها على الديمو، ثم مراجعة المدرس وحفظ الخطة وقراءتها من الطالب وسحبها وتغير الأهلية واسترجاع الحفظ بعد الانقطاع، مع إبقاء الغياب بعذر وغير المسجل والإتمام والوصول منفصلة. عقود ربط الأسرة/نشر النتائج وتكليف المصحح وإعادة فتح النتيجة تحتاج تعريفها قبل توسيع سلطتها. OMR اختياري؛ لا نعد بإغلاق الإنتاج أو قياس الفائدة الميداني بهذه الدفعة.
