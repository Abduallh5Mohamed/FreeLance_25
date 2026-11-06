# OpenCode stall diagnosis and supervisor repair — 6 November 2026

Owner explicitly requested diagnosing and fixing the stalled worker. Product
implementation remains OpenCode-owned; no product files were repaired by Codex.

## Confirmed cause and sequence

The correction's native generation stopped emitting events at 20:56:15 Cairo.
The process and claim stayed alive; the local log held AI_APICallError, while
the CLI JSON event stream never emitted a terminal error. Initial inspection
looked for HTTP 429/quota/auth codes and did not identify a cause. That was
insufficient: the operational message uses **free usage limit** without an HTTP
status. Deeper classification confirmed that usage allowance had been exceeded.
No provider payload, credentials or raw native/MCP output were printed or saved.

Before that deeper classification, one controlled recovery was performed under
the owner's explicit repair request. All 22 existing allocated files were
snapshotted. Only the exact native PID 1492 with parent 9336 was interrupted
after checking its executable and verifying no tool was in progress. Both old
processes were verified absent; original claim/session/model were preserved.
Same session resumed with host 19896 / native 21916, but produced no new model
events or product edits. The newer log then made the free-usage-limit category
clear. Recovery did not fix provider availability. The recovered process was
stopped too; there is no overlapping or replacement writer.

The prior recovery evidence is now explicitly invalidated for further use.
No further retry, model/account change, paid fallback, permission change or
attempt to route around the provider's allowance is authorized/performed.
An exact reset time was not supplied by the diagnostic message.

## Actual supervisor repair

- Runner detects ten minutes without output as stalled, rather than treating
  process liveness as successful progress. It does not automatically relaunch.
- A bounded local log-health check recognizes free-usage-limit messages even
  without 429, as well as explicit quota/auth errors. No raw log text is persisted.
- Confirmed provider blocks are persisted in
  `D:/Automation/TabwebBusinessSupervisor/provider-quota-block.json`; preflight
  refuses further model launches while blocked. This is a local supervisor
  safety stop, not a modification of OpenCode's permission/approval guards.
- Resumed native session ID remains in status even if the request emits zero
  events. Genuine tool permission rejection is terminal and never retried.
- Same-owner recovery policy verifies exact task/session/worker, stopped native
  PID, explicit repair authority and absence of any known quota/auth/guard fault.
  It neither reclaims nor retires an active task or expires an overdue lease.

Infrastructure tests: **11 pass / 0 fail** across
`native-failure-policy.test.cjs` and `stall-recovery-policy.test.cjs`; Node syntax
checks pass. No new product tests or acceptance are attributed to this repair.
Code and tests are under `D:/Automation/TabwebBusinessSupervisor/`.

## Remaining external prerequisite

The allowance itself cannot be reset by a code repair. Resume requires confirmed
provider availability/reset or a new explicit user decision about legitimate
authorized provider/model usage and any cost. Do not switch free models/accounts
to evade a quota. Keep the same claimed task and preserved partial source. The
15-minute supervisor schedule can observe status, but must not send model
requests or dispatch another task while this confirmed provider block remains.
