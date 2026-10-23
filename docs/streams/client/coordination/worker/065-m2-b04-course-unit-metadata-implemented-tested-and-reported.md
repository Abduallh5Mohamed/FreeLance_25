# M2-B04 course-unit metadata implemented, tested and reported

**Task:** `client-m2-b04-course-unit-metadata-20261019-01` (backend, write) —
claimed by worker `opencode-worker-b04-20261019` on 2026-10-19, implemented
against the five approved paths of `docs/streams/server/M2-B04-HANDOFF.md`.
**Contract:** `docs/streams/server/M2-B04-CONTRACT.md`.
**Branch:** `codex/human-client` — all pre-existing dirty work (M2-B01/B02/B03
and the client batches) was preserved; no file outside the approved scope was
edited.

## Changed paths (exactly the five approved ones)

- `server/src/routes/course-units.ts` — **new**. An injected unit router with
  the whole contract: strict validation, verified-owner authority, bounded
  keyset list, audited writes, explicit connection lifecycle. It imports
  `AuthRequest` as a **type only**, has **no default export** and binds **no**
  database/provider/renewal/dotenv adapter; its only dependency is an injected
  transactional connection supplier.
- `server/src/routes/tenant-self.ts` — **additive only**: one import
  (`createCourseUnitsRouter`) and one `router.use('/catalog', …)` placed
  immediately after the existing `router.use(deps.authenticate)`. Every
  accepted handler (profile read/write, branches, subscription, billing,
  top-ups, renewal intents) is byte-untouched.
- `server/migrations/20261019_02_course_units.sql` — **new** additive table
  FILE. **It was NOT applied**: no database was connected and no statement was
  executed. One new table `course_units`; no `ALTER`/`DROP`/`TRUNCATE`/
  `DELETE`/`INSERT`/`UPDATE`; no change to `courses`; the tenant is **derived**
  through `courses.tenant_id`, so no `tenant_id` column is duplicated.
- `server/tests/m2-course-units.test.ts` — **new** hermetic suite (61 tests).
- `docs/streams/server/M2-B04-CONTRACT.md` — **new** API/schema/check/limits
  contract.

## Before / after

- **Before:** courses and materials existed; there was no unit hierarchy
  contract in the inspected course routes.
- **After:** the **verified owner** of the server-selected institution can
  list, create, rename, reorder, archive and reactivate **private** unit
  metadata under an **active course of that tenant**. No student/public
  consumption, no lesson/material move, no upload/provider, no drip, no
  progress, no enrollment and no checkout effect. An archived unit is metadata
  only: it does not alter the access of any existing course or material.

## Authority and shape actually implemented

- Owner authority is the **real** `tenants.owner_user_id` of the
  server-selected tenant, with an active tenant and a live caller, re-checked
  on the same transaction connection. A membership label
  (`owner`/`instructor`), a global teacher/admin role and a student never
  grant unit visibility or writes. The owner is determined **before** the
  course is looked up.
- The course must exist, be `is_active = 1` and belong to the selected
  tenant; a null, foreign, inactive and absent course give the **identical**
  404. The write paths lock the owner rows **and** the course row `FOR UPDATE`.
- Every unit lookup and write qualifies **both** the unit id and the course of
  the path; a foreign and an absent unit give the identical 404.
- Billing-only principals are refused **locally and before any connection**,
  because `middleware/auth.ts` exempts the whole `/api/tenants/me` prefix.
- Fixed DTO `{id,course_id,name,display_order,status,created_at,updated_at}` —
  never a row spread, no tenant/owner/contact/billing field. Timestamps are
  rendered as the exact UTC instant (`toISOString()`).
- Strict input: UUID ids, `name` trimmed to 1..255, `display_order` an
  integer `0..2147483647` that is **never coerced**, `status` exactly
  `active`/`archived`, unknown keys (tenant/course/owner/publication/paid
  fields) rejected, empty PATCH rejected.
- Bounded keyset list ordered by `(display_order, id)` with the id as the
  stable tie-breaker: default 25 / max 100, a `limit+1` read, no totals, no
  drain, no offset, and an opaque **canonical** cursor carrying only
  `display_order`/`id` (≤256 chars, re-encoded and compared).
- Atomic audited writes: the write and its `audit_events` row share one
  transaction; the audit references the actor, the derived tenant, the unit
  and the course, with a fixed bounded payload. Success is reported only
  after `commit()` resolves. A lost commit acknowledgement is an **uncertain**
  state: no rollback is claimed, no retry happens and the connection is
  destroyed. A failed `beginTransaction` is discarded; a failed rollback is
  destroyed, never released.

