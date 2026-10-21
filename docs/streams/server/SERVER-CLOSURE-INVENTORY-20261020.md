# جرد إغلاق السيرفر وتقسيم WorkBuddy / Claude–OpenCode

تاريخ الجرد: 2026-10-20. المرجع الحاكم docs/17 وdocs/19 وقرارات المالك اللاحقة. هذه قائمة إغلاق وخطة توزيع، وليست ادعاء قبول أو تصريحًا بتشغيل الخدمات والمال. لا يبدأ تنفيذ دفعة قبل تثبيت ملفاتها وقبولها وفق docs/18. جرد المصدر لا يعادل تجربة حية؛ احتمال اكتشاف عيوب إضافية أثناء التنفيذ والمراجعة قائم.

## خط الأساس

- HEAD المراجع: `03b7707` مع تغييرات غير محفوظة من الفريقين؛ لا reset/clean/checkout.
- آخر فحص أجراه Codex بعد توقف الفريقين: 2382/2382 من الجذر و2382/2382 من server؛ typecheck ناجح، بدون force-exit. فحص diff أصبح نظيفًا بعد إزالة سطر فارغ زائد فقط.
- الاختبارات المعزولة لا تثبت مزودًا أو schema حيًا أو اكتمال الوظائف. ملفات وتقرير الفحص: جسر WorkBuddy `handoff/combined-verification-20261020.json`؛ بصمة ملف moderation في ذلك التقرير سبقت تنظيف نهايته.
- تصحيحات T1–T5 موجودة واختباراتها ضمن الفحص؛ لا نعيد مهامها بالجملة. الأجزاء المحجوزة للسياسة والتكامل تبقى في هذا الجرد.
- الشهادات A8 مستبعدة. الواجهة ملك مطور آخر. SMS/WhatsApp OTP مؤجل بقرار المالك، ولا يعلن نجاح إرسال وهمي.

## معنى الحالة

«أساس موجود» = مصدر واختبارات موجودان؛ لا يعني قبول كل حالات الوظيفة. «جزئي» = نقص محدد أو تحقق خارجي باقٍ. «قرار» = الجزء التابع له متوقف فقط. لا نسب إنجاز نهائية في هذا المستند.

## تغطية جميع صفوف البلان

