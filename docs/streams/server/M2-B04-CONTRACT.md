# M2-B04 Contract — private owner-managed course-unit metadata

**Task:** `client-m2-b04-course-unit-metadata-20261019-01` — team `backend`, the
five approved paths only. **Basis:** the human152 delegation of the bounded
M2-B04 slice recorded in
[171](../client/coordination/supervisor/171-m2-b04-unit-metadata-task-and-cli-start.md)
and specified in [M2-B04-HANDOFF.md](M2-B04-HANDOFF.md).
**Correction:** `client-m2-b04-utc-correction-20261020-01` — the same five
paths, on the human152 necessary-correction authority, for the 173 findings
F1 (exact-UTC projection) and F2 (truthful mutable-pagination claim), recorded
in
[173](../client/coordination/supervisor/173-m2-b04-review-utc-and-pagination-truth.md).
**Branch:** `codex/human-client`.

This document is an execution and coverage contract. **It is not acceptance**;
acceptance is Codex's independent review.

## Changed paths (exactly five)

| Path | Change |
|---|---|
| `server/src/routes/course-units.ts` | **new** injected router with the whole unit contract; corrected by the 173 task to project the timestamps as epoch seconds and to state the mutable-`display_order` pagination truth |
| `server/src/routes/tenant-self.ts` | **additive only**: one import + one `router.use('/catalog', …)` after `router.use(deps.authenticate)`; every accepted handler (profile read/write, branches, subscription, billing, top-ups, renewal intents) is untouched |
| `server/migrations/20261019_02_course_units.sql` | **new** additive table FILE — **never applied** |
| `server/tests/m2-course-units.test.ts` | **new** hermetic suite; extended by the 173 task with the UTC/epoch and mutable-pagination regressions |
| `docs/streams/server/M2-B04-CONTRACT.md` | this document |

No change to `server/src/index.ts`, the authentication middleware, the shared
boundaries, any other router, the shared API client, the schema of an existing
table, a package, or a configuration file.

## Endpoints

```
GET   /api/tenants/me/catalog/courses/:courseId/units
POST  /api/tenants/me/catalog/courses/:courseId/units
PATCH /api/tenants/me/catalog/courses/:courseId/units/:unitId
```

The router is mounted by `createTenantSelfRouter` under `/catalog`, **after**
`router.use(deps.authenticate)`, so every unit route is authenticated by the
existing middleware. The tenant-self router itself stays mounted at
`/api/tenants/me` (`server/src/index.ts:150`); `index.ts` is unchanged.

`server/src/routes/course-units.ts` is a separate module with **no default
export**: it imports `AuthRequest` as a **type only** and binds **no** default
database, provider, renewal or environment adapter. Its single dependency is
an injected transactional connection supplier; the tenant-self mount supplies
its existing `getConnection`.

## Scope and data

A course unit is **private metadata only**: a name, a display position and a
status. There is no teacher assignment, no student entitlement, no
enrollment, no publication, no drip, no progress, no pricing, no capacity and
no contact data, and no upload/provider rule. Nothing in this slice changes
the access of an existing course or material, and no lesson or material row is
read or written.

Archiving a unit is a **metadata** change: it publishes nothing and grants or
revokes no course, student or teacher access. The owner still sees archived
units in the list — the list is private, not a public projection.

There is **no** `DELETE`, **no** move-to-course, **no** hard delete, **no**
default-unit backfill and **no** idempotency-key system. A retried create
produces a second unit; this is not claimed to be idempotent.

## Authorization — verified owner only, resolved from server-side rows

- The caller must be the **verified** `tenants.owner_user_id` of the
  server-selected tenant, that tenant must be `active`, and the caller's own
  `users` row must be live. The check is re-resolved on the same connection
  that performs the unit work, from server-side rows only.
- A membership role label (`owner`/`instructor`) **never** grants unit
  visibility or writes; neither does a global teacher/admin role, nor a
  student. The instructor read authority of the profile endpoints is
  deliberately **not** extended to units.
- The **owner is determined before the course is looked up**, so a non-owner
  learns nothing about whether a course exists.
- The course must exist, be `is_active = 1` and belong to the server-selected
  tenant. A **null, foreign, inactive and absent** course produce the
  **identical** 404.
- Every unit lookup and write qualifies **both** the unit id and the course of
  the path, so a foreign and an absent unit produce the identical 404 and no
  ownership is disclosed. The tenant of a unit is **derived** through its
  course; no request field can select it.
