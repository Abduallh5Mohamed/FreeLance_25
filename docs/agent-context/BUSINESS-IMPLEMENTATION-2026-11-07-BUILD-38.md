# BUILD-38 — حفظ خطة الرجوع وقراءتها الخاصة للطالب

تاريخ التنفيذ: **7 نوفمبر 2026**. استمرار مباشر بتفويض المالك ونقل التنفيذ إلى Codex؛ الجدولة متوقفة. المرجع: [الخطة 22](../22-business-strategy-integration-ar.md)، [قائمة التنفيذ](BUSINESS-EXECUTION-QUEUE.md). هذه أدلة تحقق محلية، وليست قبولًا مستقلًا أو إنتاجيًا.

## السلوك المنفذ

بعد مراجعة مسودة BUILD-37، يستطيع المالك حفظ الخطة أو استبدالها بإصدار متوقع، وسحبها صراحة. كل تغيير يجمع رأس الخطة ومراجعة ثابتة وسجل التدقيق وإيصال العملية في معاملة واحدة. تعارض الإصدار يرفض التعديل؛ فشل كتابة المراجعة أو التدقيق أو الإيصال يعيد المعاملة. تكرار نفس العملية والطلب يعيد الإيصال التاريخي، وتغيير محتواها أو صاحبها يرفضه الخادم. تطبيع معرف المقرر يمنع اختلاف حالة حروف UUID من إنشاء نطاق ثانٍ.

الحفظ يعيد إثبات المالك والمقرر والطالب والأدلة وأهلية الخطوات ورمز المراجعة؛ لا تكفي معاينة قديمة. السحب لا يشترط بقاء قيد الطالب نشطًا. استرجاع إيصال عملية يظل مقيدًا بالمالك الحالي والمقرر وصاحب العملية، ويمكنه تأكيد نتيجة سابقة بعد انتهاء قيد الطالب.

فقد الرد بعد محاولة commit نتيجة غير محسومة؛ لا يتحول إلى فشل كتابة مؤكد ولا يعاد POST تلقائيًا. الواجهة تحفظ قبل الطلب علامة sessionStorage محدودة بمعرف العملية والإصدار والحالة المتوقعة ومعرف خطة موجودة عند الحاجة؛ لا تحفظ رمز دخول أو أسماء أو بيانات حضور أو محتوى الخطة. إعادة التحميل تستعيد استعلام GET فقط. فشل تخزين العلامة يمنع الطلب. غياب الإيصال أو تعذر التحقق يبقي الحالة غير محسومة. نجاح الحفظ المؤكد يبقى ظاهرًا حتى عند فشل تحديث القراءة أو تنظيف العلامة.

تجمد الواجهة تغيير السياق أثناء الكتابة أو غموض نتيجتها. قفل نافذة المقرر يجمع قفل القوالب وقفل خطة الرجوع، فلا يحرر أحدهما الآخر. رأس القراءة يحمل وصف «نسخة الخطة وقت هذه القراءة»؛ الإيصال التاريخي ليس ادعاءً بتحديث القائمة الحالية. تغير الجلسة يخفي البيانات الخاصة.

أضيفت قراءة الطالب ولوحته داخل لوحة الطالب: هوية طالب فعلية وقيده المختار يعاد إثباتهما من الخادم، ولا تعتمد الصلاحية على محددات الواجهة. تعرض القراءة خمس خطط كحد أقصى في الصفحة وثلاث خطوات للخطة. لكل خطوة إثبات جمهور الدرس الحالي؛ الخطوة التي فقدت صلاحيتها تعرض موضعًا وحالة عدم إتاحة فقط، دون معرفها أو عنوانها أو مدتها. الخطة المسحوبة أو مقررها غير المنشور لا يعودان إلى نسخة أقدم. نقص مخطط الإثبات يرفض الصفحة كاملة. تقدم catalog يعرض منفصلًا؛ لا توجد كتابة إكمال خطة أو فتح قفل أو تمديد اشتراك أو منح وسائط.

## المعمارية والمخطط