| IDs | الوضع الحالي وحد الإغلاق المتبقي | حزمة العمل |
|---|---|---|
| S1,S3,S4 | أساس الهوية والصلاحيات والدعوات موجود؛ يلزم تدقيق قبول المصفوفة الحالية عبر كل المسارات، خصوصًا داخل السنتر | I4 |
| S2,C9,N1 | auth/OTP محلي وسياسة fail-closed موجودة؛ إرسال حقيقي واسترداد/إساءة استخدام مع المزود غير مثبت | W9,D1,I4 |
| S5,S9 | bootstrap/manifest وrestore سابق موجودان؛ تطبيق أحدث schema على fixture جديد واختبارات قبول الوضع الحالي غير مثبتة | I2,I4 |
| S6,Q6 | ملفات خاصة موجودة؛ تصدير ناقص/ملكية nullable واستثناءات غير واضحة | W2,W4,I4 |
| S7,V3,V5 | استحقاق وفحوص كل طلب موجودة؛ مسار support-revoke لا يثبت إيقاف تسليم الجلسة/نسخة أخرى | W3,I4 |
| S8 | اختبارات queue/socket عزل موجودة؛ يلزم قبول السياق لكل العمال والـlive المستقبلي | W9,W10,I4 |
| C1,C4,C5 | أساس صفحات المؤسسة والكتالوج موجود؛ ثغرة ربط video:// بموارد الغير وتعطيل الفيديو تحتاج إغلاقًا | W5,I4 |
| C2 | branding/host موجود؛ الواجهة RTL/English وتسليم العقد للمطور والتحقق الخارجي باقيان | D2,I4 |
| C3 | adapter للتحقق من النطاق موجود؛ DNS/TLS وتجديد/سحب وإثبات منع takeover غير مثبت | D2 |
| C6,C7 | release/sequential موجودان؛ فجوة DST في helper المشترك تحتاج إصلاحًا وفحص replay/time-boundary | I3 |
| C8,C10 | lifecycle/access موجودان؛ ربط العلاقة المؤهلة مع تعدد المدرسين والفوترة وفترات الدفع المحمية يحتاج عقدًا متسقًا | C5,C7,I4 |
| C11,G2 | إصلاحات الجداول/القوائم موجودة؛ idempotency إنشاء السلاسل، lifecycle والإشعارات، وسياسة تضارب الوقت/الصلاحيات | C3,W9,I2,D3 |
| C12 | import موجود؛ بعض مسارات إنشاء الطلاب لا تضمن هوية مستخدم موحدة، مما يؤثر في عد الفوترة | C5,I4 |
| V1 | asset lifecycle/callback state موجود؛ provider verification حي وrecording mapping لاحق | W10,D2 |
| V2,V6 | transcode/ABR/resume لها أساس؛ رفع مستأنف/DRM/device matrix وضعف الاتصال الحقيقي غير مثبت | W10,D2 |
| V4 | watermark موجود؛ منع linking الخاطئ أولًا، ثم فحص العميل/الأجهزة دون ادعاء منع screenshot | W5,D2 |
| V7 | تنزيل offline غير منفذ ضمن قدرة موثقة؛ default deny حتى الحقوق/المزود | D2 |
| V8,O3,O8 | watch events/analytics موجودة جزئيًا؛ storage metering والمصالحة وربط التعريفات بالدفتر المالي غائبة/غير مثبتة | W6,C7,C8 |
| A1,A2,A3 | بنك الأسئلة والنسخ والتصحيح الآلي موجود وتصحيحات T2 مطبقة؛ قبول صلاحيات/حالة/نشر النتائج وقرارات مؤجلة | C1,D3,I4 |
| A4 | manual-grading القديم مركب؛ لا يثبت دعم pending_review في exam_versioned_attempts الجديد مع rubric/revisions | C1,I2 |
| A5 | رفع وتقديم موجود؛ abandoned pending_upload يحرق المحاولة، immutable bytes/scanner/قراءة المعلم غير مكتملة | W4,C2,D2 |
| A6 | gradebook محسّن في T1؛ ربط تقييم الواجب/الامتحان، unique/void/revision، وحالات policy المعلقة باقية | C1,C2,I2,D3 |
| A7 | services/progress-reports.ts موجود؛ اكتمال routes/publish/parent field gates ليس مثبتًا | C4,I1,I2 |
| A8 | مستبعد صراحة، لا blocker ولا إعادة تفعيل | خارج النطاق |
| G1,B3,S10 | مجموعات/فروع وقدرات موجودة؛ قبول المدرس المعيّن فقط عبر المواد والطلاب والمال يحتاج مصفوفة موحدة | C2,C5,C8,I4 |
| G3 | manual attendance موجود ومحسّن؛ reconcile القديم/الجديد وخصوصية السبب والسياسات لم تُحسم | C3,D3 |
| G4,G5,G6 | live join/leave الآلي/الحصص المدمجة/تحويل التسجيل للمكتبة غير مكتمل؛ meetings القديم ليس دليل تحقق قبولها | W10,D2,I2 |
| G7 | تقارير الحضور manual + automatic reconcile ناقصة؛ T3b معلّق على المصدر والسياسة وG4 | C3,W10,D3 |
| P1 | challenge/link/read-token موجود وتدقيقه محسّن؛ provisioning/invalidation/OTP live معلقة | C4,W9,D1,D3 |
| P2 | parent views موجودة؛ published grades/report وattendance boundaries وإبطال الرابط تحتاج إغلاقًا | C4,I2,D3 |
| P3 | consent ledger/atomic unsubscribe موجود؛ مصدر الحقيقة tenant/global/contact semantics يحتاج تثبيتًا | W9,D3 |
| P4,N1 | dispatch/claim/recovery/outbox primitives موجودة؛ تشغيل worker والمنتجون/resolver والتسليم الحقيقي غير مكتملة | W9,D2 |
| P5 | SMS/WhatsApp provider/template/consent receipt غير مثبت ومؤجل | D1 |
| P6,O4 | discussion/moderation tenant/transaction تحسنت؛ policy إغلاق report/restore/retention والتنبيه لم تحسم | C6,W9,D3 |
| P7 | composer/outbox skeleton موجود؛ محتوى/وتيرة التقرير ومصدر البيانات وتسليم receipt تابع لقرارات ومزود | C4,W9,D1,D3 |
| O1,O2,O5 | lifecycle/flags/support لها مصدر واختبارات؛ يبقى فحص lifecycle/permissions/rollback/export المباشر ضمن القبول | I4 |
| O6 | start/approve/revoke atomic والهوية/الصلاحية الحية وexpiry مصححة؛ live rerun بعد الإصلاح، timestamp consistency، banner العميل وتغطية audit باقية | W8,I4,D2 |
| O7 | audit/export/hash موجود ومحسن؛ تغطية كل المجالات والاحتفاظ/الحذف واستعادة الدليل ناقصة | I3,C6,D3 |
| O9 | MFA management/step-up primitives موجودة؛ فرض MFA خادميًا على الأدوار/المسارات الحساسة ليس مثبتًا | W8,I1 |
| Q1,Q2 | server errors/contracts جزء منا؛ RTL/English/accessibility/device/media captions مراجعة عميل منفصلة | D2,I4 |
| Q3 | search موجود؛ student id mismatch مؤكد وأداء normalized LIKE غير مقاس | W1,W7,I4 |
| Q4 | logger/metrics/request IDs موجودة؛ timeout probes/redaction failures/alerts/jobs coverage ناقصة | W7,W9,I4 |
| Q5 | restore M1 قديم موجود؛ backup مشفر DB+objects ودليل استرجاع snapshot الحالي وRTO/RPO غير مكتمل | I4,D2 |
| Q7 | لا دليل حمل p95/error/queue-lag صالح للوضع الحالي؛ لا ادعاء scale من unit tests | I4,D2 |
| Q8 | CI/gates موجودة؛ قبول migration/deploy/rollback ومراجعة الأمن النهائية غير مكتملة | I2,I4 |
| B1,B4,B5 | signup/approval/manual payment أساس جزئي؛ checkout verified callback، immutable price snapshot، offline cash semantics تحتاج إغلاقًا | C5,C8,D2 |
| B2,B10 | قرار التسعير/عد السنتر موثق؛ ليس هناك محرك invoice/price-version/event-union فعلي مطابق | C7 |
| B6 | audience أساس موجود؛ يلزم direct API/file/video/exam/assignment/live acceptance بكل مجال | C2,W3,W10,I4 |
| B7,B8,B12 | instructor-wallet الحالي ليس دفتر تحصيل/محفظة سنتر متوازنة؛ reservations/refund/payout/dispute incomplete | C8,D2,I2 |
| B9 | لوحة/plan analytics أساس؛ تعريف invoice basis/version/reconciliation والرسوم/المراجعة يحتاج تنفيذًا | C7,C8,I4 |
| B11 | renewal/grace أساس calendar month؛ يلزم 30-day UTC cycle و96h وحجز/سداد وحماية الفترات المستقبلية | C7,C8 |
| F1,F2 | بوابات مالية مستقلة: ledger/exact arithmetic/retry/races/provider sandbox لا تزال غير مقبولة؛ تشغيل المال محجوب | C7,C8,I4,D2 |

