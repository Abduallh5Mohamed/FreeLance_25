# M2-04 — جانب المدرس من التسجيل والانضمام القائم

**مقبولة — 2026-10-19 بتوقيت القاهرة:** القبول المستقل في [080](coordination/supervisor/080-final-m2-04-instructor-students-acceptance.md)
بعد تصحيحات078/079: نجح583 اختبار عميل و5 اختبارات مشرف؛ صفر أخطاء أنواع داخل النطاق،
و11 خارجه. النطاق أدناه سجل تاريخي، لا مهمة جديدة. M2 ككل لم تكتمل؛ الجدولة مستمرة وفق075.

2026-10-18، codex/human-client. استمرار مباشر بطلب المستخدم «لا كمل عايز
اخلص m2 بقي قعدت كتير اوي». النطاق عُرض في المحادثة قبل المهمة؛ OTP مؤجل060.
039/055/067/074 مقبولة ولا تعاد. هذه شريحة منC8/C9/C10/B4، لا إغلاق شامل لها.

## النتيجة والسلوك

InstructorStudents.tsx يحمل الطلاب والرصيد والمجموعات وطلبات الانضمام/الاسترجاع
بلا generation/session/dispose guard. أخطاء طلبات تتحول إلى[]؛ دعوة تدور كل
ضغطة، ورفض clipboard بعد نجاح الدوران يعرض العملية كفشل رغم إلغاء الرابط
القديم. قبول/رفض الطلب بلا قفل فوري. إضافة الطالب تعتمد saving في React فقط
ثم تمسح النموذج بعد await دون عمر نموذج/جلسة. هذه أدلة مصدر لا خدمات حية.

المطلوب: قراءات بحالات loading/error/empty مستقلة، فشل جزئي لا يتحول لنجاح
أو فراغ، حفظ النماذج/الأهداف، قفل قبل أولawait، إبطال الردود القديمة وعمر
scope/form/decision/invitation عبر success/error/finally/dispose. نجاح إنشاء
دعوة أو طالب أو قرار خادمي لا يتحول لفشل الكتابة بسبب clipboard/refresh؛
لا إعادة إنشاء/تدوير صامتة. لا ادعاء نسخ إن clipboard غير متاح أو رفض.

## أربعة ملفات فقط

- src/pages/InstructorStudents.tsx
- src/features/enrollment/instructor-students.ts — seam إنتاج تستعمله الصفحة
- src/tests/m2-instructor-students.test.ts
- docs/streams/client/M2-04-CONTRACTS.md

قراءة العقود/الأنواع غير السرية الضرورية فقط: api/api-http/session-events،
instructors/student-enrollment/students/groups وما يلزم لفهم الاستدعاءات القائمة.
لا env/.qa/credentials/traces أو claim files. لا تعديل backend/shared/auth/API/
router/player/package/config/schema أو ملفات الدفعات المقبولة. لا نسخ وحدة كاملة
من دفعة قديمة؛ حدود صغيرة ضمن enrollment، وإعادة استعمال إنتاج موجود للقراءة
إن كان مناسبًا، لا تبعية عبر features أو helper مخصص للاختبارات بلا استعمال فعلي.

## عقود البيانات وحدود المرحلة

approve/reject يحكمهما student-enrollment routes؛ /requests للمدرس authenticated،
ولا تمنح واجهة admin صلاحية بمجرد الدور المحلي. createStudent يصون boolean
is_offline وعقد المجموعة وكلمة المرور، لا تغيير قواعد القبول أو رسوم/وصول مدفوع.
القبول الخادمي لا يثبت دفعًا أو مدة وصول. لا تحويل client للاشتراك/النوع.
rotateStudentInvite يلغي الرابط الأقدم، لذلك لا يكرر على clipboard failure.
لا طباعة رابط دعوة/كود استرجاع أو credentials في logs/tests/report؛ fixtures فقط.

المحفظة وعمليات الفيديو والاسترجاع اليدوي موجودة بالصفحة؛ لا تغيّر سياستها
أو تعرضها كميزات مكتملة جديدة. أبقِ عرض البيانات/الرسائل صادقًا، وفشل الرصيد
لا يعرض صفرًا كرصيد خادمي مؤكد. أي نتائج/روابط/أكواد خاصة قديمة لا تظهر تحت
جلسة أخرى. تصحيح عمر استدعاء موجود داخل الصفحة لا يضيف إجراء فيديو أو OTP.
تأجيل OTP الخاص بالهاتف والمزوّد المدفوع لا يمحو مسار الاسترجاع اليدوي القائم.

لا DB/network/browser/providers/services/Docker أو installs أو Git writes أو
commit/push/deploy أو تغيير أسعار/فوترة. لا anonymous onboarding أو checkout
أو فرع/دومين/وحدة/درس جديد. نقص upstream عقد يُسجل بدل اختراع field أو policy.

## الاختبارات والانتهاء

اختبارات hermetic لإنتاج فعلي تستخدمه الصفحة مع transport/storage/clipboard
محَقونة: duplicate add/approve/reject/invite، رفض ثم retry، نجاح الكتابة ثم
فشل refresh/clipboard، تغيير نموذج/طلبA→B→A/جلسة/هدف أثناء الانتظار، استجابة
معكوسة وunmount، finally قديم لا يحررbusy أحدث؛ failure/empty مستقلان. لا سجل
هوية تاريخي أو hash احتمالي، قارن الجلسة الفعلية داخليًا دون نشر التوكن.
حافظ على الحقول والعلاقات الحالية والفشل الجزئي، ولا تضع fixtures بالإنتاج.
RTL/labels والتعامل مع الإدخال الحالي؛ لا ادعاء DOM/a11y/runtime غير مختبر.

الأساس511 اختبار عميل و11 خطأ أنواع خارجي من074. شغّل المعزول والعميل المناسب
والـtsc الموجود؛ صفر أخطاء scoped، وافصل السابق. جرد before/after وcheckpoint
عند تقدم فعلي، ثم توقف قبل التقرير؛ Codex يراجع diff والمعمارية والعقود والاختبارات
مستقلًا ولا يقبل تقرير العامل وحده. لا عمل مصطنع/مدة أو مرحلة جديدة.
guard/429 توقف مرة مع disk state، لا retry/account/model workaround.

WorkBuddy وحده يسحب task وينفذ عبر native/MCP. لا Codex claim أو مالك بديل
بمرور الوقت. الفحص الساعي للعامل متوقع لا يثبت liveness. مراجعة المشرف كل15دقيقة
تستمر بعد قبول الدفعة وفق075 حتى شرط توقف مرحلةM2، ولا تنشئ عملًا بلا نطاق.
