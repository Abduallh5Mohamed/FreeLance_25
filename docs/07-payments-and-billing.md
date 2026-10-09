# الدفع، الفوترة، والاستهلاك

## اشتراك Tabweb للمدرس

المؤسسون يتفقون مع كل مدرس/مركز ويصدرون الفاتورة ويتابعون التحصيل يدويًا وفق عدد الطلاب النشطين. المنصة لا تضع أسعارًا، لا تحسب قيمة مستحقة من meter، ولا تنفذ خصمًا أو تجديدًا تلقائيًا. تسجل `usage_event` ومجاميع usage المفسرة (active students, watch minutes, storage) مع فترة وتعريف القياس وإمكانية export ومصالحة؛ يقرر المؤسس قيمة العقد خارج النظام.

فصل `platform_contract/statement` عن student purchase. إذا سجل النظام فاتورة/دفعة للمراجعة التشغيلية، فهي إدخال إداري وليست بوابة تحقق/تسوية تلقائية. لا تخزن بيانات بطاقة.

## دفع الطالب / enrollment

الوظائف تدعم مدرسًا يحدد طريقة التسجيل ووصول الطالب وخصم coupon. لا ندّعي بوابة دفع محلية مكتملة حتى عقد وتحقق API/KYC/refunds/settlement والـmerchant-of-record. التكامل يكون hosted checkout باسم التاجر المسؤول وتأكيد webhook من المزود، مع amount/currency/order/idempotency؛ إن لم يُعتمد، يعرض النظام قناة المدرس الخارجية وحالة الوصول بوضوح دون إيصال كاذب. Tabweb لا تستقبل أو تحجز أموال مدرسين. تقسيم الأموال أو payout خارجي ليس قرارًا مفترضًا.

## تدفقات العمل

`Order.created → awaiting_provider → paid|failed|expired|refunded|disputed` إذا تكامل مزود معتمد. الـwebhook موقّع، idempotent، ويطابق حساب/عملة/مبلغ/order. enrollment حالة مستقلة عن payment لتعامل الدعم مع refund أو إلغاء المنهج. coupon يطبق server-side مع validity/cap/tenant. تسجيل كل تغيير ومراجعة مالية منفصلة.

## مزودون/أمان/اعتماد

Paymob/Fawry/wallets/Stripe availability, APIs, fees, recurring, webhooks, settlement, KYC, split payouts وrefund rules **تحتاج تحققًا رسميًا وعقدًا حسب البلد**. لا تنسخوا سعرًا منشورًا قديمًا ولا تسجلوا card PAN/CVV. خطط test/sandbox لكل provider جزء من M2/M7 حسب domain؛ الملف 17 يسجل gates.
