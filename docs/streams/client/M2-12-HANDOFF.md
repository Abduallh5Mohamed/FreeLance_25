# M2-12/B06: private tenant branding editor, API and local preview

Human196 direct request to prepare and start next real NEW M2 batch now, under
180/152. WorkBuddy native lane; OpenCode owns separate six student-import fixes.
Backlog17/C2 explicitly requires tenant-owned localized branding/color. Before:
no private branding configuration contract/editor. After: verified selected-tenant
owner can read and save Arabic/English display labels and accent color, with an
accessible existing-dashboard editor and honest local RTL/English preview.
One coherent full API+schema FILE+editor+tests+contracts batch. Presentation metadata
only: do not rename business_name/accounts, affect access/pricing, or apply a
global application language/theme. Logo assets, hosts/subdomains/customDNS/TLS and
whole C2 stay separate existing dependency gates. No provider/file/upload guesses.

Task client-m2-12-private-branding-20261021-01. Exact THIRTEEN allowedPaths:

1. server/src/routes/tenant-branding.ts: new injected production router, NO default
   adapter/provider import, AuthRequest type-only.
2. server/src/routes/tenant-self.ts: additive branding import/mount ONLY after
   existing authentication, preserve185/current accepted handlers byte-for-byte.
3. server/migrations/20261021_02_tenant_branding.sql: new table FILE only, no apply.
4. server/tests/helpers/m2-tenant-branding-harness.ts: synthetic positive import
   interception/transaction fixture only, real production handlers/composition.
5. server/tests/m2-tenant-branding.test.ts: real auth/contract/write/no-op tests.
6. server/tests/m2-tenant-branding-failures.test.ts: real cleanup/audit/failure tests.
7. src/pages/InstructorDashboard.tsx: additive dedicated card import/mount ONLY;
   preserve existing profile/name/wallet/dashboard logic, no route changes.
8. src/features/tenant/TenantBrandingCard.tsx: new Arabic/RTL accessible editor with
   explicit open, labeled fields/local unsaved preview/read status/confirmation.
9. src/features/tenant/branding.ts: new injected client parser/controller/lifetimes.
10. src/lib/api-http.ts: additive branding DTO/read/PATCH adapters ONLY. Shared
    request/auth/errors/session and all accepted adapters unchanged.
11. src/tests/m2-tenant-branding-ui.test.ts: real transport/controller/callback tests.
12. docs/streams/server/M2-B06-CONTRACT.md: actual API/schema/checks/limits.
13. docs/streams/client/M2-12-CONTRACTS.md: actual editor/preview/checks/limits.

NO student-import/InstructorStudents/lesson source, shared helpers/auth/middleware/
index/provider/config/package/other schema changes. Unique worker reply separately
allowed. Native own MCP claim exact task; Codex never claims/edits active source.

## Private existing authority and canonical contract

GET/PATCH /api/tenants/me/branding, dedicated factory mounted existing tenant-self.
Explicit billingOnly refusal403 before acquisition, same active actual selected-
tenant owner row/active caller/tenant as185. Owner before config lookup; role labels
and unscoped admin/student/foreign owner never grant visibility/writes. Preserve
existing auth/selector/student-boundary status precedence via real composition.
No tenant/header/body/identity selector, no global/public projection endpoint.
Every handler-owned outcome Cache-Control:no-store before await/denial.

Envelope exactly {branding:{display_name_ar,display_name_en,accent_color,updated_at}}.
Labels null OR trimmed1..255 characters; Unicode permitted, no script guessing.
accent_color null OR exact #RRGGBB hex, canonical uppercase stored/returned; null
means inherit existing presentation, not empty string/default fabricated setting.
updated_at canonical SQL epoch -> finite ISO before commit, or null ONLY for
successful owner read with genuinely absent config row. Missing schema/SQL/error
is500 feature unavailable, NEVER a fabricated all-null success.

PATCH nonempty subset of ONLY display_name_ar/display_name_en/accent_color, strict
object/keys/types/lengths, reject empty strings/arrays/numbers/URLs/other fields.
No-op same effective values: no update/audit/commit, truthful canonical response.
Absent row + all-null requested effective config is a no-op and stays absent;
absent row + change inserts complete effective row with other fields null.

