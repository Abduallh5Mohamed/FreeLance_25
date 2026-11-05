# Business implementation — 2026-11-05, BUILD-16

Continues [BUILD-15](BUSINESS-IMPLEMENTATION-2026-11-05-BUILD-15.md). [Assigned queue contract](../streams/server/J04-SUPPORT-ASSIGNED-QUEUE.md). [Current execution queue](BUSINESS-EXECUTION-QUEUE.md).

Follow-up: [BUILD-17](BUSINESS-IMPLEMENTATION-2026-11-06-BUILD-17.md) starts J02/J03 video work with the explicit owner-only preparation backend. Actual owner video UI and catalog-aware student playback remain next; no live media/schema was activated.

## Result

The actual Support page now offers a private self-assigned queue with explicit 25-row keyset paging and refresh. The server uses the live canonical actor and current platform support grant; no client-selected assignee, tenant or role becomes authority. Read DTOs are fixed and omit contacts, descriptions and private notes. Opening a row reuses the existing authenticated detail flow.

The open queue hides and aborts obsolete rows while local assignment writes/retries/recovery are active, then reads fresh membership after settlement. Transferred/unassigned tickets therefore disappear on that fresh read. A counted gate covers overlapping local actions. Unknown assignment persistence remains uncertain and is not "confirmed" by a membership read. Session/identity/disposal fences cover both async reads and row-opening actions. Failed refresh clears old rows; failed next-page reads preserve the previous verified page/cursor for retry.

## Changed files

| File | Change |
|---|---|
| `server/src/services/support-writes.ts` | Shared bounded platform-support proof, self-assigned page, fixed UTC DTO and index gate |
| `server/src/routes/support-tickets.ts` | Actual authenticated/no-store `/assigned` route and exact query selectors |
| `server/migrations/20261105_05_support_assigned_queue.sql` (new, unapplied) | Exact assignee/ID paging index |
| `server/tests/support-writes.test.ts` | Canonical actor binding, 61-row paging/anchor transfer, schema/index/authority/input/date cases |
| `server/tests/m1-sprint-notification-support.test.ts` | Actual route privacy, refreshed transfer removal, cache and selector rejection |
| `src/features/support/assigned-queue.ts` (new) | Strict page parser and private reader/action lifecycle |
| `src/features/support/SupportAssignedQueue.tsx` (new) | Collapsed actual queue, status labels, bounded scrolling, refresh and next-page UI |
| `src/features/support/SupportAssignment.tsx` | Notify page around actual assignment save/retry/recovery actions |
| `src/pages/Support.tsx` | Queue/detail integration and counted assignment activity/revision gate |
| `src/lib/api-http.ts` | Canonical authenticated/no-store queue transport |
| `src/tests/support-assigned-queue.test.ts` (new) | DTO/transport, paging/failure, activity invalidation, read/action/session fences |
| `src/tests/m1-sprint-meeting-support-ui.test.ts` | Inert import export extended |
| `tmp/support-assignment-browser.cjs` | Optional `--assigned-queue` actual page journey and baseline regression |

Context: this record, queue contract, README, FEATURE_MATRIX, strategy 22, execution queue and previous-build pointer.

## Verification

Installed Node v24.19.0; no install. Commands:

```powershell
$businessNode = 'C:/Users/BaraaWael/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe'
& $businessNode --import ./node_modules/tsx/dist/loader.mjs --import ./server/tests/helpers/isolated-io-guard.ts --test --test-reporter=spec server/tests/support-writes.test.ts
& $businessNode --import ./node_modules/tsx/dist/loader.mjs --test --test-reporter=dot server/tests/m1-sprint-notification-support.test.ts
& $businessNode --import ./node_modules/tsx/dist/loader.mjs --test --test-reporter=dot src/tests/support-assigned-queue.test.ts src/tests/support-assignment.test.ts src/tests/support-private-notes.test.ts src/tests/support-write-attempt.test.ts src/tests/support-lesson-context.test.ts src/tests/support-reply-pagination.test.ts src/tests/m1-sprint-meeting-support-ui.test.ts
& $businessNode ./server/node_modules/typescript/bin/tsc -p server/tsconfig.json
& $businessNode ./node_modules/typescript/bin/tsc -p tsconfig.app.json --noEmit
& $businessNode ./node_modules/vite/bin/vite.js build
& $businessNode tmp/support-assignment-browser.cjs --assigned-queue
& $businessNode tmp/support-assignment-browser.cjs
& $businessNode tmp/support-write-browser.cjs
```

Scoped server **107 pass / 0 fail** (64 service, 43 actual-router), frontend **104 pass / 0 fail**. Both typechecks/backend compile and Vite build passed. Retained mixed-import, large-chunk and outdated Browserslist warnings; main JS approximately 3.60 MB before gzip. No full-project or production performance acceptance is asserted. The final visual change bounded the list's vertical scrolling; frontend build and assigned browser were repeated for that change.

Synthetic service tests run under isolated I/O guard; actual auth/router tests use local loopback HTTP with synthetic SQL. Server cases prove paging after cursor-ticket transfer, actor canonicalization, fixed DTOs/UTC instants, revoked grants, missing index/schema and rejected caller selectors. No real database was used.

The browser fixture bundles actual Support/queue/assignment components, controllers and API with inert navigation and synthetic intercepted responses. Verified no collapsed/requester assigned fetches, 25+1 visible assigned pages, assigned-row detail opening without mutation, membership refresh after lost-ack/recovery/transfer/unassignment, clearing after refresh failure and permission loss. Existing assignment journey still uses four deliberate assignment POSTs (one definitive stale rejection), zero public mutations and zero duplicate recovery POSTs. Final assigned-mode journey: **41 intercepted requests**. No page errors or horizontal overflow at 390/1024 pixels; mobile screenshot inspected.

Baseline assignment browser also passed: 28 requests, four deliberate assignment POSTs, historical GET recovery/current-state separation, opaque keys only, no requester fetches/errors/overflow. Existing support write browser passed: 12 requests, one create POST and one reply POST, two reloads and GET recovery, no duplication/errors/overflow.

Artifacts: `tmp/support-assignment-browser.html`, `tmp/support-assigned-queue-{390,1024}.png`, refreshed baseline assignment/write artifacts. These are synthetic browser journeys, not live API/MySQL integration.

## Readiness and next work

New migration 05 and existing assignment migration 04 remain unapplied. Queue reads are unavailable until actual schema and exact index proof pass; the general support flow retains its existing readiness. No Git/GitHub, real database/provider, package installation, deployment, migration application or spending.

This completes the planned local self-assigned view, not all J04 or all strategy. Tenant staff identities and scoped teacher inboxes, response-time policy and other contexts remain open. Real query plans/locking/load, foreign-key counter invalidation and receipt retention remain acceptance gates. Ordering is stable ID order and includes closed tickets; no priority sort, live snapshot, SLA or real-time revocation claim.

The next bounded business work is J02/J03 lesson-package video binding: inspect current source authority and delivery paths before defining/implementing the reference. Multiple contents per lesson and separate catalog/legacy progress remain the owner's recorded choices.
