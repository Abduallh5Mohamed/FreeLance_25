# BUILD-41 — متابعة طلبات الدعم حسب آخر تحديث ومسؤولها

**7 نوفمبر 2026**. تنفيذ مباشر بواسطة Codex ضمن تفويض المالك، واستكمال للخطة الحالية دون تشغيل OpenCode أو إعادة الجدولة. المرجع [الخطة 22](../22-business-strategy-integration-ar.md)، والحالة والباقي في [قائمة التنفيذ](BUSINESS-EXECUTION-QUEUE.md). هذه أدلة تحقق محلية، وليست قبولًا مستقلًا أو إنتاجيًا.

## السلوك المنفذ

أضيف قسم قابل للفتح داخل صفحة الدعم الحالية بعنوان **«متابعة الطلبات حسب آخر تحديث»**، خاص بمن يملك سلطة دعم المنصة المثبتة. لا تُرسل طلبات متابعة وهو مغلق. عند فتحه، يختار الموظف:

- «المسند لي» لحسابه الحالي، أو «بلا مسؤول». لا اختيار لحساب موظف آخر أو مؤسسة من العميل.
- طلبات جديدة/بانتظار الدعم، أو طلبات بانتظار المستخدم. المحلولة والمغلقة خارج هذه الفلاتر؛ القوائم الأصلية باقية بعقودها.
- مدة عدم تحديث: أي مدة أو 24 ساعة أو 3 أيام أو 7 أيام. هذا فلتر عمل يختاره الموظف، وليس SLA أو وصفًا آليًا لتقصير أو لانتظار رد.

تظهر الأقدم تحديثًا أولًا، 25 طلبًا كحد أقصى في الصفحة، مع مرجع وقت من الخادم ومدة محسوبة منه. الصفحة التالية تستبدل الحالية، فلا تتحول القائمة إلى تجميع غير محدود في الذاكرة. الفلتر الجديد يبدأ قراءة جديدة ويخفي الصفحة القديمة. الرد المتأخر لا يعيد سياقًا سابقًا، وفشل القراءة لا يوصف بأنه قائمة محدثة أو خالية.

النقر على طلب معروض يستعمل مسار فتح التفاصيل الحالي الذي يعيد التحقق من صلاحيتها؛ المتابعة لا تمنح صلاحية بالتكليف وحده. إجراءات الإسناد/التحويل تبقى في التفاصيل بعقودها الحالية. أثناء إجراء إسناد أو إنشاء/رد/تغيير حالة محلي، تختفي المتابعة وتتوقف إجراءات الصفوف حتى إعادة القراءة. إعادة القراءة لا تؤكد نتيجة كتابة غير محسومة ولا تستبدل استرجاع الإيصال.

**المصدر هو `support_tickets.updated_at`**: كتابة الإسناد تحافظ عليه عمدًا، والملاحظات الخاصة لا تجدده. الرد أو تغيير الحالة قد يجدده. الواجهة توضح هذا؛ لم نعتبره وقت آخر رد أو وقت آخر عمل فعلي على الطلب.

## المعمارية والأمان والمخطط

المسار الجديد `GET /api/support-tickets/follow-up` مركب قبل مسارات معرف التذكرة داخل router الدعم الموجود. no-store قبل المصادقة. يمنع انتحال الهوية وbilling-only والمحددات غير المدعومة والجسم غير الفارغ. هوية staff القديمة تظل غير مدعومة.

استُخدم `createSupportWriteService` الحالي لإعادة إثبات الهوية القانونية من users وتوكنها ونشاطها وتعليقها، وصلاحية `support.read` أو super-admin الحالية داخل المعاملة القائمة. لا تكفي ملكية تذكرة أو تسمية دور admin. العمل الجديد قراءة `write:false`، فينتهي بـrollback دون commit أو كتابة أو audit مصطنع. فشل قراءة عادي يعيد المعاملة ويمكن تحرير اتصالها النظيف؛ فشل التنظيف يتخلص من الاتصال. لم تُعدل سياسة نتائج الكتابة المجهولة.

كل استعلام يثبت حساب المسؤول الحالي من الخادم أو NULL للطلبات غير المسندة. لكل حالة فعلية range مستقل بحد 26، ثم دمج SQL محدود بحد 26. الفهرس الجديد بالترتيب `assigned_to,status,updated_at,id`، مع إثبات فعلي له ولأن طوابع الوقت TIMESTAMP بدقة ثوانٍ؛ غياب الإثبات يمنع فحص الصفوف بـ503. هذا ليس قياسًا لتكلفة الاستعلام أو ضمان اختيار المحسن للفهرس.

ملف migration **غير مطبق**: `server/migrations/20261107_02_support_followup.sql`. لا DDL وقت التشغيل. المتابعة تحتاج أيضًا المخططات السابقة التي تتطلبها خدمة الإسناد. القوائم القديمة لا تعتمد على الفهرس الجديد، ولا يتم تفعيل المتابعة على قاعدة فعلية من مجرد وجود الملف.

