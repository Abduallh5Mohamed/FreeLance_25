# مراجعة المنتج والواجهة وتجارب المستخدم

> الحالة: اكتملت مرحلة الاكتشاف الساكن وربط الواجهة بالمسارات والـ APIs. لم تُنفّذ تغييرات سلوكية في المنتج ضمن هذه المرحلة، التزامًا بشرط فهم الواجهة كاملة قبل البدء في إعادة التصميم.

## 1. الملخص التنفيذي

المنصة الحالية منتج قائم وغني وظيفيًا، وليست واجهة فارغة. تحتوي على إدارة طلاب وصفوف ومجموعات وحضور ومحتوى ومحاضرات وامتحانات ومدفوعات وتقارير ورسائل، إضافة إلى نظام حديث نسبيًا للمدرسين المستقلين والفيديو والمحفظة. المشكلة الأساسية ليست نقص عدد الشاشات، بل أن المنتج نما على عدة مسارات متوازية من دون نموذج تنقل وصلاحيات وتجارب موحد.

أهم النتائج:

- يوجد 55 مسارًا معلنًا في `App.tsx`، بينها مسار مكرر، وصفحات يتيمة، وصفحات اختبار مكشوفة.
- يوجد نموذجان متداخلان للمستخدم التعليمي: `teacher` و`instructor`، ولكل منهما Dashboard وتدفق فيديو وطلاب مختلف.
- يوجد ثلاثة أنظمة تنقل منفصلة: `Header` و`InstructorHeader` و`StudentHeader`، لكن معظم صفحات المدرس الجديد تستخدم `Header` القديم لا `InstructorHeader`.
- حماية الواجهة تعتمد على اسم الدور وقوائم ثابتة موزعة في أكثر من ملف، وليست على effective permissions/capabilities.
- واجهة الرسائل الرئيسية تحتوي نصوصًا عربية تالفة بالترميز، مع وجود واجهتي Chat متوازيتين (`Messages` و`StudentChat`) وسلوك بحث يعتمد على رقم مدرس ثابت.
- الدعم الحالي مجرد رابط أو إعادة توجيه إلى المحادثة؛ لا يوجد Ticketing أو تصنيف أو حالة أو تتبع أو لوحة دعم للإدارة.
- لا توجد وحدات Assignments أو Announcements أو Onboarding أو Help Center في الواجهة أو الـBackend الحالي.
- لوحة الطالب تسحب بيانات حقيقية في معظمها، لكنها لا ترتب العمل حسب “ماذا أفعل الآن؟” ولا تعرض الواجبات أو الحضور أو الدعم.
- لوحة المدرس القديم تعرض مؤشرات حقيقية جزئيًا، ولوحة instructor الجديدة محدودة بالفيديو والمحفظة والطلبات والطلاب، ولا تدير العملية التعليمية كاملة.
- Admin لا يملك Dashboard حقيقية؛ الصفحة الوحيدة الخاصة به هي إدارة المدرسين.
- نموذج online/offline موجود كـ`is_offline`، لكنه مختلط مع إنشاء الحساب. الكود الحالي ينشئ سجل `users` للطالب الأوفلاين عند وجود بريد، وهو عكس الدلالة المطلوبة ويحتاج Migration/Service آمنة لا تعديل UI فقط.
- المحتوى يدعم grade/group في عدة مواضع، لكن لا توجد Visibility Engine موحدة ولا Audience Selector مشترك ولا تحقق موحد على الـBackend.
- لا توجد اختبارات E2E فعلية للرحلات المطلوبة، والملفات الحالية المسماة QA تعتمد على قاعدة بيانات حية أو بيانات اعتماد محلية ولا تصلح كاختبارات CI آمنة.

## 2. نطاق الفحص وطريقته

تم فحص:

- جميع ملفات `src/pages` و`src/components`.
- جميع Routes في `src/App.tsx`.
- روابط التنقل في الرؤوس الثلاثة.
- `AuthGuard` وخريطة صلاحيات الموظفين وقائمة instructor الثابتة.
- جميع imports من `src/lib/api-http.ts` والطلبات المباشرة عبر `fetch` و`axios`.
- جميع Routers المركبة في `server/src/index.ts` والعمليات المتاحة في `server/src/routes`.
- نموذج البيانات المتعلق بالطلاب والصفوف والمجموعات والتسجيل والمحتوى والحضور والرسائل.
- حالات Loading/Empty/Error الظاهرة، الحوارات، الجداول، البحث والفلاتر والحذف.
- ملفات QA السابقة وصور `.qa` المتاحة. الصور السابقة لم تثبت دخولًا ناجحًا للأدوار؛ بعضها عاد إلى صفحة الدخول، لذلك لم تُعتبر دليل قبول.

