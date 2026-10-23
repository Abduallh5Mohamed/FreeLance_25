# M2-B14 — course publication and anonymous published-course discovery

Task: `client-m2-22-published-course-discovery-20261023-01`
Stream: server (implemented in `server/src/routes/courses.ts`,
`server/src/routes/public-catalog.ts`, `server/src/index.ts`)
Status: implemented and reported by the WorkBuddy worker. **A worker report is
not acceptance.**

## 1. What this surface is

Two separate things, deliberately kept apart:

1. **An explicit publish / unpublish WRITE** on the existing private course
   surface (`PUT /api/courses/:id/publication`), available to the same teaching
   authority that can already edit that course.
2. **An anonymous read-only DISCOVERY surface** (`GET /api/public/courses` and
   `GET /api/public/courses/:courseId`) that lists the published, active courses
   of ACTIVE academies through a fixed ten-field projection.

`publication_state = 'published'` means one thing only: **this course is eligible
to appear in the public catalogue**. It does NOT mean enrolled, granted, paid,
scheduled, delivered, emailed, queued or read.

Explicitly out of scope and NOT implemented here: signup / OTP / registration,
enrollment or access entitlement, lesson or file delivery, payment or billing,
provider / domain / DNS, search indexing or ranking, recommendation, analytics,
M3, migration application, and any live DB / network / browser / service /
deploy activity.

## 2. Migration

`server/migrations/20261023_03_course_publication.sql` — **FILE ONLY, NEVER
APPLIED** by this batch.

Additive: two new columns and one index on the existing `courses` table. No
existing column, index, constraint or row is altered, dropped or backfilled.

| Change | Shape |
| --- | --- |
| `courses.publication_state` | `ENUM('draft','published') NOT NULL DEFAULT 'draft'`, after `is_active` |
| `courses.published_at` | `TIMESTAMP NULL DEFAULT NULL`, after `publication_state` |
| `idx_courses_public_discovery` | `(publication_state, is_active, id)` |

Three non-obvious decisions, all deliberate:

- **There is no `unpublished` value.** "Never published" and "published then
  withdrawn" must be indistinguishable to the public read, so they share the one
  reachable state `draft`. A third value would create a distinction the
  catalogue must not expose and the audit trail does not need.
- **Every existing row becomes `draft`, with NO backfill.** Nothing was published
  before this batch existed, so nothing may appear in the catalogue because of
  it. Publishing is an explicit act by an instructor.
- **`publication_state` is NOT derived from `is_active`.** The accepted
  `DELETE /api/courses/:id` already owns the archive flag. The public read
  requires BOTH `publication_state='published'` AND `is_active=TRUE`, so
  archiving a published course withdraws it from discovery **without rewriting
  its publication record** — and un-archiving it restores exactly the state it
  had. The index leads with `publication_state` because that is the selective
  first predicate of every discovery query.

## 3. The publication write

`PUT /api/courses/:id/publication`

Body: **exactly** `{ "publication_state": "draft" | "published" }`.

| Outcome | Status | Body |
| --- | --- | --- |
| Confirmed transition | 200 | `{ course_id, publication_state, published_at }` |
| Truthful no-op (already in that state) | 200 | the CURRENT stored projection |
| Malformed id (not a UUID) | 404 | `Course not found` |
| No selected tenant / caller | 403 | `Teaching access is not active for the selected tenant` |
| Body is not exactly `{publication_state}` | 400 | `Invalid publication payload` |
| Value is not `draft` / `published` | 400 | `Invalid publication state` |
| Membership is not an active teaching member | 403 | `Teaching access is not active for the selected tenant` |
| Course is foreign, archived or absent | 404 | `Course not found` |
| The row changed under the transaction | 409 | `Course was modified concurrently` |
| Read-back missing after the write | 500 | `Failed to update course publication` |
| Any other failure | 500 | `Failed to update course publication` |

Why each rule exists:

- **The body is strict and closed.** No `tenant_id`, no `instructor_id`, no
  `is_active`, no `published_at`, no price. A caller therefore cannot back-date a
  publication, cannot publish another tenant's course by naming a tenant, and
  cannot smuggle an unrelated course column through this route. The tenant
  boundary middleware rejects a `tenant_id`-shaped key before the router is even
  reached.
