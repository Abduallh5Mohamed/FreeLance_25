# تقرير فحص المنصة وخطة التطوير الآمن

**التاريخ:** 2026-09-21  
**النطاق:** قراءة ساكنة للمستودع الحالي، وبناء الواجهة والخادم، وتحليل العقود والمسارات والـSQL المعلن.  
**المبدأ الحاكم:** المنصة الحالية هي الـBaseline؛ لا حذف لميزة عاملة، ولا تغيير صامت لقواعد العمل، ولا ترحيل هدّام للبيانات.

> هذا التقرير هو بوابة المرحلة الأولى قبل أي Refactor واسع. لم يتم الاتصال بقاعدة Production أو تعديل بياناتها، لذلك توصيف قاعدة البيانات هنا هو **النموذج المعلن في المستودع** وليس إثباتًا نهائيًا لحالة Production. قبل أي Migration يجب أخذ snapshot فعلي من `INFORMATION_SCHEMA` ونسخة احتياطية قابلة للاسترجاع.

## 0. الخلاصة التنفيذية

المنتج الحالي Modular Monolith بدائي لكنه قابل للتطوير تدريجيًا، وليس هناك مبرر لإعادة كتابته. الواجهة React/Vite/TypeScript، والخادم Express/TypeScript، وقاعدة التشغيل الحالية MySQL، مع MinIO وFFmpeg للفيديو، وSocket.IO للمحادثات، وGroq للمساعد الذكي، وخيارات WhatsApp متعددة.

البناء الحالي ينجح للواجهة والخادم، وهذا Baseline مهم يجب الحفاظ عليه. في المقابل، المنصة **غير جاهزة لتوسّع Multi-Tenant آمن** في وضعها الحالي. السبب ليس شكل المجلدات؛ السبب هو Broken Access Control: عدد كبير من API endpoints غير محمي مركزيًا، وعزل المدرّس جزئي واختياري، وبعض العمليات الحساسة تثق في IDs يرسلها العميل. توجد أيضًا أسرار مكشوفة داخل Source Code، وعمليات DDL خطرة أثناء Runtime، ولا توجد اختبارات آلية تحمي السلوك الحالي.

أعلى الأولويات، بالترتيب:

1. تدوير السر المكشوف فورًا خارج الكود، ثم إزالة كل fallback secrets.
2. إغلاق تصعيد الصلاحية في التسجيل العام، وحماية الحذف وعمليات الإدارة والمال والترحيلات والفيديو وSocket.IO.
3. إنشاء Authentication/Authorization boundary مركزي مع Default Deny، من دون تغيير العقود العامة دفعة واحدة.
4. تثبيت Schema وإيقاف DDL أثناء الطلبات، مع سجل migrations واحد وآمن.
5. إضافة characterization/authorization tests قبل نقل كل module.
6. إدخال Tenant/Workspace وMembership بصورة additive، ثم backfill والتحقق قبل فرض `NOT NULL`.

## 1. المعمارية الحالية

| الطبقة | الحالة الحالية | الملاحظة |
|---|---|---|
| Frontend | React 18 + Vite + TypeScript + React Router + TanStack Query + shadcn/Radix + Tailwind | 59 تعريف Route؛ أغلب الصفحات تستدعي HTTP client أو `fetch` مباشرة |
| Backend | Express 4 + TypeScript، Routes كبيرة تتعامل مباشرة مع SQL | لا توجد طبقات domain/repository واضحة؛ Controllers وBusiness Logic وSQL متداخلة |
| Database | MySQL عبر `mysql2/promise`، pool حجمه 10 | توجد بقايا Supabase migrations وadapter توافق، لكن مسار التشغيل الفعلي هو MySQL API |
| Storage/Video | MinIO + FFmpeg + HLS + signed URLs + video security sessions | المعالجة داخل نفس عملية Web؛ بعض key/stream endpoints تحتاج تشديد Authorization |
| Realtime | Socket.IO للمحادثات والحضور | لا توجد مصادقة handshake موثوقة حاليًا |
| Notifications | DB notifications + WhatsApp/Twilio/Baileys/free links | توجد عدة استراتيجيات متوازية وبعضها fallback صامت |
| Deployment | Docker/PM2/nginx ونسخ Hostinger/VPS متعددة | كثرة الحزم والنسخ المكررة تجعل مصدر النشر الفعلي غير واضح |
| Tests | scripts يدوية متفرقة فقط | لا توجد test runner أو suite في `package.json`; backend test script يفشل عمدًا |

التدفق الحالي باختصار:

```text
React pages/components
  -> api-http.ts / fetch / Supabase compatibility adapter
  -> Express route modules
  -> mysql2 queries مباشرة
  -> MySQL

Video: Browser -> Express session/upload APIs -> MinIO -> FFmpeg/HLS
Chat: Browser <-> Socket.IO -> MySQL messages
AI: Browser أو Express -> Groq API
```

## 2. جرد الميزات الحالية

