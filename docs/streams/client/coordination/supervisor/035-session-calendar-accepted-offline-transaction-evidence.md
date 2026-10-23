# Session/calendar accepted; one offline transaction acceptance gap remains

UTC: 2026-10-16T22:16:30Z (2026-10-17 01:16 Cairo).
Branch verified codex/human-client. Read coordination README, new worker/025 and
ACTUAL results for all three031 recoveries. Each now reported with result JSON,
not merely an MD assertion. Report protocol requires stop; initial dispatch shows
no active/ready/blocked tasks. Coordinator native-ID limitation remains explicit.

## Independent checks

Managed Node22.22.2 + local tsx, all frontend suites PLUS server
m1-offline-course-contract, m1-attendance-calendar, m1-sprint-attendance-boundary:
**409/409 pass**, zero failures/skips. This is the selected combined run, not an
independently executed full829-test backend baseline. Worker reports826/829 with
three preexisting outside failures; no outside test edits approved.

Frontend tsc: same11 known outside-scope errors, zero scoped, command nonzero.
Server tsc: exit0, no diagnostics. No DB/network/browser/services/installs or Git
writes; no source edits by Codex.

## Accepted bounded contracts

- client-m1-session-recovery-20261017-01: actual token rotation writer now emits
  after token mutation; login still emits only after complete token+identity.
  Real-writer tests cover login/failed login/logout/rotation; both pages consume
  a production session guard tested with the real bus and deferred loader so
  stale responses cannot repopulate links. Accepted within026's boundary.
  No follow-up merely to consolidate equivalent logout storage writes.
- client-m1-cairo-recovery-20261017-03: both helpers now validate timestamp
  components/explicit offset and safely handle parsed non-array JSON; page/route
  wiring and direct production regressions covered. Accepted within026's boundary.
  Query inventory finds getAttendanceByDate only defined/exported, with page
  mentions now comments; no remaining live calls were found. Its host-local legacy
  implementation is documented technical debt, not a new acceptance gate/task.
  Dead mock api-browser copy likewise does not justify work to fill time.

Recorded these acceptances in existing state/ledger, preserving result evidence.
Previously accepted corrections remain accepted; no overall M1 declaration yet.

## Offline source improvement versus missing evidence

Production POST rejects course_ids for online creation. PUT now begins a
transaction, locks/validates the target including stored offline status and
instructor authority, updates data/enrollment and commits, with rollback/release
paths. Source appears to address the prior eligibility/locking findings.

However the required REAL transaction evidence is still absent. The20 backend
tests exercise validation/diff/SQL and lock helpers. The test named "lock refusal
... (rollback path)" only invokes lockOfflineCourseTarget; it never invokes
beginTransaction/rollback/release. Another test manually composes lock+apply.
Neither can detect the actual route omitting rollback/commit/release, wrong
ordering, an enrollment failure leaving partial student writes, or concurrent
replacement behavior. This is the original026/029/031 requirement, not a new
feature or insistence on a live DB.

Do not accept client-m1-offline-courses-recovery-20261017-02 yet. Created approved
continuation client-m1-offline-transaction-evidence-20261017-02, NARROWED to:
- server/src/routes/students.ts
- server/src/lib/offline-student-courses.ts
- server/tests/m1-offline-course-contract.test.ts

Predecessor reported/stopped before creation. Sanitized dispatch verifies one
ready task, no active owners; no worker claimed/launched by Codex.

WorkBuddy: use an existing injectable actual route seam or extract the SMALLEST
production transaction runner used by real handlers. Test real begin/lock/writes/
commit/release, refusal/failure rollback/release/no commit/no partial writes, POST
orphan prevention, absent-vs-empty selection, and deterministic overlapping
replacement with mocked serialized locks. No test-local copied transaction flow.
Preserve status/auth/tenant/admissions/password/billing contracts and all dirty
work; no frontend changes or router rewrite. No unrelated outside baseline fixes,
live DB, dependency installs, schema/package changes, scope expansion or M2.
Keep claim/report in one continuous context and verify genuine receipt.

Finite remaining set: actual offline transaction regression acceptance, then
stable consolidated M1 disposition. No new session/calendar task. No artificial
duration or self-acceptance. Continue quarter-hour scheduling, no429 or new human
intervention blocker observed.
