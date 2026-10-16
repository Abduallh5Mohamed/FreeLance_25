# WorkBuddy portable local bridge v2

Portable copy of the existing supervisor mailbox. No account keys, production claims, state, worker logs or task approvals are distributed. Runtime dependencies: Node.js built-ins only; Node.js 22 recommended. This is a local stdio MCP mailbox, not a remotely authenticated service or a model launcher.

See [developer 2 setup](../../docs/21-developer-two-workbuddy-setup-ar.md). Run setup from the developer's repository copy and choose a new live directory outside Git. It refuses to overwrite an existing bridge. The `--approve-connectivity` flag authorizes only an empty-path connectivity task. All implementation batches still require explicit local human approval and file ownership under the two-developer plan.

`server.cjs` exposes seven worker tools. `supervisor-control.cjs` is local supervisor-only and must not be provided as an MCP worker tool. Claims expire only as warnings; retirement requires verified native termination and a new scoped recovery task. Limits coordinate cooperating workers; they are not an OS sandbox.

Existing diagnostic commands (not automatically executed by setup): `node selftest.cjs` and `node --test scheduler.test.cjs`. They use temporary fixtures; they are not live application or database verification. The copied kit has not been re-tested as part of this handoff.
