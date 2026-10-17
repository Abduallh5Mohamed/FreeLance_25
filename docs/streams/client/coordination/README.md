# M1 coordination mailbox

Workspace: `D:\FreeLance_25-1\FreeLance_25-1`
Branch: `codex/human-client`
Bridge: `C:\Users\BaraaWael\TabwebClientBridge`

This folder supplements the existing MCP bridge. It does not replace approvals,
claims, checkpoints or reports. The original six local M1 scopes and the explicit
human-approved contract closure extension in supervisor/026 are authorized.
026 supersedes the original backend/shared prohibition ONLY for its exact task
allowedPaths and three contracts. All other boundaries remain in force.

- Codex writes `supervisor/`: review findings, exact paths, required corrections,
  verification evidence and acceptance decisions.
- WorkBuddy writes `worker/`: coordination acknowledgements, real native run/task
  mappings, progress summaries and report references. This explicit coordination
  permission does not expand any implementation task's allowedPaths.
- Each author creates a new uniquely named Markdown message; do not overwrite or
  delete the other author's messages. Reference message names in replies. Include
  actual UTC timestamp, task ID, changed paths, checks and blockers; no tokens,
  credentials, student data or application traces.
- WorkBuddy claims implementation work only through `next_approved_task`, and
  submits checkpoints/reports through MCP. No preclaims, duplicate workers,
  automatic retirement or direct changes to tasks/state/approvals.
- A review finding is not a new task approval. Follow-up implementation requires a
  separate scoped bridge task under the existing human-approved M1 scope, after
  verifying that previous activity on those files has stopped. New scope requires
  human approval. Never change an active task's scope.

If a native scheduler is available, the user authorizes a coordination check every
15 minutes for this M1 batch. Read only new messages and bridge status; resume only
approved runnable work. An active worker continues useful work and checkpoints at
natural milestones, without waiting for the interval. Completion or blockers are
reported immediately. Empty queues do not trigger busy polling or invented work;
only the next scheduled check may inspect for new approved instructions.

## Current cadence (user instruction, 2026-10-16)

Codex reviews every 15 minutes using the installed Windows scheduled task
`Tabweb-M1-Codex-Supervisor-15min`, which queues a message to the existing supervisor
thread. WorkBuddy is expected to check hourly under the user's latest arrangement;
its coordinator must acknowledge the actual configured schedule when it next runs.
This user arrangement supersedes the invocation-only pause recorded in 005.
An idle interval while awaiting the next hourly check is expected and does not by
itself justify stopping Codex scheduling or claiming WorkBuddy is running.

Use this same Markdown folder for instructions, questions, evidence and replies.
Codex posts review findings with precise files and acceptance checks; WorkBuddy
replies by message reference. Implementation follow-ups still use scoped MCP tasks,
not free-form instructions that bypass claims. No duplicate workers or scope edits.

Creating this folder alone did not configure a timer. Neither app is guaranteed
to run after its host closes. Report real scheduling failures. Stop on 429 without
retry loops or account/model changes. Stop on completion, cancellation or an
unresolved blocker that prevents further authorized progress and needs the human.
Record narrower API/product blockers separately while other approved work proceeds.

Codex reviews source diffs, API contract compatibility, authorization, stale-result
guards, duplicate submissions, failure retention, isolated behavioral tests and
scoped type diagnostics. A worker report is not acceptance. No live services, DB,
Docker, dependency installs, shared/backend changes outside the explicit 026
exception, merge/push/deploy or M2.
