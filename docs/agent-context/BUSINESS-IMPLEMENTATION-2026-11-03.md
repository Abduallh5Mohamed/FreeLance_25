# Business strategy implementation — 2026-11-03

Scope: local implementation authorized by the owner's subsequent request to plan and execute the strategy step by step. This authorization supersedes the earlier planning-only status for local work; it does not authorize Git/GitHub, live data, migration application, providers, deployments or spending. Preserve all other workspace work. Product roadmap: [22](../22-business-strategy-integration-ar.md).

## Product decisions now resolved

The owner explicitly chose:

- one lesson may contain several deliverables;
- catalog completions and legacy progress remain separate for now, and the difference must be explained to users.

These decisions do not make the old M2-B16 proposal an approved implementation contract. The actual content ownership and delivery mapping still need to be traced and specified before writing that integration. Opening a deliverable must not silently complete a lesson, migrate legacy progress, grant access or issue payment.

## Sequence and current status

| Work | Status | Result / remaining gate |
|---|---|---|
| PLAN-01: source inventory for J01–J03 | Scoped source inventory recorded below | Not an M1, production schema or provider acceptance |
| BUILD-00: lesson reorder prerequisite foundation | Implemented locally; focused and catalog regressions pass | No migration or API/DTO change; production DB not exercised |
| BUILD-01: J01 import preparation and next-action guide | Implemented locally; frontend regressions and static visual check pass | Existing import authority, matching and commit seams retained; full onboarding/group setup not completed |
| BUILD-02 / J02: owner material binding | Backend attach/list/detach implemented locally; contract recorded | Schema file unapplied; owner UI, student delivery and direct video-asset authority still pending |
| BUILD-03 / J02: owner material UI and private selector | Implemented locally; scoped component/controller/transport/backend regression and static visual checks pass | Supersedes BUILD-02's UI-pending status; schema unapplied; student delivery and direct video-asset authority still pending |
| Remaining J03–J10 | Not completed by this change | Continue within their roadmap gates; no automatic provider or finance wiring |

## PLAN-01 source evidence

| Boundary | Current source evidence | Limits |
|---|---|---|
| J01 UI | `src/pages/InstructorStudents.tsx` mounts `src/features/students/StudentImportPreview.tsx` | `src/pages/Imports.tsx` is supplier purchases, not student import; `src/features/imports/` does not exist |
| J01 client | `csv-preview.ts`, `xlsx-preview.ts`, `import-resolution.ts`, `server-resolution.ts`, `import-commit.ts`, `import-report.ts` | Six columns, 1000 records, local preview; no implicit account/enrollment/access |
| J01 HTTP | `resolveStudentImportRows` / `commitStudentImportBatch` in `src/lib/api-http.ts`; owner-scoped router under `tenant-self.ts` → `/student-import` | Distinct from the legacy `/api/student-import` CSV route; do not substitute contracts |
| J01 schema | `server/migrations/20261021_04_student_import_batches.sql` | File exists; no live schema catalog checked or migration applied |
| J02 catalog | `course-lessons.ts`, `course-units.ts`, mounted through `tenant-self.ts` | Reorder guard used a dependent's stored position even when it moved in the same batch |
| J03 path | `student-course-access.ts` mounted in `index.ts`; client controller in `student-learning-path.ts` | Path/completion metadata do not deliver bound files or videos |
| J02 progress | `course_lesson_completions` vs legacy `lesson_completions` as mapped in M2-B16 proposal | Owner chose separation; no backfill or unification performed |
| J02 asset authority | `video_assets` schema has tenant/owner but no course column | Same-tenant existence alone must not be relabeled proof of course relationship; delivery route must be checked |
| Runtime factories | `index.ts` mounts existing catalog/import/path; named notification/live/financial factories are not constructed there | This read is not proof that providers or live schema are ready |

No operator time-saving baseline was measured. The visual check below uses synthetic states only and is not a field trial or full authenticated browser journey.

## BUILD-00 — final-state lesson reorder

