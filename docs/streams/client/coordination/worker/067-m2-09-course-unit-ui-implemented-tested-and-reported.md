# M2-09 course-unit metadata UI — implemented, tested and reported

- Task: `client-m2-09-course-unit-ui-20261020-01` (frontend, write access).
- Worker: `opencode-worker-m2-09-20261020`.
- Claimed through `tabweb_supervisor.next_approved_task` on 2026-10-20 (the only
  ready task; no other task was claimed and none was invented).
- Native session id: the native CLI did not emit one into this invocation's
  transcript, so none is claimed from the run itself. Supervisor/178 (published
  2026-10-20 00:35 Cairo) records the runtime native session
  `ses_ea9f01701ffekPRuBpOqwOVdRo` for this task and this owner; that is the
  supervisor's record, not a value invented here.
- Consumed: `docs/streams/client/M2-09-HANDOFF.md`, supervisor/176, supervisor/177,
  `docs/streams/server/M2-B04-CONTRACT.md` and
  `server/src/routes/course-units.ts` (read only).
- Branch `codex/human-client`. No Git write, no deploy, no install, no service,
  no DB, no browser, no live network, no migration application. Every uncommitted
  accepted change (M2-02 course controller, M2-05/06/07 profile+branch work,
  M2-08 CSV preview, M2-B04 server slice) was preserved untouched.

## Exact changed paths (six, all inside the approved allowedPaths)

1. `src/lib/api-http.ts` — ADDITIVE ONLY. Added `CourseUnit`,
   `CourseUnitStatus`, `CourseUnitListEnvelope`, `CourseUnitEnvelope`,
   `COURSE_UNIT_PAGE_LIMIT = 25`, `listCourseUnits`, `createCourseUnit`,
   `updateCourseUnit` and their docs. No shared request/auth/error/session line
   was touched, and no existing endpoint was changed.
2. `src/features/catalog/course-units.ts` — NEW. The injected production
   controller: strict DTO/envelope validation, documented-message
   classification, explicit open, one bounded page, single-flight writes,
   page/form/request/principal generations, authorization-loss cleanup,
   uncertain-write handling, reconciliation, disposal.
3. `src/features/catalog/CourseUnitManager.tsx` — NEW. The dedicated accessible
   Arabic/RTL panel. Render only: no request, no cursor, no decision.
4. `src/pages/Courses.tsx` — ADDITIVE ONLY on top of the accepted M2-02 work:
   the `CourseUnitManager` import, the keyed mount inside the existing
   details dialog (`detailsDialogOpen && selectedCourse`, `key={course.id}`),
   and `max-h-[85vh] overflow-y-auto` on the dialog content. The course
   controller, the course form, the course list, the price and the delete
   dialog were NOT rewritten.
5. `src/tests/m2-course-unit-ui.test.ts` — NEW. 64 hermetic tests over the real
   transport, the real controller and the real component.
6. `docs/streams/client/M2-09-CONTRACTS.md` — NEW. The actual contract,
   checks and limits.

## Before / after behaviour

- **Before**: the course-details dialog showed the course fields only; there
  was no unit metadata anywhere in the client.
- **After**: the same dialog mounts a dedicated, explicitly opened private
  panel. Nothing is fetched until the user opens it (no eager GET per course
  card, per dialog or per course list). The panel lists ONE bounded page of
  at most 25 units of that course with next/first navigation, and can create,
  rename, reorder, archive and reactivate a unit through the accepted 176 API.
- **Unchanged**: course management, price, enrollment, the shared transport,
  the shared request/auth/error and session helpers, every backend file, the
  migration FILE (not applied), and the whole C5/M2 scope.

## Architecture and authority

- The server stays the authority. The panel is labelled owner-only; the
  capability is NEVER derived from the local role, the profile, the tenant
  status or the selected course. The selected course id is a RESOURCE id that
  travels in the path; the server selects the tenant and re-verifies the real
  owner row. The client sends no tenant selector at all.
- The controller is created for ONE course id and that binding is immutable for
  its lifetime; the dialog mounts the panel keyed by the course id, so a
  different course is a different controller and an old course completion can
  never affect another selected course.
- The transport is the canonical `request` in `src/lib/api-http.ts`: the
  billing-only identity event + redirect and the suspension teardown are
  untouched, and the server's `error` message still arrives WITHOUT the HTTP
  status and WITHOUT the `code`, so only documented messages classify an
  outcome. No status and no discarded code is ever turned into a permission
  outcome.
- Strict runtime validation: the exact seven-field unit DTO, the exact
  `{ units, next_cursor }` / `{ unit }` envelopes, `course_id` bound to the
  controller's course, a UUID unit id, a trimmed 1..255 name, an integer
  `display_order` in 0..2147483647, `active`/`archived` only, a cursor that is
  `null` or a non-empty string of at most 256 characters, and a **response**
  page bound of 25 rows checked BEFORE any row is traversed or copied.
- Lifetimes fenced: page, request (synchronous single-flight latch taken
  before the first await), form and session/principal generations. The
  canonical principal is observed at entry AND at completion of every read and
  write, on the success and the failure path, and a RETIRED operation observes
  it BEFORE it settles any visible state, so a silent logout can never revive
  the previous principal's rows or drafts.
- Honesty: an unknown write outcome (500 / network / malformed success / a
  PATCH for another unit or another course) stays explicitly UNCERTAIN, is
  never retried automatically and never triggers an automatic read; a deliberate
  reconciliation read shows the CURRENT state and is never proof of the earlier
  write or its audit; duplicate names are allowed by the contract, so a
  deliberate create retry may duplicate and the panel says so; a definite
  conflict permits a deliberate retry without an unrelated operation and the
  control is not latched disabled afterwards.
