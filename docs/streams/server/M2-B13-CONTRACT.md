# M2-B13 — private group announcements (audited management lifecycle)

Task: `client-m2-21-private-group-announcements-20261023-01`
Stream: server (implemented in `server/src/routes/groups.ts`)
Status: implemented and reported by the WorkBuddy worker. **A worker report is
not acceptance.**

## 1. What this surface is

An instructor who already owns a group in the server-selected tenant can now
manage a **private, bounded, audited announcement lifecycle** for that group: a
title, a body and an explicit `draft` / `published` / `retracted` state with
server timestamps.

`published` means "part of this group's private management record". It does NOT
mean delivered, scheduled, emailed, queued or read. This batch adds **no
recipient copy, no delivery queue, no outbox, no provider message id and no read
receipt**, and nothing here is visible to a student principal.

Explicitly out of scope and NOT implemented here: student consumption, scheduled
delivery, publish-at / expiry / delivery-window / timezone policy, email / SMS /
push, recipient lists, enrollment, access, role, session, attendance, payment or
billing effect, migration application, and any
network/browser/provider/service/deploy activity.

## 2. Migration

`server/migrations/20261023_02_group_announcements.sql` — **FILE ONLY, NEVER
APPLIED** by this batch.

Additive: one new table, no existing table, column or row is touched.

| Change | Shape |
| --- | --- |
| `group_announcements` | new table, `id CHAR(36)` PK |
| `idx_group_announcements_page` | `(tenant_id, group_id, id)` — the bounded page shape |
| `idx_group_announcements_group` | `(group_id)` |
| `fk_group_announcements_tenant` | `tenant_id` → `tenants(id)` |
| `fk_group_announcements_group` | `group_id` → `groups(id)` **`ON DELETE CASCADE`** |

Columns: `tenant_id CHAR(36) NOT NULL`, `instructor_id CHAR(36) NOT NULL`,
`group_id CHAR(36) NOT NULL`, `title VARCHAR(255) NOT NULL`, `body TEXT NOT
NULL`, `state ENUM('draft','published','retracted') NOT NULL DEFAULT 'draft'`,
`created_at`/`updated_at`/`retracted_at`. Engine, charset and collation match
`groups` and `tenants` (`InnoDB`, `utf8mb4`, `utf8mb4_unicode_ci`).

Two non-obvious decisions, both deliberate:

- **`ON DELETE CASCADE` on `group_id`.** The accepted `DELETE /api/groups/:id`
  hard-deletes a group. Without the cascade this table would make an *already
  accepted* deletion start failing on a foreign-key error, i.e. this batch would
  regress an accepted behavior. The cascade keeps that path working and keeps no
  orphan announcement behind.
- **`instructor_id` is an immutable AUTHOR stamp, not authority.** It records who
  wrote the row and is never read to decide access. It is deliberately **not** a
  foreign key, so a later account change cannot block or cascade an announcement
  write. Authority always comes from the live membership row (section 4).

## 3. Endpoints

All four are mounted on the **existing** `/api/groups` router, appended after the
accepted M2-19 handlers. No existing handler, mount, guard or middleware was
changed.

### `GET /api/groups/:groupId/announcements`

Middleware: `authenticateToken` (a read: any authenticated caller whose
membership resolves the group; no teaching write required).

Query: `limit` (integer 1..100, default 25), `cursor` (opaque, optional).

`200`:

```json
{
  "announcements": [
    {
      "id": "b1111111-1111-4111-8111-111111111111",
      "group_id": "11111111-1111-4111-8111-111111111111",
      "title": "First session",
      "body": "Bring the workbook.",
      "state": "draft",
      "created_at": "2026-10-23 09:15:00",
      "updated_at": "2026-10-23 09:15:00",
      "retracted_at": null
    }
  ],
  "next_cursor": null
}
```

Rows are ordered by `id` ASC (a total, stable order that needs no timestamp or
timezone interpretation) and read with a keyset cursor, so no page is unbounded
and no offset can skip or duplicate a row under concurrent writes. One extra row
is read to learn whether a further page exists; only `limit` rows are ever
returned. The cursor encodes a POSITION only and never carries authority: the
page is still qualified by the group AND the selected tenant, so a cursor minted
elsewhere can never widen the read.

