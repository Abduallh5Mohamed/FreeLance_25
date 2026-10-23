# M2-09 contracts — private course-unit metadata in the course details dialog

Task `client-m2-09-course-unit-ui-20261020-01` (frontend, write access). Scope:
the six allowed paths of `docs/streams/client/M2-09-HANDOFF.md`. Backend
contract: `docs/streams/server/M2-B04-CONTRACT.md` /
`server/src/routes/course-units.ts`, accepted under supervisor/176.

## Before / after

- Before: the existing course-details dialog (`src/pages/Courses.tsx`) showed
  the course fields only. No unit metadata existed anywhere in the client.
- After: the same dialog mounts a **dedicated, explicitly opened** private
  panel that lists ONE bounded page of the course's unit metadata and can
  create, rename, reorder, archive and reactivate a unit through the accepted
  176 API, with truthful denials, errors and unknown-write outcomes.
- Unchanged: the course controller, the course form, the course list, the
  price/enrollment logic, the shared transport, the shared request/auth/error
  and session helpers, and every backend file.

## Exact six allowed paths

| Path | Change |
| --- | --- |
| `src/lib/api-http.ts` | Additive ONLY: `CourseUnit`, `CourseUnitStatus`, `CourseUnitListEnvelope`, `CourseUnitEnvelope`, `COURSE_UNIT_PAGE_LIMIT = 25`, `listCourseUnits`, `createCourseUnit`, `updateCourseUnit`. No shared request/auth/error/session line was touched. |
| `src/features/catalog/course-units.ts` | NEW — the injected production controller/lifetimes (no React). |
| `src/features/catalog/CourseUnitManager.tsx` | NEW — the dedicated accessible Arabic/RTL component (render only). |
| `src/pages/Courses.tsx` | Additive import + keyed mount inside the existing details dialog + `max-h-[85vh] overflow-y-auto` on the dialog content. No course controller/form rewrite. |
| `src/tests/m2-course-unit-ui.test.ts` | NEW — hermetic real transport/controller/component tests. |
| `docs/streams/client/M2-09-CONTRACTS.md` | NEW — this file. |

## Transport contract (canonical, additive)

Prefix `/api/tenants/me/catalog/courses/:courseId/units`; the server mounts the
unit router at `/catalog` under `/api/tenants/me`.

- `GET .../units?limit=25[&cursor=...]` → `{ units: CourseUnit[], next_cursor: string | null }`.
- `POST .../units` body `{ name }` **plus an optional `display_order` NUMBER**.
  The server refuses a numeric string, a float and a boolean, so the adapter
  only ever sends a JSON number, and the controller only sends the field when
  the user typed one (otherwise the server default `0` applies).
- `PATCH .../units/:unitId` body: a non-empty subset of `{ name }`,
  `{ display_order }`, `{ status }`. The controller sends only the fields the
  user actually changed, so a rename never carries a position and an archive
  never carries a name.
- No client tenant selector in any header, query or body: the server selects
  the tenant and re-verifies the real owner row. The course id in the path is
  a **resource id**, never a tenant authority.
- The shared transport still throws the server's `error` message WITHOUT the
  HTTP status and WITHOUT the `code`, so only documented messages classify an
  outcome. The canonical BILLING_ONLY identity event + redirect and the
  canonical TENANT_SUSPENDED teardown are preserved and asserted.

## DTO contract (strict runtime validation)

The unit DTO is exactly seven server-projected fields —
`{ id, course_id, name, display_order, status, created_at, updated_at }` — and
the row is never spread. The controller accepts a unit only when:

- `id` is a UUID;
- `course_id` is EXACTLY the course the controller is bound to (a unit of
  another course is refused);
- `name` is a string that trims to 1..255 characters;
- `display_order` is a JSON number that is already an integer in
  `0..2147483647`;
- `status` is exactly `active` or `archived`;
- both timestamps are strings;
- the key set is EXACTLY the seven projected fields.

The list envelope is exactly `{ units, next_cursor }` and the write envelope is
exactly `{ unit }`. The **response** page bound is checked BEFORE any row is
traversed or copied: a body with more than 25 rows is a malformed response,
never a held page and never a silently truncated one. The opaque cursor is
bounded like the server bounds it — it must be `null` or a non-empty string of
at most 256 characters — so a cursor outside that bound is a malformed
response and is never sent back to the server. The position parser refuses a
sign, a decimal point, an exponent, whitespace-only input and Arabic-Indic
digits — exactly what the server refuses.

## Documented server answers (the only classification signals)

