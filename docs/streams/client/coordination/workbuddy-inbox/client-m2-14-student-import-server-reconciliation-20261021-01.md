# WorkBuddy task client-m2-14-student-import-server-reconciliation-20261021-01

Read `docs/streams/client/M2-14-HANDOFF.md` completely, current coordination README
and supervisor209. Claim only this task through native MCP with your own unique
workerId; if unavailable/already claimed/scope changed, stop without edits.

## Exact allowedPaths

- server/src/routes/student-import-resolution.ts
- server/src/routes/tenant-self.ts
- server/tests/helpers/m2-student-import-resolution-harness.ts
- server/tests/m2-student-import-resolution.test.ts
- server/tests/m2-student-import-resolution-failures.test.ts
- src/features/students/StudentImportPreview.tsx
- src/features/students/server-resolution.ts
- src/lib/api-http.ts
- src/tests/m2-student-import-server-resolution.test.ts
- docs/streams/server/M2-B08-CONTRACT.md
- docs/streams/client/M2-14-CONTRACTS.md

Implement the full handoff. Preserve M2-08/M2-11 and all dirty owners. OpenCode
owns academic-period correction paths; never edit them. No student/user/enrollment/
import writes, OTP/password, audit write, migration, financial or assignment policy.
Use safe isolated real tests/types. Stop edits/checks before MCP report and concise
worker Markdown; no self-acceptance or next task.
