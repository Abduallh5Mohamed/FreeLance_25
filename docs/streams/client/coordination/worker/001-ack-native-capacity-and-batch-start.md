# Worker acknowledgement — native capacity, scheduling status, batch start

- **Author:** WorkBuddy (client worker/coordinator), account holder's app session
- **UTC timestamp:** 2026-10-16T14:16:25Z
- **Reply to:** `supervisor/001-start.md`
- **Read first:** `coordination/README.md`, `tools/workbuddy-bridge/WORKER-PROMPT-CLIENT.md`,
  `docs/streams/client/M1-HANDOFF.md`
- **Branch:** `codex/human-client`
- **Changed paths by this message:** `docs/streams/client/coordination/worker/001-ack-native-capacity-and-batch-start.md` (new file only)

## 1. Native scheduling availability — reported as unavailable, not activated

I did **not** activate any schedule, and I am not claiming a 15-minute check exists.

- The local bridge (`tools/workbuddy-bridge/`) contains **no timer or periodic loop**. Its
  `scheduler.test.cjs` exercises the atomic claim lock (`.scheduler-lock`) that serialises
  concurrent `next_approved_task` calls — it is a mutual-exclusion lock, not a scheduler.
  `supervisor-control.cjs` only exposes `retire` / `enable-v2` and states explicitly that it
  "does not start WorkBuddy agents or approve new tasks".
- The host app does provide native recurring automation, but its scheduling vocabulary is
  **hourly or coarser** (DAILY / HOURLY / WEEKLY / MONTHLY / YEARLY). A **15-minute** cadence is
  **not expressible** and therefore was not configured. No substitute cadence was set silently.
- Per `README.md`, no scheduler exists and neither app is claimed to wake automatically or to
  continue after its host closes. Consistent with the fallback the README prescribes, I
  performed **one explicit check when invoked** (dispatch_plan + queue_status) and did not
  busy-poll.
- If a coarser cadence is acceptable, an hourly native automation can be created on request.
  Until then, coordination checks remain manual/invocation-driven.

## 2. Capacity verified (dispatch_plan read once)

Read once at 2026-10-16T14:15Z. `queue_status` at 2026-10-16T14:16:25Z:

- `active`: [] — no pre-existing claims on this batch.
- `ready`: the six approved local IDs `client-m1-20261016-01` … `-06`, all `team: frontend`,
  `accessMode: write`.
- `blocked`: [] — no unmet dependencies.
- Limits: `maxActive 48`, `maxPerTeam 6`; all six scoped tasks are in `frontend`, so all six are
  admissible concurrently.
- `upgradePending: false`.

Actual native child-worker capacity was **probed, not assumed**: a native child process
successfully reached `mcp__tabweb-client-supervisor__queue_status` through ToolSearch +
DeferExecuteTool and returned the same status object. Native child workers are therefore
available, and per the start message each worker claims **its own** exact task — no preclaim by
the coordinator, no nested spawning.

## 3. What started

Six native child workers were launched at **2026-10-16T14:16Z**, one per approved task, each
instructed to claim exactly one task ID with its own unique `workerId`, inventory its scoped
files before editing, stay strictly inside its `allowedPaths`, checkpoint at milestones and send
a single `submit_task_report`. No worker holds two tasks; no worker is nested.

| Native worker | Local task ID | workerId used for the claim | Scoped paths |
| --- | --- | --- | --- |
| `wb-task-01` | `client-m1-20261016-01` | `wb-client-m1-01` | `src/pages/EditExam.tsx`, `ExamManager.tsx`, `TeacherExams.tsx`, `src/tests/m1-expanded-exam-authoring-ui.test.ts` |
| `wb-task-02` | `client-m1-20261016-02` | `wb-client-m1-02` | `src/pages/Students.tsx`, `OfflineStudents.tsx`, `StudentRegistrationRequests.tsx`, `src/tests/m1-expanded-student-management-ui.test.ts` |
| `wb-task-03` | `client-m1-20261016-03` | `wb-client-m1-03` | `src/pages/Attendance.tsx`, `AttendanceLog.tsx`, `QRAttendance.tsx`, `BarcodeAttendance.tsx`, `src/tests/m1-sprint-attendance-ui.test.ts` |
| `wb-task-04` | `client-m1-20261016-04` | `wb-client-m1-04` | `src/pages/StudentExams.tsx`, `StudentExamResults.tsx`, `ExamReview.tsx`, `ManualGrading.tsx`, `src/tests/m1-sprint-exam-ui.test.ts` |
| `wb-task-05` | `client-m1-20261016-05` | `wb-client-m1-05` | `src/pages/OnlineMeeting.tsx`, `StudentMeetings.tsx`, `Support.tsx`, `src/tests/m1-sprint-meeting-support-ui.test.ts` |
| `wb-task-06` | `client-m1-20261016-06` | `wb-client-m1-06` | `src/pages/Subscriptions.tsx`, `InstructorSubscription.tsx`, `src/tests/m1-sprint-subscription-ui.test.ts` |

Honesty note: at 2026-10-16T14:16:25Z the bridge still reported `active: []` because the workers
had just been launched and had not yet claimed. This message does **not** claim six live claims;
the authoritative claim state is whatever `queue_status` reports, and I will not fabricate
liveness or runtime identifiers. Workers were launched as native WorkBuddy child agents in the
host app session; if the host closes they do not continue.

## 4. Checks performed before editing (baseline, 2026-10-16T14:15Z)

- `git status --porcelain` on `codex/human-client`: clean except this new untracked
  `docs/streams/client/coordination/` folder — no dirty work at risk, no other active owner.
- Scoped tests, `tsx --test` on the six scoped test files: **103/103 pass, 0 fail**
  (19 + 32 + 15 + 15 + 9 + 13).
- `tsc --noEmit -p tsconfig.app.json`: 13 diagnostics project-wide, of which **exactly one** is
  inside the six scopes —
  `src/pages/AttendanceLog.tsx(218,61): error TS2339: Property 'parent_phone' does not exist on type 'Student'`.
  The other 12 are outside this batch's ownership (`src/components/NotificationBell.tsx`,
  `src/components/StudentHeader_OLD_BACKUP.tsx`, `src/pages/ExamReports.tsx`,
  `src/pages/ExamResults.tsx`, `src/pages/Fees.tsx`, `src/pages/StudentBarcodes.tsx`,
  `src/pages/StudentDashboard.tsx`, `src/utils/versionChecker.ts`) and are reported as
  pre-existing, not fixed.
- `node_modules` is present with `tsx`/`tsc` available; no dependency installation is needed or
  permitted.

## 5. Blockers

- **Scheduling blocker (non-fatal):** 15-minute native cadence is unavailable, as detailed in
  §1. Reported, not worked around.
- **Known ownership blocker (pre-flagged):** the single scoped type error in `AttendanceLog.tsx`
  concerns the shared `Student` type. `src/lib/**` is outside every allowedPaths, so task 03 was
  instructed to fix it only from inside its own page or else report a precise blocker rather
  than edit shared code.
- No other blocker at this time. No 429 encountered. No M2, no scope expansion, no live
  services, DB, Docker, installs or git writes.

A worker report is not acceptance. Waiting on Codex review.
