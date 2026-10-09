# خارطة البناء: M1–M8

المراحل التالية **ترتيب بناء فقط**. كل وظيفة في `02` و`17` ضمن المنتج؛ لا تستخدم الجدول لحذف وظيفة، ولا تفهمه كمدة إجمالية ثابتة. تقدير المدة والقدرة يحدث بعد backlog refinement وSpike لكل اعتماد خارجي. العمل متسلسل عند gates الأمنية.

| المرحلة | نطاق البناء | شروط إغلاق المرحلة |
|---|---|---|
| M1 — security + tenant core | identity/session, MFA basis, RBAC, tenant/member/branch model, migration safety, A→B tests | API/files/video/jobs/export/cache reject cross-tenant; authz matrix passes; restore successful; no unsafe schema mutation |
| M2 — teacher/student core | public page/discovery, branding/subdomain/domain verification, course/unit/lesson/files, signup/join/OTP, enrollment, progress, schedule/drip/terms, import base | tenant scoped end-to-end; custom domain ownership/TLS; import reconciles; responsive RTL route works |
| M3 — video protection | provider layer, DRM, partial watermark, session/device/concurrency limits, playback resume/low-bandwidth/download permissions | revoke/replay/device tests; assets compatibility recorded; download policy enforced |
| M4 — assessment and assignments | reusable question bank, timed exams, MCQ auto grading, manual grading, assignments/files, gradebook/reports/certificates | immutable exam version, timer/grading idempotence, upload scan/tenant scope |
| M5 — groups/attendance/live | groups/branches/schedules, manual+automatic attendance, integrated live sessions, recording-to-library | verified live provider callbacks, reconnect handling, recording and attendance reconciliation |
| M6 — parent and communication | parent link verification, published read-only views, notification preferences, in-app/email/WhatsApp/SMS, announcements/Q&A/comments | revoked links deny; opt-in/unsubscribe and delivery audit; no scope widening |
| M7 — platform operations | plan/flag editor, usage meter and export, tenant lifecycle, support/moderation/appeals, impersonation/audit, analytics and MFA enforcement | least privilege, dual confirmation for dangerous actions, audit trace and usage reconciliation |
| M8 — quality and scale | full RTL/English, a11y, search, performance/load, SLO/alerts, DR, data export, app installability | acceptance checklist, restore drill, accessibility and performance targets measured |

## Dependency graph

`M1 → M2 → {M3, M4} → M5 → M6 → M7 → M8`. M3 and M4 can proceed concurrently only after shared M1/M2 contracts and independent test gates. M7 tenant lifecycle core relies on M1; full admin reporting and meter presentation arrive in M7. Cross-cutting CI/security/tests continue every phase.

## Release discipline

At each milestone: implementation → tests/static checks → evidence capture → fix failures → commit. Do not begin dependent phase while a blocking test fails. A provider/API/legal decision is a dependency, not a simulated completed feature. Use feature flags for staged rollout; never use them as substitutes for backend authorization.
