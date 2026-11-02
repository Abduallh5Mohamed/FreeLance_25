# Feature and readiness matrix

Checkpoint: **2026-10-26**, `main` at `681432c` plus the existing dirty M2-23
implementation. Source/build/test audit: [AUDIT-2026-10-26.md](AUDIT-2026-10-26.md).
Re-check target source and tests before changing a status. This is not a live
database/provider acceptance.

Status meanings:

- **Mounted**: reachable from the current composition root.
- **Partial**: useful code exists but an end-to-end contract is incomplete.
- **Factory only**: implementation exists but production never constructs it.
- **External/config blocked**: requires real schema, secret or provider evidence;
  do not fabricate it.

| Area | Current state | Primary entry points | Important gap |
|---|---|---|---|
| Authentication and scoped principals | Mounted | `routes/auth.ts`, `middleware/auth.ts`, `security/identity-scope.ts` | OTP is deliberately outside the current completion target |
| Tenant/workspace/branch boundaries | Mounted, actively enforced | `middleware/tenant-authority-boundary.ts`, `student-workspace-boundary.ts`, `security/branch-access.ts` | Every new route still needs resource-level tenant checks |
| Catalog units/lessons and publication | Mounted; public composition corrected locally (audit A fixed) | `routes/courses.ts`, `course-units.ts`, `course-lessons.ts`, `public-identity.ts`, `public-catalog.ts` | One public `/courses` endpoint now serves the M2-22 contract and every public projection pins explicit publication + active tenant; the publication migration is still a file only, so publication reads fail closed until it is applied (external prerequisite) |
| M2-23 student learning path | Mounted in existing dirty tree; scoped tests pass, acceptance incomplete | `routes/student-course-access.ts`, `routes/course-lessons.ts`, `src/features/catalog/student-learning-path.ts`, `src/pages/StudentContent.tsx` | Prerequisite order can be invalidated by position-only PATCH/reorder; SQL session timezone needs proof; metadata has no file/video delivery integration. See audit E/F |
| Student import | Mounted in bounded phases | `routes/student-import.ts`, `src/features/imports/` | Migrations remain environment-dependent; no implicit account/enrollment creation beyond explicit contracts |
| Groups, schedules, announcements | Mounted | `routes/groups.ts`, `schedules.ts`, `announcements.ts` | Some broad post-merge harness suites are stale/failing; validate before claiming full regression green |
| Assignments | Mounted with private MinIO object store | `routes/assignments.ts`, assignment recovery services | No trusted malware scanner; durable cleanup/scan recovery and exact-version proof remain unconfigured, so clean verdict is unreachable |
| In-app notifications/preferences | Mounted | `routes/notifications.ts`, `services/notification-preferences.ts` | External dispatch is separate |
| Notification dispatch runtime | Factory only | `services/notification-runtime-factory.ts`, delivery/outbox services | Needs purpose-scoped contacts, tenant binding, secrets, applied schema report and real ready adapters; not constructed by `index.ts` |
| Legacy meetings | Mounted | `routes/meetings.ts` | Not equivalent to the hardened live runtime |
| Hardened live sessions/recordings | Factory only | `services/live-runtime-factory.ts`, `routes/live-sessions.ts`, `services/live-recording-ingest.ts` | Not mounted; requires schema/operational evidence, sealed audit, provider verification/mapping and optional real storage metering/recovery lifecycle |
| Legacy fees/payments/expenses/wallet UI | Mounted | `routes/fees.ts`, `payment-requests.ts`, `expenses.ts`, `instructor-wallet.ts` | Does not prove hardened end-to-end settlement/provider flow |
| Hardened financial source composition | Factory only | `services/financial-source-composition.ts`, billing SQL/services | Not composed in production; requires connection-bound sealed audits, verified schema and explicit payment/payout provider orchestration |
| Tenant export | Mounted fail-closed | `routes/tenant-export.ts`, startup option in `index.ts` | Ownership remains unavailable unless explicit catalog verification succeeds; migration files alone are insufficient |
| Video/media | Mounted, large legacy surface | `routes/videos.ts`, `secure-video.ts`, `video-assets.ts`, MinIO/FFmpeg services | Requires configured MinIO/FFmpeg and careful access-policy regression testing |
| Exams, results and grading | Mounted | `routes/exams.ts`, `exam-versions.ts`, `manual-grading.ts`, reporting routes | Real schema may differ from migration inventory; expiry/grading jobs require bounded lifecycle checks |
| Reporting/admin/platform controls | Mounted in multiple bounded surfaces | admin/report routes in `index.ts` | UI presence is not proof of cross-role end-to-end readiness |

