# Registration decision race and barcode authentication review

Date: 2026-10-16. Continues 008; no new worker messages since worker/007.

## Verified state

Branch codex/human-client. All scoped source/test hashes still match checkpoint
008; no implementation edits since the independently verified 202/202 tests and
zero scoped type diagnostics. Did not rerun those unchanged suites. Two tasks from
008 remain queued, no active claims, no new task reports/heartbeats. Hourly waiting
is expected; no continuing worker liveness or new completion is claimed.

Read additional production flows under the original M1 ownership instead of
assuming previous helper tests proved every page's acceptance.

## Reproduced registration conflict

StudentRegistrationRequests.tsx createRegistrationDecisionController keys its latch
by approve:id and reject:id separately. Extracted that EXACT exported declaration
using the installed TypeScript AST/transpiler and evaluated it with injected
deferred approval/rejection APIs. Before releasing either dependency, calling
approve and reject for the same synthetic request recorded BOTH backend operations:
[approve, reject]. No source edits, app module imports, services, credentials or
live requests were used by this diagnostic. It reproduces a real production
controller race. Page processingId React state cannot close the same-render gap.

Decision: serialize mutually exclusive decisions by resource. A conflicting
operation must get a blocked outcome, not the other's success result. Preserve
reason/dialog on rejection failure and release the latch for deliberate retry.
Do not change the admissions policy or backend's authority.

Also inspected real list loads: Students/OfflineStudents fetchStudents commit
without a generation guard, and registration fetchData unconditionally commits all
four lists. Older loads may restore pre-mutation data after a successful refresh.
Shared loadError in Students/OfflineStudents also lets an unrelated student refresh
erase selector-load errors. Correct production loader lifecycle and independent
error states, not only standalone pure guard functions.

Ready task: client-m1-student-races-20261016-02.
Same original three student pages and approved test file; course-write contract
blocker remains unchanged and cannot be resolved by inventing a payload/endpoint.

## Barcode authentication and failure retention

BarcodeAttendance.tsx still reads localStorage.token in eight protected requests
(lines 131, 148, 160, 178, 260, 402, 502, 560 at this checkpoint). Canonical api-http
uses authToken. This is the same verified contract class already repaired in the
meeting pages; leaving Barcode unchanged was not a complete flow audit.

doRecordAttendance failure calls handleAttendanceError, which clears scan input
unconditionally, even for retryable failures. fetchTodayAttendance issues a
group-scoped request and later unconditionally commits records/payment and prior
attendance maps across several awaits. No generation guard fences scope changes.
Fix authenticated production request construction, failed-scan actionable state
and stale group results with isolated injected-transport tests. Preserve existing
single-flight scan protections.

Ready task: client-m1-barcode-auth-20261016-03.
Narrowed ownership: BarcodeAttendance.tsx and m1-sprint-attendance-ui.test.ts only.
No date/scheduled-weekday/payment convention change is authorized. The calendar
contract question in 008 is separate; do not use this task to silently decide it.

## Coordination and hygiene

Four tasks are now ready (the two above plus the two from 008), no active conflicts.
No worker was started or claimed by Codex; predecessor coordinator reported workers
stopped and predecessor states remain reported. Original reports/evidence retained.
Read exact task instructions and claim through MCP at the next hourly invocation.
Nothing outside allowedPaths is authorized by this discussion.

git status additionally lists an untracked .workbuddy-ai/ directory. Its contents
were NOT inspected because runtime/account/session configuration is outside this
task. WorkBuddy coordinator: identify whether the app itself generated it, without
reading/disclosing secrets or traces; do not delete it, add it to Git, or change
shared ignore/config files. Do not claim all untracked files are coordination docs.

Process correction in this review: status reads must target exact taskId.json
filenames or strictly filter .json, never glob all similarly prefixed state files.
Markdown remains token-free. No acceptance changes beyond the two narrow corrections
already recorded in 008; overall M1 acceptance withheld. No 429, live services,
network app requests, DB, installs, shared source edits or M2. Schedule continues.

Review completed UTC: 2026-10-16T16:02:10.7400851Z
