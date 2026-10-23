# M2-B02 proposal: audited institution-name update

Approved for implementation by the human's direct request to start OpenCode
following presentation of this proposal,2026-10-19; governing supervisor124.
Name-only, verified institution owner-only write; exact three paths below.
Proposal/pending-decision wording below is historical for this approved slice.

Prepared from remaining C1; NOT approved, NOT queued, no implementation authority.
Accepted101/121 selected profile stays closed. This proposal covers institution
metadata only; branches, membership policy and institution-status changes remain
separate, and no whole-C1/M2 completion is implied.

## Evidence and smallest proposed behavior

docs/17-full-feature-backlog.md:27 requires tenant-owned audited metadata.
server/migrations/20260921_saas_foundation.sql:4 defines tenants.business_name
VARCHAR255; :16 defines active tenant memberships; :155 defines audit_events.
tenant-self.ts:119 currently reads the selected profile, with no profile write.
platform-tenants.ts contains admin audit writes; those do not grant tenant-user
write authority. No database/schema change is necessary for name-only metadata.

Before: a selected institution's name can be read through the accepted endpoint.
Proposed after: authenticated authorized actor updates only that institution's
business_name, returning the same minimal profile DTO after committed persistence.
Proposed PATCH /api/tenants/me/profile rejects unknown fields, supplied tenant/
owner/status selectors, missing/non-string/empty/over255 name. Do not update
subject_type, status, ownership, financial data, memberships or access entitlement.
The proposed exact endpoint/validation are design, not an existing API contract.

## Authorization decision to resolve before implementation

Recommended narrow policy: verified current institution OWNER only can rename;
an instructor membership alone cannot. Existing read permits owner/instructor,
so copying that helper unchanged would broaden proposed write permission.
This owner-only write policy needs applicable product approval; do not silently
infer it from read authority. Confirm name-only metadata as this bounded slice.
No additional branch/status/subject-type decisions are needed for name-only work.

## Proposed ownership and implementation boundaries

Exactly three proposed paths:
- server/src/routes/tenant-self.ts: scoped injected handler/route, selected authority,
  strict name payload, transaction using existing connection facilities, no-store.
- server/tests/m2-tenant-profile-update.test.ts: isolated production-handler tests.
- docs/streams/server/M2-B02-CONTRACT.md: actual request/response/error/audit contract.

Read necessary existing auth/transaction/audit dependencies; edit none. No middleware,
global router wiring, shared API, migrations/schema/package/config, live DB/services,
provider, install, Git/deploy or client editor changes. If existing facilities cannot
support one transaction without shared edits, report the exact dependency blocker.

Write and audit must commit together; audit failure rolls back name update, and
neither response nor UI can claim success before commit. Use tenant-scoped locked
row/authority revalidation appropriate to existing transaction facilities. Identical
retry must not invent another change event; define actual no-op behavior in contract.
Never log credentials/private identity or return audit internals/profile row spreads.

## Verification and completion

Positive import isolation: no dotenv/DB client/network initialization; injected
connection and identity fixtures exercise real production handler. Prove owner
success; no token; suspended/inactive/no selected tenant; instructor-only and
cross-tenant denial; missing/invalid/extra payload; update failure; audit failure;
rollback/commit failure; same-name retry; connection release and safe error body.
Assert actual SQL values/tenant predicate/audit ownership and transaction sequence,
while disclosing that mocked tests are not live SQL/concurrency authorization proof.
Run existing safe profile suite and server type check with before/after diagnostics.

Done after independent Codex source/architecture/contract/test/type review and
recorded acceptance. No client name editor or subsequent branch work implicitly
approved. No artificial duration or per-batch timer stop. OTP remains deferred.
