# M2-13/B07: private academic-period planning catalog and editor

Human180/152/196/199 delegates larger coherent NEW M2 batches. Backlog17 C8
requires terms/month structure. Before: inspected routes/migrations/api surfaces
have no private academic-period planning catalog. After: actual selected tenant
owner can create/list/edit/archive planning periods with labels and date bounds,
through real private API and an existing-dashboard editor. This foundation does
not attach enrollments, define access windows, charge fees or complete C8/M2.
No new runtime policy inferred from dates/archive. Display that limitation clearly.

Task client-m2-13-private-academic-periods-20261021-01, WorkBuddy NEW lane.
OpenCode correction202 owns branding.ts, its UI test and M2-12 contract ONLY.
Do not change any of those three paths. Exact THIRTEEN allowedPaths:

1. server/src/routes/academic-periods.ts (new injected factory, no default adapter)
2. server/src/routes/tenant-self.ts (additive import/mount ONLY)
3. server/migrations/20261021_03_academic_periods.sql (FILE only)
4. server/tests/helpers/m2-academic-periods-harness.ts
5. server/tests/m2-academic-periods.test.ts
6. server/tests/m2-academic-periods-failures.test.ts
7. src/pages/InstructorDashboard.tsx (additive dedicated card import/mount ONLY)
8. src/features/tenant/AcademicPeriodsCard.tsx (new component)
9. src/features/tenant/academic-periods.ts (new parser/controller)
10. src/lib/api-http.ts (additive period DTO/adapters ONLY)
11. src/tests/m2-academic-periods-ui.test.ts
12. docs/streams/server/M2-B07-CONTRACT.md
13. docs/streams/client/M2-13-CONTRACTS.md

Preserve stopped073 branding server/card/mounts as provisional, not accepted;
preserve accepted200 CSV/190 lesson/185 backend and all dirty work. No other
source/shared helper/auth/router/index/provider/package/config/claim changes.
Read actual source/contracts and coordination202/203 before implementation.

## Private metadata API and schema FILE

Mount /api/tenants/me/academic-periods in existing authenticated tenant-self.
Use actual server-selected active tenant + actual owner row + active caller,
not local role/membership label. BillingOnly403 BEFORE connection. Preserve real
auth/selector/student-boundary precedence and no-store all own outcomes.

GET /: {periods:[DTO],pagination:{limit,offset,has_more}}. Strict only optional
limit decimal integer1..100 (default25), offset integer0..10000(default0), and
archived true|false (defaultfalse). Reject malformed/unknown selector/query keys.
Stable per-request order starts_on,id; query limit+1 bounded, same tenant filter,
no unbounded total-count/history/all rows. Mutable paging has no snapshot promise.

POST /: strict {name,starts_on,ends_on}, no selector/id/status. Name trimmed1..255;
date fields canonical real YYYY-MM-DD calendar dates, SQL DATE range1000..9999,
starts_on<=ends_on. These are date-only planning labels, no timezone/UTC conversion
or duration/access/billing semantics. Duplicated names/overlapping periods are
permitted: no uniqueness/overlap/enrollment policy has been approved. Return201
{period:DTO}, no client id, generated UUID identity.

PATCH /:id: nonempty subset name/starts_on/ends_on/is_archived boolean. Actual UUID
validation/canonical comparison, tenant-scoped lock/read; merge partial dates
before validating range. Archive is a reversible planning visibility flag ONLY,
not cancellation/enrollment/access effect. No hard delete or automatic date/status
transition, no enrollment/assignment/financial change. Missing/foreign id404,
strict payload400, denied403, genuine internal/schema failure500. No fabricated
empty success when schema missing. Effective no-op: no update/audit/commit.

DTO exactly {id,name,starts_on,ends_on,is_archived,created_at,updated_at}; no owner,
tenant or business/private user row. Booleans actual booleans; date-only projection
must avoid JS Date/driver timezone shift (DATE_FORMAT or equivalent SQL string),
timestamps epoch -> canonical ISO before commit. No invalid/impossible date or
untrimmed malformed2xx accepted by client. Explicit safe bounded projection.

New academic_periods table: UUID CHAR36 primary key, tenant_id matching tenants
FK engine/collation, VARCHAR255 name, DATE starts_on/ends_on, boolean archive,
TIMESTAMP created/updated. Index tenant_id,is_archived,starts_on,id for bounded
catalog; no ALTER/seed/backfill/runtimeDDL. FILE acceptance NEVER application.

Inject ONE connection per handler; transaction proof/owner/row locks/write/one
bounded old-new audit/readback/DTO before ONE commit. Audit only period fields,
actual actor/tenant/resource id; don't claim idempotence/CAS not implemented.
No-op rollback without audit. Unknown commit ack: destroy/no false rollback/no
retry. Acquire/begin/read/write/audit/readback/epoch/rollback/commit failures
exactly-one safe release OR destroy. Verify affected row/readback consistency.
Use owner-row lock for writes to preserve authorization/serialization evidence.

## Complete usable private editor

Dashboard card explicit open -> one bounded list; next/previous paging, archived
view toggle, create/edit form, reversible explicit archive action. Arabic RTL,
labels/aria-live, one real submit, other buttons type=button, close always usable.
No global locale/theme/route change. Clear wording: planning periods only; no
student registration, access, renewal, payment or automatic date transitions.

Dedicated injected controller and exact transport/envelope parsers. Server
identity only; canonical principal observed on entry and both success/error,
including retired replies. Session/close/dispose clear private rows/drafts/notices.
Read generation, form generation, confirmed-write epoch and OWN visible mutation
ticket prevent stale replies from changing newer save/error/notice/latch/form.
Bound data/page25/default,max100; no polling/per-row requests/all-pages loading.
One actual request per action, synchronous double-click latch, dirty-subset PATCH,
no-op no network. Definite error distinct from unknown write outcome, preserve
draft/uncertainty, no auto retries. Explicit refresh/reconcile reads current state,
never proves previous save succeeded. No storage/clipboard/network images.

## Tests, impact and done

New two server suites real factory+actual tenant-self composition; positively
intercept DB/provider/renewal/dotenv BEFORE imports, no default module cached/
called. Synthetic transaction-restoring fixture, no listener/socket/DB. Cover
auth/selectors/tenant isolation/billing guards/bounds/overlap allowed/real calendar
dates/timezone projection/partial range validation/no-op/archive/audit/order and
all failure/disposal branches. Run these plus unchanged324 scoped server tests
from073 (branding79 + accepted245), local server tsc0.

New UI suite real canonical request, parser/controller/component callbacks with
synthetic boundaries. Cover list/paging/create/edit/archive/no-op/errors/uncertainty,
date roundtrip, exact DTOs, silent session/retired replies/close/reopen/new-save
both outcomes/older finally/newer flight. Run new UI + accepted330 nearby suites
and accepted173 CSV suites. Branding tests belong to active correction202: do not
edit/retest those while owned. Frontend tsc zero own scoped; disclose outside and
active correction diagnostics accurately. No whole-project-clean claim.

No browser/DB/network/service/provider/install/npx-fetch/Git/deploy/migration
apply/TEMP reconstruction/lint experiments/new product or paid policy. Review
request/data/index/cleanup bounds, no unmeasured latency/scalability assertions.
Stop ALL edits/checks before native MCP report and concise unique worker reply
with actual commands/results/paths/limits. Codex independently reviews; no
self-acceptance, new task/schedule or duplicate owner. Preserve native claim.
