# M2-04 scope correction: A→B→A revival and retired-scope latches fixed, verified, reported

UTC 2026-10-18T21:09Z / Cairo 2026-10-19 00:09. Branch `codex/human-client`.

## Messages consumed

- `supervisor/079` — the only message newer than this stream's `worker/045`. It
  accepts the three 078 corrections, then rejects the submission for two
  remaining **scope-lifetime** defects, with two external production probes.
- `supervisor/075`/`076`/`078` — governing cadence, the Codex-only/WorkBuddy-only
  clarification and the 078 correction already implemented in `worker/045`.
  Unchanged: no `allowedPaths` expansion, no server/shared/backend scope.
- `worker/045` is this stream's previous reply. Nothing was overwritten, edited
  or deleted; this is a new uniquely named file.

## Claim / run mapping

- `queue_status` once at 21:05Z: `active []`, `ready
  [client-m2-04-instructor-students-scope-correction-20261018-01]`, `blocked []`,
  `upgradePending false`, maxActive 48 / maxPerTeam 6. `dispatch_plan` once
  (advisory, same single ready task). No polling loop.
- One claim, one worker: workerId `wb-m2-04-scope-correction-01a`, team
  `frontend`. `approval.by = human`, approvalVersion 2, scopeHash
  `852d531d…4e891`, basis = the existing human M2-04 four-path continuation
  (075) plus the bounded correction in 079. No second worker, no nested spawn,
  no preclaim, no owner replacement.
- `allowedPaths` verified before any edit — exactly the four existing paths:
  `src/pages/InstructorStudents.tsx`,
  `src/features/enrollment/instructor-students.ts`,
  `src/tests/m2-instructor-students.test.ts`,
  `docs/streams/client/M2-04-CONTRACTS.md`. Nothing outside them was written.
- No `sessionId` was available to this invocation, so no native run mapping is
  claimed. The claim token stayed in memory only — it is in no file, report or
  message.

## Defects confirmed on the real source (not taken on trust)

Both 079 findings reproduce against the 078-corrected controller:

1. `stillBound(principal, scope)` compared the scope **id** only. Because
   `adoptScope` leaves `scopeId` as the last adopted id, A→B→A made the old
   operation's check pass again and it returned `approved` — the old scope was
   revived by returning to its id.
2. `adoptScope` invalidated read generations but never released the mutation
   latches or `busy` entries. A decision awaiting transport in A kept
   `decisionGuard` held, so B's legitimate decision was answered `duplicate`
   and never reached the transport.

## Corrections (narrow, inside the same controller)

- **Monotonic scope lifetime.** `scopeIncarnation` advances on every scope
  change and on every session retirement. `bindOperation()` captures
  `{principal, scope, scopeIncarnation}` **before** the first await of each
  mutation (`submitStudent`, `decideRequest`, `rotateInvite`,
  `copyInviteLink`, `approveReset`, `suspendStudent`); `stillBound(binding)`
  re-validates all three after every await — success, error, `stale` refresh,
  post-write refresh and page outcome. A→B→A is therefore a new lifetime and
  returns `blocked`, not a success and not a retryable failure.
- **Synchronous retirement of the old scope's operations.** `adoptScope` bumps
  the incarnation and calls `retireScopeOperations()` (release every latch,
  drop every `busy` entry) before the new reads start, so the new scope can
  mutate immediately.
- **Old `finally` ownership.** Release is ticket-bound: `release(token)` only
  frees its own holder and `endOperation(ticket)` deletes only its own key. A
  newer scope acquires a newer ticket, so a retired operation settling during
  the newer transport can neither free the newer latch nor clear its `busy`
  entry.
- **Session retirement ends the scope lifetime too** (`retireInFlight` bumps the
  incarnation), so an operation that began before an identity change can never
  be validated by a later scope.
- Untouched on purpose: read generations, `inviteLink` and form incarnation,
  server write authority, every policy and every outcome vocabulary. No new
  action, field, service, provider or shared helper.

## Evidence (local, hermetic)

- `src/tests/m2-instructor-students.test.ts`: **72/72** — the 66 existing tests
  unchanged plus 6 new scope-lifetime regressions (A→B→A cannot revive an
  in-flight decision and publishes no error/removal; a new scope decides while
  the retired transport is unresolved, with the old `finally` unable to clear
  the newer busy entry or free its latch — a third click is still `duplicate`;
  a retired scope's failure never publishes its error; A→B→A during a decision
  refresh returns `blocked`; a create confirmed under the first A is not
  published after A→B→A; the new scope's add is not blocked and the reset code
  stays private).
- All 14 client test files: **583/583** (577 after 078 + 6).
- Supervisor's own external probes against this production module, unchanged:
  `078-m2-04-review-probes.test.ts` **3/3** and
  `079-m2-04-scope-probes.test.ts` **2/2** pass.
- `tsc -p tsconfig.app.json --noEmit`: **zero** diagnostics in the three
  TypeScript paths of this task, the same **11** pre-existing outside errors
  (NotificationBell, StudentHeader_OLD_BACKUP, ExamReports, ExamResults, Fees,
  StudentBarcodes, StudentDashboard, versionChecker); command still exits 2.
- `docs/streams/client/M2-04-CONTRACTS.md` records the 079 correction, the
  exact behaviour change per defect and these numbers.
- All 078 corrections and every pre-existing uncommitted file are preserved
  untouched (80 dirty entries before this review's two new coordination files,
  82 now; no revert, no checkout, no stash).

## Limits / blockers

- Not proven: rendered DOM/RTL paint, real HTTP, real DB, end-to-end
  authorization, providers or live services, load/performance. The probes hold
  the principal constant on purpose, so they establish the controller's scope
  contract, not a live cross-account exploit.
- Remaining contract gaps are unchanged and outside this task: C8 term/date/
  status transitions, C9 OTP (deferred 060), C10 eligibility/expiry evidence,
  C12 student import. `M2-B01` remains a prepared proposal, not approved
  implementation; no server ownership or shared session-reader edit was taken.
- No 429 and no tool-guard error in this run.

## State

One `task_checkpoint` at the implementation-green milestone and exactly **one**
`submit_task_report` → `reported` / `awaiting_supervisor`. All implementation
activity stopped before the report. A report is not acceptance and no next
phase is started. No git writes, no installs, no DB/network/browser/Docker/live
services, no migrations, no deployment, no edits to tasks/state/approvals,
bridge configuration, accounts, runtime or schedules.
