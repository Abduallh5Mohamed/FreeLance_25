# Business implementation — BUILD-28 — 6 November 2026

## Result

Implemented the actual student lesson-homework panel: policy/history/recovery,
file picker, explicit keyed preparation, signed upload, authorization refresh,
verification/scanning, pending-version cancellation and new-version policy check.
Homework metadata now advertises `submission_required`, a fresh-proof candidate.
Default backend upload gates remain closed; no live readiness is claimed.

Contract: [student catalog homework](../streams/client/J03-STUDENT-CATALOG-HOMEWORK.md).

## Changed files

- `src/features/catalog/catalog-homework-api.ts`: strict policy/receipt/history/
  authorization/verification parsers, authenticated catalog API and isolated
  bearer-free/cookie-free signed PUT/POST transfer.
- `src/features/catalog/catalog-homework.ts`: scoped opaque request storage,
  workspace/auth incarnation proof, single-flight lifecycle, explicit recovery,
  local file bounds, timeout retirement and private in-memory file/authorization.
- `src/features/catalog/StudentCatalogHomework.tsx`: mounted RTL picker/actions,
  exact state labels, original limits/deadline, cancel confirmation, existing
  version selection and beforeunload warning.
- `src/features/catalog/StudentLessonActivities.tsx` and
  `src/features/catalog/student-lesson-activities.ts`: mount only the correct
  homework candidate, with old unconfigured compatibility and unchanged quiz flow.
- `server/src/services/student-lesson-activities.ts`: candidate metadata only;
  no upload runtime, scanner, deadline, limit, grade or progress policy change.
- `src/tests/catalog-homework-ui.test.ts`: 24 new tests.
- `src/tests/student-lesson-activities.test.ts` and
  `server/tests/student-lesson-activities.test.ts`: candidate contract coverage.
- Current queue, README, matrix, strategy and linked server/client contracts.

## Locally demonstrated behavior

Mount performs only reads. Request key is stored before creation; blocked
storage prevents POST. File/authorization remain in memory and source IDs or
private payload fields fail strict parsers. Storage transfer uses no app bearer,
cookies, redirect or referrer; signed multipart fields are bounded. Transfer
success is distinct from API verification and clean scan. Pending_scan is never
shown as clean, and quarantine is its own confirmed state.

Unknown create/transfer/finalize/cancel outcome cannot be automatically replayed.
Read-only recovery keeps request identity; a missing receipt is not treated as
rollback. Same-key retry is deliberate, with original metadata frozen in memory.
Scope/auth/workspace/ABA/disposal and late timeout replies cannot restore a
private file, receipt or authorization. Cancel keeps its receipt; a new version
requires explicit fresh policy and safe pointer cleanup. No legacy redirect,
extra attempt allowance, completion or local grade is introduced.

## Verification

Installed Node 24; no packages installed:

```powershell
$businessNode='C:/Users/BaraaWael/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe'
& $businessNode --import ./node_modules/tsx/dist/loader.mjs --test --test-reporter=spec src/tests/catalog-homework-ui.test.ts src/tests/student-lesson-activities.test.ts
$frontendTests=@(Get-ChildItem src/tests/*.test.ts | ForEach-Object {$_.FullName}) + @('src/auth/access-control.test.ts')
& $businessNode --import ./node_modules/tsx/dist/loader.mjs --test --test-reporter=spec @frontendTests
$homeworkTests=@('m2-lesson-quiz-versions','student-lesson-activities','m2-lesson-activities','student-lesson-videos','m2-lesson-videos','m2-lesson-contents','m2-lesson-release','m2-student-course-access','m2-course-lessons','m2-course-lessons-reorder','m2-course-units','m2-course-publication','m2-public-course-discovery','catalog-video-session','catalog-exam-attempts','m4-exam-snapshots','m4-exam-grading','m4-assignments','m4-assignment-storage','m4-assignment-scan-worker','catalog-homework') | ForEach-Object { "server/tests/$_.test.ts" }
& $businessNode --import ./node_modules/tsx/dist/loader.mjs --import ./server/tests/helpers/isolated-io-guard.ts --test --test-reporter=spec @homeworkTests
& $businessNode ./node_modules/typescript/bin/tsc -p tsconfig.app.json --noEmit
& $businessNode ./server/node_modules/typescript/bin/tsc -p server/tsconfig.json
& $businessNode ./node_modules/vite/bin/vite.js build
```

Scoped frontend: **37 pass / 0 fail**, included in full frontend **2017 pass /
0 fail**. Backend catalog/proof/exam/upload/scan suites: **813 pass / 0 fail**.
Frontend typecheck, server compile/build and Vite build pass. Large main-chunk
warning remains (about 3.69 MB / 1.05 MB gzip); no performance improvement claimed.
Transcripts: `output/homework-ui-build28-{scoped,frontend,server,types,server-types,vite}.txt`.

Tests use actual effects/callbacks with hook/SSR and synthetic fetch fixtures,
synthetic signed targets and transactional SQL. No actual browser or provider
was exercised. Earlier counts are not reused as new evidence. The previously
documented premium-lecture regression remains open; full unrelated video suite
was not rerun and the whole backend is not declared green.

## Limits and next step

No Git/GitHub, migration application, live DB/data, providers, deployment,
installation or spending. New schema remains unapplied. Existing composition
still lacks declared ETag/durable cleanup ports; UI cannot turn them on. Missing
scanner is pending, never clean. Real database isolation, storage/scanner/CORS,
browser/device and query/load/resource performance acceptance remain open.
Cross-origin HTTP storage is rejected; approved TLS/proxy setup is needed.
Files are not persisted or resumed by byte offset. Same metadata does not prove
same file bytes. sessionStorage pointer is per tab and beforeunload is not a full
SPA navigation blocker. Previously issued capabilities keep their original TTL.
Catalog and legacy progress stay separate; J02/J03 remain partial journeys.

Next coherent slice: lesson announcement and audience/publish preview, using
existing announcement/notification boundaries; no real delivery activation.
