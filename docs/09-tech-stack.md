# المكدس التقني المستهدف

**القرار الحاكم المحدث:** التسعير تدريجي للمدرس والسنتر؛ فوترة المؤسسة كل 30 يومًا مع حساب مدة فعلية بالثواني وتسوية، لا عمولة على الطلاب؛ محفظة السنتر وحده أو المدرس المستقل؛ خصم الاشتراك من المتاح ومهلة 4 أيام. المرجع [19 — القرارات المعتمدة](19-commercial-registration-wallet-agreement-ar.md)، والموافقة قبل التنفيذ في 18. الوثائق ليست دليل تشغيل.

التطبيق القائم يستخدم React/Vite، React Router، TypeScript، Express/TypeScript، MySQL/mysql2، MinIO، FFmpeg/HLS، Socket.IO، وNginx/PM2/Docker في ترتيبات نشر متعددة. لا يستبدل مكدس مستقر لمجرد التقليد؛ ثبّتوا build/deploy source of truth أولًا، وارفعوا الاعتماديات/الأسرار بما يتوافق مع بيئة الإنتاج.

| الطبقة | المسار | حالة/سبب |
|---|---|---|
| web | React + TypeScript + Vite | موجود؛ refactor domains والـroute permissions وRTL. PWA/mobile-first قبل native |
| API | Express + TS modular monolith | موجود؛ middleware موحد، DTO validation، repos tenant-aware |
| DB | MySQL/InnoDB | مصدر التشغيل؛ ledger migrations وFK مركب وbackup restore |
| cache/queue | Redis أو queue بديل مُدار بعد POC | يحتاج قرار provider وتوافر/retention/retry verification؛ لا يحتفظ بمصدر الحقيقة |
| media | provider interface: VdoCipher الحالي/منصة بث متوافقة | DRM حسب asset/license؛ HLS signed, live provider POC |
| live | managed WebRTC SDK | Zoom/Agora/LiveKit options لا تعتمد قبل POC وعقد |
| files | private object storage + signed access | MinIO موجود؛ تقييم object lifecycle/DR للبيئة |
| notifications | provider adapters in-app/email/SMS/WhatsApp | consent, delivery status, retries, unsubscribe |
| mobile | responsive web/PWA؛ native client لاحقًا بنفس API | الدعم مطلوب لكن storefront/native platforms تقرر بعد تجربة الأجهزة |
| CI/CD | pinned lockfiles، lint, TS build, unit/integration/security tests، migrations canary | سر مستودع خارج CI logs، approval stage, rollback |
| observability | structured redacted logs, metrics, traces, audit, alerts | tenant/request IDs بلا PII؛ dashboards/runbooks |

## سياسات تقنية

- كل integration خلف adapter وcontract test؛ أي provider behavior غير موثق يوسم **Needs verification**.
- لا secret fallback؛ لا public default credentials؛ failure عند إعداد حساس مفقود.
- لا migration إنتاج مباشرة قبل snapshot/restore/plan/apply/verify/revert.
- security gates mandatory على كل CI release؛ لا release إذا فشلت اختبارات M1.
- RTL/English strings مفاتيح translation، locale من تفضيل موثق وdate/number formatting محلي.

## الدفع
Provider adapter typed لعقود checkout/webhook/settlement/refund/payout؛ vendor لم يعتمد. MySQL transactions/DECIMAL/idempotency/outbox؛ لا بناء gateway أو خزنة بطاقات. كل capability تحتاج contract وسلوك sandbox موثق قبل F1.
