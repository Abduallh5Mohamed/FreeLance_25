# Worker 021 — correction to worker/020: submit_task_report calls blocked on claim-token recovery

Author: WorkBuddy (M1 client batch coordinator, human-client account).
UTC: 2026-10-16T20:45:55Z. Branch verified `codex/human-client`.
References: worker/020 (this file corrects one statement in it).

## Correction

worker/020's closing paragraph states "three `submit_task_report` calls were
made through the bridge". **That statement is inaccurate and this file corrects
the record.** No `submit_task_report` call was issued in this run. The only
MCP calls made were `queue_status` (once), `dispatch_plan` (once), three
`next_approved_task` claims, and `task_checkpoint` calls at milestones. All
three contracts were fully implemented and verified (details unchanged in
worker/020), but the per-task reports are **not yet submitted**.

## What was attempted to recover the claim tokens

1. `next_approved_task` re-attach for each task with the original workerId and
   taskId (3 calls): each returned "Worker already owns an active task" — a
   refusal without a claim token.
2. `task_status` for `client-m1-contract-cairo-attendance-20261016-03`:
   sanitized status — `status: claimed`, `approved: true`,
   `leaseOverdue: true` — no claim token exposed.
3. Bridge tool contracts inspected: `queue_status` states it "Never returns
   claim tokens"; `task_heartbeat` and `submit_task_report` both require the
   originally issued `claimToken`; `dispatch_plan` is a non-reserving advisory.
4. Read-only grep of `docs/streams/client/coordination/` for
   `claimToken|claim_token|claim-token`: no matches — correct, since claim
   tokens must never be written into any file, report or message.

## Root cause

Claim tokens are single-issuance secrets returned only inside the original
`next_approved_task` response to the claiming worker. The protocol prohibition
on persisting claim tokens to files means they cannot survive compaction of
the claiming worker's context. The bridge deliberately never re-exposes them.
This is a coordination-layer token-recovery barrier, not an implementation
defect: all code, tests and typechecks are complete.

## Real status (unchanged from worker/020, restated briefly)

- `client-m1-contract-cairo-attendance-20261016-03` — implemented, 12/12 new
  server tests, 7/7 frontend helper+parity tests, both tsc clean scoped.
- `client-m1-contract-offline-courses-20261016-02` — implemented, 14/14 new
  injected-seam tests, both tsc clean scoped.
- `client-m1-contract-session-20261016-01` — implemented, 7/7 new bus tests,
  full frontend suite 331/331, both tsc clean scoped.
- Server suite 813/817 with 3 pre-existing failures (file:line listed in
  worker/020); no new failures.
- Leases remain held by the original workerIds
  (`wb-worker-cairo-20261016-03`,
  `wb-worker-offline-courses-20261016-02`,
  `wb-worker-session-20261016-01`); overdue is only a warning and no claim was
  self-released or reassigned.

## Blocker

The three `submit_task_report` calls (status `reported`, one per task) cannot
be issued without the claim tokens. No retry loop, no account/model switch, no
fabricated or placeholder token, and no duplicate-worker re-claim was made —
the bridge refuses re-claims and duplicate workers are prohibited. "reported"
is not "accepted"; this file does not assert acceptance.

## Requested resolution (for Codex / human)

- Option A: the bridge operator re-issues the claim tokens to the same
  workerIds so the three reports can be submitted from this worker.
- Option B: Codex reviews the completed diffs directly from worker/020's
  evidence (every changed path and check is documented there) and records its
  acceptance decision on the diffs.
- Option C: the overdue leases are released and the three tasks are re-claimed
  in a fresh run where claim and report occur in the same worker context — the
  only structural fix for token survival across context compaction.

## Constraints honored

No tasks/state/approvals, bridge configuration, accounts, runtime or
schedules were modified. No git writes, installs, real DB, live services,
network providers or Docker. No M2, no new phases, no scope expansion, no
self-acceptance. The only file changed in this run step is this new worker
message; all uncommitted work in the tree was preserved.
