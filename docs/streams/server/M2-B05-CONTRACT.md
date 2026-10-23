# M2-B05 Contract — private lesson catalog and atomic batch ordering

**Task:** `client-m2-b05-lesson-catalog-20261021-01` — team `backend`, the seven
approved paths only, `implementationWorker: workbuddy`, `taskKind:
implementation`. **Basis:** the human180 dual-lane delegation recorded in
[180](../client/coordination/supervisor/180-human-dual-workers-larger-batches-15min.md)
and specified in [M2-B05-HANDOFF.md](M2-B05-HANDOFF.md).
**Branch:** `codex/human-client`.

**Correction:** `client-m2-b05-uuid-correction-20261021-01` — team `backend`,
`implementationWorker: opencode`, `taskKind: correction`, the **same seven
paths**, after the independent review
[182](../client/coordination/supervisor/182-m2-b05-uuid-identity-correction.md).
The correction is the UUID identity rule documented in
[the evidence section](#uuid-identity-correction-supervisor-finding-182); it
changed four of the seven paths and left the additive mount and the migration
FILE untouched.

This document is an execution and coverage contract. **It is not acceptance**;
acceptance is Codex's independent review.

## Changed paths (exactly seven)

| Path | Change |
|---|---|
| `server/src/routes/course-lessons.ts` | **new** injected router with the whole lesson contract: list, create, update and the atomic bounded reorder |
| `server/src/routes/tenant-self.ts` | **additive only**: one import + one `router.use('/catalog', …)` after the accepted unit mount; every accepted handler is untouched |
| `server/migrations/20261021_01_course_lessons.sql` | **new** additive table FILE — **never applied** |
| `server/tests/helpers/m2-course-lessons-harness.ts` | **new** synthetic, positively isolated fixtures/composition helpers (test-only) |
| `server/tests/m2-course-lessons.test.ts` | **new** hermetic CRUD/authority/validation/list suite |
| `server/tests/m2-course-lessons-reorder.test.ts` | **new** hermetic atomic batch/failure suite |
| `docs/streams/server/M2-B05-CONTRACT.md` | this document |

No change to `server/src/index.ts`, the authentication middleware, the shared
boundaries, any other router, the accepted unit router or its accepted tests,
the shared API client, `src/**`, `api-http`, a package, a configuration file or
the schema of an existing table.

## Endpoints

```
GET   /api/tenants/me/catalog/courses/:courseId/units/:unitId/lessons
POST  /api/tenants/me/catalog/courses/:courseId/units/:unitId/lessons
PATCH /api/tenants/me/catalog/courses/:courseId/units/:unitId/lessons/:lessonId
POST  /api/tenants/me/catalog/courses/:courseId/units/:unitId/lessons/reorder
```

The router is mounted by `createTenantSelfRouter` under `/catalog`, **after**
`router.use(deps.authenticate)` and next to the accepted M2-B04 unit mount, so
every lesson route is authenticated by the existing middleware. The tenant-self
router itself stays mounted at `/api/tenants/me`; `index.ts` is unchanged.

`server/src/routes/course-lessons.ts` is a separate module with **no default
export**: it imports `AuthRequest` as a **type only** and binds **no** default
database, provider, renewal or environment adapter. Its single dependency is an
injected transactional connection supplier; the tenant-self mount supplies its
existing `getConnection`.

## Scope and data

A course lesson is **private metadata only**: a title, an optional description,
a display position and a status. There is **no** lesson delivery, content,
video, file, material or asset reference, no upload/provider rule, no teacher
assignment, no student entitlement or enrollment, no publication, no drip, no
progression, no pricing/capacity and no contact data. Nothing in this slice
changes the access of an existing course, unit or material.

Archiving a lesson is a **metadata** change: it publishes nothing and grants or
revokes no course, unit, student or teacher access. The owner still sees
archived lessons in the list — the list is private, not a public projection.

There is **no** `DELETE`, **no** hard delete, **no** move-to-unit, **no**
move-to-course, **no** default-lesson backfill and **no** idempotency-key
system. A retried create produces a second lesson; this is not claimed to be
idempotent.

## Authorization — verified owner only, resolved from server-side rows

- The caller must be the **verified** `tenants.owner_user_id` of the
  server-selected tenant, that tenant must be `active`, and the caller's own
  `users` row must be live. The check is re-resolved on the same connection
  that performs the lesson work, from server-side rows only.
- A membership role label (`owner`/`instructor`) **never** grants lesson
  visibility or writes; neither does a global teacher/admin role, nor a
  student.
- The **owner is determined before the course is looked up**, so a non-owner
  learns nothing about whether a course exists.
- The course must exist, be `is_active = 1` and belong to the server-selected
  tenant. A **null, foreign, inactive and absent** course produce the
  **identical** 404 `Course not found`.
- The unit must exist **and** belong to the course of the path. A **foreign,
  absent or course-mismatched** unit produces the **identical** 404
  `Course unit not found`. An **archived** unit is still private
  owner-manageable metadata, so its status is deliberately **not** filtered.
- Every lesson lookup and write qualifies **both** the lesson id and the unit
  of the path, so a foreign and an absent lesson produce the identical 404
  `Course lesson not found` and no ownership is disclosed. The course and the
  tenant of a lesson are **derived** through its unit and that unit's course;
  no request field can select them.
- The write paths take the owner rows, the **course row**, the **parent unit
  row** and (for a single write) the **lesson row** `FOR UPDATE`, so a write
  cannot race an ownership change, a course archive, a unit move or a
  concurrent write on the same lesson. The list path uses plain snapshot
  selects inside its own transaction, so the verification and the page read
  share one snapshot without an exclusive lock on a read path.

### Local billing-only denial (before any data access)

`server/src/middleware/auth.ts` exempts the **whole** `/api/tenants/me` prefix
from the instructor billing-only path restriction, so mounting a route below
that prefix does **not** enforce the denial. Each lesson route therefore checks
`req.user.billingOnly` itself and refuses **before any connection is taken**.
The shared authentication middleware, its exemptions and the existing handlers
are **not** edited.

```
403 { "error": "Course lesson management is not available while the account is limited to billing and support",
      "code": "BILLING_ONLY" }
```

## Request

### POST body — strict object `{title, description?, display_order?}`

- `title` is **required** and must be a `string` that trims to `1..255`
  characters. The stored value is the trimmed value.
- `description` is optional: `null` or a `string` of at most **10000**
  characters (an engineering bound). It is stored **verbatim** — it is free
  text, not a label, so it is neither trimmed nor markup/URL-filtered.
- `display_order` is optional and must already **be** an integer in
  `0..2147483647`. A numeric string, a float, a boolean, `null` or a
  negative/out-of-range value is rejected — the value is **never coerced**. The
  default is `0`.
- `status` is **not** accepted on create: a new lesson is always `active`. Any
  other key — a tenant/course/unit/owner selector, an id, an asset/content/
  video/material field, a publication, assignment, progression or paid field —
  is rejected with **400** before a connection is taken. A body that is not a
  plain object, is an array, is `null` or is a primitive is **400**.
- Duplicate titles are **allowed**; the lesson id (UUID) is the identity and
  the order may tie between two lessons.

### PATCH body — strict, non-empty subset of `{title, description, display_order, status}`

- Only those four keys are accepted. Any other key is **400**; an **empty**
  update is **400**.
- `title` and `display_order` follow the create rules; `status` must be exactly
  `active` or `archived`; `description` is `null` (explicit clear) or a string
  of at most 10000 characters.
- `:courseId`, `:unitId` and `:lessonId` must be canonical UUIDs; a malformed
  id is **400** (input validation, which discloses nothing about any row). A
  well-formed but foreign or absent id is **404**. An **empty path segment is
  not a routable path at all**: such a request never reaches a lesson handler.
- A `display_order` change moves **that lesson's** metadata position only. No
  other lesson is renumbered and no ordering policy is claimed.

### POST /reorder body — ONLY `{items:[{id, display_order}]}`

- `items` must be an **array of 1..100** entries. The body must have **exactly**
  one key (`items`).
- Each entry must have **exactly** the two keys `id` and `display_order`; `id`
  must be a canonical UUID and **unique inside the batch**; `display_order`
  must already be an integer in `0..2147483647`.
- Any other key, a duplicate id, a non-integer position, a missing entry key,
  an out-of-range length (0 or 101) or a non-array is **400** before a
  connection is taken. Nothing is coerced, truncated or deduplicated.
- **One id has one identity.** The migration declares `course_lessons.id` as
  `CHAR(36)` in a `utf8mb4_unicode_ci` table, so MySQL compares the id
  **case-insensitively**: an uppercase uuid addresses the very same stored row
  as its lowercase spelling. The batch therefore works on ONE canonical
  identity — the lowercase form of a valid uuid — for the uniqueness check,
  the lock order, the SQL binds and the locked-row lookup. Two spellings of
  one id are a **duplicate batch** and are **400** before a connection is
  taken, exactly like two identical ids. The canonical identity never
  rewrites the stored spelling: the response DTO and the audit event keep the
  **stored** id.

### GET query

- `limit` — optional integer `1..100`, default `25`. A non-digit, an
  out-of-range value, a non-string or a spaced value is **400**.
- `cursor` — optional opaque cursor. A malformed, oversized (>256 chars) or
  non-canonical cursor is **400**.

## Response

### GET 200

```json
{ "lessons": [ { "id": "...", "unit_id": "...", "title": "...",
                 "description": null, "display_order": 0, "status": "active",
                 "created_at": "2026-10-21T08:00:00.000Z",
                 "updated_at": "2026-10-21T08:00:00.000Z" } ],
  "next_cursor": null }
```

The DTO is explicit — the row is never spread, and no tenant, owner, course,
contact, billing, content or asset field is exposed. `next_cursor` is `null`
when no further page exists.

### POST 201

```json
{ "lesson": { "id": "...", "unit_id": "...", "title": "...", "description": null,
              "display_order": 0, "status": "active",
              "created_at": "...", "updated_at": "..." } }
```

The id is server-generated (`randomUUID()`); the unit and the course are the
ones named in the path. The row is read back inside the same transaction so the
response carries the exact stored instants rather than a guessed one.

### PATCH 200

```json
{ "lesson": { "id": "...", "unit_id": "...", "title": "...", "description": null,
              "display_order": 0, "status": "active",
              "created_at": "...", "updated_at": "..." } }
```

### POST /reorder 200

```json
{ "lessons": [ { "id": "...", "unit_id": "...", "title": "...",
                 "description": null, "display_order": 5, "status": "active",
                 "created_at": "...", "updated_at": "..." } ] }
```

The response carries the canonical DTO of **every selected lesson** (at most
100) in the **resulting `(display_order, id)` order** — a deterministic order
over exactly the selection. It is **not** a whole-catalog read and it is **not**
a cross-request snapshot. No-op rows are included unchanged, so a client can
compare the requested positions with the resulting ones.

### UTC timestamp serialization

The two timestamps are read as **Unix epoch seconds**, never as a driver
datetime value:

```sql
UNIX_TIMESTAMP(l.created_at) AS created_at_epoch,
UNIX_TIMESTAMP(l.updated_at) AS updated_at_epoch
```

The pool is configured with `timezone: '+02:00'`. That option is a
**client-side** instruction: the installed mysql2 decoder uses it to
*interpret* the wall time it receives, so it is **not** a
`SET SESSION time_zone` statement and it does not configure a SQL session
offset. With a UTC SQL session, a TIMESTAMP stored as `2026-10-21 12:00:00` is
decoded by that driver as `2026-10-21T10:00:00.000Z` — a two-hour shift of
every serialized instant.

Projecting the stored instant as epoch seconds removes the driver
interpretation entirely, exactly as the corrected M2-B04 contract does. The
serialized value is therefore the **exact stored instant**, independent of the
SQL session time zone, the driver offset and a daylight-saving transition, and
identical across all four routes because all four read the same projection. The
`*_epoch` aliases never leak into a DTO.

**An unreadable instant is refused, never guessed.** A missing, malformed,
non-positive or unrepresentable epoch fails the request with the route's 500
answer; the write paths materialize the DTO **inside the transaction and before
the commit**, so an unreadable instant rolls the write back instead of
committing a row whose date could only be guessed. No 1970 instant, no "now"
and no `null` date is ever produced.

Physical limits that remain unproven here: the projection assumes the columns
are `TIMESTAMP` (instant semantics), which is what the migration file declares.
The MySQL `TIMESTAMP` range (1970-01-01 00:00:01 UTC .. 2038-01-19 03:14:07 UTC)
bounds the representable epochs; epoch `0` is not representable and is
therefore refused. No live MySQL, no session time-zone setting and no query plan
was exercised in this batch.

## List ordering and the cursor

Rows are ordered by `(display_order, id)` — a total order over the rows a single
request reads, which needs no timestamp or timezone interpretation. The id is
the tie-breaker when two lessons share an order. The list reads one row beyond
the requested page size to learn whether a successor exists and never returns
more than the requested size; there is **no** total count, **no** all-page drain
and **no** offset.

The cursor is the **base64url of `"<display_order>:<lesson_id>"`**. It is
opaque, carries only a **position** — never authority, because the page is still
qualified by the unit, the unit by the course and the course by the selected
tenant — and it is **canonical**: the decoded pair is re-encoded and compared,
so exactly one encoding of a position is accepted. The decoded payload is
range-checked (`0..2147483647`) and shape-checked (a canonical UUID).

The keyset predicate is
`unit_id=? AND (display_order>? OR (display_order=? AND id>?))`, so no page is
unbounded and no offset is used. The first page uses the sentinel order `-1`
(below every stored order) and the empty id.

### The cursor is a position, not a snapshot

`display_order` is **mutable**. The pages of one traversal are therefore **not**
a snapshot of the unit: a lesson moved **after** a page was served can
**reappear** on a later page, and a lesson moved **before** the cursor position
can be **omitted** from the remaining pages. What the list guarantees is a
deterministic order per request over the rows that request reads, bounded pages
(default 25, maximum 100, one `limit+1` read) and a cursor that is only a
position. **No snapshot token, no version column, no ordering freeze and no
cursor policy change is provided or promised here** — those would be new
product semantics.

## Atomic batch ordering (`POST /reorder`)

One connection, one transaction, in this order:

1. `beginTransaction`;
2. verify the **verified owner** of the selected tenant `FOR UPDATE`;
3. resolve the **active** course of the selected tenant `FOR UPDATE`;
4. resolve the **parent unit** of that course `FOR UPDATE`;
5. lock the **selected lesson rows** with ONE bounded statement
   (`WHERE unit_id=? AND id IN (…) ORDER BY id ASC FOR UPDATE`), the **canonical**
   ids bound in **ascending id order** so two batches over the same set cannot
   deadlock by taking the same rows in a different sequence;
6. prove that **every** id belongs to the bound unit: if the locked row count
   differs from the batch size, the answer is the identical **404**
   `Course lesson not found` and the whole batch rolls back — **no update and no
   audit has happened yet**. The locked rows are indexed by their **canonical**
   identity, so the row addressed by an uppercase id is found again under the
   identity the batch was parsed with; a row that cannot be found that way is
   the identical **404**, never a crash;
7. for each **changed** row (in the same deterministic id order) issue one
   bounded `UPDATE course_lessons SET display_order=? WHERE id=? AND unit_id=?`
   and one bounded audit event. The bound id and the audited `resource_id` are
   the **stored** id of the row that changed. A zero-row update is **409** and
   rolls the batch back. A selected row whose position already equals the
   request is a truthful **no-op**: no UPDATE and no audit event for that row;
8. read back exactly the selected rows in the resulting `(display_order, id)`
   order, materialize every DTO **before** the commit, and commit once.

A batch of **pure no-ops** writes nothing and therefore commits nothing (it
rolls back after the read-back) while still returning the truthful current
DTOs. Positions may tie: no mass renumbering, no normalisation and no ordering
policy is claimed, and no other resource's order or status is touched. Every
batch operation is bounded by the payload cap of 100: one lock read, at most 100
updates, at most 100 audit inserts and one read-back — there is no unbounded
hierarchy load and no N+1 read per selected row.

## Status and behaviour (read from the actual source)

| Status | Result | Source |
|---|---|---|
| Verified owner, active tenant, live user, active own course, unit of that course | 200 (list/reorder) / 201 (create) / 200 (update) | handler |
| Update whose values equal the current ones | 200 with the current DTO, **no** `UPDATE` and **no** audit event (truthful no-op) | handler |
| Reorder row whose position equals the request | no `UPDATE` and **no** audit event for that row; the batch still returns the truthful DTOs | handler |
| Reorder batch of pure no-ops | 200 with the current DTOs, **no** update, **no** audit, **no** commit | handler |
| Invalid body / unknown key / empty update / invalid status / invalid title / invalid order / invalid description / non-object body | 400 `Invalid course lesson payload` / `Invalid course lesson update payload` | handler |
| Invalid reorder payload (shape, keys, duplicate id, 0 or 101 items, non-integer position) | 400 `Invalid course lesson reorder payload` | handler |
| Reorder batch that names one id twice in two spellings (upper/lower/mixed case) | 400 `Invalid course lesson reorder payload` **before a connection is taken** — the case variants of one uuid are ONE identity under the declared collation | handler |
| Malformed `:courseId` / `:unitId` / `:lessonId` | 400 `Invalid course id` / `Invalid course unit id` / `Invalid course lesson id` | handler |
| `limit` outside `1..100` or not an integer | 400 `Invalid course lesson list limit` | handler |
| Malformed / oversized / non-canonical cursor | 400 `Invalid course lesson list cursor` | handler |
| Client-supplied tenant selector (body, query or header) | 400 `Tenant context must not be supplied by the client` (upstream boundary answer) | `tenant-authority-boundary.ts` |
| Billing-only instructor | 403 `BILLING_ONLY` **before any database access** | local lesson guard |
| Membership instructor, or an `owner` role label without the real `owner_user_id`, or the owner of another tenant selecting this tenant | 403 `Forbidden`; no lesson row is read or written | handler |
| Tenant not active | 403 `Forbidden` | handler |
| Revoked / inactive caller identity | 401, unchanged upstream behaviour | `auth.ts` |
| No selected tenant scope (no membership, or an ambiguous scope without a selection) | 404 `Tenant membership not found`, before any connection | handler |
| Global admin (no tenant scope) | 404 `Tenant membership not found` | handler |
| Student with a selected workspace | 403 `Forbidden` | handler |
| Course absent, foreign, tenant-less or inactive | 404 `Course not found` — identical for all four | handler |
| Unit absent, foreign, or belonging to another course | 404 `Course unit not found` — identical for all | handler |
| Lesson id absent, foreign, of another unit, or one foreign/missing id in a reorder batch | 404 `Course lesson not found` — identical for all; a mixed batch writes and audits **nothing** | handler |
| `UPDATE` affecting zero rows (concurrent modification) | 409 `Course lesson was modified concurrently`, nothing audited | handler |
| Failed connection acquisition | 500 with the route's message; no cleanup for a connection that does not exist | handler |
| Failed `beginTransaction` | 500; the unconfirmed connection is **discarded**, never pooled | handler |
| Failed owner verification, course/unit/lesson lookup, list read, insert, update, audit, batch lock, batch read-back or DTO materialization | 500; rollback, then release once | handler |
| Unreadable epoch projection (missing, malformed, non-positive or unrepresentable instant) | 500; rollback then release once; **no** commit on any write path — the DTOs are materialized before the commit | handler |
| Failed rollback | the truthful answer is unchanged, and the connection is **destroyed**, never released | handler |
| Lost `commit` acknowledgement | 500; **no** rollback is claimed, no silent retry, and the connection is **destroyed** | handler |
| Invalid, missing, expired or revoked token | 401, unchanged upstream behaviour | `auth.ts` |
| Administratively suspended instructor account | 403 `TENANT_SUSPENDED`, unchanged upstream behaviour | `auth.ts` |

`Cache-Control: no-store` is set on **every** outcome the lesson handlers
produce — 200, 201, 400, 403, 404, 409 and both 500 paths — before the first
`await` and before any denial. Upstream `auth`/boundary answers (401/403/400)
are unchanged and do not carry it; that is pre-existing behaviour.

## Atomicity, audit and uncertainty

- The authorization, the parent scope proof, every write and every audit event
  of one request share **one connection and one transaction**.
- Create audits `course.lesson_created`; update audits `course.lesson_updated`;
  each changed reorder row audits `course.lesson_reordered`. In every case
  `resource_type='course_lesson'`, `resource_id=<lesson id>`, the actor is
  `actor_user_id`, the tenant is the **derived** selected tenant, and the
  audited payload is a **fixed, bounded key set**: `course_id`, `unit_id`,
  `lesson_id` plus the lesson metadata (`title`, `description`,
  `display_order`, `status` for create/update; the old/new `display_order` for
  a reorder). No secret, contact, billing, content, asset or student data is
  written.
- A failed audit rolls the write back and no success is reported. Success is
  reported only after `commit()` resolves.
- **A lost commit acknowledgement is an uncertain persistence state:** no
  rollback is claimed, no success is fabricated, no automatic retry is
  attempted, and the connection is destroyed instead of returning to the shared
  pool. There is **no** idempotency-key system in this slice and none is
  claimed.
- **Connection ownership is explicit:** a failed acquisition performs no
  cleanup; a failed `beginTransaction` destroys the unconfirmed connection;
  after the transaction started, a successful rollback (including on a denial, a
  no-op and a 409) or a successful commit releases exactly once; a failed
  rollback or a failed/ambiguous commit destroys exactly once and never
  releases. There is no rollback or commit retry.

## Schema file (NOT applied)

`server/migrations/20261021_01_course_lessons.sql` creates exactly one table:

```
course_lessons(id CHAR(36) PK, unit_id CHAR(36) NOT NULL, title VARCHAR(255) NOT NULL,
               description TEXT NULL, display_order INT NOT NULL DEFAULT 0,
               status ENUM('active','archived') NOT NULL DEFAULT 'active',
               created_at TIMESTAMP, updated_at TIMESTAMP,
               FK (unit_id) REFERENCES course_units(id), CHECK (display_order >= 0),
               INDEX idx_course_lessons_page (unit_id,display_order,id))
```

- The file is **additive only**: no `ALTER`, `DROP`, `TRUNCATE`, `DELETE`,
  `INSERT` or `UPDATE` statement, no backfill, no change to `courses` or
  `course_units`.
- The **course** and the **tenant** are **derived** through the parent unit and
  its course; there is deliberately **no** `course_id` and no `tenant_id`
  column, so an independent relation can never disagree with the parent chain.
- The foreign key to `course_units(id)` has **no** `ON DELETE` clause: deleting
  a unit that still owns lessons is refused by the database rather than
  silently orphaning or cascading the lessons. The product decision on unit
  deletion is out of this slice.
- The collation/engine (`InnoDB`, `utf8mb4`/`utf8mb4_unicode_ci`, `CHAR(36)` id)
  match the declared M2-B04 parent. The file was **not applied**: no database
  was connected and no statement was executed. Static SQL inspection is not
  migration execution and is not database constraint validation.

## Evidence (actually executed)

All commands were run from `server/` with the repository-local binaries (no
`npx` fetch, no install).

- `./node_modules/.bin/tsx --test tests/m2-course-lessons.test.ts` — **48 tests,
  48 passing, 0 failing**.
- `./node_modules/.bin/tsx --test tests/m2-course-lessons-reorder.test.ts` —
  **33 tests, 33 passing, 0 failing** (26 of the original batch + **7** UUID
  identity regressions added by the correction below).
- `./node_modules/.bin/tsx --test tests/m2-course-lessons.test.ts tests/m2-course-lessons-reorder.test.ts`
  — **81 tests, 81 passing, 0 failing**.
- `./node_modules/.bin/tsx --test tests/m2-tenant-profile.test.ts tests/m2-tenant-profile-update.test.ts tests/m2-tenant-branches.test.ts tests/m2-course-units.test.ts`
  — **164 tests, 164 passing, 0 failing** (the accepted M2-B01/M2-B02/M2-B03/
  M2-B04 suites, unchanged, still pass with the new mount in place).
- `./node_modules/.bin/tsc --noEmit -p tsconfig.json` — **exit 0, 0
  diagnostics**.
- `./node_modules/.bin/tsx --test C:/Users/BaraaWael/TabwebClientSupervisor/182-m2-b05-uuid-probes.test.ts`
  — the independent public probe of the correction, run unmodified from
  `server/`: **3 tests, 3 passing, 0 failing** (uppercase uuid → 200 with the
  canonical DTO, case-variant duplicate → 400 before the connection, lowercase
  control → 200 with exactly one safe release). It was 1/3 before this
  correction.

### UUID identity correction (supervisor finding 182)

The B05 batch was **not accepted** after the independent review: an uppercase
lesson uuid matched the lowercase stored row in SQL (the declared
`utf8mb4_unicode_ci` collation) but was not found again by the JavaScript
locked-row map, so the request answered **500**; and two spellings of one id
evaded the uniqueness check, reached the locks and answered **404** from the
row-count mismatch instead of the **400** a duplicate batch owes. The
correction keeps the seven paths of this batch and changes only the id
identity:

- `server/src/routes/course-lessons.ts` — one canonical identity (the
  lowercase form of a valid uuid) for the uniqueness check, the lock order,
  the SQL binds and the locked-row lookup; the case-variant duplicate is
  refused **400 before a connection is taken**; the write and the audit event
  name the **stored** id; a row that cannot be found under its canonical
  identity is the identical **404**, never a crash. The authorization, the
  parent scope proof, the transaction, the audit, the epoch projection, the
  release/destroy lifecycle and every other route are unchanged.
- `server/tests/helpers/m2-course-lessons-harness.ts` — the fixture now
  emulates the **declared** collation of the `CHAR(36)` id columns instead of
  a byte-exact comparison, so `id IN (…)`, the unit qualification and the
  keyset tie-break answer the way the declared schema answers. This is a
  comparison rule of the fixture, not a claim that a real MySQL was exercised.
- `server/tests/m2-course-lessons-reorder.test.ts` — seven regressions: the
  fixture's own case-insensitive comparison, an uppercase uuid addressing the
  stored row, the four case-variant duplicate shapes refused before any
  connection, a mixed-case selection writing and auditing every row once with
  the canonical bind order, a mixed-case batch containing a foreign id keeping
  the identical 404 with no write, an unknown uuid keeping the identical 404,
  and a stored id that is not lowercase being answered with the stored
  identity.
- `docs/streams/server/M2-B05-CONTRACT.md` — this section.

`server/src/routes/tenant-self.ts` (the additive mount) and
`server/migrations/20261021_01_course_lessons.sql` (the schema FILE) were
**not** changed by the correction: the mount is still additive only and the
migration was still not applied.

Behaviour covered by the new suites:

- **Composition and isolation.** The lesson module is loaded **alone and first**
  and its interception log is asserted **empty**, which proves it pulls in no
  database, provider, renewal or environment module by itself. The
  `src/db`, `src/services/minio`, `src/services/subscription-renewal` and
  `dotenv` module bodies are intercepted in the CommonJS loader before any app
  module loads, never enter `require.cache`, need no dummy env, and the
  sentinel counter is re-asserted empty in `after`. The real production chain
  (optional auth → tenant-authority boundary → student-workspace boundary →
  real tenant-self router with the real lesson router under `/catalog`) is
  driven without a listener, socket, fetch, DB, provider or app startup.
- **List.** Explicit eight-field DTO; the serialized instant is the **stored**
  instant and not the driver-decoded value (the fixture hands back the raw
  datetime columns decoded with the installed driver's `timezone: '+02:00'`
  interpretation — two hours earlier — next to the epoch projection); the same
  epoch across the 2026-03-29 DST start stays exactly one hour apart; a
  missing/`null`/zero/`NaN`/non-numeric/absent epoch fails the page and never
  answers a 1970 instant, a current time or a `null` date; the default page is
  25 and the maximum 100 with one `limit+1` read; rejected `limit` and cursor
  values (malformed, oversized, non-canonical, out-of-range, padded) with **no
  connection**; the opaque cursor resumes strictly after the last returned row
  with the `(display_order, id)` tie-break; a cursor is a position only (a
  cursor minted for another unit stays a position); an archived unit is still
  readable; a lesson of another unit or another tenant is never listed.
- **Create.** Server-generated id, trimmed title, `display_order` default 0,
  `description` default `null`, status always `active`, one bounded audit event
  with the exact payload, the exact call order
  `begin → owner → course → unit → insert → audit → read-back → commit → release`,
  the exact SQL text and bound parameters; duplicate titles allowed; the
  255/256 title and 10000/10001 description boundaries; the `0/1/2147483647`
  order bounds and the rejection of `-1`, `2147483648`, `1.5`, `'3'`, `true`,
  `null`, `NaN`; strict payload rejection of unknown, selector, asset, content,
  publication, assignment, progression and paid keys; an explicit `null`
  description stored as `null`; an unreadable epoch projection failing the
  create with **no** commit and no surviving row.
- **Update.** Retitle, describe, reorder, archive and reactivate; an omitted
  description preserved and an explicit `null` clearing it; the audit
  old/new payload; the truthful no-op (no `UPDATE`, no audit, no commit,
  current DTO, rollback + release); strict payload rejection; a malformed
  lesson id refused before any connection; a lesson of another unit or another
  tenant and an absent lesson producing the identical 404 with no write; a
  zero-row update as 409 with nothing audited; an unreadable epoch projection
  failing the update with no commit and the row restored.
- **Reorder.** The exact call order
  `begin → owner → course → unit → batch_lock → (reorder_update → audit)* →
  batch_read → commit → release`; ONE bounded lock read with the ids bound in
  **ascending id order**; the audit payload of a changed row; a no-op row with
  no write and no audit; a mixed no-op/changed batch writing only the changed
  row; a pure no-op batch committing nothing; tied positions allowed with the
  id tie-breaker; exactly 100 items accepted (100 audits) and 101 refused with
  no connection; strict payload rejection (shape, keys, duplicate id, missing
  key, non-uuid, out-of-range/float/string/null position, nested status, 0
  items); a mixed batch containing an absent lesson, a lesson of another unit
  and a lesson of another tenant producing the identical 404 with **zero**
  updates, **zero** audits, **zero** commits and the valid row restored; the
  lock preceding every write and every audit; a failed batch lock; a failure on
  the **second** update and on the **second** audit each restoring every row
  with no committed audit event; an incomplete read-back; a zero-row update as
  409; an unreadable epoch projection; a lost commit acknowledgement; a failed
  rollback destroying the connection; failed acquisition and failed
  `beginTransaction`; exactly one response per outcome. Plus the **UUID
  identity** regressions: an uppercase uuid addressing the stored row under the
  declared collation, the four case-variant duplicate shapes refused **400
  before any connection**, the canonical bind order of a mixed-case selection,
  the identical 404 of a mixed-case batch with a foreign id and of an unknown
  uuid, and a stored id that is not lowercase answered with the **stored**
  identity in the DTO and in the audit event.
- **Authority.** The billing-only denial on **all four** routes with zero
  database access; membership instructor and `owner` role label refused 403
  with no row read; the owner of another tenant selecting this tenant refused
  403; an inactive tenant refused 403; a revoked caller 401 before any
  connection; student 403; unscoped admin and no-scope 404 before any
  connection; an ambiguous multi-tenant scope 404; a client tenant selector
  refused 400 by the boundary on list/create/update/reorder; malformed course/
  unit/lesson ids 400 before any connection; the identical foreign/inactive/
  tenant-less/absent course 404; the identical foreign/other-course/absent unit
  404 on list and create; an empty path segment never reaching a handler.
- **Lifecycle.** Failed acquisition with no cleanup; failed
  `beginTransaction` destroying the unconfirmed connection; failed owner/
  course/unit/list/insert/audit/read-back/lesson-lookup with exactly one
  rollback and one release; failed rollback destroying and never releasing;
  lost commit acknowledgement destroying with no rollback claim.
- **Migration FILE.** Inspected read-only: the table shape, the foreign key to
  `course_units`, the `(unit_id,display_order,id)` index, the enum, the
  nonnegative check, the InnoDB/utf8mb4 parent match, the absence of a
  `tenant_id`/`course_id` column and the absence of every destructive statement.

## Coverage limits (explicit)

- No real MySQL, no real HTTP, no provider, no Docker, no migration execution.
  Real row locking, real concurrency/deadlock behaviour, real keyset index
  usage, the real `ENUM`/foreign-key/`CHECK` constraints and the real
  transaction isolation are **not** exercised: the injected fixture replays the
  transaction (a snapshot on `beginTransaction` restored on `rollback`), so the
  atomicity assertions prove the **decision boundary** (the call sequence and
  the restored state) and not the physical InnoDB effect.
- The migration file was **not applied**; the schema shape and deployment
  compatibility must be reviewed before any application.
- The epoch projection is exercised through an injected fixture, not against a
  live MySQL: no real `UNIX_TIMESTAMP` evaluation, no real session time zone
  and no real query plan were run. The pool's `timezone: '+02:00'` is a driver
  setting; this batch neither read nor changed the shared `server/src/db.ts`
  configuration and issued no pooled `SET SESSION time_zone`.
- The billing-only denial is proven at the handler boundary with the real
  authentication middleware and an injected principal repository; the shared
  middleware itself is not modified or re-designed.
- The `limit`/`cursor` query contract is proven at the handler boundary; the
  upstream query parser is not re-implemented.
- The legacy `auth-boundary` and `m1-expanded-tenant-admin` suites were **not**
  re-run: they are outside the handoff's named scope.
- The declared `utf8mb4_unicode_ci` comparison of the `CHAR(36)` id columns is
  **emulated by the fixture's comparison rule**, not evaluated by a real
  MySQL: no real collation, no real `id IN (…)` matching and no real
  case-insensitive primary-key uniqueness were exercised. The emulation
  covers the lesson id, the unit qualification and the keyset tie-break.
- No performance, throughput, latency or concurrency claim is made; no
  measurement was taken. The only bounds claimed are the ones visible in the
  source: one page read of `limit+1 ≤ 101` rows, one lock read plus at most 100
  updates, 100 audit inserts and one read-back per reorder batch, one lesson row
  per single write, and exactly one connection acquisition and one
  release-or-destroy per request.
- No self-acceptance is claimed.

## Out of scope

Runtime rollout and migration application, any client UI, lesson
delivery/content/assets/video/materials, uploads/providers, instructor
assignment, student entitlement or enrollment, publication, drip, progression,
pricing/payment, the public catalog and OTP (deferred). M2-B05 does not close
C5 or M2.
