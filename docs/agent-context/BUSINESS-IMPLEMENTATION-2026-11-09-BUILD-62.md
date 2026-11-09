# BUILD-62 — مراجعة التشغيل والأداء المحلية

تاريخ العمل: **9 نوفمبر 2026**. تنفيذ المهمة الكبيرة5 على النطاق المحلي المأذون، مع قراءة المصدر واختبارات مستقلة عن تقارير الدفعات السابقة. لا قبول ذاتي للإنتاج أو إعلان اكتمال التوسعات أو الخدمات المؤجلة.

## المشاكل التي ظهرت والإصلاح

### تكرار استعلامات صفحة المصحح

الـrouter كان يثبت هوية المصحح والمخطط، ثم يعيد الهوية وثلاث قراءات information_schema لكل تكليف من25. القياس **قبل تعديل المصدر** أثبت180 استعلامًا للصفحة، منها78 للمخطط.

أُضيف `listGradingAssignments`: إثبات الهوية والمخطط مرة واحدة داخل معاملة الطلب نفسها، ثم إثبات كل تكليف ومدرسه الحالي وتعليقاته المعيارية وقراءة label المحدودة. إثبات الموارد private داخل الخدمة، دون خيار عام لتجاوز السلطة، ودون cache بين الطلبات. المسار المستقل لحفظ/قراءة تكليف ما زال يثبت كامل السلطة. الصفحة المفلترة تحفظ مؤشر المرشحين الأصلي ولا تخترع نهاية عند سحب بعض التكليفات. البيانات الفاسدة أو المخطط غير المتاح لا يصبحان نجاحًا جزئيًا.

### تعارض الأقفال بين المدرس والمصحح

الجولة الأصلية من72 قراءة HTTP عند تزامن1/4/8 أظهرت **3 نتائج غير متوقعة**:503 لاختيارات المدرس و500 لقراءتين مخولتين بالرفض الخاص. أعيد إنتاج `ER_LOCK_DEADLOCK` في تجربة مستقلة باتصالين MySQL، بين إثبات هوية المدرس T وقراءة تكليف للمصحح G تحتاج المدرس المسؤول T؛ الطالب أو بياناته لم يُغيّرا.

أُضيف `lockAcademicTenant` قبل أقفال المستخدم/العضوية في `grading-authority` و`teaching-authority`. كلا الإثباتين كان يقفل tenant أصلًا ضمن JOIN؛ الإصلاح يحدد ترتيب الاكتساب: **tenant ثم actor ثم الموارد/المدرس المسؤول**. القفل لا يمنح سلطة ولا يستبدل فحص العضوية والحساب الحاليين. لا retry تلقائي أو تخفيف صلاحيات.

إعادة نفس تجربة الاتصالين نجحت لكليهما دون deadlock. هذا بروتوكول للمسارات المتأثرة وليس إثباتًا بأن كل writers القديمة تلتزمه. ترتيب الأقفال يزيد انتظار بعض الطلبات المتزامنة؛ لا تُعرض الطلبات الفاشلة السريعة كتحسن أداء.

### رؤوس الكاش عند الفشل المبكر

- تعطل reporting القديم503 كان يعود بلا `Cache-Control`. أصبح wrapper يضع `no-store` قبل المصادقة/فحص الجاهزية، ويشمل401/503 والأخطاء اللاحقة. المخطط ما زال غير جاهز503؛ لا migration أو bypass.
- حساب موظف السنتر كان يُرفض مبكرًا بـ`CENTER_ACCOUNT_ONLY` قبل الوصول لرؤوس feature router. أُضيف `no-store` لهذا الرفض في المصادقة الصارمة والاختيارية. لا تغيير للدور أو grants أو أجسام الأخطاء.

## القياس قبل وبعد

العينة:26 تكليفًا اصطناعيًا أُضيفت داخل outer transaction فقط، وكل صفحة25 عنصرًا. نفس fixture/criteria، اتصال MySQL دافئ واحد، طلبان warmup ثم12 طلبًا مقاسًا. router الأصلي مع principal حقن معلن وrequest savepoints. كل الصفوف الإضافية **ROLLBACK**، وhash الجداول الأصلية مطابق قبل وبعد.

