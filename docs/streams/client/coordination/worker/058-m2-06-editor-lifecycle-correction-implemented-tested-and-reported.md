# M2-06 editor lifecycle + response identity correction — implemented, verified and reported

**Task:** `client-m2-06-editor-lifecycle-correction-20261019-01` (same-five-path
correction of supervisor136 findings F1/F2 over the stopped/reported057
predecessor).
**Worker:** `opencode-worker-058` (native claim taken once in this session; no
re-claim, no second worker, no ownership transfer, no retirement).
**UTC:** 2026-10-19T16:21Z — **Branch:** `codex/human-client`.
Native session ID is not exposed by the available tooling; the run continued in
the same native conversation context and the original claim token from that
context remained usable, so no private claim file was read.

## Changed paths (within the five allowed paths + this coordination report)

- `src/features/tenant/profile.ts` — the only product file changed in this
  correction. (a) F1: operation-owned lifetime settlement separate from the
  profile-data generation fence — `settleReadPhase` lets a retired read settle
  only the `loading` phase it opened (never a newer read/write's phase, never
  a stale payload), and `settleSupersededSave` lets a retired save settle only
  the `saving` state it owns (draft preserved; the real denial/conflict message
  shown; an unknown outcome stays explicitly `uncertain`; no success claim, no
  rollback claim, no automatic PATCH retry, no extra read). (b) F2: the form is
  bound to the exact confirmed `tenant.id` captured at `openEditor`; a
  well-formed PATCH DTO for another institution is never committed and never
  closes the form (it stays `uncertain`, draft kept); a current read that
  changes the confirmed institution invalidates the open form and no write is
  sent afterwards; the save itself is refused when the form's target is not the
  confirmed identity. No tenant selector, no owner flag, no shared
  request/auth/error change.
- `src/tests/m2-tenant-profile-edit.test.ts` — 7 new hermetic production-path
  regressions (30 tests total) for the two findings.
- `docs/streams/client/M2-06-CONTRACTS.md` — new section 8 (F1/F2 semantics,
  coverage limits) and refreshed evidence section 5.
- This report only in `docs/streams/client/coordination/worker/`.

`src/pages/InstructorDashboard.tsx` and `src/lib/api-http.ts` were **not**
modified in this correction (last write 18:00 and 17:51 local, before this
run started): the page already renders the resulting states, and the accepted
canonical adapter needs no change. All previously accepted dirty work and the
38-read test package were left untouched.

## Before/after behavior

Before (per supervisor136 probes): a save that a newer refresh superseded left
`edit.status === 'saving'` forever — input/save/cancel disabled and
`openEditor` refused, although every request had settled; a write denial that
superseded an older GET left `phase === 'loading'` forever, hiding a valid
profile and a retained draft; and a well-formed PATCH reply for `tenant-b`
committed to the `tenant-a` card and closed the form as a success.

After: the retired operation settles the state it owns, so the editor returns
to a usable `editing` state with the draft and the real message, the read phase
returns to `ready` with the last confirmed profile, and an unknown write
outcome remains explicitly `uncertain`. A PATCH reply for a different
institution is never committed: the card keeps the confirmed identity, the
draft survives, the form does not close as a success, and nothing is retried
automatically. A current read that changes the confirmed institution
invalidates the open form so no write can be aimed at the wrong institution.

## Verification (actual commands, locally run)

- `node --import tsx --test C:/Users/BaraaWael/TabwebClientSupervisor/136-m2-06-review-probes.test.ts`
  (external supervisor136 probes, absolute path, run unchanged, not copied into
  the workspace) → **3/3 pass**. Before this correction the same command gave
  **0/3** with the three asserted failures (stuck `saving`, stuck `loading`,
  `tenant-b` committed).
- `.\node_modules\.bin\tsx.cmd --test src/tests/m2-tenant-profile-edit.test.ts`
  → **30/30 pass**, 0 fail/cancelled (23 accepted + 7 new).
- Unchanged accepted read suite
  `.\node_modules\.bin\tsx.cmd --test src/tests/m2-tenant-profile-ui.test.ts`
  → **38/38 pass** (file unchanged).
- Nearby shared-helper regression
  `.\node_modules\.bin\tsx.cmd --test src/tests/m2-course-management.test.ts`
  → **61/61 pass** (file unchanged).
- `.\node_modules\.bin\tsc.cmd -p tsconfig.app.json --noEmit` → **zero errors in
  the five scoped paths**; the known **11 outside** diagnostics remain
  (NotificationBell, StudentHeader_OLD_BACKUP×2, ExamReports×2, ExamResults,
  Fees×2, StudentBarcodes, StudentDashboard, versionChecker) — the same set
  recorded before this correction. Wrapper exit code 2 (errors present);
  no pre-change measurement was captured in this session, only the current one.
- `.\node_modules\.bin\eslint.cmd src/features/tenant/profile.ts src/tests/m2-tenant-profile-edit.test.ts src/pages/InstructorDashboard.tsx src/lib/api-http.ts`
  → zero problems in `profile.ts` and the new test package; the 11 reported
  problems (10 `no-explicit-any` + 1 `react-hooks/exhaustive-deps` warning) are
  on unchanged legacy lines of `api-http.ts` (2102-2214) and
  `InstructorDashboard.tsx` (79, 80, 119, 143).
- `git diff --check -- src/lib/api-http.ts src/pages/InstructorDashboard.tsx`
  → exit 0.
- Request-count evidence (numbers, not timings): one PATCH per explicit save;
  a superseded save issues **no** extra PATCH and no extra GET; the deliberate
  user retry after recovery issues exactly one PATCH; a confirmed write issues
  no extra GET; a foreign-institution reply issues no PATCH at all; an
  invalidated form issues no request.

## Limitations / blockers

- No DOM/RTL/browser, no real HTTP/DB/provider/live service: the controller
  and the canonical transport are exercised hermetically with a fake fetch.
  No performance, latency or scalability claim is made.
- Real row locking, commit ambiguity and audit rollback remain server
  integration concerns; the accepted129 write contract was not re-run here.
- A retired save that the server confirmed settles as a usable `editing`
  state (no success is claimed and no rollback is claimed); the card keeps the
  newer read, so a user may re-save deliberately — a server-side no-op when the
  name already matches. This is stated in the contracts doc, not hidden.
- Tooling note: the file-edit/read tooling in this run intermittently served a
  stale snapshot and once re-applied an append, which duplicated the new test
  block. This was detected by line counting plus a duplicate-declaration count,
  the duplication was removed, and the final state was re-verified (907 lines,
  exactly 30 `test(` declarations, 30/30 pass). `profile.ts` was re-checked the
  same way after the same symptom appeared there (one `settleSupersededSave`,
  one `settleReadPhase`, one `closeEdit`).
- Work is stopped. Codex independently reviews the stable source, contracts,
  tests and types and decides acceptance; this report is not self-acceptance.

## Schedule

Next scheduled **check** (not a guaranteed implementation start):
**2026-10-19 19:33:58 Africa/Cairo (UTC+3)**, about **13 minutes 32 seconds**
from 19:21:29 local at report-writing. `Get-ScheduledTaskInfo` reports
`NextRunTime 19:33:58`, `LastRunTime 19:18:59` (result 0) and the task state
was `Ready` with `MultipleInstances = IgnoreNew`; the schedule was not
changed.