لم يتم:

- تعديل قاعدة البيانات أو إنشاء مستخدم QA داخلها.
- تشغيل Scripts قد تنشئ أو تعدل بيانات حية.
- اعتبار نجاح Build دليلًا على صحة رحلة مستخدم.

## 3. جرد المسارات والصفحات

### 3.1 صفحات عامة

| الصفحة | المسار | الحالة الحالية | القرار |
|---|---|---|---|
| `Index` | `/` | Landing طويلة، بها مساعد AI مباشر وترويج ودعم شكلي | الحفاظ، فصل AI العام عن رحلة الطالب، إصلاح روابط الدعم |
| `PromoVideo` | `/promo` | صفحة ترويج منفصلة | الحفاظ إذا كانت مستخدمة تسويقيًا |
| `Auth` | `/auth`, `/login` | دخول وتسجيل وطلب تسجيل داخل ملف 889 سطرًا | تقسيم الرحلات وتوضيح نوع الحساب، دون تغيير العقد الحالي أولًا |
| `NotFound` | `*` | 404 بسيط بلا مسارات تعافٍ مفيدة | إضافة عودة حسب الدور ودعم |
| `TestVideo` | `/test-video` | صفحة اختبار مكشوفة في Router الإنتاج | نقلها إلى dev-only أو حذف المسار بعد التأكد من عدم الاعتماد عليه |

### 3.2 Teacher / Staff / Admin legacy workspace

| الصفحة | المسار | Backend/API | الحالة/الفجوة الأساسية |
|---|---|---|---|
| `TeacherDashboard` | `/teacher` | Students/Courses/Materials | مؤشرات حقيقية أساسية، لكنها ليست operations-focused وتعرض إجراءات Admin لبعض الأدوار |
| `Courses` | `/courses` | CRUD courses/grades/subscriptions | CRUD موجود؛ لا Details page ولا archive ولا pagination |
| `Students` | `/students` | students/grades/groups/courses/subscriptions | تعرض Online فقط؛ الإضافة المباشرة غير مكتملة، والحذف مشتت بين student/user |
| `OfflineStudents` | `/offline-students` | CRUD students | إنشاء أوفلاين موجود؛ نوع الطالب وحساب الدخول غير منفصلين دلاليًا |
| `StudentRegistrationRequests` | `/registration-requests` | registration requests | Approval flow موجود لكنه Admin-only في Backend مع Route معروض كـteacher |
| `Subscriptions` | `/subscriptions` | CRUD subscriptions | أقرب لتعريف خطط/اشتراكات، المصطلح والملكية غير واضحين |
| `Grades` | `/grades` | CRUD grades | CRUD بسيط؛ بلا archive، تفاصيل، bulk assignment أو إحصاءات |
| `Groups` | `/groups` | CRUD groups/students | إضافة/نقل طلاب جزئي؛ يحتاج Details page وbulk/archive/search متماسك |
| `Attendance` | `/attendance` | students/courses/attendance | حضور يدوي قائم لكنه غير ظاهر في Sidebar الحالية |
| `BarcodeAttendance` | `/barcode-attendance` | direct axios attendance/fees | شاشة ضخمة تخلط حضورًا ورسومًا ورسائل WhatsApp |
| `AttendanceLog` | `/attendance-log` | grades/groups/students/attendance | فلترة وسجل موجودان؛ لا pagination أو تصدير موحد |
| `QRAttendance` | — | attendance/groups | الصفحة مستوردة في الكود لكن غير مربوطة بالراوتر |
| `StudentBarcodes` | `/student-barcodes` | students/groups | إدارة وطباعة الباركود موجودة |
| `Fees` | `/fees` | fees/subscription requests | اسم الشاشة “المصروفات” يتعارض مع `Expenses`؛ تجمع التحصيل والموافقات والتنظيف |
| `StudentPayments` | `/student-payments` | direct axios students/fees | سجل وتسجيل دفعات؛ تداخل وظيفي مع `Fees` |
| `Expenses` | `/expenses` | CRUD expenses | CRUD قائم |
| `Imports` | `/imports` | CRUD imports/fees | اسم المجال غير واضح للمستخدم، والـBackend الخاص به عالي الخطورة بسبب DDL runtime موثق سابقًا |
| `AccountStatement` | `/account-statement` | طبقة غير موحدة | عرض محدود بلا بحث/تفاصيل/تصدير موحد |
| `Profits` | `/profits` | fees/expenses/imports | حساب مشتق في الواجهة؛ يحتاج API تقرير موثوق وصلاحية مالية |
| `Reports` | `/reports` | تنفيذ محلي/قديم | صفحة تقارير عامة محدودة |
| `StudentReports` | `/student-reports` | students/attendance/fees/results/notes | تقرير غني لكنه 808 أسطر، ويجب تحويل الطالب إلى Details Page |
| `Staff` | `/staff` | CRUD/login staff | صلاحيات على مستوى أقسام فقط؛ لا Roles & Permissions حقيقية |
| `Messages` | `/messages`, `/student-messages` | messages + socket | نصوص عربية تالفة، واجهة موحدة ظاهريًا لكن Route الطالب يستخدم Header غير مناسب |
| `ChatAssistant` | `/chat-assistant`, `/student-ai-chat` | backend AI proxy | نفس الصفحة للدورين وتبدّل Header داخليًا؛ تحتاج Layout موحد وحدود استخدام |
| `OnlineMeeting` | `/online-meeting` | meetings/grades/groups | CRUD اجتماعات قائم؛ الجمهور grade/group فقط |
| `CourseContentManager` | `/course-content` | materials/courses/grades/groups | Backend حقيقي؛ يتداخل مع `TeacherContentManager` |
| `TeacherContentManager` | `/teacher-content-manager` | تنفيذ مستقل/قديم | وظيفة مكررة مع مدير محتوى الدورة |
| `TeacherLectures` | `/teacher-lectures` | lectures/videos/grades/groups | إنشاء وعرض وحذف؛ لا Audience Engine مشتركة |
| `TeacherMaterials` | — | Supabase مباشرة | غير مربوطة بالراوتر وتعتمد مصدر بيانات مختلفًا |
| `TeacherPremiumLectures` | `/teacher-premium-lectures` | premium lectures/payments | نظام كامل نسبيًا لكنه ضخم ومكرر داخليًا |
| `TeacherExams` | `/teacher-exams` | exams/grades/groups | إنشاء ونشر فعليان؛ نموذج طويل ويحتاج خطوات واضحة |
| `EditExam` | `/teacher/exams/:id/edit` | exams/questions | صفحة 1077 سطرًا؛ تعديل وأسئلة وصور، مع طلبات مباشرة غير موحدة |
| `ExamManager` | — | exams/questions | صفحة بديلة كاملة غير مربوطة؛ تشير تقارير منها إلى `/exam-manager` غير الموجود |
| `EditExam_NEW` | — | direct fetch | نسخة بديلة غير مستخدمة؛ مصدر ارتباك وصيانة |
| `ExamReports` | `/exam-reports/:id` | attempts/not-attempted | يعمل، لكن زر الرجوع يذهب إلى `/exam-manager` غير الموجود |
| `ExamResults` | `/exam-results` | results/students/groups/grades | بحث وفلاتر موجودة |
| `ManualGrading` | `/manual-grading` | manual grading | واجهة قائمة لكنها تستخدم fetch غير موحد وتحتاج صلاحية publish |
| `TeacherChat` | — | واجهة AI/Chat قديمة | غير مستخدمة |

