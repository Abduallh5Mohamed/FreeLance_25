# M2-18 — client contracts for private student branch assignment

Task: `client-m2-18-private-student-branch-assignment-20261022-01`.
Handoff: `docs/streams/client/M2-18-HANDOFF.md`.
Server contract: `docs/streams/server/M2-B10-CONTRACT.md`.
Builds on: accepted M2-04 (instructor students controller/page) and the accepted
M2-B03 branch routes.

The enrollment page, its six reads, the invite/decision/reset/suspend workflows
and every existing lifecycle fence are **unchanged**. This batch widens exactly
one thing: the page can assign one existing tenant student row to one **active**
branch of the same tenant, or clear it. Assigning a branch is **planning
metadata only** — it never changes a login, an enrollment, a group, an access
rule, pricing or billing. No new read or write exists beyond the bounded catalog
read and the single assign/clear write.

## Modules

| Path | Change |
|---|---|
| `src/lib/api-http.ts` | **additive** — `StudentBranchAssignment`, `StudentBranchEnvelope`, `assignStudentBranch(studentId, branchId)` and the `api` export entry |
| `src/features/enrollment/instructor-students.ts` | **additive** — the branch section, the bounded catalog reader, the projection validator, the failure classifier and the `loadBranches`/`selectBranch`/`clearBranchDraft`/`assignBranch` controller methods |
| `src/pages/InstructorStudents.tsx` | **additive** — the bounded catalog card and a per-student active-branch selector with an explicit save/clear |
| `src/tests/m2-instructor-students.test.ts` | **additive** — 18 hermetic branch tests; every accepted M2-04 behaviour still pinned |

The write reuses the same authenticated `request` as the rest of `api-http`; the
student id in the path is a **resource selector**, never a tenant authority, and
no tenant selector is sent in the header, query or body.

## The read — one bounded ACTIVE catalog

`loadBranches()` reads `GET /tenants/me/branches` as its **own section**,
independent of the other six reads (a failing catalog never clears the students,
the wallet or anything else, and never becomes an empty catalog).

`normalizeBranchCatalog(payload)` is the only reader:

- `null` when the body is not the documented `{ branches, next_cursor }`
  envelope — an error, **never** an empty catalog;
- rows without a usable `id` are dropped;
- rows whose `status` is not `'active'` are dropped — an archived branch is
  **not** a selectable target;
- the list is capped at `STUDENT_BRANCH_CATALOG_LIMIT` (25), so the selector
  stays bounded no matter what the body contains;
- `branchesHasMore` is `true` exactly when the server returned a non-null
  `next_cursor`; the client never drains further pages automatically.

A confirmed empty catalog is an honest `empty` state; a failed or malformed read
with nothing confirmed is an `error` state; a failed or malformed read **beside**
confirmed rows keeps those rows and reports the error next to them.

## The write — assign or clear, then publish only the server's reply

`assignBranch(studentId, branchId)`:

- `branchId` a canonical UUID → **assign**; `branchId === null` → **clear**;
- a non-UUID selector (or a blank student id) is refused as `invalid` **before**
  the transport, so an obviously malformed choice never reaches the server;
- a same-tick duplicate save never reaches the transport (the latch is acquired
  before the first `await`);
- the reply is validated by `readStudentBranchAssignment(reply, studentId,
  branchId)`, which accepts **only** the server's own three-field projection
  naming the **SAME** student and the **SAME** branch. A reply naming a
  different student or branch is a stale/foreign reply: it is refused
  (`conflict`) and **never** cached. For a clear, `branch_name` must be `null`
  exactly when there is no branch.

A confirmed assignment is published into `branchAssignments[studentId]` — the
server's projection is the **only** source. Nothing is inferred from a local
role, profile or status.

## Draft lifecycle

The page arms a target, then saves explicitly:

- `selectBranch(studentId, branchId)` sets `branchDraftStudentId` /
  `branchDraftId` and sends **nothing**; a malformed selector never arms it;
- `clearBranchDraft()` drops the draft (cancel);
- on a successful save the draft is cleared;
- `denied` (not the verified owner) and `not-found` (absent/foreign
  student/branch) **clear** the draft, because the authority or the target is
  gone and a retry cannot succeed;
- `conflict` (the row moved under the write) and a transport `error` **keep** the
  draft, so the same save can be retried on purpose.

## Failure classification

`classifyStudentBranchFailure` maps **only** the documented server strings
(`Forbidden`, `Tenant membership not found` → denied; `Student not found`,
`Branch not found` → not-found; `Student was modified concurrently` → conflict;
`Invalid student branch payload`, `Invalid student id` → invalid). Everything
else is `error`. The transport drops the HTTP status and the `code`, so a status
is **never** fabricated on the client and permission is **never** inferred from a
local role, profile or status.

## Lifecycle fences (unchanged, extended)

The branch write is bound by the same fences as every other mutation:

- a reply that lands after the **session** changed (or a silent principal
  replacement) is `blocked` and commits nothing;
- a reply that lands after the **instructor scope** changed — including an
  `A → B → A` return — is `blocked`, and a scope change clears the catalog and
  every cached assignment;
- a reply that lands after `dispose()` commits nothing;
- an older `finally` releases only its own latch/ticket, so it can never free a
  newer operation.

## Explicitly not in this contract

No account/login/enrollment/group/access/pricing/billing change, no branch
create/rename/archive, no automatic page draining, no bulk assignment, no
optimistic local assignment (the server's projection is required first), and no
DOM/RTL/HTTP/DB proof (the server remains authoritative).
