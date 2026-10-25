# جرد المتبقي الفعلي للمنصة — 2026-10-24

## النتيجة العددية وحدودها

**26 حزمة عمل مفتوحة في الجرد الحالي:18 تنفيذ/تكامل/تهيئة +8 تحقق/قبول.** هذه وحدات تخطيط غير متساوية الجهد؛ ليست26ميزة ولا26%، ولا يمكن تحويلها إلى نسبة إتمام زمنية أو وزن تجاري بدون تقدير ومراجعة معايير قبول كل حزمة. رقم80%السابق غير مدعوم بهذا الجرد ولا يُستخدم baseline. هذا حد أدنى عملي من الفجوات المعروفة، وليس إثبات عدم وجود عيوب إضافية أو مسحًا سطريًا كاملًا لكل ملف.

لا ينفي هذا إنجازًا كبيرًا موجودًا: المسارات الأساسية للطلاب/المحتوى/التصحيح/الحضور/search/playback والإدارة موجودة، وتسليمات الإشعارات الأخيرة نفذت source حقيقيًا. لكن الجاهزية لا تساوي وجود الكود. الشهادات مستبعدة بقرار المنتج اللاحق، ولا تعد هنا عملًا مطلوبًا لمجرد ظهورها في roadmap قديم.

## مرجع النسخة والدليل

- مرجع المنتج docs/02 وdocs/17 مع قراراتdocs/19، وتوزيع الملكية/master الحالي مع overridesالبشرية اللاحقة.
- primary:codex/workbuddy-server عند8d47b16 ومعه تغييرات محلية جديدة؛ remote main تأكد بالقراءة عندcc0e91a23f661a244d14cfcae7733487f7a0af02. نسخة main تحتويM2 مختلفة؛ لا تُستبدل عشوائيًا بالـprimary.
- فحص27مسارًا ماليًا/schema في نسخة كلود المنفصلة:21 isolated-only،3different-source،3same-source. عدد ملفات، لا نسبة إنجاز. Snapshot C:/Users/abdua/opencode-reports/PLATFORM-INVENTORY-FINANCE-SNAPSHOT-20261024.json.
- مراجعتان مستقلتان للواجهة/الجلسات وللسيرفر الدراسي والوسائط، إضافة إلى جرد Codex للمالية والإشعارات والتشغيل. الأدلة قراءة مصدر وتقارير معروفة؛ لا compiler/tests/browser/SQL/services/providersأُجريت في هذا الجرد، ولا مصدر تطبيق تغيّر. لا يثبت هذا حالة إعداد إنتاجية أو غياب أسرار أو نجاح نشر.
- ملاحظة: WorkBuddy اعترف بأن آخر حملاته مرورمقيّد؛ الملفات غير المقروءة لم تتحول إلى مغلقة تلقائيًا.

## التنفيذ والتكامل والتهيئة المتبقية —18