| المقياس للصفحة | قبل | بعد نهائي |
|---|---:|---:|
| الاستعلامات |180|81|
| استعلامات المخطط |78|3|
| الوسيط p50 |57.07ms|17.14ms|
| p95 nearest-rank |60.44ms|20.37ms|

الانخفاض **55% في عدد الاستعلامات** ونحو70% في وسيط عينة الصفحة. p95 محسوب من12 عينة صغيرة؛ ليس تقديرًا مستقرًا لأحمال الإنتاج. القفل المشترك الجديد أضاف استعلامًا واحدًا، لذلك الدليل النهائي81 لا80 من التجربة الوسيطة.

EXPLAIN على27 صفًا اختار `uq_grading_assignment_question` مع `Using filesort` للترشيح؛ فهرس actor موجود، ولم نفرض index hint أو DDL بناءً على هذه العينة الصغيرة. اختبار البيانات الممثلة والحمل الممتد ما زال مطلوبًا.

### HTTP الأصلي

72 طلب GET ببيانات الديمو المحتفظ بها،24 عند كل مستوى1/4/8. تشمل المقررات، تكليف المصحح، التحضير، متابعة الرجوع، الموسم، رفض الأدمن/المدرس الأجنبي، وreporting503 **المتوقع**. تحققنا من المحتوى والسلطة والكاش، لا status200 وحده.

| التزامن | الطلبات | p50 النهائي | p95 النهائي | نتائج غير متوقعة |
|---|---:|---:|---:|---:|
|1|24|7.63ms|32.78ms|0|
|4|24|21.69ms|56.43ms|0|
|8|24|43.23ms|64.97ms|0|

الجولة النهائية مستقلة عن تشغيل Chrome المتوازي؛ جولة التنافس مع Chrome محفوظة منفصلة في `build62-http-after-concurrent-chrome.json`، وأزمنتها لا تُستخدم في الجدول. مع إصلاح ترتيب الأقفال اختفت الأخطاء في هذه الجولة، لكن بعض الوسائط زادت مقارنة بالأصل عند التزامن بسبب الانتظار؛ لا ادعاء بتسريع كل route.

CPU للعملية الأصلية زاد0.3125 ثانية خلال الجولة؛ working set من163168256 إلى163999744 بايت، والـpeak219193344 بايت. هذه لقطات عملية واحدة على آلة واحدة وليست profile كاملًا أو حد موارد مقبولًا إنتاجيًا. لا قياس event-loop داخل الخادم أو انتظار pool مفصل أو استقرار heap ممتد.

**44 قراءة إضافية** عند تزامن4/8 تمزج الطالب المختار، موظف السنتر، المدرس، المصحح، عميل الدعم وأدمن دعم المنصة: صفر نتائج غير متوقعة وصفر ردود بلا no-store في الجولة النهائية. الطالب يقرأ محاولة نهائية موجودة، لا يبدأ/يحفظ/يسلم محاولة جديدة.

المجموع116 قراءة في مجموعتي الجولة النهائية، لا ادعاء بأن116 مستخدمًا كانوا متزامنين؛ الحد8. رد403/404/503 المتوقع مفصول عن الخطأ. اختبار أولي ظن واجهة تعيين دعم المنصة متاحة للعميل؛ المصدر أثبت أنها خاصة، فصُحح السيناريو لقراءة العميل تفاصيل طلبه، دون توسيع المنتج. رفض الموظف المبكر بلا رأس cache كان عيبًا حقيقيًا وأُصلح.

## الحفظ الذي لم يصل تأكيده

خضعت عملية تجديد تكليف موجود **لنفس المدرس والمصحح والمعيار** لحالتين على MySQL الحقيقي عبر router الأصلي:

1. hook المعاملة يرفض قبل تنفيذ COMMIT:503، الاتصال يُستبعد، rollback/إغلاق الاتصال يرجع الكتابة. GET أصلي مصادق يعيد `receipt:null`، والتكليف ثابت. لا إعادة POST تلقائية.
2. ينفذ MySQL COMMIT فعلًا ثم يرفض hook تأكيده:503 مع استبعاد الاتصال، لكن GET أصلي مصادق يثبت الإيصال المحفوظ. replay الصريح المطابق بعد ثبوت الإيصال يعود200 تاريخيًا، دون زيادة version أو audit مرة أخرى.