- **Authority is revalidated INSIDE the transaction**, on the same connection, by
  a `FOR UPDATE` read of `tenant_memberships ⋈ users ⋈ tenants`. The middleware
  check that ran before the router is not trusted as the final word: a membership
  revoked between the two would otherwise still write.
- **The target is locked with a tenant-scoped `FOR UPDATE` select.** A foreign
  course and an absent course produce the SAME 404 body, so the route cannot be
  used to probe another academy's course ids.
- **A no-op is truthful.** Publishing an already-published course writes nothing,
  audits nothing, and answers with the ORIGINAL `published_at` — so a retried
  publish (a double click, a flaky network) can never re-stamp the instant.
  `published_at` is set with `COALESCE(published_at, CURRENT_TIMESTAMP)` for the
  same reason. Unpublishing sets `published_at = NULL`.
- **Exactly ONE sanitized audit event** is written with the transition:
  `course.published` / `course.unpublished`, `resource_type='course'`,
  `resource_id=<course>`, and `{publication_state}` old → new only. It carries no
  name, description, price, student, lesson, file or contact value, because this
  route changes none of them.
- **`affectedRows !== 1` is a 409, not a silent success.** The row was locked, so
  a zero-row update means it changed in a way this transaction must not paper
  over.
- **An uncertain commit destroys the connection.** If `commit()` was attempted
  and then failed, the connection is destroyed and the response is a 500: the
  write may or may not have persisted, and the route never claims a rollback it
  cannot prove. A failed rollback, a failed `beginTransaction` and a throwing
  `release`/`destroy` follow the same rule; a failed acquisition does no cleanup.
  `release`/`destroy` runs exactly once, in `finally`.
- **`Cache-Control: no-store` is set first**, before any validation, so no
  intermediate cache can hold a private publication record.
- **`published_at` is projected as an EPOCH** (`UNIX_TIMESTAMP`) and converted to
  a UTC ISO string. The mysql2 pool is configured `timezone: '+02:00'`, so
  projecting the raw TIMESTAMP would shift every instant the client renders.

## 4. The discovery read

Mounted at `/api/public`, inside the same `/api` boundary as every other route,
so `optionalAuth`, the tenant authority boundary and the student workspace
boundary all still run. The router itself consults **no principal at all**: it
never reads `req.user`, so an authenticated caller and an anonymous one receive a
byte-identical body.

### `GET /api/public/courses?limit&cursor&q`

| Outcome | Status | Body |
| --- | --- | --- |
| A bounded page | 200 | `{ courses: [...], next_cursor: string \| null }` |
| `limit` is not an integer in 1..60 | 400 | `Invalid public course list limit` |
| `cursor` is not a decodable position | 400 | `Invalid public course list cursor` |
| `q` is not a string of 1..100 trimmed characters | 400 | `Invalid public course search term` |
| Any other failure | 500 | `Failed to load public courses` |

- `limit` defaults to **24** and is capped at **60**. The route reads
  `limit + 1` rows to decide whether a next page exists, and mints the cursor
  from the LAST VISIBLE row — never from the look-ahead row.
- The cursor is opaque base64url over the last course id, re-validated against
  the UUID pattern and bounded to 64 characters on the way in. It encodes a
  **position**, never authority: a caller cannot widen the result set by forging
  one, only move within it.
- `q` is trimmed. A blank or whitespace-only term is the SAME as no term — the
  unfiltered page — because "search for nothing" is not a different query. An
  over-long term is a 400 rather than a silently truncated search.
- The search covers **`name` and `subject` only**, never `description`: private
  wording in a description must not be probeable through the public surface.
- LIKE metacharacters are escaped with `!` (`ESCAPE '!'`), so searching for
  `100%` or `a_b` matches those literal characters instead of becoming a
  wildcard that widens the scan.
- Ordering is by `id`, so the keyset cursor is stable and a page can never
  repeat or skip a row while rows are added.

### `GET /api/public/courses/:courseId`

| Outcome | Status | Body |
| --- | --- | --- |
| A published, active course of an active academy | 200 | `{ course: {...} }` |
| Malformed id | 404 | `Course not found` |
| Unpublished / archived / suspended academy / foreign / absent | 404 | `Course not found` |
| Any other failure | 500 | `Failed to load public course` |

Unpublished, foreign and absent are **one** answer with **one** body. The route
cannot be used to learn whether a course id exists, whether it belongs to another
academy, or whether it was ever published. A malformed id is the same 404,
returned before any read.

### The visible set

