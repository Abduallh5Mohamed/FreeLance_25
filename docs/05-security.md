# الأمن والخصوصية والعزل

## ترتيب غير قابل للتجاوز

Security + tenant core هو M1؛ لا يبدأ أي surface جديد قبل نجاح الاختبارات الحرجة في [17](17-full-feature-backlog.md). تقرير [audit](ARCHITECTURE_AUDIT_AND_MIGRATION_PLAN_AR.md) يسجل صلاحيات غير موحدة، self-assigned role، أسرار/fallback، DDL runtime، Socket.IO ومخاطر IDOR. الـaudit دليل تاريخي يجب تأكيده على النسخة الحالية، ولا يجوز اعتبار وجود middleware/tenant column إثباتًا للاكتمال.

## نموذج تهديد

| أصل/تهديد | مثال | ضابط واختبار |
|---|---|---|
| tenant data | تعديل ID طالب أو تقرير tenant B | server-derived membership + compound FK + A→B tests للـAPI/export/jobs |
| privilege escalation | signup يرسل role admin | allowlist أدوار signup؛ اختبار injection/غير معروف |
| جلسات وOTP | سرقة token أو إساءة OTP | rate limit، expiry/one-time، revoke/session registry ومخزن آمن |
| video/data files | رابط manifest أو export دائم | entitlement وقت الإصدار، signed URL قصير، object private وA→B tests |
| live media | تزوير participant/callback | participant/session identity من provider verified webhook + recheck tenant |
| parent data | ربط ولي غير شرعي أو تجاوز النطاق | consent/verification/revocation، published-only read, audit |
| impersonation/admin abuse | دعم يفتح طالبًا/يغير مالًا | سبب، موافقة، مدة، banner، audit immutable، منع العمليات المحظورة |
| messaging | رسائل بلا opt-in أو كشف رقم | purpose-specific consent, preference/unsubscribe, minimization |
| supply chain/secrets | secret in source/CI/build | rotation, secret manager, fail startup if missing, CI scan |

## Identity/Auth

هوية موحدة مع memberships متعددة؛ OTP email/SMS/WhatsApp للطلاب وفق channel verification ومعدل/انتهاء/one-time؛ كلمات مرور آمنة للstaff/مدرس أو passkey لاحقًا. جلسة access قصيرة + refresh rotation/revocation أو server sessions. MFA إلزامي Super-Admin، ويُطلب step-up للـimpersonation/export/tenant restoration. لا تخزن OTP أو recovery token كـplaintext ولا تسجلها في logs. لا تربط حسابات بمعرف اتصال غير موثق.

## RBAC

capability-based scope: `platform.tenant.manage`, `platform.feature_flags.manage`, `platform.usage.read`, `platform.moderation.review`, `platform.support.manage`, `platform.impersonate`, `platform.audit.read`; tenant-scoped `tenant.brand.manage`, `course.manage`, `student.read/manage`, `assessment.manage`, `attendance.manage`, `live.moderate`, `staff.manage`, `billing.read`, `parent.link.manage`. parent read-only, student own enrollment/data. Deny-by-default; لا wildcard في role UI أو صلاحية قديمة.

## ثوابت العزل

1. tenant ID مصدره principal membership أو host mapping verified؛ لا من العميل.
2. كل read/write/update/delete/export/media/job revalidates resource owner.
3. مركب FK يمنع علاقة course/enrollment/lesson/user بين tenants.
4. cache/object keys/events/audit تشمل tenant; cross-tenant context غير معلوم يرفض.
5. platform support/admin access just-in-time, least-privilege, time-bound, logged.
6. صفوف legacy الغامضة quarantine حتى owner verification.
7. redacted structured logs؛ لا OTP/tokens/student PII غير لازم.

## الخصوصية والاستمرارية

سجل البيانات والغرض وموقع المعالجة والاحتفاظ والمزودين؛ اتفاقيات controller/processor؛ شروط المدرس وسياسة الطالب والولي وموافقة قنوات الرسائل والتسجيل؛ طلب export/deletion وإدارة incident. راجع محليًا القوانين المصرية ذات الصلة وGDPR إذا نطاقها متحقق والسعودية قبل معالجة إقليمية. لا تصف المنتج “متوافقًا” من قائمة فحص وحدها.

نسخ DB/object metadata مشفرة إلى نطاق إداري منفصل؛ جدول RPO/RTO يعتمد بعد دراسة SLA؛ اختبار restore دوري ومراقب. incident response يشمل containment، أثر tenants، حفظ الأدلة، إشعار الأطراف المطلوبة واستعادة. pentest قبل الإنتاج الخارجي.

## Release gates

- Cross-tenant denial verified for API, static/private files, video, live callbacks, cache, exports and background jobs.
- Signup/OTP/session/authz/RBAC tests pass; Super-Admin MFA and impersonation audit pass.
- No runtime destructive DDL, no fallback secret, no public migration/admin endpoint, no hard-delete orphan behavior.
- Restore drill and video/session revoke exercised; rate limit, alerting, audit evidence and incident owner documented.
