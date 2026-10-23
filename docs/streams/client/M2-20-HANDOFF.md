# M2-20 handoff: private instructor branch-assignment metadata

Task: `client-m2-20-private-instructor-branch-assignment-20261023-01`

## Goal and before/after

Before: accepted branch management can assign students, but the verified tenant
owner cannot record which active branch an existing instructor membership is
organized under.

After: the verified active tenant owner can list bounded active instructor
memberships and assign one to one active branch of the same tenant, or clear the
assignment. The existing branch manager exposes this organization metadata.
Assignment has no authorization, teaching, course, enrollment, access, pricing
or billing effect.

## Exact allowed paths

1. `server/migrations/20261023_01_instructor_branch_assignment.sql`
2. `server/src/routes/tenant-self.ts`
3. `server/tests/m2-instructor-branch-assignment.test.ts`
4. `server/tests/m2-instructor-branch-assignment-failures.test.ts`
5. `src/lib/api-http.ts`
6. `src/features/tenant/branches.ts`
7. `src/features/tenant/BranchManager.tsx`
8. `src/tests/m2-tenant-branches-ui.test.ts`
9. `docs/streams/server/M2-B12-CONTRACT.md`
10. `docs/streams/client/M2-20-CONTRACTS.md`

## Required behavior

- Add a migration **file only** for nullable branch metadata on an existing
  instructor tenant membership, tenant-safe lookup index/FK shape and no
  backfill. Never apply it.
- Add owner-only bounded instructor-membership list and single assign/clear
  operation under the existing tenant-self router. Resolve tenant and owner
  only from authenticated server state and revalidate owner, active tenant,
  active instructor membership and active same-tenant branch on one connection
  inside one transaction.
- Accept exactly a canonical membership selector plus `branch_id: uuid|null`.
  Foreign/absent membership and foreign/archived/absent branch disclose no
  cross-tenant existence. Return only membership id, instructor id, bounded
  display name, branch id/name; write one sanitized audit atomically. Truthful
  no-op writes/audits nothing; uncertain commit destroys the connection.
- Extend the existing adapter/branch controller/card with a bounded instructor
  list and explicit save/clear. Server response is authoritative. Preserve
  principal/session/list/form/target/dispose fences and duplicate blocking.
- No role changes, permission matrix, teaching-access change, course/group/
  student assignment, login/invitation, payment, migration application,
  network/browser/provider/service/install/Git/deploy/OTP/M3.

## Impact, tests and done

- Hermetic server tests cover bounded list, assign/clear/no-op, tenant isolation,
  inactive/foreign targets, atomic audit and all cleanup/uncertain-commit paths.
- Client production tests cover exact DTOs, list/assign/clear, malformed bodies,
  duplicate saves, stale principal/list/target replies and cleanup.
- Run both new server suites, unchanged branch/student-branch suites, updated
  client branch suite and scoped types. Stop before MCP report; report is not
  self-acceptance.

