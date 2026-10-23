# WorkBuddy task client-m2-21-private-group-announcements-20261023-01

Read coordination/README.md and the latest applicable supervisor instructions.
Claim ONLY this exact approved task through native MCP with your own worker ID.
If unavailable, already claimed, scope changed or this inbox pointer is not ready,
exit without edits. This document is NOT a claim or permission expansion.

Workspace: D:/FreeLance_25-1/FreeLance_25-1
Scope hash: 68d5395b9d414be885c686a5a3cafd51337b159f85915ac89cd411287997c57c

## Exact allowedPaths

- server/migrations/20261023_02_group_announcements.sql
- server/src/routes/groups.ts
- server/tests/m2-group-announcements.test.ts
- server/tests/m2-group-announcements-failures.test.ts
- src/lib/api-http.ts
- src/features/groups/group-announcements.ts
- src/pages/Groups.tsx
- src/tests/m2-group-announcements.test.ts
- docs/streams/server/M2-B13-CONTRACT.md
- docs/streams/client/M2-21-CONTRACTS.md

## Instructions

WorkBuddy NEW lane. Read M2-21-HANDOFF and current coordination. Implement the complete private group-announcement lifecycle across exactly ten paths. Migration FILE only, never apply. Authenticated instructor plus selected active tenant plus owned same-tenant group; bounded cursor list and strict create/update/publish/retract with fixed DTO, atomic sanitized audit, truthful no-op and safe uncertain-commit cleanup. Extend real api-http/controller/Groups page/tests with principal/session/list/form/target/dispose fences and retained input on failure. Private management surface only: no student consumption, scheduled delivery/timezone policy, email/SMS/push, access/enrollment/role/payment effect. Preserve dirty accepted work. No live DB/network/browser/provider/service/install/Git/deploy/OTP/M3. Claim exactly this task, stop all activity before MCP report, no self-acceptance or next task.

## Completion criteria

- Instructor can manage bounded announcements only for owned same-tenant groups; strict canonical DTO and tenant-safe pagination.
- Create/update/publish/retract mutations revalidate authority transactionally and write exactly one sanitized audit; truthful no-op writes nothing.
- Exactly ten paths; migration file never applied; new and unchanged group suites plus scoped types reported after all work stops.

Stop edits and all checks before native MCP report and unique concise worker reply.
No self-acceptance, new task, worker timer, secret access or ownership transfer.