| ID | الحزمة | شرط الإغلاق المتبقي | دليل/مكان |
|---|---|---|---|
| R01 | توحيد النسخة التي ستُسلّم | تثبيت نسخة تسليم موحدة وتتبع مصادر التغييرات وحل تعارضات الفروع مع حفظ M2؛ هذه حزمة تجميع فقط، ولا تعيد احتساب تنفيذ إصلاحات الواجهة أو وحدات المال أدناه. لا push أو merge جديد مُنفّذ في هذا الجرد. | primary HEAD8d47b16+local مقابل maincc0e91a؛ src/pages/Auth.tsx في نسخة دمجmain؛ تقارير Codex الحديثة |
| R02 | الجلسات وMFA فعليًا | مصدر migration لـlogin_sessions وخطة القطع؛ حفظ sid عند إصدار token مساحة الطالب؛ تركيب واجهة MFA المحلية والـstep-up؛ تفعيل الحارس لا يتم قبل تحقق المخطط. | server/src/routes/auth.ts:65؛ middleware/auth.ts؛ student-enrollment.ts:754؛ PlatformMfaPanel.tsx محلي فقط؛ CODEX-LOGIN-SESSION-SCHEMA-REQUEST-20261023.md |
| R03 | الأساس المالي والفواتير والهوية | مراجعة/تسليم نسخة كلود ثم دمج العلاقة القانونية والفترات والفواتير والدفتر كوحدة متسقة؛ حسم منتج journals إصدار الفاتورة/حساب الإيراد والاستحقاق وملاحظات التسوية المفتوحة. | 21 من27 مسارًا ماليًا/schema في النسخة المنفصلة فقط،3مختلفة؛ CLAUDE-FINANCE-LIVE-CONTRACT-PROGRESS-20261023.md |
| R04 | التحصيل وcheckout | دمج orders والإثباتات والallocations وتسوية الفرق مع APIs؛ ربط verified payment بcanonical order ودورة التزام المنصة، ومصالحة callbacks. لا استخدام service-credit كمال تاجر. | payment-checkout*.ts وbilling-collection*.ts في النسخة المنفصلة؛ طلب عقد platform obligation lifecycle |
| R05 | المحفظة والصرف والاسترداد والنزاعات | دمج التمويل والحجوزات والمقابل المحاسبي والتحقق من المزود؛ القرارات غير المحسومة تبقى held؛ لا إتاحة الصرف بوجود دين غير قابل لإثباته. | billing-payouts*.ts وbilling-refunds*.ts وbilling-settlement*.ts في النسخة المنفصلة؛ FIN9/FIN10 |
| R06 | العرض المالي canonical | ربط واجهات الإدارة وقراءات debt/pending/available/reserved/subscription_credit بالدفتر والفواتير الحقيقية؛ عدم تقديم المحفظة القديمة كبديل. | billing-read-models.ts في النسخة المنفصلة؛ docs/19؛ صفحات المحافظ/الإدارة الحالية ليست إثبات ربط بهذه الوحدات |
| R07 | البث والحضور الآلي والتسجيل | دمج schema R16–R24 ومحولاتها؛ createLiveRuntime/router غير مركبين؛ توفير verifier ومطابقة المشاركين/tickets/هوية التركيب؛ caller checkpoint دائم ومصالحة الحضور. | لا createLiveRuntime caller/mount في primary index؛ live-runtime-factory.ts؛ وثيقة live §§14–20 |
| R08 | الوسائط والقياس الدائم | تمثيل موحد video→lecture/material ومعالجة القديم الغامض؛ تركيب مخزن metering الحقيقي بعد المكتبة، وإبقاء التزام القياس قابلًا للمصالحة عبر فشل المزود/انتهاءgrace. | video-assets.ts:704–720 omits meterStorage؛ createSqlMediaMeteringStore بلا production caller؛ R9/durable accounting held |
| R09 | فحص الواجبات | مخزن دائم لمحاولات/leases/retry/exhaustion، ماسح حقيقي وحدود فشل، وتركيب start/stop/drain؛ pending_scan ليس clean. | assignments.ts:2250 productionMalwareScanner=undefined؛ لا caller لـcreateAssignmentRecoveryRuntime |
| R10 | التنظيف الآمن للملفات | إثبات دائم لكل نسخة مع backfill موثوق؛ exact-version adapter؛ توصيل cleanupObligations/objectVersionColumn؛ تقدم الصفوف المسمومة دون إسقاطها؛ سياسة retention/orphans صريحة. | assignment-cleanup-recovery.ts unconditional legacy_etag_unprovable؛ assignment-storage.ts:615 conditionalDelete:false؛ assignments.ts:2291+ |
| R11 | تصدير بيانات المستأجر | دمج owner/epoch/lease schema وحقن ownership port؛ تركيب job/storage lifecycle؛ coverage/omissions واتساق snapshot واحتفاظ namespaces غير المشار إليها. | tenant-export.ts:494 ownership:undefined => unavailable؛ لا قبول لتصدير مُركّب من مصادر ناقصة |
| R12 | الإشعارات الفعلية | عقد ومخزن اتصالات purpose-scoped حقيقي؛ تركيب runtime في index والتوقف/drain؛ مزودون وقوالب وأهلية رسائل معتمدة. source worker الجديد وحده ليس إرسالًا. | notification-contact-sql.ts يعيد configured:false دائمًا؛ notification-runtime-factory.ts غير مركّب؛ review dual-lane source completed |
| R13 | دورة الدرجات والامتحانات | سياسة retake/draft/release/archived questions؛ grade void/revision history؛ حسم canonical essay-answer rows ثم إصلاح unchecked answer update إن كان عيبًا فعليًا؛ finalize→gradebook مراجعة كاملة. | WORKBUDDY-CLOSURE-ACADEMIC-20261022.md؛ manual-grading.ts held finding؛ وجود routes لا يثبت السياسة |
| R14 | الجداول ومصادر الحضور | سياسة التعارض وإنشاء السلاسل؛ توحيد legacy/new/live attendance والمصالحة والخصوصية. لا إعادة سباق المجموعة الذي أصلحه Codex بالفعل. | academic doc policy-held؛ attendance-records.ts locked current authority fix موجود؛ automatic-live source غير موصول |
| R15 | ولي الأمر والتقارير المنشورة | اكتمال provisioning هوية/اتصال ولي الأمر وإبطال/liveness العلاقة؛ الحقول والوتيرة والcomposer/receipts وفق سياسة النشر. لا raw-grade fallback. | parent-views.ts published-only موجود؛ C4-R1/R2 في الجرد السابق؛ قرار الحقول/الوتيرة لم يثبت إغلاقه |
| R16 | الرصد والجاهزية التشغيلية في المصدر | استكمال hooks metrics للعاملين وbacklog حقيقي وalerts/SLO/runbook؛ single-flight/admission موجودان في ops.ts بالفعل ويحتاجان مراجعة وتحقق لاحق، لا إعادة تنفيذ. | ops.ts يحتوي createSingleFlightProbe يحتفظ بالعملية غير المنتهية؛ timeout ليس إلغاء؛ لا worker gauge wiring مثبت؛ CODEX-OPERATIONS-CLOSURE-20261022.md |
| R17 | إغلاق رحلات الواجهة | دمج تحسينات الإدارة/student reports/manual grading/exam review/workspace switching منprimary؛ مراجعة حالات unavailable/draft/stale response لكل رحلة؛ إزالة auth PII logs وتثبيت تغطيةRTL/English/a11y. | CODEX-STUDENT-SESSION-CLOSURE-20261024.md؛ CODEX-ADMIN-LOAD-MUTATION-CLOSURE-20261024.md؛ اختلافprimary/main موثّق |
| R18 | تجميع السكيما والمهاجرات | بعد أن تنتج الحزم المالكة migrations المطلوبة، تُراجع هنا فقط قائمة manifest وbootstrap وترتيب التنفيذ والتوافق بين المهاجرات وخطة backfill وقدرة runner. لا يُعاد احتساب كتابة مخطط الجلسات أو live أو cleanup أو القياس أو التصدير ضمن هذه الحزمة. | primary لا يحتوي migrations20261022/23 المنفصلة؛ manifest/SQL application غير متحقق؛ FINANCE-SCHEMA-INTEGRATION-INVENTORY-20261024.json |