### 3.3 Instructor workspace الحديث

| الصفحة | المسار | الحالة/الفجوة |
|---|---|---|
| `InstructorDashboard` | `/instructor` | بيانات حقيقية للمحفظة والفيديو والطلاب والطلبات؛ لا Courses/Groups/Attendance/Exams/Support |
| `InstructorLectures` | `/instructor-lectures` | فيديوهات ورفع وطلبات مشاركة؛ يستخدم `Header` العام لا `InstructorHeader` |
| `InstructorWallet` | `/instructor-wallet` | رصيد وحركات حقيقية |
| `InstructorVideoRequests` | `/instructor-video-requests` | إرسال/استقبال/مشاركة/رد |
| `InstructorStudents` | `/instructor-students` | قائمة قراءة فقط؛ لا Add/Edit/Profile/Group/Attendance |
| `InstructorHeader` | component فقط | تنقل أنظف لكنه غير مستخدم فعليًا في صفحات instructor الحالية |

القرار المعماري: لا نبني Workspace ثالثًا. يجب دمج قدرات instructor الحديثة داخل Workspace التدريس الموحد، مع capabilities ونطاق tenant/instructor، والإبقاء على Routes القديمة كـredirects مرحلية.

### 3.4 Student workspace

| الصفحة | المسار | الحالة/الفجوة الأساسية |
|---|---|---|
| `StudentDashboard` | `/student` | يسحب دورات/محتوى/امتحانات/نتائج/رسائل؛ لا نموذج أولويات يومية ولا حضور/واجبات/دعم |
| `StudentChat` | `/student-chat` | Realtime وصور وتعديل/حذف وAI؛ يبحث عن مدرس برقم ثابت `01024083057` |
| `StudentContent` | `/student-content` | مواد وبحث ومعاينة/تنزيل |
| `StudentLectures` | `/student-lectures` | محاضرات وبحث وتشغيل؛ مصدر thumbnail خاص بـDrive |
| `StudentPremiumLectures` | `/student-premium-lectures` | شراء/إيصال/تشغيل آمن نسبيًا |
| `StudentExams` | `/student-exams` | عرض وإتاحة وبدء امتحان |
| `TakeExam` | `/take-exam/:id` | رحلة امتحان غنية جدًا وملف 1832 سطرًا؛ autosave وصور وإرسال ونتيجة |
| `StudentExamResults` | `/student-exam-results` | fetch مباشر للنتائج؛ عرض ومراجعة |
| `ExamReview` | `/exam-review/:id` | مراجعة تفصيلية، fetch مباشر |
| `ExamAccess` | `/exam-access` | يعتمد Supabase مباشرة، لا يظهر في Navigation، ومفهومه متداخل مع قائمة الامتحانات |
| `StudentMeetings` | `/student-meetings` | اجتماعات الطالب |
| `StudentMessages` | — | ملف فارغ تمامًا |

