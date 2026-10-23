# M2-B03 proposal: tenant-owned branch metadata foundation

Approved for direct CLI execution under human continuation148,2026-10-19,
after presentation of this exact proposal. Four paths and proposed policies below
now govern this bounded batch. Earlier pending/proposal-only statements are
historical for this batch. Timers disabled by human request; no DB application.

Prepared2026-10-19 after accepted144. PROPOSAL ONLY: not approved, queued or
implemented. This requires new backend/schema-file authority beyond131; it does
not authorize applying a migration or starting services. OTP stays deferred.

## Goal, source evidence and before/after

Backlog17:C1 requires tenant-owned audited branch relation/status. Agreement19
paragraph7 places branches inside the center tenant; assignments restrict teacher
access. Current accepted101/129/144 closes only selected institution identity/name.
Read-only search of server/src, server/migrations SQL and client api/features found
no branch table, branch_id relation or branch endpoint; the video-policy comment
using the English word branches is unrelated. This is evidence about checked
local source, not production schema or another checkout.

Foundation migration20260921_saas_foundation.sql declares tenants and tenant
memberships; it does not declare branches. Existing tenant-self router already
mounts below /api/tenants/me, authenticates and resolves selected tenant authority.
Accepted129 transaction/audit seam and randomUUID are available. Do not repurpose
groups, tenant memberships or subscription rows as implicit branches.

Before: no confirmed branch metadata API in the inspected surfaces. After this
bounded proposed batch: owner-controlled create/list/rename/archive metadata for
branches belonging to the server-selected tenant, using an additive migration
FILE and mocked SQL fixtures. No running DB evidence until a separately authorized
integration gate. This is not complete branch RBAC, assignments or full C1.

## Proposed exact four implementation paths

1. server/migrations/20261019_01_tenant_branches.sql — additive schema FILE only.
2. server/src/routes/tenant-self.ts — narrowly additive branch handlers/seams.
3. server/tests/m2-tenant-branches.test.ts — isolated real handlers/contracts.
4. docs/streams/server/M2-B03-CONTRACT.md — exact DTO, policy and limitations.

No index/auth/middleware/shared/client/package/config/provider changes. Preserve
accepted GET/PATCH profile and billing handlers. OpenCode implements only after
applicable explicit approval; Codex reviews. No claim/task exists for this proposal.

## Proposed policy to approve, not existing policy

- One branch belongs to exactly one tenant; no cross-tenant move, hard deletion,
  default-branch backfill, teacher assignment or student enrollment change.
- Owner-only list/write for this first metadata surface using verified owner
  rows in the selected active tenant. Do NOT extend existing instructor profile
  read authority into branch visibility. Broader branch roles need a later matrix.
- Important inspected boundary: auth.ts:68-75 exempts the WHOLE
  /api/tenants/me prefix from the instructor billing-only path restriction.
  Merely mounting new branch routes there therefore does NOT enforce a
  billing-only denial. Proposed branch handlers explicitly deny
  req.user.billingOnly before data access, without changing shared auth or
  exemptions for existing billing/support/profile handlers. Approval covers
  that local guard; tests must exercise it independently of mocked authenticate.
- Proposed states: active and archived. Archive changes only branch metadata;
  it grants/revokes no current course/group/student access. Reject state input
  outside these values. No tenant suspension or billing-status changes.
- Proposed fields: server-generated id, immutable tenant_id, trimmed name1..255,
  status and timestamps. No contact/address/student data, pricing or capacity.
  Duplicate names are permitted; UUID is identity. No inferred uniqueness rule.
- Proposed routes: GET/POST /branches and PATCH /branches/:branchId. Reject
  unknown write keys and all client tenant selectors. PATCH allows name/status
  only, rejects empty updates; current identical state is a no-op without audit.
- List uses deterministic bounded keyset pagination (default25, max100), no
  unbounded rows. Opaque validated cursor is a position, never authority.
- Branch lookups and writes always qualify BOTH id and selected tenant. Foreign
  or absent ids have the same not-found result, no ownership disclosure.
- Write plus audit are atomic; failed audit rolls back. Existing transaction
  cleanup/uncertain-commit rules retained. DTO is explicit, no row spread.
- All own outcomes carry no-store before the first await. POST commit failure
  may be uncertain: no fabricated success/rollback or blind automatic retry.
  This slice promises no POST idempotency-key system; that would require an
  explicitly designed storage/expiry contract rather than claiming UUIDs dedupe.
- Schema draft references existing tenants, indexes tenant/id for pagination;
  no destructive ALTER, runtime DDL, seed/backfill or DB execution. Schema shape
  and deployment compatibility must be reviewed before any application.

Approval must explicitly cover these proposed defaults and four paths. They are
not inferred from the existence of C1 or an earlier batch. If policy differs,
revise this proposal before implementation; no hidden decision in worker code.

## Data/services, tests and completion

Proposed writes: branch metadata and matching audit only; zero wallet/payment,
enrollment, student/group/teacher assignment or live provider effect. No migration
application, DB/browser/network/service startup/install/Git/deploy permitted.

Use injected real-router dependencies and positive import isolation. Tests cover
selected owner allow; non-owner, absent scope, inactive tenant/user deny; forged
selector/foreign branch; strict fields/status/name; paging bounds and cursor;
atomic audit failure, no-op, transaction/commit/release errors, no double response
or uncertain-success fabrication. Existing profile tests/probes remain unchanged.
Pin billing-only denial with no DB calls on all three new branch routes, and
unchanged outcomes on accepted profile and billing handlers. Pin no-store on
own200/400/403/404/500 outcomes, including acquisition/commit/audit failure.
Local installed Node/tsx/server tsc only, no blanket unsafe server suite/npx fetch.
Static SQL inspection is not migration execution or DB constraint validation.

Done only after stopped MCP report plus Codex independent actual source/schema
draft/architecture/contract/tests/types review, preserved accepted hashes and
recorded integration limits. Necessary correction loop stays inside approved
paths; no new role/status/provider policy. Runtime branch rollout and client UI
remain separate scopes, not silently bundled into acceptance of this foundation.