```sql
FROM courses c
JOIN tenants t ON t.id = c.tenant_id AND t.status = 'active'
LEFT JOIN tenant_branding b ON b.tenant_id = t.id
WHERE c.publication_state = 'published' AND c.is_active = TRUE
```

A course is discoverable only when ALL of these hold: it is published, it is
active, it belongs to a tenant, and that tenant is `active`. A `pending`,
`suspended` or `archived` academy contributes nothing. A course with
`tenant_id IS NULL` (legacy rows) is not discoverable, because it has no academy
to attribute it to.

### The fixed TEN-field projection

```json
{
  "course_id": "…",
  "name": "…",
  "subject": "…|null",
  "description": "…|null",
  "grade": "…|null",
  "tenant_id": "…",
  "business_name": "…",
  "display_name_ar": "…|null",
  "display_name_en": "…|null",
  "accent_color": "#RRGGBB|null"
}
```

The projection is assembled **column by column, never as a row spread**, so a
column added later cannot leak by accident. Specifically:

- `description` is bounded **in the SQL** (`SUBSTRING(c.description, 1, 600)`), so
  an oversized body is never shipped to an anonymous caller.
- `c.tenant_id` is deliberately **not** selected as a raw column; the tenant id
  comes from `t.id`, which is non-null only because the `JOIN` matched. An
  unresolvable tenant therefore cannot contribute an id.
- `accent_color` is re-checked against the accepted canonical form
  `^#[0-9A-F]{6}$`; anything else is reported as `null` ("inherit") rather than
  handed to a page that would render it verbatim.
- Absent: price, instructor, instructor id, lesson, unit, material, file,
  student, enrollment, payment, contact detail, owner, subscription,
  `is_active`, `publication_state`, `published_at`, `thumbnail_url`, and every
  counter. Nothing about the commercial or delivery side of a course is
  discoverable here.

`Cache-Control: no-store` is set first on both routes.

## 5. Files

| Path | Change |
| --- | --- |
| `server/migrations/20261023_03_course_publication.sql` | NEW — schema file only |
| `server/src/routes/courses.ts` | ADDITIVE — one `PUT /:id/publication` route and its constants/parsers. The five legacy handlers are untouched |
| `server/src/routes/public-catalog.ts` | NEW — the anonymous read-only router |
| `server/src/index.ts` | ONE mount: `app.use('/api/public', publicCatalogRoutes)` |
| `server/tests/m2-course-publication.test.ts` | NEW — hermetic publication suite |
| `server/tests/m2-public-course-discovery.test.ts` | NEW — hermetic discovery suite |

## 6. Verification

Hermetic only: no DB, no network, no browser, no service, no provider, no
dotenv, no migration application.

- `server/tests/m2-course-publication.test.ts` — **30/30**. Pins the exact
  publish/unpublish statement sequence, the preserved instant on a no-op, a
  republish stamping a new instant, 15 malformed payloads, the malformed
  selector, 401/403 denials, a membership-lock denial, foreign/archived/absent →
  one 404, a cross-tenant instructor → 404, owner allowed, `affectedRows 0` →
  409, and the full failure/disposal matrix (failed update / audit / read-back,
  empty read-back, uncertain commit, failed rollback, failed begin, failed
  acquire, throwing release/destroy, single-disposal sweep, `no-store` sweep).
- `server/tests/m2-public-course-discovery.test.ts` — **23/23**. Pins anonymity
  (each route has exactly one layer — the handler — with no auth middleware), the
  visible set, the exact ten-field projection, a structural no-private-leak
  check, branding inheritance, the accent downgrade, the default page and its
  cursor, page 2 continuing without duplicates, malformed limit/cursor → 400
  before any read, the search bounds and LIKE escaping, an authenticated caller
  receiving a byte-identical body, opaque 500s, `no-store` on every outcome, and
  the three 404 cases collapsing to one answer.

## 7. Limits

- The migration is a **file only**. Until it is applied, `publication_state` and
  `published_at` do not exist and every publication route answers a 500. The
  client reports an unknown publication state rather than guessing `draft`, and
  the discovery page reports the server's own message.
- Discovery is a **catalogue**, not a funnel. There is no detail page for a
  lesson, no price, no call to action that grants anything, and no analytics.
- The public read is deliberately **not** cached. A CDN or HTTP cache in front of
  it would have to be added with its own invalidation contract, which this batch
  does not define.
