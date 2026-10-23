# Offline transaction-evidence task completed and reported (034/035 consumed)

UTC: 2026-10-16T22:33Z (2026-10-17 01:33 Cairo). Branch `codex/human-client` verified.
Read coordination README, WORKER-PROMPT-CLIENT.md, supervisor/034, supervisor/035.

## New messages since worker/025
- `supervisor/034` (22:00Z) — observation only: the three 031 recoveries were
  claimed with checkpoints present, leases not overdue, no result yet. Explicitly
  "no acknowledgment-only reply needed; current checkpoint progress is observed."
  No instruction → no action required for 034.
- `supervisor/035` (22:16Z) — accepts session + cairo recoveries (within 026
  boundary); does **not** accept the offline-courses recovery because the required
  *real transaction evidence* is absent (existing tests only invoked helpers, never
  the route's begin/commit/rollback/release lifecycle). Creates a new approved
  ready task `client-m1-offline-transaction-evidence-20261017-02`, narrowed to:
  `server/src/routes/students.ts`, `server/src/lib/offline-student-courses.ts`,
  `server/tests/m1-offline-course-contract.test.ts`. Directs WorkBuddy to claim it.

## Queue and claim (MCP, this session)
- `queue_status` once: active=[], ready = the single 035 task, blocked=[],
  upgradePending=false. `dispatch_plan` once (confirmed the same single ready task).
- Claimed it once via `next_approved_task` with unique workerId
  `wb-offline-txn-evidence-20261017-01a` (no duplicate worker, no nested spawning,
  no preclaim). allowedPaths verified as the three files above; all edits stayed
  strictly inside them. Claim token held only in live runtime — never written to
  any file, message, checkpoint or report.

## Work performed (035 gap: actual route transaction evidence)
- `server/src/lib/offline-student-courses.ts`: added the smallest production
  transaction runner `runStudentWriteTransaction(connection, body)` that owns
  beginTransaction → run body → commit on success, rollback+rethrow on any error,
  release in `finally`. Exported `WriteTransactionConnection` interface and
  `StudentWriteRefusal` class (status 400|403|404|409).
- `server/src/routes/students.ts`: both POST (user/student/enrollment) and PUT
  (lock + student/user update + enrollment) handlers now delegate the entire
  transaction boundary to `runStudentWriteTransaction`; every refusal throws
  `StudentWriteRefusal`, caught and mapped to the correct 4xx, while ER_DUP_ENTRY
  still maps to 409. Prior password/group/grade/is_offline behavior preserved.
- `server/tests/m1-offline-course-contract.test.ts`: +7 real transaction-runner
  regression tests driving the actual runner with mocked serialized locks (no live
  DB): success commit+release with lock-before-write ordering; lock refusal and 404
  course refusal → rollback+release, no commit, no enrollment write; simulated DB
  failure → rollback+release+rethrow, no commit; POST insert+refusal prevents an
  orphan (inserts rolled back, never committed); two sequential transactions each
  re-lock and the later reads the prior committed rows; absent `course_ids`
  preserves and explicit `[]` clears.

## Verification
- `server/tests/m1-offline-course-contract.test.ts`: **27/27 pass** (was 20),
  Managed Node 22.22.2 + local tsx; hermetic mocks, no live DB/network/dotenv.
- `server` `tsc --noEmit`: **exit 0**, zero diagnostics in the two changed source files.
- Pre-existing 3 outside server test failures (m1-expanded-file-authority x2,
  m1-test-target-safety x1) left untouched (out of this task's allowedPaths).

## Report
- Exactly one `submit_task_report` → status `reported`, `awaiting_supervisor`
  (a report is not acceptance). Native run/session ID not observable in this
  headless invocation; mapping is coordinator-reported, not a liveness claim.

## Constraints honored
No state/task/approval/bridge/schedule/runtime/account edits; no git writes; no
dependency installs; no live DB/network/Docker/browser; no M2, no scope expansion,
no self-acceptance. All pre-existing uncommitted work preserved (tree untouched
outside the three allowedPaths).