- إضافة ملف migration فقط لثلاثة جداول InnoDB: رأس وحيد لنطاق tenant/course/enrollment، مراجعات ثابتة، وإيصالات مستقلة. يوجد فهرس قراءة الطالب وقيد مراجعة إلى الرأس؛ لا نسخ لأسماء أو محتوى الدروس في الخطوات المحفوظة.
- خدمة مشتركة تفحص أنواع الأعمدة وأطوالها وnullability وcollation والمحركات والفهارس وFK وJSON/enum قبل الاعتماد على التخزين. غيابه يبقي المسودة قابلة للقراءة ويمنع الحفظ.
- مسارات المالك تحت tenant-self/catalog، ومسار الطالب `GET /api/tenants/me/catalog/my-return-plans`. التركيب داخل `tenant-self.ts` بعد المصادقة؛ لا تعديل لمسارات WorkBuddy المحجوزة.
- كتابة المالك تستعمل ترتيب الأقفال القائم وإصدارًا متوقعًا. قراءة الطالب معاملة قراءة دون أقفال `FOR UPDATE` جديدة، وتستعمل إثبات جمهور الدرس المشترك بهوية الطلب الحقيقية. اختبارات المعاملات محلية مصطنعة؛ لم يثبت عزل MySQL الفعلي.
- علامة الاسترجاع مرتبطة بالمقرر والمالك. قراءة الطالب تتبع الجلسة ومساحة الطالب بما فيها تغير المساحة دون تغير الرمز، مع إلغاء الطلبات وإهمال الردود القديمة ومهلة محدودة. لا تخزين دائم لبيانات الخطة في واجهة الطالب.

العقود: [الخادم](../streams/server/J07-SAVED-RETURN-PLANS.md)، [الواجهة](../streams/client/J07-SAVED-RETURN-PLANS.md). عقود المسودة السابقة محدثة لتوضيح أن المراجعة وحدها لا تحفظ.

## الملفات المتغيرة

خادم ومخطط:

- `server/migrations/20261107_01_course_return_plans.sql` — ملف غير مطبق.
- `server/src/services/saved-return-plans.ts` — فحص المخطط والكتابة المشتركة والإيصالات.
- `server/src/routes/course-return-plan.ts` — حفظ وسحب واستعلام، وجاهزية التخزين في المعاينة.
- `server/src/routes/student-return-plans.ts` — قراءة الطالب الخاصة.
- `server/src/routes/tenant-self.ts` — التركيب الفعلي.

واجهة:

- `src/features/catalog/course-return-plan.ts` و`CourseReturnPlan.tsx` — الحفظ والسحب والاسترجاع والعلامة والحالات.
- `src/features/catalog/student-return-plans.ts` و`StudentReturnPlans.tsx` — قراءة ولوحة الطالب.
- `src/pages/Courses.tsx` — جمع أقفال نافذة المقرر.
- `src/pages/StudentDashboard.tsx` — تركيب لوحة الطالب.

اختبارات:

- `server/tests/saved-return-plans.test.ts` — 21 حالة جديدة.
- `server/tests/helpers/return-plan-fixture.ts` — استخراج fixture المسودة ودعم المخطط والمعاملة وفقد تأكيد commit.
- `server/tests/helpers/lesson-package-fixture.ts` — بيانات التخزين ولقطات rollback الفعلية داخل harness.
- `server/tests/course-return-plan.test.ts` — استعمال fixture المشتركة مع إبقاء حالات المسودة.
- `src/tests/saved-return-plans.test.ts` — 9 حالات جديدة، منها لوحتا المالك والطالب الفعليتان.
- `src/tests/course-return-plan.test.ts` — جاهزية التخزين وsessionStorage والنص الجديد.
- `src/tests/lesson-package-template-panels.test.ts` — قفل النافذة المجمع.

توثيق: عقدا الحفظ الجديدان، عقدا المسودة الحاليان، وهذا التقرير، وقائمة التنفيذ وREADME وFEATURE_MATRIX وملاحظة الإشراف. حُفظت الأعمال السابقة دون Git/GitHub أو مسارات WorkBuddy المحجوزة.