## حزم WorkBuddy — تنفيذ السيرفر التقني

كل حزمة تملك ملفاتها المذكورة واختباراتها الجديدة وتقريرًا باسم الحزمة. الملفات المشتركة المحددة في قسم I خارج ملكية العمال. أي مسار إضافي يرفع للتنسيق قبل لمسه.

| الحزمة | التنفيذ المطلوب / allowed source paths | قبول أساسي وتبعيات |
|---|---|---|
| W1 | `routes/search.ts`, `services/search.ts`, `tests/m8-search.test.ts` | resolver الحقيقي id != user_id ثم نجاح الطالب، غير المنشور/tenant/branch deny؛ حدود tokens/query؛ W7 لا يلمس search |
| W2 | `services/tenant-export.ts`, `routes/tenant-export.ts`, `tests/m8-tenant-export.test.ts` | استنتاج ملكية حاسم للصفوف NULL من parent، رفض conflict، manifest included/omitted/incomplete بدقة؛ لا تصدير تلقائي لكل الجداول ولا أسرار؛ stale job guard/resources bounded؛ لا حذف PII حقيقي |
| W3 | `routes/playback-sessions.ts`, `services/playback-session-registry.ts`, `routes/secure-video.ts`, `services/video-security.ts`, `services/playback-entitlement.ts`, اختبارات m3/m1 media اللازمة بحجز صريح | revoke يمنع manifest/segment/key/refresh التالي بلا bytes؛ مصدر durable لا cache-only، no cross-tenant، actor audit atomic؛ لا provider call |
| W4 | `routes/assignments.ts`, `services/assignments.ts`, `services/assignment-storage.ts`, اختبارات m4 assignments/storage | pending attempt لا يستهلك حق الطالب بلا bytes؛ نسخ وتكرار/finalize bounded، immutable object binding، scanner state/retry/read-access؛ بعدها تسليم نفس assignment files إلى C2 حصريًا |
| W5 | `routes/lectures.ts`, `routes/videos.ts`, اختبارات ربط الفيديو الجديدة | ربط video:// يتحقق من tenant والوجود والروابط المتعارضة وقت الكتابة؛ fail-closed، سباق حقيقي يحتاج schema يرفع I2، لا اختيار first parent |
| W6 | `services/video-usage-events.ts`, `services/playback-progress.ts`, اختبار metering جديد | idempotent event attribution watch/storage، تعريف counters ومصالحة مصدر؛ بعد W3/W4 يرفع hooks المطلوبة I1 ولا يشارك ملفاتهم |
| W7 | `routes/ops.ts`, `services/logger.ts`, `services/metrics.ts`, `middleware/request-context.ts`, `tests/m8-observability.test.ts` | readiness timeout bounded، redact nested/error/cycles، auth metrics/cardinality، no false ready؛ لا new timers/index edits |
| W8 | `services/impersonation.ts`, `middleware/impersonation-context.ts`, `routes/platform-mfa.ts`, `services/platform-mfa.ts` إن موجود، اختباراتهما | timestamps متسقة، تصميم وhook MFA mandatory/step-up غير قابل للتجاوز؛ لا guard على OTP/MFA recovery يسبب lockout؛ shared auth/index إلى I1؛ live validation منفصل |
| W9 | `services/notification-outbox.ts`, `services/delivery-channels.ts`, `routes/notifications.ts`, `services/notification-consent.ts`, `routes/notification-consent.ts`, اختباراتها | bounded worker/claim/recovery/unknown outcome، consent المصدر المعتمد، producers contract، لا ادعاء exactly-once خارجي؛ event hooks في ملفات Claude إلى I1؛ لا SMS تشغيل |
| W10 | ملفات جديدة فقط `services/live-session-core.ts`, `routes/live-sessions.ts`, `services/live-recording-ingest.ts`, اختبارات live جديدة | يبدأ بعقد provider-neutral من معيار G4–G6، signed callback/dedupe/tenant/host/join/grace/recording lifecycle؛ hooks إلى W9/W3/I1 وschema I2؛ live proof مزود محجوب D2 |