- `proveDependentOrder` now takes the dependent's position from the same canonical final-order map if it moved, otherwise its stored position.
- A prerequisite/dependent move from 1/2 to 5/6 succeeds in both payload orders and audits both changes.
- Moving them to 6/5 returns 409 before UPDATE, audit or commit, leaving both stored positions unchanged.
- The valid-case regression was first run against the previous implementation: 409 instead of 200 (one fail, one pass). After the correction, both focused tests passed. The existing unmoved-dependent and bounded-set refusals remain covered.

## BUILD-01 — guided import preparation

New production modules:

- `src/features/students/import-guide.ts`: presentation-only next-action model and a header-only UTF-8 BOM CSV template derived from the parser's supported columns.
- `src/features/students/StudentImportGuide.tsx`: four RTL steps, a downloadable blank template, live next-action wording and navigation to existing sections.

`StudentImportPreview.tsx` supplies the live preview, evaluated commit gate, matching availability/state and confirmed result. The guide creates no controller, request, storage entry, identity, group assignment, enrollment or financial write. A confirmed import disables redundant confirmation in the panel; the underlying idempotency/retry protocol is unchanged.

Behaviors covered: missing/empty/refused/reading file, pending/invalid decisions, unavailable/failed/stale/matched reconciliation, explicit confirmation, uncertain and malformed outcomes, confirmed student-record-only success, and reset back to file preparation. The component test renders the real panel with its existing seams and verifies the guide follows its actual gate without sending a request.

The blank template contains only `name,email,phone,guardian_phone,grade,barcode` and a line ending. No demo student, personal data, formulas or raw source filename is included. The parser round-trip checks the six supported headers and zero records. A Chromium check downloaded the actual link and verified its bytes after removing the BOM.

## Verification

Runtime for scoped runs: installed `C:/Users/BaraaWael/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe`, **v24.19.0**. No runtime or package was downloaded. CI's pinned Node version is unchanged; no result below is a claim about all Node versions.

Common test invocation prefix (repository root):

```powershell
$businessNode = 'C:/Users/BaraaWael/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe'
```

Frontend — **438 pass / 0 fail**:

```powershell
& $businessNode --import ./node_modules/tsx/dist/loader.mjs --test --test-reporter=spec src/tests/business-student-import-guide.test.ts src/tests/m2-student-csv-preview.test.ts src/tests/m2-student-xlsx-preview.test.ts src/tests/m2-student-import-resolution.test.ts src/tests/m2-student-import-server-resolution.test.ts src/tests/m2-student-import-commit.test.ts src/tests/m2-student-learning-path.test.ts
```

Backend, with outbound I/O and listeners blocked — **398 pass / 0 fail**:

```powershell
& $businessNode --import ./node_modules/tsx/dist/loader.mjs --import ./server/tests/helpers/isolated-io-guard.ts --test --test-reporter=spec server/tests/m2-lesson-release.test.ts server/tests/m2-course-lessons.test.ts server/tests/m2-course-lessons-reorder.test.ts server/tests/m2-course-units.test.ts server/tests/m2-course-publication.test.ts server/tests/m2-public-course-discovery.test.ts server/tests/m2-public-catalog-composition.test.ts server/tests/m2-student-course-access.test.ts server/tests/m2-student-import-commit.test.ts server/tests/m2-student-import-commit-failures.test.ts
```

The first broader server run had 397 pass / 1 fail in an existing safety assertion that searched a whole serialized record for the unrelated three-character hex fragment `07f`. Such a fragment can occur in a UUID or digest. The test now checks the actual submitted phone and the exact seven allowed batch keys. No production import protection was changed to accommodate it; the corrected broader run passed.

Type/build commands (final results recorded after execution):

```powershell
& $businessNode ./node_modules/typescript/bin/tsc -p tsconfig.app.json --noEmit
& $businessNode ./server/node_modules/typescript/bin/tsc -p server/tsconfig.json
& $businessNode ./node_modules/vite/bin/vite.js build
```

Both type/build checks passed in the scoped run. Vite build passed with its large-chunk warning; no application performance improvement is inferred from a successful build.

Static visual check: real guide component rendered with React's server renderer and the built CSS, then viewed in local headless Chromium at 390 and 1024 pixels. One current step, working section navigation, actual header-only CSV download, and no horizontal overflow. No authenticated app navigation, database, provider, network request or listener was needed. Screenshots are local temporary review artifacts.

