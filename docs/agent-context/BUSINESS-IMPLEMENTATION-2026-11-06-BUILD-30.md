# Business implementation — BUILD-30 — 6 November 2026

## Result

Implemented explicit reviewed announcement publication/withdrawal, owner controls
and current authorized student reading inside the lesson. Separate from the
group source's private management state. Source edits/revisions hide unreviewed
text until explicit new publication. No external delivery or source edit occurs.
This is local conditional implementation, not whole-plan or production acceptance.

Contract: [reviewed announcement publication](../streams/server/J03-LESSON-ANNOUNCEMENT-PUBLICATION.md).

## Changed files

- `server/src/services/lesson-announcement-publication.ts`: actual schema/index/FK
  checks, source/review fingerprints, explicit atomic publication/withdrawal and
  fresh shared student group/lesson proof before private text projection.
- `server/src/services/lesson-announcements.ts`: exported same-course source
  reader and optional locking review reuse; ordinary preparation DTO unchanged.
- `server/src/routes/course-lessons.ts` and
  `server/src/routes/student-course-access.ts`: mounted owner lifecycle and
  separate student read, strict selectors/no-store and uncertainty response.
- `server/migrations/20261106_08_lesson_announcement_publications.sql`: additive
  one-publication-per-reference file, not applied or backfilled.
- `src/features/catalog/announcement-publication.ts`: fixed parsers/transport,
  owner/student session-fenced lifecycles, staleness and unknown-write recovery.
- `src/features/catalog/LessonAnnouncementPublication.tsx`,
  `src/features/catalog/StudentLessonAnnouncement.tsx`,
  `src/features/catalog/LessonAnnouncementManager.tsx`, `src/pages/StudentContent.tsx`:
  actual reviewed approval/withdrawal and student text panels, with separate
  preparation meaning, escaped text and no completion action.
- `server/tests/lesson-announcement-publication.test.ts`: 23 new actual-router
  tests; `server/tests/m2-student-course-access.test.ts`: actual route inventory.
- `src/tests/announcement-publication.test.ts`: 14 new tests;
  `src/tests/lesson-announcements.test.ts`: preparation wording continuation.
- Current queue, README, matrix, strategy and source/preparation contracts.

## Locally demonstrated behavior

Private group publication alone never exposes text. Owner review/publish is
bound to current text/revision/reference/group and displayed preview facts.
Changed review is rejected before mutation. Same current reviewed publication is
a no-op; a replacement uses a new ID and stale withdrawal cannot affect it.
Failed audit rolls back, and a lost commit reply is recovered by current reads.

Student routes use exact current identity/enrollment/course/lesson/group/branch
proof; release/prerequisite/suspension and withdrawal are enforced. Unreviewed
edits or source retraction return no text. Response includes only the permitted
title/body/content/publication/time fields, with no source/group/user identities.
New reads are current; already delivered text has no instant push-erasure promise.

UI requires fresh review and deliberate confirmation, never silently reuses
approval. Unknown mutation freezes writes even when recovery read fails. Actual
owner callbacks send review and publish requests; actual student mount sends
only its private read and clears on workspace event. No notification, outbox,
enrollment, access expansion, grade, payment or progress completion is written.

## Verification

Installed Node 24; no packages installed:

```powershell
$businessNode='C:/Users/BaraaWael/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe'
& $businessNode --import ./node_modules/tsx/dist/loader.mjs --import ./server/tests/helpers/isolated-io-guard.ts --test --test-reporter=spec server/tests/lesson-announcement-publication.test.ts server/tests/m2-lesson-announcements.test.ts
& $businessNode --import ./node_modules/tsx/dist/loader.mjs --test --test-reporter=spec src/tests/announcement-publication.test.ts src/tests/lesson-announcements.test.ts
$frontendTests=@(Get-ChildItem src/tests/*.test.ts | ForEach-Object {$_.FullName}) + @('src/auth/access-control.test.ts')
& $businessNode --import ./node_modules/tsx/dist/loader.mjs --test --test-reporter=spec @frontendTests
$publicationTests=@('m2-lesson-quiz-versions','student-lesson-activities','m2-lesson-activities','student-lesson-videos','m2-lesson-videos','m2-lesson-contents','m2-lesson-release','m2-student-course-access','m2-course-lessons','m2-course-lessons-reorder','m2-course-units','m2-course-publication','m2-public-course-discovery','catalog-video-session','catalog-exam-attempts','m4-exam-snapshots','m4-exam-grading','m4-assignments','m4-assignment-storage','m4-assignment-scan-worker','catalog-homework','m2-lesson-announcements','m2-announcements','m2-group-announcements','m2-group-announcements-failures','lesson-announcement-publication') | ForEach-Object { "server/tests/$_.test.ts" }
& $businessNode --import ./node_modules/tsx/dist/loader.mjs --import ./server/tests/helpers/isolated-io-guard.ts --test --test-reporter=spec @publicationTests
& $businessNode ./node_modules/typescript/bin/tsc -p tsconfig.app.json --noEmit
& $businessNode ./server/node_modules/typescript/bin/tsc -p server/tsconfig.json
& $businessNode ./node_modules/vite/bin/vite.js build
```

Scoped backend: **38 pass / 0 fail** (23 new). Scoped frontend: **27 pass / 0
fail** (14 new). These are included in **943 combined backend** and **2044 full
frontend pass / 0 fail**. Frontend types, server compile/build and Vite build pass.
Main chunk warning remains (about 3.72 MB / 1.06 MB gzip); no performance gain
claimed. Transcripts:
`output/announcement-publication-build30-{scoped-server,scoped-frontend,server,frontend,types,server-types,vite}.txt`.

Tests use actual routers/shared proof and hook/SSR callbacks with transactional
SQL/clock/revision fixtures. No actual DB isolation/locking/FK/collation, browser,
device, load or provider acceptance. Earlier counts are not new evidence. Known
premium-lecture regression stays tracked; unrelated full video suites were not
rerun, and the whole backend is not declared clean.

## Limits and next step

No Git/GitHub, migration application, live DB/data/provider, deployment,
installation or spending. New schema remains unapplied. Reviewed source hash
detects change rather than storing a permanent body archive; publication audit
records sanitized identity/fingerprint transitions. Review token is staleness
data, not a human-read proof or frozen recipient list. Group membership and
lesson authority remain dynamic and checked on student read. No auto-push removal
of text already displayed. Real database concurrency/query/resource performance
and browser acceptance remain separate gates. Catalog and legacy progress stay
separate; remaining J00–J10 work is not declared complete.

Next coherent slice: lesson-package template/reuse preview within the same
course, showing reference/audience conflicts before copying. Never copy student
attempts/progress/grants/publication or reset exam/enrollment allowances.
