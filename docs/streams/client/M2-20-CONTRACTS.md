# M2-20 — client contracts: instructor branch-assignment organization metadata

Task: `client-m2-20-private-instructor-branch-assignment-20261023-01`
Server contract: `docs/streams/server/M2-B12-CONTRACT.md`
Status: implemented and reported by the WorkBuddy worker. **A worker report is
not acceptance.**

## 1. Modules touched

| Path | Role |
| --- | --- |
| `src/lib/api-http.ts` | Canonical transport: the two new adapters and their DTO types (additive only; the existing `request` and every existing adapter are unchanged) |
| `src/features/tenant/branches.ts` | The testable controller: the instructor section's state, parsing, classifiers, single-flight writes and every lifetime fence |
| `src/features/tenant/BranchManager.tsx` | The card: renders the existing branch panel plus the new instructor section. Owns no request and no decision |
| `src/tests/m2-tenant-branches-ui.test.ts` | Production-path tests for both the transport seam and the controller seam |

## 2. Transport

```ts
listMyTenantInstructorMemberships({ limit?: number; cursor?: string | null })
  -> GET  /api/tenants/me/instructor-memberships?limit=25[&cursor=…]

assignInstructorBranch(membershipId: string, branchId: string | null)
  -> PATCH /api/tenants/me/instructor-memberships/:membershipId
     body: { "branch_id": <uuid> | null }
```

- The default page size is `TENANT_INSTRUCTOR_MEMBERSHIP_PAGE_LIMIT = 25`, the
  server's own default. No client code drains all pages automatically.
- **No client tenant selector exists** in header, query or body. The server
  selects the tenant and re-verifies the owner inside the transaction that
  writes.
- The path id is a **resource selector**, never an authority.
- The write body is the strict single field `{ branch_id }`. A clear sends an
  **explicit `null`**, never an omission, so "clear" can never be confused with
  "leave unchanged".
- The transport throws the server's `error` message **without** the HTTP status
  and **without** the `code`. Callers therefore classify only documented
  messages and never fabricate a status.

## 3. DTO validation

The server's projection is exactly five fields, and anything else is a malformed
response — never a fabricated record:

```ts
interface TenantInstructorMembership {
  membership_id: string;      // non-empty
  instructor_id: string;      // non-empty
  instructor_name: string;    // bounded display label, ≤ 255
  branch_id: string | null;
  branch_name: string | null;
}
```

`parseTenantInstructorMembership` rejects: a non-object, an array, a wrong field
type, an unknown extra key (including `tenant_id`, `role_key`, `status`), and a
**half-populated branch pair** — `branch_id` and `branch_name` are either both
present or both `null`, because that is the only shape the server can produce.

`parseTenantInstructorMembershipList` requires exactly
`{ memberships, next_cursor }` and enforces the page bound **on the response**:
more than 25 rows is a malformed response, rejected before a single row is
traversed or copied. `parseTenantInstructorMembershipEnvelope` requires exactly
`{ membership }`.

## 4. Failure classification (documented messages only)

`classifyTenantInstructorListFailure` → `phase` + `reason`:

| Message | Phase | Reason |
| --- | --- | --- |
| `Token expired`, `Invalid token`, `No token provided`, `Session revoked`, `Selected workspace is no longer active` | `unauthorized` | `session` |
| `Instructor account is administratively suspended` | `denied` | `suspended` |
| `Branch management is not available while the account is limited to billing and support` | `denied` | `billing-only` |
| `Forbidden` | `denied` | `not-owner` |
| `Tenant membership not found`, `Select an instructor workspace first` | `no-workspace` | `no-workspace` |
| `Failed to list instructor memberships` | `error` | `server` |
| `Invalid instructor membership list limit` / `… cursor` | `error` | `invalid` |
| anything else | `error` | `unknown` |

`classifyTenantInstructorWriteFailure` → `kind` + `reason`:

| Message | Kind | Reason |
| --- | --- | --- |
| session / suspension / billing-only / `Forbidden` / no workspace | `unauthorized` or `denied` | as above |
| `Instructor membership not found` | `missing` | `missing-membership` |
| `Branch not found` | `missing` | `missing-branch` |
| `Instructor membership was modified concurrently` | `conflict` | `conflict` |
| `Invalid membership id` / `Invalid instructor branch assignment payload` | `invalid` | `invalid` |
| `Failed to assign instructor branch` | `uncertain` | `server` |
| anything else (network, transport, unrecognized) | `uncertain` | `unknown` |

**A missing target is not an authorization loss.** `Branch not found` and
`Instructor membership not found` mean the server did **not** write: the rows and
the explicit selection are preserved so the user may deliberately retry. Only
the session/suspension/billing-only/not-owner/no-workspace outcomes clear the
private state.

