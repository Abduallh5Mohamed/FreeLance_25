# Business implementation — 2026-11-05, BUILD-11

Follow-up: [BUILD-12](BUSINESS-IMPLEMENTATION-2026-11-05-BUILD-12.md) adds student lesson context and shared live source proof. Its migration is unapplied; remaining-work notes below describe BUILD-11's end state.

Local J04 continuation after [BUILD-10](BUSINESS-IMPLEMENTATION-2026-11-05-BUILD-10.md). Contract: [support write reliability](../streams/server/J04-SUPPORT-WRITE-RELIABILITY.md).

## Result

Support creation and replies now require stable request keys. Server-derived resource IDs and existing primary keys prevent duplicate records on same-key replay. A reply, its ticket status and sanitized audit commit together. Status changes are audited in a transaction and same-status repeats are no-ops. Unknown commits destroy their connection and remain uncertain.

The real Support page retains only the opaque key in session storage, preserves it after unknown outcomes and offers explicit read-only reconciliation. Reopening the page can recover a confirmed creation/reply without re-posting or storing private draft text. Reply acknowledgements provide actual server status; an old reply already present after refresh is not displayed twice. Authentication/session/target fences remain active.

## Changed files

| File | Change |
|---|---|
| `server/src/services/support-writes.ts` (new) | Canonical actor proof, engine/primary-key gates, stable request identity, atomic create/reply/status/audit and read-only reconciliation |
| `server/src/routes/support-tickets.ts` | All writes use the transactional service; attempt GET endpoints; required key and fixed envelopes |
| `server/tests/support-writes.test.ts` (new) | Serialized duplicate fixture, lost commit, rollback/audit, permission, schema/engine, replay/no-op and reconciliation cases |
| `server/tests/m1-sprint-notification-support.test.ts` | Actual router fixture supports transaction/authority/audit SQL; key/reconciliation integration regression |
| `src/features/support/write-attempt.ts` (new) | Durable opaque browser key, frozen unknown payload, explicit retry/check, deadline and session fences |
| `src/features/support/write-result.ts` (new) | Strict acknowledgement and reply-target validation |
| `src/lib/api-http.ts` | Required keyed POSTs, validated acknowledgements and attempt GETs |
| `src/pages/Support.tsx` | Actual attempt controllers, account/target storage scope, truthful unknown/confirmed UI and server-derived reply status |
| `src/tests/support-write-attempt.test.ts` (new) | Key lifetime, unknown retry/reopen, storage/cleanup, timeout/denial/fences and canonical transport |
| `src/tests/m1-sprint-meeting-support-ui.test.ts` | Inert transport imports extended for reconciliation |
| `tmp/support-write-browser.cjs` (new) | Actual Support page/controller/API with synthetic persisted acknowledgements and two reloads |

Context: this record, README, FEATURE_MATRIX, strategy 22, J04 contracts and BUILD-10 follow-up pointer.

## Verification

Already installed Node v24.19.0; no package installation. Exact commands:

```powershell
$businessNode = 'C:/Users/BaraaWael/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe'
& $businessNode --import ./node_modules/tsx/dist/loader.mjs --import ./server/tests/helpers/isolated-io-guard.ts --test --test-reporter=spec server/tests/support-writes.test.ts
& $businessNode --import ./node_modules/tsx/dist/loader.mjs --test --test-reporter=dot server/tests/m1-sprint-notification-support.test.ts
& $businessNode --import ./node_modules/tsx/dist/loader.mjs --test --test-reporter=dot src/tests/support-write-attempt.test.ts src/tests/m1-sprint-meeting-support-ui.test.ts src/tests/support-reply-pagination.test.ts
& $businessNode ./server/node_modules/typescript/bin/tsc -p server/tsconfig.json
& $businessNode ./node_modules/typescript/bin/tsc -p tsconfig.app.json --noEmit
& $businessNode ./node_modules/vite/bin/vite.js build
& $businessNode tmp/support-write-browser.cjs
& $businessNode tmp/support-pagination-browser.cjs
```

Scoped server suites **58 pass / 0 fail** (23 service and 35 real-route fixture cases), frontend **54 pass / 0 fail**. Both TypeScript checks passed. Vite build passed with the existing large-chunk/mixed-import warnings; main JS approximately 3.57 MB before gzip. No whole-project or production load/latency acceptance is claimed.

The service fixture models serialization and transaction snapshots entirely in memory under the isolated I/O guard. The route suite runs real Express/JWT/permissions over synthetic SQL and local loopback HTTP. Neither is a real MySQL engine/concurrency test. They prove the actual service/route decisions and SQL/transaction calls without production data or credentials.

Browser evidence bundles the real Support page/controllers/API and stubs shared navigation headers only. All HTTP requests are intercepted at a synthetic secure origin; no real listener, database or provider. Simulated persistence plus lost acknowledgements for both creation and reply; two reloads recovered via GET, with exactly one create POST and one reply POST, no duplicate visible reply, opaque keys only, no mobile overflow or page errors. Mobile screenshot inspected. The pagination browser fixture also passed again: 251 messages/three pages, fixed reading position, late-response/session fences and no mutations.

Artifacts: `tmp/support-write-browser.html`, `tmp/support-write-{uncertain,confirmed}-390.png`; prior pagination artifacts refreshed. The secure fixture origin is needed for the browser's real `crypto.randomUUID`; no production randomness fallback was introduced.

## Readiness and next work

No migration was authored/applied, no live data/provider used and no Git/GitHub command run. The service relies on existing schema and fails closed if transactional storage/audit/primary-key evidence is missing. New required request headers and POST envelopes need the updated frontend/API to be released together. Replays are durable while immutable support rows are retained; deletion/retention would require a tombstone contract first.

J04 still needs classified/context-proven requests, scoped assignment/transfer, separation of private notes and a realistic service policy. Current support remains the global requester/platform inbox. Staff-only identity mapping is unresolved; no tenant staff authority was invented. The other business journeys and J03 external activation/cleanup/replacement remain open.