لا توجد صفحات Student Profile أو Attendance أو Assignments أو Notifications Center أو Support Tickets أو Settings أو Help.

## 4. عيوب Routing مؤكدة

1. `/student-reports` معلن مرتين، مرة بـ`StudentReports` ومرة بـ`Reports`. أول تطابق يخفي الثاني، لكنه عيب صيانة واختبار.
2. `ExamReports` يرجع إلى `/exam-manager`، والمسار غير موجود.
3. `QRAttendance` و`ExamManager` و`TeacherMaterials` موجودة دون Route.
4. `EditExam_NEW` و`TeacherChat` نسخ بديلة غير مستخدمة.
5. `StudentMessages` فارغة وغير مستوردة، بينما `/student-messages` يعرض `Messages` العام.
6. `/test-video` مكشوف للجميع في Router الإنتاج.
7. Admin بعد الدخول لا يملك `/admin` أو Dashboard مستقلة؛ نجاح الدخول يعتمد على redirects موزعة داخل `Auth`.
8. أسماء المسارات لا تعكس hierarchy واحدة، ما يصعب breadcrumbs والتحليلات والتفويض.

## 5. جرد الـ Features

| Feature | Frontend | Backend/API | صلاحيات | الحالة | الأولوية/الإجراء |
|---|---|---|---|---|---|
| Authentication | موجود | موجود | role-based | يعمل مع تعقيد legacy | P0: Session context موحد وredirect حسب capability |
| Students online | عرض/تعديل/حذف | CRUD | غير موحد | ناقص إنشاء واضح | P1 |
| Students offline | CRUD | CRUD | غير موحد | موجود لكن model ملتبس | P1 + migration |
| Student profile | غير موجود | البيانات موزعة | — | مفقود | P1 Details route |
| Grades/classes | CRUD | CRUD | غير موحد | أساسي فقط | P1 archive/assign/details |
| Groups | CRUD جزئي | CRUD | غير موحد | ناقص bulk/details | P1 |
| Courses | CRUD | CRUD | غير موحد | موجود | P2 details/archive/audience |
| Documents/materials | واجهتان متداخلتان | موجود | غير موحد | يعمل جزئيًا | P2 توحيد |
| Videos/lectures | عدة واجهات | موجود | جزئي | غني لكن مجزأ | P1/P2 توحيد audience/security |
| Attendance | 3 واجهات | موجود | غير موحد | يعمل، navigation مربك | P1 |
| Exams | غني | غني | غير موحد | يعمل مع تكرار وملفات ضخمة | P2 |
| Assignments | غير موجود | غير موجود | — | مفقود | P3 بعد تثبيت الأساس |
| Results/manual grading | موجود | موجود | غير موحد | يعمل جزئيًا | P2 publish/status |
| Meetings | موجود | موجود | غير موحد | يعمل | P2 |
| Chat | واجهتان | موجود + Socket.IO | token مضاف، المشاركون غير model كامل | UX غير مقبول | P1 |
| Notifications | Bell فقط | موجود | ضعيف | لا Center ولا deep links موثوقة | P2 |
| Announcements | غير موجود | غير موجود | — | مفقود | P3 |
| Support | رابط شكلي | غير موجود | — | مفقود | P1 |
| Billing/fees | عدة واجهات | موجود | غير موحد | تداخل مصطلحات وعمليات | P2 |
| Instructor wallet/video sharing | موجود | موجود | محسن في P0 | يعمل كنظام منفصل | P2 دمج workspace |
| Admin instructor management | موجود | موجود | Admin | يعمل | P1 ضمن Admin shell |
| Admin dashboard | غير موجود | APIs موزعة | — | مفقود | P1 |
| Roles & permissions | Staff sections فقط | لا RBAC كامل | hardcoded | مفقود | P0/P1 foundation |
| Onboarding/tour | غير موجود | غير مطلوب أولًا | — | مفقود | P2 |
| Help center/guides | غير موجود | غير موجود | — | مفقود | P2 |
| Search | محلي في بعض الصفحات | APIs بلا معيار موحد | — | غير متسق | P2 query contract |
| Pagination | شبه غائب | معظم APIs تعيد قوائم كاملة | — | مفقود | P1 للأحجام الكبيرة |
| Bulk operations | محدود جدًا | غير موحد | — | مفقود | P2 |
| Audit/activity | غير موجود UI | لا audit service موحد | — | مفقود | P2/P3 |