بقي **تجديد اصطناعي واحد مقصود** للتكليف، مع version أحدث وتدقيق مختوم وإيصال، دون تغيير صاحب المقرر أو المصحح أو المعيار أو منح وصول جديد. لم تُحذف هذه الآثار لإخفاء التجربة. ملف `build62-commit-fixture.json` يحفظ مفاتيح التجربة ومراحلها؛ rerun يسترجعها بدل تجديد إضافي. أسئلة/محاولات/مراجعات/درجات/awards سابقة وحقول أمان الحسابات تطابق hashes السابقة، وسلسلة audit الحقيقية تتحقق.

هذه **أخطاء ACK محقونة في transaction adapter** مع COMMIT حقيقي، وليست انقطاع TCP فعليًا. الطلب المحقون يستخدم principal fixture معلنًا؛ الاسترجاع/replay يستخدمان native authentication/HTTP. الإيصال الغائب يظل مقفولًا ويحتاج تسوية معتمدة؛ لم نُضف ممحاة علامات أو retry أو صلاحية grading لأدمن تبويب.

أثناء بناء runner أُصلح غياب `req.path` من harness وافتراض خاطئ أن audit-head اسمه1؛ رأس النظام الحقيقي `audit-chain-head`. لم تُغير هذه التصحيحات المصدر الإنتاجي أو تكرر COMMIT المقصود، والقبول هنا من نتيجة الجولة المكتملة لا المحاولات الفاشلة.

## الاختبارات والأدلة الحالية

`NODE24` هو الملف المثبت:

```text
C:/Users/BaraaWael/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe
```

```text
NODE24 output/run-build62-backend.cjs
NODE24 --import ./node_modules/tsx/dist/loader.mjs --test src/tests/*.test.ts src/auth/access-control.test.ts
NODE24 node_modules/typescript/bin/tsc -p tsconfig.app.json --noEmit
NODE24 node_modules/typescript/bin/tsc -p server/tsconfig.json --outDir output/build62-server-dist
NODE24 node_modules/vite/bin/vite.js build
NODE24 --import ./node_modules/tsx/dist/loader.mjs output/measure-build62-grading.cjs before
NODE24 --import ./node_modules/tsx/dist/loader.mjs output/measure-build62-grading.cjs after
NODE24 --import ./node_modules/tsx/dist/loader.mjs output/verify-build62-lock-order.cjs before
NODE24 --import ./node_modules/tsx/dist/loader.mjs output/verify-build62-lock-order.cjs after
NODE24 output/measure-build62-http.cjs before
NODE24 output/measure-build62-http.cjs after
NODE24 output/verify-build62-roles.cjs
NODE24 --import ./node_modules/tsx/dist/loader.mjs output/verify-build62-commit.cjs
NODE24 output/prepare-build62-browser.cjs
NODE24 output/verify-build62-workspace-browser.cjs
NODE24 output/verify-build62-workforce-browser.cjs
NODE24 output/verify-build62-quiz-terminal.cjs
NODE24 --import ./node_modules/tsx/dist/loader.mjs output/verify-build62-original-flow-sql.cjs
```

أوامر `before` شُغلت **قبل إصلاح المصدر المقصود**؛ تشغيلها على المصدر الحالي لا يعيد baseline ولا يتوقع إعادة deadlock القديم. نُسخ الأدلة الأصلية محفوظة. المتابعة Native تتطلب جلسات ديمو جديدة بعد إزالة cache المؤقت؛ لا تطبع مفاتيح أو كلمات مرور، ولا تعِد تشغيل الخادم لتجاوز حد مصادقة.

