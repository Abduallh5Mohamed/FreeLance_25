# تسليم المطور 2: الخطة وربط Codex مع WorkBuddy على جهازه

## 1. ابدأ من main ثم فرعك

اللقطة والخطة منشورتان على `main` كتسليم WIP، وليستا إصدار إنتاج أو إعلان قبول M1. على جهاز المطور:

```powershell
git clone https://github.com/Abduallh5Mohamed/FreeLance_25.git
cd FreeLance_25
git switch codex/human-client
```

لو عندك نسخة وتعديلات محلية، افحصها واحفظها مع مشرفك قبل أي مزامنة؛ لا reset/clean أو force checkout. لا يعمل الطرفان مباشرة على main. صلاحية الوصول إلى الريبو وحساب WorkBuddy يوفرهما صاحب الحساب نفسه؛ لا تنقل حساب المطور 1 أو أسراره.

اقرأ الخطة الكاملة `docs/README.md` و00–19، ثم `20-two-developer-operating-plan-ar.md` وحدودها و`streams/client/M1-HANDOFF.md`. وجود الخطة لا يجيز M2 أو خدمات حية أو migrations. عملك M1 الخاص بالواجهة فقط إلى حين إغلاق البوابات.

## 2. أنشئ جسرًا محليًا مستقلًا

نفس آلية المطور 1: Codex مشرف، WorkBuddy منفذ من حسابه، وMCP محلي لتسليم المهام والتقارير. لا تشارك مجلد state أو tokens أو task approvals بين الجهازين؛ الحجز على جهازك لا يحجز ملفات جهاز زميلك، لذلك ملكية الملفات والفروع في 20 إلزامية.

تأكد من توفر Node.js 22 على جهازك، ثم شغّل من PowerShell داخل نسخة الريبو، بأمر إعداد الجسر فقط:

```powershell
node .\tools\workbuddy-bridge\setup.cjs --workspace "$((Get-Location).Path)" --bridge-dir "$env:USERPROFILE\TabwebClientBridge" --approve-connectivity
```

هذا ينسخ الجسر إلى مجلد جديد خارج Git، ويولد `workbuddy-mcp.json` بمسارات جهازك وNode الحقيقي ومهمة اتصال فقط. لا يشغّل منصة أو DB أو worker أو خدمة شبكة، ولا يثبت حسابًا أو يغير إعداد WorkBuddy تلقائيًا. إذا المجلد موجود توقف واختر اسمًا جديدًا بعد مراجعة المشرف؛ لا تحذف state قديمًا.

بدون `--approve-connectivity` يكون الطابور فارغًا. تمرير هذا الخيار موافقتك المحلية على **اختبار الاتصال فقط**. ليس تفويضًا آليًا لأي implementation task.

## 3. أضف MCP داخل WorkBuddy

1. افتح إدارة موصلات MCP في تطبيق WorkBuddy حسب واجهة الإصدار المثبت.
2. أضف stdio MCP من الملف المحلي `%USERPROFILE%\TabwebClientBridge\workbuddy-mcp.json`. اسم الموصل `tabweb-client-supervisor`. إن كانت الواجهة تطلب الحقول منفصلة، استخدم `command` و`args` من الملف كما هي.
3. حدّث/أعد اتصال الموصل داخل التطبيق. لا تشغّل نسختين قديمتين من الجسر على نفس مجلد العمل، ولا تقتل عمليات node بالاسم عشوائيًا.
4. تحقق أن الأدوات: `next_approved_task`, `submit_task_report`, `task_status`, `queue_status`, `dispatch_plan`, `task_heartbeat`, `task_checkpoint` ظاهرة. يجب أن يعيد queue_status إصدار 2.
5. ابعت إلى WorkBuddy تعليمات `tools/workbuddy-bridge/WORKER-PROMPT-CLIENT.md`، ثم اطلب تنفيذ **connection-001 فقط** وإرسال summary `CONNECTED WORKBUDDY-731`.
6. Codex المحلي يراجع ملف نتيجة الاتصال في `TabwebClientBridge/results/connection-001.json` ويؤكد عدم تنفيذ كود؛ قبلها لا تبدأ دفعة تنفيذ. نجاح stdio منفرد لا يثبت أن ربط التطبيق تم.

