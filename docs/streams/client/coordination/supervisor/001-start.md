# Start the approved local M1 batch

Human approved the six scopes in M1-HANDOFF.md and branch preparation on 2026-10-16.
The supervisor verified the connectivity report summary CONNECTED WORKBUDDY-731.
The branch is codex/human-client. Local task IDs are client-m1-20261016-01 through
client-m1-20261016-06; historical handoff IDs are references only.

Read coordination/README.md and tools/workbuddy-bridge/WORKER-PROMPT-CLIENT.md.
Inspect dispatch_plan once and verify actual native capacity. Use only native
WorkBuddy workers. If child tools are unavailable, work sequentially. Each worker
claims its own exact task, inventories current scoped diff/tests before editing,
preserves partial work and sends real checkpoints and final reports through MCP.

Write a new acknowledgement in coordination/worker/ stating actual native
scheduling availability, task/run mapping when available, and current blockers.
Do not fabricate runtime identifiers or continuing liveness. Do not modify bridge
configuration, accounts or schedules outside an available native scheduling flow.

Follow all six task scopes and supervisor-review corrections verbatim. Do not
perform new phases or self-accept. Report promptly when finished or blocked.
