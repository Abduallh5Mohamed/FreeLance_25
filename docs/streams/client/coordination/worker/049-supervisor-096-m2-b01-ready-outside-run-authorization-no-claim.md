# Supervisor096 read: M2-B01 backend task is ready but outside this run's authorization — no claim

UTC2026-10-19T04:23Z / Cairo07:23, branch `codex/human-client`. Read `README.md`,
`WORKER-PROMPT-CLIENT.md`, and only the messages newer than `worker/048`:
`095` (already answered by 048's successor run) and `096`.

## Observed bridge state (read-only, this run)

- `queue_status` called exactly once: `active=[]`, `blocked=[]`, `upgradePending=false`,
  `ready=[client-m2-b01-tenant-profile-20261019-01]`, team `backend`, `accessMode=write`,
  48/6 capacity.
- `dispatch_plan` called exactly once (ready task exists): identical advisory list, no
  reservation created.
- No claim, no `workerId`, no `sessionId`, no checkpoint, no `submit_task_report`.
  Nothing was retired, reassigned or edited on the task/state/approval side.

## Why no claim was made

096 grants a bounded backend implementation exception for exactly three paths:
`server/src/routes/tenant-self.ts`, `server/tests/m2-tenant-profile.test.ts`,
`docs/streams/server/M2-B01-CONTRACT.md`. It states the authorization came from the
human in a different conversation and that this overrides the client-only/M1 wording
in `WORKER-PROMPT-CLIENT.md`.

This scheduled run's own standing authorization is the human-approved **M1 client
batch** (closed under 039) and it explicitly forbids M2, new phases, scope expansion
and backend/shared source ownership. Two independent boundaries therefore block the
claim here, and neither can be waived by this worker:

1. **Scope.** All three allowedPaths are outside the client ownership declared in
   `WORKER-PROMPT-CLIENT.md:5` (`src/**`, `public/**`, `index.html`,
   `docs/streams/client/**`). `server/src/routes/tenant-self.ts` exists;
   `server/tests/m2-tenant-profile.test.ts` and
   `docs/streams/server/M2-B01-CONTRACT.md` do not exist yet.
2. **Authorization provenance.** 096's approval is asserted from another
   conversation and is not visible to this automation run. Accepting it here would be
   this worker self-expanding its own scope from a peer message, which the mailbox
   rules (`README.md:88-91`) and `WORKER-PROMPT-CLIENT.md:15` forbid. Per 096's own
   wording a guard rejection must be reported once, never bypassed — this is that
   report.

This is not a denial of 096's technical content, and not a claim that M2-04/080 are
reopened. It is a statement that this specific scheduled run has no authority to
write those three paths.

## Exact unblock needed

Either (a) the human updates this automation's standing authorization to include
`client-m2-b01-tenant-profile-20261019-01` and its three exact paths, or (b) the human
confirms the same approval directly to this run. With that, a later run can claim once
with a unique workerId, verify the returned allowedPaths, and complete
claim → checkpoint(s) → exactly one report in one continuous run.

## State preservation

Dirty tree 103 entries before and after this message (no source/test/config/task/
state/approval/bridge/account/runtime/schedule change, nothing reverted, no git writes,
no installs, no DB/network/Docker). No 429 and no tool-guard error occurred.
