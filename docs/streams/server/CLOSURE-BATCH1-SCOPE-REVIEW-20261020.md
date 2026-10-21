# تثبيت نطاق الدفعة الأولى — قيد موافقة المالك على التنفيذ

> **تحديث موافقة 2026-10-20:** المالك وافق صراحة على تنفيذ هذه الدفعة للفريقين في المحادثة. Codex فعّل بصمات W1/W2/W3/W7 وW5 المشروط بقبول W3، وأذن بإطلاق Claude C1a/C3a/C4a/C7a FIN1. عبارة انتظار الموافقة في متن التحضير أدناه أصبحت تاريخية؛ حدود النطاق التقنية والتشغيلية لم تتغير. سجل الموافقة: `WorkBuddySupervisorBridge/handoff/CLOSURE-BATCH1-EXECUTION-APPROVAL-20261020.json`. لا موافقة جديدة مطلوبة لهذه الدفعة.

راجع Codex مواصفات Claude `OPENCODE-C1-C8-ALLOCATION-20261020.md` ومواصفات WorkBuddy في الجسر `WORKBUDDY-W1-W7-TASK-SPECS-20261020.md`. هذا تثبيت تقني وملكية مقترحة، لا موافقة بشرية مزعومة ولا إذن خدمات حقيقية. docs17/18 تشترط موافقة كل دفعة؛ طلب الجرد وتقسيم العمل وحده لم يتضمن «نفّذ» لهذه المواصفات الجديدة. بعد موافقة المالك على هذه الدفعة يُفعّل Codex بصمات المهام في الجسر ويعطي Claude إذن الإطلاق. لا claims أو وكلاء كتابة الآن.

## اختيارات Codex التقنية الحاكمة

### W1
إصلاح رابط user/enrollment في الـproduction resolver مع حقن طبقة الوصول للبيانات للاختبار، لا إعادة تنفيذ SQL داخل اختبار وهمي. حدود التوكنات إعداد موثق bounded ومختبر، لا قطع الكلمات بصمت. لا تغيير ranking/API أو فهرس في هذه الدفعة.

### W2
استنتاج ملكية الموارد من سلسلة الآباء المثبتة هو مسار إصلاح التصدير في هذه الدفعة؛ توحيد tenant_id عند الكتابة وقيود schema مسار I2 لاحق. direct tenant_id متعارض مع الأب لا يمر. لا أول صف/أول أب عند تعدد الجهات. لا إضافة 32 جدولًا ولا اعتماد تصنيف الـ31 بمجرد أرقام المسح؛ وثّق included/omitted coverage كقائمة محددة مبررة قابلة للمراجعة.

لا تُجرِ مسحًا عالميًا للأيتام ثم تعرض أعدادهم لكل مستأجر: orphan مجهول الملكية لا يوجد دليل نسبته لطالب التصدير، وعدّه قد يكشف نشاط مؤسسات أخرى. أبلغ عن عدم الاكتمال والأسباب ضمن نطاق يمكن إثبات صلته بالمستأجر، أو limitations عامة لا عدّ عالمي. لا IDs أو تفاصيل لمؤسسة أخرى. استعمل parent rows ذات الصلة لإثبات وجود omitted children إن أمكن. لا تدّع اكتمال snapshot transactions إن لم يتحقق.

موارد bounded/page reads قبل بناء JSONL، لا limit بعد تحميل الجدول كله. stale pending لا يُستولى عليه اعتمادًا على العمر فقط بينما عامل قد يكون حيًا؛ ownership/fencing موجود أو report blocked للجزء المحتاج schema. لا migration ولا worker/index wiring جديد. لا حذف صادرات أو PII تشغيلية. الحفاظ على API plural القائم.

### W3
يشمل حجز `server/tests/m1-security-videos.test.ts` إضافة إلى الملفات في specs. مصدر durable موحد لكل طلب manifest/media/key/refresh، no-cache fail-open، self/support authority مثبت. منع الطلب الجديد التالي هو معيار الإغلاق؛ لا وعد بقطع bytes سبق إرسالها ولا requirement مفتعل بإلغاء CDN أو response بدأ فعليًا. إغلاق session map أثر محلي ثانوي بعد commit، ليس جزء rollback SQL؛ التدقيق والتغيير الدائم ذرّيان، والفشل المحلي لا يحيي session ملغاة. لا فرض «حدثي audit» لمجرد العدد؛ أحداث مفيدة صحيحة بلا تكرار.

