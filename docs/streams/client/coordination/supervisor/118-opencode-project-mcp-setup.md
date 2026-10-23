# OpenCode project MCP setup

Human requested connecting OpenCode to Codex supervision after worker change117.
Added project opencode.json: local tabweb_supervisor MCP uses system Node and
C:/Users/BaraaWael/TabwebClientBridge/server.cjs; project instructions point to
docs/streams/client/OPENCODE-WORKER.md. No credentials embedded, provider/account
configuration changed, task claimed or product source modified.

Verification: parsed project JSON and launched its exact configured command with
stdio JSON-RPC initialize, tools/list and read-only dispatch_plan. Exit0, initialize
succeeded, seven worker tools discovered. Dispatch observed active=[], blocked=[],
ready=[client-m2-05-profile-correction-recovery-20261019-01]. Supervisor-control
is not exposed. This proves the local command/bridge handshake, not that the
running OpenCode Desktop has reloaded this project configuration or begun work.

Next action: human opens/reopens this workspace in OpenCode and requests it to use
tabweb_supervisor, read current coordination instructions and claim the approved
ready task. OpenCode must report actual connection/claim evidence; never invent a
native run ID. Codex reviews stable submitted code and directs scoped corrections.
No HTTP listener, account sharing or external messaging channel is needed: the
existing local MCP mailbox and project coordination Markdown carry the exchange.

Supervisor scheduling remains stopped by human request. No background scheduling,
old-claim retirement, new task approval, live service or model invocation performed.
