# Business implementation — 2026-11-05, BUILD-07

Authorized local continuation after [BUILD-06](BUSINESS-IMPLEMENTATION-2026-11-05.md).
No Git/GitHub, real storage/scanner/database, migration application, credentials
change, package install, deployment or provider activation. The default runtime
still supplies no private PDF adapters. This is not whole-strategy acceptance.

Contract: [PDF adapters and student download](../streams/server/J03-PDF-ADAPTERS-DOWNLOAD-CONTRACT.md).

## Result

- Explicit MinIO adapter uses real SDK conditional create, private/versioned
  bucket checks, immutable version reads, abort-bound HTTP transport and no
  mutable overwrite or automatic provider retry loop.
- Explicit ClamAV adapter uses fixed stdin arguments, private configured paths,
  freshness/limit alerts, bounded output, hidden shell-free process creation,
  timeout/cancellation and strict clean-result parsing. It starts no process
  at construction. Real binary/signature readiness remains unverified.
- Pure runtime assembly derives ingestion/read policy from the same scanner;
  missing scanner leaves delivery absent. No new automatic startup wiring.
- Student metadata can offer `pdf_available` only after the existing scope
  checks plus the shared exact source/scan evidence predicate and configured
  reader. One bulk bounded source lookup; no provider I/O per metadata row.
- The real student component/controller/HTTP path now supports explicit bounded
  PDF fetch and browser download, session fences, no automatic retry/completion,
  stale offer removal and short-lived local Blob URL cleanup.

## Changed files

| File | Change |
|---|---|
| `server/src/services/material-minio-store.ts` (new) | Dedicated private/versioned bucket adapter over installed SDK; conditional PUT, version token/read, abort-bound transport |
| `server/src/services/material-clamav-scanner.ts` (new) | Explicit bounded process adapter, fixed paths/arguments and exact scan proof |
| `server/src/services/material-pdf-runtime.ts` (new) | Compatible upload/download dependency assembly only |
| `server/src/services/material-file-delivery.ts` | Shared `materialPdfEvidence` and source-column list; binary proof behavior retained |
| `server/src/services/student-lesson-materials.ts` | Conditional bulk private source offer after authority proof |
| `server/src/routes/student-course-access.ts` | Pass optional delivery policy for list readiness; binary snapshots skip redundant list offer query |
| `server/tests/material-adapters.test.ts` (new) | Real SDK over in-memory HTTP transport; fake owned scanner process and runtime assembly |
| `server/tests/m2-student-course-access.test.ts` | Offer/corrupt proof/duplicate/overflow tests and bulk source fixture |
| `src/lib/api-http.ts` | Canonical protected bounded binary fetch; post-chunk session, MIME, attachment, length and PDF-prefix checks |
| `src/features/catalog/pdf-browser-save.ts` (new) | Transient Blob URL and safe UUID filename; timed/lifecycle cleanup |
| `src/features/catalog/student-lesson-contents.ts` | Conditional availability DTO plus single-flight explicit download, lifetime fences, stale/denied handling |
| `src/features/catalog/StudentLessonMaterials.tsx` | Conditional download action wired to the actual controller/transport/saver |
| `src/tests/student-pdf-download.test.ts` (new) | Binary, identity, controller, URL cleanup and real component callback cases |
| `src/tests/student-lesson-contents.test.ts` | Typed state fixture extended for download state, assertions retained |

Context/docs: this record, README, FEATURE_MATRIX, strategy 22, prior
implementation follow-up and student/PDF contract pointers; new BUILD-07 contract
includes primary SDK/ClamAV references and exact readiness limitations.

## Verification

Installed runtime Node **v24.19.0**, no install/download. Exact commands:

```powershell
$businessNode = 'C:/Users/BaraaWael/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe'
& $businessNode --import ./node_modules/tsx/dist/loader.mjs --import ./server/tests/helpers/isolated-io-guard.ts --test --test-reporter=spec server/tests/material-adapters.test.ts server/tests/material-file-ingestion.test.ts server/tests/material-file-owner-routes.test.ts server/tests/material-file-delivery.test.ts server/tests/m2-lesson-contents.test.ts server/tests/m2-lesson-release.test.ts server/tests/m2-course-lessons.test.ts server/tests/m2-course-lessons-reorder.test.ts server/tests/m2-course-units.test.ts server/tests/m2-course-publication.test.ts server/tests/m2-public-course-discovery.test.ts server/tests/m2-public-catalog-composition.test.ts server/tests/m2-student-course-access.test.ts
& $businessNode --import ./node_modules/tsx/dist/loader.mjs --test --test-reporter=spec src/tests/student-pdf-download.test.ts src/tests/material-pdf-upload.test.ts src/tests/student-lesson-contents.test.ts src/tests/lesson-contents.test.ts src/tests/m2-course-lesson-ui.test.ts src/tests/m2-course-unit-ui.test.ts src/tests/m2-student-learning-path.test.ts
& $businessNode ./server/node_modules/typescript/bin/tsc -p server/tsconfig.json
& $businessNode ./node_modules/typescript/bin/tsc -p tsconfig.app.json --noEmit
& $businessNode ./node_modules/vite/bin/vite.js build
& $businessNode tmp/student-pdf-download-browser.cjs
```

