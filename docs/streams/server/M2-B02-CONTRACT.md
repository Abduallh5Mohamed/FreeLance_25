# عقد M2-B02 — تحديث اسم المؤسسة بتدقيق ذرّي

**المهمة:** `client-m2-b02-institution-name-20261019-01` — فريق `backend`،
المسارات الثلاثة المصرح بها فقط. **الأساس:** الموجّه البشري المباشر لبدء M2-B02
بعد عرض [M2-B02-PROPOSAL](../client/M2-B02-PROPOSAL.md)، والتفويض
[124](../client/coordination/supervisor/124-human-starts-m2-b02-name-update.md).
**UTC:** 2026-10-19T14:06Z — **الفرع:** `codex/human-client`.

هذا المستند عقد تنفيذ وحدود تغطية. **ليس قبولًا**؛ القبول مراجعة Codex المستقلة.

## نقطة النهاية

```
PATCH /api/tenants/me/profile
```

مثبتة في `server/src/routes/tenant-self.ts` داخل `createTenantSelfRouter`، والراوتر
مركّب أصلًا على `/api/tenants/me`. **لا** mount جديد ولا تعديل على `index.ts` أو
ترتيب الحراس. القراءة المقبولة `GET /api/tenants/me/profile` (M2-B01) تبقى كما هي.

## الطلب

جسم صارم من حقل واحد فقط:

```json
{ "business_name": "..." }
```

- `business_name` يجب أن يكون `string`، وبعد `trim` طوله `1..255`. وإلا **400**.
- يُرفض أي مفتاح إضافي (بما فيه `status`/`subject_type`/`owner_user_id`/...) وأي جسم
  مصفوفة/غير كائن/`null` بـ**400** قبل أخذ اتصال.
- لا يقبل selectors من العميل؛ `tenant_id/tenantId/tenant` في الجسم/الاستعلام/الترويسة
  تُرفض بـ**400** في `tenant-authority-boundary` قبل الـhandler.
- الاسم المخزَّن هو القيمة بعد `trim`.

## الاستجابة

### 200 (بعد `commit` فقط)

نفس DTO المعتمد المحدود، دون أي حقول فوترة/هوية/رموز/روابط:

```json
{ "tenant": { "id": "...", "business_name": "...", "subject_type": "company|null", "status": "active" } }
```

### الحالة والسلوك (الترتيب مقروء من المصدر الفعلي)

| الحالة | النتيجة | المصدر |
|---|---|---|
| datasource.owner_user_id == caller، والمساحة والمستخدم نشطان، واسم جديد | 200 + DTO، تحديث+تدقيق في معاملة واحدة | handler |
| نفس الاسم الحالي (إعادة محاولة مطابقة) | 200 + DTO الحالي، **بلا** `UPDATE` و**بلا** حدث تدقيق (no-op صادق) | handler |
| الاسم الزائد/الناقص/غير نصي/فارغ/أطول من255/حقول زائدة/جسم غير كائن | 400 `Invalid profile update payload` | handler |
| خيار tenant من العميل | 400 (حدود) | `tenant-authority-boundary.ts` |
| عضوية instructor فقط، أو وسم دور `owner` دون مطابقة `owner_user_id`، أو مساحة غير `active`، أو مستخدم غير نشط | 404 `Tenant membership not found` بلا كتابة/تدقيق | handler |
| اختيار مستأجر مزوّر/متعدد بلا اختيار/عضوية ملغاة | 404 قبل أخذ اتصال | `identity-scope.ts` |
| JWT بدور غير مدعوم/توكين غير صالح/مفقود/منتهٍ/ملغى | 401 كما هو | `auth.ts`/`identity-scope.ts` |
| حساب instructor موقوف إداريًا | 403 `TENANT_SUSPENDED` | `auth.ts` |
| صف `UPDATE` صفري (تزامن) | 409 `Tenant profile was modified concurrently` بلا تدقيق | handler |
| تعذّر الحصول على اتصال من الـpool | 500 `Failed to update tenant profile`؛ لا cleanup لاتصال غير موجود | handler |
| فشل `beginTransaction` بعد الحصول على الاتصال | 500؛ discard للاتصال لأن حالة المعاملة غير مؤكدة | handler |
| فشل التحديث أو إدراج التدقيق (rollback ناجح) | 500؛ rollback ثم release مرة واحدة إن لم يبدأ commit | handler |
| فشل rollback نفسه | 500/404/409/200 حسب المسار؛ **destroy** للاتصال، بلا release، وبلا ادعاء تنظيف ناجح | handler |
| فشل إقرار `commit` | 500؛ **لا يُدّعى** rollback، حالة الاستمرارية غير معروفة، و**destroy** للاتصال | handler |