| الميزة | Backend | Frontend | اعتماد البيانات/الخدمات | الحماية الحالية | المشكلة/الخطر | خطة آمنة |
|---|---|---|---|---|---|---|
| تسجيل الدخول والتسجيل | `auth.ts`, `staff.ts` | `Auth.tsx`, `AuthGuard.tsx` | users, staff, bcrypt, JWT | متفاوتة | Self-assigned role، JWT fallback، لا refresh/revoke | توحيد Auth service، قصر signup على student، session registry تدريجي |
| الطلاب Online/Offline | `students.ts`, registration requests | Students, OfflineStudents, registration pages | students, users, grades, groups | instructor scoping جزئي | CRUD مكشوف لأدوار أخرى، ربط user/student غير صريح | policy tests ثم ownership/tenant scope مركزي |
| المدرسون/Instructors | `instructors.ts` | AdminInstructors + Instructor pages | users + instructor wallet/share tables | غير محمي مركزيًا | إدارة الحساب والمحفظة بالـID؛ role/tenant مختلطان | إنشاء tenant + membership مع compatibility adapter |
| الموظفون | `staff.ts` | Staff + AuthGuard page labels | staff, accessible_pages | UI فقط في معظم التدفق | page labels ليست backend permissions | تحويلها إلى permissions versioned مع بقاء JSON مؤقتًا |
| المراحل والمجموعات | grades/groups routes | Grades, Groups | grades, groups, group_courses | عزل instructor جزئي | optional auth = fail-open | authenticate ثم scope policy، مع public reads محددة صراحة |
| الطلاب داخل المجموعات | students/groups | Students, Groups | students.group_id + group ownership | جزئي | لا tenant invariant شامل | FK/tenant consistency validation واختبارات cross-tenant |
| الكورسات | courses | Courses | courses, student_courses | غير محمي | CRUD عام عبر API | permission + tenant ownership؛ لا تغيير للأسماء العامة أولًا |
| المحاضرات | lectures | Teacher/Instructor/StudentLectures | lectures, groups, grades, courses | instructor scope جزئي | student access يعتمد IDs ومسارات عامة | enrollment + entitlement policy مركزي |
| المواد والملفات | materials | content managers/material pages | course_materials, material_groups, MinIO/Drive | instructor scope جزئي | streaming/conversion access غير موحد | resource policy + signed delivery + MIME/size validation |
| الفيديو | videos, secure-video, processor/security | uploaders/players/security hooks | videos, MinIO, HLS, sessions/logs | خليط بين JWT وbody token وعمليات عامة | key endpoint غير مكتمل الحماية، admin ops عامة | policy على video.read/upload/delete + session claims + background worker لاحقًا |
| الامتحانات والأسئلة | exams | TeacherExams, EditExam, TakeExam | exams/questions/groups/attempts/results | optional auth ومعرّفات من العميل | IDOR محتمل، route ضخم 1751 سطرًا | characterization tests ثم split service/repository/policies |
| محاولات ونتائج الامتحان | exams, exam-results, manual-grading | result/review/grading pages | attempts/results/answers | غير متسق | الطالب قد يحدد studentId؛ grading غير محمي مركزيًا | principal-derived student identity + grader permission |
| الحضور/QR/Barcode | attendance | Attendance/QR/Barcode/Log | attendance, QR codes, students/groups | optional auth | عمليات الكتابة ليست Default Deny | permission matrix + scope + idempotency tests |
| الاشتراكات التعليمية | subscriptions/plans/requests | Subscriptions, StudentPayments | plans, subscriptions, requests | غير محمي مركزيًا | خلط plan catalog مع student payments | فصل catalog/tenant entitlement/student purchase مع adapters |
| Premium lectures | premium-lectures | teacher/student premium pages | premium lectures/access/payments | endpoints مكررة | تسعة عقود API مكررة داخل نفس router | تثبيت behavior، اختيار implementation واحدة، deprecation داخلي |
| الرسوم والمدفوعات | fees/payment requests | Fees/StudentPayments | student_fees, payment requests | غير محمي مركزيًا | قراءة/تعديل مالي عام؛ DDL runtime | حماية billing permissions ونقل DDL إلى migration |
| المصروفات والحساب والأرباح | expenses/imports/revenues | Expenses/Imports/AccountStatement/Profits | expenses/imports/items/account/revenues | غير محمي | imports يحذف جدولين عند أول طلب؛ revenues غير mounted | إيقاف DDL الهدّام، backup/migration، توضيح domain |
| المحادثات | messages + Socket.IO | Messages/StudentChat/TeacherChat | messages/conversations/deletions/status | HTTP JWT محلي؛ socket بلا تحقق | انتحال userId عبر socket | JWT handshake + server-derived principal + room authorization |
| الإشعارات | notifications | NotificationBell/cards | notifications | IDs من query/body | قراءة/mark read لمستخدم آخر | اشتقاق user من token؛ admin send permission |
| الاجتماعات | meetings | OnlineMeeting/StudentMeetings | online_meetings/groups | optional auth | IDOR وعزل instructor جزئي | meeting policy + enrollment checks |
| المساعد الذكي | ai-chat + direct browser call | ChatAssistant | Groq | backend JWT لكن الواجهة تتجاوزه | مفتاح API مكشوف ومضمّن في bundle | rotate ثم backend-only proxy + rate/quota controls |
| WhatsApp | Twilio/Baileys/free link | attendance and pending helpers | external APIs/local storage | غير موحد | mock success قد يخفي فشل الإرسال | provider abstraction + delivery status + audit |
| التقارير والتحليلات | نتائج/حضور/رسوم + صفحات Reports | Reports/StudentReports/ExamReports | عدة جداول | UI role checks غالبًا | over-broad data access، لا field filtering | read permissions + tenant filters + projection DTOs |

## 3. نموذج قاعدة البيانات الحالي

### 3.1 النموذج الأساسي المعلن في `database/mysql-schema.sql`

| المجال | الجداول الرئيسية | العلاقات الأهم |
|---|---|---|
| Identity | users, user_roles, staff | user_roles -> users؛ staff هوية موازية مستقلة |
| Academic | grades, courses, groups, group_courses | groups -> grade/course؛ group_courses many-to-many |
| Students | students, student_courses, student_registration_requests | student -> grade/group؛ student_courses -> student/course |
| Content | course_materials, material_groups, student_materials | material -> course؛ access عبر group أو student |
| Exams | exams, exam_questions, exam_groups, exam_results, exam_student_answers | exam -> course/questions؛ result/answers -> student |
| Attendance | attendance, attendance_qr_codes | attendance -> student/course/group/user |
| Finance | subscriptions, expenses, account_statement | subscription -> student/course؛ expenses/account have created_by |
| Communication | teacher_messages | sender/recipient relations موصوفة على students |
| Operations | online_meetings, imports | meetings -> course/group/user؛ imports records |

### 3.2 جداول/أعمدة يعتمد عليها Runtime لكنها ليست مجمعة في baseline واحد

- lectures و`instructor_id` على lectures/students/groups.
- instructor_wallets, instructor_wallet_transactions.
- instructor_video_requests, instructor_shared_lectures.
- videos, video_sessions, video_security_logs.
- messages/conversations/message_deletions/user_online_status.
- notifications.
- student_fees وpayment_requests.
- subscription_plans وsubscription_requests.
- premium_lectures, premium_lecture_access, premium_lecture_payments.
- exam_attempts وحقول essay/question images.

