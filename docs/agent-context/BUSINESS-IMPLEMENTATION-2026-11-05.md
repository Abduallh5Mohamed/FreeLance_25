# Business implementation — 2026-11-05, BUILD-06

Continuation [BUILD-07](BUSINESS-IMPLEMENTATION-2026-11-05-BUILD-07.md) adds explicit
MinIO/ClamAV factories and conditional student PDF download UI. The historical
remaining-work list below predates that local continuation; real activation,
schema and provider acceptance are still open.

Continues the owner's local implementation authorization. Previous bounded work:
[BUILD-04/05](BUSINESS-IMPLEMENTATION-2026-11-04.md). This is an owner ingestion
producer/UI slice, not the whole strategy or permission to apply schema/use live
providers. No Git/GitHub, real DB/provider, package install, deployment or secrets.

## Outcome

Existing PDF references now have a collapsed owner panel for source status,
initial upload and explicit same-file retry. The mounted backend conditionally
reserves a durable source before object writing, verifies private readback, and
records only version/digest-bound trusted scanner proof. Reservation, stored
transition and scan transition each share a fresh authority check, SQL mutation
and audit transaction. Provider I/O runs between transactions, never inside one.

Without a scanner, confirmed stored files remain pending and unavailable to
students. A failed/mismatched scan cannot create a clean result. An infected
result is terminal even if a concurrent clean result arrives later. The UI
distinguishes pending, rejected, revoked, confirmed and uncertain outcomes,
validates PDF bytes before sending and retains/reconciles the same request key.

The default runtime still supplies no store/scanner configuration. Both source
and upload metadata migrations are unapplied. Source interface presence is not
live private/immutable storage or scanner verification. Student metadata and
download UI remain unavailable; ingestion does not publish or grant access.

Contract: [J03 owner ingestion](../streams/server/J03-MATERIAL-PDF-INGESTION-CONTRACT.md).

## Changed files

| File | Change |
|---|---|
| `server/src/services/material-file-ingestion.ts` (new) | Bounded body/readback, immutable-store contract, server scanner contract, durable reservation, idempotent resume and atomic state/audit writer |
| `server/src/routes/course-lessons.ts` | Owner GET/POST under a PDF reference; live owner/course/unit/lesson/material proof before body; only raw PDF and request UUID |
| `server/src/routes/tenant-self.ts` | Optional trusted ingestion configuration forwarded through the existing mount; no default provider binding |
| `server/migrations/20261105_01_material_file_ingestion.sql` (new, unapplied) | Nullable actor/request/upload phase and tenant/request uniqueness; no backfill/fabricated history |
| `src/lib/api-http.ts` | Canonical status and raw-PDF POST, bearer, Idempotency-Key, cancellation and strict path; no source selectors |
| `src/features/catalog/material-pdf-upload.ts` (new) | Strict DTO/controller, payload bounds/signature, target/size acknowledgement binding, same-key reconciliation, session/disposal fences |
| `src/features/catalog/OwnerMaterialPdfManager.tsx` (new) | Collapsed PDF owner editor; truthful source/scan/configuration states and recovery |
| `src/features/catalog/LessonContentManager.tsx` | Child mounted only for PDF references; no automatic per-row request |
| `server/tests/material-file-ingestion.test.ts` (new) | Producer, transaction/audit/provider failure, retry and producer→delivery compatibility cases |
| `server/tests/material-file-owner-routes.test.ts` (new) | Real handler/parser-chain/owner proof and optional parent mount |
| `src/tests/material-pdf-upload.test.ts` (new) | Strict parser, controller, actual HTTP and real component lifecycle/markup cases |

Updated docs: this record, README, FEATURE_MATRIX, strategy 22, the previous
implementation's handoff, PDF-boundary follow-up and new ingestion contract.

## Verification

Runtime: installed Node **v24.19.0**, unchanged packages/CI version.

