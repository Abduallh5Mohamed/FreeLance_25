# الجرد الموحد للمتبقي — السيرفر — 2026-10-22

## 1. حدود هذا الجرد ودليله

الجرد يحدّث SERVER-CLOSURE-INVENTORY-20261020.md مقابل تسليمات الدفعتين ومراجعات Codex حتى تصحيح B2-C-INTEGRATION. المرجع المنتج docs/17، والتجاري docs/19، وإذن التنفيذ docs/18. لا يوجد هنا إطلاق وكلاء أو موافقة دفعة جديدة أو إذن خدمات/DB/DDL/Git. الواجهة مسؤولية المطور الآخر، ونقاط التعاقد معه ظاهرة هنا.

آخر تحقق مستقل: **2873/2873 من الجذر و2873/2873 من server، typecheck exit0، دون force-exit أو skip/todo/cancelled**. الدليل في الجسر handoff/b2-final-root-20261022.log وb2-final-server-20261022.log، والقبول المحدود B2-INTEGRATION-SCOPED-ACCEPTANCE-20261022.md. هذه أرقام اختبارات وليست نسبة اكتمال أو دليل SQL حي. لم تُعَد الاختبارات في جولة الجرد الحالية.

الجرد تجميع ومطابقة مصدر وتسليمات، وليس مراجعة سطرية جديدة لكل النظام. «غير مغلق» لا يعني أن كل كوده غائب؛ يعني أن شروط الإغلاق لم تُثبت كلها. ظهور عيوب إضافية ممكن. الملحق يثبت تغطية IDs الأصلية؛ الأسماء C1–C8 للحزم لا تختلط مع IDs الكتالوج C1–C12.

## 2. ما لا نعيد تنفيذه

| الجزء | المنجز المقبول في نطاقه | ما لا يثبته |
|---|---|---|
| W1 البحث | user_id الصحيح، resolver حقيقي واختبارات رفض وحد tokens | أداء وفهرسة وحمل فعلي |
| W2 التصدير | ملكية من الأب، رفض التعارض، included/omitted وإعلان عدم الاكتمال، قراءات محدودة | تصدير كل بيانات المنتج أو snapshot متسقة |
| W3/W5 الفيديو | durable session checks، إلغاء يمنع الطلب التالي، صلاحية support، ربط canonical/tenant ورفض الأب الغامض | قيد ربط موحد على DB أو اختبارات مزود/نسخ حية |
| W7 observability | مهلات probes، فصل liveness/readiness، redaction، حصر labels | منظومة alerts/jobs/SLO أو إثبات حمل |
| W4 الواجبات | رفع/finalize/scanner contract، cleanup مربوط بالنسخة في الحجر والرفض والإلغاء، 132 اختبارًا مركّزًا | scanner حي أو cleanup فعلي ودائم بالإنتاج |
| W6 القياس | عقد معاملة إلزامية للأحداث والعدادين والتدقيق، rollback/interleaving، 48 اختبارًا | SQL قياس موصول أو مصالحة مجدولة |
| W9 الإشعارات | worker bounded مع claim/fencing/unknown outcome/تنقيح السجلات | تشغيله في التطبيق أو وصول رسالة حقيقية |
| C1a | تصحيح يدوي للنسخ الجديدة، revisions/CAS/finalize وأدابتَر SQL ومسار موصول | تطبيق schema حي أو حسم سياسات النتائج والمحاولات |
| C3a | تقارير الحضور اليدوي ومسار وتصدير مختوم لا يعرض سبب الحضور الخاص | حضور تلقائي/live أو توحيد النظام القديم |
| C4a | نشر/إلغاء نشر، authority فعلية، projection بمفتاح مطابق، SQL ومصدر وتقارير503 عند النقص | تسليم parent view النهائي أو وتيرة/حقول التقرير أو اكتمال مصادر درجاته |
| FIN1/FIN3 | تسعير دقيق وفترات وأساس interval union، دفتر داخلي متوازن وحجوزات وSQL adapter | فواتير وتحصيل ومحفظة تشغيلية وصرف واسترداد |
| B2 schema/integration | مصدر migrations01/02 مسجّل بالـmanifest، protected mounts، sealed audit وcolumn readiness | تنفيذ migrations أو اعتماد إطلاق إنتاجي |

## 3. حزم المتبقي التقنية — WorkBuddy مرشح تنفيذ

