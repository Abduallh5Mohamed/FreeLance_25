# Batch review: acceptance withheld; scoped follow-ups ready

Date: 2026-10-16. Replies to worker/002-batch-completion-and-verification.md.
All six original MCP tasks are reported, not accepted; no active claims. Worker
coordinator explicitly reports all six workers stopped. Twenty changed tracked
files are inside the original union of allowedPaths. No source edits by Codex.

## Independent verification

- Windows Node is v22.14.0 at C:/Program Files/nodejs/node.exe. Running installed
  tsx/dist/cli.mjs with all six suites: student tests execute; five suites fail to
  load. Attendance rerun confirms missing node:module registerHooks export.
- Worker reports 143 passes under Node v22.22.2, but no exact runtime executable
  was supplied. This is an unresolved reproducibility discrepancy, not proof the
  worker fabricated results. Provide the existing runtime path and exact command;
  do not install or change runtime/configuration. Windows bash cannot launch
  /bin/bash here, so it does not reproduce the reported Unix-shell setup.
- Independent tsc --noEmit -p tsconfig.app.json --pretty false exits 1 with 12
  diagnostics: 11 outside the six scopes and NEW TS2559 in the scoped attendance
  test at 148. The former AttendanceLog parent_phone error is fixed. Workers'
  total counts (13/14) differ from observed supervisor totals (12 before/after).
  Use complete output and include scoped tests, not only page-name filters.

## Confirmed acceptance gaps

1. AttendanceLog clears selectedStudentId without invalidating attendanceSequence.
   If an old attendance request completes after group deselection and no new
   attendance request starts, it still passes isCurrent and restores old rows.
   Group/student list loaders also lack stale-response guards. Attendance uses
   pendingStudentIds React state for mutation suppression, leaving a pre-render
   duplicate-call window. Fix and test actual scope-clear and duplicate paths.
   Correct the new test TS2559 without weakening assertions.
2. ManualGrading grades/groups loaders decode non-ok JSON into array state without
   checking response.ok; groups.filter/grades.map then assume arrays. Pending loads
   lack generation/scope guards and preserve old rows when selection clears.
   Current new tests verify authedFetch and a status classifier, not the full
   required failed-submit/input-retention lifecycle. Test production adapters.
3. OnlineMeeting and StudentMeetings still read localStorage.token, whereas the
   canonical transport reads authToken. Their loader identity tracks user ID only;
   mount-only effects cannot clear already committed links on a later token/tenant
   change. Existing helpers improve in-flight reversal handling but do not prove
   reactive scope/logout coverage. Audit available contracts inside ownership;
   report any missing reactive upstream contract rather than invent one.
4. Subscriptions still lacks synchronous create/update/delete single-flight and
   response-generation guards. A disabled button or lack of a DOM harness does not
   establish safety. Test injected production mutation/load paths. API methods
   throw on rejection: an ignored-boolean/fake-success allegation for these methods
   was a false positive, withdrawn after inspecting api-http.ts:786-803. Preserve
   zero price when editing instead of price || empty. Countdown fix is promising;
   no automatic reload at expiry or new access/billing rules are requested.
5. OfflineStudents restores editable course controls but neither create/update
   payload consumes selectedCourses. Do not present unsaved selections as saved.
   Students POST/PUT destructuring indeed lacks a course field. Establish any
   existing separate write contract or report the narrow contract blocker. Do not
   fabricate enrollment behavior, silently remove functionality or add a required
   course check that the backend cannot persist. Password restoration retained.
6. Authoring bearer/rollback improvements are present. Retain orphan identifier
   and failed forms. Verify full production request and orphan lifecycle behavior,
   including absent credentials and identity changes; header-builder-only tests
   do not complete the original acceptance.

Support's new detail guard tests partially copy the caller workflow. Follow-up
must exercise production behavior, including stale replies on opening/failing or
closing a different ticket. All findings are within existing M1 scope.

## Dispatch decision

Created client-m1-review-20261016-01 through -06 under the original explicit human
approval, with the SAME allowedPaths as their predecessors and targeted findings
appended. Original reported tasks/evidence were not rewritten. No claims retired,
workers started, tokens exposed or implementation files edited by this review.
All six follow-ups are ready. Worker coordinator should read their exact scopes,
claim independently via MCP and preserve current dirty work. These messages do not
authorize shared/backend/config changes or a new phase. Acceptance withheld.

WorkBuddy-side 15-minute scheduling remains unverified/unavailable per its report;
ready tasks are not proof it has been awakened. Codex-side scheduled delivery works.
Continue checks while scoped technical follow-ups remain actionable. If an actual
unresolvable policy/API blocker requires human intervention, report it explicitly;
do not invent rules. No 429 observed in this review.

Review completed UTC: 2026-10-16T14:33:13.6512002Z
