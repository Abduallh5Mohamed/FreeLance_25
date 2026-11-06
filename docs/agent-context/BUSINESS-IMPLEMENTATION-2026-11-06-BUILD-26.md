# Business implementation — BUILD-26 — 6 November 2026

## Result

Implemented the actual student catalog quiz UI inside authorized lesson activity
details: explicit start, resume, all four question kinds, answer clears,
debounced/explicit save, deliberate final submission and current server status.
The existing BUILD-25 backend remains authoritative. Metadata now describes quiz
launch as `attempt_required`, not as unconditional availability; homework stays
unconfigured. This completes a local quiz interaction slice, not J02/J03 or the
whole strategy. Schema/database/browser/load acceptance remains pending.

Contract: [student catalog quiz](../streams/client/J03-STUDENT-CATALOG-QUIZ.md).

## Changed files

- `src/features/catalog/catalog-quiz.ts`: strict DTO/answer parsers, canonical
  authenticated no-store transport and session-fenced single-flight controller.
- `src/features/catalog/StudentCatalogQuiz.tsx`: actual RTL answer controls,
  server deadline, two-second autosave debounce, explicit save, final review
  confirmation, recovery and honest manual-review/terminal/unavailable states.
- `src/features/catalog/StudentLessonActivities.tsx`: mounted keyed quiz panel
  inside authorized details; homework remains a separate unfinished journey.
- `src/features/catalog/student-lesson-activities.ts`: strict quiz candidate
  status parser, with compatibility for previous unconfigured responses.
- `server/src/services/student-lesson-activities.ts`: quiz candidate list/detail
  metadata only; no new attempt grants or engine/timing/grading policy changes.
- `src/tests/catalog-quiz.test.ts`: 22 new parser/controller/transport/TSX tests.
- `src/tests/student-lesson-activities.test.ts` and
  `server/tests/student-lesson-activities.test.ts`: metadata contract coverage.
- Current execution queue, README, matrix, strategy and linked contracts.

## Demonstrated behavior

Opening details only reads recovery; the start POST requires explicit choice.
Resumption reads the student's own persisted responses. Writes copy the entire
canonical answer map including null clears and prevent concurrent submission.
Strict acknowledgements precede saved/submitted messages. An unknown write
outcome stops replay; explicit recovery preserves differing local edits without
rearming autosave. Confirmed start/submit followed by failed detail read is not
reported as a failed write. Revocation/session/workspace changes retire private
state; old responses cannot restore it. No legacy redirect or new attempt after
a known/terminal attempt. No answer key, local grading or completion grant.

## Commands and results

Installed Node 24; no package installation:

```powershell
$businessNode='C:/Users/BaraaWael/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe'
& $businessNode --import ./node_modules/tsx/dist/loader.mjs --test --test-reporter=spec src/tests/catalog-quiz.test.ts src/tests/student-lesson-activities.test.ts
$frontendTests=@(Get-ChildItem src/tests/*.test.ts | ForEach-Object {$_.FullName}) + @('src/auth/access-control.test.ts')
& $businessNode --import ./node_modules/tsx/dist/loader.mjs --test --test-reporter=spec @frontendTests
$catalogTests=@('m2-lesson-quiz-versions','student-lesson-activities','m2-lesson-activities','student-lesson-videos','m2-lesson-videos','m2-lesson-contents','m2-lesson-release','m2-student-course-access','m2-course-lessons','m2-course-lessons-reorder','m2-course-units','m2-course-publication','m2-public-course-discovery','catalog-video-session','catalog-exam-attempts','m4-exam-snapshots','m4-exam-grading') | ForEach-Object { "server/tests/$_.test.ts" }
& $businessNode --import ./node_modules/tsx/dist/loader.mjs --import ./server/tests/helpers/isolated-io-guard.ts --test --test-reporter=spec @catalogTests
& $businessNode ./node_modules/typescript/bin/tsc -p tsconfig.app.json --noEmit
& $businessNode ./server/node_modules/typescript/bin/tsc -p server/tsconfig.json
& $businessNode ./node_modules/vite/bin/vite.js build
```

Scoped frontend: **34 pass / 0 fail** (included in full frontend).
Full frontend: **1992 pass / 0 fail**. Backend catalog/proof plus original
snapshot/grading: **656 pass / 0 fail**. Frontend typecheck, server compile/build
and Vite build pass. The large main-chunk warning remains; no performance
improvement is claimed. Transcripts:
`output/catalog-quiz-build26-{scoped,frontend,server,types,server-types,vite}.txt`.

Tests use synthetic transactional SQL, hook/SSR fixtures and synthetic fetch.
The actual mounted effects and callbacks are exercised, not an actual browser
or live database. Earlier counts are not new evidence. The previously tracked
premium-lecture regression remains open; its full video suite was not rerun.

## Remaining limits and next work

No Git/GitHub, live DB/data, migration application, provider, deployment, spending
or packages. All new schema files remain unapplied. No real isolation/deadlock,
query/resource/load or device/browser acceptance. In-memory local edits are lost
when the panel closes/reloads; only confirmed server responses can be resumed.
Beforeunload warning is not a complete SPA navigation blocker. The existing
engine has no new per-answer multi-tab conflict revision policy in this slice.
Autosave locks editing during its single request. Metadata can expose a candidate
whose pin/schema still fails fresh proof; this is shown as unavailable/denied,
never sent to a generic exam route. Catalog/legacy progress stay separate.

Next coherent slice: assess and implement homework submission binding to the
exact lesson reference and selected enrollment with existing private upload/scan
rules, then its student UI. Other lesson-package work and J00–J10 remain open.