## 6. رحلات المستخدم الحالية

### 6.1 الطالب

بعد الدخول يصل إلى Dashboard تحوي أقسامًا وروابط، لكنه لا يرى قائمة عمل موحدة. عليه معرفة الفرق بين المحتوى والمحاضرات والحصص المدفوعة، ولا يملك مكانًا واحدًا للواجبات والحضور والإشعارات والدعم. زر “الدعم” في الموبايل يفتح Chat، ولا يوضح هل الطرف مدرس أم إدارة.

الهدف:

1. “أكمل التعلم” أولًا.
2. “مطلوب منك الآن” للامتحانات والواجبات.
3. “قريبًا” للاجتماعات والمواعيد.
4. “آخر النتائج والتنبيهات”.
5. اختصار دعم واضح.

### 6.2 المدرس/Instructor

المستخدم قد يدخل `/teacher` أو `/instructor` حسب نوع السجل، ثم يرى قدرات مختلفة جذريًا. instructor الحديث يستطيع إدارة فيديو ومحفظة وطلبات مشاركة، لكنه لا يستطيع من Workspace نفسه إدارة المجموعة والحضور والامتحان. للوصول إلى هذه الوظائف يعتمد على allowlist تسمح له بدخول صفحات teacher القديمة.

الهدف: Teaching Workspace واحد، والتنقل فيه يُشتق من capabilities مثل:

- `student.read`, `student.create`, `student.update`
- `class.manage`, `group.manage`
- `course.manage`, `content.manage`, `video.manage`
- `attendance.manage`
- `exam.manage`, `grading.manage`
- `message.use`, `announcement.manage`
- `subscription.view`, `wallet.view`

### 6.3 Admin

لا توجد Home للإدارة. الرابط الوحيد الخاص صراحةً بالإدارة هو `/admin/instructors`، بينما بقية العمليات تستخدم صفحات teacher العامة. لا يوجد عرض Platform health أو support أو billing أو security أو roles/audit.

الهدف: Admin shell واحد يبدأ بعمليات اليوم، وتظهر وحداته حسب الصلاحيات لا حسب اسم role.

## 7. التنقل والصلاحيات

الوضع الحالي:

- `Header.tsx` يحتوي `PERMISSION_MAP` وقائمة instructor allowlist.
- `AuthGuard.tsx` يحتوي نسخة أخرى من mapping وallowlist.
- `StudentHeader` قائمة مستقلة.
- `InstructorHeader` قائمة مستقلة لكنها غير مستخدمة في صفحات instructor المكتشفة.
- Admin يُمنح كل شيء في Frontend، وteacher كذلك في `Header`.

المشكلة: إخفاء الرابط والتحقق من Route غير صادرين عن مصدر واحد، ولا يوجد `can(permission, scope)` مركزي.

التصميم المستهدف:

```text
SessionProvider
  -> effectivePermissions[]
  -> can(permission, scope?)
  -> route policy
  -> navigation registry
  -> action guards
```

يجب أن يكون Navigation Registry هو المصدر الوحيد لاسم العنصر ومساره وأيقونته وصلاحيته وترتيبه، ويجب أن يظل الـBackend جهة الإنفاذ النهائية.

## 8. Chat

### عيوب مؤكدة

- `Messages.tsx` وحده يحتوي نصوص Mojibake ظاهرة للمستخدم.
- `StudentChat.tsx` يبحث عن المدرس برقم هاتف ثابت؛ هذا يربط المنتج بشخص واحد ويكسر multi-tenant.
- يوجد `Messages` و`StudentChat` و`TeacherChat`، إضافة إلى `ChatAssistant`، بلا taxonomy واضحة.
- `/student-messages` يعرض Component المدرس العام، بينما Sidebar الطالب يفتح `/student-chat`.
- لا يوجد فصل واضح بين Support conversation وAcademic chat وAnnouncement.
- واجهة المدرس لا تقدم Compose flow واضحًا مبنيًا على الطلاب المسموحين فقط.
- حالات reconnect/offline/retry والإرسال الفاشل ليست موحدة.

### القرار

