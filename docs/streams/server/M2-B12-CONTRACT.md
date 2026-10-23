# M2-B12 — private instructor branch-assignment organization metadata

Task: `client-m2-20-private-instructor-branch-assignment-20261023-01`
Stream: server (implemented in `server/src/routes/tenant-self.ts`)
Status: implemented and reported by the WorkBuddy worker. **A worker report is
not acceptance.**

## 1. What this surface is

The verified owner of the server-selected tenant can now answer ONE question the
accepted branch surface could not: **which active branch of this tenant is an
existing active instructor membership organized under?**

That record is **planning metadata only**. It is not an authorization, role,
permission, teaching-access, course, group, student, enrollment,
login/invitation, pricing, billing or capacity field. No route anywhere in the
application consults it to decide access, and this batch changes no other table.

Explicitly out of scope and NOT implemented here: role changes, permission
matrix changes, teaching-access changes, course/group/student assignment,
enrollment, invitations, login, payments, migration application, and any
network/browser/provider/service/deploy activity.

## 2. Migration

`server/migrations/20261023_01_instructor_branch_assignment.sql` — **FILE ONLY,
NEVER APPLIED** by this batch.

Additive and reversible in intent:

| Change | Shape |
| --- | --- |
| `tenant_memberships.branch_id` | `CHAR(36) NULL`, no default, no backfill |
| `idx_tenant_memberships_branch` | `(tenant_id, branch_id)` — tenant-safe reference lookup, NOT unique |
| `idx_tenant_memberships_role_page` | `(tenant_id, role_key, status, id)` — the bounded list shape |
| `fk_tenant_memberships_branch` | `branch_id` → `tenant_branches(id)`, **no `ON DELETE` clause** |

No table is created, dropped or rebuilt; no other column is altered; no row is
rewritten. Every existing membership therefore keeps `branch_id = NULL`, which
is the documented "no branch recorded" state. There is no default branch and no
implicit reorganization.

The foreign key has no `ON DELETE` clause on purpose: deleting a branch that
still has memberships recorded against it is refused by the database rather than
silently clearing a record the owner never cleared. Branch rows carry no
application hard-delete path, so this is a referential guard, not a workflow.

A foreign key alone cannot guarantee the branch belongs to the *membership's*
tenant, because the tenant lives on the child row. The route therefore qualifies
every branch lookup by the server-selected tenant, and the index above is
deliberately tenant-led so that qualification is the indexed path.

## 3. Endpoints

Both are mounted under the existing tenant-self router (`/api/tenants/me`), after
the shared `authenticateToken` middleware. No existing handler, mount, guard or
middleware was changed.

### `GET /api/tenants/me/instructor-memberships`

Query: `limit` (integer 1..100, default 25), `cursor` (opaque, optional).

`200`:

```json
{
  "memberships": [
    {
      "membership_id": "a1111111-1111-4111-8111-111111111111",
      "instructor_id": "…",
      "instructor_name": "أحمد المدرب",
      "branch_id": "a0000000-0000-4000-8000-000000000001",
      "branch_name": "North Campus"
    }
  ],
  "next_cursor": null
}
```

Rows are ordered by `membership_id` ASC (a total, stable order that needs no
timestamp or timezone interpretation) and read with a keyset cursor, so no page
is unbounded and no offset can skip or duplicate a row under concurrent writes.
One extra row is read to learn whether a further page exists; only `limit` rows
are ever returned. The cursor encodes a POSITION only and never carries
authority: the page is still qualified by the selected tenant, so a cursor
minted elsewhere can never widen the read.

### `PATCH /api/tenants/me/instructor-memberships/:membershipId`

Body — **exactly** `{ "branch_id": <uuid> | null }`. A UUID records the branch;
`null` clears the record. Unknown keys, a missing key, a non-string and a
non-UUID string are rejected before any connection is taken, so this route can
never rename, create, archive or delete a branch and can never write a second
column. There is no "omission" form: a caller that wants to keep the current
record simply does not call the route.

`200`:

```json
{ "membership": { "membership_id": "…", "instructor_id": "…", "instructor_name": "…", "branch_id": null, "branch_name": null } }
```

## 4. Authorization

Resolved from server-side rows only, and re-verified on ONE connection inside ONE
transaction, each read locked `FOR UPDATE` where the write depends on it:

1. **Owner.** The caller is `tenants.owner_user_id` of the SELECTED tenant, that
   tenant's `status` is `active`, and the caller's own `users.is_active` is 1. A
   membership `role_key` label (`owner`/`instructor`) never satisfies this.
2. **Membership.** The target row belongs to the SELECTED tenant, has
   `role_key = 'instructor'`, `status = 'active'`, and its user row is active.
3. **Branch.** The target branch EXISTS, has `status = 'active'`, and belongs to
   the SAME tenant.

The tenant is always `req.user.tenantId`, resolved by the authentication
middleware from the caller's active memberships. No header, query or body tenant
selector is accepted anywhere; the shared tenant-authority boundary refuses a
client-supplied tenant context before this router is reached.

