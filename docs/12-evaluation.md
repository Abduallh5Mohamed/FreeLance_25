# قرارات مفتوحة، تحقق، ومعيار التقييم

لا تستخدم درجات ذاتية لقول إن وثيقة أو منتج “8/10”. الحالة تتحدد بالأدلة: contract official، test run، deployment demonstration، support/restore records. أي قيمة أو API غير مثبتة وُسمت Needs verification.

## قرارات مثبتة في وثائق النطاق

| القرار | البدائل | السبب |
|---|---|---|
| المنتج كامل؛ M1–M8 ترتيب بناء | تقليصه لخطة تجريبية | الهدف الآن كل الأسطح والوظائف المدرجة في 02 و17 |
| أمن وعزل tenant قبل الوظائف | تقديم فيديو/تحصيل سريع على حساب العزل | كل عملية تعلم وملف/رسالة/درجة تعتمد على ملكية آمنة |
| مؤسسون يديرون عقد مدرس يدويًا حسب عدد الطلاب | اشتراك SaaS ذاتي/تسعير خوارزمي | نطاق الأعمال يقضي بأن يظل تحصيل المدرس خارجيًا؛ يبقى meter تقني |
| provider adapters قبل vendor commitment | ربط UI مباشرة بAPI غير متحقق | يخفض lock-in ويجعل اختبارات الحالة صريحة |
| owner resolution موثق للبيانات القديمة | backfill آلي تخميني | يحمي العزل ويمنع ربط الطالب/الدرجة لمؤسسة خاطئة |

## سجل التحقق

| الموضوع | الحالة | دليل الإغلاق المطلوب |
|---|---|---|
| مخطط MySQL/production routes | غير متحقق من قاعدة حية في هذا الملف | snapshot آمن، introspection ومطابقة migration ledger |
| ملكية صفوف legacy | غير محسومة | data map + review queue + reconciliation report |
| DRM/device coverage | يحتاج تحقق | تشغيل مصفوفة جهاز/متصفح وتقرير provider per asset |
| live provider behavior/price/regions | يحتاج تحقق | docs رسمية سارية، عقد، sandbox POC وfailure tests |
| OTP/WhatsApp/SMS APIs والتكلفة | يحتاج تحقق | provider account, template approval, opt-in and delivery verification |
| custom domain certificate lifecycle | يحتاج تحقق | DNS/TLS staging POC واختبار takeover/expiry |
| القانون والاحتفاظ/الأطفال | يحتاج مراجعة مختصة | خريطة controller/processor وسياسات وreview قانوني للأسواق |
| backup RPO/RTO | يحدد بالاختبار | restore drill وقياس وقت/نقطة التعافي |
| usage event reconciliation | لم ينفذ | invariant/event tests ومقارنة vendor usage/DB rollup |

## تعريف الحالة

- **Done:** تغيير منشور/في المصدر، الاختبار المرتبط ناجح في البيئة المحددة، وevidence قابل للتكرار.
- **Partial:** مسار أو طبقة موجودة، لكن coverage/authorization/devices/operations ناقصة.
- **Not done:** لا يوجد implementation أو acceptance proof.
- **Needs verification:** provider, deployment, production data أو تنظيم لم يقدم دليلًا بعد.

التقرير النهائي لا يسمي وظيفة Done اعتمادًا على backlog أو ملف تصميم. الأدلة ونتائج الاختبار في سجل التنفيذ أو commit. لا تحتوي هذه الوثيقة على درجات تقدير ذاتية.
