# 17 — قائمة بناء المنتج الكامل ومعايير القبول

هذا المصدر الحاكم للنطاق. المراحل M1–M8 ترتيب اعتماد؛ **كل صف وظيفة مطلوبة**. “Needs verification” لا يعني إسقاطها؛ يعني أن التنفيذ ينتظر إثبات vendor/device/contract محدد. لا تعتبر أي وظيفة Done بدون test/run evidence.

## M1 — Security + tenant core

| ID | الوظيفة / السطح | تبعيات | معيار القبول |
|---|---|---|---|
| S1 | identity موحد user/tenant membership/branch membership | production schema inventory, migration ledger | user له memberships متعددة؛ كل membership role/status/version؛ invariants تمنع cross tenant/branch |
| S2 | auth, OTP, sessions/revoke, recovery | provider account/security design | OTP one-time/expiring/throttled؛ جلسات revoke؛ role مستمد من server؛ rate-limit abuse tests |
| S3 | RBAC capability policies | S1/S2 | default deny على route/resource/action؛ لكل role allow/deny matrix واختبار مباشر API |
| S4 | signup/invitation policy | S2/S3 | no self-selected admin; invite scoped/expiry/consumption single-use; audit |
| S5 | safe migration & data ownership | schema inventory, backup/restore | no runtime DDL/destructive import; ledger; ambiguous legacy rows quarantined; reproducible rollback/recovery |
| S6 | private file and export tenant scope | S1/S3 | A cannot list/read/replace/download/delete/export B files; signed access expires/revokes |
| S7 | video/object/session tenant scope | S1/S3 | A→B manifest/key/token/session denied; expired/revoked entitlement denies; audit events scoped |
| S8 | queue/cache/socket tenant context | S1/S3 | forged tenant ID ignored; job/socket access cross-tenant denied; missing context fails closed |
| S9 | M1 release gates | S1–S8, restored DB fixture | API/files/video/jobs A→B suite passes; secret scan and auth tests pass; snapshot restore demonstrated before M2 |

## M2 — Teacher/Student core

| ID | الوظيفة / السطح | تبعيات | معيار القبول |
|---|---|---|---|
| C1 | tenant/branch/teacher page identity | S1/S3 | institution metadata, branch relation and status are tenant-owned, audited |
| C2 | branding, RTL/English, subdomain | C1, domain service | tenant custom logo/color localized; host resolves exact tenant, bad host denied |
| C3 | custom domains | C2, verified DNS/TLS provider | challenge proves ownership, TLS issued/renewed/revoked; takeover/expired record denied; vendor behavior verified |
| C4 | public teacher page and course discovery | C1/C2, catalog | public projection only; search result tenant-safe; unpublished content hidden |
| C5 | course/unit/lesson/file catalog | C1/S6 | create/edit/reorder/archive; file type/size checks; policy protects unpublished content |
| C6 | scheduled drip release | C5, scheduler/clock | release occurs by server time/tenant timezone; early request denied; retries idempotent |
| C7 | sequential lesson unlocking | C5, progress service | next lesson opens only after configured completion; direct URL bypass denied |
| C8 | terms/month structure and enrollment lifecycle | C4/C5 | enrollment attaches to correct term, date/status transitions audited |
| C9 | student signup/join and OTP login | S2/S3, C4 | verified contact; throttle, expiry, wrong-code behavior; no tenant cross-link |
| C10 | enrollment/access status | C8/C9 | only eligible student consumes course; revoked/expired enrollment blocks future content requests |
| C11 | basic schedules and announcements | C1/C8, notification core | tenant/branch audience, time zone and permissions; edit/retract auditable |
| C12 | CSV/XLSX student import | S5/C9/branches | parser validates headers/type/rows; preview and duplicate resolution; rejected row report; import idempotent/audited |

## M3 — Video protection

| ID | الوظيفة / السطح | تبعيات | معيار القبول |
|---|---|---|---|
| V1 | provider-neutral video asset lifecycle | S6/S7/C5 | state machine, idempotent callbacks, verified owner, retries/dead-letter |
| V2 | upload/transcode HLS/ABR/DRM | V1, DRM provider verification | upload resumes; status only after provider verification; device matrix; unsupported device UX recorded |
| V3 | per-tenant playback entitlement | C10/V1 | short token tied to lesson/student/tenant/session; expired/revoked/cross-tenant denied |
| V4 | dynamic partial identity watermark | S2/V3 | pseudonymous partial identity only; overlap/opacity/position; screenshots are not claimed impossible |
| V5 | device and concurrent-session limits | S2/V3/session registry | configurable policy, warning/self revoke/support audit; race tests prevent oversubscription |
| V6 | low-bandwidth resume | V2/V3/progress | ABR and resume survive reconnect/device permitted state; progress cannot be forged across student/tenant |
| V7 | downloads where allowed | rights/DRM provider | default deny; authorized asset/device/expiry; revoke and offline lease tested; provider capability verified |
| V8 | usage events for watch/storage | V1/V3, meter schema | dedupe heartbeat/provider callbacks; tenant attribution and reconciliation evidence |

## M4 — Assessment, assignments, gradebook

