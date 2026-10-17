# Worker ack for supervisor 025 and 026 — three approved M1 contract closures implemented

Author: WorkBuddy (M1 client batch coordinator, human-client account).
UTC: 2026-10-16T20:43:31Z. Branch verified `codex/human-client`.
References: supervisor/025 (correction batch closed, stop recorded) and
supervisor/026 (human approved the three contract closures; 025's stop
superseded for this bounded extension). Queue inspected first
(queue_status: active=[], three ready tasks), then dispatch_plan (no
conflicts), then all three tasks claimed via next_approved_task, each with
its own unique workerId, no nested spawning, no preclaims. All existing
uncommitted work was preserved; nothing was reverted, committed or pushed.

## Native run/session mapping limitation

No native run/session IDs are available from this coordination layer. The
worker-to-task mapping is coordinator-reported only:

| Task | workerId |
| --- | --- |
| client-m1-contract-cairo-attendance-20261016-03 | wb-worker-cairo-20261016-03 |
| client-m1-contract-offline-courses-20261016-02 | wb-worker-offline-courses-20261016-02 |
| client-m1-contract-session-20261016-01 | wb-worker-session-20261016-01 |

The native scheduler/pause control requested in 025 and 026 was not
configured or verified by this run — no schedule, bridge, account or runtime
changes were made (out of authorized scope). 026's resume direction supersedes
025's pause, so no pause was applied.

## client-m1-contract-cairo-attendance-20261016-03 — implemented

- New `src/lib/attendance-calendar.ts` and `server/src/lib/attendance-calendar.ts`
  (mirrored): Africa/Cairo business-day helper — strict YYYY-MM-DD validation
  (2026-02-30 rejected, no rollover), DST-aware instant→Cairo-day conversion
  through runtime Intl (no hardcoded UTC+2/+3, no host-local math), injectable
  `todayDayKey`, `normalizeAttendanceDay`, schedule arithmetic.
- `server/src/routes/attendance.ts`: `normalizeDay` delegates to the helper;
  an absent `attendance_date` defaults to the Cairo day via a new injectable
  `now` dep (default binds the real clock; production export unchanged
  otherwise).
- Pages: Attendance.tsx (Cairo default day, Cairo-day record comparison),
  QRAttendance.tsx (scan duplicate detection and loads key on Cairo days via
  `getAttendance` with explicit keys), BarcodeAttendance.tsx (today key and
  previous-scheduled-day lookback on Cairo days; the today/absent key
  disagreement near midnight is gone), AttendanceLog.tsx (Cairo month
  default, Cairo-day row keying).
- Payment month/year lookups deliberately untouched (explicit billing
  prohibition).
- Checks: server tsc 0 errors; frontend tsc only the 11 known outside errors;
  12/12 new server route+helper tests (injected clock: Cairo-next-day default
  at 21:30Z, explicit-key preservation, invalid-key 400, instant conversion,
  Cairo-day duplicate guard, date-filter normalization, invalid filter 400);
  frontend 320/320 at that stage including 7 helper+parity tests and a
  controller test pinning the Cairo today/previous-session keys.

## client-m1-contract-offline-courses-20261016-02 — implemented

- New bounded helper `server/src/lib/offline-student-courses.ts`: course_ids
  validation (array of unique non-empty ids, bounded), caller course authority
  mirroring the canonical `courseScope` (admin unrestricted / selected tenant /
  tenant-less), absent-vs-empty semantics, added/removed diff, and the
  production transaction binding (INSERT IGNORE additions, diff-only deletes,
  retained rows keep status/progress/enrollment_date).
- `server/src/routes/students.ts`: POST applies the selection inside the
  existing student/user transaction (rollback on refusal/failure); PUT gets a
  transactional path when `course_ids` is present (the non-course path is
  byte-for-byte the previous behavior); `course_ids` CSV added to all student
  read SELECTs (read contract, existing fields preserved). No schema,
  migration, billing or entitlement change; student_courses schema inspected
  read-only — it carries no payment/entitlement coupling, so no contract
  blocker arises from enrollment writes.
