# M2-09 follow-up latch correction — implemented, tested and reported

- Task: `client-m2-09-followup-latch-correction-20261021-01` (frontend, write
  access, `implementationWorker=opencode`, `taskKind=correction`), batch M2-09.
- Worker: `opencode-worker-m2-09-followup-latch-20261021`, claimed once through
  `tabweb_supervisor.next_approved_task` (the only OpenCode task in the ready
  queue). No other task was claimed, created or inferred; the WorkBuddy backend
  task `client-m2-b05-lesson-catalog-20261021-01` was NOT touched.
- Native session id: this invocation did not expose a native session id, so
  none is claimed.
- Consumed: `docs/streams/client/OPENCODE-WORKER.md`,
  `docs/streams/client/coordination/README.md`, supervisor/179, supervisor/180,
  supervisor/177, supervisor/178, `docs/streams/client/M2-09-HANDOFF.md`,
  `docs/streams/client/M2-09-CONTRACTS.md`, the unchanged public probe
  `C:/Users/BaraaWael/TabwebClientSupervisor/179-m2-09-independent-probes.test.ts`
  (read only, not edited).
- Branch `codex/human-client`. No Git write, no deploy, no install, no service,
  no DB, no browser, no live network, no migration application. Every
  uncommitted accepted change (M2-02/05/06/07/08 and the 176 backend slice)
  was preserved untouched.

## Exact changed paths (three of the six allowed paths)

1. `src/features/catalog/course-units.ts` — the correction. In `runMutation`
   the confirmed write's OWN latch ticket is now settled BEFORE the bounded
   follow-up read is awaited, and the `finally` releases that same ticket at
   most once. Nothing else in the controller changed: the DTO validation, the
   classification, the page/form/request/principal generations, the epoch
   fence, the authorization-loss cleanup, the uncertain-write handling and the
   reconciliation are byte-for-byte as accepted.
2. `src/tests/m2-course-unit-ui.test.ts` — 6 new regressions (64 → 70 tests).
3. `docs/streams/client/M2-09-CONTRACTS.md` — the corrected latch contract, the
   honest verification counts and the new limits.

`src/pages/Courses.tsx`, `src/features/catalog/CourseUnitManager.tsx` and
`src/lib/api-http.ts` were NOT changed: the defect was in the controller's
latch lifetime, not in the component's disabled attribute or in the transport.

## Root cause (found in the actual partial source, not guessed)

`runMutation` awaited `runRead(null, 'post-write')` INSIDE its `try`, so
`writeGuard.release(ticket)` only ran in the `finally` — AFTER the follow-up
GET resolved. The finished create therefore still held the MUTATION latch
while the refresh was on the wire. The panel state was already truthful
(`mutation.status === 'idle'`, so the row archive button was ENABLED), but
`setStatus` -> `runMutation` -> `writeGuard.acquire()` failed and returned
silently: the enabled user action disappeared with no request and no message.
The same held the latch after a confirmed REORDER.

## Before / after behaviour

- **Before**: after a confirmed create (or reorder) the panel waited for the
  automatic first-page GET while still holding the write latch; any enabled
  row action clicked in that window was silently dropped — no PATCH, no error,
  no state change. The drop could last as long as the GET.
- **After**: the confirmed mutation releases its OWN ticket before the bounded
  follow-up read is awaited, so the read never holds the write latch. The
  enabled archive control now sends exactly ONE explicit PATCH while the
  refresh is pending. The confirmed save stays confirmed, the rows survive a
  failed refresh, and the real in-flight write exclusion is unchanged: a
  second write is still refused while an actual write request is on the wire.
- **Unchanged**: everything else — the strict seven-field DTO, the 25-row
  response bound, the one bounded page, the documented-message classification,
  the principal/page/form/request/epoch fences, the authorization-loss cleanup,
  the uncertain-write contract (no automatic retry, no automatic read), the
  single follow-up GET, the accepted 176 backend contract, the shared
  transport, course management, price and enrollment.

## Owner-ticket safety (the fence that had to survive the early release)

- The ticket source is monotonic and shared, so every ticket is unique. A
  release carries its OWN ticket: `writeGuard.release(ticket)` frees the latch
  only while that ticket still owns it.
- The mutation releases at most once (`writeTicketReleased`), so the older
  `finally` after the early release is a no-op and can never free a NEWER
  mutation's latch. This is pinned by a new regression.
- The lifecycle retire paths (`retireInFlight`, close, dispose, session event)
  still release unconditionally, as before.

## Request counts and bounds (unchanged by this correction)

- One GET per explicit open, one GET per paging/refresh action, at most ONE
  extra bounded first-page GET after a confirmed create or reorder, one GET for
  a deliberate reconciliation. No polling, no totals, no all-page drain.
- At most one page is held (≤25 rows); an oversized response is refused before
  a row is copied.
