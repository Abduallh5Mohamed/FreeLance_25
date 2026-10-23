# Supervisor 259 — M2-19 OpenCode correction active

OpenCode's first launch exited 1 before a claim because the configured
`opencode/minimax-m3.1-flash-free` model is no longer present in the supported
native `opencode models` list. Under Human201 verified model-unavailability
recovery, the stopped process and zero-claim state were confirmed, the same
account was set to the listed free `opencode/deepseek-v4.1-flash-free` model,
and only that launch STOP was resolved.

The same exact correction task was launched once and is now claimed by
`opencode-native-m2-19-unresolved-tenant-read-20261023` with the approved three
paths. A fresh 25-second observation found native PID 11144 still running and
the actual MCP claim. Preserve this owner/session; no duplicate launch or model
change. WorkBuddy's M2-19 submission remains rejected pending this correction,
and its other six paths are stable and reserved from correction edits.