| Outcome | Transported message | Phase / reason |
| --- | --- | --- |
| Expired / invalid session | `Token expired`, `Invalid token`, `No token provided`, `Session revoked`, `Selected workspace is no longer active` | `unauthorized` / `session` |
| Suspended account | `Instructor account is administratively suspended` | `denied` / `suspended` |
| Billing-only restriction | `Course unit management is not available while the account is limited to billing and support` | `denied` / `billing-only` |
| Not the owner | `Forbidden` | `denied` / `not-owner` |
| No workspace | `Tenant membership not found` | `no-workspace` / `no-workspace` |
| Missing / foreign / inactive course | `Course not found` | `missing-course` / `missing-course` |
| Missing / foreign unit | `Course unit not found` | write `missing` |
| Concurrent modification | `Course unit was modified concurrently` | write `conflict` |
| Strict payload rejection | `Invalid course id`, `Invalid course unit id`, `Invalid course unit payload`, `Invalid course unit update payload`, `Invalid course unit list limit`, `Invalid course unit list cursor` | write `invalid` |
| Handler failure | `Failed to list course units`, `Failed to create course unit`, `Failed to update course unit` | read `error`/`server`, write `uncertain` |

A discarded `code` is never turned into a permission outcome, and no HTTP
status is ever fabricated.

## Lifetimes (the fences)

- **course** — the controller is created for ONE course id and that binding is
  immutable for its lifetime; every request carries it. A different course is
  a different controller (the dialog mounts the panel with `key={course.id}`),
  so an old course completion can never affect another selected course.
- **page** — every list read advances a page generation; a reversed or
  superseded reply never commits. At most ONE page (≤25 rows) is held.
- **request** — every mutation advances its own request generation and takes a
  synchronous single-flight latch BEFORE the first await, so a double click or
  Enter never sends a second write. The latch is released as soon as the server
  CONFIRMS the write — BEFORE the bounded follow-up read is awaited — so the
  READ never holds the MUTATION latch: an ENABLED control (for example the real
  row archive button) is never a silent no-op while the refresh is on the wire.
  A second write is still refused while an actual write request is on the wire,
  and the older `finally` can never release a NEWER mutation's latch (the
  ticket source is monotonic and every release carries its OWN ticket).
- **form** — opening, editing, cancelling or invalidating a form advances the
  form generation, so a late reply never rewrites or closes a newer form and a
  newer draft is never overwritten by an older confirmed save.
- **authorization** — a DEFINITE read authorization or scope loss (session,
  suspension, billing-only, owner-only denial, missing workspace, missing
  course) clears the private rows, the form, the draft, the target and the
  confirmation and retires every in-flight operation, so a late completion
  cannot revive private state. A retryable read failure keeps the draft,
  because no permission loss was proven.
- **session** — the canonical principal (`readCourseSessionPrincipal`) is read
  at entry AND at completion of every read and write, on the success and the
  failure path; a RETIRED operation observes it BEFORE it settles any visible
  state, so a silent logout cannot revive the previous principal's rows.
- **close / dispose** — the panel clears the private rows, the drafts and the
  cursors and drops every in-flight reply. The close control stays USABLE
  while a read is on the wire.

## Honesty rules

- A 2xx body that cannot be validated is NOT a success.
- A PATCH response for another unit id — or for another course — is NOT a
  success for this write: the write stays explicitly UNCERTAIN, nothing is
  committed and no retry is sent.
- An unknown write outcome (handler 500, network failure, malformed success)
  is UNCERTAIN: the write MAY have persisted, nothing is retried
  automatically, the draft and the rows are preserved, and a deliberate list
  read is offered. The current list shows the CURRENT state and is never proof
  of the earlier write or its audit. Because duplicate names are allowed, a
  deliberate create retry may create a duplicate unit — the panel says so.
- A definite conflict permits a deliberate retry without an unrelated
  operation first, and the control is NOT latched disabled afterwards.
