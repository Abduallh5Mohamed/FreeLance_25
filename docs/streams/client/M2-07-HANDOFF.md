# M2-07: branch metadata controls on the existing dashboard

Selected and authorized under human152 bounded M2 task delegation; supervisor153.
Task `client-m2-07-branch-management-ui-20261019-01`, frontend. No new product
policy: consume the accepted151 B03 API exactly. No migration application.

## Goal, before/after and exact six paths

Before: API and migration FILE for branch metadata accepted151, no dashboard
branch controls. After: a dedicated Arabic/RTL accessible component, opened
explicitly from the existing dashboard, lists one bounded page and lets the
server-authorized owner create, rename, archive/reactivate branch metadata.
Label owner-only; never infer owner/capability from local role/profile/status.
Errors remain real when migration is not applied; no fake production data.

- src/pages/InstructorDashboard.tsx — mount the component only, preserve144 editor.
- src/features/tenant/BranchManager.tsx — dedicated component, rendering/labels.
- src/features/tenant/branches.ts — injected production request/form lifecycle.
- src/lib/api-http.ts — additive DTO/list/create/update adapters ONLY.
- src/tests/m2-tenant-branches-ui.test.ts — actual transport/controller behavior.
- docs/streams/client/M2-07-CONTRACTS.md — source contract, checks/limits.

Existing shared request/auth/errors/session-events/router/backend/profile.ts/
package/config/schema/providers and accepted tests are NOT editable. Read only
necessary nonsecret dependencies; preserve every dirty accepted file/owner.

## Existing contract and behavior

Read docs/streams/server/M2-B03-CONTRACT.md and151 acceptance. Canonical request:
GET /tenants/me/branches with limit25/cursor; POST body{name}; PATCH branchId
body{name and/or status}. Trim1..255; status active/archived. Server-selected
tenant, no selector, name uniqueness assumption or branch assignment/access effect.
Explicit five-field branch DTO and list next_cursor. No row spread/fallback DTO.
Runtime validation; PATCH response id must match requested branch id.

Use one explicit list page (25 rows), next/first-page navigation, bounded memory,
no automatic all-page draining/polling. Load on explicit panel open, not eager
requests for every dashboard viewer. Loading/error/empty/denied/session/missing
branch distinguished using only documented transported messages (status/code are
discarded). Preserve canonical BILLING_ONLY redirect/identity event and suspension
teardown in shared request; do not recreate or change those shared semantics.
Owner denial must never imply paid access or destroy unrelated profile state.

One synchronous mutation flight before await; no duplicate create/save/status
action. Separate form/request/page/session generations; observe canonical principal
at entry and BOTH stale success/error completion before state settlement. Old
reply/finally never mutates newer page/form/session or releases newer latch; busy
presentation must settle truthfully after every supersession. Close/unmount/logout
clears private rows/drafts and retires requests. Explicit retry remains usable.
Reuse the accepted canonical principal reader/notifier, no parallel auth lifetime.

Server-authoritative success only. Failed write retains appropriate draft/current
data. Malformed/500/network POST/PATCH outcomes may have persisted: show uncertain
warning, NEVER automatically retry writes. Offer deliberate list read; a matching
name/list is not proof of a prior create/audit (duplicate names allowed). Preserve
warning that deliberate create retry may duplicate. No invented idempotency.
After confirmed success use validated DTO and at most ONE deliberate bounded
refresh if necessary for canonical page ordering; no uncontrolled extra requests.

Keyboard/form labels/feedback, disabled busy controls, no accidental form submit
from archive/cancel/paging buttons. Keep controller behavior outside rendering;
avoid expanding dashboard with a second large inline state machine.

## Tests, impact and completion

Meaningful hermetic tests of actual canonical adapters (fake fetch) and injected
production controller: paths/query encoding/canonical bearer/name-only/status
body/no selectors; malformed DTO/id; deny/401/BILLING_ONLY; failure/uncertain and
deliberate reconciliation; repeated clicks; reversed GET/mutation/page/form/session,
silent logout on BOTH stale outcomes, newer latches/disposal; bounded page/request
counts. No implementation copied into tests, no text-only substitute.

Run new suite plus unchanged38 read/33 edit/relevant61 helper tests, local frontend
tsc before/after; known11 outside distinguished, no whole-project clean claim.
No unsafe server suite/default DB/provider imports, dotenv, live browser/server/
network/install/Git/deploy. No optional lint/TEMP baseline/source-disable probes.
Tests do not prove DOM/runtime DB/latency. Migration151 remains unapplied.

Impact: only existing branch metadata writes/audit through accepted endpoints,
no assignment/student/pricing/OTP/payment change. Stop ALL edits/checks before
native MCP report and concise worker coordination. Codex independently accepts
actual stable source/architecture/contracts/tests/types or issues exact corrections.
Checkpoint natural milestones, true native mapping if available; tokens private.