| ID | المتبقي الفعلي | شرط الإغلاق / التبعية |
|---|---|---|
| W1-R | قياس البحث ببيانات واقعية؛ pagination/الفهرسة إن أثبت القياس الحاجة | نتائج صحيحة عبر tenant/branch وغير المنشور، latency موثق؛ لا إعادة إصلاح user_id |
| W2-R | استكمال بيانات المدرسة المعلنة كفجوات في coverage؛ ضبط قائمة المستثنى المعتمدة؛ اتساق snapshot/resources/job lifecycle | كل جدول معتمد له إثبات ملكية وعزل وعدم إسقاط صامت؛ لا تصدير تلقائي للأسرار/مال المنصة؛ الأرقام القديمة ليست قياسًا أبديًا |
| W3-R | تحقق حي durable revoke والتزامن/تعدد العمليات، وفحص السلوك مع provider | الطلب التالي مرفوض بلا bytes؛ ليس ادعاء سحب bytes أرسلت بالفعل |
| W4-R1 | schema دائم لمحاولات الفحص/next attempt/lease/error/object version؛ worker يتوقف بعد exhaustion ويمكن استعادته | fencing وإعادة تشغيل/عمليتان دون ضرر؛ schema owner أولًا، لا الاعتماد على عداد runOnce |
| W4-R2 | pending-cleanup دائم وقابل للاستعلام، retry/reconciliation، سياسة retention وحدود التخزين | لا حذف replacement؛ adapter الإنتاج conditionalDelete=false حاليًا، لذا ترك bytes آمن مؤقت لا حل تشغيل مكتمل |
| W4-R3 | scanner provider حقيقي وحدود مهلة وفشل وتكامل storage versioning | اختبار مزود/ملفات معزولة بتفويض؛ لا fake clean، ولا mutable-key fallback |
| W5-R | تمثيل موحد لروابط video→lecture/material وقيد DB يمنع السباق بين النوعين، معالجة الروابط القديمة الغامضة | contract ثم source migration ثم تحقق حي؛ لا unique lectures فقط باعتباره حماية للنوعين |
| W6-R1 | SQL دائم للأحداث/عداد tenant/asset، tx وأقفال/dedupe، adapters فعلية | الحفاظ على معاملة العقد؛ إثبات InnoDB مستقل |
| W6-R2 | توصيل lifecycle بالقياس، outbox للفجوات deferred/unconfigured، job مصالحة وإعادة بناء | crash/retry لا يفقد event ولا يكرر delta؛ callback الموقّع يحتاج توافق المزود |
| W7-R | metrics فعلية للعمال والـoutbox والـscan والتصدير، alerts وSLO/runbooks وحمل probes | لا labels عالية cardinality/PII، حدود timers/queues وإغلاق نظيف |
| W8-R | MFA إلزامي/step-up على العمليات الحساسة وفق matrix، مسارات recovery لا تُقفل؛ timestamp اتساق الانتحال | حارس خادمي غير قابل للتجاوز؛ live rerun بعد expiry repair، client banner منفصل |
| W9-R1 | تشغيل/إيقاف worker صراحة مع التطبيق وgraceful shutdown، config/readiness وإعادة معالجة unknown outcome | لا startup عند import ولا exactly-once خارجي زائف؛ integration كاتب مشترك واحد |
| W9-R2 | producers من الجداول/النتائج/الإشراف/تقارير ولي الأمر، recipient resolver وconsent وتتبّع receipts | العقود والسياسات أولًا؛ consent الحالي قبل الإرسال، لا تسريب مخاطبين |
| W9-R3 | مزودا القنوات/templates/receipts/retry وتصنيف الفشل | OTP/SMS/WhatsApp مؤجل بقرار المالك، يظل رفض آمن ولا نجاح وهمي |
| W10-R1 | live core محايد: host/join/leave، callbacks موقعة ودائمة وdedupe/tenant/grace | meetings القديم لا يغلق G4–G6؛ عقد مزود/schema قبل hooks |
| W10-R2 | حضور تلقائي ومصالحة اليدوي، الحصص المدمجة، التسجيل ingest→مكتبة→حقوق وصول | سياسة المصدر والخصوصية، lifecycle وربط W9/W3/I2 |
| W10-R3 | تحقق مزود البث/التسجيل/DRM/ABR/resume/offline وdevice matrix | صلاحيات الحقوق والمزود الخارجي؛ V7 default deny حتى الإثبات |