### `POST /api/groups/:groupId/announcements`

Middleware: `requireTeachingWrite('groups')`.

Body — **exactly** `{ "title": string, "body": string, "state"?: "draft" |
"published" }`. `title` is trimmed to 1..255; `body` must be non-blank and at
most 4000 characters and is stored **exactly as sent** (only the emptiness test
trims). `state` defaults to `draft`. Unknown keys, a missing title/body, a
non-string, an over-long value and any state other than the two writable ones are
rejected **before any connection is taken**.

`201`: the created announcement (the eight-field projection).

### `PUT /api/groups/:groupId/announcements/:announcementId`

Middleware: `requireTeachingWrite('groups')`.

Body — the same key set, every key OPTIONAL. An **absent** key KEEPS the stored
value, so `{}` is a truthful no-op rather than a silent rewrite. `state` is only
ever `draft` or `published`: `retracted` is server-only and is reachable solely
through the explicit retract action, so a client can never forge a retraction
timestamp by writing a state.

`200`: the announcement after the confirmed change (or the current stored
projection for a no-op).

### `POST /api/groups/:groupId/announcements/:announcementId/retract`

Middleware: `requireTeachingWrite('groups')`. No body is read.

`200`: the retracted announcement. Retraction is **terminal**: the row keeps its
original `retracted_at` and can never be edited or re-published.

## 4. Authorization

The `groups` table carries no `tenant_id`; tenant scoping is transitive through
`groups.instructor_id` → `tenant_memberships(tenant_id, user_id,
status='active')`. That is why every statement below qualifies by BOTH the group
and the selected tenant.

Re-verified on ONE connection inside ONE transaction for every write, each read
locked `FOR UPDATE` where the write depends on it:

1. **Membership (row lock).** The caller's `tenant_memberships` row for the
   SELECTED tenant is `status='active'`, its `users.is_active` is 1 and the
   tenant `status` is `active`.
2. **Group (row lock).** The target group EXISTS, is `is_active = 1`, belongs to
   the SELECTED tenant through an active membership, and — when the caller's own
   instructor scope is resolved — is owned by the caller.
3. **Announcement (row lock).** The target announcement belongs to THAT group AND
   the SELECTED tenant.

The tenant is always `req.user.tenantId`, resolved by the authentication
middleware from the caller's active memberships. No header, query or body tenant
or instructor selector is accepted anywhere; the shared tenant-authority boundary
refuses a client-supplied tenant context before this router is reached.

The read path resolves the group under the SAME `scopePredicate(scopeId,
tenantId)` the accepted group reads use, so a foreign, inactive or absent group
is one `404`.

## 5. Outcomes

| Situation | Status | Body |
| --- | --- | --- |
| List succeeds | 200 | `{ announcements, next_cursor }` |
| Create succeeds | 201 | the announcement |
| Edit / no-op / publish succeeds | 200 | the announcement |
| Retract / already-retracted no-op | 200 | the announcement |
| Malformed `limit` | 400 | `Invalid announcement list limit` |
| Malformed `cursor` | 400 | `Invalid announcement list cursor` |
| Non-UUID `:groupId` | 404 | `Group not found` |
| Non-UUID `:announcementId` | 404 | `Announcement not found` |
| Unknown key / non-object body | 400 | `Invalid announcement payload` |
| Missing, blank, non-string or over-long title | 400 | `Invalid announcement title` |
| Missing, blank, non-string or over-long body | 400 | `Invalid announcement body` |
| State other than `draft`/`published` | 400 | `Invalid announcement state` |
| Teaching entitlement not active | 403 | `Teaching access is not active for the selected tenant` |
| No resolved tenant / no workspace | 404 | `Tenant membership not found` |
| Group absent, foreign, archived or another instructor's | 404 | `Group not found` |
| Announcement absent, foreign or of another group | 404 | `Announcement not found` |
| Edit of a retracted announcement | 409 | `Announcement is retracted` |
| `affectedRows !== 1` on update/retract | 409 | `Announcement was modified concurrently` |
| Any internal failure | 500 | `Failed to list announcements` / `Failed to save announcement` |