One injected connection/transaction. Lock real owner/user and existing config for
writes; owner row lock also serializes first insert. All proof/changes/bounded
old-new branding audit/readback/DTO share transaction. One bounded audit event for
effective change, never credentials/student/billing fields. Materialize DTO before
one commit. Acquire/begin/owner/read/insert/update/audit/readback/epoch/rollback/
commit failures: honest status, exactly one safe release OR destroy. Unknown commit
ack: destroy, no false rollback/idempotence/retry claim. No lost-update prevention
or version/CAS promise unless actually present; do not invent product conflict policy.

tenant_branding table: tenant_id CHAR(36) PK FK tenants(id), nullable two VARCHAR255
labels and CHAR7 accent_color, TIMESTAMP created/updated. Match existing declared
parent engine/collation; no duplicate business identity/tenant fields, no ALTER/
backfill/default seed/runtime DDL. FILE only; compatibility/application is a later
authorized gate. No DB/provider/network/service/bootstrap/rollout action.

## Complete usable editor and preview

Owner-only label is informative; server remains authority, no client role guessing.
One explicit open -> one GET, not every dashboard render or polling. Dedicated
controller created per mount, no principal/task state in shared request. Exact
envelope/keys/types/canonical real ISO/null rule; malformed2xx never confirmed.
Server selected identity only; no client tenant selector. Use existing stable
canonical principal/session seam; read at entry and before BOTH success/error.
Close/unmount/scope loss clears private fields/drafts/notices/preview and retires
pending work. Close remains available during pending reads. Read generation, form
generation and confirmed-write epoch prevent old read/write from overwriting newer
draft/server confirmation; one actual write flight/own-ticket lifecycle, no silent
enabled no-op or automatic write retries. Definite denial/error distinct from
unknown persisted outcome; invalid2xx/transport500 stays uncertain, preserves draft,
explicit reconcile reads current values only, never proves prior save succeeded.

Fields offer explicit inherit/null controls; trimmed blank invalid if not inherit.
PATCH sends dirty subset only; no-op no request. On confirmed canonical response
show saved truth, don't overwrite newer draft. Preview clearly UNSAVED/local,
switch Arabic RTL vs English LTR only within preview; show inherited state honestly
without changing entire app. Render names as text; color CSS only after strict
hex validation, never raw style/HTML/URL. No logo/background/network image fetch,
localStorage/sessionStorage/IndexedDB/clipboard or global theme/language provider.

## Required safe verification and done

Server: production factory+actual tenant-self auth/selector/student-boundary mount
using injected leaves. Positively intercept default DB/provider/renewal/dotenv
BEFORE imports and assert bodies not cached/called. Synthetic rollback-restoring
fixture+call order; no real listener/socket/HTTP/DB. Cover all authority/selector/
billing/order/null/inherit/first insert/noop/audit/uppercase color/strict payload/
epoch and every cleanup/failure boundary including uncertain commit.
Run new2 suites+unchanged245 accepted safe profile/update/branch/unit/lesson/
lesson-reorder server tests and server local tsc0. Never legacy auth-boundary/
m1-expanded-tenant-admin/default adapters/index bootstrap.

Client: real canonical request with stubbed synthetic fetch/storage/session,
production parser/controller and actual component callbacks. Cover form/null/color/
localized preview, malformed dates/envelopes/2xx uncertainty, no-op/double submit,
principal silent swap/session/close/unmount/races/both outcomes, older finally/newer
flight, errors/reconcile/confirmation/newer draft and exact request bounds.
Run new UI suite+unchanged330 safe unit/lesson/course/branch/profile suites and
public179/188 unchanged if accessible; local frontend tsc zero scoped, known11
outside honestly reported. No installs/npx fetch/TEMP/source reconstruction/lint/
browser/network/services/Git/deploy or unsupported performance/whole C2/M2 claim.

Stop ALL edits/checks before native MCP report and concise unique worker reply:
actual commands/counts/diagnostics/paths/before-after/limits, no prose-only proof or
self-acceptance/new tasks/timers. Codex reviews actual stable source/architecture/
contracts/tests/bounds, gives exact same-scope corrections through OpenCode.
