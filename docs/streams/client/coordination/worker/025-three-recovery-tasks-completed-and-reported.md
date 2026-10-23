# Three recovery tasks claimed, completed and reported (031/032/033 consumed)

UTC: 2026-10-16T22:35Z (2026-10-17 01:35 Cairo). Branch `codex/human-client` verified.
Read coordination README, WORKER-PROMPT-CLIENT.md, supervisor/031, 032, 033.

## Consumed messages

- `supervisor/031` (21:20:55Z) — operator-directed unblock recorded; three fresh
  recovery tasks ready with 026's exact allowedPaths. Consumed and acted on.
- `supervisor/032` (21:30:22Z), `supervisor/033` (21:45:25Z) — waiting
  observations; no acknowledgment-only reply required, no new instruction.
  This message carries the work 031 requested.

## Queue and claims (MCP, this session)

- `queue_status` once at 21:49Z: active=[], ready = the three 031 recoveries,
  blocked=[], upgradePending=false. `dispatch_plan` once.
- Claimed one task each with unique workerIds (no duplicate worker, no nested
  spawning, no preclaim): `wb-cairo-recovery-20261017-03a`,
  `wb-offline-courses-recovery-20261017-02a`,
  `wb-session-recovery-20261017-01a`. allowedPaths verified per claim.
- Claim tokens retained privately in live runtime only; never written to any
  file, message, checkpoint or report.
- Exactly one `submit_task_report` per task — all three returned
  `awaiting_supervisor`. A report is not acceptance; no next phase claimed.

## Work performed (all inside claimed allowedPaths; all dirty work preserved)

### 1. client-m1-cairo-recovery-20261017-03 (wb-cairo-recovery-20261017-03a)

Both production mirrors (`src/lib/attendance-calendar.ts`,
`server/src/lib/attendance-calendar.ts`) fixed for the three 029 defects:

- `parseScheduleWeekdays` checks `Array.isArray` AFTER `JSON.parse`: JSON
  `null`, `{}`, `42`, `"sun"` yield an empty schedule instead of TypeError.
- `normalizeAttendanceDay` rejects impossible instant date/time components
  (`2026-02-30T00:00:00Z` no longer rolls to 2026-03-02; month 13, hour 25,
  non-leap 2026-02-29 rejected).
- Instant strings must carry an explicit timezone/offset (Z or ±HH:MM);
  offsetless host-dependent datetimes are rejected. Explicit valid day keys
  preserved unchanged; DST-aware Africa/Cairo conversion via runtime Intl
  (no hardcoded offsets).

Tests: frontend calendar 11/11 (was 6), server calendar 18/18 (was 13) —
including route-level 400s for impossible/offsetless datetime inputs.
Attendance suites 84/84.

### 2. client-m1-offline-courses-recovery-20261017-02 (wb-offline-courses-recovery-20261017-02a)

- New production seam `lockOfflineCourseTarget` in
  `server/src/lib/offline-student-courses.ts`: `SELECT ... FOR UPDATE` with
  the instructor-authority predicate under the lock, plus the STORED
  `is_offline` predicate (never a UI flag).
- `server/src/routes/students.ts`: PUT course path locks and re-validates
  the target inside the transaction (the old bare `SELECT id` without
  `FOR UPDATE` is gone); POST rejects `course_ids` for non-offline creations.
- absent-vs-empty semantics, canonical `course_ids` readback, transactional
  rollback, page payload/failure retention: preserved and verified.

Tests: server offline contract 20/20 (was 15) — production-path regressions
(FOR UPDATE emission, in-transaction authority, offline predicate incl.
NULL, lock-before-write ordering, refusal performs zero enrollment SQL);
student-management UI 56/56.

### 3. client-m1-session-recovery-20261017-01 (wb-session-recovery-20261017-01a)

- `selectStudentSpace` (the actual token-rotation writer) notifies `token`
  AFTER its complete mutation; `setAuthToken` stays a pure storage writer so
  login remains atomic (no subscriber ever sees a token without identity).
- Meeting session handling extracted into an exported production controller
  `createMeetingSessionGuard` in OnlineMeeting.tsx + StudentMeetings.tsx
  (subscribe → invalidate in-flight load → clear rendered links; unmount
  unsubscribe).
- Tests: session contract 12/12 (was 7 bus-only) — now exercises the REAL
  api-http writers with injected in-memory localStorage + stubbed fetch
  (atomic login, bare-token no-notify, rotation notification, full teardown,
  failed login silence); meeting support 32/32 — real-bus guard tests on both
  page copies.

## Verification totals (this run)

- All frontend `src/tests` suites: **342/342**.
- All server `tests` suites: **826/829**. The 3 failures are PRE-EXISTING in
  files untouched by this batch: two `m1-expanded-file-authority` assertions
  expect SQL `tenant_id = ?`/`uploaded_by = ?` while the source emits
  `f.tenant_id=?`/`uploaded_by=?` (whitespace drift), and one
  `m1-test-target-safety` refusal-message assertion. Reported, not touched.
- Frontend `tsc -p tsconfig.app.json`: same 11 known out-of-scope
  diagnostics, zero scoped. Server `tsc --noEmit`: exit 0.

## Limitations and follow-ups (reported, not implemented)

1. `getAttendanceByDate` (`src/lib/api-http.ts:1051-1062`) still formats the
   Date with host-local parts; the only live consumer (QRAttendance.tsx)
   avoids it deliberately. `src/lib/api-browser.ts:197-205` is a dead mock
   copy (not imported anywhere in src). A narrowly scoped follow-up is needed
   to move it to Cairo day keys — outside this batch's ownership.
2. Two file-authority test failures are a test-vs-source whitespace mismatch;
   fixing them touches a test file outside this batch's allowedPaths.
3. Native run/session IDs unavailable in this invocation; mapping remains
   coordinator-reported. No 429, no tool-guard error, no retries.

No state/claim/task/approval edits, no retire/reclaim, no schedule, bridge,
account or runtime changes; no git writes; no installs; no live services/DB;
no M2; no scope expansion. All pre-existing uncommitted work preserved
(tree: 45 entries, nothing reverted).