## 4. حزم المنتج الدراسي — Claude/OpenCode مرشح تنفيذ

| ID | المتبقي | شروط وتبعيات |
|---|---|---|
| C1-R | سياسات draft/submitted/retake/results release/archived questions، ربط التصحيح النهائي بدفتر الدرجات | لا إعادة C1a؛ hooks بعد تثبيت سياسة النشر وهوية enrollment، idempotency وrevisions |
| C2-R | مراجعة grading الواجبات وصلاحية المدرس المعيّن؛ كتابة gradebook idempotent؛ unique/void/revision والتصحيح المتكرر | تسليم حصري لملفات assignments من W4 قبل الكتابة؛ لا تتزامن ترقيات التخزين مع تعديل نفس routes |
| C3-R | idempotency إنشاء سلسلة الجداول؛ تضارب الأوقات/صلاحية الإنشاء؛ legacy/new attendance ومصالحة live | manual reports منجزة؛ automatic reports تنتظر W10 وقرار المصدر؛ حفظ response shapes والسبب الخاص |
| C4-R1 | توصيل parent views بمصدر published الصحيح مع liveness وإبطال الرابط؛ provisioning هوية parent | لا raw grades fallback؛ contract حساب ولي الأمر ومن يطلب verify/من يملك الطفل |
| C4-R2 | تقرير ولي الأمر النهائي: الحقول والوتيرة واللقطة والأحداث ثم composer/receipt | قرار المنتج أولًا ثم hook W9؛ لا اعتبار projection وجود إرسال |
| C5-R / FIN2 | هوية موحدة للطالب، تعدد teacher relationships داخل tenant، activation/deactivation event log، import ambiguity، registration/subscription attribution | لا دمج بالاسم أو cross-tenant؛ حل groups.course_id مقابل student_courses؛ بداية الفترة لها دليل |
| C6-R | عقد lifecycle البلاغات وإغلاقها/استرجاع المحتوى/retention، alerts، تغطية sealed audit المتبقية | إصلاحات tenant evidence وtransaction السابقة محفوظة؛ لا purge أو اختراع حالات |
| C7-R | invoice/price version/offer snapshots، دورة الفوترة/reconciliation/read models | FIN1 منجز؛ FIN2 مصدر العدد، FIN3 ركيزة المال؛ لا teacher analytics كأساس فاتورة سنتر |
| C8-R | تدفقات التحصيل والأولوية/المهلة والتسويات والمحفظة/الصرف والاسترداد/dispute | دفتر domain وSQL موجودان؛ لا financial API موصول حاليًا؛ FIN4–FIN12 أدناه |

## 5. المال — تفصيل يمنع إخفاء العمل وراء «الدفتر خلص»

| البند | الحالة الدقيقة والمتبقي |
|---|---|
| FIN1 التسعير | مصدر واختبارات موجودة؛ live ليس مطلوبًا للنقاء الحسابي، لكن دمجه بالفواتير وربطه بأحداث FIN2 لم يكتمل |
| FIN2 أساس العلاقة | سجل علاقة مؤهلة user/teacher/tenant وأحداثها، imports ambiguous، union للفترات داخل tenant؛ ناقص |
| FIN3 الدفتر | domain/reservations/schema source/SQL adapter موجودة؛ تبقى allocations واكتمال كل مسارات الأعمال وSQL حي وتشغيل/قراءة الأرصدة |
| FIN4 الفواتير | periods/invoices/lines وprice/offer snapshots immutable، أول فاتورة وفق docs19، rebuild ومصالحة؛ غير مغلق |
| FIN5 التحصيل والأولوية | طلب فرق، أولوية دين الاشتراك قبل حجوزات سحب جديدة، 96 ساعة من إصدار طلب الفرق، retry لا يجددها، حماية الفترات المدفوعة المستقبلية |
| FIN6 التحصيل القديم | exact identity، paid-without-payment، pending duplicates، attribution مرة واحدة وربط fees/subscription-requests بعد C5 |
| FIN7 التزامن | idempotency تدفقات دفع حقيقية، decimals/remaining/overpayment allocations وفق العقد؛ ليس مجرد دفتر خالص |
| FIN8 checkout/callback | عقد order/amount/currency/signature/provider-event/reconciliation ثم adapter vendor؛ الحقيقي يحتاج تفويض ومزوّد |
| FIN9 السحب | destination authority، request/reserve/process/confirm/fail، حماية الحجز، KYC/limits/cooling/provider |
| FIN10 الاسترداد/dispute | funding/reservation/reversal، idempotency وإيراد/رصيد صحيح؛ dispute مستقل عن إلغاء عادي؛ تنفيذ خارجي محجوب |
| FIN11 الإدارة | read models من الفاتورة/دفتر canonical، عرض debt/pending/available/reserved/credit منفصلة، تصدير ومصالحة |
| FIN12 F1/F2 | اختبارات قبول مالية كاملة وحالات الانقطاع/replay/concurrency/compensation ثم SQL/sandbox؛ لا تحصيل حقيقي قبلها |