## بوابات التحقق والقبول —8

هذه لاحقة للتنفيذ، وليست إعادة كتابة للميزة. «لم يثبت» لا يعني بالضرورة «لا يعمل»؛ يعني أنه لا توجد أدلة حالية كافية على النسخة المجمّعة. تحتاج هذه الأعمال التفويض والبيئة الملائمين، ولا يقدّم هذا الجرد إذن تشغيل جديدًا.

| ID | البوابة | المطلوب |
|---|---|---|
| V01 | الترجمة والاختبارات المركّزة | تشغيل compiler/typecheck واختبارات العقود المتأثرة بعد إذن مستقل، وإصلاح التوقعات المتعارضة دون إضعاف الثوابت. لا نتائج قديمة كدليل لآخر source. |
| V02 | Regression ومصفوفة الصلاحيات | API/files/video/jobs/export/socket وtenantA→B/teacherA→B/branch/session-change/MFA/impersonation/revoke على النسخة الموحدة. |
| V03 | MySQL الحقيقي | مهاجرات clean+upgrade+recovery وCHECK/index/collation/BIGINT/affectedRows/locks/deadlocks/restart/unknown commit على بيئة معزولة مصرح بها. |
| V04 | تجارب المزوّدين والتخزين والدومين | scanner/object version/conditional delete/live callbacks/DRM/playback/email/SMS/PSP sandbox وDNS/TLS/custom-domain ownership/recovery عند التفويض والتهيئة. |
| V05 | القبول المالي | فواتير وتسوية وcheckout/allocations/رصيد/حجز/صرف/refund/dispute مع replay/overpayment/failure/restart، مع حفظ الفترات المدفوعة وحدودال96ساعة. |
| V06 | القبول بالمتصفح | رحلات المدرس/الطالب/المسؤول/ولي الأمر، تبديل الهوية، الملفات والتصحيح، حالات فشل البيانات، RTL/English/accessibility والأجهزة المعتمدة. |
| V07 | الأداء والتحميل | بيانات واقعية وفهرسة/latency للبحث والتصدير، pool/queue/memory bounds، load/soak وp95/error/queue lag، سيناريو مزود متعطل. |
| V08 | التعافي والإطلاق | backupDB+objects مشفر واسترجاع معزول متسق،audit-chain/financial-balance reconciliation،RTO/RPO، مراجعة التهيئة/الأسرار دون كشفها،deploy/rollback/runbooks وقبول الإطلاق. |