- The write paths take the owner rows and the **course row** `FOR UPDATE`, so
  a write cannot race an ownership change or a course archive. The list path
  uses a plain snapshot select inside its own transaction, so the verification
  and the page read share one snapshot without an exclusive lock on a read
  path.

### Local billing-only denial (before any data access)

`server/src/middleware/auth.ts:68-75` exempts the **whole** `/api/tenants/me`
prefix from the instructor billing-only path restriction, so mounting a route
below that prefix does **not** enforce the denial. Each unit route therefore
checks `req.user.billingOnly` itself and refuses **before any connection is
taken**. The shared authentication middleware, its exemptions and the existing
billing/support/profile handlers are **not** edited.

```
403 { "error": "Course unit management is not available while the account is limited to billing and support",
      "code": "BILLING_ONLY" }
```

The message is unit-specific so the local guard is distinguishable from the
upstream authentication denial.

## Request

### POST body — strict object `{name, display_order?}`

- `name` is **required** and must be a `string` that trims to `1..255`
  characters. The stored value is the trimmed value.
- `display_order` is optional and must already **be** an integer in
  `0..2147483647`. A numeric string, a float, a boolean, `null` or a
  negative/out-of-range value is rejected — the value is **never coerced**.
  The default is `0`.
- Any other key — a tenant/course/owner selector, a `status`, a publication
  or paid field — is rejected with **400** before a connection is taken. A
  body that is not a plain object, is an array, or is `null` is **400**.
- Duplicate names are **allowed**; the unit id (UUID) is the identity and the
  order may tie between two units.

### PATCH body — strict, non-empty subset of `{name, display_order, status}`

- Only those three keys are accepted. Any other key is **400**.
- An **empty** update is **400**.
- `name` follows the create rule; `display_order` follows the create rule;
  `status` must be exactly `active` or `archived` (any other value, including
  a non-string, is **400**).
- `:courseId` and `:unitId` must be canonical UUIDs; a malformed id is **400**
  (input validation, which discloses nothing about any row). A well-formed
  but foreign or absent id is **404**. An **empty path segment is not a
  routable path at all**: such a request never reaches a unit handler.
- A `display_order` change moves **that unit's** metadata position only. No
  other unit is renumbered and no ordering policy is claimed.

### GET query

- `limit` — optional integer `1..100`, default `25`. A non-digit, an
  out-of-range value, a non-string or a spaced value is **400**.
- `cursor` — optional opaque cursor. A malformed, oversized (>256 chars) or
  non-canonical cursor is **400**.

## Response

### GET 200

```json
{ "units": [ { "id": "...", "course_id": "...", "name": "...",
                "display_order": 0, "status": "active",
                "created_at": "2026-10-19T08:00:00.000Z",
                "updated_at": "2026-10-19T08:00:00.000Z" } ],
  "next_cursor": null }
```

The DTO is explicit — the row is never spread, and no tenant, owner, contact
or billing field is exposed. `next_cursor` is `null` when no further page
exists.

### POST 201

```json
{ "unit": { "id": "...", "course_id": "...", "name": "...", "display_order": 0,
            "status": "active", "created_at": "...", "updated_at": "..." } }
```

The id is server-generated (`randomUUID()`); the course is the one named in
the path. The row is read back inside the same transaction so the response
carries the exact stored timestamps rather than a guessed one.

### PATCH 200

```json
{ "unit": { "id": "...", "course_id": "...", "name": "...", "display_order": 0,
            "status": "active", "created_at": "...", "updated_at": "..." } }
```

### UTC timestamp serialization

The two timestamps are read as **Unix epoch seconds**, never as a driver
datetime value:

```sql
UNIX_TIMESTAMP(u.created_at) AS created_at_epoch,
UNIX_TIMESTAMP(u.updated_at) AS updated_at_epoch
```

The pool is configured with `timezone: '+02:00'`. That option is a
**client-side** instruction: the installed mysql2 decoder uses it to
*interpret* the wall time it receives, so it is **not** a
`SET SESSION time_zone` statement and it does not configure a SQL session
offset. With a UTC SQL session, a TIMESTAMP stored as `2026-10-20 12:00:00`
is decoded by that driver as `2026-10-20T10:00:00.000Z` — a two-hour
shift of every serialized instant.

Projecting the stored instant as epoch seconds removes the driver
interpretation entirely. The serialized value is therefore:

- the **exact stored instant**, independent of the SQL session time zone,
  of the driver offset and of a daylight-saving transition;