هذه الفجوة تعني وجود **Schema Drift**: لا يوجد migration chain واحد يعيد إنشاء قاعدة مماثلة بثقة. بعض الـroutes تنشئ أو تعدّل الجداول أثناء الطلب، و`imports.ts` ينفذ `DROP TABLE IF EXISTS` قبل إعادة الإنشاء عند أول استخدام. هذا خطر فقد بيانات Critical ويجب ألا يصل إلى Production بصورته الحالية.

### 3.3 مشكلة مصدر الحقيقة

يوجد تاريخ Supabase/PostgreSQL migrations كبير، لكن client الحالي compatibility adapter، والخادم يستخدم MySQL. لذلك لا ينبغي تشغيل Supabase migrations أو اعتبارها schema فعليًا دون قرار موثق. الهدف: MySQL migrations تصبح المصدر الوحيد للحالة التشغيلية الحالية، وتُنقل Supabase artifacts إلى archive موثق بعد إثبات عدم استخدامها.

## 4. Authentication الحالي

- Login بالهاتف أساسًا، والبريد للتوافق السابق، مع bcrypt وJWT صالح افتراضيًا 7 أيام.
- Login يبحث في `users` ثم `staff`، ويحوّل staff إلى JWT role=`staff`.
- Token محفوظ في `localStorage`، و`currentUser/currentStudent` أيضًا؛ AuthGuard يثق بهذه البيانات للواجهة.
- `/auth/me` يتحقق من JWT ثم من `is_active` في users، لكنه لا يدعم staff بصورة متناسقة.
- لا يوجد logout server-side، refresh token، session registry، session revoke عام، reset password، email/phone verification workflow مكتمل، MFA، أو device/session management عام.
- shared middleware يتحقق من التوقيع فقط ولا يعيد فحص نشاط/تعليق الحساب في كل request.
- توجد نسخ متعددة من JWT middleware داخل route modules، مع fallback secrets مختلفة؛ هذا يخلق أكثر من مصدر حقيقة.

## 5. Authorization الحالي

الحالة الحالية Role-based وPage-based بصورة جزئية:

- Frontend `AuthGuard` يمنح `admin` وصولًا كاملًا، ويسمح `teacher/student/instructor` بحسب route، ويستخدم `accessible_pages` للـstaff.
- هذه الحماية UX فقط ويمكن تزوير `currentUser` في Local Storage.
- Backend لا يطبّق authorization مركزيًا. يوجد `authenticateToken` في عدد محدود من endpoints، و`optionalAuth` في بعض modules لعزل instructor فقط إذا وُجد token صالح.
- `optionalAuth` يتجاهل token غير الصالح ويمرر الطلب، ولذلك لا يصلح لحماية عمليات الكتابة.
- لا يوجد permission catalog، resource policy، ownership policy، entitlement policy، أو default-deny gateway موحد.
- عزل Instructor الحالي مفيد كبداية لكنه ليس Tenant isolation كاملًا، و`tenant = instructor user` ما زال متضمنًا في التصميم.

## 6. الأدوار الموجودة

| الدور | الاستخدام الحالي | الملاحظة |
|---|---|---|
| admin | وصول UI كامل وإدارة التسجيل وبعض Instructor UI | صلاحية واسعة جدًا ومشفرة بالاسم |
| teacher | منصة الإدارة التعليمية والمالية الحالية | يجمع tenant owner/teacher/operations/billing عمليًا |
| student | تجربة الطالب والمحتوى والامتحانات والمدفوعات | الهوية وربط student record غير موحدين |
| instructor | مسار جديد تدريجيًا ببيانات ومحفظة ومشاركة فيديو | يُستخدم كـtenant owner وrole في الوقت نفسه |
| staff | حساب في جدول منفصل + `accessible_pages` | page permissions فقط وليست action/resource permissions |

## 7. وظائف الإدارة الحالية

- إدارة Instructor accounts وتفعيلها/إيقافها وحذفها.
- اعتماد/رفض طلبات تسجيل الطلاب وطلبات الاشتراك والدفع والمحاضرات المدفوعة.
- إدارة الطلاب والكورسات والمراحل والمجموعات والحضور والمحتوى والامتحانات.
- إدارة الموظفين وقائمة الصفحات المسموح بها.
- الرسوم والمصروفات والواردات وكشف الحساب والأرباح.
- مراجعة الامتحانات والتصحيح اليدوي والتقارير.
- لا توجد Admin Platform موحدة بمستويات SUPER/OPS/BILLING/SUPPORT/SECURITY/CONTENT/ANALYST بعد.

## 8. وظائف المدرس/Instructor الحالية

- Dashboard وإحصاءات ومحفظة وحركات مالية.
- محاضرات وطلاب مرتبطون بـ`instructor_id`.
- طلبات شراء/مشاركة فيديو ومحاضرات بين المدرسين.
- دخول إلى subset من صفحات teacher التعليمية: المحتوى، الامتحانات، النتائج، التصحيح، الطلاب، المجموعات، الحضور والمحادثات.
- scoping مضاف لبعض routes (students/groups/lectures/materials/exams/attendance/meetings/results) لكنه غير شامل وغير mandatory.

## 9. وظائف الطالب الحالية

- Dashboard ومحتوى ومحاضرات ومواد واجتماعات.
- امتحانات: عرض، دخول، حفظ تقدم، تسليم، نتائج ومراجعة.
- Premium lectures وطلبات الدفع.
- محادثات ورسائل ومساعد ذكي.
- تقارير ومدفوعات.
- حماية عرض/تسجيل الشاشة ومحاولات video session/security.

## 10. خريطة API الحالية

الخادم يركب 29 route modules تحت `/api`، مع نحو 220 تعريف endpoint في الملفات؛ الرقم يتضمن تعريفات مكررة في premium lectures. `revenues.ts` موجود لكنه غير mounted.

