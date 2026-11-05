# Business implementation — 2026-11-05, BUILD-08

Authorized local continuation after [BUILD-07](BUSINESS-IMPLEMENTATION-2026-11-05-BUILD-07.md). [Source revocation contract](../streams/server/J03-PDF-SOURCE-REVOCATION-CONTRACT.md).

The teacher now has an explicit, confirmed **withdraw PDF source** action. The backend rechecks live owner/course/unit/lesson/binding authority, locks the source and commits revocation with audit. A repeat is a no-op. Student offer and download already require active source proof; the new tests exercise the actual producer→delivery transition and an in-flight scan race. The panel reconciles unknown DELETE outcomes and fences session changes.

Changed source/tests: `server/src/services/material-file-ingestion.ts`, `server/src/routes/course-lessons.ts`, `server/tests/material-file-ingestion.test.ts`, `server/tests/material-file-owner-routes.test.ts`, `src/lib/api-http.ts`, `src/features/catalog/material-pdf-upload.ts`, `src/features/catalog/OwnerMaterialPdfManager.tsx`, `src/tests/material-pdf-upload.test.ts`. Context: this record, README, FEATURE_MATRIX, strategy 22 and the new contract.

Verification used installed Node v24.19.0, no real network or provider. Exact commands:

```powershell
$businessNode = 'C:/Users/BaraaWael/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe'
& $businessNode --import ./node_modules/tsx/dist/loader.mjs --import ./server/tests/helpers/isolated-io-guard.ts --test --test-reporter=dot server/tests/material-file-ingestion.test.ts server/tests/material-file-owner-routes.test.ts server/tests/material-file-delivery.test.ts server/tests/m2-student-course-access.test.ts
& $businessNode --import ./node_modules/tsx/dist/loader.mjs --test --test-reporter=spec src/tests/material-pdf-upload.test.ts src/tests/student-pdf-download.test.ts
& $businessNode ./server/node_modules/typescript/bin/tsc -p server/tsconfig.json
& $businessNode ./node_modules/typescript/bin/tsc -p tsconfig.app.json --noEmit
& $businessNode ./node_modules/vite/bin/vite.js build
```

Scoped server suites **170 pass / 0 fail**, frontend suites **46 pass / 0 fail**, both TypeScript checks passed. Vite build passed with its existing large chunk warning. The first server run caught a new syntax typo; fixed before the passing rerun. No full-project or live provider acceptance is claimed.

Default adapters remain unconfigured and SQL migration files unapplied. Withdrawal does not erase an object, undo a completed browser download or implement source replacement. Durable operator cleanup/retention and real schema/provider readiness are still pending.
