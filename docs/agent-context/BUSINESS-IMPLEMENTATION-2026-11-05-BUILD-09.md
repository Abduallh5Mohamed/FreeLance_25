# Business implementation — 2026-11-05, BUILD-09

Follow-up: [BUILD-10](BUSINESS-IMPLEMENTATION-2026-11-05-BUILD-10.md) implements older-reply pagination and session fences. The remaining-work notes below describe BUILD-09's historical endpoint.

Local continuation into J04 after [BUILD-08](BUSINESS-IMPLEMENTATION-2026-11-05-BUILD-08.md). [Bounded support detail contract](../streams/server/J04-SUPPORT-DETAIL-BOUNDARY.md).

The existing support ticket detail now returns an explicit projection without a user phone or internal assignee fields. The owner predicate is repeated in the detail query. Replies read at most 101 rows, present the latest 100 in chronological order, and mark older replies honestly in the UI. The page resets that warning when another ticket opens, so an old response cannot label the wrong conversation.

Changed source/tests: `server/src/routes/support-tickets.ts`, `server/tests/m1-sprint-notification-support.test.ts`, `src/lib/api-http.ts`, `src/pages/Support.tsx`, `src/tests/m1-sprint-meeting-support-ui.test.ts`. Context: this record, README, FEATURE_MATRIX, strategy 22 and J04 contract.

Verification with the already installed Node v24.19.0, local in-memory SQL fixture and loopback HTTP only. Exact commands:

```powershell
$businessNode = 'C:/Users/BaraaWael/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe'
& $businessNode --import ./node_modules/tsx/dist/loader.mjs --test --test-reporter=dot server/tests/m1-sprint-notification-support.test.ts
& $businessNode --import ./node_modules/tsx/dist/loader.mjs --test --test-reporter=dot src/tests/m1-sprint-meeting-support-ui.test.ts
& $businessNode ./server/node_modules/typescript/bin/tsc -p server/tsconfig.json
& $businessNode ./node_modules/typescript/bin/tsc -p tsconfig.app.json --noEmit
& $businessNode ./node_modules/vite/bin/vite.js build
```

Scoped server **32 pass / 0 fail**, frontend **33 pass / 0 fail**. Both TypeScript checks and Vite build passed; the existing large chunk warning remains (main JS about 3.56 MB). No real database was accessed and no production acceptance is claimed.

The first follow-up is cursor pagination for older replies. J04 remains partial: existing creation/reply writes are not idempotent or atomic with status changes; assignment/context proof and service policy are not yet implemented. No external channel or provider was activated.
