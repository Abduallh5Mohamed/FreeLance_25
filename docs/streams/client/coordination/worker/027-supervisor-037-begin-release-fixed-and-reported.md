# Supervisor 037 begin-release fix completed and reported (036/037 consumed)

UTC: 2026-10-16T22:41Z (2026-10-17 01:41 Cairo). Branch `codex/human-client` verified.
Read coordination README, WORKER-PROMPT-CLIENT.md, supervisor/036, supervisor/037.

## New messages since worker/026
- `supervisor/036` (22:30Z) — in-flight observation: one claimed owner
  `wb-offline-txn-evidence-20261017-01a`, no checkpoint/result yet. Explicitly
  "no acknowledgment-only reply required for this in-flight note." It flags the
  036 resource-boundary finding (beginTransaction before try/finally) as within
  current acceptance, not a new task. No instruction → no separate action for 036
  beyond the fix 037 mandates.
- `supervisor/037` (22:40Z) — expedited user-requested review. Confirms the 026/035
  offline task reported/stopped; reproduces the 036 defect with an external probe of
  the ACTUAL production runner (`released=0, bodyCalls=0, rollbacks=0,
  originalErrorPreserved=true; expected release=1`). Does NOT accept yet; prepares a
  narrowed ready task `client-m1-offline-begin-release-20261017-02` with ONLY
  `server/src/lib/offline-student-courses.ts` + `server/tests/m1-offline-course-contract.test.ts`
  (students.ts explicitly NOT in scope). Directs the minimum fix: begin inside the
  release boundary, track successful begin, always release, preserve primary error.

## Queue and claim (MCP, this session)
- `queue_status` once: active=[], ready = `client-m1-offline-begin-release-20261017-02`,
  blocked=[], upgradePending=false. `dispatch_plan` once (confirmed the same single ready task).
- Claimed once via `next_approved_task` with unique workerId
  `wb-offline-begin-release-20261017-01a` (no duplicate worker, no nested spawning,
  no preclaim). allowedPaths verified as the two files above; all edits stayed strictly
  inside them. Claim token held only in live runtime — never written to any file, message,
  checkpoint or report.

## Work performed (037 gap: connection-release boundary)
- `server/src/lib/offline-student-courses.ts`: `runStudentWriteTransaction` now calls
  `connection.beginTransaction()` INSIDE the `try` block; a `began` flag records whether a
  transaction actually opened. A connection whose begin rejected is NOT rolled back (it was
  never opened) but IS still released in the `finally` — closing the leaked-connection hole.
  If `rollback()` itself rejects, the primary body/commit error is preserved (attached as
  `error.cause`) and still rethrown; `release()` always runs so the pooled connection is
  returned exactly once on every failure site. `server/src/routes/students.ts` untouched.
- `server/tests/m1-offline-course-contract.test.ts`: +5 real runner regression tests driving
  the ACTUAL `runStudentWriteTransaction` with a controllable connection asserting exact
  call order/count and original-error propagation:
  - begin rejection → order `[begin, release]`, no body, no rollback, original error preserved;
  - body rejection → `[begin, body, rollback, release]`, no commit, body error preserved;
  - commit rejection → `[begin, body, commit, rollback, release]`, commit error preserved;
  - rollback rejection → release still runs, primary body error preserved as cause;
  - success → `[begin, body, commit, release]`, commit + release once, value passed through.

## Verification
- `server/tests/m1-offline-course-contract.test.ts`: **32/32 pass** (was 27), managed Node
  22.22.2 + local tsx; hermetic mocks, no live DB/network/dotenv.
- `server` `tsc --noEmit`: **exit 0**, zero diagnostics in the two changed source files.
- The 037 probe reproduction (leaked connection on begin rejection) is now satisfied:
  released=1 exactly once, no rollback, original error preserved.

## Report
- Exactly one `task_checkpoint` (after fix + tests green) + one `submit_task_report` →
  `reported`, `awaiting_supervisor` (a report is not acceptance). Native run/session ID not
  observable in this headless invocation; mapping is coordinator-reported, not a liveness claim.
- One open question to supervisor: accept this 037 fix, or prefer a further route-level
  regression before final consolidation?

## Constraints honored
No state/task/approval/bridge/schedule/runtime/account edits; no git writes; no dependency
installs; no live DB/network/Docker/browser; no M2, no scope expansion, no self-acceptance.
All pre-existing uncommitted work preserved (tree untouched outside the two allowedPaths).
