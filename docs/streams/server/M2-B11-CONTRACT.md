# M2-B11 — private bounded group weekly schedules (server contract)

Task: `client-m2-19-private-group-weekly-schedules-20261023-01`.
Handoff: `docs/streams/client/M2-19-HANDOFF.md`.
Router: `server/src/routes/groups.ts` — the **existing** `/api/groups` mount,
hardened in place. No router, middleware, schema or shared helper is added or
edited. No migration.

**This is timetable metadata only.** A group carries a weekday list and one
wall-clock time. The contract creates no session, occurrence, calendar entry,
attendance record, announcement, notification, enrollment, access rule, pricing
or billing effect, and it defines no timezone, recurrence or automatic-date
rule. `schedule_time` is a bare `HH:mm` string with no zone attached.

## Endpoints (all preserved)

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/groups` | the caller's own bounded groups |
| `GET` | `/api/groups/:id` | one own group |
| `POST` | `/api/groups` | create one group |
| `PUT` | `/api/groups/:id` | update one own group |
| `DELETE` | `/api/groups/:id` | delete one own group |

Every handler sets `Cache-Control: no-store` **before its first `await` and
before any denial**, so a cached private group list can never be replayed.

`/api/groups` is **not** a billing-only exempt prefix (`isInstructorBillingPath`
in `middleware/auth.ts`), so a billed-out instructor is refused by the shared
middleware (`403 BILLING_ONLY`) before any handler runs.

## Canonical schedule vocabulary

```
GROUP_SCHEDULE_DAYS = ['sat','sun','mon','tue','wed','thu','fri']
```

- exactly these seven keys — the same seven the existing screen already shows;
- **unique**: a repeated key is refused (`400`);
- **at most seven** entries: an eighth entry is refused (`400`);
- emitted in **canonical order** regardless of the order the client sent;
- `schedule_time` is `HH:mm` (`^([01]\d|2[0-3]):([0-5]\d)$`) or `null`. `7:30`,
  `24:00`, `23:60`, `17:05:00` and `''` are all refused (`400`).

Read side is deliberately more lenient than write side: a legacy row may hold a
JSON string, an array, unknown keys or duplicates, so the projection parses it,
**drops** anything that is not one of the seven keys, de-duplicates, and
re-emits canonical order. A MySQL `TIME` column echoes `HH:mm:ss`; the
projection always emits `HH:mm`.

## Omission ≠ clear

| Body state | Effect |
|---|---|
| key **absent** | the stored value is kept |
| `schedule_days: []` | the stored list becomes empty |
| `schedule_days: null` | the stored list becomes empty (explicit clear) |
| `schedule_time: null` | the stored time is cleared (explicit clear) |
| `schedule_time: "18:30"` | the stored time is set |

Before this batch the screen could not express a clear at all: an empty list and
an empty time were dropped from the body, which the server read as "keep".

## Authorization — server-derived, never a selector

- **Reads** are bounded by `scopePredicate(instructorScopeId(req),
  req.user.tenantId)` and **require** a server-resolved tenant: `g.is_active =
  TRUE`, plus a tenant subquery over `tenant_memberships (tenant_id, user_id,
  status='active')`, plus `g.instructor_id = <caller>` when the caller's role is
  `instructor`. The tenant predicate is always present and is never dropped. A
  client tenant or instructor selector is never accepted — the body allow-list
  has no such key and any extra key is `400`.
- A token whose selected tenant the server cannot resolve (no active membership)
  leaves `req.user.tenantId` undefined. Both `GET /` and `GET /:id` then answer
  `404 { "error": "Tenant membership not found" }` **before any group query**.
  They never fall back to instructor-only rows from another tenant, even when
  `g.instructor_id` matches the caller.
- **Writes** additionally require the real `requireTeachingWrite('groups')`
  guard: an ACTIVE membership in the **server-selected** tenant whose
  `role_key` is `owner` or `instructor`, an active user, an active tenant, and a
  tenant that is legacy-compatible or subscription-entitled. Denial is
  `403 { "error": "Teaching access is not active for the selected tenant" }`.
- Authority is **re-read inside the write transaction on the same connection**,
  so a membership downgraded between the guard and the write cannot slip
  through:

```
SELECT m.role_key,u.is_active AS caller_active,t.status AS tenant_status
FROM tenant_memberships m
JOIN users u ON u.id=m.user_id
JOIN tenants t ON t.id=m.tenant_id
WHERE m.user_id=? AND m.tenant_id=? AND m.status='active'
LIMIT 1 FOR UPDATE
```

A caller with no resolved tenant scope has no private group read at all: list
and detail refuse with `404 Tenant membership not found` before any statement,
and writes are denied by the entitlement guard when no tenant was selected.

## Transaction

```
acquire → BEGIN → membership revalidation (FOR UPDATE)
        → group lock by id + tenant + caller scope (FOR UPDATE)
        → merge patch over the current row → change detection
        → (no change) rollback → 200 current projection
        → UPDATE → affectedRows check → audit INSERT → COMMIT → release
```

The group lock joins the **owning instructor's** active membership in the
selected tenant, and — when the caller has an instructor scope — also matches
`g.instructor_id = caller`:

```
SELECT <10 columns> FROM `groups` g
JOIN tenant_memberships tm
  ON tm.user_id=g.instructor_id AND tm.tenant_id=? AND tm.status='active'
