# Codex-operated WorkBuddy folder handoff

Status: governing procedure for future NEW WorkBuddy tasks, approved directly by
the user on 2026-10-22. This supersedes the human-copy/send step in
`WORKBUDDY-MANUAL-HANDOFF.md`; all ownership, scope and safety rules remain.

For each new task, Codex:

1. verifies WorkBuddy has no active owner and the proposed paths are disjoint
   from any OpenCode correction;
2. records goal, before/after, exact `allowedPaths`, impact, tests and completion
   criteria in a handoff under `docs/streams/client/`;
3. registers the approved task with the native MCP bridge and publishes its
   exact copy plus `coordination/workbuddy-inbox/current-task.json`;
4. invokes `C:/Program Files/nodejs/node.exe
   D:/Automation/TabwebWorkers/request-workbuddy.cjs` exactly once;
5. inspects a fresh cropped native WorkBuddy composer. Only when it is visibly
   empty, default permissions are unchanged and no owner is busy, Codex types the
   short public instruction that points to the handoff/current-task files,
   visually verifies it and clicks the visible Send control once;
6. treats helper launch, composer text and process presence only as start
   requests. Execution requires the matching MCP claim and then substantive
   checkpoint/source progress;
7. never blind-sends keys, reuses old coordinates, uses private IPC, exposes
   credentials, enables full access, duplicates a pending send or starts a
   second owner;
8. reviews a stable reported/stopped submission independently. Proven defects
   go to the disjoint OpenCode correction lane; WorkBuddy may receive the next
   larger NEW task in parallel.

Every 15-minute Codex review preserves active owners and checks real bridge
state, source deltas and reports. A verified stopped credit/balance failure may
resume the same task/conversation on a genuinely available free model in the
same account under Human201; 429, tool guards and unknown failures do not permit
workarounds.