- `src/pages/OfflineStudents.tsx`: create always sends the explicit selection
  (`[]` = none); update sends it only when the selector list loaded (absent =
  preserved server-side); the edit dialog pre-selects canonical `course_ids`
  (ids outside the visible list are kept so a save re-sends them instead of
  silently dropping); the old nonpersistence notice is replaced by a true
  persistence notice. Removed Auth.tsx-style redundant writes are not involved
  here.
- Checks: 14/14 new injected-seam helper tests (absent=no-write, non-array
  400, nonexistent 404, out-of-authority 403, admin authority, diff replace,
  explicit clear, retry no-op, production SQL shape); server suite 813/817,
  frontend 324/324 at that stage; both tsc projects zero scoped errors.

## client-m1-contract-session-20261016-01 — implemented

- New `src/lib/session-events.ts`: the small explicit same-document contract —
  `{ kind }`-only payload (no token/user/private-link data), notify after
  complete mutations, unsubscribe on unmount, throwing subscribers isolated,
  no storage monkeypatch or polling.
- Publishers wired (audited — every active session write site under src/ is
  covered): `signIn`/`signUp` (`login` after token+identity stored),
  `clearAuthToken` (`logout` after all keys removed — covers InstructorHeader
  logout and the TENANT_SUSPENDED path), Header.tsx and StudentHeader.tsx
  logouts canonicalized onto `clearAuthToken` (duplicate raw removals
  removed), `useSecuritySupervisor` force-logout (`logout` after storage
  clears), `SecureVideoPlayer` force-logout (`logout` after storage clears),
  `StudentSpaces` space switch (`scope` after both writes), and the
  BILLING_ONLY identity rewrite in api-http (`identity`). Auth.tsx's
  redundant post-signIn identity write was removed so the notification can
  never precede a later mutation.
- Subscribers wired: AuthGuard (re-reads the stored session on any change),
  Header (identity refresh / logout clear), OnlineMeeting and StudentMeetings
  (invalidate in-flight loads AND clear already-rendered private meeting data
  on any session change, before stale responses can commit), SecureVideoPlayer
  (token-clearing path only: pause, clear src, destroy HLS — no playback or
  protection behavior change). InstructorHeader/StudentHeader hold no cached
  identity state (props/form state), so no subscriber was added there.
- `StudentHeader_OLD_BACKUP.tsx` still holds raw session removals — excluded
  by the approved scope ("OLD_BACKUP components are excluded"); reported, not
  modified.
- Checks: 7/7 new bus tests (payload shape exactly `{ kind }`, all five kinds,
  immediate unsubscribe, throwing-subscriber isolation, inert no-op);
  full frontend suite 331/331 (all eight suites, including the existing
  30/30 meeting-support suite with its three stubbed api-http surfaces
  updated for the canonical `clearAuthToken` export); frontend tsc only the
  11 known outside errors; server suite unchanged at 813/817.

## Blockers and observations (precise, no scope expansion taken)

1. `src/lib/api-http.ts:1035-1042` — `getAttendanceByDate` formats the Date
   with host-local date parts. It is a shared api-http helper and is NOT in
   the Cairo task's allowedPaths (api-http.ts is authorized only for the
   session task), so it was not modified. QRAttendance switched its call
   sites to `getAttendance({ date: <Cairo key> })`, so the page is correct on
   every host; the helper itself would need its own scoped change. On the
   Cairo production host the gap is a no-op.
2. Three pre-existing server test failures, outside scoped ownership and
   untouched by this work: `server/tests/m1-expanded-file-authority.test.ts`
   (two tests — emitted-SQL whitespace regex mismatch:
   `f.tenant_id=?` vs `/tenant_id = \?/`) and
   `server/tests/m1-test-target-safety.test.ts:156` (refusal echoes
   "fragment" text). They failed identically before and after this batch.
3. BarcodeAttendance payment month/year remain on the existing billing
   convention — an explicit prohibition in the Cairo task, recorded here so
   the choice is traceable.
4. Native automation pause/resume control: not configured or verified
   (schedules are out of authorized scope). The hourly coordination check
   that produced this run is the only scheduling evidence available.

No tasks/state/approvals, bridge configuration, accounts, runtime or
schedules were modified. No git writes, installs, real DB, live services,
network providers or Docker. No M2, no new phases, no self-acceptance —
three `submit_task_report` calls were made through the bridge, each after
its claim's work fully stopped.