داخل WorkBuddy: W1/W2/W3/W4/W5/W7 يمكن تقسيمها بالتوازي بعد تثبيت أسماء ملفات الاختبارات القديمة منعًا لتداخلها؛ W6 بعد W3/W4، W8 وW9 بعد قبول عقودهما، W10 بعد عقود provider/lifecycle. لا يطلق عشرة عمال لمجرد وجود عشرة أسماء.

## حزم Claude / OpenCode — المنتج الدراسي والمال

| الحزمة | التنفيذ / الملكية | تبعيات وقبول |
|---|---|---|
| C1 | `routes/exam-versions.ts`, `services/exam-snapshots.ts`, `services/exam-grading.ts`, `routes/manual-grading.ts`, اختبارات الامتحان/manual | مسار manual grading للـversioned attempts، reviewer/rubric/revision/audit؛ لا استرجاع قائمة غير معتمدة؛ schema I2؛ publication/retake/draft policy D3 |
| C2 | بعد تسليم W4: `routes/assignments.ts`, `services/assignments.ts`; `routes/gradebook.ts`, `services/gradebook.ts`, اختبارات gradebook/assignment | teacher assignment authority، grading محفوظ وتكامل الدرجات idempotent؛ new exam-grade hook بعد C1 إلى I1؛ schema unique/void I2؛ لا concurrent W4 |
| C3 | `routes/schedules.ts`, `services/schedules.ts`, `routes/attendance-records.ts`, `services/attendance-records.ts`, `routes/attendance.ts` بعد قرار المصدر، اختبارات الحضور | manual reports G7 ثم reconcile بعد W10؛ سلسلة create idempotency I2؛ لا تغيير response shape؛ policy legacy/reason/overlap D3 |
| C4 | `routes/parent-links.ts`, `services/parent-links.ts`, `routes/parent-views.ts`, `services/progress-reports.ts`, ملفات report route/service جديدة، اختبارات P1/P2/A7 | published-only summaries، child scope، link revoke/liveness، route actual mounted I1، schema publish I2؛ cadence/fields D3؛ لا notification outbox edits |
| C5 | `routes/student-enrollment.ts`, `routes/students.ts`, `routes/student-import.ts`, `services/student-csv-import.ts`, `routes/registration-requests.ts`, `routes/subscription-requests.ts`, اختبارات enrollment/import | توحيد user identity وعدم دمج أشخاص بالاسم، علاقة طالب/مدرس متعددة داخل السنتر مع حفظ القديم والدفع، actor != instructor، revenue attribution؛ schema I2؛ event anchor D3 |
| C6 | `routes/moderation.ts`, `services/moderation.ts`, `services/lesson-discussions.ts`, `routes/audit-logs.ts`, `services/audit-log.ts`, اختبارات moderation/audit | lifecycle report عند عقد صريح، notification event contract W9، restore/retention لا purge دون موافقة؛ chain shared writer I3 |
| C7 | ملفات جديدة `services/billing-basis.ts`, `services/billing-pricing.ts`, `services/billing-invoices.ts`, `services/billing-periods.ts` واختباراتها | pure exact arithmetic أولًا، unique user interval union داخل tenant، immutable price/event IDs، 30 يوم UTC، snapshots rebuild، credit != wallet؛ بعد C5/I2 والقرارات؛ لا تشغيل مال |
| C8 | `routes/fees.ts`, `routes/platform-tenants.ts`, `routes/instructor-wallet.ts`, `routes/payment-requests.ts`, `services/subscription-renewal.ts`, ملفات ledger/reservation/payment-adapter جديدة واختباراتها | يبدأ fee identity/paid0/idempotency ثم balanced ledger/available/pending/reserved/refund/payout/grace؛ ملفات subscription-requests فقط بعد تسليم C5؛ C7/I2 قبل تدفقات wallet؛ provider D2 |