| Prefix | العقود الحالية المختصرة |
|---|---|
| `/auth` | login, register, me, delete student user, search phone |
| `/students` | CRUD, lookup email/phone/barcode, notes |
| `/courses`, `/grades`, `/groups` | CRUD |
| `/attendance` | CRUD + notify absent |
| `/exams` | student list, CRUD, groups, questions/images, attempts/progress/submit/results/review |
| `/exam-results` | list/by student/by id |
| `/manual-grading` | pending, submit |
| `/lectures` | CRUD + student view |
| `/materials` | CRUD + student view + Drive conversion/stream |
| `/videos` | upload lifecycle, keys, stream/refresh, CRUD, retry/reprocess, analytics/security logs |
| `/secure-video` | session, refresh, heartbeat, violations, kill, key, logs |
| `/subscriptions`, `/subscription-plans` | CRUD |
| `/subscription-requests` | list/create/approve/reject/delete/cleanup |
| `/fees` | CRUD |
| `/payment-requests` | list/create/approve/reject/stats |
| `/premium-lectures` | lecture CRUD/access + payment flow؛ تسعة endpoints مكررة |
| `/expenses` | CRUD |
| `/imports` | CRUD with items؛ schema initialization خطر |
| `/messages` | conversations, unread, send/upload/edit/delete/read/users |
| `/notifications` | list/read/read-all/count |
| `/meetings` | CRUD/student/groups by grade |
| `/registration-requests` | public create + admin list/approve/reject |
| `/staff` | CRUD + login |
| `/instructors` | CRUD + stats/lectures/students |
| `/instructor-wallet` | balance/transactions/credit/debit |
| `/instructor-video-requests` | list/available/mine/received/shared/create/respond/delete |
| `/ai-chat` | authenticated chat proxy |
| `/migrations` | three mutation/migration endpoints مكشوفة |

ملاحظة أمنية كمية: 17 فقط من 220 تعريف route تحمل `authenticateToken` صراحة على سطر التعريف. بعض modules تستخدم `optionalAuth` أو تحققًا داخليًا، لذا الرقم ليس نسبة حماية نهائية، لكنه يثبت غياب policy موحدة ويبرر مراجعة endpoint-by-endpoint.

## 11. خريطة Frontend routes

| النطاق | المسارات |
|---|---|
| Public | `/`, `/promo`, `/auth`, `/login`, `/test-video` |
| Teacher/Admin operations | `/teacher`, `/courses`, `/students`, `/offline-students`, `/registration-requests`, `/subscriptions`, `/groups`, `/grades`, `/attendance`, `/barcode-attendance`, `/attendance-log`, `/student-payments`, `/fees`, `/messages`, `/reports`, `/expenses`, `/account-statement`, `/imports`, `/student-barcodes`, `/profits`, `/staff`, `/online-meeting` |
| Teacher content/exams | `/course-content`, `/teacher-content-manager`, `/teacher-lectures`, `/teacher-exams`, `/teacher/exams/:examId/edit`, `/exam-reports/:examId`, `/exam-results`, `/manual-grading`, `/student-reports`, `/chat-assistant`, `/teacher-premium-lectures` |
| Admin | `/admin/instructors` فقط حاليًا |
| Instructor | `/instructor`, `/instructor-lectures`, `/instructor-wallet`, `/instructor-video-requests`, `/instructor-students` |
| Student | `/student`, `/student-ai-chat`, `/student-chat`, `/student-messages`, `/student-content`, `/student-lectures`, `/student-exams`, `/student-exam-results`, `/exam-review/:examId`, `/student-premium-lectures`, `/student-meetings`, `/exam-access`, `/take-exam/:examId` |

يوجد تعريفان متعارضان للمسار `/student-reports`؛ أحدهما `StudentReports` والآخر `Reports`. يجب تثبيت أيهما السلوك الفعلي باختبار routing ثم إزالة التكرار دون تغيير URL.

## 12. التكاملات الخارجية

| التكامل | الاستخدام | الملاحظات |
|---|---|---|
| MySQL | مصدر البيانات التشغيلي | لا توجد migration ledger موحدة |
| MinIO | originals/HLS/thumbnails وsigned URLs | defaults غير آمنة إن غابت env؛ URLs/logging تحتاج تقليلًا |
| FFmpeg | transcoding وHLS/encryption | داخل web process حاليًا؛ يحتاج job boundary عند الحاجة الفعلية |
| Socket.IO | messaging/presence | handshake غير موثق بالمستخدم |
| Groq | المساعد الذكي | مفتاح حي ظاهر في frontend/backend؛ يجب تدويره فورًا |
| Twilio WhatsApp | رسائل WhatsApp | fallback mock success عند غياب الإعداد |
| Baileys | WhatsApp مجاني/session محلية | lifecycle وتشغيله بحاجة عزل ومراقبة |
| wa.me | إرسال يدوي | مناسب كـfallback صريح فقط |
| Google Drive | روابط مواد وتحويل embed/stream | لا يوجد OAuth؛ يعتمد public sharing links |
| nginx/PM2/Docker | النشر والبروكسي | ملفات كثيرة متباينة؛ يلزم تعريف canonical deployment |

## 13. مشكلات الأمان الحالية

### Critical

1. **سر مزود AI مكشوف داخل Source والـbrowser bundle.** يلزم revoke/rotate خارج المستودع فورًا، ثم backend-only integration. إزالة النص من Git لا تلغي صلاحية المفتاح القديم.
2. **Privilege escalation في `/auth/register`.** العميل يستطيع إرسال `role`، ولا توجد allow-list تجبر التسجيل العام على student.
3. **Broken Access Control واسع.** CRUD للإدارة والمال والمحتوى وwallet/instructors والمهاجرات متاح بلا authorization مركزي، وبعضه بلا authentication.
4. **حذف بيانات غير مصرح به.** endpoint حذف student user/data لا يتحقق من admin.
5. **Socket.IO identity spoofing.** العميل يرسل `userId` ويُضم إلى room ويستطيع تنفيذ أحداث مع IDs يقدمها بنفسه.
6. **Data loss path.** أول استخدام لـimports قد يسقط `imports` و`import_items` ويعيد إنشاءهما.
7. **Migration endpoints عامة.** يمكنها ALTER schema أو تحويل question type عبر HTTP.
8. **Video key/access gaps.** يوجد TODO صريح للتحقق من حق المشاهدة وبعض secure-video actions بلا JWT صريح.

### High

