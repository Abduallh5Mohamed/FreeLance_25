# M2 native core progress — 2026-10-18

Human requested native GPT-6-Luna Low delegation and supervised continuation.
Three workers used disjoint module/test ownership; root integrated and reran
the whole suite after all worker activity stopped. Existing dirty work was
preserved. This is **partial delivery, not whole-M2 or whole-M1 acceptance**.

## Work completed this pass

| Area | Verified changes | Limits |
|---|---|---|
| C1/C4 public identity | Teacher-course projection requires an active course tenant; generic500 on each failed DB lookup; safe projection tests | C1 private metadata/lifecycle breadth not completed by this module |
| C5 lectures | Create/update/reorder/archive mutate and write audit inside one transaction; reorder locks course and active lecture set, validates all IDs and branch access; archived edit/republish denied | Whole unit/file catalog not accepted; no live DB concurrency run |
| C8 enrollment | UTC inclusive-start/exclusive-end selection, status validation, no zero-length window, real calendar validation; effective mutation/audit transaction | New lifecycle schema is an unexecuted draft |
| C10 selected session | Common SQL principal enrollment lookup rechecks status/start/end on each request; stale selected JWT denied when enrollment stops resolving | SQL behavior has hermetic source/handler coverage only, not new live proof |

Contract: `docs/contracts/M2-IDENTITY-CATALOG-ENROLLMENT.md`.
No pricing/payment policy or provider behavior was changed. Existing enrollment
approval, tenant/branch policies and deferred OTP503 remain required.

## Tests and regression handling

- Full guarded hermetic tests: **1223/1223** from repo root and server cwd.
- Source `tsc --noEmit -p server/tsconfig.json`: exit0.
- `git diff --check`: exit0 (existing line-ending notices only).
- Tracked text secret scan:944 files,0 findings,3 existing allowlisted fixtures.
- Public identity focused13pass; lecture focused25pass; enrollment focused18pass;
  root added common-auth revocation/calendar tests.
- Earlier full run exposed15 failures. Lecture tests needed explicit transaction
  injection and complete active-row fixtures; deny expectations were preserved.
  Course fixtures had incorrectly returned a foreign row despite the real SQL
  ownership predicate, and counted the required audit INSERT as a second domain
  mutation. Those fixtures now enforce the scoped predicate and assert separate
  domain mutation/audit contents. No authorization assertion was loosened.
- M1 bootstrap inventory test now recognizes the SHA256 of the **new unexecuted
  M2 migration draft**. This was a supervisor-coordinated manifest-only scope
  adjustment; no old migration changed and no SQL ran. The manifest explicitly
  records the absence of fresh MySQL validation for this draft.

Private logs: `WorkBuddySupervisorBridge/handoff/m2-native-root.log` and
`m2-native-server.log`. Native reservation belongs to root; child agents never
received claim tokens or claimed the WorkBuddy task.

## Remaining work / honest closure matrix

- **C4 publication is unresolved.** Courses only have `is_active`, which existing
  source uses for active/archive and defaults true at creation. It cannot prove
  publishing intent or draft isolation. Do not expose the new public catalog
  as a completed publication feature until an explicit publication contract and
  schema are implemented and verified; existing activity filters are not proof.
- The draft `20261018_01_m2_identity_catalog_enrollment.sql` must pass separately
  approved isolated migration/bootstrap/idempotency/live tests before deployment.
  Auth now depends on its lifecycle columns and intentionally does not silently
  fall back to expired/revoked access if schema lookup fails.
- Audit/branch race behavior and old term/date data need actual DB verification.
  Partial window changes also need a complete effective-window validation policy
  (input-only ordering is not a claim about every possible existing-row merge).
- C1 metadata mutation breadth, C5 non-lecture units/files and remaining full
  enrollment lifecycle contracts are not declared complete by this pass.
- SMS delivery remains human-deferred; no external messages/costs/accounts.
- No frontend, provider, production, DB/service/Docker, Git commit/push/merge
  or deployment action performed. No new migration was executed.
