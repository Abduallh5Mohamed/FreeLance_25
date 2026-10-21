# مراجعة Codex للدفعة الأولى — ليست قبولًا شاملًا

## التحقق المستقل

بعد تأكيد توقف Claude/WorkBuddy، وإثبات إنهاء W1 في native log وتحرير حجزه: root 2519/2519، server 2519/2519، لا force-exit، typecheck exit0، diff-check نظيف (تحذير CRLF فقط). السجلات في bridge handoff/batch1-combined-{root,server}-20261020.log. هذه اختبارات معزولة؛ لا SQL/provider/live acceptance.

W3 قُبل نطاق إصلاحه المحدد سابقًا بدليل مستقل197/197 وأصبح W5 READY؛ لا يعاد طلب موافقة المستخدم لتطبيق deny على admin بلا verified tenant/capability، فذلك تنفيذ نطاق الصلاحية المعتمد، لا feature جديد. auth context enrichment منفصل عند الحاجة، لا fallback role-only.

## تصحيحات Claude اللازمة داخل النطاق المعتمد

### C4 — منع تسرب داخل المستأجر/الفرع

مصدر `routes/progress-reports.ts` في GET `/`: إذا حذف العميل `course_id`، لا ينادي deps.authority، ويقرأ listRecords لكل tenant ثم يطبق branch_id من query فقط. غياب selector لا يجوز أن يوسع الصلاحية. وفي publish/unpublish فحص course authority وحده لا يثبت انتماء الطالب/المجموعة للفرع المسموح.

التصحيح: server-scoped allowed courses/student groups لكل row، branch context من principal وmembership لا query وحدها؛ owner positive وteacher exact relation؛ صلاحية كل نتيجة سواء selector موجود/محذوف/مزوّر. لا اكتفاء بbranch membership للوصول لطلاب المدرسين الآخرين. row source يجب أن يستقبل scope أو يطبق قرارًا صريحًا قبل أي projection/export/publication. اختبارات مدرسين في tenant واحد وفرع واحد لكن مجموعتين مختلفتين، وفرعين مختلفين، وحذف course/branch selectors، owner positive، publish/unpublish على طالب غير مخول يرفض بلا كتابة أو audit نجاح. لا تغير سياسة enrolled relation المختلف عليها؛ استعمل عقد authority مصرح يثبت exact relation، fail-closed عند الغموض.

### C4 — الذرّية ليست optional

`ProgressPublicationServiceDeps.transaction?` وrouter deps يتيحان fallback مباشر store+audit. عند فشل audit بعد transition يمكن أن يبقى publication mutated. اجعل transaction seam مطلوبًا عند الإنشاء/الmutation، أو ارفض الإعداد الناقص قبل الكتابة. لا autocommit fallback. اختبر rollback على المصدر/contract الحقيقي، ولا fake يفرض rollback بلا أن يمرر الكود callback الصحيح. parentProjection يجب ألا يقبل record نشر لمفتاح تقرير آخر عند إعطائه PublicationRecord؛ اربط tenant/enrollment/course في العقد والاختبار حيث تتوافر الهوية. لا توصيل إنتاجي أو تعديل parent-views الآن.

### C1 — تثبيت عقد السباق داخل transaction

الـrouter يحسب plan من bundle قبل دخول transaction، وappendAnswerGradeRevision input لا يحمل expected attempt version/state، بينما finalize يعتمد version من bundle قديم. هذا لا يثبت أن مراجعة جواب لا تصل بعد finalize أو أن finalize لم يستخدم أحدث revision. لا نقول إن SQL الحي معيب لأنه لم يكتب بعد؛ نقول إن العقد الحالي لا يضمن invariant.

اجعل إعادة قراءة/قفل attempt+latest revisions وتخطيط score داخل transaction-bound store، أو optimistic guard يشمل كل answer revision مع bump attempt version وفحص pending على كل كتابة. finalize يقفل/يتحقق نفس المصدر. اختبارات interleaving: grade بعد finalize مرفوض بلا revision، وتغيير revision بعد قراءة finalize إما يظهر في total أو409؛ لا final total قديم مع success. audit داخل نفس seam محفوظ. لا schema SQL أو shared source تعديل. owner C1 فقط على ملفاته الجديدة واختباره وتقريره.

هذه التصحيحات ضمن دفعة المالك المعتمدة؛ لا موافقة ثانية مطلوبة. C3a/FIN1 نجحا في الحزمة لكن لم تتم مراجعتهما سطرًا بسطر؛ لا قبول production أو schema/mount.

## W1

الأدلة الأصلية: session01a15a8b-bd10-780d-be79-2d43518760a9 / agent98cb357b. log2026-10-20 lines43868/43884 RUN_FAILED->idle,43885–43886 cleanup release+completed,43889 terminal502. Codex حرّر الحجز باستخدام retire، لم يستخدم claimToken. source orphan محفوظ. recovery task جديدة للتحقق والتقرير، لا انتحال تقرير العامل القديم ولا إعادة كتابة عمله من الصفر.