| ID | الوظيفة / السطح | تبعيات | معيار القبول |
|---|---|---|---|
| A1 | reusable question bank | S1/S3, C1 | questions tenant-owned, tagged, versioned; reuse never leaks across tenants |
| A2 | timed exams and snapshots | A1/C10 | server clock authoritative; published exam version immutable for active attempt |
| A3 | MCQ auto-grading | A2 | deterministic rubric, integer/decimal scoring policy documented, regrade idempotent |
| A4 | manual grading | A2, teacher capabilities | examiner only sees assigned tenant/student answers; rubric/revision/audit |
| A5 | assignments and file submissions | C5/S6/C10 | deadlines/time zone, private upload scan, resubmission/version/revoke policy |
| A6 | grading assignments and gradebook | A4/A5 | weighted/points policy visible; calculated grades recomputable, permissions scoped |
| A7 | student progress and reports | V8/A3/A6 | student sees own/parent sees published scope; teacher filters tenant/branch; export audited |
| A8 | certificates | A3/A6 | eligibility policy, unique verify ID, revocation, tenant branding, no forged certificate |

## M5 — Groups, attendance, integrated live

| ID | الوظيفة / السطح | تبعيات | معيار القبول |
|---|---|---|---|
| G1 | groups, multi-teacher center, branches | S1/S3/C1 | membership is branch/tenant scoped; teacher only sees assigned groups |
| G2 | schedules/calendar | G1/C8 | timezone recurrence, DST/date edge cases, notifications and cancel/reschedule audit |
| G3 | manual attendance | G1/G2 | present/absent/late/excused state; actor/time/reason; duplicate marking idempotent |
| G4 | automatic attendance | Live provider S7 | verified join/leave callbacks, reconnect/grace policy, teacher correction with audit |
| G5 | in-platform live session | G1/G2, provider POC, S8 | authorized join token, host roles, mute/remove, connection failure handling, no cross-tenant room access |
| G6 | recording saved into course library | G5/V1 | recording callback verified; tenant and lesson mapping; scan/transcode; ready/fail/retry states |
| G7 | attendance reports and manual+automatic reconcile | G3/G4 | totals match events; teacher override reason retained; export scoped |

## M6 — Parent and notifications

| ID | الوظيفة / السطح | تبعيات | معيار القبول |
|---|---|---|---|
| P1 | parent-student verified linking | S2/S3, legal policy | single-use challenge to verified contacts; authorization/revocation/session tests |
| P2 | read-only parent progress/attendance/grades | A7/G7/P1 | only linked child and published fields; parent cannot mutate student state |
| P3 | notification preferences | S2/P1 | purpose/channel opt-in, consent source/time, unsubscribe and re-consent history |
| P4 | in-app/email delivery | event/outbox | retries idempotent, bounce/failed state, locale template and links expire safely |
| P5 | WhatsApp/SMS reports | P3/P2, provider verification | approved template/account, verified number, opt-in and STOP/unsubscribe honored, no PII in delivery logs |
| P6 | lesson comments and Q&A | C5/C10/S3 | enrolled access only; moderation/report/block; deletion/retention and notification rules |
| P7 | parent report delivery | P2/P3/P5 | report contains only configured summary; channel proof and successful/failed receipt logged |

## M7 — Super-Admin operations

| ID | الوظيفة / السطح | تبعيات | معيار القبول |
|---|---|---|---|
| O1 | tenant create/suspend/restore with reason | S1/S3 | allowed transition/dual authorization as needed; reason/actor/time/status immutable audit |
| O2 | plans and feature-flag editor | S3/O1 | validation, preview, scoped targeting, version, audit, rollback, server-side enforcement |
| O3 | teacher usage metering | V8/enrollment/store events | active students/watch minutes/storage definitions, filters/range, reconciliation and export; does not calculate charges |
| O4 | content moderation/reports | P6/C4 | queue, evidence, decision/reason, appeals, tenant notification, reviewer permissions |
| O5 | support tickets | S3/O1 | tenant and request identity, assignment/status/priority/private note, audit and export |
| O6 | impersonation | S2/O5/explicit permission | reason and approval, time bound, visible banner, read/write scope, every action audit, protected actions blocked |
| O7 | audit logs | all domains | append-only write path; filters/export with audit; tamper detection/retention policy |
| O8 | platform analytics | O3/O7 | aggregate without accidental PII exposure; definitions/time windows match source ledger |
| O9 | platform MFA | S2 | mandatory for super-admin/staff sensitive roles; recovery and step-up tests |

## M8 — Quality and operations

| ID | الوظيفة / السطح | تبعيات | معيار القبول |
|---|---|---|---|
| Q1 | complete Arabic RTL and English | all UI flows | strings/dates/numbers/forms/error/print directions work in both locales |
| Q2 | accessibility | all surfaces | keyboard, screen reader labels, contrast, zoom, error focus and media captions reviewed |
| Q3 | search | catalog/permissions | tenant/visibility filters server-side; query and indexing performance measured |
| Q4 | observability | all services/jobs/providers | structured redacted logs, traces/metrics, tenant/request IDs and actionable alerts |
| Q5 | backup and tested restore | DB/object/export | encrypted isolated backup; restore drill records duration/data loss and passes target |
| Q6 | per-tenant data export | S6 and all domains | user-initiated/admin authorized export, completeness manifest, signed expiry and audit |
| Q7 | scale/performance | measured traffic profile | load test meets documented p95/errors/queue lag; capacity thresholds and rollback |
| Q8 | release safety | CI/CD | tests/lint/build/security scan, migration approval, staged deployment, rollback evidence |

## Gating rules and status evidence

- M1 is blocking for every later milestone. A→B tests cover API, private files, video authorization/token, jobs and socket room boundary before M2.
- Do not promote cross-milestone provider stubs to Done. Mark provider/API/contract/device gaps Needs verification.
- Every row requires unit, integration, security or demonstrated manual evidence appropriate to its behavior. Tests run and commits recorded per milestone.
- Tenant data export, backup and restore are product/operations functionality, not cleanup work.
- Founders decide the teacher fee outside the system; meter only records evidence according to `14-usage-metering`.