لا يوضع C1 وC2 في سباق على hooks؛ لا يوضع C5 وC8 في سباق على subscription-requests. القبول المالي يبقى مستقلًا؛ mock provider لا يشغّل تحصيلًا حقيقيًا.

## التكامل المشترك — مالك واحد يثبّته Codex قبل التنفيذ

| ID | الملفات/المخرجات | الترتيب |
|---|---|---|
| I1 | `server/src/index.ts`, auth/authority helpers وحراس MFA، event hooks المتفق عليها | نقطة تجميع متسلسلة بعد توقف أصحاب الملفات؛ mount مرة واحدة، CORS exposes X-Results-Truncated، auth context محفوظ، لا APIs جديدة بلا عقد |
| I2 | migrations جديدة فقط + `server/bootstrap/m1/manifest.json`, bootstrap scripts عند الحاجة | مُهندس schema واحد؛ جدول تغييرات واحد لكل المجالات، لا تعديل قديم/FK disable؛ unique/parent/version/ledger/grades/live contracts تسبق التنفيذ التابع؛ التطبيق الحي يحتاج إذن منفصل |
| I3 | `services/content-release.ts`, `security/audit.ts` واختباراتهما | DST nonexistent walltime tests، عقد audit sealing coverage وربط timestamp؛ لا concurrent C6 على helpers؛ لا purge |
| I4 | تقارير acceptance/CI/runbooks واختبارات end-to-end hermetic ثم fixture حي مصرح | regression بعد توقف الفريقين، secret scan، policy A→B وteacher→teacher، DB transactions/races/schema restore، provider sandbox/device/load بعد إذن؛ مراجعة الكود تتبع كل دفعة ثم مراجعة نهائية |