## Known verification checkpoint

At the 2026-10-26 audit:

- conflict-marker check, frontend Vite build and backend build passed;
- frontend TypeScript failed with 11 diagnostics (including broken Fees calls);
- all `src/tests/*.test.ts` plus access test: 1390 pass / 18 fail, including
  environment and outdated-harness failures;
- seven catalog/learning-path server suites: 290 pass / 0 fail;
- guarded import/branding/reporting suites: 252 pass / 0 fail;
- guarded M2-23 client suites: 123 pass / 0 fail;
- selected legacy group/lecture/enrollment suites: 64 pass / 99 fail. A group
  harness escaped to a real SQL dependency; local authentication was rejected.
  Fix injection and block external I/O before rerunning those suites;
- synthetic probes confirmed the public route collision, shared transaction
  connection release after uncertain commit, and prerequisite order invalidation.

The following is the **historical** 2026-10-25 checkpoint, not current proof:

- frontend build and TypeScript checks passed;
- backend TypeScript build passed;
- conflict-marker check passed;
- selected new server suites passed (203 assertions/tests in the selected run);
- focused course-publication and branding suites passed;
- broad legacy M2 runs still showed failures concentrated in lecture, group
  announcement and group schedule harnesses after the merge.

Do not reuse these counts as fresh proof. Run relevant tests again after edits.

## Batch execution record (local source fixes, 2026-10-26)

Independent supervisor review: [SUPERVISOR-REVIEW-2026-10-26.md](SUPERVISOR-REVIEW-2026-10-26.md).
The **completed locally** entries below are WorkBuddy's implementation reports,
not independent acceptance. Batches 2 and 4 are accepted within their local
scope. Batch 1's later cache correction passed 43 focused tests and server
build, so it is now accepted locally too. Batch 3's later fee corrections
passed 21 focused tests, frontend typecheck and build, so the UI correction is
accepted locally; the financial backend is still not a production collection
contract. The independent unit-PATCH part of batch 5 later passed 80 unit tests,
345 scoped catalog tests and server build; lesson reorder remains unaccepted
under the old WorkBuddy-owned source path.

### Batch 1 — public discovery and draft leak (audit A)

- Decision: **completed locally**.
- Changed files:
  - `server/src/routes/public-identity.ts` — removed the legacy `GET /courses`
    discovery handler (array body, `is_active`-only filter) so exactly one
    public endpoint exists; teacher page now pins
    `c.publication_state='published'` beside the existing `is_active` and
    active-tenant gates.
  - `server/src/index.ts` — `publicCatalogRoutes` is now mounted BEFORE
    `publicIdentityRoutes` on `/api/public` (defense in depth; order pinned by
    a test).
  - `server/tests/m2-c1-c4-public-identity.test.ts` — dropped tests of the
    removed route; added publication-gate SQL and row-level draft-hiding tests
    and a structural single-route assertion.
  - `server/tests/m2-public-catalog-composition.test.ts` (new) — composes both
    REAL routers under a real express Router in the actual index mount order;
    proves the list can only be answered by the M2-22 handler, a draft is
    invisible through the composed mount, the teacher page stays
    publication-gated, and `src/db` never evaluates.
- Verified behavior: `GET /api/public/courses` answers only
  `{ courses, next_cursor }` with `publication_state='published'`,
  `is_active` and active-tenant pinned; drafts/archived/suspended invisible;
  `/teachers/:id` hides drafts; legacy statement never executes.