لا توجد مفاتيح API أو كلمات مرور للربط في هذه الحزمة؛ WorkBuddy يستخدم حساب المطور 2. MCP لا يغير الموديل أو حصته أو تسعيره، وFree لا تعني سعة بلا حدود.

## 4. رسالة البداية إلى Codex المحلي عند المطور 2

> اقرأ docs/20-two-developer-operating-plan-ar.md وdocs/21-developer-two-workbuddy-setup-ar.md والخطة الكاملة وتسليم M1 في docs/streams/client/M1-HANDOFF.md. أنت المشرف وأنا المطور 2. WorkBuddy منفذ بحسابي على codex/human-client. ملكيتنا src/** وpublic/** وindex.html وتقارير docs/streams/client/** فقط. استخدم جسر TabwebClientBridge المحلي، وتحقق من تقرير اتصال connection-001 قبل أي تنفيذ. اقترح دفعة واجهة كبيرة محددة بالملفات والعقود والاختبارات، وانتظر موافقتي قبل اعتمادها وإدراجها؛ لا تنشئ موافقة من نفسك. لا تعدل server/** أو الملفات المشتركة ولا تنقل claims من جهاز المطور 1. تنسيق API عند المشرفين عبر العقد أو التقرير، لا تعديل فرع الزميل. لا live DB/Docker/migrations/secrets/merge/push/deploy أو M2 دون تصريح محدد. لا تستخدم Codex/CodeBuddy CLI كمنفذ بديل عن WorkBuddy.

## 5. دورة المهام مثل المطور 1

- الإنسان يوافق على scope ملموس؛ Codex المحلي ينشئ JSON المهمة مع workspace المحلي، allowedPaths الدقيقة، dependencies، team وaccessMode وapprovalVersion=2، ثم يحسب scopeHash من `mailbox-core.cjs`. البصمة تربط الموافقة بنص المهمة ومساراتها، لكنها لا تمنح موافقة بشرية بذاتها.
- يمنع worker من كتابة approval أو state أو قراءة claim tokens الخاصة بغيره. لا نسخ state/results القديمة من جهاز المطور 1.
- يقرأ المنسق dispatch_plan، ويطلق أدوات WorkBuddy الأصلية للمهام ready فقط؛ كل عامل يطالب لنفسه مرة ويرسل checkpoint والدليل بعد توقف النشاط.
- Codex يراجع النتيجة والمصدر ضمن الملكية ويقبل أو يكتب متابعة؛ reported ≠ accepted. لا تفتح مرحلة تابعة من نجاح mock أو مدة انتظار.
- في 429: توقف وبلّغ مرة؛ لا retries متكررة أو تبديل حساب/موديل لتجاوز الحد. موعد reset المبلّغ ليس ضمانًا.
- الجسر لا يجدول المهام بنفسه؛ أي automation تضبط داخل WorkBuddy بموافقة صاحب الجهاز، client-only، بلا polling عند الفراغ أو بدء مراحل تلقائي. لا وعد بالعمل بعد إغلاق المضيف.
- لا retire إلا بعد ربط taskId بـnative run وإثبات توقفه؛ retire يقفل claim القديم ولا يعيد المهمة queued، ويلزم recovery task جديد داخل scope المعتمد.

## 6. كيف تتعاونون بلا تعارض

أنت تعمل على `codex/human-client`، والمطور 1 على `codex/workbuddy-server`. لا تكتب أنت server ولا يكتب هو src. العقود المشتركة وتغييرات package/lock/config والتبعيات تمر بالتنسيق حسب 20. قد تحتاج الواجهة عقد API قبل الاكتمال؛ سجل الحاجة ولا تخترع استجابة ناجحة أو endpoint بديل.

كل تسليم يذكر commit والملفات والعقود ونتائج الفحص والقيود، في `docs/streams/client/` أو PR عند التصريح. Codex يراجع الدمج. نشر هذه الحزمة على main لا يصرح تلقائيًا لك بدمج أو push أو تشغيل live.

## 7. ما الذي لا ينسخ من المطور 1

حساباته، MCP config بمسارات جهازه، claim tokens، state/results/checkpoints/archives، سجلات التطبيق وذاكرته، ملفات env أو بيانات الطلاب. المنقول فقط source الجسر العام وتعليمات الإعداد والخطة. الأسرار الخاصة بك تحفظ محليًا خارج Git.