## 5. Controller surface

The instructor section lives inside the SAME controller the card already mounts,
so both surfaces share one principal reader, one session subscription, one
disposal and one write latch:

```ts
openInstructors()            // explicit; ONE bounded page
closeInstructors()
refreshInstructors()
nextInstructorsPage()        // no cursor ⇒ no request at all
firstInstructorsPage()
selectInstructorBranch(membershipId, branchId)   // local only, no request
cancelInstructorSelection()
saveInstructorBranch()       // explicit single-flight write
clearInstructorBranch(id)    // explicit single-flight write of null
reconcileInstructors()       // deliberate read after an uncertain write
```

State: `state.instructors = { open, phase, rows, nextCursor, hasPreviousPage,
error, reason, lastConfirmed, selection, mutation }`.

- Nothing is requested before `openInstructors()`. The card shows an explicit
  "عرض المدربين" control.
- `openInstructors()` also reads the **bounded branch page** if it was never
  read, because the selector's options are the ACTIVE branches of that page.
  It is exactly one branch read, through the normal read path — never a second
  parallel read.
- `selectInstructorBranch` accepts only an ACTIVE branch of the CURRENT branch
  page and only a membership of the CURRENT instructor page. An archived,
  unknown or off-page id is refused **locally** with
  `INSTRUCTOR_SELECTION_INVALID_MESSAGE` and never reaches the transport.
  Selecting the already-recorded branch simply clears the selection.
- `saveInstructorBranch` with no selection is a local rejection and sends
  nothing. It re-validates the row and the branch against the current pages
  before sending, so a superseded target is never written.
- `clearInstructorBranch` on an already-empty record sends nothing.

## 6. Lifetimes fenced

- **page.** Every instructor read advances its own page generation, so a
  reversed or superseded reply can never commit. Only ONE page (at most 25 rows)
  is ever held, and the response is validated against that bound **before** any
  row is copied. The instructor page and the branch page have independent
  generations, so a superseded instructor reply is never mistaken for a branch
  reply (or vice versa), and opening the instructor section never silently
  cancels an in-flight branch read.
- **write.** Every assignment advances its own request generation and takes a
  synchronous single-flight latch BEFORE the first await. The latch is the
  panel's **single write latch**, shared with branch create/rename/status: one
  write of any kind is in flight at a time, so a double-clicked save never sends
  a second write and a save racing a branch rename never overlaps.
- **selection.** The explicit selection is the draft. It is **never applied
  optimistically**: the row keeps showing the last server-confirmed value, and
  the selection survives every definite failure, every uncertain outcome and
  every superseded write. Only a confirmed write for that membership consumes
  it.
- **authorization.** A DEFINITE loss (session, suspension, billing-only,
  owner-only denial, missing workspace) clears every private row, cursor and
  selection and retires all in-flight operations. A retryable failure keeps the
  selection, because no permission loss was proven.
- **session.** The canonical principal is re-read at entry AND at completion of
  every read and write, on the success and the failure path, and a RETIRED
  operation observes it BEFORE it settles any visible state. A session event
  clears the section and, if it was open, gives the new session its own bounded
  first page.
- **dispose.** `dispose()` clears the rows, the cursor and the selection and
  drops every in-flight reply; a reply that lands afterwards commits nothing.

## 7. Honesty rules

- A 2xx body that cannot be validated is **not** a success: it becomes
  `mutation.status = 'uncertain'` with `INSTRUCTOR_ASSIGNMENT_UNCERTAIN_MESSAGE`.
- A well-formed DTO for **another** membership is not a success for this write:
  the row is never overwritten, the selection is retained and the write stays
  explicitly uncertain.
- An unknown write outcome is **uncertain**, not failed: nothing is retried
  automatically, the selection is preserved, and a deliberate
  `reconcileInstructors()` read is offered.
- A reconciliation read shows the **current** state only. A matching record is
  never proof that the earlier write succeeded or that its audit was written;
  the warning says so and the mutation stays `uncertain`.
- A confirmed success publishes the **server's DTO only**, patched into the held
  page. No optimistic value is ever shown.
- The selector never misrepresents the stored value: a branch recorded earlier
  and archived since is not selectable but remains visible as its own option.

## 8. Scope boundary

Organization metadata only. The client cannot change a role, a permission, a
teaching-access decision, a course, a group, a student, an enrollment, a login,
an invitation, a price or a billing state through this surface, and no
capability is inferred from a local role, profile or tenant status — the server
stays authoritative for every outcome and every denial is shown as the server's
own message.

**Not proven here:** DOM rendering, RTL paint, real HTTP, real DB, live services
and end-to-end authorization. The migration FILE is not applied, so no runtime
rollout of the new column is claimed.
