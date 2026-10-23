# M2-B10 — private student branch assignment (server contract)

Task: `client-m2-18-private-student-branch-assignment-20261022-01`.
Handoff: `docs/streams/client/M2-18-HANDOFF.md`.
Router: `server/src/routes/students.ts` — one additive owner-only route beside the
existing student management handlers. It is mounted by the existing students
router; no other router, middleware or shared helper is edited.
Migration FILE: `server/migrations/20261022_01_student_branch_assignment.sql`
(**created, never applied by this batch**).

**This route is the only WRITE in the M2-18 chain.** It sets exactly one
nullable column on one existing tenant student row (`students.branch_id`) plus
one sanitized audit event, atomically or not at all. It creates no account,
login, password, invitation, OTP, enrollment, group/course membership,
academic-period binding, access rule, pricing or billing change.

## Endpoint

`PATCH /api/students/:id/branch`

- Authenticated. The tenant is the one the authentication middleware selected
  from the caller's active memberships. **No tenant selector** is accepted in
  the header, the query or the body; an extra key is refused with `400` before a
  connection is taken.
- `Cache-Control: no-store` on **every** outcome this handler produces,
  including `400`, `403`, `404`, `409` and `500`. The directive is set before
  the first `await` and before any denial.
- `/api/students` is **not** a billing-only exempt prefix
  (`middleware/auth.ts` `isInstructorBillingPath`), so a billed-out instructor is
  refused by the shared middleware (`403 BILLING_ONLY`) **before** this handler
  runs. No local billing guard is added here.

## Authorization

The caller must be the **verified owner** of the server-selected **active**
tenant, re-read **on the same connection that performs the write** and **inside
the transaction that performs it**:

```
SELECT t.owner_user_id,t.status AS tenant_status,u.is_active AS caller_active
FROM tenants t JOIN users u ON u.id=? WHERE t.id=? FOR UPDATE
```

`owner_user_id === caller`, `status === 'active'` and `caller_active === 1` are
all required. A membership row labelled `owner` or `instructor` is **not**
sufficient, and an instructor/admin/student principal never reaches the write.

Authority is deliberately **not** the instructor scope used by the older student
handlers (`instructorScopeId` / `isStudentInScope`): branch assignment belongs to
the verified owner of the tenant, re-resolved from server-side rows — the same
owner rule the accepted M2-B03 branch routes use (`routes/tenant-self.ts`).

## Transaction

The transaction is opened **before** the owner read, so the authorization and the
write it authorizes share **one** transaction on **one** connection. An ownership
change, a tenant suspension or a caller revocation that lands between the
authorization and the write therefore cannot slip through.

```
acquire → BEGIN → owner revalidation (FOR UPDATE)
        → student lock by id+tenant (FOR UPDATE)
        → branch lock by id+tenant (FOR UPDATE, only when assigning)
        → no-op check → UPDATE → audit INSERT → COMMIT → release
```

`BEGIN` is always the first step on the connection: when `beginTransaction`
fails, **no statement is issued at all** and the connection is destroyed
(untrusted), never returned to the pool.

## Outcomes

| Outcome | Status | Body |
|---|---|---|
| malformed student id | `400` | `{ "error": "Invalid student id" }` |
| malformed / non-single-field / non-UUID body | `400` | `{ "error": "Invalid student branch payload" }` |
| billing-only (shared middleware, before this handler) | `403` | `{ "error": "…billing and support", "code": "BILLING_ONLY" }` |
| not the verified owner / suspended tenant / revoked caller | `403` | `{ "error": "Forbidden" }` |
| no server-selected tenant | `404` | `{ "error": "Tenant membership not found" }` |
| student absent **or** belongs to another tenant | `404` | `{ "error": "Student not found" }` |
| branch absent, foreign **or** archived | `404` | `{ "error": "Branch not found" }` |
| the row moved under the write (`affectedRows === 0`) | `409` | `{ "error": "Student was modified concurrently" }` |
| acquisition/begin/read/update/audit/rollback failure | `500` | `{ "error": "Failed to update student branch" }` |
| `commit()` failed (outcome uncertain) | `500` | `{ "error": "Failed to update student branch" }` |
| identical retry (no write, no audit) | `200` | `{ "student": { "student_id": "…", "branch_id": "…", "branch_name": "…" } }` |
| assign / clear committed | `200` | `{ "student": { "student_id": "…", "branch_id": "…" \| null, "branch_name": "…" \| null } }` |