ترويسة `Cache-Control: no-store` على **كل** نتيجة يُصدرها الـhandler نفسه: 200، و400،
و404 الخاص به، و409، وكلا مساري 500 (تُضبط قبل أول `await` وقبل أي رفض). ردود
`auth`/الحدود upstream 401/403/409/400 لا تتغير ولا تحملها، وهذا مقصود.

## التفويض والذرّية

- التفويض **للمالك الفعلي فقط**: تُقرأ صف المساحة `FOR UPDATE` على اتصال المعاملة مع
  صف المستخدم المُستدعي (`tenants JOIN users WHERE t.id=? AND u.id=?`)، ويُشترط
  `tenants.owner_user_id == caller` و`tenants.status='active'` و`users.is_active=1`.
  وسم عضوية (`owner`/`instructor`) وحده **لا** يمنح الكتابة؛ ولا يُستدعى مساعد سلطة
  القراءة (`loadActiveTenantAuthority`) في مسار الكتابة.
- التحديث والتدقيق يتقاسمان نفس الاتصال والمعاملة:
  `UPDATE tenants SET business_name=? WHERE id=? AND owner_user_id=?` ثم
  `INSERT INTO audit_events (id,actor_user_id,tenant_id,action,resource_type,resource_id,old_value,new_value)`
  بـ`action='tenant.profile_name_updated'`, `resource_type='tenant'`, `resource_id=tenantId`,
  `old_value={"business_name":...}` و`new_value={"business_name":...}`.
- لا نجاح قبل `commit()`. إن فشل التدقيق، يُنفَّذ rollback للتحديث ولا يُبلغ نجاح.
- **إقرار commit المفقود حالة غامضة:** لا يُدّعى rollback ولا نجاح، ولا إعادة كتابة
  صامتة. يعيد 500 ويُسجَّل خطأ استمرارية غير مؤكدة، ويُدمَّر الاتصال بدل إعادته للـpool.
- **ملكية الاتصال صريحة:** تعذّر الحصول على اتصال لا يُنفّذ أي cleanup. فشل
  `beginTransaction` يُدمّر الاتصال غير المؤكد. بعد بدء المعاملة: rollback ناجح
  (بما فيه الرفض وno-op و409) أو commit ناجح ⇒ `release()` مرة واحدة. فشل rollback
  أو فشل/غموض `commit` ⇒ `destroy()` مرة واحدة، ولا `release()`. لا إعادة محاولة
  rollback/commit، ولا ادعاء rollback بعد commit غامض.
- إعادة المحاولة المطابقة no-op حقيقي: لا `UPDATE` ولا حدث تدقيق إضافي. حتى لو فشل
  rollback في مسار no-op يُدمَّر الاتصال وتبقى الاستجابة الحالية الحقيقية بلا كتابة.
- لا تعديل `subject_type`/`status`/الملكية/العضويات/الأهلية/البيانات المالية. لا
  schema/migration/جدول/خدمة/شبكة/مزوّد/حزم/Git.

## الأدلة (منفذة فعليًا)