- JWT secret له fallback ضعيف بدل fail-fast، وتوجد عدة middleware implementations.
- CORS callback يسمح بكل origin في فرع الرفض؛ Socket CORS أيضًا يحتاج سياسة واحدة.
- tokens في localStorage تجعل أثر أي XSS أكبر، والواجهة تثق بـ`currentUser` كصلاحية.
- notification/student/exam/payment endpoints تعتمد userId/studentId من URL/body، ما يفتح IDOR.
- `optionalAuth` يحوّل token الفاسد إلى anonymous، ثم يسمح للطلب بالاستمرار.
- static `/uploads` عامة ومركبة مرتين؛ يلزم تصنيف الملفات العامة والخاصة.
- Login logs جسم الطلب، ما قد يطبع كلمة المرور في logs.
- لا rate limiting/login throttling، ولا Helmet/security headers على Express، ولا validation schemas مركزية.
- auth middleware لا يفحص `is_active` أو suspension/session revocation في كل request.
- رسائل الخطأ العامة تعيد `err.message`، وقد تكشف تفاصيل داخلية.

### Medium

- لا CSRF concern مباشر مع Bearer/localStorage، لكن التحول مستقبلًا إلى cookies يحتاج CSRF design.
- file upload policies وMIME/content scanning ليست موحدة.
- لا audit trail موثوق للعمليات الحساسة.
- Default MinIO credentials موجودة كfallback، ويجب رفض تشغيل Production بها.
- credentials تشغيلية موثقة داخل `.env.example`; يجب استبدالها بقيم غير حقيقية وتدوير أي قيمة استُخدمت فعليًا.

## 14. المشكلات المعمارية

- routes ضخمة؛ `exams.ts` وحده 1751 سطرًا، مع SQL وvalidation وbusiness rules والاستجابة في مكان واحد.
- `api-http.ts` 1801 سطر، وصفحات متعددة تتجاوز client وتستخدم `fetch` مباشرة.
- Identity موزعة بين users/staff/students، وربط user-student يعتمد phone/email أحيانًا.
- role وtenant owner وplatform admin مفاهيم مختلطة.
- schema يُدار عبر عشرات SQL/scripts وruntime DDL بدل migration history واحدة.
- مصدران تاريخيان للبيانات: Supabase artifacts وMySQL runtime.
- نسخ deployment وbackups وملفات `_OLD/_NEW` داخل source tree تزيد احتمال تعديل أو نشر نسخة خاطئة.
- logging بـ`console` غير structured ولا يملك correlation/redaction policy.
- duplicate routes في frontend وpremium backend.
- `revenues.ts` dead/unmounted ظاهريًا؛ لا يُحذف قبل إثبات عدم وجود consumer خارجي.

## 15. مخاطر الأداء

- Production JS الرئيسي ~2.46 MB (~707 KB gzip)، وVite يحذر من chunk أكبر من 500 KB؛ لا يوجد route-level lazy loading.
- Imports endpoint ينفذ N+1 query لجلب items لكل import.
- كثير من القوائم `SELECT *` بلا pagination أو حدود؛ خطر على الطلاب/الرسائل/النتائج/logs.
- body limit = 50 MB لكل JSON/urlencoded request، ما يزيد memory/DoS risk.
- FFmpeg processing وإعادة معالجة stuck videos داخل web process؛ ضغط CPU/ذاكرة واحتمال duplicate jobs بعد restart.
- analytics وبعض التقارير تعتمد joins/aggregation من دون إثبات indexes متسق عبر schema drift.
- Socket.IO presence يبث status عالميًا وقد لا يناسب multi-instance أو tenant isolation.
- صور كبيرة في bundle العام؛ اثنتان تتجاوزان 1 MB.

القاعدة: لا تحسين تخميني. بعد إغلاق الثغرات يُضاف query timing وslow-query log وbundle budget وload test قبل اختيار cache/queue/Redis.

## 16. مخاطر سلامة البيانات

- DROP runtime لجداول imports.
- عمليات approve/payment/wallet تحتاج معاملات DB وidempotency keys؛ بعض التدفقات متعددة الخطوات يمكن أن تنجح جزئيًا.
- استخدام phone/email لربط users وstudents قد يحذف/يعدل سجلًا خاطئًا عند التكرار أو تغير الهاتف.
- migration files متكررة ومتضاربة، وبعضها يعدل ENUM للدور بقيم مختلفة.
- runtime auto-create/alter يخفي الفشل ويجعل النسخ المختلفة من التطبيق تعمل على schemas مختلفة.
- tenant ownership ليس invariant على كل resource؛ backfill مستقبلًا قد يكون ambiguous.
- generated columns وتعريفات الجداول موزعة، ولا يوجد schema version check عند startup.
- hard deletes واسعة مع CASCADE بلا soft-delete/audit/retention policy واضحة.

## 17. المعمارية المستهدفة

الهدف Modular Monolith داخل نفس Express/React/MySQL stack:

```text
HTTP / Socket adapters
  -> Authentication (principal + active session)
  -> Tenant context resolution
  -> Authorization policy (principal, action, resource, context)
  -> Module application service
  -> Tenant-aware repository / transaction boundary
  -> MySQL

Cross-cutting: audit, validation, errors, observability, feature flags
```

الوحدات المقترحة دون إعادة كتابة دفعة واحدة:

- IAM: users, credentials, sessions, verification, recovery.
- Tenancy: tenants, memberships, tenant selection/context.
- Authorization: permissions, roles, policies, ownership/relationships/entitlements.
- Academic Catalog: grades, courses, groups, enrollments.
- Learning Content: lectures, materials, videos.
- Assessment: exams, questions, attempts, grading, results.
- Attendance.
- Billing & Entitlements: plans, subscriptions, payments, wallets.
- Communications: messages, notifications, WhatsApp.
- Platform Admin & Support.
- Audit & Security Events.

لا Microservices/Kafka/CQRS الآن. يُفصل video processing إلى worker داخل نفس codebase فقط عندما تقيس الحاجة، مع transactional job table قبل إدخال بنية إضافية.

## 18. تحليل الفجوات Current -> Target

