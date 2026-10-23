# M2-B07 — private academic-period planning catalog

Task: `client-m2-13-private-academic-periods-20261021-01`
Worker: `workbuddy-native-m2-13-periods-20261021`
Handoff: `docs/streams/client/M2-13-HANDOFF.md`
Supervisor: `supervisor/203-next-larger-academic-period-planning-batch.md`
Correction: `client-m2-13-canonical-name-correction-20261021-01`
(`supervisor/207-m2-13-canonical-name-correction.md`) — canonical stored name.

Status: **IMPLEMENTED, TESTED, REPORTED — NOT ACCEPTED.** Acceptance is a
separate, independent Codex review.

---

## 1. Goal and before/after

Before: the inspected routes, migrations and API surfaces had no private
academic-period planning catalog. There was no way for an institution owner to
record the terms/months structure that backlog item C8 requires, and nothing to
build on.

After: the VERIFIED owner of the server-selected tenant can list, create, edit
and reversibly archive academic periods — a label plus two date-only bounds —
through `GET|POST /api/tenants/me/academic-periods` and
`PATCH /api/tenants/me/academic-periods/:id`, and manage them in an Arabic/RTL
card on the existing instructor dashboard.

This is a FOUNDATION. It completes nothing:

* no enrollment, registration, roster, group, grade, course or lesson is
  attached to a period;
* no student access window, visibility rule, capacity or publication exists;
* no invoice, price, fee, discount, payment or subscription effect exists;
* no automatic date or status transition exists — nothing reads the clock to
  expire, open, close or archive a period;
* no uniqueness or overlap policy exists: duplicated names and overlapping
  ranges are PERMITTED;
* C8, M2 and C2 are NOT complete.

## 2. Surface

Mounted by `server/src/routes/tenant-self.ts` (additive, one import + one
`router.use`) under `/academic-periods`, after the authentication middleware, so
every route is authenticated and the billing-only exemption of the
`/api/tenants/me` prefix is enforced locally inside the module.

| Method | Path | Success | Body |
| --- | --- | --- | --- |
| `GET` | `/api/tenants/me/academic-periods` | `200` | `{ periods: DTO[], pagination: { limit, offset, has_more } }` |
| `POST` | `/api/tenants/me/academic-periods` | `201` | `{ period: DTO }` |
| `PATCH` | `/api/tenants/me/academic-periods/:id` | `200` | `{ period: DTO }` |

The DTO is EXACTLY seven fields:

```
{ id, name, starts_on, ends_on, is_archived, created_at, updated_at }
```

`tenant_id`, `created_at`-adjacent owner/contact/billing columns and every
enrollment/price/access column stay server-side. The row is never spread.

## 3. Authority

* The tenant is the SERVER-selected scope on the authenticated principal
  (`req.user.tenantId`), never a client value. A body, query or header
  `tenant_id` is rejected by the existing `tenant-authority-boundary` with `400`
  before this module runs.
* The caller must be the tenant's REAL owner: `tenants.owner_user_id` = caller,
  `tenants.status = 'active'` and the caller's own `users.is_active = 1`, read on
  the same connection and inside the same transaction as the work.
* A membership role label (`owner` / `instructor`), a global `admin` and a
  `student` are NOT authority. A membership instructor, a role-label owner, an
  admin without a membership and a principal with no active membership are all
  refused.
* `billingOnly` is refused with `403 { code: 'BILLING_ONLY' }` BEFORE any
  connection is acquired and before any statement is issued.
* The owner is verified BEFORE any period row is read, so a non-owner learns
  nothing about whether a period exists.
* `Cache-Control: no-store` is set before the first `await` and before any
  denial, so every outcome this module produces carries it.

## 4. List contract

Query parameters — only these three; an unknown key is `400`, not ignored:

| Name | Type | Default | Bound |
| --- | --- | --- | --- |
| `limit` | decimal integer | `25` | `1..100` |
| `offset` | decimal integer | `0` | `0..10000` |
| `archived` | `true` \| `false` | `false` | — |

A non-string (array) value, a sign, a decimal point, an exponent, an empty
string or a value outside the bound is `400`.

Ordering is `starts_on ASC, id ASC` — a total order over the rows the request
reads, needing no timestamp or timezone interpretation. The query reads
`LIMIT ?+1 OFFSET ?` so exactly one extra row decides `has_more`; only `limit`
rows are ever returned. There is no total-count query, no unbounded history read
and no cross-tenant read.

`offset` paging is a POSITION, not a snapshot: `name`, `starts_on` and
`is_archived` are mutable, so a period created, moved or archived between two
page reads can shift the remaining pages. Each single page is internally
consistent for the rows it reads, but there is NO cross-request snapshot and no
stable-once guarantee. No snapshot token or ordering freeze is provided.

## 5. Create contract

Body: exactly `{ name, starts_on, ends_on }`. All three are required and any
other key is `400` before a connection is taken.