## Commands and outcomes (actually executed)

All from `server/` unless stated otherwise.

| Command | Result |
|---|---|
| `npx tsx --test tests/m2-course-units.test.ts` | **61 tests, 61 pass, 0 fail** |
| `npx tsx --test tests/m2-tenant-profile.test.ts tests/m2-tenant-profile-update.test.ts tests/m2-tenant-branches.test.ts tests/m2-course-units.test.ts` | **156 tests, 156 pass, 0 fail** (the 95 accepted M2-B01/B02/B03 tests unchanged + the 61 new) |
| `npx tsc --noEmit -p server/tsconfig.json` (from the repo root) | **0 diagnostics, exit 0** |

No pre-existing or outside failure was observed in these runs. The legacy
`auth-boundary` and `m1-expanded-tenant-admin` suites were deliberately **not**
re-run: they are outside the handoff's named scope.

## Test isolation and what the tests really prove

- The `src/db`, `src/services/minio`, `src/services/subscription-renewal` and
  `dotenv` module bodies are intercepted in the CommonJS loader **before any
  app module loads**, never enter `require.cache`, need no dummy env, and a
  sentinel counter is re-asserted empty in `after`.
- The new unit module is loaded **alone and first**; the interception log is
  asserted **empty**, which positively proves the new module pulls in no
  database, provider, renewal or environment module by itself.
- The suite drives the real production composition — `createOptionalAuth` →
  `enforceTenantAuthorityBoundary` → `enforceStudentWorkspaceBoundary` →
  `createTenantSelfRouter` → the mounted `/catalog` unit router — with only
  leaf repositories and the transactional connection injected. No listener, no
  socket, no `fetch`, no app startup, no database, no provider.
- The fake DB asserts the **actual SQL text and bound parameters** (owner
  select read/`FOR UPDATE`, course select read/`FOR UPDATE`, the keyset list
  statement with `[courseId, order, order, id, limit+1]`, the course-qualified
  unit select with `[unitId, courseId]`, the insert, the update and the audit
  parameters) and the **exact transaction call order**
  (`begin → owner → course → insert → audit → select → commit → release` and
  the write equivalents).
- Coverage includes: owner list/read/rename/reorder/archive/reactivate/no-op;
  body/id/cursor/limit bounds; foreign, null, inactive and absent course and
  unit isolation; owner vs membership-label vs other-tenant owner vs student
  vs admin vs unauthenticated vs missing/ambiguous selection vs billing-only;
  inactive tenant; revoked user (upstream 401); selected-scope switch; the
  route mount; the fixed DTO and `no-store`; keyset ties and page/row bounds;
  atomic audit and row locks; and every connection failure mode, including
  the uncertain commit on both write paths.
- The migration FILE is inspected **read-only** (table shape, foreign key,
  index, enum, nonnegative check, no `tenant_id` column, no destructive
  statement).

## Limits and blockers (no self-acceptance)

- No real MySQL, no real HTTP, no provider, no Docker, **no migration
  execution**: real row locking, real concurrency, real keyset index usage
  and the real `ENUM`/FK/`CHECK` constraints are **not** exercised. The
  injected fixture cannot replay a physical rollback, so the atomicity
  assertions prove the **decision boundary** (the call sequence) and not the
  physical effect.
- The migration file was **not applied**; the schema shape and deployment
  compatibility must be reviewed before any application. The FK to
  `courses(id)` has no `ON DELETE` clause: deleting a course that still owns
  units is refused by the database rather than cascading — the product
  decision is out of this slice.
- No performance or throughput claim is made and **no measurement was taken**.
  The only bounds claimed are the ones visible in the source: one page read of
  `limit+1 ≤ 101` rows, one unit row per write, one connection acquisition and
  exactly one release-or-destroy per request.
- The billing-only denial and the tenant-selector refusal are proven at the
  handler/boundary with the real authentication middleware and an injected
  principal repository; the shared middleware is not modified.
- A failed rollback on the **read** path still returns the truthful page and
  discards the connection (the accepted M2-B03 behaviour); on a **write** path
  the write outcome is unchanged and the connection is discarded.
- No blocker. No scope expansion, no schedule change, no migration
  application, no Git write, no self-acceptance.

## Next owner action

Codex independent source/architecture/contract/type/test review of the five
paths, then acceptance or a same-scope correction claim. The worker timer
`Tabweb-OpenCode-Worker-15min` is **DISABLED** (state `Disabled`,
`Enabled=False`); the enabled 10-minute reviewer is
`Tabweb-Codex-Supervisor-10min`.
