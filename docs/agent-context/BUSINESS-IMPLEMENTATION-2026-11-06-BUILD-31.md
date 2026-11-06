# Business implementation — BUILD-31 — 6 November 2026

Implemented an actual owner lesson package comparison panel inside lesson
management. The owner can review material/video position and capacity conflicts,
homework/quiz/announcement singleton conflicts, restricted/draft/unavailable
sources and quiz version differences before manually binding references.
This is local read-only progress in J02, not completion of templates or copying.

Contract: [lesson package preview](../streams/client/J02-LESSON-PACKAGE-PREVIEW.md).

## Changed files

- `src/features/catalog/lesson-package-preview.ts`: comparison, canonical private
  read composition, strict existing parsers, bounded source choices, deadline,
  abort/session/principal/selection fencing and all-or-nothing result handling.
- `src/features/catalog/LessonPackagePreview.tsx`: deliberate source selector and
  comparison button, escaped result rows, conflicts and explicit readiness limits.
- `src/features/catalog/CourseLessonManager.tsx`: actual per-lesson entry point.
- `src/tests/lesson-package-preview.test.ts`: 23 new tests, including actual
  component callbacks and real canonical HTTP transport with synthetic responses.
- Queue, matrix, README, strategy and the linked client contract.

## Demonstrated behavior and material limits

Opening the panel reads nothing. Only currently loaded same-unit/same-course
lessons are selectable; source cannot equal destination. At most 8 reference
reads plus 2 conditional quiz-pin reads per deliberate comparison. Existing
server routes retain owner/source authority. No backend route/schema changes.

Both sides must load completely. Denied/malformed/schema-unavailable reads clear
results; no empty-package or general/legacy fallback. Session change, late reply,
source switch, unmount and timeout cannot restore the old result. Shared mixed
positions and the 20-item bound are preserved. Existing identical references
do not consume new slots. Draft and restricted sources remain visible warnings.

The preview is based on separate reads, not an atomic snapshot or approved write
plan. It cannot prove exact audience overlap, current student entitlement,
provider/file delivery or performance. Cross-unit selection, saved templates,
batch apply and timing are still open. Source quiz pins and announcement
publication require independent destination review; no attempts, submissions,
progress, permissions or exam/enrollment limits are copied/reset.

## Verification

Using installed compatible Node; no packages installed:

```powershell
$businessNode='C:/Users/BaraaWael/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe'
& $businessNode --import ./node_modules/tsx/dist/loader.mjs --test --test-reporter=spec src/tests/lesson-package-preview.test.ts
$frontendTests=@(Get-ChildItem src/tests/*.test.ts | ForEach-Object {$_.FullName}) + @('src/auth/access-control.test.ts')
& $businessNode --import ./node_modules/tsx/dist/loader.mjs --test --test-reporter=spec @frontendTests
$catalogTests=@('m2-lesson-quiz-versions','m2-lesson-activities','m2-lesson-videos','m2-lesson-contents','m2-lesson-release','m2-course-lessons','m2-course-lessons-reorder','m2-course-units','m2-lesson-announcements','lesson-announcement-publication') | ForEach-Object { 'server/tests/'+$_+'.test.ts' }
& $businessNode --import ./node_modules/tsx/dist/loader.mjs --import ./server/tests/helpers/isolated-io-guard.ts --test --test-reporter=spec @catalogTests
& $businessNode ./node_modules/typescript/bin/tsc -p tsconfig.app.json --noEmit
& $businessNode ./node_modules/vite/bin/vite.js build
```

Scoped new frontend: **23 pass / 0 fail**. Full frontend: **2067 pass / 0 fail**.
Scoped existing catalog backend: **352 pass / 0 fail**. Frontend types and Vite
build pass; the existing main chunk size warning remains (~3.73 MB minified,
~1.06 MB gzip). Logs: `output/package-preview-build31-{scoped,frontend,server,types,vite}.txt`.
Server source was not changed; server types/full backend were not rechecked.
The previously documented premium-lecture failure is still open; these results
do not mean the entire backend passed. No real browser/provider/database/load
acceptance, external activation, migration application, Git or GitHub use.

## Next

Implement reviewed server-side batch reference reuse with atomic audit and
stale-review/idempotency/unknown-commit handling, then connect explicit owner
approval. Preserve the separate announcement-publication and quiz-pin lifecycles.
Extend bounded source selection across units and define timing/template storage
without copying student history or access rights. Other journeys and external
gates remain as tracked in the execution queue.