**A foreign target and an absent target are the same 404 with the same body.**
A foreign announcement, an announcement of another group and a missing one are
indistinguishable; a foreign or archived group is indistinguishable from a
missing one. No cross-tenant or cross-group existence is disclosed.

Every `500` body is opaque. No thrown message, table name, column name, driver
code or stack frame reaches the client.

## 6. Write semantics

- **Truthful no-op.** An edit that changes nothing writes nothing, audits nothing
  and answers `200` with the current stored projection. Retracting an
  already-retracted announcement is the same no-op and preserves the original
  `retracted_at`; no second retraction is ever recorded.
- **Retraction is terminal.** An edit of a retracted announcement is refused
  (`409 Announcement is retracted`) rather than silently resurrecting it.
- **One sanitized audit, atomically.** A confirmed change writes exactly ONE
  `audit_events` row in the same transaction:

  | Action | When | `old_value` → `new_value` |
  | --- | --- | --- |
  | `group.announcement_created` | create | `null` → `{ group_id, state }` |
  | `group.announcement_updated` | any confirmed edit | `{ state }` → `{ state }` |
  | `group.announcement_published` | a confirmed transition into `published` (in practice `draft → published`, since a retracted row is refused earlier) | `{ state }` → `{ state }` |
  | `group.announcement_retracted` | confirmed retraction | `{ state }` → `{ state: 'retracted' }` |

  `resource_type = 'group_announcement'`, `resource_id = <announcement id>`. The
  **title and body are deliberately never copied into the audit**: the event
  records WHO changed WHICH record into WHICH state, not the private content. No
  recipient, email, SMS, push, provider, enrollment or price value exists in the
  event because this surface creates none.
- **Read-back inside the transaction.** Every response is the row re-read on the
  same connection after the write, never a locally assembled guess. An
  unreadable or empty read-back rolls back and answers the opaque `500`.
- **`instructor_id`, `tenant_id` and `group_id` are never updated.** The only
  statements that write are the `INSERT` above and two `UPDATE`s whose `WHERE`
  clause pins `id AND group_id AND tenant_id` (the retract one additionally pins
  `state<>'retracted'`).

## 7. Connection hygiene

Every handler sets `Cache-Control: no-store` before the first `await` and before
any denial, so every outcome the handlers produce carries it. (The upstream
`401` is produced by the shared authentication middleware before this router and
is untouched.)

- A read path writes nothing and takes no connection from the write path; it uses
  the shared pool adapters.
- A confirmed rollback, a committed transaction or a truthful no-op **releases**
  the connection exactly once.
- A failed rollback, a failed `beginTransaction` and an **uncertain commit** (the
  acknowledgement was lost) **destroy** the connection instead of returning a
  possibly-dirty session to the shared pool. An uncertain commit never claims
  that a rollback happened and never retries silently.
- A failed acquisition has no connection to dispose of and skips cleanup.
- A throwing `release`/`destroy` is swallowed and cannot change the answer.

## 8. Test coverage (hermetic, production-path)

- `server/tests/m2-group-announcements.test.ts` — 31 tests.
- `server/tests/m2-group-announcements-failures.test.ts` — 31 tests.

Composition under test is the real production order: the real
`optionalAuth`/`authenticateToken` over the real principal resolver, the real
`requireTeachingWrite('groups')` entitlement guard (with its own documented
repository injection point, so the entitlement DECISION stays the real one), the
real tenant boundary modules and the real router from `src/routes/groups.ts`.
Only leaf data boundaries are fixtures: the `src/db` adapters, the entitlement
guard's repository and the `src/security/principal-repository` lookups. No
express listener, socket, fetch, DB, provider or app startup.

The fake transaction **buffers** the row write and the audit and applies them
only at `COMMIT`, so every "zero partial writes" assertion is real: a
rolled-back, denied or uncertain transaction leaves the fixture byte-identical.

**Not claimed:** live MySQL row-level locking, real concurrency, real keyset
index usage, real HTTP transport, and any runtime behavior of the migration
(which is not applied).