الاحتفاظ بـSocket.IO وMessage APIs القائمة، وبناء Shell واحد للمحادثات مع policies للمشاركين. يفصل AI Assistant عن محادثات الأشخاص، ويعامل Support كنوع محادثة أو Ticket حسب الحاجة، لا كرقم هاتف ثابت.

## 9. Support وContact Administration

لا يوجد Support Domain حقيقي حاليًا. إضافة صفحة شكلية فوق Messages لن تحقق المطلوب.

الحد الأدنى المقترح:

- `support_tickets`: tenant/user/category/subject/status/priority/assigned_to/timestamps.
- `support_messages`: ticket/sender/body/attachment/timestamps.
- حالات: `open`, `waiting_on_support`, `waiting_on_user`, `resolved`, `closed`.
- صفحة المستخدم: إنشاء، رقم تذكرة، متابعة ورد وإغلاق.
- صفحة Admin/Support: Queue وفلاتر وتعيين ورد وتصعيد.
- Entry points: Sidebar، Profile، أخطاء الحساب/الدفع، وHelp Center.

## 10. Online / Offline student model

الحالي هو `students.is_offline BOOLEAN`. وهو concept قابل للتطوير بدل إنشاء concept مكرر، لكن يجب فصل المحاور التالية:

| المحور | القيم المقترحة |
|---|---|
| Student type | `ONLINE`, `OFFLINE` |
| Account status | `NONE`, `INVITED`, `ACTIVE`, `SUSPENDED` |
| Enrollment status | `PENDING`, `ACTIVE`, `COMPLETED`, `CANCELLED` |
| Content grant | course/grade/group/student/resource-specific |

لا ينبغي قلب `is_offline` مباشرة قبل Migration آمنة. المرحلة الأولى تضيف service/API view تطبع المعنى الحالي وتمنع إنشاء User تلقائيًا للطالب الأوفلاين إلا بفعل صريح “منح دخول محدود”.

## 11. Content visibility

التطبيق الحالي يمرر `grade_id` و`group_ids` في المحاضرات والمواد والامتحانات بنماذج مختلفة. لا يوجد Resource Audience موحد.

المستهدف:

```text
resource_audiences
  resource_type
  resource_id
  audience_type: tenant | grade | group | course | student
  audience_id
  access_mode
```

مع endpoint مركزي للتحقق، وفهرسة مناسبة، وواجهة `AudienceSelector` مشتركة. لا يتم تنفيذ Migration قبل جرد البيانات الحالية وكتابة backfill وrollback.

## 12. Design system وحالات الصفحات

المشروع يملك أساسًا جيدًا من shadcn/Radix، لكنه لا يستخدم Patterns موحدة فوقها. المطلوب إنشاء طبقة Product UI صغيرة لا Design System جديدًا من الصفر:

- `AppShell`, `RoleAwareNav`, `PageHeader`, `Breadcrumbs`.
- `DataTable` مع search/filter/sort/pagination/actions/bulk.
- `PageState` لحالات loading/empty/error/forbidden/offline.
- `ConfirmActionDialog` للحذف والتعطيل والإلغاء والنشر.
- `FormActions` وحالة dirty/saving/success.
- `StatusBadge` بمفردات وألوان موحدة.
- `DetailsLayout` للطالب والمدرس والدورة والامتحان والمجموعة والتذكرة.

الموجود حاليًا يستخدم spinners ونصوص Empty متفاوتة، وقليل من Skeletons، ولا يوجد Unauthorized page مستقلة. بعض الحذف يستخدم حوارًا وبعضه ينفذ مباشرة.

## 13. RTL واللغة وAccessibility

- الواجهة عربية عمومًا و`dir=rtl` مدعوم في مواضع متعددة، لكن اتجاه الأيقونات والعودة والـpagination غير موحد.
- `Messages.tsx` يحتاج إصلاح ترميز كامل قبل أي تجميل.
- المصطلحات متعارضة: Fees/Expenses كلاهما يظهر “مصروفات”، وCourses/دورات/كورسات مختلطة.
- يلزم Glossary منتج: طالب، صف، مجموعة، دورة، محاضرة، مادة تعليمية، اختبار، حضور، دفعة، اشتراك، دعم.
- كثير من الأزرار icon-only تحتاج `aria-label`، والـDialogs تحتاج تركيزًا وعناوين موثوقة.
- ملفات النماذج الكبيرة تحتاج ربط labels ورسائل validation بالحقل وتركيز أول خطأ.

## 14. الأداء

