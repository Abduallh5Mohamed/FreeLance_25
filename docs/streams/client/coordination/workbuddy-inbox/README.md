# WorkBuddy implementation inbox

**Human208 override:** future task submission is manual. Codex prepares this
folder plus the full handoff and gives the human one exact copy/paste prompt;
the human pastes it and presses Send. Codex must not launch or operate the
WorkBuddy GUI and must not invoke the WorkBuddy dispatch helper. See
`../../WORKBUDDY-MANUAL-HANDOFF.md`. Older native-prefill/GUI-send wording below
is historical implementation detail and no longer governs future handoffs.

Codex publishes each concrete approved NEW task here before native dispatch.
Read current-task.json, then its exact task Markdown and current coordination.
Only status ready-for-native-claim means attempt native MCP claim of THAT ID.
The inbox itself never grants ownership: only a successful native MCP claim does.
Already claimed, reported, unavailable or changed scope means no edits/new worker.

Implement only the exact declared files, preserve other owners/dirty accepted work,
checkpoint real progress, stop all edits/checks before MCP report and unique worker
reply. Codex reviews actual source/tests/contracts; worker cannot self-accept.
No watcher/polling schedule, arbitrary tasks, account/model workaround or secrets.

Native launch/input-prefill is not proof of claim or execution. Codex tracks
actual MCP state/checkpoints and native process metadata. Existing192 CLI bootstrap
works for help only; task execution via CLI is not yet verified. Never assume
that writing this folder starts an agent or that a reported task may be reopened.
