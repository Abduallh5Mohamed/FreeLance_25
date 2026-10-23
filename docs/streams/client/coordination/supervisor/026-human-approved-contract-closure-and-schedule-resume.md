# Human approved three M1 contract closures; supervision resumes

Recorded UTC: 2026-10-16T19:59:53Z.

The human explicitly approved the three proposals discussed after 025, confirmed
no other developer is working on backend/auth, and requested scheduling resume.
This authorizes course persistence, shared reactive session notification and
Africa/Cairo attendance business-day semantics while preserving billing policy.
025's stop condition is superseded for this bounded extension. Original six-scope
work and its accepted corrections remain preserved. This is M1, not M2.

## Concrete approved tasks

Created fresh scope-hashed approved MCP tasks; initial dispatch verified all three
ready, active=[], blocked=[]. No claim, worker launch or implementation edit by
Codex. WorkBuddy claims normally via MCP after checking native capacity, with
fresh IDs and exact returned allowedPaths. Scope instructions live in each task;
historical handoff prohibitions yield ONLY to this explicit approved exception.

### client-m1-contract-offline-courses-20261016-02

Allowed paths:
- server/src/routes/students.ts
- server/src/lib/offline-student-courses.ts (new bounded helper if needed)
- server/tests/m1-offline-course-contract.test.ts
- src/pages/OfflineStudents.tsx
- src/tests/m1-expanded-student-management-ui.test.ts

Existing source confirms student POST/PUT lack a course-write field while the page
shows course selection. Implement optional course_ids preserving absent-vs-empty
semantics, canonical ID readback and page payloads, server tenant/instructor/course
authority and transactional consistency. Preserve password/group/offline boolean,
existing admissions/online workflows and failed form input. Course selections may
not silently fail or create new monetary entitlement policy. Read existing schema
and transactions without starting DB. No migration/schema/install/API-library edit.
If existing enrollment/payment coupling prevents the approved selection contract,
report concrete evidence instead of inventing business rules.

### client-m1-contract-session-20261016-01

Allowed paths:
- src/lib/session-events.ts (small explicit new contract)
- src/lib/api-http.ts
- src/pages/Auth.tsx
- src/pages/StudentSpaces.tsx
- src/components/AuthGuard.tsx
- src/components/Header.tsx
- src/components/InstructorHeader.tsx
- src/components/StudentHeader.tsx
- src/components/SecureVideoPlayer.tsx
- src/hooks/useSecuritySupervisor.ts
- src/pages/OnlineMeeting.tsx
- src/pages/StudentMeetings.tsx
- src/tests/m1-session-contract.test.ts
- src/tests/m1-sprint-meeting-support-ui.test.ts

Source inventory finds canonical token/session writers across these live paths.
Integrate explicit token/identity/student-space change notifications after complete
mutations; event payload must contain no secrets/private links. Meeting subscribers
clear private data and invalidate pending requests on same-document changes.
Preserve action gates/cross-tab protections and cleanup listeners on unmount.
No global storage monkeypatch or polling, auth redesign or unrelated component
change. SecureVideoPlayer ownership is ONLY its token-clearing/logout event path,
not playback/protection behavior. OLD_BACKUP components are excluded.

### client-m1-contract-cairo-attendance-20261016-03

Allowed paths:
- src/lib/attendance-calendar.ts
- server/src/lib/attendance-calendar.ts
- server/src/routes/attendance.ts
- src/pages/Attendance.tsx
- src/pages/AttendanceLog.tsx
- src/pages/QRAttendance.tsx
- src/pages/BarcodeAttendance.tsx
- src/tests/m1-sprint-attendance-ui.test.ts
- src/tests/m1-attendance-calendar.test.ts
- server/tests/m1-sprint-attendance-boundary.test.ts
- server/tests/m1-attendance-calendar.test.ts

Use Africa/Cairo for attendance defaults/instant day conversion and scheduled
weekday/previous day. Preserve explicit valid YYYY-MM-DD keys, reject invalid
dates; use timezone-aware Intl semantics, not fixed offsets/host-local arithmetic.
Do not migrate historical rows or change payment_date/payment_month/year, pricing,
entitlement or billing conventions. Report any unavoidable coupling as a precise
blocker; the approved attendance timezone does not authorize a billing rewrite.
Test server/frontend parity, Cairo midnight/DST, leap/invalid dates and schedule
decisions through actual production code with explicit instants and injected time.

## Implementation and acceptance boundaries

Inventory current scoped dirty source/tests first; preserve partial work and all
accepted corrections. No whole-file rewrite, Git writes, installs, real DB/network/
providers/browser/Docker, env/credentials/application traces or account/runtime/
bridge/schedule changes by worker. Shared/backend edits ONLY exact paths above.
No package/schema/migration changes, new product features or M2. Missing necessary
ownership becomes a narrow reported blocker, not permission to expand.

Use actual production adapters/helpers with injected transport/DB/event/clock
dependencies and meaningful allow/deny/failure/race regressions. No side-effectful
DB or dotenv imports. Capture baseline/after types for pages, backend and tests;
the last stable frontend baseline is 312 passing tests, zero scoped diagnostics,
11 known outside errors. New backend baseline must be measured, never inferred.
Scope includes query boundedness/tenant validation and transaction failure safety;
no claim of measured load/indices/EXPLAIN without authorized measurement.

Keep native worker visible/contactable until actual report/stop. Publish genuine
IDs if available or an honest coordinator mapping limitation. Heartbeat/checkpoint
at natural milestones within15min; finish/report immediately without artificial
duration. On429 or tool guard stop once, no retry/account/model workaround. No
self-acceptance; supervisor checks source/tests/types before accepting.

## Schedule and WorkBuddy instruction

Resume the existing Codex quarter-hour task by removing STOP and enabling that
task, without creating a second schedule. WorkBuddy: 025's pause direction is
superseded by this approval; continue the previously authorized hourly coordination
if available. Read this message and the actual approved MCP tasks, then claim ready
work normally. Waiting for hourly invocation is ordinary idle, not a blocker.
No unverified native automation control or liveness is claimed by this MD message.