### قرارات تجارية محسومة وليست أسئلة جديدة

- طالب السنتر يعد مرة واحدة لكل user داخل tenant؛ المدرسون المتعددون لا يضاعفون العدد؛ الفترات اتحاد لا جمع؛ لا dedupe بين tenants.
- الدورة 30 يوم UTC = 2,592,000 ثانية؛ تقريب HALF_UP مرة في النهاية، بلا floating money. C(351)=13030، وليس13000.
- مهلة الفرق96 ساعة من إصدار طلبه، وليست من نهاية الفترة؛ الطلب المعاد لا يعيد الساعة.
- wallet القديم service-credit وليس merchant wallet؛ subscription_credit غير قابل للسحب؛ النقد لا يخلق merchant_available؛ لا عمولة منصة.
- حماية فترات الطالب المدفوعة بما فيها المستقبلية، وحماية حجوزات السحب القائمة، لا تُسقطان بتعطيل عام خاطئ.

## 6. التكامل والبيانات والقبول — مالك متسلسل ينسقه Codex

| ID | المتبقي |
|---|---|
| I1-R | توصيل worker الإشعارات، hooks النتائج/الواجبات/الجدول/الإشراف، قياس media، live، حارس MFA، ثم عقود العميل؛ mounts B2 المدرسية منجزة ولا تعاد |
| I2-R1 | bootstrap حي معزول لكل migrations الحالية وتحقق schema01/02 والقيود/أنواع BIGINT والـcollation وترتيب الأقفال وsealed audit على driver الحقيقي؛ التسجيل بالـmanifest ليس التطبيق |
| I2-R2 | schema source جديدة للعلاقة FIN2، invoice/collections، scan leases/attempts/cleanup، meter events/counters/outbox، binding موحد، gradebook unique/void، series idempotency، live؛ لا يدّعى أنها كلها ضمن01/02 |
| I3-R | إصلاح فجوة DST في content-release بحدود زمنية واختبارات، توحيد timestamp المتبقي، audit coverage لكل المجال/الاحتفاظ؛ لا كتابة متزامنة على helpers |
| I4-R1 | matrix شاملة direct API/files/video/jobs/socket: tenantA→B، teacherA→B، branch وتبديل الهوية؛ MFA/impersonation/liveness/revocation؛ regression بعد تجميد الشجرة |
| I4-R2 | isolated MySQL integration/concurrency/restart/migrations recoverability، object-store/scanner/provider sandbox عند التصريح؛ لا recording seam كدليل حي |
| I4-R3 | backup DB+objects مشفر واسترجاع لقطة متسقة ودليل RTO/RPO؛ secret/dependency scan، deploy/rollback/runbooks |
| I4-R4 | load/soak p95/error rate/queue lag، boundedresources والتعامل مع مزود متعطل؛ لا أرقام scale من unit tests |

## 7. قرارات ومنتجات/مزودون — لا يخمّنها المنفذ

