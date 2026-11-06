# Business implementation — BUILD-33 — 6 November 2026

Implemented actual bounded unit/lesson source selection for lesson package
comparison and reviewed reuse. The owner can choose a lesson in a different
unit of the same course without typing IDs or loading every course lesson.
This closes the same-unit UI limitation of BUILD-32; saved templates and timing
are not implemented by this batch.

Contract: [cross-unit package sources](../streams/client/J02-CROSS-UNIT-PACKAGE-SOURCES.md).

## Changed files

- `src/features/catalog/lesson-package-sources.ts`: canonical unit/lesson page
  reads, strict existing parsers, current-page selection, source/save lock,
  cancellation/deadline/session fences and all-or-nothing page handling.
- `src/features/catalog/LessonPackageSources.tsx`: actual unit and lesson
  selectors, first/next controls, archive/destination restrictions and empty,
  failure/session/save-lock states.
- `src/features/catalog/LessonPackagePreview.tsx`: actual picker mount,
  immutable cross-unit source key, separate source reader and locked comparison.
- `src/features/catalog/lesson-package-preview.ts`: optional separate source
  reader, retaining the existing destination reader and selection checks.
- `src/features/catalog/LessonPackageReuse.tsx`: reports save/recovery/uncertainty
  lock so browsing cannot discard an unresolved operation's in-memory context.
- `src/lib/api-http.ts`: optional AbortSignal for the existing two list APIs;
  fixed paths and default 25-row request limits unchanged.
- `src/tests/lesson-package-sources.test.ts`: 19 new tests, including actual
  picker/comparison callbacks and canonical cross-unit requests.
- `src/tests/lesson-package-preview.test.ts`, `lesson-package-reuse.test.ts`:
  hook harness continuation and actual save/uncertainty/unlock callback checks.
- Queue, README, matrix, strategy and related contracts.

## Demonstrated behavior

Closed picker sends nothing; opening reads one unit page. Only choosing a unit
reads its lessons; only deliberate comparison reads packages. First/next controls
replace pages, with at most 25 units and 25 lessons stored. Source selection is
limited to an active current-page row, excluding the destination. Existing strict
course/unit parsers reject foreign metadata. No tenant authority is passed by
the new UI, and existing owner checks remain server-side.

Actual comparison requests use source unit for the source lesson and destination
unit for destination; actual reuse still targets the destination path. Source,
page and refresh changes immediately remove old comparison/review children.
Cancelled/late/failed/oversized/duplicate pages cannot restore an old selection.
Clearing a unit during pending load does not leave controls stuck loading.
Session changes clear rows; selecting while a write is unresolved is rejected
by both the controls and controller. Closing/navigation remains the documented
exception that can discard the in-memory recovery locator without undoing writes.

## Verification

Installed compatible Node, no packages installed:

```powershell
$businessNode='C:/Users/BaraaWael/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe'
& $businessNode --import ./node_modules/tsx/dist/loader.mjs --test --test-reporter=spec src/tests/lesson-package-sources.test.ts src/tests/lesson-package-preview.test.ts src/tests/lesson-package-reuse.test.ts
$frontendTests=@(Get-ChildItem src/tests/*.test.ts | ForEach-Object {$_.FullName}) + @('src/auth/access-control.test.ts')
& $businessNode --import ./node_modules/tsx/dist/loader.mjs --test --test-reporter=spec @frontendTests
& $businessNode --import ./node_modules/tsx/dist/loader.mjs --import ./server/tests/helpers/isolated-io-guard.ts --test --test-reporter=spec server/tests/m2-course-units.test.ts server/tests/m2-course-lessons.test.ts server/tests/m2-course-lessons-reorder.test.ts server/tests/lesson-package-reuse.test.ts
& $businessNode ./node_modules/typescript/bin/tsc -p tsconfig.app.json --noEmit
& $businessNode ./node_modules/vite/bin/vite.js build
```

Scoped frontend: **58 pass / 0 fail**, including 19 new. Full frontend:
**2102 pass / 0 fail**. Scoped existing backend: **187 pass / 0 fail**.
Frontend type check and Vite build pass, with the existing large-main-chunk
warning. Logs: `output/package-sources-build33-{scoped,frontend,server,types,vite}.txt`.
Backend source/schema did not change; server compilation/full backend were not
rechecked. Earlier premium-lecture failure remains open; no entire-backend
passing claim is made.

No Git/GitHub, live DB, schema application, provider, deployment, package install,
real browser/device, actual MySQL concurrency/query plans or load measurement.
Tests exercise actual callbacks/SSR with synthetic HTTP and scoped server harnesses.

## Remaining and next

Source pages can move under edits, and there is no global snapshot or automatic
all-page loading. Save recovery stays memory-only; existing panels need manual
refresh after confirmed save. Receipt/source schemas remain unapplied; no quiz
pin, announcement publication, progress, history, access or allowance is copied.
Next: same-course saved reference template contract/revisions and explicit
destination timing, followed by their reviewed implementation. Other journeys
and real operational acceptance gates remain as tracked in the queue.