## Next local work

Continuation 2026-11-04: [BUILD-04 and remaining sequence](BUSINESS-IMPLEMENTATION-2026-11-04.md)
now provide student material metadata visibility with full scoped revalidation.
Private file/video delivery remains unavailable; the older next-step wording
below describes the handoff before that continuation.

BUILD-02/03 implement owner-only material binding, picker and editor under [their bounded contract](../streams/server/J02-LESSON-MATERIAL-BINDING-CONTRACT.md). Continue with student delivery revalidation. Direct video assets still need course authority. Keep legacy progress separate. External schema application and provider activation remain separately authorized gates.

## BUILD-02 — owner-only material binding backend

Changed source: `server/src/routes/course-lessons.ts`; added schema file
`server/migrations/20261103_01_course_lesson_contents.sql`, tests
`server/tests/m2-lesson-contents.test.ts`, and the J02 contract linked above.
Existing `tenant-self.ts` mounting is reused; no new adapter/provider mount.

Proven locally: several same-course materials, sorted fixed DTO without URLs,
20-reference limit, duplicate no-op, position/source conflicts, foreign source
refusal, owner/course/unit/lesson/schema denials, billing-only denial before
connection, scoped deletion, atomic audit rollback, uncertain-commit discard,
rollback-failure discard and real mount/auth ownership denial for all verbs.
No frontend change in BUILD-02. No student content delivery, automatic completion,
old-progress merging, provider activation or applied schema is claimed.

Initial server typecheck caught `Object.hasOwn` being outside the configured
TypeScript library; replaced it with `Object.prototype.hasOwnProperty.call`
without changing the target or packages. Final validation is recorded below.

BUILD-02 exact validation commands (repository root, the installed Node v24.19.0
path assigned to `$businessNode` as above):

```powershell
& $businessNode --import ./node_modules/tsx/dist/loader.mjs --import ./server/tests/helpers/isolated-io-guard.ts --test --test-reporter=spec server/tests/m2-lesson-contents.test.ts
& $businessNode --import ./node_modules/tsx/dist/loader.mjs --import ./server/tests/helpers/isolated-io-guard.ts --test --test-reporter=spec server/tests/m2-lesson-contents.test.ts server/tests/m2-lesson-release.test.ts server/tests/m2-course-lessons.test.ts server/tests/m2-course-lessons-reorder.test.ts server/tests/m2-course-units.test.ts server/tests/m2-course-publication.test.ts server/tests/m2-public-course-discovery.test.ts server/tests/m2-public-catalog-composition.test.ts server/tests/m2-student-course-access.test.ts
& $businessNode ./server/node_modules/typescript/bin/tsc -p server/tsconfig.json
```

Focused suite: **26 passed, 0 failed**. Final combined backend regression run:
**351 passed, 0 failed** (includes the 26 focused tests; not additive). Server
TypeScript build: **exit 0**. Regression output saved locally to
`tmp/j02-owner-binding-tests.log`. Frontend was unchanged and was not rebuilt or
retested for BUILD-02. Earlier frontend results in this document belong to
BUILD-00/01, not a new full-project acceptance.

Changed documentation: this record, README routing, FEATURE_MATRIX, roadmap 22,
the M2-B16 historical proposal's follow-up pointer, and the new J02 contract.
No Git/GitHub, live database, migration application, package installation,
provider or deployment was used.

## BUILD-03 — owner material picker and editor

Production changes:

- `src/features/catalog/LessonContentManager.tsx` (new): collapsed per-lesson
  entry, owner editor, material picker, position input, source paging and explicit
  detach confirmation. Mounted in `CourseLessonManager.tsx`, reachable through
  the existing Courses → units → lessons UI. No requests per closed lesson.
- `src/features/catalog/lesson-contents.ts` (new): strict DTO parsers and actual
  controller used by the editor; single flight, lifetime/session fences, private
  state clearing, confirmed-save/failed-refresh and uncertain-write handling.
- `src/lib/api-http.ts`: four canonical transport functions. Strict attach body,
  existing authenticated request helper, no client tenant/owner selector.
