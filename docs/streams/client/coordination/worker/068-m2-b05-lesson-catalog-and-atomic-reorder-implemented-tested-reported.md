# M2-B05 private lesson catalog + atomic reorder — implemented, tested, reported

Task `client-m2-b05-lesson-catalog-20261021-01` (backend, WorkBuddy native lane
under [180](../supervisor/180-human-dual-workers-larger-batches-15min.md),
scope in [M2-B05-HANDOFF](../../../server/M2-B05-HANDOFF.md)).
Worker `workbuddy-native-m2-b05-lesson-catalog-20261021`; native session/run id
not exposed to this worker, so none is claimed. Reported through MCP;
**not acceptance**.

## Before / after

- Before: accepted M2-B04 private course units existed, with no lesson-child
  metadata surface.
- After: a verified owner can list/create/edit/archive/reactivate private lesson
  metadata under a unit of an active owned course, and atomically reorder up to
  100 selected lessons of one unit with full prevalidation, one bounded audit
  event per changed row and rollback on every failure. No delivery/content/
  asset, move, assignment, progression or financial semantics.

## Changed paths (exactly seven)

- `server/src/routes/course-lessons.ts` (new) — injected router: GET list,
  POST create, PATCH `/:lessonId`, POST `/reorder`. Type-only `AuthRequest`
  import, no default export, single injected connection supplier.
- `server/src/routes/tenant-self.ts` — **additive only**: one import plus one
  `router.use('/catalog', createCourseLessonsRouter({ getConnection }))` after
  the accepted unit mount. The diff contains no other line.
- `server/migrations/20261021_01_course_lessons.sql` (new) — additive table
  FILE, **never applied**; FK to `course_units`, no `course_id`/`tenant_id`
  duplication, `(unit_id,display_order,id)` index.
- `server/tests/helpers/m2-course-lessons-harness.ts` (new) — synthetic
  fixtures, positive import interception, transaction-replaying connection.
- `server/tests/m2-course-lessons.test.ts` (new).
- `server/tests/m2-course-lessons-reorder.test.ts` (new).
- `docs/streams/server/M2-B05-CONTRACT.md` (new) — actual contract/checks/limits.

No `src/**`, api-http, unit router, accepted test, package, config, index,
auth/middleware or other schema file was touched; OpenCode's M2-09 frontend
paths are untouched.

## Commands and outcomes (from `server/`, repository-local binaries, no fetch)

- `./node_modules/.bin/tsx --test tests/m2-course-lessons.test.ts` — 48 tests,
  48 passing, 0 failing.
- `./node_modules/.bin/tsx --test tests/m2-course-lessons-reorder.test.ts` —
  26 tests, 26 passing, 0 failing.
- both new suites together — 74 tests, 74 passing, 0 failing.
- `./node_modules/.bin/tsx --test tests/m2-tenant-profile.test.ts
  tests/m2-tenant-profile-update.test.ts tests/m2-tenant-branches.test.ts
  tests/m2-course-units.test.ts` — 164 tests, 164 passing, 0 failing (accepted
  suites unchanged, still green with the new mount in place).
- `./node_modules/.bin/tsc --noEmit -p tsconfig.json` — exit 0, 0 diagnostics.

## Real findings worth review

- The reorder proof order is: owner → course → unit (`FOR UPDATE`) → ONE
  `id IN (…) ORDER BY id ASC FOR UPDATE` lock → count check against the batch
  size. A mixed batch therefore writes and audits **nothing** and answers the
  same 404 as an absent id; the fixture confirms the valid rows are restored.
- Locking the ids in ascending id order is a deliberate deadlock-avoidance
  choice, not a payload-order echo; the response is ordered by the **resulting**
  `(display_order, id)`.
- A pure no-op batch commits nothing (rolls back after the read-back) while
  still returning the truthful current DTOs; a mixed batch commits once and
  audits only the changed rows.
- Timestamps use the corrected M2-B04 epoch projection
  (`UNIX_TIMESTAMP(col)`), so the serialized instant is the stored instant and
  not the driver's `+02:00` interpretation; an unreadable epoch fails the
  request instead of fabricating a date.

## Limits (no overclaim)

No live MySQL, no real row locking/concurrency, no real keyset index usage, no
real FK/ENUM/CHECK enforcement, no HTTP transport, no migration execution, no
provider/Docker/install. The fixture replays the transaction (snapshot on
`beginTransaction`, restore on `rollback`), so atomicity evidence is the
decision boundary plus restored state, not a physical InnoDB rollback. No
performance, latency or scalability measurement was taken. The legacy
`auth-boundary` / `m1-expanded-tenant-admin` suites were not re-run (outside the
named scope). No self-acceptance.

## Next owner action

Codex: independent source/architecture/contracts/tests review of the seven
paths. Any necessary correction belongs to a same-scope scoped task; this
worker is stopped and holds no further edits.