Combined backend **484 pass / 0 fail**, including adapter/runtime **17** and
student access **89** (the latter includes existing tests plus nine offer cases).
Combined frontend **283 pass / 0 fail**, including new download **22** cases.
Counts overlap; do not add focused results. Both TypeScript checks passed.
Vite build passed with the retained large-chunk warning (main JS about 3.55 MB
before gzip). No general load/memory/latency or full-project acceptance claim.

After a final structural reader-readiness guard, reran the two affected server
suites and server typecheck:

```powershell
& $businessNode --import ./node_modules/tsx/dist/loader.mjs --import ./server/tests/helpers/isolated-io-guard.ts --test --test-reporter=spec server/tests/material-file-delivery.test.ts server/tests/m2-student-course-access.test.ts
& $businessNode ./server/node_modules/typescript/bin/tsc -p server/tsconfig.json
```

Final focused repeat **127 pass / 0 fail**, typecheck exit 0. This repeats cases
already in the combined regression, not additional independent coverage.

Evidence details:

- Real installed MinIO SDK signs/builds requests against a synthetic Writable/
  Readable HTTP transport, never a socket. Tests pin conditional header, opaque
  version preservation, version-specific GET, public/suspended/unknown refusal,
  NoSuchBucketPolicy handling, no transient backoff retry and request cancellation.
- Scanner process factory is injected: no ClamAV executable ran. Tests check
  fixed shell-free/hidden options, no inherited provider secrets, valid clean
  output, missing/noisy/error/infected/flood output, owned-child kill and deadline.
- Metadata readiness preserves exact private DTO keys; missing/pending/revoked/
  wrong-policy/raw-version/digest/duplicate/overflow proofs remain unavailable,
  with no provider I/O. Existing scope/lock/withdrawal tests remain passing.
- Client binary tests reject MIME/length/attachment/signature/short/overrun errors
  and session change during streaming. Controller tests prove no double request,
  no save after event/silent/ABA/disposal fences, no completion write, and stale
  action removal. Blob URL cleanup and actual component callbacks are exercised.

The first SDK fixture incorrectly emitted string response chunks and modeled
an HTTP request as auto-destroyed on Writable finish. Corrected it to byte
responses and a request that stays open until response/abort; no production
guard was weakened. The old typed student state fixture was updated for the
new required download-state fields before passing frontend typecheck.

## Real browser fixture

`tmp/student-pdf-download-browser.cjs` bundles the real React child/controller/
HTTP/saver with installed esbuild and built CSS. Local Chromium intercepts all
requests to a synthetic origin and aborts others; no listener, real authentication
server, database, provider or scanner is used.

Verified at **390 and 1024** pixels with no horizontal overflow; mobile screenshot
inspected. Collapsed panel made zero API requests. Opening offered a PDF, actual
browser download bytes and UUID filename matched the synthetic fixture exactly,
then a withdrawn response cleared the private title and action. Exactly three
GET API requests, zero completion writes. This is a real browser frontend journey
with mocked API responses, not a live backend/provider integration test or proof
of OS file save on every supported device.

Local artifacts: `tmp/student-pdf-download-{390,1024}.png`,
`tmp/student-pdf-download-revoked.png`, `tmp/student-pdf-download-browser.html`,
`tmp/j03-adapter-download-{backend,frontend}.log`,
`tmp/j03-adapter-download-build.log`, `tmp/j03-shared-readiness-final.log`.

## Remaining gates

Real catalog/constraints, private versioned storage and conditional-create
semantics, actual scanner binary/signatures/private temp/limits, and cancellation
must be verified before explicit runtime binding. No migration was authored or
applied in this slice. Adapters exist in code; defaults are still unconfigured.
`pdf_available` is a scoped source-proof offer, not a provider health guarantee.

Real activation/schema/provider actions remain separately authorized. Recovery/
retention/versioned replacement and operator resolution are unfinished, as are
direct video authority/delivery and the rest of the business strategy. Policy IDs
must track meaningful scanner/policy changes; no automatic rescan or signature
update worker was introduced. Existing manual completion and separate progress
ledgers remain unchanged.