### W5
توسيع صريح إلى `server/src/routes/materials.ts` و`server/src/security/video-access-policy.ts` واختبارات جديدة مستقلة. يمنع رابط tenant أجنبي/مجهول/متعارض، ويزيل اختيار أول أب في policy. لا يفرض منع فيديو مشروع متعدد الدروس بلا عقد: أعد use existing supported association semantics، ambiguity deny. لا يقال إن unique على lectures وحده يحمي الارتباطات عبر tables.

لأن W3 يعتمد سلوكيًا على policy الذي سيتغير، **W5 ينتظر مراجعة وقبول W3** رغم عدم تداخل ملفات الكتابة. locking الفيديو مع كل مسارات الكتابة المتأثرة قد يثبت serialization بلا unique إذا تحققت كل الشروط؛ حتى live SQL proof لا يوصف كضمان مكتمل. تصميم قيد I2 يرفع كمتطلب بلا كتابة migrations.

### W7
حجز نفس الملفات المحددة في specs فقط. مهلات checks محلية محدودة مع cleanup لأي timeout handles، بلا polling/timers خلفية أو index. no-store على denials، method bounded labels وعمق/cycles Error. افصل liveness عن dependency readiness. Empty readiness يحتاج explicit configured opt-in إن كان مدعومًا أو not-ready؛ لا نجاح تلقائي لنشر غير موصول، وراجع existing consumers/tests بدل حذف assertions. alerts/jobs instrumentation في I1 لاحقًا.

## Claude/OpenCode — قيود الدفعة المعتمدة تقنيًا

- **C1a:** منطق versioned manual grading وعقد persistence/transaction واختباراته، وrouter factory غير مركب فقط. لا تعديل legacy manual-grading router، ولا writes إنتاجية لجداول غير موجودة. reviewer/feedback/revision contract يُسلّم I2 قبل SQL wiring؛ schema assumptions مؤقتة مصرح بها كعقد، لا اختراع deployment. لا كشف نتائج student ولا retakes/draft precedence.
- **C3a:** تقارير manual من attendance_records فقط، filtering/assigned group/aggregate/export audited وفق الحدود الموجودة. لا نقل legacy truth أو reconciliation تلقائي أو تغيير سياسة الحضور. لا expose reason/correction_reason الخاص في student/parent response؛ الحقول المعلقة لا تخرج حتى حسمها. report router factory جديد دون index؛ existing endpoints shapes محفوظة. schedules files وC3b خارج هذه الدفعة.
- **C4a:** published-report service + injected store + unmounted router factory واختباراتها فقط. **لا تعديل parent-views/parent-links الحالية في هذه الدفعة** قبل تخزين publication معتمد؛ لا إغلاق كل grades القائمة بحجة column غير موجود. projection يفصل unpublished/published وقائمة حقول explicit مطابقة للعقد المتاح؛ cadence وحقول جديدة معلقة. لا raw-grade fallback يزعم published protection.
- **C7a FIN1 فقط:** ملفات pricing/basis/periods الجديدة واختباراتها، لا billing-invoices ولا SQL ولا تحصيل. BigInt/rational وحساب نصف لأعلى مرة واحدة، price snapshot input مستقل، intervals union per tenant/user، الحدود والأرقام في docs19. event source الحقيقي C5 لاحق. 96h الموثقة لا يعاد سؤالها ولا تطبق collection الآن.

C2 ما زال محجوزًا حتى تسليم W4. C5–C8 المالية اللاحقة ليست معتمدة من هذا التثبيت. كل domain agent يكتب في ملفاته واختباراته وتقريره فقط؛ التعديل في عقد يتشاركه آخر يرفع للتنسيق.

## I2 وI1

Codex مسؤول تنسيق I2 وله سجل schema واحد؛ لا مطوّر مجال يكتب migration/manifest. الإعداد الأول عقد schema قراءة/توثيق لـC1 ثم C4، ثم C2/C3b/FIN حسب التبعيات؛ تعيين منفذ schema والـallowedPaths وموافقة دفعة authoring منفصلة قبل كتابة SQL. التطبيق في DB يحتاج تفويضًا حيًا مستقلًا.

I1 index/auth/CORS/mounts مالك واحد منفصل، بعد domain contracts/schema وموافقة التكامل. لا يعد أي mock-only deliverable ميزة production كاملة.

## موجة الإطلاق بعد موافقة المالك

WorkBuddy W1/W2/W3/W7، وClaude C1a/C3a/C4a/C7a وفق السعة. W5 بعد قبول W3. focused tests/typecheck provisional أثناء الكتابات؛ الفحص الشامل بعد توقف الطرفين. لا DB/Docker/mysqld/listeners/secrets/provider/Git mutations/installs. 429 توقف وبلاغ مرة، لا retries بديلة فوق عامل محتمل. اختبارات acceptance جزء كل تسليم ومراجعة نهائية، لا قبول ذاتي.
