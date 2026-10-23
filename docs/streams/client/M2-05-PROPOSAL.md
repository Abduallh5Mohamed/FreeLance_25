# M2-05 proposal: selected institution identity on existing instructor dashboard

**Approved2026-10-19:** explicit human approval and same-scope correction delegation
recorded in [105](coordination/supervisor/105-human-approved-m2-05-client-profile-start.md).
Task client-m2-05-dashboard-profile-20261019-01, five exact paths below. Proposal-only
wording below is historical; no wider shared/auth/backend/services authority.

Prepared2026-10-19 after human asks what action follows accepted101. Proposal
only, not execution approval. Workspace codex/human-client; accepted work preserved.

## Actual screen and before/after

src/pages/InstructorDashboard.tsx exists; App.tsx mounts it at /instructor behind
instructor AuthGuard. It currently displays the local user's greeting and separate
stats/transactions/requests/subscription data, but no selected institution profile.
No new screen, route or setting surface is necessary.

After: a read-only institution identity card on that existing dashboard consumes
accepted GET /api/tenants/me/profile. Show server-confirmed business_name,
subject_type only when present, and institution status as metadata. Do not equate
institution status with payment or course entitlement, map arbitrary subject_type
values to invented business categories, or substitute local user name/billing DTO.
Loading, retryable error,401/403 and404 no-authorized-workspace are distinct;
failure clears identity instead of retaining a prior session's institution.

## Exact proposed five paths

- src/pages/InstructorDashboard.tsx — integrate the read-only card and lifecycle.
- src/features/tenant/profile.ts — small injected production loader/controller,
  runtime DTO validation and principal/scope generations; used by the page.
- src/lib/api-http.ts — narrowly add TenantProfile DTO and getMyTenantProfile
  through existing authenticated request transport; no changes to shared auth,
  request error behavior or existing API contracts.
- src/tests/m2-tenant-profile-ui.test.ts — hermetic actual-production tests.
- docs/streams/client/M2-05-CONTRACTS.md — contract, test evidence and limits.

api.ts already re-exports api-http, so no extra barrel file changes. This proposed
small shared API addition needs explicit approval as part of these five paths;
no raw duplicated authentication transport or alternate token storage.

## Lifetimes and limits

Use existing session-events subscription plus exact canonical identity observed
at entry/commit, monotonic session/scope/request lifetime, cleanup on unmount and
old success/error/finally unable to commit into newer load. Show only confirmed
server profile of selected workspace; no client selector query/header. Missing
or malformed body is an error, never fabricated institution data.

Do not refactor unrelated dashboard stats/subscription/transactions, accepted
feature modules or shared helpers. Existing dashboard money/default-zero and
countdown concerns are separate from this profile slice; record verified findings
without silently expanding scope. No new branches/branding/host/public catalog,
profile writes, prices/paid-access policy, OTP or services.

## Impact, verification, completion

Read-only existing endpoint, no server/schema/data writes or providers. No DB,
network/browser/live startup, installs or Git writes. WorkBuddy alone implements
natively after a fresh approved exact-path task; Codex reviews stopped code.

Tests: actual transport path uses canonical authenticated request; exact valid DTO,
nullable subject, malformed response,404/401/403 and transient failure+retry;
scope/session A-B-A, reversed loads, pending failure after newer success, disposal,
old finally ownership and no cross-session private identity. Do not copy production
implementation into tests or assert permission from local role. Prove no header/
query client tenant selectors. Before/after relevant frontend types and existing
client regressions, distinguish known11 outside errors; do not claim DOM/browser
or performance proof from isolated tests.

Done only after production integration and meaningful isolated tests independently
reviewed, zero scoped types, contract matches behavior and limitation record. No
self acceptance or automatic subsequent batch. No unresolved product decision is
needed for this read-only display; subject_type labels remain literal server data.
