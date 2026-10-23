# M2-B03 Contract — tenant-owned branch metadata foundation

**Task:** `client-m2-b03-tenant-branches-20261019-01` — team `backend`, the four
approved paths only. **Basis:** the direct human request to execute the exact
presented [M2-B03-PROPOSAL](../client/M2-B03-PROPOSAL.md), recorded in
[148](../client/coordination/supervisor/148-human-direct-cli-starts-presented-branch-batch.md).
**UTC:** 2026-10-19T18:05Z — **Branch:** `codex/human-client`.

This document is an execution and coverage contract. **It is not acceptance**;
acceptance is Codex's independent review.

## Endpoints

```
GET   /api/tenants/me/branches
POST  /api/tenants/me/branches
PATCH /api/tenants/me/branches/:branchId
```

All three are mounted in `server/src/routes/tenant-self.ts` inside
`createTenantSelfRouter`; the router is already mounted at `/api/tenants/me`
(`server/src/index.ts:150`). **No** new mount and **no** change to `index.ts`,
the authentication middleware, the shared boundaries or any other router. The
accepted `GET /api/tenants/me/profile` (M2-B01) and `PATCH
/api/tenants/me/profile` (M2-B02) handlers are untouched.

## Scope and data

A branch is **metadata only**. One branch belongs to exactly one tenant
(`tenant_id`, immutable, server-owned). There is no assignment, enrollment,
teacher, student, group, pricing, capacity, contact or address data, and no
branch write touches wallet, payment, subscription, enrollment or assignment
data. There is no hard deletion, no cross-tenant move, no default-branch
backfill and no tenant-suspension or billing-status effect. Archiving a branch
changes branch metadata only; it grants and revokes no course, group or student
access.

## Authorization — owner only, resolved from server-side rows

- The caller must be the **verified** `tenants.owner_user_id` of the
  server-selected tenant, that tenant must be `active`, and the caller's own
  `users` row must be `is_active = 1`. The check is re-resolved on the same
  connection that performs the branch work, from server-side rows only.
- A membership role label (`owner`/`instructor`) **never** grants branch
  visibility or writes. The instructor read authority used by the profile
  endpoints is deliberately **not** extended to branches.
- The write paths take the tenant/user rows `FOR UPDATE` so a write cannot race
  an ownership change. The list path uses a plain snapshot select inside its own
  transaction, so the verification and the page read share one snapshot without
  taking an exclusive lock on a read path.
- Every branch lookup and write qualifies **both** the branch id and the
  selected tenant. A foreign id and an absent id produce the **identical**
  not-found result, so no ownership is disclosed. No branch row is ever
  readable through a minted cursor, because the page is still tenant-qualified.

### Local billing-only denial (before any data access)

`server/src/middleware/auth.ts:68-75` exempts the **whole** `/api/tenants/me`
prefix from the instructor billing-only path restriction, so mounting a route
below that prefix does **not** enforce the denial. Each branch route therefore
checks `req.user.billingOnly` itself and refuses **before** any connection is
taken and before the first `await`. The shared authentication middleware, its
exemptions and the existing billing/support/profile handlers are **not** edited.

```
403 { "error": "Branch management is not available while the account is limited to billing and support",
      "code": "BILLING_ONLY" }
```

The message is deliberately branch-specific so the local guard is
distinguishable from the upstream authentication denial (which uses a different
message and is not raised on this exempt prefix).

## Request

### POST body — strict single-field object

```json
{ "name": "..." }
```

- `name` must be a `string` that trims to `1..255` characters. The stored value
  is the trimmed value.
- Any other key — a status, a capacity, a tenant selector — is rejected with
  **400** before a connection is taken. A body that is not a plain object, is
  an array, or is `null` is **400**.
- Duplicate names are **allowed**: the branch id (UUID) is the identity, and no
  uniqueness rule is inferred.

### PATCH body — strict, `name` and/or `status`

```json
{ "name": "...", "status": "active" | "archived" }
```

- Only `name` and `status` are accepted. Any other key is **400**.
- An **empty** update is **400**.
- `status` must be exactly `active` or `archived`; any other value (including a
  non-string) is **400**. A branch status outside these two values is never
  stored.
- `name` follows the same `1..255` trimmed rule as the create.
- `:branchId` must be a canonical UUID; a malformed id is **400** (input
  validation, which discloses nothing about any row). A well-formed but
  foreign or absent id is **404**.

### GET query

- `limit` — optional integer `1..100`, default `25`. A non-digit, an
  out-of-range value, a non-string or a repeated value is **400**.
- `cursor` — optional opaque cursor. A malformed cursor is **400**.

## Response

### GET 200

```json
{ "branches": [ { "id": "...", "name": "...", "status": "active",
                   "created_at": "...", "updated_at": "..." } ],
  "next_cursor": null }
```

