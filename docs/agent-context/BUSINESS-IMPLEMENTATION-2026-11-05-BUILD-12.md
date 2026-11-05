# Business implementation — 2026-11-05, BUILD-12

Local J04 continuation after [BUILD-11](BUSINESS-IMPLEMENTATION-2026-11-05-BUILD-11.md). Contract: [lesson support context](../streams/server/J04-LESSON-SUPPORT-CONTEXT.md).

## Result

An accessible lesson on the real student learning path now opens a support draft for that lesson. Preflight verifies its current scope. Creation repeats that proof and stores server-derived references atomically with ticket/audit. Support displays current verified course/lesson names separately from the message; expiry/withdrawal or a student's workspace switch withholds the context. Invalid/unavailable context never silently changes into a generic request; that needs an explicit user choice. Ordinary support still works when context columns are absent.

The existing private student material read now shares its enrollment/course/lesson proof with this surface. No learning-path/material/write acknowledgement DTO was widened. A confirmed contextual save retains the prior same-key reconciliation behavior even after the source becomes unavailable.

## Changed files

| File | Change |
|---|---|
| `server/src/services/student-lesson-access.ts` (new) | Shared pure enrollment/course/lesson proof, optional transaction locks |
| `server/src/services/support-lesson-context.ts` (new) | Strict context selectors, schema/source gates, immutable binding decoding and bounded current metadata |
| `server/src/services/support-writes.ts` | Contextual keyed creation/binding/audit, replay comparison and purpose-scoped context read |
| `server/src/routes/student-course-access.ts` | Shared proof wiring plus student-only preflight |
| `server/src/routes/support-tickets.ts` | Authorized ticket-context GET |
| `server/migrations/20261105_02_support_lesson_context.sql` (new, unapplied) | Five nullable reference columns and all-none/all-complete CHECK |
| `server/tests/support-writes.test.ts` | Context source/authority/schema/idempotency/audit/uncertain-commit cases |
| `server/tests/m2-student-course-access.test.ts` | Real preflight mount/DTO/denial cases plus shared-proof regression |
| `server/tests/m1-sprint-notification-support.test.ts` | Generic-schema compatibility and actual context route authority regression |
| `src/features/support/lesson-context.ts` (new) | Strict URL/DTO parsing and private read lifecycle |
| `src/lib/api-http.ts` | Canonical context reads and optional three-key create reference |
| `src/pages/StudentContent.tsx` | Accessible-lesson help action |
| `src/pages/Support.tsx` | Actual verified draft/current ticket context, explicit generic choice and target/session fences |
| `src/tests/support-lesson-context.test.ts` (new) | Parsing, cancellation, stale/private/denied read and canonical transport |
| `src/tests/m1-sprint-meeting-support-ui.test.ts` | Inert import fixtures extended for new readers |
| `tmp/support-lesson-context-browser.cjs` (new) | Real student path → contextual support form → recovery/withdrawal/generic choice journey |
| `tmp/support-{write,pagination}-browser.cjs` | Existing regression fixtures adapted to actual router context and empty context responses |

Context: this record, README, FEATURE_MATRIX, strategy 22, J04 contracts and prior-build follow-up.

## Verification

Existing Node v24.19.0; no install or migration application. Exact commands:

```powershell
$businessNode = 'C:/Users/BaraaWael/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe'
& $businessNode --import ./node_modules/tsx/dist/loader.mjs --import ./server/tests/helpers/isolated-io-guard.ts --test --test-reporter=dot server/tests/support-writes.test.ts server/tests/m2-student-course-access.test.ts
& $businessNode --import ./node_modules/tsx/dist/loader.mjs --test --test-reporter=dot server/tests/m1-sprint-notification-support.test.ts
& $businessNode --import ./node_modules/tsx/dist/loader.mjs --test --test-reporter=dot src/tests/support-lesson-context.test.ts src/tests/support-write-attempt.test.ts src/tests/support-reply-pagination.test.ts src/tests/m1-sprint-meeting-support-ui.test.ts src/tests/m2-student-learning-path.test.ts
& $businessNode ./server/node_modules/typescript/bin/tsc -p server/tsconfig.json
& $businessNode ./node_modules/typescript/bin/tsc -p tsconfig.app.json --noEmit
& $businessNode ./node_modules/vite/bin/vite.js build
& $businessNode tmp/support-lesson-context-browser.cjs
& $businessNode tmp/support-write-browser.cjs
& $businessNode tmp/support-pagination-browser.cjs
```

Scoped server **166 pass / 0 fail** (130 isolated shared-proof/support cases and 36 actual-router fixture cases). Frontend **95 pass / 0 fail**. Both typechecks passed. Vite build passed with retained large-chunk/mixed-import warnings; main JS approximately 3.57 MB before gzip. This does not establish whole-project cleanliness, actual MySQL behavior or production performance.

SQL fixtures execute the real helpers/services/routers with synthetic rows; no real database, dotenv credentials, provider or migrations. The student/source suites use the isolated I/O guard; the legacy notification/support router suite uses local loopback HTTP with synthetic SQL. Existing release epoch, completion separation, publication, group/branch material and protected-file tests in the affected student suite remain passing.

The new browser fixture bundles actual StudentContent and Support pages, controllers and transport, with navigation headers inert. All requests are intercepted at a synthetic secure origin. Verified one help action for the accessible lesson and none for a locked lesson; contextual POST carries only course/lesson references; lost acknowledgement recovered by GET; renewed ticket context read hides withdrawn metadata; unavailable preflight blocks submit until explicit generic selection. Two deliberate support POSTs (one contextual, one generic), zero implicit writes, 16 total requests. No horizontal overflow at 390/1024 pixels or page errors. Mobile screenshot inspected.

Existing write/reload browser regression also passed (one create POST, one reply POST, two reloads, opaque keys only; 12 requests including context reads). Existing history regression passed (251 messages/three pages, reading position and ticket/session fences; 10 GETs). Browser fixtures use synthetic API responses, not a live database/backend integration.

Artifacts: `tmp/support-lesson-context-browser.html`, `tmp/support-lesson-context-{390,1024}.png`, refreshed prior support browser artifacts.

## Readiness and next work

The new migration is a file only. Until actual columns exist, contextual support fails closed and generic support remains usable. No live schema/data/provider, Git/GitHub, package install or deployment was used. Context uses the existing requester/platform-support inbox; it does not assign a teacher or grant tenant staff authority. Next J04 work is scoped assignment/transfer and private-note separation with explicit operational authority. Other context kinds, teacher/parent identity cases, service-time policy and the rest of the business strategy remain open.
