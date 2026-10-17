# Barcode refresh-race fixed and reported (client-m1-barcode-refresh-race-20261016-03)

UTC: 2026-10-16T19:09Z. Branch verified `codex/human-client`.
Consumes `supervisor/022-barcode-production-refresh-race-not-accepted.md` (19:02Z). Note: 022 records
the latest worker MD as 015; `worker/016-two-recovery-tasks-completed-and-reported.md` (19:01Z) was
already on disk when this run started and is the reply 022's barcode findings answer for the
predecessor task `client-m1-barcode-recovery-20261016-03`.

## Queue facts (one `queue_status`, one `dispatch_plan`, this run)

- `queue_status` once at 19:03Z: active = [] (the EditExam reservation 022 observed changing is
  indeed gone), ready = `client-m1-barcode-refresh-race-20261016-03` (frontend, write), blocked = [],
  upgradePending false, maxActive 48 / maxPerTeam 6.
- `dispatch_plan` once (ready task exists). No conflicts.
- One claim via `next_approved_task`, unique workerId `wb-barcode-refresh-race-03a`; allowedPaths
  verified from the claim before any edit and never exceeded:
  `src/pages/BarcodeAttendance.tsx`, `src/tests/m1-sprint-attendance-ui.test.ts`.
- Native session/run IDs unavailable: the implementation ran inside this coordinator invocation
  (no spawned child processes), exactly as the predecessor run recorded. No fabricated mapping.
- No 429, no tool-guard error, no account/model change, no retry loop.

## The defect (as reproduced by the supervisor and confirmed by code read)

`createBarcodeAttendanceController` (src/pages/BarcodeAttendance.tsx): the today-load failure path
called `clearCommitted()` — retiring `committedRows`/`todayCommitted` and both lookup maps — but
never invalidated `absentGuard`. An in-flight `loadAbsentStudents()` loop therefore kept a current
token, resumed its superseded nested reads after the authoritative attendance refresh had failed,
and republished `absentRows` plus the payment / last-attendance maps on top of the cleared state.
The two loaders' separate guards meant the today guard could not protect the absent computation.

## The fix (small, targeted; every 021 correction preserved)

- New `fenceDependentAbsentLoads()` inside the controller: `absentGuard.invalidate()` plus a
  coherent reset of the dependent absent loading state (`{ loading: false, error: null }`).
- Called in two places:
  1. **Snapshot change (success path):** immediately after a today load commits a refreshed
     snapshot, before that load's own nested reads run — an attendance snapshot change supersedes
     absent computations derived from the previous snapshot.
  2. **Authoritative failure:** right after `clearCommitted()` in the today-load `catch` — the
     snapshot the dependent computation relied on no longer exists.
- `invalidate()` (unmount/teardown) now also calls `resetLoadStates()` so no loading flag lingers
  after teardown.
- Untouched by design: canonical auth adapter, explicit paid/unpaid/unknown payment decisions,
  honest `_unavailable` / `_attended: null`, scope-keyed merged maps, single-flight scan submission,
  failed-input retention, date conventions, the today loader's own currentness (todayGuard), and
  every other file in the tree.

## Tests added (production controller, deferred transport, no copied implementation)

Four regressions appended to `src/tests/m1-sprint-attendance-ui.test.ts`, driven by the existing
injected harness:

1. **Exact supervisor/022 sequence:** successful empty today load → absent computation holding its
   nested previous-attendance read → refresh whose main request fails offline → the old absent
   nested read resolves. Asserts absentRows/maps stay empty, todayLoad error is the honest network
   classification, absentLoad is cleared, and **zero reads are issued after the fence**.
2. **Successful refresh** fences an in-flight absent computation derived from the previous
   snapshot (late nested read must not commit).
3. **Scope clear without a replacement request** fences an in-flight absent computation.
4. **Unmount invalidation** fences an in-flight absent computation.

## Verification (2026-10-16T19:07–19:09Z)

- `src/tests/m1-sprint-attendance-ui.test.ts`: **54/54** (was 50/50) — managed Node v22.22.2
  (`C:/Users/BaraaWael/.workbuddy-ai/binaries/node/versions/22.22.2-6/node.exe`) +
  `node_modules/tsx/dist/cli.mjs --test`.
- All 7 `src/tests` suites together: **295/295**.
- `tsc -p tsconfig.app.json --pretty false`: **11 diagnostics, identical to the pre-existing
  out-of-scope set** (NotificationBell, StudentHeader_OLD_BACKUP, ExamReports, ExamResults, Fees,
  StudentBarcodes, StudentDashboard, versionChecker); **zero** in either scoped file.
- Supervisor's independent external reproduction
  `C:/Users/BaraaWael/TabwebClientSupervisor/barcode-race-review.mts`, re-run with the same managed
  runtime: **1 test, 1 pass, 0 fail**, emitting `rows: [], loadFailed: true` (before the fix the
  supervisor recorded the assertion failure with both students repopulated).
- Read-only git: 24 tracked modified files, 8378 insertions / 1018 deletions (was 8239/1018); only
  the two allowedPaths changed this run; all pre-existing dirty work — including the EditExam files
  022 flagged as changed mid-review — preserved untouched. No git writes.

## Limitations / open items for the supervisor

- Native session/run IDs: unavailable this invocation; coordinator-hosted implementation, no
  children spawned, nothing claimed on anyone's behalf.
- This report is **reported, not accepted**; no self-acceptance and no next phase assumed.
- No position taken on the EditExam task's state change 022 observed mid-review — no EditExam file
  was read for editing, claimed, or modified here.
- Design decision worth a supervisor nod: the fence on the **success** path both invalidates the
  dependent guard and resets the absent loading state (coherent with the failure path); if the
  supervisor prefers success-path fencing limited to guard invalidation, that is a one-line change.
- The standalone backend/performance contract notes and the open items from earlier worker messages
  (offline-course endpoint, meeting-link reactive auth, DOM harness, BarcodeAttendance UTC/local
  date semantics) remain out of scope and untouched.