The list read verifies the same owner authority on the same connection without
taking an exclusive lock on the owner row, so the page and the authority share
one snapshot.

## 5. Outcomes

| Situation | Status | Body |
| --- | --- | --- |
| List succeeds | 200 | `{ memberships, next_cursor }` |
| Assignment/clear succeeds | 200 | `{ membership }` |
| Malformed `limit` | 400 | `Invalid instructor membership list limit` |
| Malformed `cursor` | 400 | `Invalid instructor membership list cursor` |
| Non-UUID `:membershipId` | 400 | `Invalid membership id` |
| Malformed body | 400 | `Invalid instructor branch assignment payload` |
| Billing-only account | 403 | `Branch management is not available while the account is limited to billing and support` + `code: "BILLING_ONLY"` |
| Caller is not the tenant owner | 403 | `Forbidden` |
| No resolved tenant / no workspace | 404 | `Tenant membership not found` |
| Membership absent, foreign, non-instructor or inactive | 404 | `Instructor membership not found` |
| Branch absent, foreign or archived | 404 | `Branch not found` |
| `affectedRows !== 1` | 409 | `Instructor membership was modified concurrently` |
| Any internal failure | 500 | `Failed to list instructor memberships` / `Failed to assign instructor branch` |

**A foreign target and an absent target are the same 404 with the same body.**
No cross-tenant existence is disclosed: a foreign membership is
indistinguishable from a missing one, and a foreign or archived branch is
indistinguishable from a missing one.

The billing-only denial reuses the branch-management wording because it is the
same guard over the same organization-metadata surface: `auth.ts` exempts the
whole `/api/tenants/me` prefix from the instructor billing-only path
restriction, so each route enforces the denial locally before any data access.

Every `500` body is opaque. No thrown message, table name, column name, driver
code or stack frame reaches the client.

## 6. Write semantics

- **Truthful no-op.** Re-recording the branch that is already stored writes
  nothing, audits nothing and answers `200` with the current stored projection.
  Clearing an already-empty record is the same no-op.
- **The branch check runs BEFORE the no-op comparison.** Re-recording a branch
  that has since been archived is refused (`404 Branch not found`) rather than
  accepted as "already recorded", because an archived branch is not a valid
  target.
- **One sanitized audit, atomically.** A confirmed change writes the single
  column and exactly ONE `audit_events` row in the same transaction:
  `tenant.instructor_branch_assigned` or `tenant.instructor_branch_cleared`,
  `resource_type = 'tenant_membership'`, `resource_id = <membership id>`, and
  `old_value`/`new_value` carrying only `{ branch_id, branch_name }`. No role,
  permission, teaching-access, course, group, student, enrollment or billing
  value is copied into the event, because this route changes none of them.
- **Read-back inside the transaction.** The response is the row re-read on the
  same connection after the update, never a locally assembled guess. An
  unreadable or empty read-back rolls back and answers the opaque `500`.
- **The membership row's `role_key` and `status` are never touched.** The only
  statement that writes is `UPDATE tenant_memberships SET branch_id=? WHERE
  id=? AND tenant_id=?`.

## 7. Connection hygiene

Every handler sets `Cache-Control: no-store` before the first `await` and before
any denial, so every outcome the handlers produce carries it. (The upstream
`401` is produced by the shared authentication middleware before this router and
is untouched.)

- A read path writes nothing, so it **rolls back** rather than commits and
  returns a clean connection to the pool.
- A confirmed rollback, a committed transaction or a read path **releases** the
  connection exactly once.
- A failed rollback, a failed `beginTransaction` and an **uncertain commit**
  (the acknowledgement was lost) **destroy** the connection instead of returning
  a possibly-dirty session to the shared pool. An uncertain commit never claims
  that a rollback happened and never retries silently.
- A failed acquisition has no connection to dispose of and skips cleanup.
- A throwing `release`/`destroy` is swallowed and cannot change the answer.

## 8. Test coverage (hermetic, production-path)

- `server/tests/m2-instructor-branch-assignment.test.ts` — 29 tests.
- `server/tests/m2-instructor-branch-assignment-failures.test.ts` — 27 tests.

Composition under test is the real production order: the real optional-auth
middleware over the real principal resolver, the real tenant-authority and
student-workspace boundaries, and the real `createTenantSelfRouter` handlers.
Only leaf data repositories and the transactional connection are injected. No
express listener, socket, fetch, DB, provider or app startup. The
`src/db`, `src/services/minio` and `src/services/subscription-renewal` module
bodies are intercepted in the CommonJS loader and proven never to evaluate.

The fake transaction **buffers** the column write and the audit and applies them
only at `COMMIT`, so every "zero partial writes" assertion is real: a
rolled-back, denied or uncertain transaction leaves the fixture byte-identical.

**Not claimed:** live MySQL row-level locking, real concurrency, real keyset
index usage, real HTTP transport, and any runtime behavior of the migration
(which is not applied).
