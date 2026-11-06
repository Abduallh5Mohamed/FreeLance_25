# Business implementation — 2026-11-06, BUILD-23

Continuation: [BUILD-24](BUSINESS-IMPLEMENTATION-2026-11-06-BUILD-24.md) adds
explicit owner selection of a published quiz header and its editor. Durable
catalog-bound attempt start/read/save/submit remains pending; launch unconfigured.

Continues [BUILD-22](BUSINESS-IMPLEMENTATION-2026-11-06-BUILD-22.md).
[Student read contract](../streams/server/J03-STUDENT-LESSON-ACTIVITIES.md),
[execution queue](BUSINESS-EXECUTION-QUEUE.md).

## Result and limits

The actual student learning path now displays authorized published homework/quiz
references and separately reads homework instructions and its database deadline.
Both new student GET routes repeat identity, lesson, actual enrollment-group,
branch, source/publication and original assessment audience proof. The shared
video identity/lesson/group proof was extracted without introducing a second
student branch policy. Selected-reference proof remains server-private.

The panel starts collapsed and uses strict locator/source-free DTOs. It fences
late/aborted responses and scope/unmount changes, latches duplicate detail reads,
clears private state after withdrawal and renders instructions as escaped text.
All requests are canonical authenticated no-store GETs. No enrollment, attempt,
submission, score, question/answer, notification or completion is created/read by
these routes. Deadline display does not mean a submission window is open.

**Starting/submitting remains explicitly unconfigured.** The legacy exam path
contains auto-enrollment and ambiguous legacy schedule handling; linking a button
to it would bypass the new boundary. The existing mounted versioned exam engine
is the next integration candidate, after explicit snapshot/attempt context proof.
No new migration, schema application, provider or actual browser acceptance.

## Changed files

| File | Change |
|---|---|
| `server/src/services/student-lesson-audience.ts` (new) | Shared extracted live student/lesson/group/branch proof |
| `server/src/services/student-lesson-videos.ts` | Reuses the shared proof; video-specific reference/schema/source checks remain |
| `server/src/services/lesson-activities.ts` | Exports existing schema/source proof and internal audience facts; fixed owner HTTP projection unchanged |
| `server/src/services/student-lesson-activities.ts` (new) | Published student metadata, private selected reference proof and bounded homework detail read |
| `server/src/routes/student-course-access.ts` | Actual no-store list/detail routes with strict selectors and student scope |
| `src/features/catalog/student-lesson-activities.ts` (new) | Strict DTOs, read-only controller, abort/deadline/session/target fences |
| `src/features/catalog/StudentLessonActivities.tsx` (new) | Actual collapsed list, explicit detail action and honest unavailable launch state |
| `src/pages/StudentContent.tsx` | Mounts the activity panel only for accessible catalog lesson rows |
| `src/lib/api-http.ts` | Canonical activity list/detail GET transports |
| `server/tests/student-lesson-activities.test.ts` (new) | Real service/router with synthetic SQL, authority/source/audience/schema/withdrawal/privacy cases |
| `server/tests/m2-student-course-access.test.ts` | Route inventory and actual auth/workspace-chain negative cases |
| `src/tests/student-lesson-activities.test.ts` (new) | Actual panel effect/button/SSR plus DTO/transport/lifecycle cases |

Context: this record, read contract, README, FEATURE_MATRIX, strategy 22, execution
queue and BUILD-22 contract/record continuation pointers.

## Fresh verification

Installed Node v24.19.0; no installation. Commands run independently:

```powershell
$businessNode = 'C:/Users/BaraaWael/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe'
& $businessNode --import ./node_modules/tsx/dist/loader.mjs --import ./server/tests/helpers/isolated-io-guard.ts --test --test-reporter=spec server/tests/student-lesson-activities.test.ts
& $businessNode --import ./node_modules/tsx/dist/loader.mjs --test --test-reporter=spec src/tests/student-lesson-activities.test.ts
& $businessNode --import ./node_modules/tsx/dist/loader.mjs --import ./server/tests/helpers/isolated-io-guard.ts --test --test-reporter=spec server/tests/student-lesson-activities.test.ts server/tests/m2-lesson-activities.test.ts server/tests/student-lesson-videos.test.ts server/tests/m2-lesson-videos.test.ts server/tests/m2-lesson-contents.test.ts server/tests/m2-lesson-release.test.ts server/tests/m2-student-course-access.test.ts server/tests/m2-course-lessons.test.ts server/tests/m2-course-lessons-reorder.test.ts server/tests/m2-course-units.test.ts server/tests/m2-course-publication.test.ts server/tests/m2-public-course-discovery.test.ts server/tests/catalog-video-session.test.ts
& $businessNode --import ./node_modules/tsx/dist/loader.mjs --import ./server/tests/helpers/isolated-io-guard.ts --test --test-reporter=spec --test-name-pattern 'catalog|generic fallback' server/tests/catalog-video-session.test.ts server/tests/m1-media-socket-regressions.test.ts server/tests/m3-playback-revocation-delivery.test.ts
& $businessNode --import ./node_modules/tsx/dist/loader.mjs --test --test-reporter=spec src/tests/*.test.ts src/auth/access-control.test.ts
& $businessNode ./server/node_modules/typescript/bin/tsc -p server/tsconfig.json
& $businessNode ./node_modules/typescript/bin/tsc -p tsconfig.app.json --noEmit
& $businessNode ./node_modules/vite/bin/vite.js build
```

New student activity backend: **25 pass / 0 fail**. New frontend: **11 pass / 0
fail**. Thirteen catalog/proof suites: **520 pass / 0 fail**. Scoped actual video
session/delivery/persistence regression: **28 pass / 0 fail**. Full frontend:
**1955 pass / 0 fail**. Frontend types, server compile/build and Vite build passed.
Vite retains the large-chunk warning (main JS about 3.65 MB / 1.04 MB gzip);
no loading-performance improvement is claimed.

Transcripts: `output/student-activities-build23-focused.txt`,
`output/student-activities-build23-server.txt`, `output/student-activities-build23-media.txt`,
`output/student-activities-build23-frontend.txt`, `output/student-activities-build23-vite.txt`.
Tests use synthetic SQL/I/O isolation and actual service/router/helper policies.
UI checks exercise actual TSX effects/button wiring with hook fixtures and SSR,
not a browser or real provider. Read fixtures reject every mutation and forbid
question/attempt/submission queries; actual route checks prove rollback-only reads.

The prior premium-lecture regression remains tracked; the full unrelated video
suite was not rerun here. Its old failure/count is not new evidence, and there
is no whole-backend-green or production-readiness claim.

## Next work

Establish explicit published-snapshot selection for catalog quizzes using the
existing versioned engine; then design durable catalog-bound attempt start and
read/save/submit revocation checks with original attempt/window/grading rules and
truthful idempotency/uncertain outcomes. Current metadata proof is insufficient
for an attempt. Do not redirect through old auto-enrollment routes or silently
pick a snapshot. Homework upload/submission requires matching selected enrollment
and the existing private object/scan pipeline. No automatic completion.

Previous schema files remain unapplied. Real FK/engine/index/query-plan/isolation,
browser/device/provider/load acceptance and other J00–J10 work remain open.
No Git/GitHub, live DB/provider/data change, migration application, deployment,
package installation or spending.
