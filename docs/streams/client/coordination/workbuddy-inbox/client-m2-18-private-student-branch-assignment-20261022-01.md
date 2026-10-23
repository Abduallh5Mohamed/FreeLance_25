# WorkBuddy task client-m2-18-private-student-branch-assignment-20261022-01

Read coordination/README.md and the latest applicable supervisor instructions.
Claim ONLY this exact approved task through native MCP with your own worker ID.
If unavailable, already claimed, scope changed or this inbox pointer is not ready,
exit without edits. This document is NOT a claim or permission expansion.

Workspace: D:/FreeLance_25-1/FreeLance_25-1
Scope hash: f060482e2fe5859dd49bdf23a4e1bacd7f7c37417bb996c0d3f15567559542f4

## Exact allowedPaths

- server/migrations/20261022_01_student_branch_assignment.sql
- server/src/routes/students.ts
- server/tests/m2-student-branch-assignment.test.ts
- server/tests/m2-student-branch-assignment-failures.test.ts
- src/lib/api-http.ts
- src/features/enrollment/instructor-students.ts
- src/pages/InstructorStudents.tsx
- src/tests/m2-instructor-students.test.ts
- docs/streams/server/M2-B10-CONTRACT.md
- docs/streams/client/M2-18-CONTRACTS.md

## Instructions

WorkBuddy NEW lane. Read docs/streams/client/M2-18-HANDOFF.md fully, the current inbox pointer and coordination README. Implement the complete private student branch-assignment metadata batch across exactly ten allowed paths. Add the migration FILE only and never apply it; owner-only transactional server assign/clear with active same-tenant branch and same-tenant student revalidation plus atomic sanitized audit; canonical bounded response; client adapter/controller/page selector and explicit save/clear with strict principal/session/target/list lifecycle fencing. This is organization metadata only: no login/account/invitation/enrollment/group/course/period/access/payment effect. Preserve all existing student and branch behavior. Add real hermetic server/client tests and contracts. No live DB/network/browser/provider/service/install/Git/deploy/OTP/M3. Claim exactly this task with one unique native workerId, stop edits/tests before MCP report, no self-acceptance or next task.

## Completion criteria

- Verified owner can transactionally assign or clear an existing same-tenant student branch using only an active same-tenant branch, with one atomic sanitized audit and no access effect.
- The private instructor UI uses canonical server rows and preserves all stale principal/session/selection/target and retry cleanup guarantees.
- Exact ten paths only; new and nearby safe suites plus scoped server/frontend types are reported after all work stops.

Stop edits and all checks before native MCP report and unique concise worker reply.
No self-acceptance, new task, worker timer, secret access or ownership transfer.
