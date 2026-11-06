# Business implementation — BUILD-25 — 6 November 2026

## Result and scope

Implemented the backend catalog-bound student quiz lifecycle using the existing
exam-version timing/grading engine: explicit start, pure recovery, reading own
saved answers, autosave and submit with fresh lesson/source/pin authority.
This is local backend evidence, not whole-strategy completion or production
acceptance. Student launch UI/metadata remain unconfigured.

Contract: [J03-CATALOG-EXAM-ATTEMPTS](../streams/server/J03-CATALOG-EXAM-ATTEMPTS.md).

## Changed files

- `server/src/services/catalog-exam-access.ts`: durable-context validation,
  actual schema/index checks, bounded frozen-snapshot fingerprint, current
  catalog/audience proof, private saved-draft recovery and server settlement proof.
- `server/src/routes/exam-versions.ts`: actual catalog GET/POST start/recovery,
  context in original INSERT/audit, exact selected enrollment, original attempt
  allowance, read/save/submit guards, uncertainty responses, no-store headers,
  JSON scalar decoding and expiry/regrade snapshot checks.
- `server/src/routes/exams.ts`: production legacy-entry guard for bound exams,
  including encoded resource selectors.
- `server/src/services/student-lesson-audience.ts` and
  `server/src/services/student-lesson-activities.ts`: optional locking current
  reads for transactional proof; ordinary metadata/video reads keep defaults.
- `server/migrations/20261106_05_catalog_exam_attempt_context.sql`: additive
  nullable JSON column file only; no application or historical backfill.
- `server/tests/catalog-exam-attempts.test.ts`: 28 actual-handler/authority tests.
- `server/tests/helpers/student-activity-fixture.ts` and
  `server/tests/student-lesson-activities.test.ts`: extracted shared synthetic
  fixture; original activity coverage retained.
- Maintained queue, README, feature matrix, strategy and predecessor contracts.

## Behavior demonstrated locally

The exact selected enrollment and saved published pin decide the attempt's
context, on its original insert. Start/retry retains one exam/enrollment attempt
and one creation audit. GET recovery never creates or settles an attempt. Old
unbound attempts are not backfilled; another lesson/version cannot reset the
allowance. Changed snapshot content/timing/scoring cannot replace the fingerprint
captured at start. Catalog/private context and answer keys stay out of student
responses; only bounded own answers are returned.

Withdrawal, prerequisite lock, enrollment/user deactivation and changed pin deny
subsequent student read/save/submit. Tests include changes while acquiring
questions and at transaction entry. Save/submit reuse original grading and audit;
lost creation/save/submit commit acknowledgements remain explicitly uncertain
and recoverable by reading server state when still authorized. Failed insert or
audit rolls back fixture mutations. Generic versioned and legacy exam entries
cannot bypass the current catalog boundary. Existing legacy/manual grading
tests remain green. Server settlement after withdrawal still requires the
original frozen snapshot; it does not require a revoked student to regain access.

## Verification

Installed Node 24 was used; no packages installed. Commands run from repository
root (`$businessNode` is the installed executable below):

```powershell
$businessNode='C:/Users/BaraaWael/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe'
$catalogTests=@('m2-lesson-quiz-versions','student-lesson-activities','m2-lesson-activities','student-lesson-videos','m2-lesson-videos','m2-lesson-contents','m2-lesson-release','m2-student-course-access','m2-course-lessons','m2-course-lessons-reorder','m2-course-units','m2-course-publication','m2-public-course-discovery','catalog-video-session','catalog-exam-attempts') | ForEach-Object { "server/tests/$_.test.ts" }
& $businessNode --import ./node_modules/tsx/dist/loader.mjs --import ./server/tests/helpers/isolated-io-guard.ts --test --test-reporter=spec @catalogTests
& $businessNode --import ./node_modules/tsx/dist/loader.mjs --import ./server/tests/helpers/isolated-io-guard.ts --test --test-reporter=spec server/tests/catalog-exam-attempts.test.ts server/tests/m4-exam-snapshots.test.ts server/tests/m4-exam-grading.test.ts
& $businessNode --import ./node_modules/tsx/dist/loader.mjs --import ./server/tests/helpers/isolated-io-guard.ts --test --test-reporter=spec server/tests/m1-sprint-exam-boundary.test.ts server/tests/m4-exam-manual-grading.test.ts server/tests/exam-manual-grading-sql.test.ts
& $businessNode ./server/node_modules/typescript/bin/tsc -p server/tsconfig.json
```

Catalog/proof: **572 pass / 0 fail**. New attempt plus existing snapshot/grading:
**112 pass / 0 fail** (the same 28 new tests also appear in the catalog run; do
not add totals as distinct tests). Legacy boundary/manual grading: **64 pass /
0 fail**. Server compile/build passed. Transcripts are
`output/catalog-attempt-build25-{server,engine,legacy,types}.txt`.

No frontend source change or frontend/browser run in this slice; older frontend
counts are not new evidence. The previously documented premium-lecture test
failure from BUILD-20/21 remains open; the full video suite was not rerun.

## Limits and next step

No Git/GitHub, migration application, live DB/data/provider, deployment, package
installation or spending. Real schema/FKs/JSON/locking/deadlocks/concurrency,
query/load/resource performance and device/browser acceptance remain open.
Fixtures serialize transactions; they do not establish actual isolation.
Context-column removal/backfill is not implemented. Changed/archived snapshots
can block server settlement and require review. Repeated bounded snapshot proof
cost has not been measured. Homework submission, other J00–J10 journeys and
external gates remain incomplete; progress ledgers remain separate.

Next coherent slice: actual catalog quiz start/resume/answer/save/submit UI,
strict responses and recovery after uncertain writes, with server deadlines,
workspace/session fences and withdrawal handling; no legacy redirect. Keep
launch metadata unconfigured until that student flow is wired and verified.
