# Business implementation — 2026-11-06, BUILD-22

Continuation: [BUILD-23](BUSINESS-IMPLEMENTATION-2026-11-06-BUILD-23.md) adds the
actual student's published metadata/homework-detail routes and panel. Attempt
launch/submission remains unconfigured pending explicit snapshot/context binding.

Continues [BUILD-21](BUSINESS-IMPLEMENTATION-2026-11-06-BUILD-21.md).
[Activity contract](../streams/server/J02-LESSON-ACTIVITIES-CONTRACT.md),
[execution queue](BUSINESS-EXECUTION-QUEUE.md).

## Result

The actual owner lesson editor now has homework/quiz preparation backed by
mounted private catalog routes. One homework slot references existing assignments;
one quiz slot references existing exams. Both require the exact active owner,
tenant course and lesson, actual required schema, same-course source and valid
bounded audience facts. Drafts can be prepared without publishing them. The two
slots are separate from the twenty ordered material/video references.

Owners can select paged sources, see draft/published and restricted-audience
labels, attach, inspect or explicitly detach a pinned reference. Original
assessments, attempts, submissions and grades are preserved. A changed reference
cannot be removed by a stale delete. Writes/audit are atomic, duplicate attaches
are no-ops, and unknown commit is not silently retried. Client state separates
confirmed save from failed refresh and retires responses after scope/unmount.

This is **owner preparation only**, not whole J02/J03 completion. No student
catalog launch, assessment read/attempt grant, enrollment, question copying,
notification, publication or progress write. The new migration is an unapplied
file. Branch-wide homework without a group is deliberately unavailable pending
its own branch proof. Real schema/concurrency/performance/browser acceptance is
not supplied by synthetic tests.

## Changed files

| File | Change |
|---|---|
| `server/src/services/lesson-activities.ts` (new) | Actual schema checks, batched source/audience proof, bounded owner projections and reference/audit writes |
| `server/src/routes/course-lessons.ts` | Mounted owner routes with exact selectors, fresh owner/parent authority and transaction uncertainty response |
| `server/migrations/20261106_03_course_lesson_activities.sql` (new, unapplied) | Two typed slots, uniqueness, FK and matching-source CHECK |
| `src/features/catalog/lesson-activities.ts` (new) | Strict DTO parsing, fenced editor, single-flight writes and truthful refresh/recovery state |
| `src/features/catalog/LessonActivityManager.tsx` (new) | Actual collapsed owner editor, selection/paging/status and pinned detach confirmation |
| `src/features/catalog/CourseLessonManager.tsx` | Integrates the new editor into each real lesson row |
| `src/lib/api-http.ts` | Canonical authenticated no-store list/selector/attach/pinned-detach transport |
| `server/tests/m2-lesson-activities.test.ts` (new) | Real router over transactional SQL fixtures, denial/schema/audience/count/atomicity/concurrency/uncertain-commit cases |
| `src/tests/lesson-activities.test.ts` (new) | Actual editor effect/attach callback, canonical transport, strict DTOs and lifecycle/write outcomes |

Context updates: this record, activity contract, README, FEATURE_MATRIX, strategy
22, execution queue and BUILD-21 continuation pointer.

## Fresh verification

Installed Node v24.19.0, no installation. Commands run independently:

```powershell
$businessNode = 'C:/Users/BaraaWael/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe'
& $businessNode --import ./node_modules/tsx/dist/loader.mjs --import ./server/tests/helpers/isolated-io-guard.ts --test --test-reporter=spec server/tests/m2-lesson-activities.test.ts
& $businessNode --import ./node_modules/tsx/dist/loader.mjs --test --test-reporter=spec src/tests/lesson-activities.test.ts
& $businessNode --import ./node_modules/tsx/dist/loader.mjs --import ./server/tests/helpers/isolated-io-guard.ts --test --test-reporter=spec server/tests/m2-lesson-activities.test.ts server/tests/student-lesson-videos.test.ts server/tests/m2-lesson-videos.test.ts server/tests/m2-lesson-contents.test.ts server/tests/m2-lesson-release.test.ts server/tests/m2-student-course-access.test.ts server/tests/m2-course-lessons.test.ts server/tests/m2-course-lessons-reorder.test.ts server/tests/m2-course-units.test.ts server/tests/m2-course-publication.test.ts server/tests/m2-public-course-discovery.test.ts
& $businessNode --import ./node_modules/tsx/dist/loader.mjs --test --test-reporter=spec src/tests/*.test.ts src/auth/access-control.test.ts
& $businessNode ./server/node_modules/typescript/bin/tsc -p server/tsconfig.json
& $businessNode ./node_modules/typescript/bin/tsc -p tsconfig.app.json --noEmit
& $businessNode ./node_modules/vite/bin/vite.js build
```

New backend suite: **19 tests** pass in the final broadened run. New frontend:
**13 pass / 0 fail**. Eleven catalog suites: **476 pass / 0 fail**. Full frontend:
**1944 pass / 0 fail**. Frontend typecheck, server compile/build and Vite build
passed. Vite retains its large-chunk warning (main JS about 3.64 MB / 1.04 MB gzip);
no load-time or bundle improvement is claimed.

Transcripts: `output/lesson-activities-build22-server.txt`,
`output/lesson-activities-build22-frontend.txt`, `output/lesson-activities-build22-vite.txt`.
The UI test runs actual TSX effect/button wiring with injected hooks and SSR,
not an actual browser/provider. Backend tests use the isolated I/O guard and real
handlers with synthetic transactional SQL, not real MySQL locking or migrations.
The source-selector query count stays constant for one versus twenty-five quiz
sources; that is not a measured SQL plan/load result.

The previously observed premium-lecture failure from BUILD-20/21 is still tracked
in the queue. That unrelated video regression was not rerun here; no old test
count is presented as fresh evidence and no whole-backend-green claim is made.

## Next work

Student activity metadata and launch must combine fresh catalog release/
prerequisite/enrollment/branch proof with the original assignment/exam audience,
window, frozen-version and attempt policy. Inspection found existing legacy exam
`can-attempt`/`start` handlers can auto-enroll; do not expose those as a safe
catalog launch without resolving that boundary. No catalog ID is a legacy
assignment/exam ID, and no metadata read may create an enrollment or attempt.

Other J02 work includes announcements, templates, timing, audience and publish
preview. Other J00–J10 journeys and real J03 schema/media/device/load acceptance
remain open. No Git/GitHub, live DB/data/provider, migration application, package
installation, deployment or spending.