- At most ONE write is in flight; the latch is taken before the first await and
  the confirmed write releases it before the follow-up read.

## Validation — actual commands and results

```
.\node_modules\.bin\tsx.cmd --test src/tests/m2-course-unit-ui.test.ts
  → 1..70   # tests 70   # pass 70   # fail 0   # cancelled 0   # skipped 0

.\node_modules\.bin\tsx.cmd --test src/tests/m2-course-management.test.ts `
    src/tests/m2-tenant-branches-ui.test.ts src/tests/m2-tenant-profile-ui.test.ts `
    src/tests/m2-tenant-profile-edit.test.ts
  → 1..184  # tests 184  # pass 184  # fail 0   # cancelled 0  # skipped 0

.\node_modules\.bin\tsx.cmd --test src/tests/m2-course-unit-ui.test.ts `
    src/tests/m2-course-management.test.ts src/tests/m2-tenant-branches-ui.test.ts `
    src/tests/m2-tenant-profile-ui.test.ts src/tests/m2-tenant-profile-edit.test.ts
  → 1..254  # tests 254  # pass 254  # fail 0   # cancelled 0  # skipped 0

.\node_modules\.bin\tsx.cmd --test `
    C:/Users/BaraaWael/TabwebClientSupervisor/179-m2-09-independent-probes.test.ts
  → 1..3    # tests 3    # pass 3    # fail 0   # cancelled 0  # skipped 0
    (the UNCHANGED public supervisor probe; read-only, not edited by this task.
     It was 2/3 before this correction — the archive-action probe failed — and
     is 3/3 now.)

node node_modules/typescript/bin/tsc -p tsconfig.app.json --noEmit
  → 11 errors, the SAME 11 pre-existing outside diagnostics as the accepted
    baseline (NotificationBell.tsx x1, StudentHeader_OLD_BACKUP.tsx x2,
    ExamReports.tsx x2, ExamResults.tsx x1, Fees.tsx x2, StudentBarcodes.tsx x1,
    StudentDashboard.tsx x1, versionChecker.ts x1). ZERO diagnostics in the six
    scoped paths, including the changed controller and the new tests.
```

The 184 unchanged tests and the 11 outside diagnostics are the like-for-like
baseline of the accepted 176/070 work, so the comparison is exact.

The 6 new regressions pin: the confirmed CREATE releases its own latch before
the follow-up read (the real enabled row action reaches the transport while
the GET is pending); the same for a confirmed REORDER; a write that is REALLY
on the wire still excludes a second write; the older `finally` never releases
a NEWER mutation's latch after the early release; a silent principal change
during the pending follow-up read still clears the private rows, the form and
the confirmation; and the REAL production component tree with the REAL
controller in its ref, where the actual archive control's actual callback
performs the write instead of being dropped.

## Remaining limitations (honest)

- No DOM/browser, no RTL paint and no real browser event: the component is
  rendered with the real React server renderer and the real shared UI
  primitives, and for this correction the production element TREE is rendered
  with the real controller in its ref so the real control's real callback is
  invoked. A real browser session is NOT proven.
- No live HTTP, no database, no services, no migration application: the
  transport runs through the real `request` with a stubbed `fetch`,
  `localStorage` and `window`. The accepted migration FILE is NOT applied, so
  no runtime unit rollout is claimed.
- The server suite was deliberately NOT run from this client task (no DB, no
  provider, no dotenv, no unsafe server suite); the 176 contract was read from
  source.
- No performance, latency or scalability measurement was made. The 25-row page
  bound and the single-page memory bound are structural, not measured.
- The correction is bounded to the write-latch lifetime. It does not change
  the paging notice, the mutable-cursor honesty, the uncertain-write contract
  or any server behaviour.

## Scope statement

Only three of the six allowed paths were written. No backend, router, auth,
shared helper, schema, package, config or provider file was touched; no
migration was applied; no service, DB, browser or provider was started; no
dependency was installed; no Git write or deploy was performed; no timer or
schedule was created, enabled, paused or modified. The public 179 probe file
was read and executed, never edited. The claim is NOT self-accepted: Codex
decides acceptance. All edits and checks were stopped before this report.

## Scheduling (read only, nothing changed)

- `Tabweb-OpenCode-Worker-15min`: **State = Disabled**, `NumberOfMissedRuns =
  111`. `Get-ScheduledTaskInfo` still reports a `NextRunTime` of
  2026-10-21 00:48:58 Cairo, but because the task is Disabled that value will
  NOT fire, so there is no scheduled worker check to promise. The next worker
  run happens only when Codex dispatches the native CLI again.
- Codex review cadence: every 15 minutes (supervisor/180). The next
  independent review of this report is expected on that cadence, not on the
  disabled worker timer.
- No schedule was created, enabled, paused, disabled or modified by this task.
