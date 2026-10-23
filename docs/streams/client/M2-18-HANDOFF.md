# M2-18 handoff: private student branch assignment metadata

Task: `client-m2-18-private-student-branch-assignment-20261022-01`

## Goal and before/after

Before: accepted tenant branches can be managed, and existing students can be
managed, but a tenant owner cannot attach an existing student row to one of the
tenant's active branches. C1 therefore has branch catalogs without usable
student assignment.

After: the verified active tenant owner can assign one existing tenant student
row to one active branch of the same tenant, or explicitly clear the assignment.
The instructor student screen loads the bounded branch catalog and exposes that
metadata operation. Assignment is planning/organization metadata only: it never
changes login, enrollment, group/course membership, access, pricing or billing.

## Exact allowed paths

1. `server/migrations/20261022_01_student_branch_assignment.sql`
2. `server/src/routes/students.ts`
3. `server/tests/m2-student-branch-assignment.test.ts`
4. `server/tests/m2-student-branch-assignment-failures.test.ts`
5. `src/lib/api-http.ts`
6. `src/features/enrollment/instructor-students.ts`
7. `src/pages/InstructorStudents.tsx`
8. `src/tests/m2-instructor-students.test.ts`
9. `docs/streams/server/M2-B10-CONTRACT.md`
10. `docs/streams/client/M2-18-CONTRACTS.md`

These paths are disjoint from the active OpenCode M2-17 correction.

## Required behavior

- Add an additive migration **file only** for nullable `students.branch_id`, its
  tenant-safe lookup index/foreign key shape and no data backfill. Never apply it.
- Add an owner-only private student branch update route beside existing student
  management. Revalidate the authenticated owner, active tenant, target student
  tenant and active target branch tenant on one connection inside one transaction.
- Accept exactly `{ branch_id: uuid | null }`. `null` clears. Reject malformed,
  foreign, archived or missing branches and foreign/missing students without
  disclosing cross-tenant existence. Return a bounded canonical student branch
  projection from the transaction and write one sanitized audit event atomically.
- Do not create/delete a student, user, invitation, enrollment, group/course
  assignment, academic-period binding, payment or access rule. Branch metadata
  must have no authorization effect.
- Extend the existing client adapter and instructor-student controller/page with
  a bounded active-branch selector and explicit save/clear action. Server data is
  authoritative; never infer permission from local role/profile/status.
- Preserve principal/session/selection fencing, duplicate-submit blocking,
  target identity checks, denied/not-found cleanup, retryable failure retention,
  stale response retirement, close/reset/dispose cleanup and existing workflows.
- No live DB/network/browser/provider/service, dependency install, Git/deploy,
  migration application, OTP, billing or M3 work.

## Tests and completion

- Hermetic server production-path tests cover assign, clear, canonical response,
  transaction/audit order, tenant isolation, archived/foreign/missing targets,
  malformed payloads and rollback/release failure paths with zero partial writes.
- Client production-path tests cover branch load/render, assign/clear, exact DTO,
  duplicate save, stale principal/session/row/list replies, denied/malformed
  responses, retry and cleanup without weakening existing student management.
- Run both new server suites, unchanged nearby branch/student suites, the updated
  client suite and scoped server/frontend types. Report exact results and known
  unrelated diagnostics honestly.
- Stop all edits/checks before the MCP report. Worker report is not acceptance.
