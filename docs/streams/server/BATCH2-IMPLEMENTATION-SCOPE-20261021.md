# الدفعة الثانية — تنفيذ جديد، ملكية منفصلة

المالك طلب في 2026-10-21 تجهيز أعمال تنفيذ كبيرة للفريقين تحت إشراف Codex. هذا النطاق تنفيذ كود ومهاجرات مصدر جديدة فقط، وليس إذن تطبيق SQL أو تشغيل خدمة/DB/provider أو تحصيل. لا إعادة طلب موافقة على المهام المدرجة؛ أي توسع في الملفات/السياسة يُرفع. المرجع docs17/19 وSERVER-CLOSURE-INVENTORY، وقرارات استبعاد الشهادات وتأجيل SMS باقية.

خط الأساس الأخير: 2592/2592 من الجذر ومن server، typecheck0، diff-check0، بدون force-exit. W1 وW3 وW5 لها قبول محدود؛ C4 تصحيحاتها المحددة مقبولة كعقد غير مركب. لا يعني ذلك إغلاق مرحلة أو تحقق SQL/provider.

## قواعد حاكمة

كاتب واحد لكل ملف، بما فيه الاختبار والتقرير. الحفاظ على الشجرة المتسخة؛ hashes كاملة قبل وبعد، لا reset/clean/stash/checkout/commit/push/merge. لا تطبيق مهاجرات أو Docker/mysqld/listeners/network/secrets/install/realprovider. لا any/ts-ignore أو تخفيف تأكيدات. اختبارات مركزة ومراجعة لكل تسليم، الشامل بعد توقف كل الكتابات. فشل quota/500 لا يبرر بديلًا قبل native termination evidence ولا retries تلقائية. الادعاء بالذرّية يتطلب نفس connection في adapter الحقيقي، لا مجرد callback اسمه transaction.

## WorkBuddy — ثلاث مهام متوازية، ملكية ثابتة

### B2-W4: دورة رفع الواجب وتسليم الملف الآمن

الملفات: `server/src/routes/assignments.ts`, `server/src/services/assignments.ts`, `server/src/services/assignment-storage.ts`, ملفات جديدة `server/src/services/assignment-scan-worker.ts`, `server/tests/m4-assignment-scan-worker.test.ts`, الاختباران القائمان `server/tests/m4-assignments.test.ts`, `server/tests/m4-assignment-storage.test.ts`, العقد `docs/contracts/ASSIGNMENT-UPLOAD-FINALIZE.md`, تقرير `docs/streams/server/B2-W4-ASSIGNMENTS-20261021.md`.

المخرج: abandoned pending_upload لا يحرق حد المحاولات نهائيًا؛ API استكمال/إلغاء محروس وهوية submission/object مثبتة؛ finalize/retry نظيف وتزامن يمنع تكرار النسخة؛ immutable object/version binding عند الجاهزية عبر قدرة المخزن المعلنة أو fail-closed إذا غير متاحة؛ لا السماح بقراءة موظف لملف غير clean أو foreign. مراجعة admission size: لا تدّع أن max_bytes في JSON يقيد PUT. نفذ قدرة حقيقية متاحة من الـSDK الحالي إن أمكن دون مزود، وإلا صرّح بقصور adapter وتوقف العملية غير الآمنة بدل ضمان كاذب.

scan worker قابل للتشغيل صراحةً من injected scheduler/store، لا timer تلقائي/index؛ bounded claim/concurrency/backoff/attempts مع CAS باستخدام أعمدة موجودة، وأي أعمدة ناقصة يرفع عقدها دون DDL. scanner absent لا clean، malware quarantine غير قابل للقراءة، scanner errors ليست infected، لا retry عشوائي لنتيجة غير مؤكدة، verdict مربوط بالنسخة المفحوصة لا clientmetadata. لا اختيار provider أو تسمية extension كفحص malware. إذا provider capabilities تمنع مسارًا، أكمل بقية التنفيذ وأعلن هذا الحد. لا إضافة grading أو empty-category/late-finalize سياسة. التسليم الحصري لملفات assignments إلى Claude C2 يأتي لاحقًا فقط.