- identical for all three routes (list, create, update), because all three
  read the same projection;
- free of the epoch internals: the DTO keeps its **seven** fields and the
  `*_epoch` aliases never leak into a response.

**An unreadable instant is refused, never guessed.** A missing, malformed,
non-positive or unrepresentable epoch fails the request with the route's
500 answer; the write paths materialize the DTO **inside the transaction
and before the commit**, so an unreadable instant rolls the write back
instead of committing a row whose date could only be guessed. No 1970
instant, no "now" and no `null` date is ever produced.

Physical limits that remain unproven here: the projection assumes the
columns are `TIMESTAMP` (instant semantics), which is what the migration
file declares — a `DATETIME` column would be interpreted in the session
time zone instead. The MySQL `TIMESTAMP` range (1970-01-01 00:00:01 UTC
.. 2038-01-19 03:14:07 UTC) bounds the representable epochs; epoch `0` is
not representable and is therefore refused. No live MySQL, no session
time-zone setting and no query plan was exercised in this batch.

## List ordering and the cursor

Rows are ordered by `(display_order, id)` — a total order over the rows a
single request reads, which needs no timestamp or timezone interpretation.
The id is the tie-breaker when two units share an order. The list reads one
row beyond the requested page size to learn whether a successor exists and
never returns more than the requested size; there is **no** total count,
**no** all-page drain and **no** offset.

The cursor is the **base64url of `"<display_order>:<unit_id>"`**. It is
opaque, carries only a **position** — never authority, because the page is
still qualified by the course and the course by the selected tenant — and it
is **canonical**: the decoded pair is re-encoded and compared, so exactly one
encoding of a position is accepted. The decoded payload is range-checked
(`0..2147483647`) and shape-checked (a canonical UUID).

The keyset predicate is
`course_id=? AND (display_order>? OR (display_order=? AND id>?))`, so no page
is unbounded and no offset is used. The first page uses the sentinel order
`-1` (below every stored order) and the empty id.

### The cursor is a position, not a snapshot

`display_order` is **mutable**. The pages of one traversal are therefore
**not** a snapshot of the course:

- a unit that is moved **after** a page was served can **reappear** on a
  later page (it now sorts after the cursor position);
- a unit that is moved **before** the cursor position can be **omitted** from
  the remaining pages (it now sorts before the cursor position).

What the list actually guarantees:

- a **deterministic order per request** over the rows that request reads;
- **bounded** pages (default 25, maximum 100, one `limit+1` read);
- a cursor that is only a position and never authority.

