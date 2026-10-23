# عقد M2-B01 — هوية مساحة المؤسسة المختارة (قراءة فقط)

**المهمة:** `client-m2-b01-tenant-profile-20261019-01` — فريق `backend`،
المسارات الثلاثة المصرح بها فقط. **الأساس:** [096](../client/coordination/supervisor/096-human-approved-m2-b01-backend-profile-start.md)
بتصحيحات 094/095 والاعتماد البشري المباشر في جلسة العمل.
**التصحيح الحالي:** `client-m2-b01-profile-cache-correction-20261019-01` بموجب
[099](../client/coordination/supervisor/099-m2-b01-independent-review-cache-contract-correction.md)
وبتفويض بشري مباشر، ضمن نفس المسارات الثلاثة.
**UTC:** 2026-10-19T04:34Z (تحديث التصحيح 04:56Z) — **الفرع:** `codex/human-client`.

هذا المستند عقد تنفيذ وحدود تغطية. **ليس قبولًا**؛ القبول مراجعة Codex المستقلة.

## نقطة النهاية

```
GET /api/tenants/me/profile
```

مثبتة في `server/src/routes/tenant-self.ts` داخل `createTenantSelfRouter`، والراوتر
مركّب أصلًا على `/api/tenants/me` في `server/src/index.ts:150`. **لا** mount جديد ولا
تعديل على `index.ts` أو على ترتيب الحراس.

### الاستجابة 200

```json
{ "tenant": { "id": "...", "business_name": "...", "subject_type": "company|null", "status": "active" } }
```

- الحقول الأربعة صريحة؛ لا نشر row كاملة ولا حقول `legacy_compat`/`owner_user_id`/
  هاتف/بريد/فوترة/رموز/روابط.
- `subject_type` عمود موجود أصلًا (`VARCHAR(80) NULL`، migration
  `20260927_course_tenant_ownership_and_instructor_subject.sql:4`) ويُعاد `null` كما هو.
- ترويسة `Cache-Control: no-store` على **كل** نتيجة يُصدرها الـhandler نفسه:
  200، و404 الخاص به، وكلا مساري 500. تُضبط قبل أول `await` وقبل أي رفض، لا على
  مسار النجاح فقط (تصحيح 099). الردود upstream 401/403/409/400 لا تتغير ولا
  تحمل هذه الترويسة، وهذا مقصود: سياسة `auth`/الحراس خارج نطاق التصحيح.

### الحالة والسلوك

| الحالة | النتيجة | المصدر |
|---|---|---|
| owner/عضو `owner`/`instructor` نشط في مساحة مختارة | 200 + DTO | handler |
| JWT بدور غير مدعوم (`owner`) | 401 `Invalid token` | `auth.ts:60-66` (validateClaims) |
| توكن غير صالح/مفقود | 401 `Invalid token` / `No token provided` | `auth.ts` |
| توكن منتهٍ | 401 `TOKEN_EXPIRED` | `auth.ts` |
| `token_version` مختلف أو مستخدم غير نشط | 401 `SESSION_REVOKED` | `identity-scope.ts` |
| حساب instructor موقوف/غائب إداريًا | 403 `TENANT_SUSPENDED` | `auth.ts:135-139` |
| instructor بحالة billing-only | 200 بالـDTO المحدود | مسار `/api/tenants/me` مسموح أصلًا في `auth.ts:68-75` |
| admin (بلا نطاق tenant) | 404 | handler |
| طالب بلا مساحة مختارة | 409 `STUDENT_SPACE_REQUIRED` | `student-workspace-boundary.ts:15-18` |
| طالب بمساحة لكن بلا سلطة خادمية | 404 | handler |
| اختيار tenant مزوّر/غير مطابق للعضوية | 404 بلا fallback | `identity-scope.ts:100-108` |
| عضوية واحدة/متعددة بلا اختيار (غموض) | 404 | `identity-scope.ts` |
| selector في header/query/body (متداخل أيضًا) | 400 قبل الـhandler | `tenant-authority-boundary.ts` |
| فشل قراءة البيانات أو السلطة | 500 `Failed to load tenant profile` فقط | handler |

ترتيب الحالات أعلاه مقروء من المصدر الفعلي، لا من مصفوفة مستندية. لا تعديل على
`auth`/الحراس لإجبار نتيجة. كل صف مصدره `handler` يحمل `Cache-Control: no-store`
(200، 404 الخاص به، و500)؛ صفوف `auth`/الحراس لا تحمله ولا تُعدّل.

## التنفيذ

- `getOwnedTenant` تحتفظ بـ`authenticate` + `loadActiveTenantAuthority` نفسيهما؛ أُضيف
  معامل اختيار إسقاط `{ includeSubjectType?: boolean }`. الإسقاط الافتراضي (الفوترة/
  التجديد) **بقي نصًّا متطابقًا حرفيًا**، والإسقاط الجديد هو الأربعة حقول فقط:
  `SELECT t.id,t.business_name,t.subject_type,t.status FROM tenants t WHERE t.id=? LIMIT 1`.
  استعلام واحد لكل طلب؛ لا استعلام ثانٍ.
