# Narrow Barcode acceptance; EditExam lifecycle needs two verified corrections

UTC: 2026-10-16T19:17:25Z. Branch verified `codex/human-client`.
Read coordination README, worker/016 and worker/017, actual EditExam recovery
result and Barcode source/test corrections. Dispatch initially showed no active
owners or ready tasks: predecessors reported and stopped under report protocol.
Native IDs remain unavailable; coordinator reports in-invocation implementation.

## Independent verification and Barcode decision

Existing managed Node22.22.2 + tsx, both authoring and attendance suites:
**119/119 pass** (65 authoring, 54 attendance). Full tsc: **11 known outside-scope
errors, zero scoped page/test diagnostics**, overall command exits nonzero.
No DB, network, browser, provider, installs or Git writes. No worker source edits.

Re-ran external `TabwebClientSupervisor/barcode-race-review.mts` with
`--test-name-pattern supervisor:`: **1/1 pass**; the same real controller sequence
previously failed after a refresh failure repopulated absent rows.
Source confirms dependent absent guard invalidation plus load-state reset after
authoritative failure and refreshed snapshot commit, and teardown reset. Existing
explicit payment/availability consumers and merged scope maps are preserved.
Success-path dependent loading reset is appropriate; no speculative change needed.
Unknown is not monetary authority; current handling does not change billing rules.

Accepted `client-m1-barcode-refresh-race-20261016-03` narrowly for completed 021/022
recovery, recording evidence in task state and supervisor ledger. This does not
accept all attendance flows or all M1. No new Barcode task or unrelated optimization.
Previously documented calendar/performance contracts remain separate limitations.

## EditExam source and real production counterexamples

`client-m1-edit-recovery-20261016-01` is NOT accepted despite 65 passing tests.
The new runEditExamOperation is actually wired into handlers, but two correctness
gaps remain in those same approved lifecycle requirements:

1. **List deletion loses its outcome:** handleDeleteQuestion passes the question
   ID as operation target; isEditExamOperationCurrent requires that ID to be the
   currently open editor. The list Delete button is outside the editor, normally
   with editingQuestionId=null. The server DELETE succeeds but lifecycle returns
   superseded without reloading or displaying success; failures also disappear.
   Separate list-delete operation authority from editor form identity while
   preserving route/operation fencing and duplicate-write suppression.
2. **Reopened draft revives old upload:** target identity is only question ID or
   boolean addingNewQuestion. Closing/reopening the new form within one route
   changes true->false->true, leaving route generation unchanged. An old upload
   then commits into the new draft. Same-ID editor ABA has the analogous gap.
   Actual form/draft lifetimes need a generation invalidated by open/close/switch/
   reset, consumed by the production handlers; equality of current target alone
   is insufficient.

External isolated reproduction preserved at
`C:/Users/BaraaWael/TabwebClientSupervisor/edit-lifecycle-review.mts`, reusing
existing test harness/import isolation and ACTUAL exported lifecycle, not copied
implementation. Run existing managed Node22.22.2 + tsx with
`--test --test-name-pattern supervisor:` and that file:
**2 tests / 2 failures**. Successful list-delete outcome actual `superseded`,
expected `committed`; close/reopen pending upload actual `committed`, expected
`superseded`. No source/test under worker ownership modified for reproduction.

Source also shows latestCommitted only advances after success: review ordering
of older upload completion after newer upload failure, and old failure after newer
success. These are original stale-result requirements, not new product behavior.
Preserve normal same-scope uploads/reloads and retained failed-save input.

## Prepared bounded continuation

Created scope-hashed approved `client-m1-edit-target-lifecycle-20261016-01`, ONLY:
`src/pages/EditExam.tsx`, `src/tests/m1-expanded-exam-authoring-ui.test.ts`.
Previous EditExam worker reported/stopped before creation. New task ready via
sanitized dispatch; Codex did not claim or launch a replacement worker.

WorkBuddy: inventory/preserve partial code, fix the actual list-delete and target
lifetime paths, add deferred production allow/reject/failure regressions, verify
full scoped types and report promptly. No weakening shared currentness checks to
make deletion pass; use appropriate operation authority. No TeacherExams edits,
backend/shared/router/package/config changes, new policies, M2 or live services.
Keep native ownership observable and report genuine IDs or explicit limitation.

Finite remaining correction: this EditExam lifecycle follow-up, then consolidated
stable original-checklist verification. No whole M1 completion or self-acceptance.
Schedules continue; no 429 or new human intervention blocker observed.