- **918/918 خادم في49 ملفًا محددًا**، بلا skipped؛ ليس backend كاملًا. يحتوي مركز/هوية/دعم/حضور/تصحيح/مخطط/تحضير/رجوع/موسم، والاختبارات الجديدة لحدود الصفحة وترتيب الأقفال والكاش المبكر.
- **2300/2300 واجهة كاملة**، بلا skipped. أنواع التطبيق وبناء الخادم وVite ناجحة. تحذير546.45kB/gzip169.41kB للحزمة الأساسية وBrowserslist باقٍ؛ لم تثبت حزمًا.
- SQL: قياس الصفحة قبل/بعد، سباق الأقفال قبل/بعد، و**7 مجموعات تراجعات أصلية** من دورة المدرس عبر MySQL، مع outer rollback ومساواة12 مجموعة state/security hashes وصفر probe باقية في تلك المجموعات.
- COMMIT: **4 مجموعات تحقق**، بنوعي الإثبات الموضحين أعلاه؛ تجديد واحد باقٍ مقصود، لا نخلطه بـzero-persisted rollback tests.
- Chrome: **7** لمساحة المدرس (منها استبدال الهوية وتعطل الشبكة و390px بعد طي القائمة) + **2** للمصحح وموظف السنتر + **1** لطالب يقرأ محاولة مسلمة، دون أي exam POST. native APIs/MySQL ولا نجاح mocked. صُحح محدد اختبار الطالب ليختار زر الكويز داخل التقييمات، لأن الحصة تجمع واجبًا وكويزًا؛ لم يُغيّر المنتج لإرضاء المحدد.
- فُحصت صور المصحح والموظف بصريًا، وسائر screenshots في artifacts الحالية. viewport ليس جهازًا حقيقيًا؛ لا تدّعي تجربة مستخدم بشري.

Logs/results: `output/build62-backend.log`، `build62-frontend.log`، `build62-app-types.log`، `build62-server-types.log`، `build62-vite-build.log`، `build62-grading-before/after.json`، `build62-lock-order-before/after.json`، `build62-http-before/after.json`، `build62-role-results.json`، `build62-commit-results.json`، `build62-browser-results.json`، `build62-workforce-browser-results.json`، `build62-terminal-browser-results.json`، `build62-original-flow-sql-results.json`.

## Changed files

المصدر:

- جديد `server/src/services/academic-lock-order.ts`.
- تعديل `server/src/services/grading-delegation.ts`، `grading-authority.ts`، `teaching-authority.ts`، `school-reporting-wiring.ts`، `server/src/routes/grading-control.ts`، `server/src/middleware/auth.ts`.
- جديد `server/tests/grading-assignment-page.test.ts`، `academic-lock-order.test.ts`.
- تحديث fixtures/اختبارات العقد: `grading-authority.test.ts`، `question-grading.test.ts`، `teaching-workspace.test.ts`، `season-course-reuse.test.ts`، `season-template-import.test.ts`، `helpers/lesson-package-fixture.ts`، `b2-production-wiring.test.ts`، `center-team-identity.test.ts`.

أضيفت runners/نتائج BUILD-62 وقائمة القبول التشغيلي، وحُدث السياق وعقود التصحيح/دورة المدرس. لا تعديل لصفحات/مصادر WorkBuddy المحجوزة أو منطق المال أو تقدم الطالب. لا migration أو تفعيل مخطط أو مزود جديد.

## المتبقي بعد هذه الدفعة

**المراجعة الهندسية المحلية المنفذة ليست إغلاقًا إنتاجيًا للمهمة5.** الباقي: أحجام بيانات وحمل ممثل ومدة ضغط فعلية، توزيع writers وتزامنها، Android/iOS فعليان، تمرير الرحلات لموظفين ومدرسين/طلاب مستقلين، اتساق التصحيح تربويًا، وقياس وقت المهمة الصحيحة قبل/بعد. لا ساعات توفير أو نسبة نجاح بشرية مخترعة.

لا قبول عام لترتيب أقفال كل المسارات القديمة أو TCP partition أو تسوية إيصال غائب. reporting القديم ما زال503، والتشخيص التربوي وملاحظات دائمة وعينة موسم غير المادة لها حدودها السابقة. التخزين والفحص والفيديو وSMS/واتساب وربط الأونلاين وولي الأمر ونشر النتائج له مؤجلة. OMR اختياري.

الديمو8081/3001 باقٍ، PIDs الحالية في `output/dev-session-20261107-1815.json`. كلمات المرور الأصلية لم تتغير، وجلسات BUILD-62 المؤقتة أُزيلت بعد آخر تحقق. الجدولة وOpenCode متوقفان؛ لا Git/GitHub أو مصدر/إنتاج أو نشر أو تثبيت/إنفاق. قائمة الخطوات الميدانية وفحص الانقطاع: [قائمة القبول](OPERATING-ACCEPTANCE-CHECKLIST.md).
