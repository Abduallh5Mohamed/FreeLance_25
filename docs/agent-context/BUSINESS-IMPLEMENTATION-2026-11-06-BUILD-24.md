# Business implementation — 2026-11-06, BUILD-24

Continues [BUILD-23](BUSINESS-IMPLEMENTATION-2026-11-06-BUILD-23.md).
[Published-version selection contract](../streams/server/J02-LESSON-QUIZ-VERSION-PIN.md),
[execution queue](BUSINESS-EXECUTION-QUEUE.md).

## Result and limits

The actual owner quiz activity editor now supports explicitly selecting and
pinning a published version of that same exam, through new mounted private
catalog routes. A new publication never changes the selected snapshot. Draft,
archived or foreign headers cannot be selected, and a stale unpin cannot remove
a replacement. A withdrawn selection is shown as unavailable without a fallback.

Source and parent authority, actual required schema/FKs/indexes, bounded header
projection, duplicate/no-op handling and atomic audit are enforced server-side.
The actual UI starts collapsed with no selected default, latches writes, confirms
unpin and retires stale async state. Confirmed save with failed refresh is
reported separately from unknown writes. There is no automatic mutation retry.

This is header selection **only**. Questions/hashes, attempt window/allowance,
student attempt context and full entry-point revocation are not proved by pinning.
No exam is published, question copied or grade/attempt/progress changed. Student
launch remains explicitly unconfigured. The new migration is a file, not an
applied schema or a production activation.

## Changed files

| File | Change |
|---|---|
| `server/src/services/lesson-quiz-versions.ts` (new) | Actual schema/FK proof, bounded same-exam/tenant published header selection and pin/audit writes |
| `server/src/routes/course-lessons.ts` | Actual owner version read/selector/pin/pinned-unpin routes; uncertainty response |
| `server/migrations/20261106_04_course_lesson_quiz_versions.sql` (new, unapplied) | One selection per quiz reference, content cascade and restricted source FKs |
| `src/features/catalog/lesson-quiz-versions.ts` (new) | Strict DTOs and fenced read/paging/pin/unpin controller |
| `src/features/catalog/LessonQuizVersionManager.tsx` (new) | Actual collapsed version editor with explicit selection and unpin confirmation |
| `src/features/catalog/LessonActivityManager.tsx` | Mounts the version editor only on the current quiz reference |
| `src/lib/api-http.ts` | Canonical authenticated no-store version transports |
| `server/tests/m2-lesson-quiz-versions.test.ts` (new) | Actual router over transactional SQL fixtures, source/schema/FK/withdrawal/stale-delete/atomicity/uncertainty cases |
| `src/tests/lesson-quiz-versions.test.ts` (new) | Actual effect/pin-button wiring, transports, strict parsing, no-auto-selection and lifecycle/write outcomes |

Context: this record, selection contract, README, FEATURE_MATRIX, strategy 22,
execution queue and BUILD-23 contract/record pointers.

## Fresh verification

Installed Node v24.19.0; no installation. Commands run independently:

```powershell
$businessNode = 'C:/Users/BaraaWael/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe'
& $businessNode --import ./node_modules/tsx/dist/loader.mjs --import ./server/tests/helpers/isolated-io-guard.ts --test --test-reporter=spec server/tests/m2-lesson-quiz-versions.test.ts
& $businessNode --import ./node_modules/tsx/dist/loader.mjs --test --test-reporter=spec src/tests/lesson-quiz-versions.test.ts
& $businessNode --import ./node_modules/tsx/dist/loader.mjs --import ./server/tests/helpers/isolated-io-guard.ts --test --test-reporter=spec server/tests/m2-lesson-quiz-versions.test.ts server/tests/student-lesson-activities.test.ts server/tests/m2-lesson-activities.test.ts server/tests/student-lesson-videos.test.ts server/tests/m2-lesson-videos.test.ts server/tests/m2-lesson-contents.test.ts server/tests/m2-lesson-release.test.ts server/tests/m2-student-course-access.test.ts server/tests/m2-course-lessons.test.ts server/tests/m2-course-lessons-reorder.test.ts server/tests/m2-course-units.test.ts server/tests/m2-course-publication.test.ts server/tests/m2-public-course-discovery.test.ts server/tests/catalog-video-session.test.ts
& $businessNode --import ./node_modules/tsx/dist/loader.mjs --import ./server/tests/helpers/isolated-io-guard.ts --test --test-reporter=spec server/tests/m4-exam-snapshots.test.ts server/tests/m4-exam-grading.test.ts
& $businessNode --import ./node_modules/tsx/dist/loader.mjs --test --test-reporter=spec src/tests/*.test.ts src/auth/access-control.test.ts
& $businessNode ./server/node_modules/typescript/bin/tsc -p server/tsconfig.json
& $businessNode ./node_modules/typescript/bin/tsc -p tsconfig.app.json --noEmit
& $businessNode ./node_modules/vite/bin/vite.js build
```

New backend suite: **24 pass / 0 fail**. New frontend suite: **14 pass / 0 fail**.
Fourteen catalog/proof suites: **544 pass / 0 fail**. Existing versioned snapshot/
grading suites: **84 pass / 0 fail**. Full frontend: **1969 pass / 0 fail**.
Server compile/build, frontend typecheck and Vite build passed. The large-chunk
warning remains (main JS about 3.66 MB / 1.04 MB gzip); no performance gain claimed.

Transcripts: `output/quiz-version-build24-server.txt`,
`output/quiz-version-build24-exam-engine.txt`, `output/quiz-version-build24-frontend.txt`,
`output/quiz-version-build24-vite.txt`.

Backend tests use actual handlers and synthetic transactional SQL under isolated
I/O guard. They model parent serialization, not real MySQL locking. The frontend
test runs the actual TSX effect and pin callback with hook/SSR fixtures, not an
actual browser. There is no real FK/cascade/collation/SQL plan/load or provider
acceptance. The previously tracked premium-lecture regression is still open;
its unrelated full video suite was not rerun and no old count is new evidence.

## Next work

Backend continuation is implemented locally in [BUILD-25](BUSINESS-IMPLEMENTATION-2026-11-06-BUILD-25.md).
The following boundary is retained as BUILD-24 provenance; actual student UI and
live schema/concurrency acceptance are still pending.

Bind a student attempt durably to the exact catalog reference, selected published
snapshot and server-selected enrollment, reusing the existing engine. Prove the
frozen question/timing/audience/attempt policy on the write connection, retain
the original exam/enrollment attempt allowance, and enforce fresh context on
read/save/submit with no generic-entry fallback. Define old unbound-attempt and
historical-grade behavior and truthful duplicate/uncertain start recovery before
exposing the student button. Pin metadata alone does not authorize any of this.

No migration application, live DB/provider/data change, Git/GitHub, deployment,
package installation or spending. Other J00–J10 journeys and real acceptance
remain open; lesson and legacy progress stay separate.