WHERE g.id=? [AND g.instructor_id=?] AND g.is_active=TRUE
FOR UPDATE
```

A group of another tenant, of another instructor in the same tenant, or an
inactive group is therefore **indistinguishable from a missing one** (same
`404 { "error": "Group not found" }`), so no cross-tenant or cross-instructor
existence is disclosed.

`BEGIN` is always the first statement on the connection. When it fails, **no
statement is issued at all** and the connection is destroyed (untrusted) rather
than returned to the pool.

## Outcomes

| Outcome | Status | Body |
|---|---|---|
| non-object body, unknown key, bad `description`/`is_active` | `400` | `{ "error": "Invalid group payload" }` |
| missing / blank / over-255 `name` on create | `400` | `{ "error": "Group name is required" }` |
| malformed, foreign or archived `course_id` | `400` | `{ "error": "Invalid course selector" }` |
| malformed or absent `grade_id` | `400` | `{ "error": "Invalid grade selector" }` |
| non-integer / out-of-range `max_students` | `400` | `{ "error": "Invalid max students" }` |
| duplicate, unknown, non-array or over-seven weekdays | `400` | `{ "error": "Invalid schedule days" }` |
| non-`HH:mm` / non-null time | `400` | `{ "error": "Invalid schedule time" }` |
| billing-only (shared middleware) | `403` | `{ "error": "…billing and support", "code": "BILLING_ONLY" }` |
| no teaching entitlement / no selected tenant | `403` | `{ "error": "Teaching access is not active for the selected tenant" }` |
| group absent, foreign, other instructor or inactive | `404` | `{ "error": "Group not found" }` |
| selected tenant unresolved on list/detail | `404` | `{ "error": "Tenant membership not found" }` |
| non-UUID id | `404` | `{ "error": "Group not found" }` |
| acquisition/begin/read/update/audit/rollback failure | `500` | `{ "error": "Failed to save group" }` |
| `commit()` failed (outcome uncertain) | `500` | `{ "error": "Failed to save group" }` |
| identical retry (no write, no audit) | `200` | the current projection |
| create committed | `201` | the created projection |
| update committed | `200` | the updated projection |
| list / detail read | `200` | array of projections / one projection |
| delete committed | `200` | `{ "message": "Group deleted successfully" }` |

Every `500` body is opaque: no SQL, no table name, no driver message, no stack.
Selector validation runs **before** a connection is taken, so a refused selector
issues zero statements.

## Response projection

Exactly ten keys — the row is **never** spread:

```json
{
  "id": "…",
  "name": "…",
  "description": "…" | null,
  "course_id": "…" | null,
  "grade_id": "…" | null,
  "max_students": 30,
  "current_students": 0,
  "is_active": true,
  "schedule_days": ["sat", "mon"],
  "schedule_time": "18:30" | null
}
```

`instructor_id`, `tenant_id`, `created_at`, `updated_at` and every other stored
column are **not** exposed. `schedule_days` is always a canonical array (never a
JSON string, never `null`) and `schedule_time` is always `HH:mm` or `null`.

## Writes and audit

A committed write changes exactly one `groups` row (the eight canonical columns
plus `updated_at`) and records exactly **one** sanitized `audit_events` row in
the **same** transaction:

- `action` = `group.created` (create), `group.schedule_updated` (the schedule
  changed) or `group.updated` (any other change);
- `resource_type` = `group`, `resource_id` = the group id;
- `actor_user_id` = the authenticated caller, `tenant_id` = the server-selected
  tenant — never a body value;
- `old_value` / `new_value` carry **only** `{ schedule_days, schedule_time }` —
  never a group name, description, course or grade value, and never a student
  value.

`affectedRows !== 1` on the update is a `404`, and it rolls back: no column and
no audit event survive.

## Truthful no-op

When the merged result equals the stored row the route **rolls back, writes
nothing and audits nothing**, and answers `200` with the current projection. A
repeated identical retry therefore never manufactures a second audit event, and
the client can safely re-save an unchanged form.

## Connection hygiene

- a failure at any point before `commit()` rolls back and releases the
  connection exactly once;
- a **denial** (`403`) and a **missing target** (`404`) roll back before the
  answer and release exactly once, writing nothing;
- a **failed rollback** destroys the connection instead of returning it to the
  pool;
- a `commit()` that throws leaves the outcome **unknown**: the connection is
  destroyed, never released, and never blindly rolled back; the answer is `500`;
- a release/destroy that throws is swallowed and never produces a second
  response.

## Delete

`DELETE /api/groups/:id` keeps its existing hard-delete behaviour but is now
bounded: a non-UUID id is `404` before any query, the ownership `SELECT` is
qualified by the same scope + tenant predicate, and only a matched row is
deleted. A foreign or other-instructor group is `404` and is not touched.

## Explicitly not in this contract

No migration, no live database, no network/provider/service call, no session or
occurrence generation, no attendance, no announcement/notification, no
enrollment/access/payment effect, no timezone or recurrence policy, no course or
grade creation, no capacity recalculation, and no change to the accepted
student, tenant, course or billing contracts.