Every `500` body is opaque: no SQL, no table name, no driver message, no stack
and no internal detail. A foreign student and an absent student are
**indistinguishable** (same `404` body), and a foreign/archived branch is
indistinguishable from a missing one (same `404` body), so no cross-tenant
existence is disclosed.

## Request

Exact body, exactly one key:

```json
{ "branch_id": "123e4567-e89b-12d3-a456-426614174000" }
```

| Rule | Bound |
|---|---|
| body | plain object (not array, not null) with **exactly** `branch_id` |
| `branch_id` | a canonical UUID **or** `null` |
| `null` | **clears** the assignment (a first-class state, not a missing feature) |

A tenant selector, a status, a name or any second key is refused with `400`
before a connection is taken. A malformed student id is refused with `400` before
a connection is taken. Every rule above issues **zero** statements when it fails.

## Writes

Exactly one transaction writes exactly two things:

1. `students` — `UPDATE students SET branch_id=? WHERE id=? AND tenant_id=?`.
   Only the nullable `branch_id` column is written; no other student column is
   touched, so no account, enrollment, group, access, pricing or billing field
   can change.
2. `audit_events` — one sanitized event, **inside the same transaction**:
   - `action` = `student.branch_assigned` (assign) or `student.branch_cleared`
     (clear);
   - `resource_type` = `student`, `resource_id` = the student id;
   - `old_value` = `{ "branch_id": <previous id or null> }`,
     `new_value` = `{ "branch_id": <new id or null> }` — **only** the branch id,
     never a student value, never a branch name, never an existing-record
     identity.

The `affectedRows === 1` check is the concurrency fence: a row that changed
between the lock and the update is `409` and writes neither the column nor an
audit event.

## No-op

When the requested `branch_id` equals the student's current `branch_id` the route
is a **truthful no-op**: it rolls the transaction back, writes nothing, audits
nothing, and answers `200` with the current projection. A repeated identical
retry therefore never manufactures a second audit event.

## Response

Exactly three keys — the student id, the branch id and the branch name. The
student row is **never** spread into the response: no name, phone, email,
barcode, grade, group or any other stored value. `branch_name` is read under the
same lock inside the same transaction and is `null` **exactly** when there is no
branch.

## Connection hygiene

The injected seam exposes `getConnection`, `beginTransaction`, `commit`,
`rollback`, `release` and `destroy`:

- a failure at any point before `commit()` rolls the whole transaction back and
  releases the connection exactly once;
- a **denied authority** rolls the open transaction back before the answer,
  releases the connection exactly once and writes neither the column nor an
  audit event;
- a **failed rollback** destroys the connection instead of returning it to the
  pool, because the session is in an unknown state;
- a `commit()` that throws leaves the outcome **unknown**: the connection is
  destroyed, never released and never rolled back blindly, and the answer is
  `500`;
- a release/destroy that throws is swallowed and never changes the answer or
  writes a second response.

## Migration file

`server/migrations/20261022_01_student_branch_assignment.sql` defines one
**additive** change. It is **a file only**: this batch never applies it, and no
test connects to a database.

```sql
ALTER TABLE students
  ADD COLUMN branch_id CHAR(36) NULL,
  ADD INDEX idx_students_tenant_branch (tenant_id, branch_id),
  ADD CONSTRAINT fk_students_branch FOREIGN KEY (branch_id) REFERENCES tenant_branches(id);
```

- nullable, no default, **no backfill** — every existing row keeps
  `branch_id = NULL`, the documented "not assigned" state;
- the index is **tenant-led** (`tenant_id, branch_id`) and **not unique**: many
  students may share one branch;
- the foreign key has **no `ON DELETE` clause**: deleting a branch that still has
  students assigned is refused by the database rather than silently clearing an
  assignment the owner never cleared;
- a foreign key on `branch_id` alone cannot prove the branch belongs to the
  student's tenant, so the route qualifies **every** branch lookup by the
  server-selected tenant inside its transaction, and the tenant-led index makes
  that qualification the indexed path.

## Explicitly not in this contract

No account/login/password/invitation/OTP change, no enrollment, no
group/course/period assignment, no access-rule change, no pricing, billing,
wallet or capacity change, no branch create/rename/archive, no migration
application, no notification, no bulk assignment, and no claim that assigning a
branch grants or revokes anything.