- Bundle الإنتاج الحالي يقارب 2.46MB (نحو 706KB gzip) مع تحذير chunk كبير.
- جميع الصفحات مستوردة eagerly في `App.tsx`؛ لا يوجد route-level lazy loading.
- كثير من APIs تعيد قوائم كاملة ثم تتم الفلترة في المتصفح.
- Dashboard الطالب والمدرس تنفذ عدة طلبات مستقلة؛ بعضها يمكن تجميعه في endpoint Dashboard.
- React Query موجود في Root لكنه غير مستخدم كطبقة data موحدة؛ معظم الصفحات تدير fetch/cache بنفسها.

الإجراء: lazy routes، query keys موحدة، pagination server-side، منع duplicate requests، وDashboard endpoints مركبة حسب الصلاحية.

## 15. Back-end gaps التي تمنع اكتمال UX

1. RBAC/effective permissions موحدة مع tenant/scope.
2. Support ticket domain.
3. Assignments domain.
4. Announcements domain.
5. Audience/visibility engine.
6. Student account lifecycle منفصل عن student type.
7. Dashboard aggregate endpoints.
8. Search/pagination contract موحد.
9. Audit/activity events.
10. Notification deep-link/event taxonomy.

كما أن عدة Routers الحالية ما زالت غير محمية بالكامل وفق تقرير الأمن السابق؛ لذلك لا يجوز إظهار عمليات جديدة في UI قبل إنفاذها على الـBackend.

## 16. ترتيب التنفيذ المعتمد

### P0 — Product foundation

1. إزالة عيوب Router المؤكدة دون حذف الصفحات.
2. Session/capability model مركزي وNavigation Registry واحد.
3. App shells للأدوار مع redirects توافقية.
4. Page states وconfirmation patterns مشتركة.
5. اختبارات Router/permission/navigation.

### P1 — الرحلات الحرجة

1. Chat موحد وإزالة الرقم الثابت وإصلاح العربية.
2. Support tickets end-to-end.
3. Student Dashboard حسب الأولويات.
4. Instructor Dashboard وWorkspace موحد.
5. Admin Dashboard أساسية.
6. Student Management + Details + online/offline lifecycle.
7. Grades/Groups/Attendance وتدفقات bulk الأساسية.

### P2 — التعليم والاكتشاف

1. Content audience engine وواجهة التعيين.
2. Courses/Documents/Videos consolidation.
3. Exams/results/manual grading consolidation.
4. Notifications Center.
5. Onboarding checklist/tour/help center.
6. Settings/Profile حسب الدور.
7. Pagination/performance/accessibility/RTL sweep.

### P3 — وحدات ناقصة

1. Assignments.
2. Announcements.
3. Activity timeline/audit UI.
4. تقارير تشغيلية متقدمة.

## 17. خطة الاختبار والقبول

يجب إنشاء Harness لا يكتب في قاعدة الإنتاج، مع seed محلي/اختباري قابل للإعادة.

### Contract/integration

- كل Action ظاهر يطابق endpoint موجودًا ومحمياً.
- كل endpoint يعيد 401 بلا token، و403 بلا permission، و404 خارج scope لمنع التسريب.
- tenant/instructor scope في القوائم والتفاصيل والكتابة.

### E2E مدرس

- دخول → إنشاء صف → مجموعة → Online student → Offline student.
- منح Offline student فيديو محدد دون تغيير نوعه.
- إنشاء دورة/رفع فيديو/تحديد الجمهور.
- تسجيل حضور online/offline.
- إنشاء اختبار/نشره/إجابة طالب/تصحيح ونتيجة.

### E2E دعم

- إنشاء تذكرة → ظهورها للإدارة → رد → إشعار المستخدم → إغلاق.

### E2E Chat

- إنشاء محادثة مسموحة، إرسال/استقبال، unread/read، عربية وصورة، reconnect، وفشل participant غير مسموح.

### E2E Onboarding

- أول دخول فقط، next/back/skip/finish، عدم التكرار، وإعادة التشغيل من المساعدة.

### Quality gates

- Desktop 1440، Tablet 768، Mobile 390.
- Keyboard-only وfocus visible.
- لا console errors ولا dead links.
- لا fake dashboard numbers.
- Build frontend/backend واختبارات الأمن الحالية تظل ناجحة.

## 18. مخاطر التنفيذ والـRollback

- لا نحذف الصفحات المكررة أولًا؛ نضع redirects/feature flags ثم نراقب الاستخدام.
- لا نغير `is_offline` مباشرة؛ migration additive ثم backfill ثم read switch ثم write switch.
- لا نوحد Chat بقطع socket events القديمة؛ adapter توافق مرحلي.
- لا ننقل كل data fetching إلى React Query في دفعة واحدة؛ Module-by-module.
- لا ننشر Navigation جديدة قبل اكتمال backend authorization للعمليات التي ستكشفها.
- كل مرحلة لها Route flag وrollback إلى shell السابق، من دون rollback للأسرار التي تم تدويرها.

## 19. أول Slice تنفيذي بعد اعتماد الجرد

