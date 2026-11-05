# Business implementation — 2026-11-05, BUILD-10

Follow-up: [BUILD-11](BUSINESS-IMPLEMENTATION-2026-11-05-BUILD-11.md) implements keyed create/reply replay, atomic writes/audit and read-only reconciliation. The remaining-work list below records the end of BUILD-10.

Local J04 continuation after [BUILD-09](BUSINESS-IMPLEMENTATION-2026-11-05-BUILD-09.md). Contract: [support detail and reply paging](../streams/server/J04-SUPPORT-DETAIL-BOUNDARY.md).

## Result

Older support messages are now accessible through an explicit **show older replies** action. Each request fetches at most 101 rows and returns 100, anchored to an existing reply inside the same freshly authorized ticket. Timestamp ties are resolved by ID inside SQL; arriving new replies do not shift earlier pages. The UI validates page DTOs, prevents concurrent duplicate page loads and overlap, preserves the cursor after transient failure, and fences responses after ticket/session changes. Permission loss clears private conversation state. The conversation scroll area preserves reading position when earlier messages are prepended.

This completes the temporary long-conversation limitation introduced in BUILD-09. It does not complete all J04 writes, routing or business journeys.

## Changed files

| File | Change |
|---|---|
| `server/src/routes/support-tickets.ts` | Shared bounded reply-page query, same-ticket anchor endpoint, additive detail cursor and no-store |
| `server/tests/m1-sprint-notification-support.test.ts` | SQL fixture projection/anchor semantics; 251 tied replies, concurrent arrival, foreign cursor, revoked admin and unauthenticated cases |
| `src/features/support/reply-page.ts` (new) | Fixed DTO/page validation and cursor consistency |
| `src/lib/api-http.ts` | Canonical validated detail/older-page GET and optional cancellation |
| `src/pages/Support.tsx` | Real older-page button/controller, session/identity fences, scroll preservation and private-state clearing |
| `src/tests/m1-sprint-meeting-support-ui.test.ts` | Actual production controller paging, single flight, retry/overlap and stale/permission fences |
| `src/tests/support-reply-pagination.test.ts` (new) | Strict page parsing and real canonical transport with synthetic fetch |
| `tmp/support-pagination-browser.cjs` (new) | Real Support page/browser/controller/transport fixture; only navigation headers replaced |

Context: this record, README, FEATURE_MATRIX, strategy 22 and the J04 contract.

## Verification

Installed Node v24.19.0; no package installation. Exact commands:

```powershell
$businessNode = 'C:/Users/BaraaWael/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe'
& $businessNode --import ./node_modules/tsx/dist/loader.mjs --test --test-reporter=dot server/tests/m1-sprint-notification-support.test.ts
& $businessNode --import ./node_modules/tsx/dist/loader.mjs --test --test-reporter=dot src/tests/m1-sprint-meeting-support-ui.test.ts src/tests/support-reply-pagination.test.ts
& $businessNode ./server/node_modules/typescript/bin/tsc -p server/tsconfig.json
& $businessNode ./node_modules/typescript/bin/tsc -p tsconfig.app.json --noEmit
& $businessNode ./node_modules/vite/bin/vite.js build
& $businessNode tmp/support-pagination-browser.cjs
```

Scoped server **34 pass / 0 fail**, frontend **42 pass / 0 fail**. Both typechecks passed. Vite build passed with existing warnings about large chunks and mixed static/dynamic imports (main JS approximately 3.56 MB before gzip). These are scoped regression results, not full-project or production performance acceptance.

The server tests run real Express/JWT/permission logic over an in-memory SQL interpreter and loopback HTTP. No real database, provider, secrets or production app startup. They establish route decisions, bounds and ordering predicates, not actual MySQL optimizer/index/latency evidence.

The browser fixture bundles the actual Support page/controller/parser/API; shared navigation headers are inert. Chromium intercepts all requests to a synthetic origin and aborts other origins. Verified 251 messages across three pages without duplicates/loss; fixed reading position after prepending; no horizontal overflow at 390/1024 pixels; late page cannot cross ticket selection; session event clears private tickets. Seven GET requests and zero mutations. Mobile screenshot inspected. Artifacts: `tmp/support-pagination-browser.html`, `tmp/support-pagination-{390,1024}.png`.

## Remaining work

Next local J04 priority: durable idempotency for ticket creation and replies, atomic reply/status/audit transitions, then scoped assignment/context routing and private-note separation. Response-time policy and classification/transfer authority still require product/operations decisions. New replies after the first page appear on explicit refresh; no polling or automatic delivery was added. Missing/deleted anchor requires refresh. J03 schema/provider activation, cleanup/retention/replacement, and the other business journeys remain separate pending work. No migration, live data, Git/GitHub, package install or external activation occurred in BUILD-10.