| المجال | Current | Target | الخطر | الحاجة | التعقيد | الأولوية | Regression |
|---|---|---|---|---|---|---|---|
| Authentication | JWT طويل بلا sessions | central auth + revocable sessions | Critical | نعم | متوسط | P0 | عالٍ |
| Authorization | role/page checks متفرقة | permission/policy default deny | Critical | نعم | عالٍ | P0 | عالٍ |
| Tenant isolation | instructor columns جزئية | tenant context + scoped repos | Critical | نعم | عالٍ | P0 | عالٍ |
| Secrets | hardcoded/fallback | secret manager/env fail-fast | Critical | نعم | منخفض | P0 | منخفض |
| DB migrations | scripts/runtime DDL | versioned expand/migrate/contract | Critical | نعم | عالٍ | P0 | عالٍ |
| Data identity | users/staff/students منفصلة | user identity + memberships/profiles | High | نعم تدريجيًا | عالٍ | P1 | عالٍ |
| Admin | admin full access | one `/admin`, capability driven | High | نعم | متوسط | P1 | متوسط |
| Billing | endpoints عامة ونماذج مختلطة | scoped billing + entitlements | Critical | نعم | عالٍ | P1 | عالٍ |
| API structure | fat route handlers | thin routes + services/repos | Medium | feature-by-feature | متوسط | P2 | متوسط |
| Frontend auth | localStorage role trust | server capabilities + UX guards | High | نعم | متوسط | P1 | متوسط |
| Tests | لا suite | characterization/integration/E2E/security | High | نعم | متوسط | P0 | منخفض |
| Realtime | client userId | authenticated socket principal | Critical | نعم | متوسط | P0 | متوسط |
| Observability | console logs | structured/redacted/correlated | Medium | نعم | منخفض | P2 | منخفض |
| Performance | large bundle/unbounded lists | lazy routes/pagination/metrics | Medium | بعد القياس | متوسط | P2 | متوسط |

## 19. استراتيجية الترحيل

1. **Freeze and observe:** توثيق العقود، snapshot schema/data volumes، وتسجيل Baseline builds والـcritical flows.
2. **Emergency containment:** rotate secrets، قفل registration role، protect destructive/admin/migration/socket/video key paths، من دون إعادة تسمية APIs.
3. **Characterization tests:** login، registration approval، student CRUD، exam lifecycle، payments، video access، messaging.
4. **Central principal:** middleware واحد يفشل عند غياب/فساد config، ويفحص user/session status.
5. **Authorization foundation:** `authorize(action, resourceLoader, policy)` مع deny by default وaudit decision.
6. **Tenant foundation (additive):** tenants/memberships وnullable `tenant_id` + backfill reports، مع بقاء instructor columns مؤقتًا.
7. **Dual read—not dual decision:** compatibility adapter يحوّل old ownership إلى tenant context؛ Authorization service وحدها تصدر القرار.
8. **Module migration:** endpoints واحدة تلو الأخرى، بدءًا بالأخطر: migrations/auth/admin/wallet/billing/video، ثم academic/content/exams.
9. **Permission-driven UI:** `/me/capabilities` أو bootstrap response؛ إخفاء navigation/action/fields للـUX مع بقاء backend source of truth.
10. **Contract phase:** بعد إثبات 100% backfill ومرور regression، تُفرض constraints؛ حذف old columns يؤجل لإصدار مستقل مع rollback window.

## 20. نموذج الأدوار الجديد

### Platform scope

- SUPER_ADMIN
- OPERATIONS_ADMIN
- BILLING_ADMIN
- SUPPORT_ADMIN
- SECURITY_ADMIN
- CONTENT_ADMIN
- ANALYST

### Tenant scope

- TENANT_OWNER
- INSTRUCTOR
- ASSISTANT_INSTRUCTOR
- TEACHING_ASSISTANT
- CONTENT_MANAGER
- GRADER
- MODERATOR
- TENANT_STAFF
- STUDENT (علاقة enrollment/profile، وقد تمثل membership محدودة)

الدور مجموعة permissions قابلة للإدارة؛ لا يكون شرط Business Logic. نفس المستخدم يمكن أن يحمل platform assignment وواحدة أو أكثر من tenant memberships مستقبلًا.

## 21. Permission catalog المقترح

الأسماء `resource.action`، مع scope مستقل في assignment/policy:

- `tenant.create/read/update/suspend`
- `admin.read/create/update/roles.assign/sessions.revoke/impersonate`
- `role.read/create/update/delete`, `permission.read/assign`
- `user.read/update/suspend`, `session.read/revoke`, `security_event.read/manage`
- `course.create/read/update/delete/publish`
- `grade.read/manage`, `group.create/read/update/delete`
- `student.read/create/update/delete/enroll`, `enrollment.read/manage`
- `lecture.create/read/update/delete/publish`
- `material.upload/read/update/delete`
- `video.upload/read/update/delete/reprocess/security.read`
- `exam.create/read/update/delete/publish`
- `exam.attempt`, `exam.results.read`, `submission.read/grade`
- `attendance.read/mark/update/delete`
- `message.read/send/moderate`, `notification.read/send`
- `meeting.create/read/update/delete`
- `plan.read/manage`, `subscription.read/create/update/cancel`
- `payment.read/create/approve/reject/refund`
- `wallet.read/credit/debit`, `invoice.read/manage`
- `support_ticket.read/update`, `analytics.read/export`
- `audit.read`, `settings.read/update`, `feature_flag.read/update`

Ownership وrelationship وentitlement ليست permissions جديدة؛ هي شروط إضافية على القرار، مثل `lecture.read` **و** نفس tenant **و** enrollment/entitlement صالح.

## 22. Permission matrix المستهدفة

الرموز: **M** إدارة، **R** قراءة، **L** محدود/حسب العلاقة، **—** منع.

| المجال | Super | Ops | Billing | Support | Security | Content | Analyst | Tenant Owner | Instructor | TA/Grader | Student |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Tenants/accounts | M | M | R | L | L | R | R | own | — | — | — |
| Platform admins/roles | M | — | — | — | L | — | — | — | — | — | — |
| Students/enrollment | R/M | M | R | L | — | R | R | M | M | L | own |
| Courses/content | R/M | R | — | L | — | M | R | M | M | L | entitled R |
| Exams/grading | R/M | R | — | L | — | M | R | M | M | L/M assigned | attempt/own R |
| Attendance | R/M | M | — | L | — | R | R | M | M | L | own R |
| Billing/payments | R/M | R | M | L | — | — | R aggregates | M own tenant | L own | — | own |
| Wallet/refunds | M | — | M | — | — | — | R aggregates | L own | own R | — | — |
| Support | M | L | L | M | L | — | R aggregate | own tenant | L | — | own tickets |
| Security/sessions | M | — | — | revoke limited | M | — | R aggregate | tenant limited | own | own | own |
| Audit | M | R | billing R | support R | M | content R | R redacted | tenant R | own actions | own | own limited |
| Analytics | M | M | billing | support | security | content | R/export | tenant | teaching | assigned | own |