القبول: pending abandoned+legitimate resubmit، duplicate finalize/retry، foreign/missing/modified object/version، scanner missing/clean/infected/timeout، retry exhaustion، byte cap قبل read where supported، teacher authorized download فقط لو existing scope/contracts يسمح وإلا لا endpoint مرتجل، no unsigned public bucket. اختبارات المصدر الحقيقي ونوعه، لا placeholders.

### B2-W9: منفذ outbox والإشعارات الفعلي ككود

الملفات: `server/src/services/notification-outbox.ts`, `server/src/services/delivery-channels.ts`, `server/src/routes/notifications.ts`, الجديد `server/src/services/notification-worker.ts`, `server/tests/m6-notification-worker.test.ts`, القائمان `server/tests/m6-notification-outbox.test.ts` إن موجود و`server/tests/m6-delivery-channels.test.ts` إن موجود، تقرير `docs/streams/server/B2-W9-OUTBOX-20261021.md` وعقد جديد `docs/contracts/NOTIFICATION-WORKER-CONTRACT.md`. لا إنشاء اختبار قائم مفترض دون التأكد من اسمه؛ المسارات الجديدة المحددة متاحة.

المخرج: runner explicit start/stop/runOnce لا يعمل عند import، bounded batch/lease، same tenant/principal، consume claim/dispatch/retry/dedupe الموجودة بدل state machine ثانية، contact resolver purpose-checked، adapter registration readiness، receipt/external-id وحالة unknown، STOP/unsubscribe من مصدر consent الحالي قبل الإرسال. لا تغيير اختيار ledger vs preferences أو semantics global unsubscribe، لا تسجيل email/phone/OTP/token/body.

خطأ نتيجة إرسال غامضة لا يعاد كأنه definitely-unsent؛ stale lease يحتاج fencing أو report blocked، لا الاستيلاء بالعمر وحده. no external exactly-once claims. adapter email/SMS بلا مزود يرد unavailable وليس sent. ربط producer endpoints القائمة في notifications فقط إذا authority/event contract قائم؛ producers في مجالات أخرى إلى عقد hooks لا edits. إعداد عقود startup/graceful-shutdown للمالك I1، لا index edit.

القبول: parallel claims no double dispatch، consent withdrawn before send denies، unknown result quarantines reconciliation، transient+permanent errors، tenant mismatch، private logs redacted، stop drains bounded and closes owned handles. لا إرسال خارجي.

### B2-W6: قياس storage/watch والمصالحة

الملفات: `server/src/services/video-usage-events.ts`, `server/src/services/playback-progress.ts`, `server/src/services/video-asset-lifecycle.ts`, `server/src/routes/video-assets.ts`, الجديد `server/src/services/media-usage-reconciliation.ts`, `server/tests/media-usage-reconciliation.test.ts`, وتقرير `docs/streams/server/B2-W6-MEDIA-METERING-20261021.md`؛ اختباران جديدان مسموحان `server/tests/video-usage-storage.test.ts`, `server/tests/video-usage-replay.test.ts`. لا secure-video/playback-session-policy/assignment edits.

المخرج: storage byte meter للأصول من بيانات server/provider-verified فقط، idempotent transitions upload/replace/delete/retry، ledger/event unit واضح للتخزين والwatch بدون خلطهما بعدد الطلاب، cumulative counters قابلة لإعادة البناء ومصالحة mismatch بغير تعديل صامت. observed bytes من metadata ليست proof مزود حي؛ لا أرقام من client. fractional money غير موجود هنا، لا اشتراك ولا charge. اربط الأحداث بحدود lifecycle الموجودة وcontext tenant/principal ثابتة، failure atomicity أو outbox contract واضح دون إضافة notificationdependency غير لازمة.

القبول: duplicate/out-of-order callback، replacement delta not double count، delete cannot go negative، no foreign event، counter rebuild matches known events، forged client byte claim ignored، reconciliation reports scoped discrepancy. أعمدة/worker دائم غير متاحة تُرفع كI2 لاحق لا invent SQL columns.

