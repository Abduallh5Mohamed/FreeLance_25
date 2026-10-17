# Initial scheduled M1 supervisor review

UTC: 2026-10-16T14:16:54.0388254Z
Branch verified: codex/human-client.

## Observed state

All six client-m1-20261016-01 through -06 tasks remain queued and ready.
No active bridge claims, checkpoints, implementation reports or worker acknowledgements.
Git shows only the untracked coordination folder; no tracked source changes.
No native worker liveness is established. No work is accepted.

## Baseline checks

Ran node node_modules/typescript/bin/tsc --noEmit -p tsconfig.app.json --pretty false.
Exit 1; 12 diagnostics total. The scoped diagnostic is AttendanceLog.tsx:218,
TS2339, Student.parent_phone. Other diagnostics are in NotificationBell,
StudentHeader_OLD_BACKUP (2), ExamReports (2), ExamResults, Fees (2),
StudentBarcodes, StudentDashboard and versionChecker. Do not edit those outside
this batch's allowedPaths. Baseline is not a new worker regression.

Node is v22.14.0; typeof require('node:module').registerHooks is undefined.
Five scoped tests import registerHooks: authoring, attendance, exam UI,
meeting/support and subscription. Existing test headers referring to Node 22.22.2
are not evidence about this machine. Adapt hermetic test loading within approved
test files using already installed facilities, or report a precise tool blocker.
Do not install dependencies, change runtime/account configuration or claim tests passed.
No behavioral tests were run during this review.

## Confirmed existing defects and next instructions

EditExam.tsx:244 question loading uses fetch without auth options.
TeacherExams.tsx:185 deleteExam ignores the DELETE response's success status.
ManualGrading.tsx:111 and :121 grades/groups loads omit auth options.
AttendanceLog.tsx:218 references undeclared parent_phone.
InstructorSubscription.tsx:29 maps malformed amounts to zero; :78 combines server
wall-clock anchor with duration. Full request lifecycle and countdown verification
remain required by the approved tasks; this spot check is not a complete security audit.

WorkBuddy: acknowledge 001-start.md, verify actual native capacity and claim only
ready tasks via MCP. Preserve existing code/tests. Send inventory and actual
milestone checkpoints; finish acceptance evidence before reporting. Scheduling on
Codex's side is now installed via Windows Task Scheduler/native queue and delivery
was observed. WorkBuddy-side scheduling has not been verified. Existing review
messages do not expand implementation scopes or transfer claims.

## Decision

Awaiting WorkBuddy execution; no implementation accepted or rejected as new work.
No worker started or claim changed by this review. No live services or network app
requests were made. Continue the scheduled checks for new progress. No STOP needed:
the observed baseline issues are already inside the approved workers' repair scope.