## التحقق النهائي

استُخدم Node المثبت المتوافق **v24.19.0** دون تثبيت حزم. من جذر المشروع، PowerShell:

```powershell
$businessNode='C:/Users/BaraaWael/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe'
$frontendTests=@(Get-ChildItem src/tests/*.test.ts | ForEach-Object {$_.FullName}) + @('src/auth/access-control.test.ts')
& $businessNode --import ./node_modules/tsx/dist/loader.mjs --test --test-reporter=spec @frontendTests
```

**2174 ناجح، صفر فشل**. سجل: `output/build38-frontend.log`.

```powershell
& $businessNode --import ./node_modules/tsx/dist/loader.mjs --import ./server/tests/helpers/isolated-io-guard.ts --test --test-reporter=spec server/tests/saved-return-plans.test.ts server/tests/course-return-plan.test.ts server/tests/lesson-learning-evidence.test.ts server/tests/lesson-preparation.test.ts server/tests/lesson-package-templates.test.ts server/tests/lesson-package-reuse.test.ts server/tests/lesson-package-timing.test.ts server/tests/m2-course-units.test.ts server/tests/m2-course-lessons.test.ts server/tests/m2-course-lessons-reorder.test.ts server/tests/m2-lesson-release.test.ts server/tests/m2-public-catalog-composition.test.ts
```

**379 ناجح، صفر فشل ضمن النطاق المحدد**. سجل: `output/build38-backend.log`. تشمل الحالات الجديدة تعارض الإصدار، rollback لكل نقطة فشل، فقد تأكيد commit، الاسترجاع بعد انتهاء القيد، السحب والتكرار، نقص المخطط والفهرس وFK، وإخفاء الخطوة أو المقرر بعد فقد الصلاحية. لا يثبت هذا نجاح مجموعة الخادم الكاملة؛ فشل اختبار المحاضرات المدفوعة الموثق سابقًا يظل مفتوحًا.

```powershell
& $businessNode ./node_modules/typescript/bin/tsc -p tsconfig.app.json --noEmit
& $businessNode ./server/node_modules/typescript/bin/tsc -p server/tsconfig.json
& $businessNode ./node_modules/vite/bin/vite.js build
```

الأوامر الثلاثة **exit 0**. السجلات: `output/build38-client-types.log` و`output/build38-server-types.log` و`output/build38-vite.log`. البناء يحمل تحذير الحزمة الكبيرة القائم: الحزمة الرئيسية **3,825.79 kB** وgzip **1,088.13 kB**؛ ليس ذلك قياس سرعة فعلية أو حلًا لمشكلة الأداء.

## الحدود والخطوة التالية

لم تُستخدم قاعدة حية، ولم تُطبق migrations أو يُفعّل مزود أو إرسال أو دفع أو نشر أو تثبيت حزم. لم تُجر تجربة متصفح فعلي أو أجهزة أو تحميل أو query plans أو عزل/تزامن MySQL فعلي؛ الاختبارات تستعمل بيئات محلية معزولة. نجاح اختبارات المكونات لا يثبت قبول تجربة المتصفح أو قيمة ميدانية.

لا إشعارات ولا ربط ولي أمر في هذه الدفعة، ولا واجهة تصفح كامل تاريخ المراجعات. لا تشخيص تربوي أو إثبات فهم أو قياس بدء/إنهاء الخطة. دقائق الخطوات تقدير يحدده المدرس، وإكمال الدرس من سجل catalog القائم؛ لا يُستنتج إكمال الخطة من المشاهدة أو حفظها. صلاحية المحتوى يعاد فحصها عند دخوله، ولا تمنح هذه اللوحة وصولًا إلى وسائطه.

التالي **J06: ملخص الأسرة وأجندة الأبناء المخولة** بعد قراءة عقود الربط والمصادر المنشورة الحالية، مع غياب صريح للدليل الناقص وحماية الدرجات غير المنشورة. تبقى بقية الرحلات والبوابات في قائمة التنفيذ مفتوحة، والجدولة متوقفة.