أول Slice يجب أن يكون صغيرًا وقابلًا للاختبار:

1. تعريف capability types و`can()` من بيانات الجلسة الحالية مع fallback توافقية للأدوار القديمة.
2. Navigation Registry واحدة تغذي Teacher/Instructor/Admin shells.
3. إصلاح المسار المكرر والعودة المكسورة وصفحة الاختبار المكشوفة.
4. `Forbidden` و`RouteLoading` واضحتان بدل شاشة فارغة في `AuthGuard`.
5. اختبارات unit/router لهذه الحالات.

بعده مباشرة يبدأ Chat ثم Support، لأنهما أكثر فجوتين تؤثران على المستخدم يوميًا وتمنعان المنتج من الشعور كمنصة متكاملة.

## 20. سجل التنفيذ — 2026-09-21

تم تنفيذ أول Slice بعد اكتمال الجرد:

- إضافة `src/auth/access-control.ts` كمصدر مركزي مؤقت للـcapabilities، مع دعم مباشر لـ`effective_permissions` وتوافق محكوم مع الأدوار و`accessible_pages` القديمة.
- ربط `AuthGuard` و`Header` بالمصدر نفسه وإضافة صفحة Forbidden مفهومة.
- إلغاء تعريف `/student-reports` المكرر، وإضافة redirect من `/exam-manager` القديم، وحصر `/test-video` في وضع التطوير.
- إضافة اختبارات access-control تغطي الطالب والموظف والصلاحيات الصريحة والمسارات الديناميكية ومجموعة الصلاحيات الفارغة.
- إزالة رقم المدرس الثابت من Student Chat واستخدام جهات الاتصال المسموحة من الـBackend.
- قصر بدء محادثة instructor على طلابه المرتبطين، وإظهار المدرس المرتبط للطالب مع دعم teacher القديم مؤقتًا.
- إصلاح النصوص العربية التالفة في `Messages.tsx` وتحسين رسائل الخطأ والحالات الفارغة.
- تنفيذ Support Tickets end-to-end: إنشاء، رقم تذكرة، تصنيف، قائمة، تفاصيل، ردود، حالات، Queue للإدارة، وصفحة واحدة تتكيف مع الدور.
- إضافة Migration additive في `server/migrations/20260921_support_tickets.sql`. لم تُطبق تلقائيًا على أي قاعدة بيانات.

التحقق المنفذ بعد التغييرات:

- Frontend production build: ناجح.
- Backend TypeScript build: ناجح.
- Backend security tests: 8/8 ناجحة.
- Frontend access-control tests: 6/6 ناجحة.
- Scoped ESLint للملفات التأسيسية وصفحة الدعم: بلا أخطاء (تمت معالجة تحذير hook لاحقًا).

قبل تشغيل صفحة الدعم في أي بيئة يجب تطبيق Migration المذكورة بعد Backup. بقية عناصر P1/P2/P3 ما زالت ضمن الخطة وليست معلنة كمكتملة.

## 21. فصل دور الأدمن عن التدريس — 2026-09-21

قرار المنتج: الأدمن يدير المدرسين والمنصة، ولا يملك فصلًا أو طلابًا أو محاضرات تخص حسابه. لذلك أُضيف `/admin` كصفحة الدخول ولوحة الأعمال للأدمن، وعُزلت قائمة تنقله إلى نظرة عامة، المدرسين، والدعم. تعرض اللوحة العدد الفعلي للمدرسين النشطين والموقوفين، مجموع الطلاب المرتبطين بالمدرسين، مجموع محاضراتهم، وجدولًا لكل مدرس بعدد طلابه ومحاضراته وحالته. مصدر الأرقام هو `GET /api/instructors` الحالي؛ لا تعرض الواجهة صفرًا إذا فشل الطلب.

أزيلت صلاحيات التدريس الافتراضية عن role `admin` في طبقة العرض، وتحوّل الروابط القديمة `/teacher` و`/instructor` إلى `/admin` لهذا الدور. صفحة `/admin/instructors/:id` تعطي الأدمن عرضًا للمتابعة فقط لقائمة طلاب المدرس ومحاضراته، دون أدوات تعديل تعليمي. قلّصنا حقول الطلاب التي يعيدها endpoint الخاص بالمدرس إلى بيانات العرض المطلوبة بدل `s.*`. بقي `teacher` القديم دون تغيير وظيفي مؤقتًا، إلى أن يُحسم ترحيل بياناته إلى نموذج instructor. الفصل في الواجهة ليس إنفاذًا أمنيًا للـBackend؛ منع الأدمن من استدعاء APIs التدريس مباشرة يحتاج استكمال الـRBAC/tenant policy على كل endpoint كما هو مخطط في P0/P1.