الصفحات تستعمل موضعًا من وقت التحديث ومعرف التذكرة، ومرجع وقت أول صفحة من `UNIX_TIMESTAMP()` الخادمي. المرجع ثابت أثناء التصفح حتى 30 دقيقة؛ تغيير الفلاتر أو نافذة غير صالحة يرفض المؤشر. الموضع ليس تفويضًا ولا lookup لتذكرة anchor، لذلك يمكن الاستكمال بعد تحويل/حذف الطلب الذي مثّل آخر موضع. التذاكر نفسها ليست لقطة ثابتة؛ تغييرها قد ينقلها خارج الصفحة، وما يقع قبل الموضع يحتاج تحديثًا.

DTO ثابت بثمانية حقول التذكرة الموجودة أصلًا: المعرف والرقم والتصنيف والعنوان والحالة والأولوية ووقتا الإنشاء والتحديث. لا هويات طالبي الخدمة أو المسؤولين أو اتصالاتهم أو وصف أو ردود أو ملاحظات أو سياق درس في القائمة. فحص التكرار والحالات والطوابع والحدود يشمل lookahead أيضًا. لا بيانات متابعة في التخزين المحلي، ولا مزود أو عامل إرسال أو تنبيه تلقائي أو تكلفة مالية.

العقود: [الخادم](../streams/server/J04-SUPPORT-FOLLOWUP.md)، [الواجهة](../streams/client/J04-SUPPORT-FOLLOWUP.md). عقد قائمة المسند لي القديمة محدث للإشارة إلى العرض الجديد مع إبقاء ترتيبها الأصلي كما هو.

## Changed files

- `server/migrations/20261107_02_support_followup.sql` — فهرس إضافي، ملف فقط.
- `server/src/services/support-followup.ts` — الفلاتر والمؤشر المقيدان، فحص الدقة والفهرس، الاستعلام المحدود وDTO.
- `server/src/services/support-writes.ts` — طريقة القراءة الجديدة عبر seam الهوية والصلاحية والمعاملة الحالي.
- `server/src/routes/support-tickets.ts` — route فعلي قبل المعرفات، تحقق المحددات والجلسة المباشرة.
- `src/features/support/follow-up.ts` — نقل no-store قانوني وparser/controller محدود للفلاتر والهوية والصفحات والمهل.
- `src/features/support/SupportFollowupQueue.tsx` — القسم المغلق/القائمة والفلاتر والوقت والفتح والتعليق أثناء الإجراءات.
- `src/pages/Support.tsx` — تركيب فعلي وربط activity gate وعمليات الصفحة بمسار التفاصيل الحالي.
- `server/tests/support-followup.test.ts` — **9 اختبارات جديدة** للمصدر والسلطة والفلاتر والمواضع والدقة والحدود والخصوصية والتنظيف.
- `server/tests/m1-sprint-notification-support.test.ts` — **اختبار HTTP إضافي** على router وJWT والصلاحيات الحقيقيين فوق قاعدة مصطنعة، لإثبات التركيب ورفض المحددات وفشل المخطط المغلق وno-store.
- `src/tests/support-followup.test.ts` — **9 اختبارات جديدة** للدقة والتصفح والهوية والمهل والتعليق والنقل والمكون الفعلي وربط الصفحة.
- `src/tests/m1-sprint-meeting-support-ui.test.ts` — استكمال صادرات بديل API القديم للقراءة الجديدة؛ يبقى بديل النقل رافضًا لأي استدعاء غير متوقع. سلوك القراءة الفعلي له اختبارات مستقلة.
- عقدا المتابعة الجديدان وعقد قائمة الإسناد، هذا التقرير، وقائمة التنفيذ وREADME وFEATURE_MATRIX وملاحظة الإشراف.

حُفظت الأعمال المحلية السابقة ومسارات WorkBuddy المحجوزة. لا Git/GitHub أو تغيير حساب/نموذج أو تثبيت حزم أو تشغيل عامل أو جدولة.

## التحقق النهائي الجديد

من جذر المشروع، PowerShell، باستخدام Node المثبت المتوافق **v24.19.0**:

