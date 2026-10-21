# استكمال المنصة بثلاثة خطوط — اعتماد المالك2026-10-22

هذه الوثيقة تحل محل REMAINING-TWO-LANE-ALLOCATION وأي prompt two-lane. المرجع SERVER-REMAINING-INVENTORY-20261022.md مع التصحيحات التالية: DST gap مستهدف الجرد مُصلح في المصدر الحالي؛ لا يعاد تنفيذه. آخر snapshot منشور680a44c على codex/workbuddy-server. الواجهة الآن ضمن خطة الاستكمال بموجب طلب المالك استكمال كل المنصة، دون تعديل بيانات أو ملفات زميله خارج checkout الحالي.

## المهام الثلاث الكبيرة

**Codex — العميل والأمان والتشغيل والتجميع:** src/** وpublic/** وindex.html؛ security/auth/MFA/impersonation/audit/moderation/content-release/observability، مراجعة الاختبارات والأمن والعمارة وعقود التوافق؛ index/manifest والتجميع كاتب واحد هنا فقط. يبدأ مهندسو أمان/وقت/تشغيل/عميل، ومراجعات مستقلة بعد كل تسليم. مصدر schema عند Claude فقط. لا تعديل package/lock/config/scripts/deploy دون نطاق فرعي مثبت.

**Claude Code — المنتج المالي وهوية المستخدم وولي الأمر والبيانات:** enrollment/students/import/registration/subscription identity؛ billing/fees/payments/wallet/renewal/invoices/collections/reconciliation/payout/refund/dispute؛ parent/progress-report publication/source؛ schema source لكل الفرق بعد عقودهم. يعمل بوكلاء مجالات منفصلين، schema مهندس واحد، subscription-requests بين الهوية والتحصيل بالتتابع. لا واجهة ولاindex/manifest ولا auth/db.

**WorkBuddy — الدراسة والوسائط والتواصل:** grading/questions/exams/assignments/gradebook/schedules/attendance؛ video/media/storage/live/recordings/search/export؛ notification/outbox/consent/delivery/producers. ثلاثة مسارات agents: academic،media،notification، بلا تداخل؛ uploads والgrading علىassignments متتابعان داخل academic. لا المالية/parent/progress ولا schema/index/auth/audit helpers.

## ملفات الملكية الملزمة

THREE-LANE-FILE-OWNERSHIP-20261022.json يثبت كل ملف حالي وجديد معروف للخطوط. أي ملف جديد غير موجود يحتاج تسجيل مالك وبصمةscope قبل كتابته؛ لا directory wildcard كتصريح مفتوح. ملفات الاختبارات تتبع المنتج؛ b2-production-wiring وbootstrap مع Codex. أصل migrations مع Claude source-only، manifest مع Codex. طلب hook/schema في ملف آخر يسلم كعقد لا كتابة عبر الحدود.

أسماء مجموعات التنفيذ ليست دليلًا على تساوي الوقت. Claude مسؤول FIN2 ثمFIN4–12 مع المحافظة FIN1/3؛ WorkBuddy مسؤول C1/2/3 وW1–6/9/10؛ Codex مسؤول W7/8 وI1/3/4 والعميل وC6. تغطية I2 مصدرschemaClaude ومراجعةCodex؛ live validation محجوب. C4 parent/progressClaude، reportattendanceWorkBuddy. لا إسقاط بند إذا احتاج طرفين؛ يقسم إلى contract ثمimplementation ثمintegration.

## التشغيل والاشراف

المالك صرّح بالتنفيذ البرمجي الجديد والوكلاء والمواصلة دون أسئلة روتينية. task/work queue متتابعة داخل كل خط، لكل عامل scopedfiles وخطة وقبول وbaseline وتقرير وحالاتheld. Codex يراجع تسليمات الطرفين ولا يعلنreportقبولًا. الجسر يضبط WorkBuddy claims؛ tokensلا تشارك؛ supervisor لا ينتحل worker. لا عاملين على ملف، لا إعادة عامل بسبب leaseفقط، evidence terminationثمretire. سقف الوكلاء حسبسعةالمزود؛ لا وعودبعمل24ساعة أو عدد وكلاء غير متاح.

استكمل تلقائيًا جميع البنود القابلة للتنفيذ، وانتقل للمستقل إذا عطل قرار أو مزود بندًا. لا تعد أساسًا سليمًا من جديد. توقف مطلوب للـ429/transportfailure أو noapprovedscope، وأبلغ مرةبدليل لاretryloop/تبديلaccountأوTLSbypass. المهامpolicyheld لا تُحل بالتخمين؛ ارفع سؤالًا محددًا وتابعغيرها.

لا يتضمن طلبpush إذن تشغيل DB/Docker/services/listeners أو تطبيقmigrations أو providers/secret/cloud/purge/deploy/merge/forcepush. المصدر المحايد وsourceDDL مسموح في ملكيته، live يحتاج تفويضًا مسمى. الشهاداتمستبعدة؛SMS/WhatsAppOTPمؤجل. docs19 مرجعالقراراتالمحسومة. لاtestsجديدةأوتشغيلها دون طلبتحققضمنالمهمة؛ الفحصالسابق2873/2873دليللقطةسابقةوليسللشغل الجديد. لا fullsuiteبين كتابات متزامنة.

## إنهاء المهمة الكبيرة

التسليم النهائي ثلاث قوائم: implemented-and-reviewed،implemented-but-unproven،held-for-decision/provider. لا100%إطلاق دونlive/security/restore/load/clientacceptance. snapshot680a44c هو نقطةبدءمحفوظة؛ أي تغييراتلاحقةمنفصلةفيcommitلاحق بعدالمراجعة. التقاريرالتراكمية تظهر تقدمًا حقيقيًا ولا تُستعمل لإخفاءجزءغيرموصول.