The DTO is explicit — the row is never spread, and `tenant_id` is never
exposed. `next_cursor` is `null` when no further page exists.

### POST 201

```json
{ "branch": { "id": "...", "name": "...", "status": "active",
              "created_at": "...", "updated_at": "..." } }
```

The id is server-generated (`randomUUID()`); the tenant is the server-selected
one. The row is read back inside the same transaction so the response carries
the exact stored timestamps rather than a guessed one.

### PATCH 200

```json
{ "branch": { "id": "...", "name": "...", "status": "active",
              "created_at": "...", "updated_at": "..." } }
```

### List ordering and the cursor

Rows are ordered by the branch id (`ORDER BY b.id ASC`). The id is a unique,
total, stable order, so a keyset cursor needs no timestamp or timezone
interpretation — the page boundary is unambiguous and the same request always
returns the same page. The list reads one row beyond the requested page size
to learn whether a successor exists, and never returns more than the requested
size.

The cursor is **base64url of the last returned row's id**. It is opaque and
carries only a **position**, never authority: the page query is still
`WHERE tenant_id = ? AND id > ?`, so a cursor minted for another tenant is only
a position and discloses nothing. The keyset read means no page is unbounded
and no offset can skip or duplicate a row under concurrent writes.

## Status and behaviour (read from the actual source)

| Status | Result | Source |
|---|---|---|
| Verified owner, active tenant, active user | 200 (list) / 201 (create) / 200 (update) | handler |
| Update whose values equal the current ones | 200 with the current DTO, **no** `UPDATE` and **no** audit event (truthful no-op) | handler |
| Invalid body / unknown key / empty update / invalid status / invalid name / malformed branch id | 400 `Invalid branch payload` / `Invalid branch update payload` / `Invalid branch id` | handler |
| `limit` outside `1..100` or not an integer | 400 `Invalid branch list limit` | handler |
| Malformed cursor | 400 `Invalid branch list cursor` | handler |
| Client-supplied tenant selector (body, query or header) | 400 (upstream boundary answer) | `tenant-authority-boundary.ts` |
| Billing-only instructor | 403 `BILLING_ONLY` **before any database access** | local branch guard |
| Membership instructor, or a `owner` role label without the real `owner_user_id` | 403 `Forbidden`; no branch row is read or written | handler |
| Tenant not active, or the caller's user row not active | 403 `Forbidden` (an inactive caller row is already revoked upstream with 401) | handler |
| No selected tenant scope | 404 `Tenant membership not found`, before any connection | handler |
| Branch id absent in the selected tenant, or belonging to another tenant | 404 `Branch not found` — identical for both | handler |
| `UPDATE` affecting zero rows (concurrent modification) | 409 `Branch was modified concurrently`, nothing audited | handler |
| Failed connection acquisition | 500 `Failed to create branch` / `Failed to update branch` / `Failed to list branches`; no cleanup for a connection that does not exist | handler |
| Failed `beginTransaction` | 500; the unconfirmed connection is **discarded**, never pooled | handler |
| Failed owner verification, list read, branch insert, update or audit | 500; rollback, then release once | handler |
| Failed rollback | 500/403/404/409/200 as the path dictates; the connection is **destroyed**, never released, and no successful cleanup is claimed | handler |
| Lost `commit` acknowledgement | 500; **no** rollback is claimed, no silent retry, and the connection is **destroyed** | handler |
| Invalid, missing, expired or revoked token | 401, unchanged upstream behaviour | `auth.ts` |
| Administratively suspended instructor account | 403 `TENANT_SUSPENDED`, unchanged upstream behaviour | `auth.ts` |

`Cache-Control: no-store` is set on **every** outcome the branch handlers
produce — 200, 201, 400, 403, 404, 409 and both 500 paths — before the first
`await` and before any denial. Upstream `auth`/boundary answers (401/403/409/400)
are unchanged and do not carry it; that is pre-existing behaviour.

## Atomicity, audit and uncertainty

- Write and audit share one connection and one transaction:
  - create: `INSERT INTO tenant_branches (id,tenant_id,name,status) VALUES (?,?,?,?)`
    then `INSERT INTO audit_events (...)` with `action='tenant.branch_created'`,
    `resource_type='tenant_branch'`, `resource_id=<branch id>`, `old_value=NULL`,
    `new_value={"name":...,"status":...}`;
  - update: `UPDATE tenant_branches SET name=?,status=? WHERE id=? AND tenant_id=?`
    then the audit insert with `action='tenant.branch_updated'`,
    `old_value={"name":...,"status":...}`,
    `new_value={"name":...,"status":...}`.
- A failed audit rolls the write back and no success is reported. Success is
  reported only after `commit()` resolves.