- Exact commands and results (repo root, Node v22.22.2):
  - `npx tsx --test server/tests/m2-public-course-discovery.test.ts server/tests/m2-c1-c4-public-identity.test.ts server/tests/m2-public-catalog-composition.test.ts` → 40 pass / 0 fail.
  - `npx tsx --test server/tests/m2-course-publication.test.ts` → 30 pass / 0 fail.
  - `npm --prefix server run build` → success; `npx tsc --noEmit` (server) → success.
  - Mutation checks: removing the publication gate fails 3 tests; swapping the
    mount order fails the mount-order test. Both were reverted after the check.
- Limitations: the M2-22 publication migration remains a FILE ONLY; until it
  is applied, publication reads fail closed (500) by contract. No database,
  network, listener, provider, deployment or Git action was used.

### Batch 2 — transaction cleanup after an ambiguous COMMIT (audit B)

- Decision: **completed locally**.
- Changed files:
  - `server/src/db.ts` — `withTransaction` now records that a COMMIT was
    attempted; when COMMIT rejects, the connection is DESTROYED (never
    released), even if the subsequent rollback succeeds. No success report, no
    automatic retry; the original error is always rethrown.
  - `server/tests/db-transaction-lifecycle.test.ts` (new) — drives the REAL
    `db.ts` with an injected synthetic pool/connection; `dotenv` and
    `mysql2/promise` are intercepted, so no database or env file is touched.
- Verified behavior: begin/work/commit/rollback/release/destroy sequences for
  success, work failure, commit failure (± rollback failure), begin failure,
  failed release on the success path; exactly-once cleanup on every path;
  original error identity preserved everywhere; commit attempted at most once.
- Exact commands and results (repo root, Node v22.22.2):
  - `npx tsx --test server/tests/db-transaction-lifecycle.test.ts` → 8 pass / 0 fail.
  - Mutation check: restoring the old release-after-commit-failure behavior
    fails the regression test; the fix was restored afterwards.
  - `.codex-audit/transaction-probe.cjs` (review probe) now FAILS on purpose:
    it asserts the old `release` sequence, and the observed sequence ends in
    `destroy` — the probe detected the correction.
  - Seven catalog suites → 290 pass / 0 fail (baseline preserved).
  - `npm --prefix server run build` → success; `npx tsc --noEmit` (server) → success.
- Limitations: synthetic connection only; no live MySQL commit-loss scenario
  was reproduced, and no other transaction helper was changed. Callers that
  relied on the old (unsafe) pooling of an ambiguous connection now receive
  the original error and must treat the write as uncertain — by design.

### Batch 3 — frontend TypeScript errors and the Fees payment journey (audit C/G)

