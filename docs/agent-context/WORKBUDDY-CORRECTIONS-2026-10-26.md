# تصحيحات مراجعة WorkBuddy — جاهزة للنسخ

انسخ النص التالي إلى WorkBuddy. هذه تصحيحات محددة لتقرير الدفعات الخمس، وليست
تفويضًا بتفعيل مزودين أو بيانات حية.

```text
قرار المراجعة المستقلة: الدفعتان 2 و4 مقبولتان محليًا ضمن نطاقهما؛ الدفعات
1 و3 و5 تحتاج التصحيحات التالية قبل قبولها. اقرأ AGENTS.md ثم
docs/agent-context/README.md وENGINEERING_RULES.md، وبعدها قسم العيب فقط من
docs/agent-context/SUPERVISOR-REVIEW-2026-10-26.md. اقرأ ملفات الدفعة قبل
التعديل. احفظ كل التعديلات المحلية الموجودة.

ممنوع تمامًا استخدام Git أو GitHub طوال المهمة، حتى للفحص: لا status/diff/log
ولا add/commit/push/pull/fetch/checkout/reset/stash/clean، ولا remote/PR ولا
أدوات GitHub. افحص الملفات مباشرة من IDE أو بأوامر قراءة ملفات عادية. لا DB
حية أو migrations أو مزودين أو نشر أو تثبيت حزم أو أسرار.

تصحيح A — كاش صفحة المدرس العامة:
الملفات: server/src/routes/public-identity.ts،
server/tests/m2-c1-c4-public-identity.test.ts،
server/tests/m2-public-catalog-composition.test.ts،
docs/agent-context/FEATURE_MATRIX.md عند تغير الحالة فقط.
قراءة فقط: docs/streams/client/M2-22-CONTRACTS.md وpublic-catalog.ts.
الرد الحالي لصفحة /api/public/teachers/:id يحمل public,max-age=60 رغم أن
قائمة الكورسات قد تسحب نشرها. اجعل رد الصفحة no-store مثل public-catalog
واختبر رأس الرد في النجاح والفشل ومحتواه بعد سحب النشر. لا تعيد تسريب draft
ولا توسع DTO؛ اختبار SQL وحده لا يثبت سلوك الكاش.

تصحيح C — مبلغ الرسوم وخطأ refresh الحقيقي:
الملفات: src/features/fees/payment-workflow.ts، src/pages/Fees.tsx،
src/tests/fees-payment-workflow.test.ts، ويمكن إضافة اختبار صفحة ضيق عند الحاجة.
ارفض المبلغ غير المطابق كاملًا (مثل 12abc)، الكسور التي لا يقبلها خادم المال
(مثل 1.234)، والقيم غير المحدودة/غير الموجبة قبل أي request. لا تعتمد على
HTML number input كحارس وحيد. حالياً loadFeesFromDB تبتلع الخطأ، لذا
runPaymentFlow لا يرى فشل refresh بعد نجاح updateFee: مرر النتيجة أو الخطأ
بصورة صحيحة مع إبقاء استدعاءات التحميل الأخرى آمنة. اختبر ربط الصفحة لا seam
محَقونة فقط، وأثبت أن الحفظ المؤكد لا يظهر كفشل كتابة وأن القائمة لا توصف
بأنها محدثة وهي قديمة. لا تضف تحصيلًا إلكترونيًا أو سياسة رصيد.

قبل الموافقة على رحلة دفع إنتاجية، جهّز تقريرًا منفصلًا عن
server/src/routes/fees.ts:516 (كتابة paid_amount المطلقة من العميل، التزامن،
التكرار والتدقيق). لا تغيّر هذه المالية الخادمية ولا تفعّل الدفع في هذه
الدفعة دون عقد واضح؛ حالة هذه الرحلة تبقى «واجهة محلية مصححة فقط».

تصحيح E — invariant ترتيب M2-23:
الملفات: server/src/routes/course-lessons.ts،
server/src/routes/course-units.ts،
server/tests/m2-lesson-release.test.ts،
server/tests/m2-course-units.test.ts،
server/tests/helpers/m2-course-lessons-harness.ts عند حاجة fixture محددة،
docs/streams/server/M2-B15-CONTRACT.md وdocs/agent-context/FEATURE_MATRIX.md
عند تغير العقد/الحالة.
المشكلة الأولى: reorder ينقل prerequisite من 1 إلى 5 والتابع من 2 إلى 6؛
الحالة النهائية صحيحة لكن السيرفر يرجع 409 لأن proveDependentOrder يقارن
بترتيب التابع القديم. استخدم موضع التابع النهائي عندما يكون في نفس batch.
اختبر طلبًا صحيحًا وطلبًا مقلوبًا معًا، بلا كتابة عند الرفض.
المشكلة الثانية: PATCH ترتيب وحدة إلى موضع بعد وحدة درس تابع يقلب شرط
prerequisite العابر للوحدات؛ route الوحدات تفحص archival فقط. أضف إثباتًا
محدودًا للحالة النهائية قبل UPDATE مع فشل مغلق عند تجاوز الحد، واختبر
القبول/الرفض والتزام audit. حافظ على سلطة tenant/course من السيرفر.
لا تطبق migration ولا تربط درسًا بفيديو/ملف هنا.

بعد كل تصحيح: شغّل اختباراته المحددة ثم catalog M2-23 suites وأنواع/بناء
الجانب المتأثر. اختبارات frontend الكاملة التي تحتاج registerHooks يجب أن
تستخدم Node متوافقًا مثبتًا، ولا تُعد فشل Node 22.14 عيبًا في الكود. قدّم
Changed files، السلوك المثبت، الأوامر ونتائجها، الحدود الباقية. لا تستخدم
أرقام تقريرك السابق كدليل جديد، ولا تعتبر تقريرك قبولًا ذاتيًا.
```