## قرارات/بوابات لا يجوز أن يخمنها وكيل

**D1 مؤجل:** قناة/مزود OTP/SMS/WhatsApp وSender/template/cost؛ يظل fail-closed.

**D2 خارجي/تشغيل:** DRM/offline rights/provider، live/recording، scanner/storage admission capabilities، DNS/TLS، merchant KYC/fees/tax/settlement/payout/chargeback/recurring consent، deployment topology/nginx، backup encryption/RTO/RPO، UI banner/RTL/accessibility. يمكن بناء العقود/التنفيذ المحايد واختباره محليًا؛ لا تُقبل الأدلة الخارجية بالافتراض. لا تشغيل DB/Docker/native server/listener أو migrations/secrets/cloud/push/deploy من هذه الخطة وحدها.

**D3 منتج/بيانات:** المرجع القانوني للتسجيل (groups/student_courses وحالات التعدد)، حدث بدء فوترة العلاقة، empty categories/extra credit، exam submitted vs draft/results release/retakes/archived questions، attendance legacy/new/correction privacy/overlap/create authority، consent source/global-vs-tenant، parent provisioning/invalidation/report fields/cadence، moderation report transitions/restore/retention. أي قاعدة موجودة صراحة في docs19 تنفّذ ولا تُسأل ثانية؛ غير المحسوم يحجب الجزء التابع فقط.

## التوزيع المرحلي العملي

1. **دفعة أولى مستقلة:** WorkBuddy: W1,W2,W3,W5,W7. Claude: C1 وC3 وC4، بعد عزل الأجزاء D3/schema التابعة. جرد schema I2 والقرارات كتابة فقط بالتوازي. لا يدّعي طرف أن المقترحات وحدها claims أو موافقات.
2. **دفعة ثانية:** WorkBuddy W4 ثم تسليم assignments إلى C2؛ W6 بعد W3؛ Claude C5 وC6؛ I2 عقود/schema متسلسلة؛ I3 على helper المحجوز.
3. **دفعة ثالثة:** C7 ثم C8 للمال؛ W8/W9/W10 وفق العقود؛ C2/C4 hooks والتقارير وتكامل النتائج؛ I1 integration متسلسل.
4. **إغلاق:** I4 مراجعة واختبارات وضبط المتبقي؛ D1 المؤجل يسجّل استثناءً صريحًا، D2 يحتاج تفويضًا وإثباتًا. المراجعة الدقيقة أثناء كل تسليم تمنع تراكم كود خاطئ؛ الفحص النهائي بعد تجميد الكتابات.

هذه كل مجموعات الباقي المعروفة مقابل صفوف البلان، وليست ضمانًا بعدم اكتشاف عيب جديد. لا يوجد حذف لمتطلبات live/finance/reports لمجرد تعذر المزود، ولا نسبة «100%» قبل الأدلة.

