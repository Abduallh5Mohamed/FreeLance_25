# 15 — ترميم المنصة الحالية أم بناء tenant core جديد

**القرار الحاكم المحدث:** التسعير تدريجي للمدرس والسنتر؛ فوترة المؤسسة كل 30 يومًا مع حساب مدة فعلية بالثواني وتسوية، لا عمولة على الطلاب؛ محفظة السنتر وحده أو المدرس المستقل؛ خصم الاشتراك من المتاح ومهلة 4 أيام. المرجع [19 — القرارات المعتمدة](19-commercial-registration-wallet-agreement-ar.md)، والموافقة قبل التنفيذ في 18. الوثائق ليست دليل تشغيل.

## سياق موثق

التطبيق يملك modules مستخدمين/طلاب/مجموعات/دورات/امتحانات/حضور/فيديو، React/Vite + Express + MySQL، وSaaS migrations جزئية. تقرير [audit](ARCHITECTURE_AUDIT_AND_MIGRATION_PLAN_AR.md) يرصد route auth غير موحد، scoping اختياريًا، فروق schema، DDL داخل runtime، وأسرار/role issues. قارِنوا هذا التقرير بproduction snapshot؛ لا تعتبروا تقريرًا قديمًا وصفًا لحالة deployment الحالية.

## البدائل

| المسار | الوصف | مكسب | خطر |
|---|---|---|---|
| A — Retrofit | migrations ملكية وtenant_id على جداول MySQL الحالية؛ policy center ثم تحويل route-by-route | reuse أكثر، أقل ازدواجًا قصير المدى | surface قديم كبير وسلوك/بيانات غامضة يضاعف تدقيق الأمان |
| B — Tenant core + module migration | identity/membership/tenant domains واضحة ثم نقل مجال/بيانات/adapters تدريجيًا؛ legacy معزول إلى أن يوقف | boundary أصغر للميزات الجديدة وقابلية deprecate | dual-system migration، كلفة UX/API/compatibility وترحيل |

## تقدير هندسي أولي (يُعاد بعد Spike)

التقدير dev-weeks لشخص واحد كامل الوقت، ويشمل اختبارات المجال والـsecurity/recovery المسؤولة، ولا يعني أسابيع تقويمية. المنتج الكامل يضم domains إضافية وتقديرها في backlog refinement؛ هذه مقارنة tenant core فقط.

| مجال | A | B |
|---|---:|---:|
| inventory + production snapshot + identity map | 3–5 | 3–5 |
| auth/session/role/secret hardening | 5–8 | 5–8 |
| schema/tenant owner + migration/quarantine | 5–8 | 4–7 |
| tenant policy + routes/resources | 8–14 | 9–15 including core and selected adapters |
| UI/legacy compatibility | 4–7 | 5–8 |
| file/video/socket/jobs/export gates | 4–7 | 4–7 |
| backfill/reconcile/cutover | 4–8 | 6–10 |
| test/restore/ops closeout | 5–8 | 5–8 |
| **Total** | **38–63** | **41–68** |

تقدير تقريبي من قراءة التقرير والمخطط وليس من migration trial على production. لا تقسموه على عدد المطورين وحده؛ الأمان/الملكية/cutover يعتمد بعضها على بعض. الجدول الزمني الكامل يحدد بعد Spike وroadmap domains.

## توصية وعتبة قرار

ابدؤوا بـSpike على snapshot آمن لمدة قصيرة: جرد tables/routes، restore، backfill عينة، composite FK، اختبار A→B لcourse/student/file/video/job. اختر A إذا كانت ملكية records واضحة ≥99% في المجالات المعنية، يمكن حصر نطاق التحويل بحدود domain/repo واحدة، وتقدير retrofit بعد التجربة قريبًا من الطرف المنخفض مع rollback موثق. اختر B إذا بقيت سجلات tenant-owned غير منسوبة، كان `optionalAuth`/legacy shared identity لا يمكن إغلاقه دون كسر واسع، أو route surface لا يمكن تغطيته باختبار/owner proof. إذا فشل كلا المسارين في إثبات العزل، لا تطلقوا الميزة؛ وسّعوا النطاق الزمني/الهندسي.

لا تعني التوصية إعادة كتابة جميع صفحات LMS. المطلوب boundary جديد/واضح مع deprecation متدرج، وإعادة استخدام domain logic فقط بعد اختباره وإثبات علاقات ملكيته.