```powershell
$businessNode='C:/Users/BaraaWael/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe'
& $businessNode --import ./node_modules/tsx/dist/loader.mjs --import ./server/tests/helpers/isolated-io-guard.ts --test --test-reporter=spec server/tests/support-followup.test.ts server/tests/support-writes.test.ts server/tests/group-setup.test.ts server/tests/m2-group-schedules.test.ts server/tests/m2-group-schedules-failures.test.ts server/tests/m2-group-announcements.test.ts server/tests/m2-group-announcements-failures.test.ts server/tests/family-summary.test.ts server/tests/m6-parent-views.test.ts server/tests/m6-parent-links.test.ts server/tests/saved-return-plans.test.ts server/tests/course-return-plan.test.ts server/tests/lesson-learning-evidence.test.ts server/tests/lesson-preparation.test.ts server/tests/lesson-package-templates.test.ts server/tests/lesson-package-reuse.test.ts server/tests/lesson-package-timing.test.ts server/tests/m2-course-units.test.ts server/tests/m2-course-lessons.test.ts server/tests/m2-course-lessons-reorder.test.ts server/tests/m2-lesson-release.test.ts server/tests/m2-public-catalog-composition.test.ts
```

**633 ناجح، صفر فشل، exit 0**. سجل: `output/build41-backend.log`. حارس العزل نشط، دون قاعدة أو شبكة أو listener لهذه المجموعة.

```powershell
& $businessNode --import ./node_modules/tsx/dist/loader.mjs --test --test-reporter=spec server/tests/m1-sprint-notification-support.test.ts
```

**44 ناجح، صفر فشل، exit 0**. سجل: `output/build41-support-http.log`. هذه مجموعة HTTP محلي قديمة تستخدم loopback `127.0.0.1`، JWT/router حقيقيين، وdotenv/mysql بديلين في الذاكرة قبل تحميل التطبيق. شُغلت منفصلة بعد فحص عزلها؛ لم يُعدّل أو يعطّل كود حارس العزل، ولم تتصل بقاعدة أو خدمة خارجية. إدراجها أولًا ضمن مجموعة منع listeners رُفض بالحارس؛ الفصل أعاد التشغيل وفق طبيعة اختبارها بدل اعتباره عيبًا بالمنتج.

```powershell
$frontendTests=@(Get-ChildItem src/tests/*.test.ts | ForEach-Object {$_.FullName}) + @('src/auth/access-control.test.ts')
& $businessNode --import ./node_modules/tsx/dist/loader.mjs --test --test-reporter=spec @frontendTests
```

**2197 ناجح، صفر فشل، exit 0**، اختبارات الواجهة الكاملة الحالية. سجل: `output/build41-frontend.log`. بديل API القديم كان يفتقد صادرات الوحدة الجديدة وتم تصحيحه قبل هذا التشغيل النهائي؛ لم تُحذف حالات أو تُستبدل اختبارات النقل الفعلي ببديل ناجح صامت.

```powershell
& $businessNode ./server/node_modules/typescript/bin/tsc -p server/tsconfig.json
& $businessNode ./node_modules/typescript/bin/tsc -p tsconfig.app.json --noEmit
& $businessNode ./node_modules/vite/bin/vite.js build
```

الثلاثة **exit 0**. السجلات: `output/build41-server-types.log` و`output/build41-client-types.log` و`output/build41-vite.log`. تحذير الحزمة الكبيرة قائم؛ الرئيسية **3,856.24 kB** وgzip **1,099.35 kB**، دون قياس زمن تحميل أو ادعاء حل مشكلة الحجم.

## الحدود والباقي

لم تُستخدم قاعدة فعلية أو تُطبق migration أو تُفعّل قنوات أو مزودون أو نشر أو دفع أو أسرار. الفحوص لا تثبت تنفيذ SQL الجديد على MySQL أو دقته وخطة تنفيذه وعزله وتحمله الفعلي؛ كذلك لا يوجد قبول متصفح أو جهاز أو فريق خدمة حقيقي. اختبارات hooks والنقل وHTTP المعزول لا تساوي ذلك.

633 و44 هما مجموعتان محددتان وليستا كامل اختبارات الخادم. فشل المحاضرات المدفوعة الموثق سابقًا يظل مفتوحًا. مصدر المتابعة سيبقى unavailable دون الفهرس والمخطط الفعليين، فلا تُعد قراءة القائمة القديمة إثبات تشغيله.

J04 تظل جزئية: سياسة استجابة معتمدة إن طلبت، وربط هويات موظفي السناتر وسياقات أخرى، وقبول القاعدة والأداء والرحلة فعليًا لم تُستكمل. لا نسمي طلبًا متأخرًا وفق التزام غير معتمد، ولا نرسل تذكيرًا أو نوسع صلاحية موظف تلقائيًا.

التالي **J08 — التصحيح بالسؤال**: فحص محرك التصحيح اليدوي والتقييم والتكليف الحالي قبل تحديد عقد السؤال ومعيار التصحيح وأثر إعادة التصحيح وسجلها، دون محرك تقييم مكرر أو نشر درجات مفترض للأسرة. OMR اختياري، وبقية الرحلات والبوابات قائمة في قائمة التنفيذ. الجدولة تظل متوقفة؛ لا إعلان بانتهاء الاستراتيجية أو قبول إنتاجي.