- A confirmed success uses the validated server DTO only. At most ONE bounded
  first-page read follows a confirmed create or a confirmed reorder (so the
  panel keeps the server's canonical ordering). That follow-up read is a READ:
  it never sends a write, never retries one and never holds the write latch —
  the confirmed mutation's OWN latch ticket is settled BEFORE it is awaited, so
  an enabled control keeps working while the refresh is on the wire. A FAILED
  follow-up read never turns the confirmed save into a failed save: the
  confirmation and the rows survive and the failed refresh is reported
  separately.
- An ENABLED control is never a silent no-op. While a read is on the wire the
  panel may refuse a write — but only by TRUTHFULLY disabling the control; a
  visible control that does nothing when it is enabled is not acceptable.
- The metadata position is a DISPLAY position inside the course. The panel
  states that it never unlocks a lesson, publishes content or changes an
  access right. There is no delete, no lesson, no material, no upload, no
  publish, no access and no paid control.
- The cursor is a POSITION, not a snapshot: a reorder between two reads can
  repeat or omit a row. The panel says so instead of promising a stable
  traversal. There is no invented snapshot token or dedup guarantee.
- No draft or private unit state is persisted outside the component/controller
  lifetime.

## Verification (actual commands and results)

```
.\node_modules\.bin\tsx.cmd --test src/tests/m2-course-unit-ui.test.ts
  → 1..70  # tests 70  # pass 70  # fail 0  # cancelled 0

.\node_modules\.bin\tsx.cmd --test src/tests/m2-course-management.test.ts `
    src/tests/m2-tenant-branches-ui.test.ts src/tests/m2-tenant-profile-ui.test.ts `
    src/tests/m2-tenant-profile-edit.test.ts
  → 1..184  # tests 184  # pass 184  # fail 0  # cancelled 0

.\node_modules\.bin\tsx.cmd --test src/tests/m2-course-unit-ui.test.ts `
    src/tests/m2-course-management.test.ts src/tests/m2-tenant-branches-ui.test.ts `
    src/tests/m2-tenant-profile-ui.test.ts src/tests/m2-tenant-profile-edit.test.ts
  → 1..254  # tests 254  # pass 254  # fail 0  # cancelled 0

.\node_modules\.bin\tsx.cmd --test `
    C:/Users/BaraaWael/TabwebClientSupervisor/179-m2-09-independent-probes.test.ts
  → 1..3  # tests 3  # pass 3  # fail 0  # cancelled 0
    (the UNCHANGED public supervisor probe, read-only, no edit to it)

node node_modules/typescript/bin/tsc -p tsconfig.app.json --noEmit
  → the same 11 pre-existing diagnostics as the pre-change baseline, in
    NotificationBell.tsx, StudentHeader_OLD_BACKUP.tsx, ExamReports.tsx,
    ExamResults.tsx, Fees.tsx, StudentBarcodes.tsx, StudentDashboard.tsx and
    versionChecker.ts. ZERO diagnostics in the six scoped paths.
```

The 184 unchanged tests and the 11 outside diagnostics were measured BEFORE
the change as well, so they are a like-for-like baseline.

What the new suite pins (70 tests): the canonical path/bearer/limit/encoded
cursor and the absence of any tenant selector; the strict request bodies and
the JSON-number position; the transported-message-only error contract with the
preserved BILLING_ONLY identity event and suspension teardown; the strict
seven-field DTO, the foreign-course refusal and the 25/26 response bound; the
documented-message classification; the explicit open with no eager GET; the
one bounded page with next/first paging; the single mutation flight; the
foreign-unit and foreign-course PATCH refusals; the uncertain write with no
automatic write and no automatic read; the deliberate reconciliation; the
denied / conflict / missing / network outcomes; the reversed read; the silent
principal change on the success and the failure path; the session event; the
old `finally` never releasing a newer latch; the superseded mutation; the
newer draft retained over an older confirmed save; close, dispose, the
authorization-loss cleanup and the late pending mutation; and the real
component's controls, bound labels, honest notices, the actual `disabled`
attribute and `type="button"` on every non-submit button.

The 179 correction regressions (6 new tests) pin: a confirmed CREATE releases
its own write latch before the follow-up read, so the real enabled row action
reaches the transport while the bounded GET is pending; the same for a
confirmed REORDER; a write that is REALLY on the wire still excludes a second
write; the older `finally` never releases a NEWER mutation's latch after the
early release; a silent principal change during the pending follow-up read
clears the private rows and the confirmation; and the REAL component tree,
with the REAL controller in its ref, where the actual archive control's
actual callback performs the write instead of being dropped.

## Limits (honest)

- No DOM/browser, no RTL paint and no real end-to-end click: the component is
  rendered with the real React server renderer and the real shared UI
  primitives, and the controller is driven directly. For the 179 correction
  the production element TREE is also rendered with the REAL controller in the
  component's ref, so the real control's real callback is invoked — but that
  is still not a browser event. A real browser session is NOT proven.
- No live HTTP, no database, no services, no migration application: the
  transport is exercised through the real `request` with a stubbed `fetch`,
  `localStorage` and `window`. The accepted migration FILE is NOT applied, so
  a real deployment answers with a truthful error and no rollout is claimed.
- No server-side verification of the 176 handlers from this task: the server
  contract was read from source, and the server suite was deliberately NOT run
  (no DB, no provider, no dotenv, no unsafe server suite).
- The panel does not implement a total order over the units: it shows the
  server's (display_order, id) order of the current page and says that the
  cursor is a position, not a snapshot.
- The client renders the position as a plain number; it does not attempt to
  renumber the other units, because the server's contract renumbers nothing.
- No performance, latency or scalability measurement was made; the page bound
  of 25 rows and the single-page memory bound are structural, not measured.
