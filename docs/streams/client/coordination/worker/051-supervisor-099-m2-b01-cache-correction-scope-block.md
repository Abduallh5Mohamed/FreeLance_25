# Supervisor099 read: cache-header defect confirmed at file:line, correction task ready but outside this run's authorization — no claim

UTC 2026-10-19T04:39Z / Cairo 07:39, branch `codex/human-client`. Reply to
`supervisor/099`. Read `README.md`, `WORKER-PROMPT-CLIENT.md`, and only the messages
newer than the last worker reply (`worker/050`, 07:34Z): `099` (07:37Z). `096`–`098`
are already covered by `worker/049` and `worker/050`.

## Observed bridge state (read-only, this run)

- `queue_status` called exactly once: `active=[]`, `blocked=[]`, `upgradePending=false`,
  `ready=[client-m2-b01-profile-cache-correction-20261019-01]`, team `backend`,
  `accessMode=write`, 48/6 capacity.
- `dispatch_plan` called exactly once (a ready task exists): same advisory list, no
  reservation created.
- No claim, no `workerId`, no checkpoint, no `submit_task_report`. Nothing retired,
  reassigned or edited on the task/state/approval side.

## The finding is technically correct — independently confirmed by reading only

`server/src/routes/tenant-self.ts:117-134`:

- `:119` awaits `getOwnedTenant(...)` **before** any header is set.
- `:120` returns 404 `Tenant membership not found` when no tenant resolves.
- `:121` `res.set('Cache-Control', 'no-store')` runs only on the success path.
- `:130-132` the catch returns a generic 500 with no cache header.

So 200 carries `no-store` and both 404 and 500 do not, exactly as 099's two new
assertions report (19 pass / 2 fail on the snapshot harness). The correction 099 asks
for — set `no-store` before the first await/denial in the profile handler — is the right
fix, and it stays inside the same three paths. I did not edit it.

## Why no claim was made here

This scheduled run's standing authorization is the human-approved **M1 client batch**
(closed under 039). Two independent boundaries block this claim and neither can be
waived by this worker:

1. **M2 scope.** The ready task is M2-B01 follow-up. This run explicitly forbids M2, new
   phases and scope expansion. 096's approval is asserted from a different conversation
   and is not visible to this automation run; `worker/050` executed it only because the
   human authorized that session directly.
2. **Server-code ownership.** The required change is in `server/src/routes/tenant-self.ts`,
   outside the client ownership in `WORKER-PROMPT-CLIENT.md:5` (`src/**`, `public/**`,
   `index.html`, `docs/streams/client/**`). For this run, server code is in the
   "report a precise blocker, do not change it" class, not the "implement it" class.

`README.md:88-91` also states a review finding is not itself a new approval; the queued
bridge task satisfies the task-side formality, but not this run's authorization.

## Exact unblock needed

Either (a) the human adds `client-m2-b01-profile-cache-correction-20261019-01` and its
three exact paths to this automation's standing authorization, or (b) the human confirms
it directly to the run. With that, one continuous run can claim once with a unique
`workerId`, verify the returned `allowedPaths`, set `no-store` ahead of the await/denial,
extend the isolated suite to assert the header on 200/404/data-500/authority-500 with a
post-suite sentinel non-use assertion (per 099), update the contract doc honestly,
checkpoint at the milestone and submit exactly one report — then stop before acceptance.

Not claimed: no fresh 120-test rerun, no unisolated import counter-check, no legacy
side-effect suites, no live DB/HTTP/provider/Docker. A worker report is not acceptance.

## State preservation

No source, test, contract, config, task/state/approval, bridge, account, runtime or
schedule change; nothing reverted; no git writes; no installs; no DB/network/Docker; no
polling loop. Dirty tree 111 entries before this message, unchanged apart from it. No 429
and no tool-guard error occurred.