| الفئة | المطلوب |
|---|---|
| D1 مؤجل | مزود/قناة OTP وSMS/WhatsApp وsender/templates/cost؛ استثناء مؤجل صريح لا «مكتمل» |
| D3 التسجيل | مصدر enrollment القانوني، علاقة الطالب متعددة المدرسين، الحدث المؤهل لبدء الفوترة وإبطاله |
| D3 الدرجات | empty categories/extra credit، draft/submitted/retakes/release/archived question policy، تجميع overall بين المصادر |
| D3 الحضور | المصدر القديم/الجديد، الخصوصية وcorrection reason، سلطة إنشاء السلاسل والتداخل، مصالحة الحضور الآلي |
| D3 ولي الأمر | provisioning/revoke/liveness عند تغيير الاتصال/تعطيل الطالب، حقول/وتيرة التقرير؛ لا يكفي token لإنشاء علاقة قانونية |
| D3 consent/moderation | consent ledger مقابل preferences ومعنى global/tenant/contact، lifecycle البلاغ/restore/retention |
| D2 خارجي | DNS/TLS والتجديد/takeover، provider live/recording/DRM/offline/device support، scanner/storage exact-version capabilities |
| D2 مالي وتشغيلي | PSP/KYC/fees/tax/settlement/limits/cooling/chargebacks/recurring consent، topology/backup/RTO/RPO؛ docs19 المحسوم ينفذ دون إعادة السؤال |
| عقد العميل | RTL/English/accessibility، watermark/ABR/captions/device، impersonation banner، published reports/errors503/truncation headers؛ التنفيذ الأمامي عند المطور الآخر |

## 8. ترتيب التنفيذ المقترح — ليس إطلاقًا أو موافقة دفعة

1. **موجة تأسيس:** FIN2/هوية التسجيل لدى Claude؛ scan persistence وcleanup لدى WorkBuddy؛ مالك schema واحد يثبت العقود. يمكن بالتوازي إعداد خطة التحقق الحي فقط، دون تشغيله.
2. **موجة منتج وتشغيل:** C2 grading hooks بعد تسليم assignments؛ W6 SQL+outbox ثم توصيل القياس؛ W9 producers/startstop على نطاق منفصل؛ I3 DST وW8 MFA بملكية منفصلة.
3. **موجة مال:** FIN4 الفواتير ثم FIN5–7 والتحصيل، ثم FIN8–11 الصرف/الاسترداد/read models وفق التبعيات. ledger source لا يغني عن هذه الموجة.
4. **موجة live/تقارير:** W10 ثم automatic attendance/reports، C4 parent workflow وC6 policy-dependent lifecycle بعد القرارات. التصدير الناقص يتوسع بجدول معتمد لكل شريحة بيانات.
5. **بوابات الإغلاق:** I1 تجميع كل موجة بكاتب واحد، I2/I4 تحقق حي بتفويض، ثم restore/load/security/client acceptance.

التوزيع مرشح لا allowedPaths نهائية. قبل أي كتابة يلزم taskId/scopeHash/allowedPaths في الجسر لـWorkBuddy، وتخصيص حصري مسجل لClaude. ممنوع مشاركة assignments بين C2 وW4 أو subscription-requests بين C5 وC8 أو index/manifest/auth/audit helpers بين عدة وكلاء. لا worktree من HEAD يفقد الشجرة غير المحفوظة، ولا reset/clean/commit/push بهذه الوثيقة.

## 9. ماذا تعني النسبة؟

لا يوجد baseline موزون للمجهود أو قائمة قبول كاملة مغلقة تسمح بنسبة دقيقة. التقدير65–75% القديم لم يُعد حسابه، فلا نعيد نشره كقياس حالي. عدد البنود أو الاختبارات ليس مقام النسبة. الدفعتان أنجزتا أساسًا مهمًا، لكن المال والبث والتشغيل والمزودين ما زالوا كتلًا كبيرة. لا M1–M8 كلها مقبولة نهائيًا، والشهادات A8 مستبعدة وليست عملًا متبقيًا.

## 10. ملحق IDs — يضاف آليًا من جدول تغطية الجرد السابق

الملحق فهرس ربط فقط؛ الحالة الحالية في الأقسام أعلاه، وليست الحالة القديمة في مستند20. يحتفظ بكل IDs المرجع دون حذف المتطلبات الخارجية أو المؤجلة.

