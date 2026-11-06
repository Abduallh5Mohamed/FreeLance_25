# Business implementation — BUILD-32 — 6 November 2026

Implemented reviewed, selected lesson reference reuse as one owner journey:
select references, read current server review, explicitly approve, atomically
insert references with audit/receipt, and recover an uncertain save using a
read-only operation lookup. Existing quiz pins and announcement publication
remain independent destination actions. This is conditional local J02 work.

Contract: [reviewed package reuse](../streams/server/J02-LESSON-PACKAGE-REUSE.md).

## Changed files

- `server/src/services/lesson-package-reuse.ts`: strict selection validation,
  actual schema/index/type/engine checks, locked bounded source/destination
  review, exact existing domain source proofs, stale review/final-state conflict
  rejection, atomic reference/audit/receipt and payload-bound replay/status.
- `server/src/routes/course-lessons.ts`: mounted review/apply/status with current
  owner/course/destination proof and explicit persistence-uncertain response.
- `server/migrations/20261106_09_course_lesson_package_operations.sql`: new
  idempotency receipt file only, not applied.
- `src/features/catalog/lesson-package-reuse.ts`: canonical authenticated
  transport, strict selected-reference parsers, approval/save/recovery lifecycle,
  selection/session/principal/unmount/timeout fences and uncertain-write freeze.
- `src/features/catalog/LessonPackageReuse.tsx` and `LessonPackagePreview.tsx`:
  actual checkboxes/server review/explicit confirmation and GET recovery controls;
  confirmed save is distinct from refreshed lists.
- `server/tests/lesson-package-reuse.test.ts`: 26 new actual-router tests.
- `src/tests/lesson-package-reuse.test.ts`: 16 new tests including actual
  component callbacks, canonical requests, lost reply/GET recovery and escaped UI.
- Queue, README, matrix, strategy and contracts.

## Demonstrated behavior

All five reference types can be selected together; same-course source unit is
derived server-side. Source/target course authority cannot be replaced by client
fields. Both lessons/units must be active for new work. Shared positions and the
20 media bound, singleton slots, unavailable/foreign source, group scope changes
and stale source/destination review are checked before writes. A subset only is
copied. Existing identical references do not duplicate. No student history,
source publication, destination quiz pin or announcement publication is copied.

Audit/write/receipt failures roll back all inserted references. Exact operation
replay creates no duplicate audit or references; changing its payload/context
is rejected. Lost commit acknowledgement discards the connection and reports
uncertainty; GET receipt recovers without applying another write. Fixture races
show one synthetic commit for duplicate requests and rejection for a competing
stale operation, not real MySQL concurrency acceptance.

UI does no automatic copy on mount. Current server review plus explicit approval
is required. Malformed/lost/5xx save responses freeze writes. Missing/failed GET
receipt does not clear uncertainty or cause POST retry. Confirmed counts are
historical save evidence; the UI requires refreshing existing panels/comparison.

## Verification

Installed compatible Node; no packages installed:

```powershell
$businessNode='C:/Users/BaraaWael/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe'
& $businessNode --import ./node_modules/tsx/dist/loader.mjs --import ./server/tests/helpers/isolated-io-guard.ts --test --test-reporter=spec server/tests/lesson-package-reuse.test.ts
& $businessNode --import ./node_modules/tsx/dist/loader.mjs --test --test-reporter=spec src/tests/lesson-package-reuse.test.ts src/tests/lesson-package-preview.test.ts
$frontendTests=@(Get-ChildItem src/tests/*.test.ts | ForEach-Object {$_.FullName}) + @('src/auth/access-control.test.ts')
& $businessNode --import ./node_modules/tsx/dist/loader.mjs --test --test-reporter=spec @frontendTests
$catalogTests=@('m2-lesson-quiz-versions','student-lesson-activities','m2-lesson-activities','student-lesson-videos','m2-lesson-videos','m2-lesson-contents','m2-lesson-release','m2-student-course-access','m2-course-lessons','m2-course-lessons-reorder','m2-course-units','m2-course-publication','m2-public-course-discovery','catalog-video-session','catalog-exam-attempts','m4-exam-snapshots','m4-exam-grading','m4-assignments','m4-assignment-storage','m4-assignment-scan-worker','catalog-homework','m2-lesson-announcements','m2-announcements','m2-group-announcements','m2-group-announcements-failures','lesson-announcement-publication','lesson-package-reuse') | ForEach-Object { 'server/tests/'+$_+'.test.ts' }
& $businessNode --import ./node_modules/tsx/dist/loader.mjs --import ./server/tests/helpers/isolated-io-guard.ts --test --test-reporter=spec @catalogTests
& $businessNode ./node_modules/typescript/bin/tsc -p tsconfig.app.json --noEmit
& $businessNode ./server/node_modules/typescript/bin/tsc -p server/tsconfig.json
& $businessNode ./node_modules/vite/bin/vite.js build
```

Scoped new backend: **26 pass / 0 fail**. Scoped frontend: **39 pass / 0 fail**
(16 new plus 23 comparison tests). Combined relevant backend: **969 pass / 0 fail**.
Full frontend: **2083 pass / 0 fail**. Both type checks/server compilation and
Vite build pass. Existing main chunk warning remains (~3.74 MB minified,
~1.06 MB gzip). Logs:
`output/package-reuse-build32-{scoped-server,scoped-frontend,server,frontend,types,server-types,vite}.txt`.

The known earlier premium-lecture failure remains open; full backend was not
declared passing. No Git/GitHub, live DB, migration application, real provider,
package installation, deployment, browser/device or load acceptance occurred.

## Remaining limits and next

New receipt schema and earlier dependencies are unapplied; reuse fails closed
without them. Pending recovery context is memory-only; closing/reloading loses
the UI locator, though confirmed server receipts persist with their schema.
No receipt history UI or retention maintenance is activated. Existing comparison
and content panels are not automatically made current after a save.

Next: bounded cross-unit source selection within the same course in the actual
UI, with source-change/selection/review fencing; then define saved lesson
templates and timing semantics without bulk publishing. Current copy preserves
original positions and source audiences, so conflicts need explicit owner repair.
J03 real schema/concurrency/source-writer/query/performance/browser/provider
acceptance and the other tracked journeys remain open. Quiz pin selection,
announcement publication and student progression stay separate.