```powershell
$businessNode = 'C:/Users/BaraaWael/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe'
& $businessNode --import ./node_modules/tsx/dist/loader.mjs --import ./server/tests/helpers/isolated-io-guard.ts --test --test-reporter=spec server/tests/material-file-ingestion.test.ts server/tests/material-file-owner-routes.test.ts server/tests/material-file-delivery.test.ts server/tests/m2-lesson-contents.test.ts server/tests/m2-lesson-release.test.ts server/tests/m2-course-lessons.test.ts server/tests/m2-course-lessons-reorder.test.ts server/tests/m2-course-units.test.ts server/tests/m2-course-publication.test.ts server/tests/m2-public-course-discovery.test.ts server/tests/m2-public-catalog-composition.test.ts server/tests/m2-student-course-access.test.ts
& $businessNode --import ./node_modules/tsx/dist/loader.mjs --test --test-reporter=spec src/tests/material-pdf-upload.test.ts src/tests/student-lesson-contents.test.ts src/tests/lesson-contents.test.ts src/tests/m2-course-lesson-ui.test.ts src/tests/m2-course-unit-ui.test.ts src/tests/m2-student-learning-path.test.ts
& $businessNode ./node_modules/typescript/bin/tsc -p tsconfig.app.json --noEmit
& $businessNode ./server/node_modules/typescript/bin/tsc -p server/tsconfig.json
& $businessNode ./node_modules/vite/bin/vite.js build
& $businessNode --import ./node_modules/tsx/dist/loader.mjs tmp/owner-pdf-ingestion-visual.cjs
```

Results: combined backend **458 pass / 0 fail**, including new service **25**
and owner route **12** cases. Combined frontend **261 pass / 0 fail**, including
new owner PDF **21** cases. Counts overlap; do not add focused and combined
results. Both TypeScript checks passed. Vite build passed with the existing
large-chunk warning (main JavaScript about 3.55 MB before gzip). No full-project
regression, latency, memory/RSS, distributed concurrency or production acceptance.

Specific evidence:

- Actual PDF stream runs through the real global JSON/urlencoded parsers and
  owner router. Their existing empty `req.body` initialization is accepted;
  nonempty/preparsed/JSON clean/source metadata is refused.
- Owner, course, unit, lesson, binding, schema and configuration refusal happen
  before body buffering/provider I/O; billing-only/selector refusal precedes SQL.
- Three atomic reservation/stored/scan events; fixed private DTO and sanitized
  audits containing no byte/hash/key/provider payload. No-op repeats do not
  rewrite, audit, reupload or rescan; different key/actor/payload cannot overwrite.
- Every audit/commit stage is faulted. Reservation failure calls no provider;
  later failure leaves a committed recovery root. Lost commit acknowledgement
  stops subsequent external work, destroys the connection and requires
  reconciliation. Same-key retry recovers without creating another object.
- Stored byte mismatch and scanner failure/exception/version/digest mismatch
  never record clean; absent scanner returns confirmed pending, not write failure.
  Ownership loss during provider work prevents the next state mutation.
- Two service admissions bound body buffering, and stream byte/chunk limits,
  copying and cancellation are exercised. Timeout forwards abort to the adapter.
- The actual source and scan record produced by this writer is accepted by the
  existing verified delivery service in a synthetic positive pipeline case.
  Real HTTP transport/storage/database/scanner remain unexercised.
- The real editor effect invokes its controller/canonical HTTP function, then
  its real session notifier clears state. Strict parsing rejects extra locator
  fields, coerced enums, wrong material/file/size, fake readiness and malformed
  acknowledgements. Unknown outcomes block further writes until explicit read,
  retaining the request key even if an early fresh snapshot is empty.

During implementation, the first server typecheck identified generic return and
nullable version narrowing issues; corrected before passing checks. No library,
schema target or security assertion was weakened to obtain a pass.

Static visual QA rendered the actual owner editor with built CSS and synthetic
initial/pending/unconfigured/uncertain states at 390 and 1024 pixels. No horizontal
overflow or unbound label; the mobile screenshot was inspected. HTTP(S) blocked,
no listener/provider/authenticated browser journey. Local artifacts:
`tmp/owner-pdf-ingestion-{390,1024}.png`, `tmp/owner-pdf-ingestion-preview.html`,
`tmp/j03-ingestion-{backend,frontend}-regression.log`, `tmp/j03-ingestion-ui-build.log`.

## What remains

1. Implement/verify real private immutable storage/version-read and trusted
   scanner adapters, including their cancellation and operational failure evidence.
   Explicit wiring/activation and applying either source migration require their
   separately authorized external gate; neither happened in this batch.
2. Verify real source schema/constraints; then derive actual PDF availability
   and add authenticated student download UI. Existing metadata remains
   `delivery_status: unavailable`; no simulated live delivery is advertised.
3. Initial-source ingestion only: source replacement/version revisions, revoked
   actor/operator resolution, durable autonomous recovery, exact-version
   quarantine/deletion and retention remain separate bounded work. No background
   worker or guaranteed cleanup is implied by the durable reservation.
4. Direct video course authority/delivery and the rest of J02 lesson packages,
   onboarding, support, family and other strategy journeys remain incomplete.

The several-contents and separate-progress decisions stay resolved. The new
nullable migration fields leave prior unclassified rows unclassified; do not
manually mark a legacy URL clean or turn a configured interface into readiness.
