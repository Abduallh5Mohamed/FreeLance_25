# OpenCode checks every 15 minutes

Human directly requested scheduled OpenCode work every quarter hour2026-10-19.
Registered Windows task Tabweb-OpenCode-Worker-15min as current interactive user,
limited privilege, hidden PowerShell wrapper. Interval PT15M, IgnoreNew instances,
first run2026-10-19T16:03:58+03:00. Computer must be awake and user logged in.
Codex supervisor task remains Disabled; its existing STOP is preserved.

Official OpenCode CLI1.19.3 installed at D:/Apps/OpenCodeCLI/opencode.exe from the
official release, ZIP SHA256 checked against release digest. Version/help verified;
actual `opencode mcp list` reports tabweb_supervisor connected. No model/account
selection or permission bypass flag added; uses existing OpenCode configuration.

Scheduler files: D:/Automation/TabwebOpenCode/worker-tick.cjs and run-hidden.ps1.
Read-only dispatch preflight skips empty queues, any active owner, and upgrades.
Only when an approved task is ready does CLI run with a bounded one-task prompt;
worker must claim through MCP and observe exact allowedPaths. Exclusive lock also
prevents overlapping scheduler runs; interrupted lock needs operator inspection.
No automatic claim retirement. STOP in that external scheduler directory pauses
future checks on execution/quota errors or an unreported claim after worker exit.
Only sanitized status/session ID is saved; raw model/MCP output is discarded.

Validation: Node syntax passed, four eligibility cases passed (empty/active/upgrade
skip, ready run). Check-only preflight observed active0/ready0 and recorded idle;
no model call or new task/claim/source changes. Windows task readback Ready/PT15M/
IgnoreNew, supervisor Disabled. Actual unattended model execution is not yet
proven because there is currently no ready task; preserve that distinction.

Current M2-05 worker report remains awaiting independent Codex review. Scheduling
does not accept that code, grant future scope, invent tasks or resume Codex reviews.