## Claude / OpenCode — schema وledger وتوصيل وظائف الدفعة السابقة

### B2-C-SCHEMA: مالك وحيد لكتابة schema الجديدة

الملفات الجديدة فقط: `server/migrations/20261021_01_exam_manual_publication.sql`, `server/migrations/20261021_02_internal_financial_ledger.sql`, `docs/contracts/B2-SCHEMA-CONTRACT-20261021.md`, `server/tests/b2-schema-contract.test.ts`, تقرير `docs/streams/server/B2-C-SCHEMA-20261021.md`.

قبل كتابة SQL اقرأ migration09/كل schema ذات صلة وManualGradingStore/PublicationStore وdb types؛ لا تفترض reviewer/version أعمدة غير موجودة. design: revision append history، attempt CAS version، reviewer/time، publication unique(tenant,enrollment,course) versioned، FK composite يمنع foreign linkage حيث يمكن إثبات existing unique key دون destructive rebuild. ledger accounts/journals/lines/idempotency/reservations حسب C-LEDGER contract أدناه. DECIMAL integer-minor أو BIGINT exact، no FLOAT. old service-credit لا يُعاد تفسيره كأموال طالب. لا invoices/refunds/payout provider schema بالجملة.

تجهيز source migrations فقط دون تنفيذ أو DDL runtime/تعطيل FK/تعديل قديم. لا تدعي rollback/data migration مثبتة باختبار regex. بما أن العمليات تحتاج معرفة قبل/بعد، وثّق inventory وforward/recovery proposal، no purge/drop/backfill حقيقي. canonical contract يثبت أسماء الجداول/types/keys/units ويفصل authoring عن application. schema agent يتواصل مع ledger agent قبل تثبيت contract، كلٌ يكتب ملفاته فقط. manifest ملك C-INTEGRATION لاحق.

### B2-C-LEDGER: الدفتر المالي الداخلي، بلا تحصيل

الملفات الجديدة: `server/src/services/billing-ledger.ts`, `server/src/services/billing-reservations.ts`, `server/tests/billing-ledger.test.ts`, `server/tests/billing-reservations.test.ts`, `docs/contracts/BILLING-LEDGER-INTERNAL-CONTRACT.md`, تقرير `docs/streams/server/B2-C-LEDGER-20261021.md`.

المخرج كود domain + transaction store contracts: journal/lines balanced per currency، append-only، stable tenant/idempotency references، debts platform_receivable وmerchant pending/available/reserved وsubscription_credit منفصلة. offsets reversal journals لا edits/delete، credit لا يصبح withdrawable، cash receipt لا يزيد merchant available. reserve/release/consume exactly once مع version/atomic CAS وbounded amounts bigints. اختبار interleaving الذي يعمل عبر store/transactioncallback الحقيقي. لا provider/interface API ادعاء live، لا رموز مزود أو تبديل wallets القديمة. فترة تبريد/رسوم/سياسة dispute غير مقررة تبقى بلا افتراض. لا إنتاج invoice issuance أو debit recurring؛ FIN1 يُستهلك كعقد exact units فقط عند الحاجة.

كل عملية tenant scoped؛ لا account بقيمة غير معروفة يُنشأ تلقائيًا في tenant آخر؛ money serialization strings. استعمل teststore واعرض حدود عدم وجود SQL حتى C-PERSISTENCE. سلّم contract للـschema agent قبل تثبيت02.

### B2-C-PERSISTENCE: محوّلات SQL فعلية — بعد تجميد schema وledger

الملفات الجديدة: `server/src/services/exam-manual-grading-sql.ts`, `server/src/services/progress-publication-sql.ts`, `server/src/services/progress-report-source-sql.ts`, `server/src/services/billing-ledger-sql.ts`, `server/tests/exam-manual-grading-sql.test.ts`, `server/tests/progress-publication-sql.test.ts`, `server/tests/billing-ledger-sql.test.ts`, تقرير `docs/streams/server/B2-C-PERSISTENCE-20261021.md`.