- سبب عدم تعديل الإسقاط الافتراضي عالميًا: `server/tests/m1-expanded-tenant-admin.test.ts:231`
  يطابق نص استعلام `getOwnedTenant` بـ`includes` حرفي، والملف **خارج**
  `allowedPaths` لهذه المهمة؛ تعديله كان سيُسقط اختبارين معتمدين. أُبقي النص كما هو
  وأُثبت ذلك باختبار انحدار صريح. إن أراد المشرف إسقاطًا قانونيًا واحدًا، يلزم توسيع
  نطاق المهمة ليشمل ملف الاختبار المذكور.
- لا كتابة، لا تغيير schema/migration، لا خدمة/DB/شبكة، لا تثبيت حزم، لا Git.
- **تصحيح 099 (نفس المسارات الثلاثة):** كان `res.set('Cache-Control','no-store')`
  يُنفَّذ بعد حلّ الـtenant، فتخرج 404 و500 بلا ترويسة. الآن يُنفَّذ قبل `try`
  وأول `await`، فتشمل الترويسة كل نتائج الـhandler. نقل سطر واحد، بلا أي تغيير في
  السلوك أو الترتيب أو DTO أو استعلام SQL.

## الأدلة (منفذة فعليًا)

- `server/tests/m2-tenant-profile.test.ts` — **20 اختبارًا تمر جميعها** (19 السابقة
  محفوظة + اختبار عقد الترويسة الجديد). تقود الوحدات الإنتاجية الحقيقية:
  `createOptionalAuth` ثم `enforceTenantAuthorityBoundary` ثم
  `enforceStudentWorkspaceBoundary` ثم `createTenantSelfRouter`، مع repository/بيانات
  محقونة فقط. لا listener ولا `fetch` ولا بدء تطبيق.
- عقد الترويسة (تصحيح 099): اختبار صريح يغطي 200، و404 الخاص بالـhandler (حالتان:
  بلا اختيار / بلا سلطة)، و500 لفشل البيانات، و500 لفشل السلطة — ويتحقق من
  `Cache-Control: no-store` في كل منها.
- حساسية الاختبارات مُثبتة بتحكّم سلبي آمن: إعادة السلوك السابق مؤقتًا (ضبط الترويسة
  بعد النجاح فقط) تُسقط **7** تأكيدات — الاختبارات 5/8/12/14/17/18/19 — بينما يبقى
  مسار 200 ناجحًا؛ ثم أُعيد الملف إلى حالته المصلحة (بصمة SHA-256 مطابقة). هذا تحكّم
  على مستوى المصدر فقط، بلا أي خدمة أو شبكة أو DB.
- عزل الاستيراد إثبات إيجابي: `src/db` و`src/services/minio` و
  `src/services/subscription-renewal` تُعترض في محمّل CommonJS قبل أي استيراد للتطبيق،
  ويُسجَّل كل اعتراض بمساره المحلول. مع الاعتراض: `MINIO_*` تبقى `undefined`، والوحدات
  الحقيقية لا تدخل `require.cache`، ونداءات sentinel = 0، والـhook يُستعاد في `finally`
  (وإن فشل التحميل). يُعاد تأكيد عدّاد sentinel في خطاف `after` بعد المجموعة كاملة،
  حتى لا يفلت نداء التُقط استثناؤه داخل اختبار لاحق. **لم يُعَد** تشغيل التحقق المضاد
  غير المعزول (تحميل الوحدات الحقيقية) لأنه يقيّم bootstrap الخاص بـDB/env/MinIO،
  وهو ممنوع في هذا النطاق بحسب 099.
- `tsc --noEmit -p server/tsconfig.json`: **0 تشخيصات، exit 0** قبل التغيير وبعده
  (قياسان منفصلان على نفس الملف). لا ادعاء بشأن أخطاء حزم أخرى.
- **لم تُشغَّل** أي مجموعة قديمة أوسع في هذا التشغيل: `m1-expanded-tenant-admin`
  و`m1-auth-regressions` و`auth-boundary` و`m1-sprint-notification-support` و
  `tests/integration/*` تحتوي آثار env/service/listener، و099 يمنع إعادة إنتاجها
  كدليل. لذلك **لا يُدّعى** أي رقم 120/120 أو ما يشبهه؛ الدليل هو مجموعة الملف الواحد
  أعلاه + الأنواع + التحكّم السلبي.

## حدود التغطية (صريحة)

- لا MySQL حقيقي، لا HTTP حقيقي، لا مزوّد، لا Docker: التصفية على مستوى الصف تبقى
  مسؤولية مجموعة التكامل (`tests/integration/*`، **لم تُشغّل**).
- `loadActiveTenantAuthority` مُحقونة ببيانات مطابقة لعقد SQL الإنتاجي، مع إثبات
  وسائط الاستدعاء `(userId, tenantId)` ونص/ربط استعلامات SQL؛ ليست نسخة من منطق
  الإنتاج ولا "always allow".
- لا ادعاء أداء أو سلوك end-to-end، ولا قبول ذاتي.

## خارج النطاق

ربط العميل بالـprofile، تحديث الهوية، branches/branding/host، الكتالوج العام، OTP
(مؤجل 060)، وأي مسار M2 آخر. M2-B01 أساس C1 فقط ولا يغلق C1 أو M2.
