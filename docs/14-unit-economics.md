# 14 — Technical usage metering only

التحليل السابق لأسعار الباقات، تكلفة المزود، الهوامش والتعادل خارج النطاق الحالي، لذلك لا تستخدم جداول/أسعار النسخة السابقة كقرار تجاري. لا يضع النظام سعرًا للمدرس أو حد خطة محسوبًا على تكلفة فيديو.

## متطلبات القياس التقنية

المنصة تجمع وتصدر usage evidence لكل tenant والمدرس والفترة، بما يشمل:

| مقياس | event source | تعريف/دقة |
|---|---|---|
| Active students | enrollment + authenticated learning activity | تعريف activity window قابل للتكوين والتوثيق؛ لا يحسب pending/deleted |
| Watch minutes | signed player heartbeat/provider usage reconciliation | dedupe by session/event ID؛ يشمل partial/resume/seek policy معلنة |
| Storage | provider/object inventory snapshots | bytes per original/rendition/recording، status/deleted/reconciled |
| Live/recorded consumption | verified provider callbacks and media events | participants and playback separated |

## سياسة القياس

- سجل immutable `usage_event(tenant_id, actor_id, metric, quantity, unit, occurred_at, source, source_event_id, idempotency_key, schema_version)`؛ uniqueness تمنع التكرار.
- Aggregate يومي/شهري يمكن إعادة بنائه من ledger؛ لا تستخدم aggregate وحده كمرجع تدقيق.
- المدير يستطيع عرض وتصدير تقرير مفصل/ملخص؛ سبب/الفاعل/الفترة/التوقيت مسجلون؛ المدرس يرى استعمال مؤسسته فقط.
- مؤسس المنتج يقرر قيمة العقد والفاتورة يدويًا وفق عدد الطلاب؛ لا توجد auto charge, overage price, plan cap enforcement أو هامش ربح مشتق.
- مصالحة event counts/bytes/minutes مع مزود الفيديو والإبلاغ عن gap. Vendor metrics/API availability تحتاج تحققًا قبل الاعتماد.
