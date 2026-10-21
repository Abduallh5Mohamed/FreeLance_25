# تقسيم استكمال السيرفر بين خطين — 2026-10-22

المرجع SERVER-REMAINING-INVENTORY-20261022.md. المالك طلب تقسيم المتبقي بين Claude وWorkBuddy واستكمال التنفيذ دون توقف روتيني بعد كل مهمة. هذا اعتماد قصد التنفيذ البرمجي في الحزم أدناه؛ كل task يحتاج تثبيت allowedPaths وبصمة قبل الكتابة، ولا يمنح تنفيذ DB/DDL/services/providers/secrets/purge/Git/deploy. لا نسبة عمل50% مثبتة؛ توزيع تقريبي بالمجهود والتبعيات، يراجع عند ظهور القياس.

هذا كله جانب المطور1 (السيرفر) من docs20. تنفيذ src/** وpublic/** وindex.html وشاشات العميل يخص المطور2 ولا يُنقل هنا. عقود العميل يكتبها السيرفر بالتنسيق؛ لا ننسب الواجهة أو تحقق المستخدم النهائي إلى إنجاز السيرفر.

## خط Claude/OpenCode — المنتج والمال والـschema

1. C5/FIN2 الهوية والتسجيل والاستيراد وعلاقات الطالب/المدرس وأحداث التفعيل.
2. C7/C8، FIN4–FIN12: الفواتير/snapshots ثم التحصيل والأولوية والمهلة والتسويات، ثم checkout/payout/refund/dispute/read models واختبارات المال. تطوير محايد فقط حتى قرارات وتفويض المزود.
3. مصدر schema واحد لكل الخطين: migrations جديدة فقط وعقود موحدة؛ schema requests من WorkBuddy تستقبل كمتطلبات ولا يفترض تطبيقها. لا تعديل migrations01/02 المجمدة دون تصحيح منسق.
4. I1 تجميع متسلسل: index/manifest والمصانع والتوصيل، بعد تسليم أصحاب المجالات؛ لا نشر أو بدء خدمة فعلي.
5. C4 ولي الأمر: provisioning/invalidation وparent views وpublished reports/composer، بعد حسم سياسات الجزء التابع. W9 استهلاك/توصيل فقط ولا يكتب هذه الملفات.
6. I4 الجانب المالي وschema/restore خطة وقبول hermetic؛ التشغيل الحي منفصل.

ترتيب Claude الداخلي: هوية FIN2 وschema contracts أولًا؛ بالتوازي كود جديد للفواتير/عقود المال لا يكتب الملفات نفسها. subscription-requests تسلّم من الهوية للتحصيل حصريًا، لا عاملان عليها. schema كاتب واحد؛ index/manifest كاتب واحد في نافذة تجميع بعد توقف كتابات المجالات.

## خط WorkBuddy — الدراسة والوسائط والأمان والتشغيل

1. C2/C1-R: الواجبات وتصحيحها وgradebook/hooks نتائج الامتحانات، مع الحفاظ على إصلاحات W4. ملفات assignments تظل هنا؛ لا وكيل Claude يكتبها.
2. C3: الجداول وidempotency والحضور اليدوي/التلقائي والمصالحة؛ القرارات القديمة لا تُخمن.
3. W4: scan scheduling/leases/exhaustion وpending cleanup وadapter exact-version/provider-neutral.
4. W6: SQL adapters قياس media على contract/schema المقدمة من Claude، outbox/reconciliation/wiring requirements.
5. W9: producers في الملفات التي يملكها هنا، worker start/stop/receipts/consent. hooks في ملفات Claude يقدّم طلب contract ولا يكتبها.
6. W10: live-neutral lifecycle/callbacks/attendance/recordings ثم device/provider validation plan.
7. W8/I3: MFA guards التصميم والمكونات، impersonation timestamps، DST، audit coverage وmoderation lifecycle بحسب سياسة صريحة.
8. W1/W2/W3/W5/W7-R: search performance، تصدير gaps، durable binding/revoke، telemetry/alerts/runbooks وحمل hermetic وخطة restore.

ترتيب WorkBuddy الداخلي: uploads/cleanup وgrading لا يكتبان assignments بالتوازي؛ يسلّمان الملف داخليًا. attendance/live لا يكتبان نفس الحضور بالتوازي. audit helpers/moderation لا يكتبان نفس المصدر بالتوازي. SQL metering ينتظر schema contract، لا يخترع جدولًا ثم يكتب اعتمادًا عليه في الإنتاج.

## الملكية ونقاط الحدود

- Claude حصريًا: student enrollment/import/registration/subscription-request؛ fees/platform-tenants/instructor-wallet/payment-requests/subscription-renewal؛ billing-*؛ parent-* وprogress publication/reports/source؛ schema ومصانع التجميع المشتركة وindex/manifest.
- WorkBuddy حصريًا: assignments/assignment-storage/scan-worker/gradebook؛ exam-versions/snapshots/grading وexam-manual-grading بما فيها sql adapter بعد تسليم baseline؛ schedules/attendance بما فيها تقاريرها؛ live/meetings؛ video/media/playback/lectures/materials؛ notification/outbox/consent/delivery؛ search/export/ops/logger/metrics/request-context؛ MFA/impersonation/content-release/moderation/discussions/audit helpers.
- ملف اختبار يتبع مالك مصدره. اختبارات التجميع العامة b2-production-wiring وm1-bootstrap-plan عند Claude، وm1 media/regression عند WorkBuddy؛ أي اختلاف يثبّت بالاسم في registry قبل الكتابة.
- docs/contracts ليست مساحة كتابة مشتركة: ملف عقد واحد له مالك مسمى. Claude يملك المالي/الهوية/parent/schema؛ WorkBuddy يملك upload/media/live/notification/security/academic. التعديل في عقد الطرف الآخر طلب مكتوب فقط.
- auth.ts/db.ts والملفات الجذرية/config/scripts/.github والنشر ليست مفتوحة للطرفين؛ يقدّم patch محدد للمشرف لتثبيت مالك ونطاق مستقل. لا تعديل شامل أو formatter يعبر الملكية.
- لا كتابة على index/manifest من WorkBuddy. يرفع wiring request، وينفذه Claude في نافذة integration حصرية بعد freeze للعقود وsnapshot.
- تبادل source ownership يحتاج handoff hashes وتأكيد توقف الكاتب القديم ثم تحديث registry؛ أسماء الملفات العامة أعلاه تصنيف وليست wildcard إذن كتابة. كل مهمة تذكر أسماء الملفات الحالية والجديدة والاختبارات والتقرير صراحة.

## الاستمرار والجودة

كل خط يجهز قائمة مهام مرتبة تغطي حصته كلها، وتخصيص allowedPaths/اختبارات/تقرير/تبعيات قبل إطلاق أي عامل. WorkBuddy لا يحوّل وثيقة التوزيع إلى claim مزيف: يقدم specs ليُسجّلها المشرف ويثبت human scope hash؛ المهمة غير الموجودة أو غير المعتمدة لا تُتجاوز. لا يُستعمل token عامل آخر.

بعد إتمام مهمة يختار التالية المعتمدة والمستقلة دون انتظار «كمل» من المالك، مع رفع الأدلة للمشرف. reported ليس accepted؛ المهمة التابعة لقبول مهمة سابقة تنتظر قرار المراجعة، ويمكن مواصلة غير التابعة. لا قبول ذاتي أو إنشاء مرحلة جديدة تلقائيًا.

المقصد إتمام كل ما هو قابل للتنفيذ ضمن العقود، وليس العمل بلا حدود أو بلا تقارير. إذا عطل قرارٌ بندًا، يُسجّل القرار وتأثيره ويتقدم الخط في البنود المستقلة. إذا نفدت المهام الآمنة المعتمدة يرفع handoff واحدًا واضحًا. عند429/502/خللTLS يوقف التنفيذ المتأثر ويرفع الدليل، لا retryloop أو تبديل الحساب أو تجاوزTLS. لا إعادة عامل قبل دليل توقف وإبطال claim القديم.

اختبارات مركزة/سلبية/فشل/تزامن لكل مهمة، بلا إضعاف اختبارات أو fake نجاح؛ source hashes قبل/بعد وفصل الموروث عن الجديد. full suite بعد توقف الخطين فقط. لا مزود حي أو DB أو listener أو migrations أو purge/merge/push/deploy تحت هذا الإذن. الشهادات مستبعدة، SMS/WhatsAppOTP مؤجلان. docs19 قرارات المال المحسومة لا يعاد طلبها.

## التسليم الأول المطلوب من الخطين

Registry يغطي كل الحصة: taskId، expected files بالاسم، dependencies، policy-held parts، اختبارات قبول، schema/wiring requests، وعدد الوكلاء حسب سعة المزود. ليس المطلوب إعادة جرد المنتج أو إعادة الأساس المنجز. Codex يثبت عدم التقاطع ويحوّل WorkBuddy specs إلى مهام bridge؛ Claude ينفذ المهام المخصصة بعد تثبيت registry. لا إطلاق على الملفات المنقولة حديثًا قبل التثبيت. هذه خطوة لازمة قابلة للمراجعة وليست طلب موافقة جديدة من المالك.