What the list explicitly does **not** guarantee: a cross-request snapshot,
a stable-once view, or the absence of a repeated or a missed row under a
concurrent reorder. **No snapshot token, no version column, no ordering
freeze and no cursor policy change is provided or promised here** — those
would be new product semantics, and they are out of this slice. The
regressions that pin this behaviour are in
`server/tests/m2-course-units.test.ts` ("a unit reordered after a page was
served can reappear on a later page", "a unit reordered before the cursor
position is omitted by the later pages").

## Status and behaviour (read from the actual source)

| Status | Result | Source |
|---|---|---|
| Verified owner, active tenant, live user, active own course | 200 (list) / 201 (create) / 200 (update) | handler |
| Update whose values equal the current ones | 200 with the current DTO, **no** `UPDATE` and **no** audit event (truthful no-op) | handler |
| Invalid body / unknown key / empty update / invalid status / invalid name / invalid order / non-object body | 400 `Invalid course unit payload` / `Invalid course unit update payload` | handler |
| Malformed `:courseId` / `:unitId` | 400 `Invalid course id` / `Invalid course unit id` | handler |
| `limit` outside `1..100` or not an integer | 400 `Invalid course unit list limit` | handler |
| Malformed / oversized / non-canonical cursor | 400 `Invalid course unit list cursor` | handler |
| Client-supplied tenant selector (body, query or header) | 400 `Tenant context must not be supplied by the client` (upstream boundary answer) | `tenant-authority-boundary.ts` |
| Billing-only instructor | 403 `BILLING_ONLY` **before any database access** | local unit guard |
| Membership instructor, or an `owner` role label without the real `owner_user_id`, or the owner of another tenant | 403 `Forbidden`; no unit row is read or written | handler |
| Tenant not active | 403 `Forbidden` | handler |
| Revoked / inactive caller identity | 401, unchanged upstream behaviour | `auth.ts` |
| No selected tenant scope (no membership, or an ambiguous scope without a selection) | 404 `Tenant membership not found`, before any connection | handler |
| Global admin (no tenant scope) | 404 `Tenant membership not found` | handler |
| Student with a selected workspace | 403 `Forbidden` | handler |
| Course absent, foreign, tenant-less or inactive | 404 `Course not found` — identical for all four | handler |
| Unit id absent, foreign, or belonging to another course | 404 `Course unit not found` — identical for all three | handler |
| `UPDATE` affecting zero rows (concurrent modification) | 409 `Course unit was modified concurrently`, nothing audited | handler |
| Failed connection acquisition | 500 `Failed to list course units` / `Failed to create course unit` / `Failed to update course unit`; no cleanup for a connection that does not exist | handler |
| Failed `beginTransaction` | 500; the unconfirmed connection is **discarded**, never pooled | handler |
| Failed owner verification, course lookup, list read, unit lookup, insert, update, audit or read-back | 500; rollback, then release once | handler |
| Unreadable epoch projection (missing, malformed, non-positive or unrepresentable instant) | 500 `Failed to list course units` / `Failed to create course unit` / `Failed to update course unit`; rollback, then release once; **no** commit on the write paths — the DTO is materialized before the commit | handler |
| Failed rollback (read path) | the truthful page is still returned, and the connection is **destroyed**, never released | handler |
| Failed rollback (write path) | the write outcome is unchanged, and the connection is **destroyed**, never released | handler |
| Lost `commit` acknowledgement | 500; **no** rollback is claimed, no silent retry, and the connection is **destroyed** | handler |
| Invalid, missing, expired or revoked token | 401, unchanged upstream behaviour | `auth.ts` |
| Administratively suspended instructor account | 403 `TENANT_SUSPENDED`, unchanged upstream behaviour | `auth.ts` |

`Cache-Control: no-store` is set on **every** outcome the unit handlers
produce — 200, 201, 400, 403, 404, 409 and both 500 paths — before the first
`await` and before any denial. Upstream `auth`/boundary answers (401/403/400)
are unchanged and do not carry it; that is pre-existing behaviour.

## Atomicity, audit and uncertainty

- Write and audit share one connection and one transaction:
  - create: `INSERT INTO course_units (id,course_id,name,display_order,status) VALUES (?,?,?,?,?)`
    then `INSERT INTO audit_events (...)` with `action='course.unit_created'`,
    `resource_type='course_unit'`, `resource_id=<unit id>`, `old_value=NULL`,
    `new_value={"course_id":…,"name":…,"display_order":…,"status":"active"}`;
  - update: `UPDATE course_units SET name=?,display_order=?,status=? WHERE id=? AND course_id=?`
    then the audit insert with `action='course.unit_updated'` and the fixed
    `old_value`/`new_value` metadata.
- The audit payload is a **fixed, bounded key set** — the unit metadata plus
  the course reference. The actor is `actor_user_id`, the tenant is the
  **derived** selected tenant, the unit is `resource_id` and the course is
  referenced in the audited payload. No secret, contact, billing or student
  data is written.
- A failed audit rolls the write back and no success is reported. Success is
  reported only after `commit()` resolves.
- **A lost commit acknowledgement is an uncertain persistence state:** no
  rollback is claimed, no success is fabricated, no automatic retry is
  attempted, and the connection is destroyed instead of returning to the
  shared pool. There is **no** idempotency-key system in this slice and none
  is claimed — the UUID does not dedupe a retried create.
- **Connection ownership is explicit:** a failed acquisition performs no
  cleanup; a failed `beginTransaction` destroys the unconfirmed connection;
  after the transaction started, a successful rollback (including on a
  denial, a no-op and a 409) or a successful commit releases exactly once; a
  failed rollback or a failed/ambiguous commit destroys exactly once and never
  releases. There is no rollback or commit retry.
- An identical update is a truthful no-op: no `UPDATE`, no audit event. Even
  if the cleanup then fails, the connection is destroyed and the truthful
  current DTO is still returned.
- Concurrent writes to the same unit serialize on the unit row lock. No
  optimistic-version field and no idempotency promise is invented.

## Schema file (NOT applied)

`server/migrations/20261019_02_course_units.sql` creates exactly one table:

```
course_units(id CHAR(36) PK, course_id CHAR(36) NOT NULL, name VARCHAR(255) NOT NULL,
             display_order INT NOT NULL DEFAULT 0, status ENUM('active','archived') NOT NULL DEFAULT 'active',
             created_at TIMESTAMP, updated_at TIMESTAMP,
             FK (course_id) REFERENCES courses(id), CHECK (display_order >= 0),
             INDEX idx_course_units_page (course_id,display_order,id))
```

- The file is **additive only**: no `ALTER`, `DROP`, `TRUNCATE`, `DELETE`,
  `INSERT` or `UPDATE` statement, no backfill, no change to `courses`, no
  lesson/material schema.
- The tenant is **derived** from `courses.tenant_id`; there is deliberately
  **no** `tenant_id` column, so an independent relation can never disagree
  with the course.
- The foreign key to `courses(id)` has **no** `ON DELETE` clause: deleting a
  course that still owns units is refused by the database rather than
  silently orphaning or cascading the units. The product decision on course
  deletion is out of this slice.
- The file was **not applied**: no database was connected and no statement was
  executed. Static SQL inspection is not migration execution and is not
  database constraint validation.

## Evidence (actually executed)

All commands were run from `server/` unless stated otherwise.

**Correction pass** (`client-m2-b04-utc-correction-20261020-01`, the 173
findings F1 and F2) — executed after the 173 review, on the same five paths:

- `npx tsx --test tests/m2-course-units.test.ts` — **69 tests, 69 passing,
  0 failing** (61 before the correction, plus 8 new UTC/pagination
  regressions).
- `npx tsx --test tests/m2-tenant-profile.test.ts tests/m2-tenant-profile-update.test.ts tests/m2-tenant-branches.test.ts tests/m2-course-units.test.ts`
  — **164 tests, 164 passing, 0 failing** (the 95 accepted M2-B01/M2-B02/M2-B03
  tests, unchanged, plus the 69 unit tests).
- `npx tsc --noEmit -p server/tsconfig.json` — **0 diagnostics, exit 0**.
- The **unchanged public 173 probe**
  `C:/Users/BaraaWael/TabwebClientSupervisor/173-m2-b04-utc-probes.test.ts`
  was executed read-only — **4 tests, 4 passing, 0 failing** (it was 1/4
  before the correction: the driver self-test passed and the three
  real-handler timestamp assertions failed). It drives the real installed
  mysql2 decoder and the real handlers with an injected connection; it
  starts no service, opens no socket and reads no database.

**Original batch** (`client-m2-b04-course-unit-metadata-20261019-01`) — the
baseline the correction preserves:

- `npx tsx --test tests/m2-course-units.test.ts` — 61 tests, 61 passing,
  0 failing.
- `npx tsx --test tests/m2-tenant-profile.test.ts tests/m2-tenant-profile-update.test.ts tests/m2-tenant-branches.test.ts tests/m2-course-units.test.ts`
  — 156 tests, 156 passing, 0 failing.
- `npx tsc --noEmit -p server/tsconfig.json` — 0 diagnostics, exit 0.
- Behaviour covered by the new suite: owner list (explicit DTO, UTC ISO
  timestamps, course-qualified query, no foreign/tenant-less unit); the
  default page 25 and the explicit `1..100` bound; the `limit+1` read and the
  bounded response; rejected `limit` and cursor values (malformed, oversized
  and non-canonical) with no connection; the opaque cursor resuming strictly
  after the last returned row; the `(display_order, id)` tie-break on equal
  orders; a cursor as a position only; owner create (server-generated id,
  trimmed name, course placement, one audit event, and the exact call order
  `begin → owner → course → insert → audit → select → commit → release`);
  duplicate names allowed; the 255/256 character boundary; rejected create
  and update payloads; the rejection of a client tenant selector; owner
  rename, reorder, archive and reactivation; the truthful no-op; the
  identical foreign/absent course and unit 404s; the rejection of a malformed
  course/unit id; the empty path segment never reaching a handler; the
  billing-only denial on **all three** routes with zero database access; the
  membership-instructor, role-label, other-tenant-owner, inactive-tenant,
  revoked-user, student, admin, no-scope and ambiguous-scope refusals; the
  selected-scope switch; the `no-store` contract and exactly one response on
  200/201/400/403/404/409/500; and every connection failure mode — failed
  acquisition, failed `beginTransaction`, failed owner verification, failed
  course lookup, failed list read, failed insert, failed audit, failed unit
  lookup, failed read-back, zero-row update (409), failed rollback on the
  read and on the write path, and a lost commit acknowledgement on create and
  on update.
- **Added by the correction:** the serialized instant is the stored instant
  and not the driver-decoded value — the fixture hands back the raw
  datetime columns decoded with the installed driver's `timezone: '+02:00'`
  interpretation (two hours earlier) next to the epoch projection, and the
  DTO must ignore the shifted column; the same epoch rendered across the
  2026-03-29 daylight-saving start stays exactly one hour apart, so the
  result is offset- and DST-independent; a missing, `null`, zero, `NaN`,
  non-numeric or absent epoch projection fails the list, the create and the
  update with the route's 500 answer, rolls back and **never commits** — and
  never answers a 1970 instant, a current time or a `null` date; the
  truthful no-op refuses an unreadable instant the same way; the epoch
  projection never leaks into the DTO; and the mutable-`display_order`
  reality is pinned by two real-handler regressions — a unit reordered after
  a page was served **reappears** on a later page, and a unit reordered
  before the cursor position is **omitted** by the later pages — while two
  identical requests still read the same rows in the same order.
- The actual SQL text and bound parameters are asserted: the owner select
  (read and `FOR UPDATE` variants), the course select (read and `FOR UPDATE`
  variants), the keyset list statement with the epoch projection and
  `[courseId, order, order, id, limit+1]`, the course-qualified unit select
  with the epoch projection and `[unitId, courseId]`, the insert, the update
  and the audit parameters.
- Positive import isolation: the `src/db`, `src/services/minio`,
  `src/services/subscription-renewal` and `dotenv` module bodies are
  intercepted in the CommonJS loader before any app module loads, never enter
  `require.cache`, require no dummy env, and a sentinel counter is re-asserted
  empty in `after` after the whole group. The new unit module is loaded
  **alone and first** and the interception log is asserted **empty**, which
  proves the new module pulls in no database, provider, renewal or environment
  module by itself.
- The migration FILE is inspected read-only: the table shape, the foreign key,
  the index, the enum, the nonnegative check, the absence of a `tenant_id`
  column and the absence of every destructive statement are asserted.

## Coverage limits (explicit)

- No real MySQL, no real HTTP, no provider, no Docker, no migration
  execution. Real row locking, real concurrency, real keyset index usage,
  the real `ENUM`/foreign-key/`CHECK` constraints and the real transaction
  isolation are **not** exercised: the injected fixtures cannot replay a
  physical rollback, so the atomicity assertions prove the **decision
  boundary** (the call sequence — rollback without commit) and not the
  physical effect.
- The migration file was **not applied**; the schema shape and the deployment
  compatibility must be reviewed before any application.
- **Timestamp correction limits.** The epoch projection is exercised through
  an injected fixture and through the public 173 probe, not against a live
  MySQL: no real `UNIX_TIMESTAMP` evaluation, no real session time zone and
  no real query plan were run. The projection assumes the columns are
  `TIMESTAMP` (instant semantics), as the migration file declares; a
  `DATETIME` column would be interpreted in the session time zone instead and
  would need its own preflight. The pool's `timezone: '+02:00'` is a driver
  setting: this batch neither read nor changed the shared
  `server/src/db.ts` configuration, and no pooled `SET SESSION time_zone`
  was issued.
- **Pagination limits.** The mutable-`display_order` regressions run the real
  handlers against the fixture's rows; they demonstrate the documented
  behaviour (a reordered unit may reappear or be omitted) and they do not
  prove a physical concurrent reorder against a live InnoDB index. The
  keyset index usage and the isolation level remain unproven.
- The billing-only denial is proven at the handler boundary, with the real
  authentication middleware and an injected principal repository. The shared
  authentication middleware itself is not modified and is not re-designed here.
- The `limit`/`cursor` query contract is proven at the handler boundary; the
  upstream query parser is not re-implemented.
- The legacy `auth-boundary` and `m1-expanded-tenant-admin` suites were **not**
  re-run in this batch: they are outside the handoff's named scope. The named
  unchanged suites (`m2-tenant-profile`, `m2-tenant-profile-update`,
  `m2-tenant-branches`) were re-run and pass unchanged.
- No performance or throughput claim is made; no measurement was taken. The
  only bounds claimed are the ones visible in the source: one page read of
  `limit+1 ≤ 101` rows, one unit row per write, and exactly one connection
  acquisition and one release-or-destroy per request.
- No self-acceptance is claimed.

## Out of scope

Runtime rollout and migration application, any client UI, lessons, material
moves, uploads/providers, instructor assignments, student entitlement or
enrollment, publication, drip, progress, pricing/payment, the public catalog
and OTP (deferred). M2-B04 does not close C5 or M2.
