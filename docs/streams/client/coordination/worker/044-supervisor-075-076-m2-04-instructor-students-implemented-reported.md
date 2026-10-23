# M2-04 instructor-side enrollment: claimed, implemented, verified, reported

UTC 2026-10-18T20:43Z / Cairo 23:43. Branch `codex/human-client`.

## Messages consumed

- `supervisor/075` — governing cadence + the concrete M2-04 slice (four exact
  paths, task `client-m2-04-instructor-students-20261018-01`).
- `supervisor/076` — team identity: only Codex and WorkBuddy execute; no external
  developer is awaited. Treated as clarification only; no `allowedPaths` change.
- `supervisor/077` — observed mid-run: it records that `worker/042` predates the
  M2-04 task and that `M2-B01-PROPOSAL.md` is prepared but NOT approved. No action
  taken on it; the backend proposal is outside this task and was not touched.
- `worker/042` is this stream's previous reply. Nothing was overwritten, edited or
  deleted.

## Claim / run mapping

- `queue_status` once at 20:30Z: `active []`, `ready [M2-04]`, `blocked []`,
  `upgradePending false`, maxActive 48 / maxPerTeam 6. `dispatch_plan` once
  (advisory, same single ready task).
- One claim, one worker: workerId `wb-m2-04-instructor-students-01a`, team
  `frontend`. `approval.by = human`, approvalVersion 2, scopeHash
  `3beca2fa…78f19`, basis = the direct human continuation request recorded in 075.
  No second worker, no nested spawn, no preclaim, no replacement of any owner.
- `allowedPaths` verified before any edit — exactly the four handoff paths:
  `src/pages/InstructorStudents.tsx`,
  `src/features/enrollment/instructor-students.ts`,
  `src/tests/m2-instructor-students.test.ts`,
  `docs/streams/client/M2-04-CONTRACTS.md`. Nothing outside them was written.
- No `sessionId` was available to this invocation and no native run mapping exists
  to report; that is stated rather than invented. The claim token stayed in memory
  only — it is in no file, report or message.

## Defects fixed (each confirmed in the real page source before editing)

1. `loadData` caught every section error and left `[]`, so a failed read rendered
   as a false empty list with no distinct error state. Now six independent reads,
   each with its own generation and phase; a failure keeps the last confirmed rows
   and reports the error beside them, and only a section with nothing confirmed
   becomes a full error.
2. `Number(walletData?.balance ?? 0)` fabricated a confirmed zero. Now
   `number | null`; `null` means unconfirmed, and a malformed body is an error too.
3. No generation/principal/dispose fence on any read: a slow reply could overwrite
   a newer one and a previous instructor's rows could survive a scope change. Both
   are now impossible.
4. `createInvite` rotated on every click — and rotation REVOKES the previous link
   (`student-enrollment.ts:35-63`) — while a clipboard refusal after a successful
   rotation was shown as a failed creation. Rotation is now single-flight, the
   confirmed link is kept on clipboard failure, and a deliberate copy retry never
   rotates.
5. `decideRequest` had no latch and kept no target. Now a synchronous latch before
   the first await, the target is retained on failure for a deliberate retry, and a
   server 404 `Pending request not found` is classified stale and refreshed instead
   of being re-sent as a new decision.
6. `addStudent` relied on React `saving` and cleared the form after `await` with no
   form incarnation. Now form incarnation + revision: a save started on a closed,
   replaced or edited form never clears or closes what the instructor is typing.

Also fenced, without changing policy: the manual password-reset issue path and the
video-security suspension (same prompts, same range 5..1440) gained only a
duplicate latch and a session fence.

## Evidence (local, hermetic)

- `src/tests/m2-instructor-students.test.ts`: **52/52**.
- All 14 client test files: **563/563** (baseline 511 from 074 + 52 new).
- `tsc -p tsconfig.app.json --noEmit`: **zero** diagnostics in the three
  TypeScript paths of this task, the same **11** pre-existing outside errors
  (NotificationBell, StudentHeader_OLD_BACKUP, ExamReports, ExamResults, Fees,
  StudentBarcodes, StudentDashboard, versionChecker); command still nonzero.
- Covered: per-section failure/empty independence, malformed body ≠ empty,
  unconfirmed wallet ≠ zero, slow and reversed replies, scope change, duplicate
  add/approve/reject/rotate/reset/suspend, failure then exactly one retry,
  confirmed write then failing refresh or refused clipboard, edit/close/session
  during the await, stale 404, older `finally` vs newer busy, dispose, and private
  outputs cleared on session change.
- `docs/streams/client/M2-04-CONTRACTS.md` records the source-verified contracts
  with `file:line`, the fixes, the fences, the unchanged policies, the limits and
  the remaining C8/C9/C10/C12 gaps.

## Limits / blockers

- Not proven: rendered DOM/RTL paint, real HTTP, real DB, end-to-end
  authorization, providers or live services, load/performance. `package.json` has
  no jsdom/happy-dom/@testing-library and installs are forbidden, so the page is
  exercised through the production seam it actually calls.
- Remaining contract gaps are unchanged and outside this task: C8 term/date/status
  transitions, C9 OTP (deferred 060), C10 eligibility/expiry evidence, C12 student
  import. No invented field, policy or completion claim.
- No 429 and no tool-guard error in this run.

## State

Two `task_checkpoint` notes at real milestones (inventory complete, implementation
green) and exactly **one** `submit_task_report` → `reported` / `awaiting_supervisor`.
All work stopped before the report. A report is not acceptance and no next phase is
started. No git writes, no installs, no DB/network/browser/Docker/live services, no
migrations, no deployment, no edits to tasks/state/approvals, bridge configuration,
accounts, runtime or schedules. All pre-existing uncommitted work — including the
accepted 039/055/067/074 files — is preserved untouched (78 dirty entries before
and after).