قدّم adapters تستعمل schema01/02 والعقود القائمة فعليًا، connection-bound tx/audit via existing db/sealed writer بلا pooled autocommit داخل transaction. answer-grade CAS+revision+attemptversion+audi­t atomic؛ finalize يقرأ أحدث revisions نفسconn؛ publication initial-row race unique/CAS، no published record mismatch؛ ledgerbalanced+idempotency+reserve constraints. sql authority تستمد tenant والطالب/المجموعة؛ لا fallback raw grades أو result-release غير معتمد.

Read model لا يخترع aggregate صفر عند عدم دعم مصدر أو جدول مفقود؛ existing approved helpers/scoring فقط، unresolved grade publication policy يبقى denied/unavailable. no provider/live engine. tests تسجّل actual SQL/params وتنفذ adapter methods، لا تعيد كتابة SQL في mock وتصفه كتكامل MySQL. أخطاء FK/duplicate handled بدقة، unknown errors ليست success.

### B2-C-INTEGRATION: كاتب الملفات المشتركة — بعد مراجعة Codex للثلاثة أعلاه

محجوز له فقط: `server/src/index.ts`, `server/bootstrap/m1/manifest.json`, الجديد `server/src/services/school-reporting-wiring.ts`, `server/tests/b2-production-wiring.test.ts`, تقرير `docs/streams/server/B2-C-INTEGRATION-20261021.md`. لا تعديل auth/db/helpers ولا existing mounting tests دون scopeextension.

أثناء تنفيذ الفرق لا يبدأ integration. بعد مراجعة Codex وfreeze للعقود: register source hashes migrations01/02 في manifest مرة واحدة، no execution؛ factories فعلية من adapters بعد قراءة العقد، protected mounts جديدة للمراجعة اليدوية/تقاريرالحضور/التقدم تحت existing API+impersonation guards. لا duplicate routes ولا إعادة شهادات، لا تسريب pending نتائج. capability/config/schema readiness تحقق خادمي fail-closed عند missing tables، لا runtimeDDL ولا استدعاء DB عند import. readiness عبر injected/proven capability لا ادعاء تطبيق schema. CORS exposes X-Results-Truncated فقط مع الحفاظ على القائمة القائمة. توصيل notification worker startup ليس ضمن هذه المهمة قبل قبول W9 وعقد explicit codeintegration؛ ارفع followup.

اختبار الـdefault production factory مع fake conn يعكس actualtransaction، anonymous401 zero datastore، teacher unrelated403، ownerpositive، oldroute contracts preserved، missing schema503 no data/sideeffect، one mount and preserved order. لا productionfinancial API exposed في هذه الدفعة.

## ترتيب وتبعيات التنفيذ

1. WorkBuddy: W4 وW9 وW6 بالتوازي حسب السعة، كل ملف اختبار حصري.
2. Claude: SCHEMA وLEDGER عاملان منفصلان؛ يتفقان على contract عبر المشرف دون كتابة مشتركة.
3. PERSISTENCE لا يبدأ قبل توقفهما ومراجعة تطابق contract (يرفعان التصادم أو نقص القرار إلى Codex).
4. INTEGRATION لا يبدأ إلا بعد قبول Codex الجزئي للمخرجات المطلوبة؛ لا إطلاق تلقائي بمجرد reported.
5. review/focused tests لكل مهمة، full regression بعد إعلان توقف الفريقين. المهاجرات الحية والتحقق المالي F1 ومزودي scan/payment/live خارج هذه الدفعة.

## تقدير الإنجاز

لا توجد أوزان مهام أو قياس مجهود معتمد يعطي نسبة دقيقة. التقدير السابق65–75% من اتساع تنفيذ السيرفر لم يُعد حسابه بعد الجرد. للتحاور فقط يمكن القول **نحو ثلث الشغل التنفيذي باقٍ، وقد يزيد المجهود الفعلي عن ذلك** لأن ledger/live/providers/operational gates كبيرة. لا نقدّم 2592 اختبارًا على أنه نسبة جاهزية إطلاق، ولا ننقص نسبة تلقائيًا لأننا قسمنا البنود لمهام أكثر.
