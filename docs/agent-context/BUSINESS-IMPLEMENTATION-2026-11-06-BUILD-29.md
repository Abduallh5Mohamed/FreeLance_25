# Business implementation — BUILD-29 — 6 November 2026

## Result and scope

Implemented actual owner lesson-announcement reference selection, binding,
detachment and private content/potential-audience preview, mounted in the lesson
manager. Uses existing same-course group announcements without changing their
private state or creating a second authoring/delivery engine. Student
publication/consumption and real notification delivery remain unconfigured.

Contract: [lesson announcement preparation](../streams/server/J02-LESSON-ANNOUNCEMENT-PREPARATION.md).

## Changed files

- `server/src/services/lesson-announcements.ts`: actual schema/index/FK probes,
  bounded same-course/tenant source and branch proof, single pinned reference,
  atomic existing audit seam and aggregate-only potential audience preview.
- `server/src/routes/course-lessons.ts`: mounted owner routes, existing parent
  authority/transaction wiring, strict paths/payloads, no-store and truthful
  unknown-commit outcome for the new route label.
- `server/migrations/20261106_07_course_lesson_announcements.sql`: additive
  reference table/unique slot/cascade FK **file only**, not applied.
- `src/features/catalog/lesson-announcements.ts`: strict DTOs, authenticated
  canonical transport, bounded source paging and session-fenced controller.
- `src/features/catalog/LessonAnnouncementManager.tsx` and
  `src/features/catalog/CourseLessonManager.tsx`: actual selector, reference,
  text/count/gate preview, detach confirmation and explicit current-state reload.
- `server/tests/m2-lesson-announcements.test.ts`: 15 new actual-router tests.
- `src/tests/lesson-announcements.test.ts`: 13 new frontend tests, including
  actual effects/preview callback and escaped SSR output.
- Current queue, README, feature matrix, strategy and source-contract follow-up.

## Behavior demonstrated locally

Owner/course/unit/lesson authority is server-derived. Foreign/retracted sources
deny; branch-invalid headers are withheld without losing raw cursor position.
Same-source attach is a no-op; replacing an existing slot is refused. Stale
reference IDs cannot detach/preview a newer binding. Source withdrawal becomes
unavailable without deleting/changing the original announcement. Audit failure
rolls back reference mutation in fixtures; unknown commit is recovered by reading
current state without a duplicate creation/audit or automatic write replay.

Preview includes escaped source text, group, bounded candidate-enrollment count,
publication/archival/release/prerequisite flags and database timestamp. SQL
filters group/tenant, approved active in-window enrollment, active unsuspended
user, course link and actual branch membership. No student identities/contact
data are projected. More than 500 candidates refuses preview rather than
claiming a truncated audience. Count is not unique people, individual prerequisite
proof, recipient commitment, student visibility or a delivery receipt.

Actual UI is initially collapsed and only reads when opened. Its source paging,
single-flight writes, scope/disposal/timeout fences and unknown-write freeze are
tested. Reading after uncertainty establishes current state, not historical
confirmation of the failed acknowledgement. No publish/send action, source edit,
student access, enrollment, grade, progress or financial effect is introduced.

## Verification

Installed Node 24, no new packages:

```powershell
$businessNode='C:/Users/BaraaWael/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe'
& $businessNode --import ./node_modules/tsx/dist/loader.mjs --import ./server/tests/helpers/isolated-io-guard.ts --test --test-reporter=spec server/tests/m2-lesson-announcements.test.ts
& $businessNode --import ./node_modules/tsx/dist/loader.mjs --test --test-reporter=spec src/tests/lesson-announcements.test.ts
$frontendTests=@(Get-ChildItem src/tests/*.test.ts | ForEach-Object {$_.FullName}) + @('src/auth/access-control.test.ts')
& $businessNode --import ./node_modules/tsx/dist/loader.mjs --test --test-reporter=spec @frontendTests
$announcementTests=@('m2-lesson-quiz-versions','student-lesson-activities','m2-lesson-activities','student-lesson-videos','m2-lesson-videos','m2-lesson-contents','m2-lesson-release','m2-student-course-access','m2-course-lessons','m2-course-lessons-reorder','m2-course-units','m2-course-publication','m2-public-course-discovery','catalog-video-session','catalog-exam-attempts','m4-exam-snapshots','m4-exam-grading','m4-assignments','m4-assignment-storage','m4-assignment-scan-worker','catalog-homework','m2-lesson-announcements','m2-announcements','m2-group-announcements','m2-group-announcements-failures') | ForEach-Object { "server/tests/$_.test.ts" }
& $businessNode --import ./node_modules/tsx/dist/loader.mjs --import ./server/tests/helpers/isolated-io-guard.ts --test --test-reporter=spec @announcementTests
& $businessNode ./node_modules/typescript/bin/tsc -p tsconfig.app.json --noEmit
& $businessNode ./server/node_modules/typescript/bin/tsc -p server/tsconfig.json
& $businessNode ./node_modules/vite/bin/vite.js build
```

New suites: **15 backend / 13 frontend pass**, no failures, included in
**920 combined backend** and **2030 full frontend pass / 0 fail**. Types/server
compile/build and Vite build pass. Main-chunk size warning remains; no performance
improvement claimed. Transcripts:
`output/announcement-build29-{scoped-server,scoped-frontend,server,frontend,types,server-types,vite}.txt`.

Tests use actual routers/effects with transactional synthetic SQL and hook/SSR
fixtures, not a browser or real database. FK cascades, MySQL isolation/deadlocks,
SQL plans/count correctness under real load and device/resource acceptance remain
open. Earlier evidence is not a fresh run. The known premium-lecture regression
remains tracked; unrelated full video suites were not rerun, and the whole backend
is not declared clean.

## Remaining work

No Git/GitHub, migration application, live DB/data/provider, deployment,
installation or spending. All new schema files remain unapplied. A source's
private published state is not student publication. There is no delivery,
outbox, schedule, student read or publish capability yet. The preview is a
point-in-time potential count, not an immutable approved audience. Other J00–J10
journeys and catalog/legacy progress separation remain as before.

Next: explicit catalog announcement publication/current student-read contract,
reviewed source/content revision and stale-preview protection, followed by UI
publication controls. Student reads must prove exact group + current lesson
access, and source edits/withdrawals must not bypass review. No notification
delivery or generic tenant-announcement shortcut.