- `server/tests/m2-tenant-profile-update.test.ts` — **31 اختبارًا تمر جميعها**. تقود
  الوحدات الإنتاجية الحقيقية بالترتيب الفعلي: `createOptionalAuth` ثم
  `enforceTenantAuthorityBoundary` ثم `enforceStudentWorkspaceBoundary` ثم
  `createTenantSelfRouter`، مع repository/اتصال معاملة محقونين فقط. لا listener ولا
  `fetch` ولا بدء تطبيق.
- تغطية سلوكية: مالك ناجح (اسم مُقلَّم)، ترتيب `begin→select→update→audit→commit→release`،
  `subject_type=null`، اسم بطول255، no-op مطابق بلا تدقيق، رفض instructor، رفض وسم دور
  `owner` دون مطابقة المالك الفعلي، رفض مساحة موقوفة، رفض مستخدم غير نشط، اختيار
  عبر المستأجرين/غموض/عضوية ملغاة بلا اتصال، 401/403/400 قبل المعاملة، رفض الأجسام
  غير الصالحة/الزائدة، فشل التحديث/التدقيق/rollback/commit، صف تحديث صفري 409،
  فشل الحصول على اتصال (بلا cleanup)، فشل `beginTransaction` (destroy)، فشل
  lock/select بعد begin (rollback ثم release)، فشل rollback في مسارات 500/404/409/
  no-op (destroy بلا release)، وفشل إقرار commit (destroy بلا release)، مع تحرير
  أو إتلاف الاتصال مرة واحدة بالضبط.
- assert قيم/وسائط SQL الفعلية: نص `LOCK_SELECT` بوسائط `[tenantId,userId]`،
  `UPDATE_SQL` بوسائط `[name,tenantId,userId]`، ووسائط التدقيق (actor/tenant/action/
  resource وJSON القديم/الجديد). إثبات أن مسار الكتابة **لا** يستدعي
  `loadActiveTenantAuthority`.
- عقد الترويسة: اختبار صريح يغطي 200 (نجاح/no-op)، 400، 404، 409، 500 ويتحقق من
  `Cache-Control: no-store` في كل منها.
- انحدارية: `GET /profile` ما زال يعيد DTO الأربعة حقول دون تغيير.
- عزل الاستيراد إثبات إيجابي: `src/db` و`src/services/minio` و
  `src/services/subscription-renewal` تُعترض في محمّل CommonJS قبل أي استيراد للتطبيق،
  ولا تدخل `require.cache`، و`MINIO_*` تبقى `undefined`، وعدّاد sentinel=0 يُعاد تأكيده
  في خطاف `after` بعد المجموعة كاملة.
- `server/tests/m2-tenant-profile.test.ts`: **20/20 تمر** (لم يُكسَر مسار القراءة
  المقبول). `tsc --noEmit -p server/tsconfig.json`: **0 تشخيصات، exit 0** قبل التغيير
  وبعده (قياسان منفصلان).

## حدود التغطية (صريحة)

- لا MySQL حقيقي، لا HTTP حقيقي، لا مزوّد، لا Docker: قفل الصف الحقيقي، التزامن الفعلي،
  وتدقيق rollback على الصف تُترك لمجموعة التكامل (`tests/integration/*`، **لم تُشغَّل**).
  الاختبارات المحقونة **ليست** إثباتًا لقفل/تزامن SQL حقيقي: fixture التحديث لا يعكس
  rollback فعلي، لذلك يُثبت حد القرار (تسلسل الاستدعاءات: rollback دون commit) لا
  الأثر الفيزيائي.
- `loadActiveTenantAuthority` يجري تخطيه في مسار الكتابة؛ الاستيثاق والحدود تُجرَّب
  بالوحدات الإنتاجية الحقيقية ولكن بrepository محقون.
- لا ادعاء أداء أو سلوك end-to-end، ولا قبول ذاتي.

## خارج النطاق

محرر الاسم في الواجهة، branches/branding/host، الكتالوج العام، الحالة/النوع/الوصول
المدفوع، OTP (مؤجل). M2-B02 لا يغلق C1 أو M2.