* `name` — a string that trims to 1..255 characters. Unicode is permitted and no
  script or locale is guessed. An empty, whitespace-only, non-string, array,
  number or boolean value is refused, never coerced. The REQUEST name is
  trimmed before it is stored, so what is stored is ALREADY canonical; the
  read-back is compared with that trimmed value (§7).
* `starts_on` / `ends_on` — canonical `YYYY-MM-DD`, a REAL calendar date in the
  SQL `DATE` range (years 1000..9999). The shape alone is not enough:
  `2026-02-30`, `2026-04-31`, `2026-13-01`, `2026-00-10` and `2027-02-29` are
  refused rather than normalized by `Date`. `starts_on <= ends_on` is required
  (canonical strings compare correctly as strings).
* The id is server-generated (`randomUUID`) and the client can never supply one.
* Duplicated names and overlapping ranges are accepted: no uniqueness or overlap
  policy has been approved, so nothing checks another row.

Success is `201 { period }`, reported only after `commit()` resolves.

## 6. Update and archive contract

Path `:id` must be a UUID (`400` otherwise) and is compared in lowercase, so the
case variants of one uuid address the same canonical row.

Body: a NONEMPTY subset of `{ name, starts_on, ends_on, is_archived }`. An empty
object, an unknown key, a non-string name, a non-canonical date and a
non-boolean `is_archived` are `400` before a connection is taken.

The DATE RANGE is validated on the MERGED result: a request that changes only
`starts_on` is checked against the STORED `ends_on`, so a partial update can
never store a range whose start is after its end. That rejection is a `400`
inside the transaction: it rolls back and releases exactly once, writing nothing.

`is_archived` is a REVERSIBLE PLANNING VISIBILITY FLAG. Setting it `true` hides
the period from the default view; `false` restores it. It is not a cancellation,
not a status machine and not an enrollment/access/billing effect, and nothing
transitions it automatically. There is no hard delete in this API.

A period of ANOTHER tenant, or an absent one, is the identical `404`: the row is
resolved `WHERE id=? AND tenant_id=?`, so the tenant boundary is part of the
lookup and not a post-hoc check.

No-op: when the requested EFFECTIVE values equal the stored values, nothing is
written, nothing is audited and nothing is committed; the truthful canonical DTO
of the current state is returned.

## 7. Dates are DATE-ONLY

`starts_on` / `ends_on` are `DATE` columns, i.e. CALENDAR DATES without a time
and without a time zone. They are read with
`DATE_FORMAT(col,'%Y-%m-%d')`, so the serialized value is the stored calendar
date itself.

Selecting the raw column would hand the value to the installed mysql2 driver,
which — with the pool's `timezone: '+02:00'` — INTERPRETS the received midnight
as `+02:00` and would answer `22:00Z` of the PREVIOUS day. A planning label must
not shift by a day, so the projection avoids the driver entirely and the handler
re-validates the stored date on every read.

`created_at` / `updated_at` ARE instants. They are projected with
`UNIX_TIMESTAMP(col)` and rendered as canonical UTC ISO-8601, so the serialized
instant does not depend on the session time zone, the driver offset or a
daylight-saving transition. A missing, malformed, non-positive or
unrepresentable epoch is REFUSED (a `500`), never replaced by a 1970 instant,
"now" or `null`.

## 7a. The stored name is canonical or the row is refused

The STORED `name` follows the same rule as the dates: it must ALREADY be
canonical, i.e. exactly its own trimmed form. A stored name that carries
surrounding whitespace — `"  October  "` — is REFUSED by the read projection.
It is never emitted raw and never normalized into a confirmed DTO, because the
trimmed value would be a name this server never stored and cannot vouch for.

Every write path of this module canonicalizes the name before storing it (§5,
§6), so a non-canonical stored row can only come from outside this module.

The consequence is exactly the one of an unreadable instant or date: the row
yields NO DTO, the request fails with `500`, and no partial page is served.
A non-canonical stored row is therefore NOT repairable through this API — a
`PATCH` reads the current row through the same projection and is refused for
the same reason, because the merged effective values must be read from a row
this module can describe truthfully. This module never guesses a stored value
and never repairs one by writing a normalized name over it.

## 8. Transaction, audit and disposal

One connection per handler. One transaction: owner check → (lock) → read/write →
one bounded audit event → read-back → DTO materialization → ONE commit.

* The DTO is materialized BEFORE the commit, so an unreadable stored instant,
  date or non-canonical name fails the write instead of committing a row that
  could only be described by guessing.
* Writes take the owner row `FOR UPDATE` (authorization/serialization evidence)
  and the period row `FOR UPDATE` (per-row serialization). Reads take no
  exclusive lock.
* Exactly ONE audit event per EFFECTIVE write:
  `tenant.academic_period_created` / `tenant.academic_period_updated` on
  `academic_period` with the real actor, tenant and resource id, and the period
  fields only as `old_value`/`new_value`. A no-op writes no audit event.
