# EditExam target-lifecycle corrections completed and reported

UTC: 2026-10-16T20:05Z. Branch verified `codex/human-client`.
Replies to `supervisor/023-barcode-accepted-edit-target-lifecycle-gaps.md` (19:17Z), the only
message new since `worker/017`. Read only that message. No other supervisor or worker message
was read, modified or deleted.

## Queue facts

- `queue_status` once (19:18Z): active empty; ready = `client-m1-edit-target-lifecycle-20261016-01`
  (frontend, write); blocked empty; upgradePending false.
- `dispatch_plan` once (same single ready task; advisory only).
- One claim via `next_approved_task`, workerId `wb-edit-target-lifecycle-01a`, team frontend.
  allowedPaths returned and verified before any edit: `src/pages/EditExam.tsx`,
  `src/tests/m1-expanded-exam-authoring-ui.test.ts`. No duplicate worker, no nested spawning,
  no preclaim. No 429, no tool-guard error. Claim token never written to any file or message.
- Two `task_checkpoint`s (after inventory; after tests green) and exactly one
  `submit_task_report` → `reported` / `awaiting_supervisor`. A worker report is not acceptance.

## Acknowledged decisions from 023

- `client-m1-barcode-refresh-race-20261016-03` narrowly accepted for the completed 021/022
  recovery. Recorded; no new Barcode task and no unrelated optimization attempted.
- `client-m1-edit-recovery-20261016-01` remains not accepted; this continuation task is the
  bounded correction, not self-acceptance.

## Inventory first (nothing overwritten)

Tree baseline before any edit: 24 tracked files, 8378 insertions / 1018 deletions — identical
to the 19:09Z state recorded in `worker/017`. All partial code, both prior reservations and
every other dirty file preserved. The two 023 defects were re-confirmed in source before
touching anything (false-positive check): `handleDeleteQuestion` passed the question ID as the
operation target while `isEditExamOperationCurrent` required that ID to be the currently open
editor (the list button runs with `editingQuestionId=null`), and the target identity carried no
incarnation, so a close/reopen draft (`addingNewQuestion` true→false→true) left route generation
and target equality unchanged.

## Corrections (only the two allowedPaths changed)

1. **List-delete authority separated from editor identity.** A question-id operation target with
   NO open edit form is now list authority: the outcome is gated by route-generation/scope
   fencing and per-question completion ordering only. A successful server DELETE commits its
   reload + success toast; a failure surfaces its reject toast. `handleDeleteQuestion` runs
   inside the existing single-flight guard and the list delete button is disabled while saving,
   so duplicate DELETE writes are impossible. An open editor for a *different* question still
   fences the operation — the edit-target checks were not weakened (covered by a new test).
2. **Real target/draft lifetime incarnations.** `newDraftGeneration` and `editFormGeneration`
   were added to `EditExamOperationState`, are captured in every operation token at start, and
   are advanced by the page at every real form boundary — open/close/switch/reset of the
   new-question draft and of the question editor. Closing/reopening the new draft and
   cancel/reopening the same question editor now retire stale uploads/saves, while normal
   same-scope uploads and reloads still commit. The incarnation check fails closed when a
   generation is absent, so no operation can claim ownership of a form whose lifetime is unknown.
3. **023 reinspect of the commit bookkeeping.** `markCommitted` was evolved to
   `recordCompletion`: the newest completion per target is recorded for success *and* failure,
   so an older upload cannot commit after a newer attempt failed, and a stale failure cannot
   toast over a newer successful result. All prior fencing (canonical auth, route generation,
   operation tokens, form retention, merged behaviors) is preserved.

## Verification

- Scoped authoring suite: **74/74** (65 prior + 9 new deferred production-path regressions:
  list-delete allow / reject / after-route-change / different-editor fence; draft close/reopen
  retire; editor ABA retire; older upload after newer failure; stale failure after newer
  success; normal same-scope allow).
- All 7 `src/tests` suites: **304/304** (was 295/295).
- `tsc -p tsconfig.app.json`: the same **11 pre-existing out-of-scope** diagnostics, zero in
  `src/pages/EditExam.tsx` or the scoped test file (no scoped diagnostics at all).
- Supervisor external reproduction `C:/Users/BaraaWael/TabwebClientSupervisor/edit-lifecycle-review.mts`
  re-run with the exact managed runtime `C:/Users/BaraaWael/.workbuddy-ai/binaries/node/versions/22.22.2-6/node.exe`
  (v22.22.2) + `node_modules/tsx/dist/cli.mjs --test --test-name-pattern supervisor:`:
  **2/2 pass** (was 2 failures: list delete returned `superseded`; the reopened-draft upload
  committed).
- Tree after: 24 tracked files, 8802 insertions / 1021 deletions (was 8378/1018) — only the two
  allowedPaths moved; everything else preserved; no git writes.

## Limitations / notes for the supervisor

- No native session/run ID was available in this hourly invocation (no background workers in
  this session); `wb-edit-target-lifecycle-01a` is the only ownership mapping and is reported
  honestly as coordinator-side.
- The state shape now carries the two generation fields; the page always provides them. The
  preserved 4-field external harness still passes both `supervisor:` tests because the
  incarnation check fails closed when a generation is absent — a harness refresh with the
  generation fields will exercise the same paths positively.
- No TeacherExams, backend, shared, router, package, config, schema, schedule, account or
  bridge change. No M2, no new phases, no self-acceptance. The `reported` status awaits the
  supervisor decision; the next step after acceptance is the consolidated stable
  original-checklist verification noted in 023.
