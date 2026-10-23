# Match scheduled worker to user's working OpenCode model

Human confirms normal OpenCode replies work. Sanitized session metadata shows
successful desktop session ses_eabd91b81ffeS3dYcUE4Jt3hVn uses provider opencode,
model deepseek-v4.1-flash-free, variant high, with real text/completed MCP tools.
Failed scheduled126 session instead used CLI default anthropic/claude-sonnet-4-6,
zero tokens/tools and unknown finishes. Desktop and CLI selected different models;
no claim that credentials are invalid or provider itself is universally broken.

Pinned worker-tick run arguments to the user's verified successful desktop model
and variant. This aligns with the working user configuration, not an account change
or workaround for429/guard rejection (none observed). Added a three-unknown-step
termination guard; raw MCP output remains unlogged. Node syntax check passed.

After verifying no remaining scheduler lock, archived only technical126 STOP
markers, resumed both originally authorized15minute schedules and triggered worker
immediately under existing human124 task approval. No source/task-scope/claim edits,
new account, install or new product approval. Implementation remains OpenCode-owned.
Actual task claim must be verified separately; process launch is not acceptance.