- **A lost commit acknowledgement is an uncertain persistence state:** no
  rollback is claimed, no success is fabricated, no automatic retry is
  attempted, and the connection is destroyed instead of returning to the shared
  pool. There is **no** POST idempotency-key system in this slice and none is
  claimed — the UUID does not dedupe a retried create.
- **Connection ownership is explicit:** a failed acquisition performs no
  cleanup; a failed `beginTransaction` destroys the unconfirmed connection;
  after the transaction started, a successful rollback (including on a denial,
  a no-op and a 409) or a successful commit releases exactly once; a failed
  rollback or a failed/ambiguous commit destroys exactly once and never
  releases. There is no rollback or commit retry.
- An identical update is a truthful no-op: no `UPDATE`, no audit event. Even if
  the cleanup then fails, the connection is destroyed and the truthful current
  DTO is still returned.

## Evidence (actually executed)

- `server/tests/m2-tenant-branches.test.ts` — **44 tests, all passing**. The
  real production units are driven in the real production order
  (`createOptionalAuth` → `enforceTenantAuthorityBoundary` →
  `enforceStudentWorkspaceBoundary` → `createTenantSelfRouter`) with only leaf
  repositories and the transactional connection injected. No listener, no
  socket, no `fetch`, no app startup, no database, no provider.
- Behaviour covered: owner list (explicit DTO, tenant-qualified query, no
  foreign row); default page 25 and the explicit 1..100 bound; the
  `limit+1` read and the bounded response; rejected `limit` and cursor values
  with no connection; the opaque cursor resuming strictly after the last
  returned row; a cursor as a position only; owner create (server-generated id,
  trimmed name, tenant placement, one audit event, and the exact call order
  `begin → owner → insert → audit → select → commit → release`); duplicate
  names allowed; the 255/256 character boundary; rejected create payloads; a
  rejected client tenant selector; owner rename, archive and reactivation; the
  archive-only-metadata-effect statement check; the truthful no-op (with and
  without a status); the identical foreign/absent 404; rejected update
  payloads; the billing-only denial on **all three** routes with zero database
  access; the tenant-selector boundary on all three routes; failed insert,
  failed audit, lost commit acknowledgement (create and update), failed
  acquisition, failed `beginTransaction`, failed rollback, denial cleanup
  failure, zero-row update (409) and failed list read; the `no-store` contract
  on 200/201/400/403/404/409/500; and exactly one response per request.
- The actual SQL text and bound parameters are asserted: the owner select
  (read and `FOR UPDATE` variants), the keyset list statement with
  `[tenantId, cursorId, limit+1]`, the tenant-qualified branch select with
  `[branchId, tenantId]`, the insert, the update and the audit parameters.
- Positive import isolation: the `src/db`, `src/services/minio` and
  `src/services/subscription-renewal` module bodies are intercepted in the
  CommonJS loader before any app module loads, never enter `require.cache`,
  require no dummy env, and a sentinel counter is re-asserted empty in `after`
  after the whole group.
- Regression witnesses: `GET /profile` still returns the unchanged four-field
  DTO and `PATCH /profile` still renames and audits the institution, through
  the same production handler.
- Unchanged accepted suites, re-run after the change: `server/tests/
  m2-tenant-profile.test.ts` (M2-B01, 20) and `server/tests/
  m2-tenant-profile-update.test.ts` (M2-B02, 31) — both still pass, unchanged.
- The scoped set (`m2-tenant-branches`, `m2-tenant-profile`,
  `m2-tenant-profile-update`, `m1-expanded-tenant-admin`, `auth-boundary`)
  passes **118/118**, exit 0.
- `tsc --noEmit -p server/tsconfig.json`: **0 diagnostics, exit 0** before the
  change and after it (two separate measurements).

## Coverage limits (explicit)

- No real MySQL, no real HTTP, no provider, no Docker. Real row locking, real
  concurrency, real index usage for the keyset read and the real `ENUM`
  constraint on `status` are **not** exercised: the injected fixtures cannot
  replay a physical rollback, so the atomicity assertions prove the decision
  boundary (the call sequence — rollback without commit) and not the physical
  effect.
- The migration file was **not applied**: no database was connected and no
  statement was executed. Static SQL inspection is not migration execution and
  is not database constraint validation. The schema shape and the deployment
  compatibility must be reviewed before any application.
- The billing-only denial is proven at the handler boundary, with a real
  authentication middleware and an injected principal repository. The shared
  authentication middleware itself is not modified and is not re-designed here.
- The `limit`/`cursor` query contract is proven at the handler boundary; the
  upstream query parser is not re-implemented.
- No performance or throughput claim is made; no measurement was taken.
- No self-acceptance is claimed.

## Out of scope

Runtime branch rollout and any client UI, branch RBAC beyond the owner, teacher
assignments, student enrollment, pricing/capacity, branch branding or hosts,
the public catalog, the paid state/type/access work and OTP (deferred). M2-B03
does not close C1 or M2.
