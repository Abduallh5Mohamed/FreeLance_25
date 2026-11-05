# Business implementation — 2026-11-04, BUILD-04/05

Continuation: [BUILD-06, 2026-11-05](BUSINESS-IMPLEMENTATION-2026-11-05.md) now
adds the conditional owner ingestion/scan producer and UI. Default real adapters
remain unconfigured and schema unapplied. This record preserves earlier evidence.

Continues the owner's authorization to implement the strategy locally, step by
step. Prior completed local slices: [2026-11-03 record](BUSINESS-IMPLEMENTATION-2026-11-03.md).
This record does not accept the whole business plan or authorize external work.
No Git/GitHub, live DB, schema application, provider, deployment or installation.

## Result and remaining boundary

The student can explicitly expand an accessible catalog lesson to see materials
that are currently published, assigned to their enrollment's group and allowed
by the existing branch policy. The server rechecks lesson/course/enrollment
authority on every read, and withholds private titles when a check fails.

The UI explains the owner's resolved decision: catalog completion is temporarily
separate from the old content progress ledger. Reading the material list causes
no completion, access grant, payment, audit mutation or provider operation.

**Metadata visibility only:** every visible material reports opening unavailable.
No legacy `file_url` is returned and no play/download/link control is fabricated.
Legacy files do not yet have a proven catalog material relationship/scanner
verdict; video assets do not have course authority. These are delivery gaps,
not grounds to silently broaden legacy storage authorization.

Controlling contract: [student material visibility](../streams/server/J03-STUDENT-LESSON-MATERIALS-CONTRACT.md).
The binding schema remains the unapplied file from BUILD-02; no migration was
authored, changed or applied in this batch. Missing schema is displayed honestly.

## Changed files

| File | Change |
|---|---|
| `server/src/routes/student-course-access.ts` | Separate contents GET under the already-mounted student router; strict request, enrollment/course/release/prerequisite checks |
| `server/src/services/student-lesson-materials.ts` (new) | Bounded schema/binding/group/branch proof; explicit private DTO; existing resource-branch policy over prefetched rows |
| `server/tests/m2-student-course-access.test.ts` | Real route/auth-chain tests plus synthetic bulk fixture; route inventory updated to include the new read |
| `src/lib/api-http.ts` | One canonical authenticated student read, no authority selector |
| `src/features/catalog/student-lesson-contents.ts` (new) | Strict lesson-bound DTO parser and single-flight read controller with lifetime fences |
| `src/features/catalog/StudentLessonMaterials.tsx` (new) | Collapsed student panel, truthful readiness/empty/error/locked states |
| `src/pages/StudentContent.tsx` | Mount for accessible lessons only; separate-progress explanation |
| `src/tests/student-lesson-contents.test.ts` (new) | Parser/controller/transport/real component and lifecycle tests |

Updated context/contracts: this record, README, FEATURE_MATRIX, strategy 22,
the earlier implementation's next-step pointer, and J02/J03 contracts.

## Evidence

Backend tests run the actual route, authentication/tenant/student boundaries and
transaction lifecycle with synthetic SQL rows. Cases cover publication and
assignment withdrawal on the next read, foreign source/course/tenant/group,
no group, ambiguous/conflicting branch links, inactive/foreign branch, missing
or revoked membership, membership-version mismatch, exact database release
boundary across session offsets, another enrollment's completion, missing
schema, bounded overflow, selector refusal and private fixed DTOs.

Twenty materials still execute one bulk group/branch read, eight SQL statements
total including scope/schema checks, with no per-material SQL query. This is
local query-shape evidence; no live MySQL concurrency, FK/catalog certification,
query-plan or latency benchmark is claimed. The shared branch policy code was
reused unchanged. Ambiguous data is withheld, without a quarantine/repair write.

Frontend tests cover wrong lesson/extra URL fields/fake readiness/duplicate or
oversized DTOs, explicit-only reads, single flight, session change including
A→B→A, disposal, removing old private rows on failed refresh, canonical bearer
transport and real component markup. The lifecycle case runs the actual child
effect/controller/HTTP function with synthetic storage/fetch, proves its bound
endpoint, and clears state through its actual session-notifier instance.

Initial regression detected the old exact three-route inventory assertion;
extended that exact assertion to include the authorized fourth route. No
authority or response assertion was removed to make the suite pass.

Runtime: already-installed Node **v24.19.0**:

```powershell
$businessNode = 'C:/Users/BaraaWael/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe'
& $businessNode --import ./node_modules/tsx/dist/loader.mjs --test --test-reporter=spec src/tests/student-lesson-contents.test.ts
& $businessNode --import ./node_modules/tsx/dist/loader.mjs --import ./server/tests/helpers/isolated-io-guard.ts --test --test-reporter=spec server/tests/m2-student-course-access.test.ts
& $businessNode --import ./node_modules/tsx/dist/loader.mjs --test --test-reporter=spec src/tests/student-lesson-contents.test.ts src/tests/lesson-contents.test.ts src/tests/m2-course-lesson-ui.test.ts src/tests/m2-course-unit-ui.test.ts src/tests/m2-student-learning-path.test.ts
& $businessNode --import ./node_modules/tsx/dist/loader.mjs --import ./server/tests/helpers/isolated-io-guard.ts --test --test-reporter=spec server/tests/m2-lesson-contents.test.ts server/tests/m2-lesson-release.test.ts server/tests/m2-course-lessons.test.ts server/tests/m2-course-lessons-reorder.test.ts server/tests/m2-course-units.test.ts server/tests/m2-course-publication.test.ts server/tests/m2-public-course-discovery.test.ts server/tests/m2-public-catalog-composition.test.ts server/tests/m2-student-course-access.test.ts
& $businessNode ./node_modules/typescript/bin/tsc -p tsconfig.app.json --noEmit
& $businessNode ./server/node_modules/typescript/bin/tsc -p server/tsconfig.json
& $businessNode ./node_modules/vite/bin/vite.js build
& $businessNode --import ./node_modules/tsx/dist/loader.mjs tmp/student-lesson-materials-visual.cjs
```

Results: focused frontend **16 pass / 0 fail**; focused backend **71 pass / 0
fail** including its existing cases. Final combined frontend **240 pass / 0
fail**, backend **374 pass / 0 fail**. Combined counts include focused cases;
do not add them together. Both TypeScript checks passed. Vite build passed with
the retained large-chunk warning (main JavaScript about 3.54 MB before gzip).
This batch does not establish full-project regression or improved runtime speed.

Static visual QA used the real child component and built CSS with synthetic
ready/empty/locked/unavailable states at 390 and 1024 pixels. No horizontal
overflow and no link/video/iframe locator; the 390px screenshot was visually
inspected. HTTP(S) was blocked; no listener/authenticated live browser journey.
Evidence lives locally under `tmp/student-lesson-materials-{390,1024}.png`,
`tmp/student-lesson-materials-preview.html` and
`tmp/j02-student-materials-{frontend,backend}-regression.log` / `-build.log`.

## Remaining plan, in dependency order

BUILD-05 now implements a conditional PDF reader boundary below. The next local
delivery work is its trusted ingestion/scan writer and proven adapter integration;
the historical sequence below still describes the broader incomplete journey.

1. **Private material delivery:** define and implement exact material/file or
   video ownership and source-version relationships, trusted scanner evidence
   for files, and an authenticated streaming boundary that revalidates the same
   lesson/material/group/branch checks. Catalog IDs must not be guessed into
   legacy lecture/video IDs. Keep delivery unavailable until its real evidence
   exists. Schema/provider application is a separately authorized external gate.
2. **Complete J02 lesson packages:** reusable reference templates, assignment/
   quiz bindings under their own authority contracts, target/timing preview,
   change history and explicit publication. The materials picker alone is not
   this entire journey.
3. **Continue J01 onboarding:** group/role setup and a bounded correct import
   outcome with a trained alternate operator; the current guide is only one
   local part of that journey.
4. **J03 delivery reliability and J04 requests:** actual supported-device
   evidence, truthful submission/retry recovery, then reuse existing support/
   Q&A with scoped lesson context and explicit responsible-party rules.
5. **J05–J10:** teacher preparation signals, authorized family summaries,
   center operations, retention/service measurements and commercial packaging,
   following the detailed dependency/decision gates in [strategy 22](../22-business-strategy-integration-ar.md).

Owner product choices already answered remain valid: several contents per
lesson, separate progress ledgers. No routine reapproval is needed for the
authorized local implementation. Do not infer notification recipients, provider
configuration, money policy, live schema readiness or external authorization.

## BUILD-05 — private PDF delivery boundary

Implemented the conditional binary read under the existing student router:
`GET .../courses/:courseId/lessons/:lessonId/contents/:contentId/file`.
Controlling contract: [private PDF boundary](../streams/server/J03-PRIVATE-MATERIAL-PDF-CONTRACT.md).

Changed production files:

- `server/src/services/material-file-delivery.ts` (new): bounded verified PDF
  preparation, exact raw version/digest/scan-policy checks, cancellation and
  two in-process preparation/response leases. It buffers up to 10 MiB and
  withholds all bytes until the file matches its scan evidence.
