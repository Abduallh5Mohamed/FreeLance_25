# Active-work checkpoint and barcode scope follow-up

Date: 2026-10-16. Continues 009. No new coordinator Markdown since worker/007;
individual MCP progress/reports are available and were inspected by exact JSON ID.

## State and independent checks

Initial observation: meeting action-scope, authoring lifecycle and student races
claimed, with recent bridge heartbeats; barcode auth reported. This establishes
claim/checkpoint state, not independent proof of continuous native process liveness.
During review, student races also reported. Final observed active ownership remains
meeting action-scope and authoring lifecycle. No worker started, claimed, retired or
replaced by Codex, and no active implementation files were edited.

Source changes since 008 are confined to the student pages/test and Barcode/test.
Ran completed barcode suite using installed managed Node 22.22.2: 35/35 pass.
After student report, ran its suite: 52/52 pass. No live services/browser/DB requests.
Full-project typecheck was not repeated while other writers remain active; doing so
would mix transient edits with final acceptance. Workers report 11 preexisting
out-of-scope errors and zero scoped diagnostics; independent stable final type
verification is still required before accepting these new tasks.

## Barcode review: partial improvement, acceptance withheld

All protected requests now use the canonical authToken adapter and missing-token
requests are rejected before transport. Retryable scan failures retain the input.
New generation checks protect several late responses; those improvements stay.

However, the selected-group effect only clears todayAttendance and absentStudents
when the group becomes empty. On A -> B it invalidates sequences but leaves A's
committed rows visible. Present rows are rendered directly from todayAttendance
(approximately 956); the page's selected-group UI now identifies B. If B fails,
the catch only toasts, leaving A data on B's screen indefinitely. monthlyPayments
and lastAttendance also merge without resetting/scoping prior maps.

Current tests around createScopedResponseGuard assign local records/loading in
the test itself. They prove token decisions, not that the production loader clears
already-committed data or handles denied/unknown nested lookups honestly. Nested
fee/previous-attendance failures currently become false/absent defaults; review
must distinguish unknown/denied from a server-confirmed unpaid/absent result.
No change to financial/date policy is authorized by this observation.

Created client-m1-barcode-scope-20261016-03, same narrowed two allowedPaths as the
reported predecessor. Extract the minimum production orchestration used by the
page, inject transport/state sinks, and test actual A-success -> B-selection ->
B-401/403/network outcomes, scope clear, reversed completion and nested failures.
Clear or scope-key rendered rows/maps at every transition, expose honest current
loading/error/retry, and stop superseded loops before issuing more nested reads.
Preserve authentication, failed scan retention, existing guards and dirty work.
No scheduled-weekday, attendance-date or payment-calendar change is approved.

The previous barcode task is NOT accepted merely because its 35 tests pass.
Its original report/evidence remains immutable; continuation is independently
queued without touching the two other active owners.

## Student report: checked and discussion answers

MCP student-races report now states resource-ID serialization with distinct blocked
conflicting outcome, independent error channels and actual production loaders.
Inspected updated registration controller: same-op repeats share only their own
promise, opposite operations are blocked, and the latch is released after the
operation. The scoped 52-test suite passes independently. This is encouraging;
full source acceptance and stable types remain pending after active authors finish.

Answers to worker questions: retain loadRegistrationPageData's strict throwing
contract alongside the independent page loader, provided the wrapper remains small
and its original tests keep passing. No removal/refactor just for aesthetics.
Small local guard duplication is acceptable under current ownership; do not move it
to a shared helper without scope approval. Offline course-write blocker remains.

## Next invocation

WorkBuddy should read this message, finish the two active owners and claim the
new barcode continuation only with verified capacity and its own MCP claim.
Coordinator report should identify actual native completion, stable final checks
and any exact remaining blocker. No duplicate workers, self-acceptance, M2 or
shared/backend/config edits. Hourly intervals are expected, so scheduling continues.
Original plans and all acceptance gaps not expressly closed remain applicable.

Review completed UTC: 2026-10-16T16:17:45.0705028Z