كل خلية تُترجم إلى permissions صريحة وسياسات field-level، ولا تُنفذ كـ`if role === ...`.

## 23. Tenant model

الجداول additive المقترحة:

- `tenants(id, name, slug, status, owner_user_id_legacy?, created_at, ...)`
- `tenant_memberships(id, tenant_id, user_id, status, joined_at, ...)`
- `roles(id, scope_type, tenant_id nullable, code, name, system_managed, ...)`
- `permissions(id, code, description)`
- `role_permissions(role_id, permission_id)`
- `membership_roles(membership_id, role_id)`
- `platform_role_assignments(user_id, role_id)`

تُضاف `tenant_id` تدريجيًا إلى groups/courses/lectures/materials/videos/exams/questions/attempts/results/students/enrollments/attendance/meetings/payments/notifications والبيانات التحليلية. في كل request:

1. principal من session الموثقة.
2. tenant من membership/route/header مقيد، وليس من body بحرية.
3. resource يُحمّل داخل tenant scope.
4. policy تتحقق من permission + relationship + ownership + entitlement + context.
5. أي غموض = deny.

## 24. معمارية Admin module/pages

منصة واحدة `/admin`:

- Dashboard بحسب capabilities.
- Tenants/Instructors list + shared detail page.
- Users/Students overview.
- Plans/Subscriptions/Payments/Invoices/Refunds.
- Support tickets/account assistance.
- Security events/sessions/account locks.
- Content moderation/catalog.
- Roles/Permissions/Admin users.
- Audit log/analytics/settings/feature flags.

أربع طبقات UI لكل صفحة: navigation، route، action، field/data. مثال صفحة instructor detail مشتركة؛ Ops يرى الحالة والاستخدام، Billing يرى subscription/payment، Support يرى بيانات الاتصال المحدودة، Security يرى sessions/events، وSuper يرى المجموعة الكاملة. DTO backend نفسه يجب أن يطبق field projection بحسب permission.

## 25. Subscription/Entitlement model

يلزم فصل ثلاثة مفاهيم مختلطة حاليًا:

1. **Platform plan:** ما الذي يستطيع Tenant استخدامه (limits/features).
2. **Tenant subscription:** حالة اشتراك المدرّس/المنظمة في SaaS.
3. **Student purchase/enrollment:** وصول الطالب إلى course/premium lecture.

الجداول المقترحة: `plans`, `plan_features`, `tenant_subscriptions`, `subscription_events`, `payments`, `invoices`, `refunds`, ثم `student_enrollments`, `content_entitlements`. قرار الوصول لا يعتمد على role فقط، بل permission + tenant + entitlement + resource state. migration تبدأ بmapping read-only من الجداول الحالية، ثم dual-write مضبوط ومراقب، ثم switch، ولا حذف للجداول القديمة في الإصدار نفسه.

## 26. Audit strategy

Audit append-only للأحداث الحساسة:

- actor user/session، tenant، action، resource type/id.
- decision allow/deny وpolicy/reason.
- before/after redacted للحقول المسموح بها.
- request/correlation ID، IP وuser-agent hash، timestamp.
- impersonation: initiator + effective actor + reason + expiry.
- login/reset/session revoke/role change/suspension/refund/wallet credit-debit/payment approval/content publish/delete/export.

لا تُسجل كلمات مرور أو JWT أو API keys أو محتوى حساس كامل. صلاحية `audit.read` منفصلة، والاحتفاظ/التصدير/التوقيع يحددهما policy موثقة.

## 27. استراتيجية الاختبارات

### قبل Refactor

- Contract tests لأشكال request/response/status على APIs المستخدمة.
- Characterization tests للـbusiness behavior الحالي، بما فيه quirks التي لا نغيرها بصمت.
- DB integration tests على MySQL disposable schema/transaction rollback.
- Browser E2E لأهم رحلات admin/instructor/student.

### لكل endpoint يُرحّل

1. valid existing user succeeds.
2. unauthenticated denied.
3. missing permission denied.
4. other tenant denied، حتى مع ID صحيح.
5. suspended/revoked session denied.
6. entitlement/enrollment enforced عند الحاجة.
7. response contract لم يتغير إلا بإصدار معلن.

### بوابات CI

- frontend/backend type build.
- lint scoped إلى canonical source فقط، ثم خفض baseline تدريجيًا.
- unit + integration + authorization matrix tests.
- migration up/down أو forward-fix test على snapshot مماثل.
- secret scanning وdependency audit وSAST.
- smoke E2E، bundle-size budget، وAPI schema diff.

## 28. استراتيجية ترحيل قاعدة البيانات

استخدام Expand -> Migrate -> Verify -> Switch -> Contract:

1. إيقاف runtime DDL ونقله إلى versioned migrations، بعد حماية endpoints الحالية فورًا.
2. أخذ backup واختبار restore وقياس أحجام الجداول/locks.
3. إضافة جداول IAM/tenant الجديدة و`tenant_id` nullable مع indexes online قدر الإمكان.
4. backfill في batches قابلة للاستئناف مع reconciliation counts وorphan report.
5. التطبيق يقرأ عبر compatibility view/adapter؛ القرار الجديد له source واحد.
6. إضافة constraints بعد وصول null/orphan إلى صفر.
7. switch reads/writes عبر feature flag لكل module.
8. rollback يعيد التطبيق للقراءة القديمة؛ migrations في مرحلة expand تبقى متوافقة.
9. حذف الأعمدة/الجداول القديمة في release منفصل بعد retention window وموافقة صريحة.

ممنوع في المرحلة الأولى: `DROP`, destructive rename, data reset، أو تعديل ENUM غير متوافق. معالجة imports الحالية يجب أن تبدأ بنسخة احتياطية وتسمية/نسخ الجداول، لا DROP مباشر.

## 29. خارطة التنفيذ