- Decision: **completed locally**.
- Changed files:
  - `src/pages/Fees.tsx` — the payment form now calls the canonical
    `updateFee` transport (imported) and the existing `loadFeesFromDB`
    refresh (the previous `updateFee`/`fetchFees` calls were undefined, so the
    write failed before the database and a half-fix would report failure after
    a successful save). Added a synchronous single-write latch, local invalid-
    amount refusal, and separation of a confirmed save from a failed refresh.
  - `src/features/fees/payment-workflow.ts` (new) — the pure decision seam:
    `parsePaymentAmount`, `computePaymentWrite`, `runPaymentFlow` over
    injected transport/refresh seams. No wallet, balance or payment policy
    changed.
  - `src/lib/api-http.ts` — typed the four previously untyped exam adapters
    (`getExamAttempts`, `getNotAttemptedStudents`, `getExamResults`,
    `getStudentExamResults`) with DTOs mirroring the server projections;
    `submitInstructorTopup`'s idempotency key is now `string` (the server
    contract bounds it to 8..120 characters, not a UUID).
  - `src/pages/ExamReports.tsx`, `src/pages/ExamResults.tsx` — consume the
    transport DTOs instead of local duplicates.
  - `src/components/NotificationBell.tsx` — `renotify`/`vibrate` declared on
    the options type (missing from this toolchain's DOM lib) instead of
    suppressed.
  - `src/components/StudentHeader_OLD_BACKUP.tsx` — the two stale
    `NotificationBell userId=…` call sites fixed to the current props; the
    backup file is corrected, not excluded from type checking.
  - `src/pages/StudentBarcodes.tsx` — reads the canonical `guardian_phone`
    only (no invented `parent_phone`).
  - `src/utils/versionChecker.ts` + `src/vite-env.d.ts` — the
    `__APP_VERSION_CHECK_ENABLED__` window flag is declared.
  - `src/tests/fees-payment-workflow.test.ts` (new) — 11 isolated tests over
    the real seam and the real `updateFee` transport (stubbed
    fetch/localStorage/window; headers read through `new Headers(...)`).
- Verified behavior: `npx tsc -p tsconfig.app.json --noEmit` is CLEAN (was 11
  diagnostics); invalid amounts send no request; one write per submission; a
  failed refresh after a confirmed save reports a separate lesser outcome;
  the write is a canonical authenticated `PUT /api/fees/:id` with the computed
  body; a server rejection throws the server message with no retry.
- Exact commands and results (repo root, Node v22.22.2):
  - `npx tsc -p tsconfig.app.json --noEmit` → 0 errors.
  - `npm run build` → success (chunk-size warnings only, as before).
  - `npx tsx --test src/tests/fees-payment-workflow.test.ts src/tests/m2-public-course-discovery.test.ts src/tests/m2-course-management.test.ts src/auth/access-control.test.ts` → 132 pass / 0 fail.
- Limitations: no DOM/RTL rendering of the page itself, no live HTTP or DB,
  no payment was sent; the wallet/payment/balance rules are untouched and no
  electronic collection is enabled.

### Batch 4 — hermetic group routes, connection barrier and CI gate (audit A/D/F)

- Decision: **completed locally** for the source, the test hermeticity and the
  CI split. The full backend suite remains known-red for reasons unrelated to
  these routes, so it is published as a non-blocking job instead of being
  asserted green.
- Changed files:
  - `server/src/routes/groups.ts` — four production corrections, all contract-
    strengthening:
    1. `GET /` and `GET /:id` now set `Cache-Control: no-store` as their first
       statement (M2-B01 requires it on EVERY handler-owned outcome; the write
       handlers already did).
    2. Both read handlers refuse a user whose selected tenant resolved to no
       active membership: `404 { error: 'Tenant membership not found' }`
       (M2-B11). Previously the list silently degraded to instructor-only rows
       from another workspace.
    3. Both read handlers return the existing bounded `groupDto` projection
       instead of spreading the row, so `branch_id` / `branch_scope` /
       `instructor_id` no longer leak through the read paths.
    4. `GET /:id` validates the id against `UUID_PATTERN` before touching the
       database and answers `404 { error: 'Group not found' }`, matching the
       write handlers.
  - `server/tests/helpers/isolated-io-guard.ts` (new) — a fail-fast barrier
    imported for its side effect. It replaces `net.Socket.prototype.connect`,
    `net.createConnection`/`connect`, `net.Server.prototype.listen`,
    `tls.connect`, `http.request`/`get`, `https.request`/`get`,
    `dns.lookup`, `dns.promises.lookup` and `globalThis.fetch` with throwers
    that raise `ISOLATED_IO_BLOCKED:<capability>`. Installation is idempotent.
  - `server/tests/helpers/isolated-io-guard.test.ts` (new) — the negative
    control: five assertions prove sockets, listeners, DNS and `fetch` are
    really blocked, so the barrier is verified rather than assumed.
  - `server/tests/m2-group-announcements.test.ts`,
    `m2-group-announcements-failures.test.ts`,
    `m2-group-schedules.test.ts`, `m2-group-schedules-failures.test.ts`,
    `m2-c5-lectures-reorder-audit.test.ts`,
    `m1-security-groups-meetings.test.ts`,
    `m1-branch-legacy-scope.test.ts`, `m1-branch-resource-contract.test.ts`,
    `m2-c8-c10-enrollment-lifecycle.test.ts`,
    `m2-enrollment-session-recheck.test.ts` — the router is now built through
    `createGroupsRouter({ ... })` with EVERY dependency injected: fixture
    `db`, the auth middlewares required *inside* the module-interception
    window, `teachingAccessSentinel.requireTeachingWrite('groups')`, a fixture
    `hasVerifiedPlatformCapability`, and `branchAccess` supplied by
    `tenantScopeBranchDeps(...)`. This closes the dynamic-`import()` gap: the
    default export and `getResourceBranchDeps()` lazily `await import('../db')`
    and would otherwise reach the real pool under `tsx`. Fixture rows carry
    `branch_id` / `branch_scope`, and the SQL constants mirror the real
    `CLASSIFIED_GROUP_SCOPE` predicates.
  - `src/tests/*` (frontend, expectations only, no assertion removed or
    skipped and no session fence weakened):
    - four suites gained the three missing `api-http` stub exports
      (`AUTH_SESSION_CHANGED_EVENT`, `signOutSession`, `verifyCurrentSession`);
    - seven suites read request headers through `new Headers(init.headers)`
      / `.get()`, matching the shared `request` helper;
    - two tenant-profile suites now assert the real `ApiRequestError`
      `status` (404) and `code` (`TOKEN_EXPIRED`, `OWNER_REQUIRED`) instead of
      the previously undefined fields;
    - `m1-session-contract.test.ts` gained a URL-routed responder, so the
      space-switch test answers `POST /student-enrollment/spaces/:id/select`
      and the follow-up `GET /students/me` identity check separately.
  - `package.json` (root) — `typecheck` and `test:src` scripts.
  - `server/package.json` — `test:isolated`, the curated hermetic set.
  - `.github/workflows/ci.yml` — five jobs pinned to Node 22.22.2:
    `quality`, `frontend` (typecheck + `test:src` + build), `server-isolated`
    (install, `tsc --noEmit`, build, `test:isolated`), `server-full-suite`
    (`continue-on-error: true`, documented known-red) and the unchanged
    `m1-tenant-isolation` DB/MinIO integration job. The header comment records
    why the version is pinned and that nothing downloads a runtime.
- Verified behavior: the eight group/enrollment suites pass with NO audit
  barrier, which is the actual goal of the batch — the in-suite guard and the
  injected `branchAccess` are sufficient on their own. Read handlers are
  uncacheable, bounded, tenant-refusing and id-validating; the tenant lock is
  asserted instead of an implementation-shaped UPDATE; a foreign course
  selector is refused with the documented `400 Invalid course selector` and
  writes nothing; the archived-lecture guard is answered before the
  transaction. Frontend header, event, error and space-switch expectations
  match production behaviour.
- Exact commands and results (repo root, Node v22.22.2):
  - `npx tsc -p tsconfig.app.json --noEmit` → 0 errors.
  - `npm run test:src` → 1707 pass / 0 fail.
  - `npm run build` → success (chunk-size warnings only, as before).
  - `npx tsc --noEmit` (server) → 0 errors; `npm --prefix server run build` → success.
  - `npm --prefix server run test:isolated` → 173 pass / 0 fail.
  - The eight group/enrollment suites → 172 pass / 0 fail under the audit
    barrier, and 147 pass / 0 fail with no barrier at all.
  - `npx tsx --test server/tests/helpers/isolated-io-guard.test.ts` → 5/5.
  - `npx tsx --test server/tests/m1-branch-legacy-scope.test.ts server/tests/m1-branch-resource-contract.test.ts` → 38 pass / 0 fail.
  - `node -e "typeof require('node:module').registerHooks"` → `function` on this runtime.
- Limitations: the full `npm test` remains 3769 pass / 145 fail, and the
  failures sit in suites that do not import `routes/groups` (search, premium
  lectures, attendance, staff auth, migrations, work items). That baseline is
  pre-existing and out of this batch's scope, so the job is published
  non-blocking with a comment naming the condition to remove it. The two
  branch suites still open a loopback listener, so they stay out of
  `server-isolated` and out of `test:isolated`. No database, MinIO, provider,
  deployment, secret or Git action was used.

### Batch 5 — M2-23 prerequisite order, archival and epoch-time proof (audit E/F)

- Decision: **completed locally**. One product decision is recorded rather than
  guessed: archiving is **refused** while a dependent lesson is active, because
  the alternative (silently clearing the edge) is exactly what the audit forbids.
- Changed files:
  - `server/src/routes/course-lessons.ts` — one order, one invariant, two guards:
    1. **ONE order.** A `PathPosition` type and `comparePathPositions` implement
       `(unit.display_order, unit.id, lesson.display_order, lesson.id)`, which is
       the student path's own `ORDER BY`. `resolveUnit` now also reads
       `u.display_order`, and the prerequisite proof compares FULL path positions
       instead of only `(lesson.display_order, id)`. A cross-unit edge into a
       later unit was previously accepted and the student path read it backwards.
    2. **The prerequisite's unit must be ACTIVE.** The path reads active units
       only, so an edge to a lesson of an archived unit could never be satisfied.
    3. **The final-state invariant.** A `display_order`-only `PATCH` and a reorder
       batch both re-prove the order before writing: the moved lesson's own stored
       edge (`readPathPositions`) and every ACTIVE dependent of a moved lesson
       (`proveDependentOrder`, bounded by `PREREQUISITE_DEPENDENTS_MAX = 1000`,
       refused when the set cannot be proved). An inversion is `409 Course lesson
       prerequisite order would be invalidated` with no `UPDATE`, no audit row and
       no commit. An unchanged stored edge on an unrelated edit is not re-asserted.
    4. **The archival policy.** Archiving a lesson that an ACTIVE lesson depends on
       is `409 Course lesson is a prerequisite of an active lesson`. The edge is
       never erased automatically; the owner clears it explicitly first.
  - `server/src/routes/course-units.ts` — archiving a unit that holds such a
    lesson is `409 Course unit contains a prerequisite of an active lesson`, rolled
    back before the `UPDATE`. This is the one statement in that router that reads
    the M2-23 column.
  - `server/src/routes/student-course-access.ts` — both release decisions (the
    path read and the completion lock) compare **epochs**:
    `release_at IS NULL OR UNIX_TIMESTAMP(release_at) <= UNIX_TIMESTAMP()`.
    `release_at` is a `TIMESTAMP`; MySQL renders it in the SESSION zone before
    comparing it with a `DATETIME`, so the previous `release_at <= UTC_TIMESTAMP()`
    was only correct on a UTC session — and nothing pins one (the pool's
    `timezone:'+02:00'` is a client-side decoder option, not
    `SET SESSION time_zone`).
  - `server/tests/helpers/m2-course-lessons-harness.ts` — `UNIT_SELECT` and
    `PREREQUISITE_SELECT` gained the unit position/status; new
    `PATH_POSITION_PREFIX`, `DEPENDENT_ORDER_PREFIX`/`_SUFFIX` and
    `ARCHIVE_DEPENDENT_SELECT` constants with their fixture branches;
    `UNIT_A1_LATER`/`LESSON_LATER` constants (deliberately NOT added to
    `makeState()`, so the suites that pin exact row counts keep their baseline);
    `dependentsOverflow` and `failDependentSelect` failure seams.
  - `server/tests/m2-lesson-release.test.ts` — 14 new tests: cross-unit accept and
    refuse, archived-unit prerequisite, position-only inversion, dependent
    inversion by `PATCH` and by reorder, the ordered controls, both archival
    refusals and their no-over-refusal controls, the unprovable dependent set, and
    that the unit lookup carries the position.
  - `server/tests/m2-course-units.test.ts` — `prerequisiteEdges` fixture (both
    sides of the edge), the archive-guard branch, `failArchiveDependent`, and 4
    new tests.
  - `server/tests/m2-student-course-access.test.ts` — `sessionOffsetSeconds`, a
    `releasedDecision` emulator that applies whichever comparison the issued
    statement actually uses (and throws on a third form), plus 3 new tests: the
    before/at/after matrix under `0`, `+02:00`, `-05:00` and `+05:30`, the same
    matrix on the completion endpoint, and a statement-level assertion that no
    release decision uses the session-dependent form.
  - `server/tests/m2-course-lessons-reorder.test.ts` — the expected event sequence
    gained `dependent_order` **before** the first `reorder_update`, which is the
    point of the fix.
  - `docs/streams/server/M2-B15-CONTRACT.md` — section 3 (epoch comparison and why),
    section 4.1 (the ONE order), 4.2 (the final-state invariant), 4.3 (the archival
    policy and the migration dependency), and three new `409` rows.
  - `docs/streams/client/M2-23-CONTRACTS.md` — section 4.1: the browser selector is
    deliberately narrower than the server, and both new `409`s are documented as
    ordinary refusals that need no new client state or retry path.
- Verified behavior: a prerequisite in an earlier unit is accepted and one in a
  later unit is refused whatever the in-unit positions say; a prerequisite of an
  archived unit is refused; a `display_order`-only `PATCH` that would invert the
  stored edge is refused and writes nothing; moving a lesson past a dependent is
  refused for `PATCH` and for reorder; ordered moves still succeed; archiving a
  lesson or a unit with an active dependent is refused and the edge survives;
  archiving with only archived dependents still succeeds; the release decision is
  identical before/at/after the instant on four session offsets, on both the path
  read and the completion lock.
- Exact commands and results (repo root, Node v22.22.2):
  - `npx tsx --test server/tests/m2-lesson-release.test.ts server/tests/m2-student-course-access.test.ts server/tests/m2-course-lessons.test.ts server/tests/m2-course-lessons-reorder.test.ts server/tests/m2-course-units.test.ts server/tests/m2-course-publication.test.ts server/tests/m2-public-course-discovery.test.ts`
    → **310 pass / 0 fail** (the 290 baseline plus 20 new tests).
  - `npx tsx --test src/tests/m2-course-lesson-ui.test.ts src/tests/m2-student-learning-path.test.ts` → **123 pass / 0 fail**.
  - `npm run test:src` → **1707 pass / 0 fail** (unchanged).
  - `npx tsc --noEmit` (server) → 0 errors; `npm --prefix server run build` → success.
  - `npx tsc -p tsconfig.app.json --noEmit` → 0 errors; `npm run build` → success
    (chunk-size warnings only, as before).
  - **Mutation checks** (each fix reverted, suite re-run, fix restored):
    reverting the epoch comparison fails the 3 time tests; making the order
    lesson-only fails the cross-unit test; dropping the unit-active rule fails the
    archived-unit test; dropping the `PATCH` stored-edge re-proof fails the
    position-only test; dropping the `PATCH` dependent proof fails the dependent
    test; dropping the lesson archive guard fails the archive test; dropping the
    reorder dependent proof fails 2 tests; dropping the unit archive guard fails 2
    tests. Every correction is therefore pinned by a test that fails without it.
- Limitations: the migration is still **FILE ONLY** and was not applied. The new
  unit-archive guard makes `course-units.ts` read
  `course_lessons.prerequisite_lesson_id`, so unit archival now requires the
  additive `20261023_04` migration and fails closed (500) without it — recorded in
  `M2-B15` §4.3 rather than papered over. The browser prerequisite selector remains
  same-unit only, so a cross-unit edge the server accepts cannot be expressed in the
  current form. No database, provider, listener, deployment, secret or Git action
  was used, and the client's `StudentContent` flow was not touched.

### Follow-up (not a batch, not approved): content binding and progression ownership

The remaining gap in this area — a lesson is schedulable, orderable and
completable while pointing at no deliverable, and two unrelated progress ledgers
exist — is recorded as a **PROPOSAL ONLY** in
`docs/streams/server/M2-B16-PROPOSAL.md`. It names the verified evidence (the two
link directions `secure-video.ts` already refuses to guess between), the five
paths a bounded batch would touch, the dependencies, the tests, and the two
product decisions (does a lesson carry several deliverables; which ledger owns
progression) that must be taken before any code is written. It authorizes
nothing and was not executed.

## Historical M2 status

`docs/streams/client/M2-REMAINING.md` ends with M2-23 as the final consolidated
non-OTP batch, but its coordination record stopped at a WorkBuddy rate limit.
The current dirty tree now contains the student router, mount, frontend wiring,
tests and contracts. Inspect the exact paths in `docs/streams/client/M2-23-HANDOFF.md`
and audit E/F; neither the old STOP record nor passing scoped tests establishes
whole-M2 or content-delivery completion.

