# M2-03 retry path (072) claimed, fixed, verified, reported

UTC 2026-10-18T18:34Z / Cairo 21:34. Branch `codex/human-client`.

## Messages consumed

- `supervisor/071-m2-03-correction-claimed-awaiting-submission.md` (18:00:34Z) —
  observation only: the 070 task was claimed by `…-02a` and awaited a stopped
  submission. No action requested.
- `supervisor/072-m2-03-refresh-retry-not-accepted.md` (18:16:54Z) — GOVERNING:
  the 070 fixes are accepted as resolved findings, but the page's actual Retry
  method was still destructive; finite correction task
  `client-m2-03-refresh-retry-preservation-20261018-03` prepared.
- `worker/040` (this stream's previous reply) already consumed 069/070. Nothing
  between 040 and 071/072 was read; no message was overwritten or deleted.

## Claim / run mapping

- `queue_status` once at 18:31Z: active `[]`, ready
  `client-m2-03-refresh-retry-preservation-20261018-03`, blocked `[]`,
  upgradePending false, maxActive 48 / maxPerTeam 6.
- `dispatch_plan` once (advisory, same single ready task).
- One claim, one worker: workerId `wb-m2-03-refresh-retry-preservation-03a`,
  team `frontend`, taskId as above. `approval.by = human`, approvalVersion 2,
  basis = the same human 068 M2-03 four paths. No second worker, no nested
  spawn, no preclaim.
- allowedPaths verified before any edit, exactly the four 068 paths:
  `src/pages/CourseContentManager.tsx`,
  `src/features/catalog/material-management.ts`,
  `src/tests/m2-material-management.test.ts`,
  `docs/streams/client/M2-03-CONTRACTS.md`. Nothing outside them was edited.
- No sessionId was available to this invocation and no native run mapping
  exists to report; that is stated rather than invented. The claim token stayed
  in memory only — it is in no file, report, message or note.

## Defect fixed (072, confirmed on the actual production seam)

`src/features/catalog/material-management.ts` `refresh()` unconditionally called
`runMaterialsLoad(courseId, 'list')`. Both page Retry buttons call exactly this
method, so after a server-confirmed create whose follow-up read came back
malformed (070 already preserved the rows there), pressing Retry re-entered the
*initial-load* branch: the repeated malformed/rejected reply wiped
`materials` to `[]`, moved the phase to `error` and turned a confirmed write
into what looks like a lost list — the blind re-creation invitation 070 removed
from the automatic follow-up path.

Fix — one dispatch decision, no lifecycle rewrite, no new abstraction:

- `refresh()` now chooses the intent by what is actually on screen. A selection
  holding confirmed rows is re-read as `'refresh'`: a malformed or rejected
  reply is reported on `refreshError` alone, the rows stay, `phase` stays
  `ready`/`empty`, `createError` stays null, and no create is issued.
- A selection with no confirmed rows has nothing to protect, so the retry stays
  `'list'` and keeps the documented honest `loading` → `empty`/`error` outcome
  instead of a fake successful empty list.
- A successful retry replaces the rows and clears `refreshError`; course and
  session transitions still clear the list, so no stale rows survive a scope
  change.

Follow-on copy fix inside the same path: the page's `refreshError` banner said
"تم حفظ التغيير" ("the change was saved"). That claim is now false when the
failure comes from a retry that follows no write, so it reads
"تعذر تحديث القائمة؛ المعروض الآن هو آخر حالة أكدها الخادم" — accurate in both
cases and still never presenting a confirmed write as a failed one.

## Verification (local, hermetic, no live anything)

- `src/tests/m2-material-management.test.ts` **42/42** (was 39; +3: the exact
  072 scenario with the page's method, repeated rejection then recovery, and an
  empty confirmed list staying an honest initial load). No existing assertion
  was weakened or removed.
- All 13 client files **511/511** (baseline 508).
- Supervisor's own out-of-repo probe
  `C:/Users/BaraaWael/TabwebClientSupervisor/072-material-refresh-retry.mts`:
  **40/40** full file; the selected test that was **0/1** (`supervisor072 retry
  after malformed refresh must preserve confirmed list again`) now passes.
- `070-material-lifecycle.mts`: **32/32**, no regression (old-course latch and
  preview ownership intact).
- `tsc -p tsconfig.app.json --noEmit`: **zero** diagnostics in the four scoped
  paths, same **11** pre-existing outside errors, command still nonzero (exit 2).
- Not proven: rendered DOM/RTL paint, real HTTP, real DB, live services,
  end-to-end authorization. No jsdom/happy-dom/@testing-library exists in
  `package.json` and installs are forbidden, so the retry is proven through the
  production seam the page calls, not through a mounted component.

## Blockers / open items (not claimed here)

- `068`'s developer-1 server contract requests remain unanswered by this worker:
  outside this task's allowedPaths and outside client ownership. Tracked as
  narrow future blockers only.
- The upload/provider surface is still not approved: external video stays
  honestly refused, `video://` only when already supplied, and the Drive
  conversion endpoint remains a source-confirmed permanent 410.

## Schedule

This batch runs on the existing hourly WorkBuddy automation
(`FREQ=HOURLY;INTERVAL=1`, ACTIVE). This worker cannot pause or edit it and did
not; schedule/runtime/account changes are forbidden by its standing constraints.

## State

Two `task_checkpoint` notes at natural milestones and exactly **one**
`submit_task_report` → `reported` / `awaiting_supervisor`. All work stopped
before the report. A report is not acceptance and no further phase is started.
No git writes (no add/commit/checkout/stash/merge/push), no dependency installs,
no DB/network/browser/Docker/live services, no edits to tasks/state/approvals,
bridge configuration, accounts, runtime or schedules, and no 429 or tool-guard
error in this run. All pre-existing uncommitted work — including the accepted
039/055/067 files — is preserved untouched.
