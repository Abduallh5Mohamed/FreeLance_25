# Claude + WorkBuddy parallel ownership — 2026-10-19

Human authorized Claude Code agents alongside the existing WorkBuddy batch.
Codex supervises the combined review. This is not production/phase acceptance.

## Exclusive write ownership

| Executor | Exact task | Source files (under server/src) | Test |
|---|---|---|---|
| Claude schedules | claude-schedules-correctness-20261019-01 | routes/schedules.ts, services/schedules.ts | m5-schedules.test.ts |
| Claude attendance | claude-attendance-correctness-20261019-01 | routes/attendance-records.ts, services/attendance-records.ts | m5-attendance-records.test.ts |
| Claude audit | claude-audit-chain-correctness-20261019-01 | routes/audit-logs.ts, services/audit-log.ts | m7-audit-logs.test.ts |
| Claude moderation | claude-moderation-correctness-20261019-01 | routes/moderation.ts, services/moderation.ts | m7-moderation.test.ts |
| WorkBuddy | six server-*-recovery-20261019-01 tasks | assignments/storage, impersonation, MFA, outbox, search, export | Their task-specific files only |

Each Claude task also owns its distinct CLAUDE-*.md report as enumerated in
the bridge task JSON. No directory-wide write grants. Read imports for context,
but do not modify another owner's file or copy/rewrite its logic locally.

## Reservation protocol

Bridge: C:/Users/abdua/WorkBuddySupervisorBridge. Read its operating instructions.
Each agent must claim its exact task before writing, and stop if unavailable.
Use the connected mailbox MCP if exposed. A local Claude agent with Node access
may call the SAME mailbox API (not modify JSON state directly):

```js
const {createMailbox} = require('C:/Users/abdua/WorkBuddySupervisorBridge/mailbox-core.cjs');
const mailbox = createMailbox('C:/Users/abdua/WorkBuddySupervisorBridge');
// Exact taskId and fresh claude workerId, with team from its task JSON.
// mailbox.call('next_approved_task', {taskId, workerId, team});
// Keep returned claimToken private; never print it or send it in chat.
// Use task_checkpoint/task_heartbeat and submit_task_report per bridge schema.
```

No claim retries, token reuse, retire/reset, approval edits or worker launch
from shell. A claim coordinates files; it does not prove a model is alive.
If connector/API unavailable, stop writes and ask Codex to coordinate.

**WorkBuddy coordinator must skip all claude-* tasks. Claude must skip server-*.
The scheduler itself has no executor identity enforcement; both coordinators
must obey this rule and only dispatch their exact task IDs.**

## Quality and integration

- Reproduce source-backed defects, correct minimally, preserve positive access.
  A verified no-defect result is valid; do not invent refactors to fill a task.
- Focused guarded hermetic tests per agent; do not weaken assertions/skips.
- Shared index/auth/security/db/helpers/packages/manifest/migrations/frontend
  are excluded from this batch. Request a precise coordinated follow-up.
- Whole suites from repo and server cwd, typecheck and diff check run after
  all relevant writers stop. During edits failures are provisional, not proof
  of either success or regression. Record baseline/current source hashes.
- No Git writes, SQL, services, Docker, real providers, credentials or installs.
- SMS remains deferred; certificates excluded; a center student counts once.
- Stop agent activity before reporting. Codex reviews before acceptance.
