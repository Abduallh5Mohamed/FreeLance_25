# الفيديو المسجل، الحماية، والدروس الحية

**القرار الحاكم المحدث:** التسعير تدريجي للمدرس والسنتر؛ فوترة المؤسسة كل 30 يومًا مع حساب مدة فعلية بالثواني وتسوية، لا عمولة على الطلاب؛ محفظة السنتر وحده أو المدرس المستقل؛ خصم الاشتراك من المتاح ومهلة 4 أيام. المرجع [19 — القرارات المعتمدة](19-commercial-registration-wallet-agreement-ar.md)، والموافقة قبل التنفيذ في 18. الوثائق ليست دليل تشغيل.

## provider-neutral media layer

يوثق المشروع MinIO/FFmpeg/HLS ومزود VdoCipher Multi-DRM، لكن لا يفترض أن كل asset قديم محمي أو قابل للتحويل. احتفظوا بـ`VideoProvider` adapter يحوي upload session، asset state، playback token، watermark policy، usage report، recording ingest وdelete lifecycle. لا تعرضوا feature capability قبل test compatibility لكل جهاز/متصفح.

## تسجيل ورفع وتشغيل

1. المدرس ينشئ upload session بعد role/tenant/quota/mime/size validation؛ المتصفح يرفع مباشرة للمزود ببيانات قصيرة العمر.
2. asset يبدأ `pending`; التحقق من callback signature ثم استعلام المزود واعتماد internal asset ID قبل `ready`.
3. HLS/DASH ABR profile مضبوط لتجربة bandwidth منخفض؛ لا ينشر manifest عام. signed playback token scoped to lesson/tenant/student/session/expiry.
4. DRM حسب الجهاز/المحتوى وسياسة العقد؛ Widevine/FairPlay حسب الدعم المثبت. watermark متحرك يضم معرفًا جزئيًا وليس PII كاملًا.
5. session/device/concurrency policy تستند إلى session registry مع إنهاء واستعادة دعم مدققين، لا بصمة الجهاز كهوية موثوقة.
6. resume position يحفظ دوريًا مع quota للevents. Downloads تكون مشفرة/مرخصة فقط إذا provider/device capability وحقوق الناشر تسمح؛ الافتراضي منع التنزيل.

## الحماية ومواجهة التسريب

إبطال روابط قصيرة، rate limit لتجديد المفتاح، event من الخادم، علامة جزئية، تعارض الجلسات، رصد مشاركة session، وتحقيق بلاغ. لا تمنع DRM تصوير شاشة جهاز خارجي ولا نسخًا بشريًا كاملاً؛ رسائل المنتج تصف رفع كلفة التسريب. اختبار iOS/Safari/Android/Chrome/Firefox وحالات clock drift/offline/revoke مطلوب.

## Live inside platform

الهدف فصل live داخل Tabweb: إنشاء schedule/session، join token بعد enrollment، audio/video أو screen share، قائمة حضور تلقائي من participant join/leave، مدرّس/مساعد moderator، signaling/recording callback، حفظ recording كـmedia asset في مكتبة المقرر بعد معالجة وفحص owner، سياسات consent/retention، وتسجيل transcript إن تقرر لاحقًا.

لا تبنوا SFU أو DRM من الصفر. قارِنوا Zoom Video SDK، Agora وLiveKit Cloud أو مزودًا متوافقًا آخر بعقد رسمي. **السعر وميزات API والـrecording وregion تحتاج verification** من مستندات/حساب المزود عند وقت التنفيذ. القرار يكون بعد POC: latency مصر/الخليج، TURN/UDP restrictions، recording export، webhook identity، SLA، cost model، data processing، concurrent rooms. لا تدمج meeting provider إلى اعتماد إنتاج قبل فحص state retries.

## حدود وأحداث واحتفاظ

`live_session.created/scheduled/started/ended`, `participant.joined/left`, `recording.ready/failed`, `media.asset.ready` أحداث idempotent تحفظ vendor event ID، tenant, session, actor. حضور آلي يعالج late joins/reconnect وduplicate events، والمدرس يصحح record بسبب/هوية. التسجيل يدخل المكتبة بعد malware scan/processing/retention validation؛ حذف التسجيل لا يحذف سجل حضور/درجة.

## اعتماديات التنفيذ

M3 يأتي بعد M1/M2: secure asset ownership/enrollment, upload quota وsigned playback. M5 يعتمد live provider/POC وبنية event outbox. لا يوجد السعر أو vendor behavior في هذه الخطة كحقيقة مؤكدة حتى فحص رسمي وPOC.
