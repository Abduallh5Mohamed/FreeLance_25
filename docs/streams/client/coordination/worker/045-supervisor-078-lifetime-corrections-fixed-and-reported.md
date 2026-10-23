# M2-04 correction: three lifetime defects fixed, verified, reported

UTC 2026-10-18T20:56Z / Cairo 23:56. Branch `codex/human-client`.

## Messages consumed

- `supervisor/078` — the only message newer than this stream's `worker/044`. It
  rejects the original submission, records the three independently reproduced
  lifetime defects and creates the bounded correction under the existing human
  M2-04 authorization with the SAME four `allowedPaths`.
- `supervisor/075`/`076` — governing cadence and the Codex-only/WorkBuddy-only
  clarification; unchanged, no `allowedPaths` expansion, no server/shared scope.
- `worker/044` is this stream's previous reply. Nothing was overwritten, edited
  or deleted; this is a new uniquely named file.

## Claim / run mapping

- `queue_status` once at 20:49Z: `active []`, `ready
  [client-m2-04-instructor-students-correction-20261018-01]`, `blocked []`,
  `upgradePending false`, maxActive 48 / maxPerTeam 6. `dispatch_plan` once
  (advisory, same single ready task). No polling loop.
- One claim, one worker: workerId `wb-m2-04-instructor-students-correction-01a`,
  team `frontend`. `approval.by = human`, approvalVersion 2, scopeHash
  `637ac095…ffa9c`, basis = the existing human M2-04 continuation (075) plus the
  bounded correction in 078. No second worker, no nested spawn, no preclaim, no
  owner replacement.
- `allowedPaths` verified before any edit — exactly the four existing paths:
  `src/pages/InstructorStudents.tsx`,
  `src/features/enrollment/instructor-students.ts`,
  `src/tests/m2-instructor-students.test.ts`,
  `docs/streams/client/M2-04-CONTRACTS.md`. Nothing outside them was written.
- No `sessionId` was available to this invocation, so no native run mapping is
  claimed. The claim token stayed in memory only — it is in no file, report or
  message.

## Inventory first (the reported implementation was preserved, not rewritten)

Read the whole 1431-line production controller, the page integration, the
52-test file and the contracts doc before touching anything. All three 078
defects were confirmed on the real source, not taken on trust:

1. `isCurrent` compared the principal and dropped the reply, but nothing ever
   ADOPTED an observed replacement — old confirmed rows, `inviteUrl` and
   `resetCode` survived a silent switch.
2. `decideRequest` returned `'approved'` after `await runRequestsRead()`;
   `submitStudent`, `approveReset` and `suspendStudent` had the same unguarded
   post-refresh return.
3. `inviteCopied` was written by whichever copy settled last, with no link
   incarnation.

## Corrections (narrow, inside the existing feature)

- **Observed identity adoption.** One `observePrincipal()` is now the only
  identity read: operation entry, every post-await commit and every read commit
  go through it. A replacement the page never announced runs the SAME retirement
  as an announced one (`applySessionChange`: all read generations invalidated,
  every latch released, busy cleared, confirmed rows dropped, invite link,
  `inviteCopied` and the one-time reset code cleared). Consecutive unchanged
  reads stay stable; A→B→A is two incarnations. In reads the generation is taken
  AFTER adoption, otherwise the retirement would invalidate the read's own
  generation and it could never commit.
- **Post-refresh revalidation.** `stillBound(principal, scope)` runs after every
  awaited refresh and before any page effect: `decideRequest` and its `stale`
  branch, `submitStudent`, `approveReset` and its `stale` branch,
  `suspendStudent`. It returns `blocked`, never `failed`: a confirmed server
  write is not turned into a retryable write failure, and the retired target or
  code is cleared by the retirement rather than re-sent.
- **Link incarnation fence.** The confirmed link has an `inviteLink` incarnation
  that advances on every rotation and on every retirement/scope change. A copy
  carries the incarnation it started on; if the link moved it returns the new
  `superseded` outcome and writes nothing, so an older copy can neither certify
  nor overwrite a newer link in either completion order. Manual copy still never
  rotates, and a refused rotation still keeps the confirmed link.
- Page: the copy button reports `superseded` honestly ("the link changed while
  copying; copy the one shown now"). No new action, field, policy or authority.

## Evidence (local, hermetic)

- `src/tests/m2-instructor-students.test.ts`: **66/66** — the 52 original tests
  unchanged plus 14 new regressions (silent replacement during a read; adoption
  at entry with a later failure showing an error and no old rows; observed
  A→B→A dropping a late reply; controller usable after adoption; decision /
  create / reset code / suspension not published when the session changes during
  their refresh; scope change during a decision refresh; `stale` refresh
  returning `blocked`; both copy races; copy after dispose; retried copy).
- All 14 client test files: **577/577** (563 baseline + 14).
- Supervisor's own external probes
  `C:/Users/BaraaWael/TabwebClientSupervisor/078-m2-04-review-probes.test.ts`
  (unchanged, imported against this production module): **3/3 pass**.
- `tsc -p tsconfig.app.json --noEmit`: **zero** diagnostics in the three
  TypeScript paths of this task, the same **11** pre-existing outside errors
  (NotificationBell, StudentHeader_OLD_BACKUP, ExamReports, ExamResults, Fees,
  StudentBarcodes, StudentDashboard, versionChecker); command still exits 2.
- `docs/streams/client/M2-04-CONTRACTS.md` now records the correction, the
  exact behaviour change per defect and these numbers.

## Limits / blockers

- Not proven: rendered DOM/RTL paint, real HTTP, real DB, end-to-end
  authorization, providers or live services, load/performance. No jsdom or
  testing-library is installed and installs are forbidden, so the page is
  exercised through the exact production seam it calls.
- Remaining contract gaps are unchanged and outside this task: C8 term/date/
  status transitions, C9 OTP (deferred 060), C10 eligibility/expiry evidence,
  C12 student import. `M2-B01` remains a prepared proposal, not approved
  implementation; no server ownership or shared session-reader edit was taken.
- No 429 and no tool-guard error in this run.

## State

Two `task_checkpoint` notes at real milestones (inventory complete,
implementation green) and exactly **one** `submit_task_report` → `reported` /
`awaiting_supervisor`. All implementation activity stopped before the report. A
report is not acceptance and no next phase is started. No git writes, no
installs, no DB/network/browser/Docker/live services, no migrations, no
deployment, no edits to tasks/state/approvals, bridge configuration, accounts,
runtime or schedules. All pre-existing uncommitted work is preserved untouched
(80 dirty entries before and after).