| IDs الأصلية | الربط بحزم المتبقي؛ المنجز يراجع في §2 |
|---|---|
| S1,S3,S4 | I4 — راجع §§3–7 للحالة المحدّثة |
| S2,C9,N1 | W9,D1,I4 — راجع §§3–7 للحالة المحدّثة |
| S5,S9 | I2,I4 — راجع §§3–7 للحالة المحدّثة |
| S6,Q6 | W2,W4,I4 — راجع §§3–7 للحالة المحدّثة |
| S7,V3,V5 | W3,I4 — راجع §§3–7 للحالة المحدّثة |
| S8 | W9,W10,I4 — راجع §§3–7 للحالة المحدّثة |
| C1,C4,C5 | W5,I4 — راجع §§3–7 للحالة المحدّثة |
| C2 | D2,I4 — راجع §§3–7 للحالة المحدّثة |
| C3 | D2 — راجع §§3–7 للحالة المحدّثة |
| C6,C7 | I3 — راجع §§3–7 للحالة المحدّثة |
| C8,C10 | C5,C7,I4 — راجع §§3–7 للحالة المحدّثة |
| C11,G2 | C3,W9,I2,D3 — راجع §§3–7 للحالة المحدّثة |
| C12 | C5,I4 — راجع §§3–7 للحالة المحدّثة |
| V1 | W10,D2 — راجع §§3–7 للحالة المحدّثة |
| V2,V6 | W10,D2 — راجع §§3–7 للحالة المحدّثة |
| V4 | W5,D2 — راجع §§3–7 للحالة المحدّثة |
| V7 | D2 — راجع §§3–7 للحالة المحدّثة |
| V8,O3,O8 | W6,C7,C8 — راجع §§3–7 للحالة المحدّثة |
| A1,A2,A3 | C1,D3,I4 — راجع §§3–7 للحالة المحدّثة |
| A4 | C1,I2 — راجع §§3–7 للحالة المحدّثة |
| A5 | W4,C2,D2 — راجع §§3–7 للحالة المحدّثة |
| A6 | C1,C2,I2,D3 — راجع §§3–7 للحالة المحدّثة |
| A7 | C4,I1,I2 — راجع §§3–7 للحالة المحدّثة |
| A8 | خارج النطاق — راجع §§3–7 للحالة المحدّثة |
| G1,B3,S10 | C2,C5,C8,I4 — راجع §§3–7 للحالة المحدّثة |
| G3 | C3,D3 — راجع §§3–7 للحالة المحدّثة |
| G4,G5,G6 | W10,D2,I2 — راجع §§3–7 للحالة المحدّثة |
| G7 | C3,W10,D3 — راجع §§3–7 للحالة المحدّثة |
| P1 | C4,W9,D1,D3 — راجع §§3–7 للحالة المحدّثة |
| P2 | C4,I2,D3 — راجع §§3–7 للحالة المحدّثة |
| P3 | W9,D3 — راجع §§3–7 للحالة المحدّثة |
| P4,N1 | W9,D2 — راجع §§3–7 للحالة المحدّثة |
| P5 | D1 — راجع §§3–7 للحالة المحدّثة |
| P6,O4 | C6,W9,D3 — راجع §§3–7 للحالة المحدّثة |
| P7 | C4,W9,D1,D3 — راجع §§3–7 للحالة المحدّثة |
| O1,O2,O5 | I4 — راجع §§3–7 للحالة المحدّثة |
| O6 | W8,I4,D2 — راجع §§3–7 للحالة المحدّثة |
| O7 | I3,C6,D3 — راجع §§3–7 للحالة المحدّثة |
| O9 | W8,I1 — راجع §§3–7 للحالة المحدّثة |
| Q1,Q2 | D2,I4 — راجع §§3–7 للحالة المحدّثة |
| Q3 | W1,W7,I4 — راجع §§3–7 للحالة المحدّثة |
| Q4 | W7,W9,I4 — راجع §§3–7 للحالة المحدّثة |
| Q5 | I4,D2 — راجع §§3–7 للحالة المحدّثة |
| Q7 | I4,D2 — راجع §§3–7 للحالة المحدّثة |
| Q8 | I2,I4 — راجع §§3–7 للحالة المحدّثة |
| B1,B4,B5 | C5,C8,D2 — راجع §§3–7 للحالة المحدّثة |
| B2,B10 | C7 — راجع §§3–7 للحالة المحدّثة |
| B6 | C2,W3,W10,I4 — راجع §§3–7 للحالة المحدّثة |
| B7,B8,B12 | C8,D2,I2 — راجع §§3–7 للحالة المحدّثة |
| B9 | C7,C8,I4 — راجع §§3–7 للحالة المحدّثة |
| B11 | C7,C8 — راجع §§3–7 للحالة المحدّثة |
| F1,F2 | C7,C8,I4,D2 — راجع §§3–7 للحالة المحدّثة |

فحص الفهرس: 84 ID فريدًا من صفوف docs17، لا ID مفقود من فهرس التغطية. هذه مطابقة IDs وليست نسبة قبول.