* Disposal: acquisition failure cleans up nothing; a failed `beginTransaction`
  DESTROYS; a denial / no-op / not-found / payload rejection rolls back and
  releases exactly once; a success commits and releases exactly once; a failed
  rollback DESTROYS; a LOST COMMIT ACK destroys, claims no rollback, reports no
  success and does not retry.
* The read-back is compared with the requested effective values. A mismatch is
  an internal consistency failure (`500`), never a success and never an invented
  conflict policy.
* A missing table (`ER_NO_SUCH_TABLE`) is a `500` on every verb. An empty
  catalog is NEVER fabricated to disguise a broken deployment.

This batch makes NO lost-update-prevention, version, idempotency or CAS promise
and deliberately returns NO `409`: the only serialization is the row lock taken
inside the handler's own transaction.

## 9. Schema FILE (never applied)

`server/migrations/20261021_03_academic_periods.sql` is a FILE. This batch
connected to no database, executed no statement, ran no seed or backfill, and the
application contains no runtime DDL.

* `academic_periods`: `id CHAR(36)` primary key, `tenant_id CHAR(36)` FK →
  `tenants(id)` with matching engine/collation and NO `ON DELETE`,
  `name VARCHAR(255)`, `starts_on DATE`, `ends_on DATE`,
  `is_archived TINYINT(1) DEFAULT 0`, `created_at`/`updated_at` `TIMESTAMP`.
* `KEY idx_academic_periods_tenant_catalog (tenant_id, is_archived, starts_on, id)`
  is the ONE access path of the bounded list.
* `CHECK` constraints bound the name length, the date floor, the range order and
  the boolean domain.
* No uniqueness on `name`, no overlap constraint, no enrollment/price/access
  column, no version column, no hard-delete path.

A real deployment that has not applied this FILE answers a truthful `500`, and
the client shows that failure rather than an empty catalog.

## 10. Verification performed

| Command | Result |
| --- | --- |
| `cd server && npx tsx --test tests/m2-academic-periods.test.ts` | 95 pass / 0 fail (91 + 4 canonical-name regressions) |
| `cd server && npx tsx --test tests/m2-academic-periods-failures.test.ts` | 32 pass / 0 fail |
| `cd server && npx tsx --test tests/m2-tenant-branding.test.ts tests/m2-tenant-branding-failures.test.ts tests/m2-tenant-profile.test.ts tests/m2-tenant-profile-update.test.ts tests/m2-tenant-branches.test.ts tests/m2-course-units.test.ts tests/m2-course-lessons.test.ts tests/m2-course-lessons-reorder.test.ts` | 324 pass / 0 fail (unchanged) |
| `cd server && npx tsc --noEmit` | 0 diagnostics |
| `npx tsx --test src/tests/m2-academic-periods-ui.test.ts` | 113 pass / 0 fail (104 + 9 canonical-name regressions) |
| `npx tsx --test src/tests/m2-course-management.test.ts src/tests/m2-course-unit-ui.test.ts src/tests/m2-course-lesson-ui.test.ts src/tests/m2-tenant-branches-ui.test.ts src/tests/m2-tenant-profile-ui.test.ts src/tests/m2-tenant-profile-edit.test.ts` | 330 pass / 0 fail (unchanged) |
| `npx tsx --test src/tests/m2-instructor-students.test.ts src/tests/m2-student-csv-preview.test.ts src/tests/m2-student-import-resolution.test.ts` | 173 pass / 0 fail (unchanged) |
| `npx tsx --test src/tests/m2-tenant-branding-ui.test.ts` | 89 pass / 0 fail (unchanged nearby set) |
| `npx tsx --test C:/Users/BaraaWael/TabwebClientSupervisor/207-m2-13-canonical-name-probes.test.ts` | 2 pass / 0 fail (public immutable probe; 1 pass / 1 fail before the correction) |
| `npx tsc --noEmit -p tsconfig.app.json` | 0 scoped diagnostics; 11 pre-existing errors outside scope |

The repository-root `tsconfig.json` has `"files": []` and no `include`, so plain
`npx tsc --noEmit` at the root checks NOTHING. `-p tsconfig.app.json` is the real
frontend check and is what is reported.

## 11. Limits

* No live MySQL: no real row locking, no real concurrency, no real index usage
  and no real server-side abort of a destroyed connection. The fixture models
  the STATEMENTS and the transaction REPLAY, not the server.
* The migration FILE is not applied, so the feature is unavailable in a real
  deployment until a separately authorized gate applies it.
* No CAS/version/lost-update promise and deliberately no `409`.
* No DOM paint, no real RTL layout and no browser: component behaviour is proven
  from the production element tree, not from pixels.
* No performance, scalability or latency claim, and no whole-C8/M2/C2 completion
  claim.