- At most ONE bounded first-page read follows a confirmed create or a
  confirmed reorder. A FAILED follow-up read never turns the confirmed save
  into a failed save: the confirmation and the rows survive and the failed
  refresh is reported separately (`refreshError`).
- The metadata position is labelled as a DISPLAY position: the panel states
  that it never unlocks a lesson, publishes content or changes an access
  right. There is no delete, lesson, material, upload, publish, access or paid
  control. The cursor is described as a position, not a snapshot; no snapshot
  token or dedup guarantee is invented.
- Nothing is persisted outside the component/controller lifetime.

## Validation — actual commands and results

```
.\node_modules\.bin\tsx.cmd --test src/tests/m2-course-unit-ui.test.ts
  → 1..64   # tests 64   # pass 64   # fail 0   # cancelled 0   # skipped 0

.\node_modules\.bin\tsx.cmd --test src/tests/m2-course-management.test.ts `
    src/tests/m2-tenant-branches-ui.test.ts src/tests/m2-tenant-profile-ui.test.ts `
    src/tests/m2-tenant-profile-edit.test.ts
  → 1..184  # tests 184  # pass 184  # fail 0   # cancelled 0   # skipped 0

.\node_modules\.bin\tsx.cmd --test src/tests/m2-course-unit-ui.test.ts `
    src/tests/m2-course-management.test.ts src/tests/m2-tenant-branches-ui.test.ts `
    src/tests/m2-tenant-profile-ui.test.ts src/tests/m2-tenant-profile-edit.test.ts
  → 1..248  # tests 248  # pass 248  # fail 0   # cancelled 0   # skipped 0

node node_modules/typescript/bin/tsc -p tsconfig.app.json --noEmit
  → 11 errors, byte-identical to the pre-change baseline, all outside the six
    scoped paths (NotificationBell.tsx, StudentHeader_OLD_BACKUP.tsx x2,
    ExamReports.tsx x2, ExamResults.tsx, Fees.tsx x2, StudentBarcodes.tsx,
    StudentDashboard.tsx, versionChecker.ts). ZERO diagnostics in
    src/features/catalog/course-units.ts, src/features/catalog/CourseUnitManager.tsx,
    src/pages/Courses.tsx, src/lib/api-http.ts or src/tests/m2-course-unit-ui.test.ts.
```

The 184 unchanged tests and the 11 outside diagnostics were measured BEFORE
the change as well, so the comparison is like-for-like. The new suite pins the
canonical path/bearer/limit/encoded cursor and the absence of any tenant
selector; the strict request bodies and the JSON-number position; the
transported-message-only error contract with the preserved BILLING_ONLY identity
event and suspension teardown; the strict seven-field DTO, the foreign-course
refusal, the 25/26 response bound and the cursor bound; the documented-message
classification; the explicit open with no eager GET; the one bounded page with
next/first paging; the single mutation flight; the foreign-unit and
foreign-course PATCH refusals; the uncertain write with no automatic write and
no automatic read; the deliberate reconciliation; the denied / conflict /
missing / network outcomes; the reversed read; the silent principal change on
the success and the failure path; the session event; the old `finally` never
releasing a newer latch; the superseded mutation; the newer draft retained over
an older confirmed save; close, dispose, the authorization-loss cleanup and the
late pending mutation; and the real component's controls, bound labels, honest
notices, the actual `disabled` attribute and `type="button"` on every non-submit
button.

## Request counts and bounds

- One GET per explicit open; one GET per paging or refresh action; at most one
  extra bounded first-page GET after a confirmed create or reorder; one GET for
  a deliberate reconciliation. No polling, no totals, no all-page drain, no
  hidden repeated load.
- At most one page is held: ≤25 rows. An oversized response is refused before
  a row is copied.
- At most one mutation is in flight; the latch is taken before the first await
  and released only by its own owner.

## Remaining limitations (honest)

- No DOM/browser and no RTL paint: the component is rendered with the real
  React server renderer and the real shared UI primitives, and the controller
  is driven directly. A real browser session is NOT proven.
- No live HTTP, no database, no services, no migration application: the
  transport runs through the real `request` with a stubbed `fetch`,
  `localStorage` and `window`. The accepted migration FILE is NOT applied, so
  a real deployment answers with a truthful error and no runtime rollout is
  claimed.
- The server suite was deliberately NOT run from this client task (no DB, no
  provider, no dotenv, no unsafe server suite); the 176 contract was read from
  source.
- No performance, latency or scalability measurement was made. The 25-row page
  bound and the single-page memory bound are structural, not measured.
- The panel shows the server's `(display_order, id)` order of the current page
  and does not renumber the other units, because the server's contract
  renumbers nothing.

## Scope statement

Only the six allowed paths were written. No backend, router, auth, shared
helper, schema, package, config or provider file was touched; no migration was
applied; no service, DB, browser or provider was started; no dependency was
installed; no Git write or deploy was performed; no timer or schedule was
created, enabled, paused or changed. The claim is not self-accepted: Codex
decides acceptance. All edits and checks were stopped before this report.

## Scheduling (read only, nothing changed)

- `Tabweb-OpenCode-Worker-15min`: **State = Disabled**. `Get-ScheduledTaskInfo`
  still reports a `NextRunTime` of 2026-10-20 00:48:58 Cairo, but because the
  task is Disabled that value will NOT fire. There is therefore **no scheduled
  worker check** to promise; the next worker run happens only when Codex
  dispatches the native CLI again. The value is reported as the stale
  scheduled next-run time, not as a guaranteed start.
- `Tabweb-Codex-Supervisor-10min`: State = Ready, next run 2026-10-20 00:44:58
  Cairo — the 10-minute Codex review cadence that continues.
- No schedule was created, enabled, paused, disabled or modified by this task.