| المرحلة | الناتج | شرط الخروج |
|---|---|---|
| 0. Baseline | هذا التقرير + schema/API snapshot + build results | موافقة على الأولويات وعدم وجود assumptions مجهولة |
| 1. Emergency security | secret rotation، signup lock، auth على destructive/admin/migration/socket/video | exploit tests تفشل، valid flows تمر |
| 2. Test harness | Vitest/Supertest أو بديل مناسب + MySQL integration + Playwright smoke | رحلات login/student/exam/payment/video/message مغطاة |
| 3. IAM consolidation | middleware/session/status/error/validation موحد | لا JWT middleware مكرر؛ revoke test يمر |
| 4. Authorization | catalog/policies/audit decisions | default deny + endpoint matrix |
| 5. Tenant foundation | tenant/membership/context + backfill | zero ambiguous ownership أو quarantine موثق |
| 6. Critical modules | billing/wallet/admin/video/migrations | cross-tenant وfinancial tests كاملة |
| 7. Academic modules | students/groups/courses/content/attendance | parity + scoped repositories |
| 8. Assessment | exams/attempts/grading/results | lifecycle/regression/concurrency tests |
| 9. Admin UI | `/admin` capability-driven + field filtering | navigation/route/action/data tests |
| 10. Entitlements | platform + tenant + student access separation | billing reconciliation وrollback |
| 11. Performance/ops | pagination, lazy loading, metrics, job boundary | measured SLO/budgets |
| 12. Contract cleanup | إزالة legacy بعد window | no legacy traffic + backup/rollback approved |

## 30. سجل المخاطر

| ID | الخطر | الاحتمال | الأثر | الأولوية | التخفيف |
|---|---|---:|---:|---:|---|
| R1 | استغلال endpoints غير المحمية | عالٍ | كارثي | P0 | authz containment + tests |
| R2 | تسريب/استهلاك مفتاح AI | مؤكد | عالٍ | P0 | revoke/rotate + server proxy |
| R3 | فقد imports بسبب runtime DROP | عالٍ عند الاستخدام | كارثي | P0 | تعطيل المسار الهدّام + backup migration |
| R4 | Cross-tenant data leak | عالٍ بعد التوسع | كارثي | P0 | tenant context/scoped repository/policy tests |
| R5 | تصعيد role عبر signup | عالٍ | كارثي | P0 | server allow-list + admin provisioning |
| R6 | انتحال Socket user | عالٍ | عالٍ | P0 | handshake JWT + server principal |
| R7 | Regression بسبب غياب الاختبارات | عالٍ | عالٍ | P0 | characterization suite قبل refactor |
| R8 | Schema drift يفشل deploy | عالٍ | عالٍ | P1 | canonical migrations + version check |
| R9 | ربط user/student خاطئ | متوسط | عالٍ | P1 | explicit identity FK/mapping + reconciliation |
| R10 | ازدواج قرار old/new auth | متوسط | كارثي | P1 | authorization service مصدر القرار الوحيد |
| R11 | deadlock/partial finance writes | متوسط | عالٍ | P1 | transactions + idempotency + ledger invariants |
| R12 | web outage بسبب FFmpeg | متوسط | عالٍ | P2 | limits/metrics ثم worker boundary |
| R13 | bundle/queries تتدهور مع النمو | عالٍ | متوسط | P2 | pagination/lazy load/query profiling |
| R14 | نشر نسخة artifact قديمة | متوسط | عالٍ | P1 | canonical build pipeline، منع committed deploy bundles |

## نتائج التحقق الحالية

| الفحص | النتيجة |
|---|---|
| Frontend production build | ناجح؛ warning عن dynamic/static import وchunk كبير |
| Backend TypeScript build | ناجح |
| Automated tests | غير موجودة كـsuite قابلة للتشغيل |
| Lint | فشل: 353 مشكلة (312 errors، 41 warnings)؛ يشمل source ونسخ deployment/backup بسبب ignore ضيق |
| Git state | worktree يحتوي تعديلات وملفات جديدة سابقة لهذا التقرير؛ لم يتم تعديلها أو حذفها |

## قرارات ADR المطلوبة قبل التنفيذ الواسع

1. ADR-001: MySQL هو operational source of truth، ومصير Supabase artifacts.
2. ADR-002: Modular Monolith وعدم الانتقال إلى Microservices حاليًا.
3. ADR-003: Central authorization decision + default deny.
4. ADR-004: Tenant != User؛ memberships model وخطة backfill.
5. ADR-005: Session/token strategy ومكان التخزين في الويب.
6. ADR-006: Expand/contract migration وruntime DDL ban.
7. ADR-007: فصل platform subscription عن student entitlement.
8. ADR-008: canonical deployment pipeline وartifact retention.

## بوابة البدء المقترحة

لا يبدأ Refactor شكلي الآن. أول Implementation slice يجب أن يكون محدودًا وقابلًا للقياس والرجوع:

1. rotate المفتاح المكشوف خارج الكود؛
2. إضافة security characterization tests لأخطر المسارات؛
3. توحيد middleware الأساسي؛
4. قفل التسجيل العام والأحداث/المسارات الهدامة؛
5. تأمين Socket.IO وvideo key؛
6. نقل imports/runtime DDL إلى migration آمنة؛
7. بعدها فقط بدء tenant/permission foundation.

بهذا الترتيب نحافظ على المنتج الحالي، نقلل الخطر المباشر، ونبني أساسًا يسمح بالتطوير Feature-by-Feature بدل Rewrite.

## تحديث التنفيذ — شريحة P0 الأولى

بتاريخ 2026-09-21 نُفذت أول شريحة احتواء بلا تغيير Schema:

- إزالة أسرار AI من Source وtext artifacts، ونقل الاتصال إلى Backend-only.
- إلغاء JWT fallback secrets وتوحيد middleware المستخدم في auth/messages/registration.
- قصر التسجيل العام على student وحماية حذف حساب الطالب والبحث بالهاتف.
- حماية migrations وإدارة Instructors والمحافظ بقواعد admin/self المؤقتة.
- مصادقة Socket.IO واستخراج هوية المرسل من JWT.
- حماية legacy video key/stream بالـJWT وربط secure video token بالجلسة والمستخدم والفيديو.
- إضافة ثمانية اختبارات أمنية؛ Frontend وBackend builds ناجحان.

تفاصيل القرار والنشر والـrollback: `docs/adr/0001-p0-security-containment.md`.