## تفصيل الحزم المالية الكبيرة — لا تُسلّم C7/C8 ككتلة واحدة

| الجزء | المخرج | الترتيب/ملكية |
|---|---|---|
| FIN1 | محرك شرائح وinterval union وحساب كسور بوحدات دقيقة، HALF_UP نهائي فقط | C7 ملفات جديدة، مستقل عن المزود؛ teacher51=2050 وcenter350=13000 وcenter351=13030؛ 51 نصف الدورة=2025، ساعة إضافية=2000.07 |
| FIN2 | علاقة متعددة student/teacher داخل tenant وسجل أحداث تفعيل غير قابل للمحو، معالجة ambiguous imports | C5 ثم I2؛ الهوية لا تُستنتج من تشابه الأسماء أو تُدمج cross-tenant |
| FIN3 | ledger متوازن، allocations، receivable/wallet/credit، حجز/تحرير وتعويض | C8 ملفات جديدة بعد schema I2؛ instructor service-credit القديم ليس merchant wallet |
| FIN4 | invoice/period/lines/price-version/offer snapshots وتسوية قابلة لإعادة البناء | C7 بعد FIN1/2/3؛ أول فاتورة أساسي دون عدد متوقع وفق docs19 |
| FIN5 | subscription collection priority/grace/access protections | C8 ثم I1؛ **96 ساعة من إصدار طلب الفرق** وفق docs19، لا يعاد السؤال عنه؛ فترات الطلاب المدفوعة المستقبلية محفوظة |
| FIN6 | تحصيل قديم: exact identity، منع paid-without-payment الكاذب، pending duplicate، attribution وإيراد مرة واحدة | C8 على fees ثم subscription-requests بعد تسليم C5؛ لا منع كل إيصالات النقد غير المرتبطة بلا عقد |
| FIN7 | concurrent payment idempotency وmoney arithmetic وعرض المتبقي | C8 على platform-tenants/service-credit؛ لا فرض رفض overpayment إذا العقد يخصص الفائض |
| FIN8 | neutral checkout/callback/reconciliation interfaces ثم vendor implementation | C8 ملفات جديدة؛ signed amount/currency/order/event، بدء التنفيذ الحقيقي D2 |
| FIN9 | payout طلب/حجز/معالجة/تأكيد/فشل وdestination authority | C8 بعد ledger/priority؛ limits/cooling/provider D2 |
| FIN10 | refund/funding/reservation/reversal وdispute مستقل عن الإلغاء العادي | C8 بعد FIN3؛ قواعد موثقة كثيرة في docs19 لا تعاد كأنها كلها مجهولة؛ التنفيذ الخارجي D2 |
| FIN11 | admin/read models من canonical invoice basis والتقارير المتصالحة | C7/C8 بعد FIN4؛ لا sum teacher analytics كأساس فاتورة سنتر |
| FIN12 | F1/F2 اختبارات القبول المالية المعزولة ثم SQL/sandbox | I4؛ لا تفعيل تحصيل حقيقي قبلها |

هذه الأجزاء متسلسلة حيث تتشارك الملفات؛ لا يطلق وكيل لكل صف مالي بالتوازي. النتائج العددية أعلاه تصحح مثال C351 الخاطئ في تقرير billing-gap السابق؛ المصدر الحاكم docs19.

## ملاحظات الجرد المستقل

ثلاث مراجعات مصدر متوازية دعمت هذا الجرد (الدراسة، media/operations، المال)، بدون اختبارات أو كتابة كود منها. أكدت أن A4 القديم ليس A4 للامتحانات الجديدة، وأن progress-report projection وdispatchOutboxRow/enqueueParentReportDelivery لا يثبت وجودها وجود منتج/worker مستهلك لها. mandatory MFA لا يثبت بتركيب صفحة إدارة MFA وحدها. هذه فروق قبول وليست دعوة لإعادة كتابة الأساس العامل.
