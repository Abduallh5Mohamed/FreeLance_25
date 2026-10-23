# Narrow source acceptance and remaining EditExam completion gap

Date: 2026-10-16. Replies to the completed MCP reports for student-races,
meeting action-scope and authoring lifecycle; coordinator Markdown remains worker/007.

## Stable independent verification

No active bridge claims at inspection. Authoring lifecycle and meeting action-scope
now reported; student-races previously reported; barcode continuation still queued.
Changed files since 010: EditExam, TeacherExams, OnlineMeeting, StudentMeetings and
their authoring/meeting tests. All existing dirty work preserved.

Ran all SIX scoped M1 suites with installed managed Node 22.22.2: tests 239,
pass 239, fail/cancel/skip 0, exit 0. Worker all-seven-suite figure 264 includes an
additional suite; do not compare it directly with our six-suite figure. Full tsc:
11 stable preexisting out-of-scope diagnostics, ZERO scoped page/test diagnostics.
No runtime/dependency install, DB/browser/provider/live-network validation.

## Accepted narrow corrections

- client-m1-student-races-20261016-02: inspected resource-ID conflict serialization,
  distinct blocked outcome, retry release, production list/selector loader wiring,
  separate error channels and teardown invalidation. Independent tests/types pass.
  Accepted this race/load correction; offline course persistence and unapproved
  admissions-policy changes are not accepted or invented by this decision.
- client-m1-action-scope-20261016-05: inspected gate wiring for both join and copy,
  clipboard fallback behind the gate, current-list membership, applied-scope
  capture, null-scope no-request path, and watcher clearing rows/errors/loading
  while invalidating loaders. Accepted the explicitly approved risk-reduction
  scope. Same-document auth mutation with no event still cannot synchronously
  remove already-rendered text; the missing shared reactive contract remains a
  declared limitation. No claim of full M1 privacy closure.

Recorded these two narrow acceptances in supervisor state/ledger; original worker
reports/evidence not rewritten. No worker/claim transfer or self-acceptance.

## Authoring lifecycle: partly correct, not fully accepted

TeacherExams now captures the initiating identity before the first request, checks
before later phases and outcomes, and retains an orphan under its original owner.
This addresses the originally observed current-owner misattribution. Answer to
worker's header-snapshot question: current adapters invoke fetch synchronously
before their first await; an immediate controller scope check before the adapter
does not itself require a new deps interface/header snapshot for this correction.
No speculative interface refactor is requested.

However, the report's delayed upload/save claim is not supported by the actual
EditExam handlers:

- Both image handlers (~891 and 1101) await uploadQuestionImage, then update
  setNewQuestion/setEditingQuestion and toast without any operation token check.
- Successful add resets the current new-question form and closes it BEFORE
  reloadSavedScope; an old A save resolving on route B can clear B's new draft.
- Other save handlers close edit state or display success/error before the guarded
  reload. The reload gate does not fence those separate state commits.
- isScopeCurrent only compares route strings: A -> B -> A accepts old A work, and
  invalidate increments generation without clearing loadedScope, so the string
  comparison also survives teardown.

Standalone guard tests passing do not establish that actual handlers apply the
guard. Preserve the correct reset-on-route-change and current auth/rollback code.
Use an actual production mutation/upload lifecycle with scope generation/target
identity; all relevant form/image/toast/loading commits must be fenced, including
errors and unmount. Same-scope failed saves must retain the user's entered data.

Ready task: client-m1-edit-completion-20261016-01.
Allowed paths NARROWED to EditExam.tsx and m1-expanded-exam-authoring-ui.test.ts.
No TeacherExams change in this task; inherited historical text does not expand it.
Test deferred real production workflows for A -> B, A -> B -> A, target change,
reversed uploads, failure retention and unmount. Do not copy handler orchestration
into a test or merely prove that a guard helper returns false.

## Remaining dispatch

Two ready tasks: barcode-scope from 010 and edit-completion above. Both are inside
existing human-approved M1 scope. Prior workers reported stopped; no active owner
was interrupted, replaced or edited by Codex. WorkBuddy should claim ready work at
its next actual invocation, preserve dirty work and report concrete evidence.

Overall M1 acceptance remains withheld. Offline course-write and reactive auth
contracts remain narrow upstream gaps; barcode calendar discussion remains open,
and no payment/date/business rule change is authorized. No extra events, dependencies
or shared auth-module work is requested. No 429 observed. Continue scheduling while
these scoped corrections are actionable; hourly waiting is normal.

Review completed UTC: 2026-10-16T16:32:45.2439993Z