- `server/src/routes/student-course-access.ts`: refactors the existing visibility
  authority into one shared helper; adds the file GET and optional trusted
  dependency. Repeats full authority/source checks in a fresh transaction after
  storage reading. Native response `end` avoids Express's automatic ETag/304
  path; attachment headers contain no storage/version/hash/original filename.
- `server/migrations/20261104_01_course_material_files.sql` (new, unapplied):
  server-owned material/source/scan evidence with pending default, raw binary
  version fields, one source per material and declared FKs/size bound.

Tests: new `server/tests/material-file-delivery.test.ts` and extended
`server/tests/m2-student-course-access.test.ts`. The real route/auth-chain
fixture now supports binary response completion events and explicit source
catalog rows; the exact route inventory includes the file GET.

**Current runtime truth:** no reader, scanner-policy configuration or trusted
ingestion/scan writer is bound in the real default composition. Authorized file
reads therefore remain 503 `MATERIAL_FILE_UNAVAILABLE`. The migration was not
applied. No client API can mark a file clean or select its private key/version.
The existing student metadata/UI continues to report opening unavailable; no
new frontend button, playable state or production delivery is claimed.

Local positive-path evidence uses synthetic bytes and a synthetic trusted
scanner/source row: PDF version/hash/size and exact headers, two full fresh
proofs, no mutation/completion, three successive downloads releasing their
response leases. Negative cases include raw-version whitespace mismatch,
wrong engine/policy/digest/key/scope, pending/rejected/revoked/missing proof,
overrun/truncation/signature/hash/provider/iterator errors, empty chunk floods,
reused chunk memory, timeout/caller abort, lease exhaustion, begin/SQL/rollback
failures, and access/source changes while reading. Course withdrawal, assignment
revocation, branch ambiguity, lesson relocking, binding removal or version change
between the two snapshots returns no file bytes.

Exact commands (same installed Node v24.19.0 `$businessNode` assignment above):

```powershell
& $businessNode --import ./node_modules/tsx/dist/loader.mjs --import ./server/tests/helpers/isolated-io-guard.ts --test --test-reporter=spec server/tests/material-file-delivery.test.ts
& $businessNode --import ./node_modules/tsx/dist/loader.mjs --import ./server/tests/helpers/isolated-io-guard.ts --test --test-reporter=spec server/tests/m2-student-course-access.test.ts
& $businessNode --import ./node_modules/tsx/dist/loader.mjs --import ./server/tests/helpers/isolated-io-guard.ts --test --test-reporter=spec server/tests/material-file-delivery.test.ts server/tests/m2-lesson-contents.test.ts server/tests/m2-lesson-release.test.ts server/tests/m2-course-lessons.test.ts server/tests/m2-course-lessons-reorder.test.ts server/tests/m2-course-units.test.ts server/tests/m2-course-publication.test.ts server/tests/m2-public-course-discovery.test.ts server/tests/m2-public-catalog-composition.test.ts server/tests/m2-student-course-access.test.ts
& $businessNode ./server/node_modules/typescript/bin/tsc -p server/tsconfig.json
```

Focused service: **38 pass / 0 fail**. Focused route/access suite: **80 pass /
0 fail**, including existing cases. Final combined backend regression: **421
pass / 0 fail**, including both focused suites, not additive. Server TypeScript
build: **exit 0**. Local logs: `tmp/j03-material-file-tests.log`,
`tmp/j03-material-file-route-tests.log`, `tmp/j03-material-file-regression.log`.
Frontend was unchanged and not rebuilt/retested in BUILD-05; earlier frontend
results in this file are historical results from BUILD-04.

After the last response-error header cleanup, reran both focused suites together:

```powershell
& $businessNode --import ./node_modules/tsx/dist/loader.mjs --import ./server/tests/helpers/isolated-io-guard.ts --test --test-reporter=spec server/tests/material-file-delivery.test.ts server/tests/m2-student-course-access.test.ts
```

**118 pass / 0 fail**, including the 38 and 80 above; local output
`tmp/j03-material-file-final-focused.log`. Failed pre-header responses remove
PDF-specific headers before returning JSON. This is a final focused repeat,
not an additional 118 independent tests.

No live DB, provider, scanner, actual storage version capability, socket,
browser download, external migration, package installation, deployment or
Git/GitHub operation was used. Declared schema/FKs are not applied evidence,
and mocked storage/scan proof is not production verification. No latency or
distributed memory/concurrency result is inferred from unit tests.

Next local slice: trusted owner ingestion and an audited server scan/source
writer, with no manually supplied clean verdict. Then prove and explicitly wire
the private reader/scanner capability, expose readiness in the student contract,
and implement authenticated PDF download UI. Video retains separate authority
and provider gates; reusable lesson packages and other strategy journeys remain
incomplete. Local preparation stays authorized; external application/activation
does not follow automatically from these code changes.