- `server/src/routes/course-lessons.ts`: private owner-only material selector
  under `/contents/available-materials`; bounded 25-row keyset pages, draft
  labels, no URL fields, same parent/owner/schema checks as the contents routes.
- `src/tests/lesson-contents.test.ts` (new) and
  `server/tests/m2-lesson-contents.test.ts` (extended).

The existing migration file was not changed or applied in BUILD-03. No provider,
real database, deployment, package install, student delivery or progress merge.
The interface honestly reports unavailable when the required schema is absent;
UI source presence does not make database-backed binding ready in an environment.

Behavioral evidence includes strict DTO refusal (extra URL keys, malformed IDs,
duplicate/unsorted/oversized lists, cursor regressions), invalid positions before
request, single-flight submission, definite conflict vs unknown result, successful
save with failed refresh, explicit reconciliation, source paging/reload failures,
session change including A→B→A, disposal, bound form fields and detach confirmation.
One component lifecycle test runs the real editor effect/controller and canonical
HTTP functions with synthetic fetch/storage, proves its exact bound paths and
POST→refresh sequence, then sends the actual session notifier to clear the editor.

Installed runtime: the same Node **v24.19.0** path above. Exact commands:

```powershell
& $businessNode --import ./node_modules/tsx/dist/loader.mjs --test --test-reporter=spec src/tests/lesson-contents.test.ts
& $businessNode --import ./node_modules/tsx/dist/loader.mjs --test --test-reporter=spec src/tests/lesson-contents.test.ts src/tests/m2-course-lesson-ui.test.ts src/tests/m2-course-unit-ui.test.ts src/tests/m2-student-learning-path.test.ts
& $businessNode --import ./node_modules/tsx/dist/loader.mjs --import ./server/tests/helpers/isolated-io-guard.ts --test --test-reporter=spec server/tests/m2-lesson-contents.test.ts server/tests/m2-lesson-release.test.ts server/tests/m2-course-lessons.test.ts server/tests/m2-course-lessons-reorder.test.ts server/tests/m2-course-units.test.ts server/tests/m2-course-publication.test.ts server/tests/m2-public-course-discovery.test.ts server/tests/m2-public-catalog-composition.test.ts server/tests/m2-student-course-access.test.ts
& $businessNode ./node_modules/typescript/bin/tsc -p tsconfig.app.json --noEmit
& $businessNode ./server/node_modules/typescript/bin/tsc -p server/tsconfig.json
& $businessNode ./node_modules/vite/bin/vite.js build
& $businessNode --import ./node_modules/tsx/dist/loader.mjs tmp/j02-content-visual.cjs
```

Results: focused frontend **31 pass / 0 fail**; combined frontend **224 pass /
0 fail**, including those 31. Combined backend **353 pass / 0 fail**, including
the **28** lesson-content tests (two new selector cases). Both TypeScript checks
passed. Vite build passed, retaining the large-chunk warning (main JS about
3.54 MB before gzip); no measured performance improvement is claimed.

Static visual QA rendered the real editor with built CSS and synthetic hook
states: ready with draft picker/detach confirmation, confirmed save with stale
list, and unavailable. Local Chromium at 390 and 1024 pixels showed no horizontal
overflow and no unbound labels; the 390px screenshot was visually inspected.
The fixture blocks HTTP(S), starts no listener and does not test an authenticated
browser journey. Local evidence: `tmp/j02-content-{390,1024}.png`,
`tmp/j02-content-preview.html`, `tmp/j02-content-ui-regression.log`,
`tmp/j02-content-backend-regression.log`, `tmp/j02-content-ui-build.log`.

The first frontend typecheck exposed a narrowing issue on an `unknown` cursor;
the validated cursor now uses a local string/null value. A new lifecycle test
initially notified the ESM test module instead of the CommonJS instance loaded
by its component harness; corrected to notify the component's actual module.
Neither correction weakened the assertions or changed shared session behavior.

Current scope/status documentation updated alongside code: this record, README,
FEATURE_MATRIX, strategy 22, the J02 contract and the historical M2-B16 pointer.
