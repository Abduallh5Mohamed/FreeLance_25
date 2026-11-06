# Business implementation — BUILD-27 — 6 November 2026

## Result

Implemented the backend binding of lesson homework to the selected student
enrollment and the existing private submission/upload engine. Mounted catalog
policy, own history, stable request recovery, create, re-authorization, finalize
and pending-upload cancellation. It is conditional local backend work: homework
metadata remains unconfigured and no student upload UI/provider is activated.

Contract: [catalog homework submissions](../streams/server/J03-CATALOG-HOMEWORK-SUBMISSIONS.md).

## Changed files

- `server/src/services/catalog-homework-access.ts`: strict private context,
  actual schema/index/ETag checks, fresh shared identity/lesson/audience proof,
  source-policy validation and exact stored-submission binding.
- `server/src/routes/assignments.ts`: mounted catalog adapter around original
  handlers, exact selected enrollment, original INSERT context/key plus audit,
  read-only receipts, matching own history, bounded admission, transactional
  revalidation, private response whitelist, uncertainty and generic-entry guard.
- `server/migrations/20261106_06_catalog_homework_context.sql`: additive JSON/key
  and unique request index **file only**, no application or historical backfill.
- `server/tests/catalog-homework.test.ts`: 25 actual-router/authority tests with
  synthetic transactional SQL, storage/scanner/cleanup ports and live proof gates.
- Current queue, README, feature matrix, strategy and linked contracts.

## Locally demonstrated behavior

Creation records context and request identity with the original row/audit.
Identical committed retry returns a receipt without another version/signature;
read-only recovery finds a committed row after a lost response. A different
file/context cannot reuse the key. Historical unbound rows remain unbound and
cannot be operated through catalog; original allowance still counts them.
Bound generic routes cannot bypass lesson locks, even after reference detach.

Actual handler tests cover source/identity/enrollment/prerequisite withdrawal,
schema/runtime/index/ETag rejection, revocation after signing and at transaction
entry, and withdrawal or deadline passage during scanning before verdict write.
Original finalize stat/signature/ETag/scan logic is reused. No scanner remains
pending_scan; only injected trusted clean scanner returns clean. Cancellation
reuses original audit/cleanup; receipt remains stable. Unknown create/finalize
commit is explicit; failed audit rolls back fixture row/audit. Concurrent starts
retain one row/audit. No automatic resubmission or lesson completion.

## Commands and evidence

Installed Node 24, no packages installed:

```powershell
$businessNode='C:/Users/BaraaWael/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe'
& $businessNode --import ./node_modules/tsx/dist/loader.mjs --import ./server/tests/helpers/isolated-io-guard.ts --test --test-reporter=spec server/tests/catalog-homework.test.ts
& $businessNode --import ./node_modules/tsx/dist/loader.mjs --import ./server/tests/helpers/isolated-io-guard.ts --test --test-reporter=spec server/tests/m4-assignments.test.ts server/tests/m4-assignment-storage.test.ts server/tests/m4-assignment-scan-worker.test.ts
$homeworkTests=@('m2-lesson-quiz-versions','student-lesson-activities','m2-lesson-activities','student-lesson-videos','m2-lesson-videos','m2-lesson-contents','m2-lesson-release','m2-student-course-access','m2-course-lessons','m2-course-lessons-reorder','m2-course-units','m2-course-publication','m2-public-course-discovery','catalog-video-session','catalog-exam-attempts','m4-exam-snapshots','m4-exam-grading','m4-assignments','m4-assignment-storage','m4-assignment-scan-worker','catalog-homework') | ForEach-Object { "server/tests/$_.test.ts" }
& $businessNode --import ./node_modules/tsx/dist/loader.mjs --import ./server/tests/helpers/isolated-io-guard.ts --test --test-reporter=spec @homeworkTests
& $businessNode ./server/node_modules/typescript/bin/tsc -p server/tsconfig.json
```

New suite: **25 pass / 0 fail**. Existing assignment/upload/scan engine suites:
**132 pass / 0 fail**. Combined catalog/proof/exam/assignment suite: **813 pass /
0 fail**, including those 157 tests; do not add overlapping counts. Server
compile/build passes. Transcripts: `output/homework-build27-{scoped,engine,server,types}.txt`.

Backend-only source changes; no new frontend count/build/browser claim. Earlier
BUILD-26 frontend evidence is not a new run. The previously documented premium
lecture regression is still open; unrelated full video tests were not rerun.

## Runtime limits and next step

No Git/GitHub, live DB/data, migration application, providers, deployment,
installation or spending. New schema remains unapplied. Existing production
composition deliberately lacks declared ETag persistence/durable cleanup ports,
so catalog uploads remain unavailable; applying the new file alone cannot turn
them on. Shared existing upload engine is retained. No actual database isolation,
concurrency/deadlock, JSON/index/collation, storage/scanner, browser/device/load
or resource performance acceptance. Fixtures serialize transactions and model
provider facts, not real delivery.

Production own-history policy reads now fail closed above 1000 versions rather
than silently dropping older versions. Current/historical context denies generic
student assignment entry; rollout therefore needs the schema/runtime and student
UI gates. Previously issued signed URLs expire on their original TTL and are
not immediately recalled by lesson withdrawal; API operations remain gated.
No historical backfill, cleanup-worker activation, multi-file submission policy,
lesson/legacy progress merge or auto-completion is introduced.

Next coherent slice: actual student homework upload/resume/finalize/cancel UI
with persisted opaque request identity, safe upload authorization handling,
honest scanner states and read-only recovery after unknown outcomes. Keep the
homework launch metadata unconfigured until that flow is wired and verified.