## ترتيب التنفيذ العملي

1. توحيد النسخة والتسليمات (R01)، مع الحفاظ على مصدر كل lane. لا نقل من نسخة كلود قبل التحقق من توقف الكاتب وتسليم الملكية.
2. تثبيت عقود المخطط وإثبات النسخ والجلسات والمال والاتصال، ثم إغلاق R18 وR02–R06. تستمر الأعمال المستقلة في الواجهة والتشغيل بالتوازي.
3. تركيب السلاسل المعطّلة في R07–R12، وإنهاء سياسات ومصالحة المنتج في R13–R15، ثم إغلاق الرصد والرحلات في R16–R17. لا يكتب عاملان الملف نفسه.
4. المرور ببوابات V01–V08 على نسخة متسقة وفق الاعتماد. يمكن إجراء تحقق مبكر مركّز عند تفويضه؛ هذا الجرد لا يدّعي إجراءه.

## تصحيحات أُغلقت في المصدر فلا تُحسب مرة أخرى

- سباق صلاحية مجموعة الحضور: إعادة فحص المدرس من الصف المقفول الحالي، مع حفظ منح المالك ومنشئ الجلسة.
- منع الكتابة بلا معاملة للحضور والموافقات، وإزالة تعريف scanStop المكرر.
- رفض CSV الدرجات الناقص، وإزالة المؤقّت من الاستيراد ثم ربط دورة بدء/إيقاف صريحة.
- إغلاق تجاوز الثقة في ETag؛ التنظيف نفسه يظل غير متاح حتى إثبات النسخ.
- إصلاح طول مفتاح تكرار تقرير ولي الأمر وتجويع استعادة طابور الإشعارات.
- حماية تبديل مساحة الطالب وتنزيل التقارير من الردود التابعة لجلسة قديمة.

هذه إصلاحات مصدرية. بقاء بوابة التحقق مفتوحة لا يعني إعادة كتابتها، كما أن إغلاقها في المصدر لا يثبت نجاحها على قاعدة أو مزوّد حقيقي.

## ماذا نقول عن النسبة؟

الجرد يقدّم عددًا محددًا للحزم المعروفة المتبقية ووصفًا لإغلاقها، لا نسبة مصطنعة. لحساب نسبة قابلة للدفاع نحتاج ربط معايير قبول المنتج في docs/17 بدليل من نسخة موحدة، وأوزان جهد أو قيمة متفق عليها. لا نساوي ترحيلًا ماليًا بصفحة واجهة أو بتصحيح سطر، ولا اختبارًا قديمًا بتحقق التسليم الحالي.
