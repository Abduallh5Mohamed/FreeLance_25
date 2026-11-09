# BUILD-35 — current lesson preparation evidence for the owner

7 November 2026. Direct Codex implementation under the owner's continuing request.
The Windows schedule remains disabled as requested; no worker was restarted.
This is a partial J05 journey, not full J05 or independent/production acceptance.

## What the teacher can do

Inside the open course-details dialog, select a unit and lesson using the bounded
existing picker. The new panel checks the selected lesson's actual reference
sources, draft states, restricted audiences and explicit quiz version. Each issue
has a concrete next step and an evidence button that re-reads current authorized
facts. A withdrawn/removed source cannot retain its former title as current evidence.

The teacher can mark a signal useful/dismissed and type a correction. These are
clearly marked memory-only drafts, cleared on refresh/context/session changes.
Nothing is published, delivered, granted, graded, messaged or persisted by this
journey. This has not yet been measured as saving field preparation time.

The panel explicitly states insufficient evidence for weak concept rankings,
recurring questions, absence or individual student needs. Current source review
did not establish a validated group/period concept-to-result model. Existing
legacy progress-report aggregation is not silently treated as catalog concept
evidence, and temporary/manual/unpublished scores are not learner diagnoses.

## Changed files and runtime architecture

- `server/src/routes/lesson-preparation.ts` (new): injected private GET route,
  live owner/caller/course/exact unit-lesson proof on one connection; strict
  selectors, no-store, bounded shared binding/source reads and existing quiz-pin
  verification. Fixed DTO without source IDs, bodies, URLs, questions, grades,
  contacts or student/group identities. All SELECT; no write/audit/commit.
- `server/src/routes/tenant-self.ts`: mounts the new router after auth under
  the existing `/catalog` prefix. It has no fallback to a public/legacy reader.
- `src/features/catalog/lesson-preparation.ts` (new): exact context-bound response
  validation, server-rule consistency, canonical authenticated reader, supersession,
  25-second deadline, session/principal fences, fresh evidence and local decisions.
- `src/features/catalog/LessonPreparation.tsx` (new): actual picker/panel,
  deterministic issues and actions, insufficient-evidence state, fresh evidence
  view, local editorial drafts, Cairo timestamps, event/storage cleanup and
  outer-picker hiding when the selected child's identity is invalidated.
- `src/pages/Courses.tsx`: mounts the keyed preparation journey only in open
  course details next to existing unit/template management.
- `server/tests/helpers/lesson-package-fixture.ts` (new extraction): moved the
  existing template transactional fixture into a reusable helper, preserving
  snapshot/rollback/lost-ACK semantics; extended explicit read fixtures for lesson
  preparation and quiz-version schema/data. Original template tests still execute.
- `server/tests/lesson-package-templates.test.ts`: imports the shared fixture;
  no original behavior assertions removed.
- `server/tests/lesson-preparation.test.ts` (new): 19 route tests, owner/tenant/
  course/unit/lesson/selector boundaries, fixed privacy DTO, all five reference
  kinds, unavailable sources, empty data, quiz pins, audiences, missing schema,
  corrupt/overflow sets and rollback failure/discard. The harness observes cleanup
  after the response instead of assuming `json()` awaits route `finally`.
- `src/tests/lesson-preparation.test.ts` (new): 9 parser/controller/actual mounted
  panel tests with canonical synthetic HTTP. Covers escaped text, evidence reads,
  no mutation for local choices, stale/failed refresh, deadlines and identity/
  storage/disposal fences.

Contracts: [server](../streams/server/J05-LESSON-PREPARATION.md),
[client](../streams/client/J05-LESSON-PREPARATION.md). Queue, README, feature matrix,
handover and supervision note now record partial J05 and the stopped schedule.
Old WorkBuddy reserved paths were not edited; unrelated local work was preserved.

## Rules and boundaries proved

Source issue priority is unavailable source, missing/unavailable published quiz
version, draft, restricted audience, then no issue. One issue per reference; no
issue is not readiness. At most 20 mixed media plus one homework, quiz and notice.
Missing supporting schema yields unavailable; malformed stored sets fail closed.
Fresh evidence reloads the same owner-scoped endpoint and discards old decisions.

Read-only transactions use the existing preparation/source lock protocol, rollback
on every path, never commit, and discard on errors/failed cleanup. These locks
and all schema checks still require real MySQL acceptance; the local fixture is
not production concurrency or query-performance proof. The route returns no group/
period analytics and rejects those selectors rather than ignoring them.

## Commands and results

Repository root; installed compatible Node v24.19.0; no installation. Final scoped
backend/full frontend/type/build commands exited 0. Logs under `output/build35-*`.

```powershell
$businessNode='C:/Users/BaraaWael/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe'
& $businessNode --import ./node_modules/tsx/dist/loader.mjs --import ./server/tests/helpers/isolated-io-guard.ts --test --test-reporter=spec server/tests/lesson-preparation.test.ts server/tests/lesson-package-templates.test.ts server/tests/lesson-package-reuse.test.ts server/tests/lesson-package-timing.test.ts server/tests/m2-course-units.test.ts server/tests/m2-course-lessons.test.ts server/tests/m2-course-lessons-reorder.test.ts server/tests/m2-lesson-release.test.ts server/tests/m2-public-catalog-composition.test.ts
$frontendTests=@(Get-ChildItem src/tests/*.test.ts | ForEach-Object {$_.FullName}) + @('src/auth/access-control.test.ts')
& $businessNode --import ./node_modules/tsx/dist/loader.mjs --test --test-reporter=spec @frontendTests
& $businessNode ./node_modules/typescript/bin/tsc -p tsconfig.app.json --noEmit
& $businessNode ./server/node_modules/typescript/bin/tsc -p server/tsconfig.json
& $businessNode ./node_modules/vite/bin/vite.js build
```

| Check | Result | Log |
|---|---|---|
| Listed backend suites | 321 pass / 0 fail | `output/build35-backend.log` |
| Full frontend command above | 2146 pass / 0 fail | `output/build35-frontend.log` |
| Frontend types | pass | `output/build35-client-types.log` |
| Server compilation | pass | `output/build35-server-types.log` |
| Vite | pass, existing large-chunk warning | `output/build35-vite.log` |

Main chunk about 3,789 kB minified / 1,077 kB gzip remains a performance concern,
not measured client latency. The documented premium-lecture backend failure was
not fixed/reclassified; the whole backend is not declared green. Final UI copy
removes the internal rule-version label; rule text and contract are unchanged.

## Remaining

J05 needs validated educational signals tied to concept/question evidence, scoped
group/period and current assignment authority, recurring questions, and field
usefulness/time measurement. Persisting editorial drafts needs its own reviewed
contract; currently no durable feedback claim. J01/J03/J04/J06/J07/J08/J10 and optional
J09 remain tracked in the queue, not implicitly complete from this panel.

No Git/GitHub, live DB, migrations, providers, deployment, package install, external
AI, messages, real browser/device/load or performance measurement occurred. No
schedule/pending-marker restart or cleanup was performed during this manual request.
