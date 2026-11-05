# Business implementation — 2026-11-05, BUILD-15

Continues [BUILD-14](BUSINESS-IMPLEMENTATION-2026-11-05-BUILD-14.md). Contract: [J04 assignment](../streams/server/J04-SUPPORT-ASSIGNMENT.md). Maintained next-work list: [business execution queue](BUSINESS-EXECUTION-QUEUE.md).

Follow-up: [BUILD-16](BUSINESS-IMPLEMENTATION-2026-11-05-BUILD-16.md) implements the actual private self-assigned view and transfer-triggered refresh locally, with an unapplied paging-index migration. Assigned-queue pending statements below preserve the BUILD-15 checkpoint.

## Result

The actual Support page now has a collapsed assignment panel: claim for the current account, select and transfer to a server-listed eligible platform-support recipient, unassign, and explicitly refresh. Opening the panel performs the first assignment read; requester views never request assignment data. Recipient discovery returns fixed ID/name projections in 25-row keyset pages with a 26-row lookahead, active/non-suspended/current permission predicates and ticket-scoped caller authority. POST still repeats live locked recipient proof; appearing in a selector is not authority.

Writes pin the displayed assignment version. A confirmed historical receipt is followed by a separate fresh current-state read, so recovering an earlier claim cannot replace a later transfer in the UI. A confirmed write followed by a failed refresh stays confirmed and clears obsolete state. Lost permission/session/ticket lifecycle fences clear private views and reject late responses.

Only the opaque UUID is persisted under account/operation/ticket in sessionStorage. Unknown outcomes block fresh decisions; explicit same-payload/version/key retry is offered only while the original payload is still in memory. Reload recovery is GET-only without reconstructing or persisting the payload. Missing receipt remains uncertain. A known missing-attempt result is not permission to rotate keys. A permanently unresolved attempt after reload still needs a future explicit operational resolution policy; this change adds no unsafe reset.

The generic support-attempt helper gained an optional definitive-rejection predicate, used only by assignment. Exact HTTP 409 codes STALE, TICKET_CLOSED and ASSIGNEE_UNAVAILABLE represent server rejection before mutation; local key cleanup and a fresh read precede a new explicit decision. Generic conflicts/network failures remain uncertain. Failed cleanup blocks fresh decisions. Server-observed closure blocks new assignment decisions for the lifetime of that panel even if its parent ticket snapshot was open.

## Changed files

| File | Change |
|---|---|
| `server/src/services/support-writes.ts` | Authorized bounded recipient discovery with explicit projection and current permission predicates |
| `server/src/routes/support-tickets.ts` | Real no-store candidate endpoint and exact query handling |
| `server/tests/support-writes.test.ts` | Multi-page recipient filtering, authority, schema and bounds |
| `server/tests/m1-sprint-notification-support.test.ts` | Actual candidate router/cache/input/permission regressions |
| `src/features/support/assignment.ts` (new) | Strict DTOs, fenced state/recipient controller, known rejection and historical recovery handling |
| `src/features/support/SupportAssignment.tsx` (new) | Actual accessible claim/transfer/unassign panel and explicit candidate paging |
| `src/features/support/write-attempt.ts` | Opt-in definitive-rejection handling; existing operations unchanged by default |
| `src/pages/Support.tsx` | Actual panel integration under existing admin UI hint; backend remains authority |
| `src/lib/api-http.ts` | Canonical assignment reads, candidate pages, keyed writes and recovery |
| `src/tests/support-assignment.test.ts` (new) | Strict DTOs/transport, versioned save/recovery, stale/closed targets, storage failure, read/write lifecycle fences and paging |
| `src/tests/m1-sprint-meeting-support-ui.test.ts` | Inert API exports extended to import the actual page |
| `tmp/support-assignment-browser.cjs` (new) | Actual Support page/controller/API synthetic browser journey |

Context: this record, execution queue, README, FEATURE_MATRIX, strategy 22, assignment contract and prior-build pointer.

## Verification

Installed Node v24.19.0, no installation. Exact commands:

```powershell
$businessNode = 'C:/Users/BaraaWael/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe'
& $businessNode --import ./node_modules/tsx/dist/loader.mjs --import ./server/tests/helpers/isolated-io-guard.ts --test --test-reporter=dot server/tests/support-writes.test.ts
& $businessNode --import ./node_modules/tsx/dist/loader.mjs --test --test-reporter=dot server/tests/m1-sprint-notification-support.test.ts
& $businessNode --import ./node_modules/tsx/dist/loader.mjs --test --test-reporter=spec src/tests/support-assignment.test.ts src/tests/support-private-notes.test.ts src/tests/support-write-attempt.test.ts src/tests/support-lesson-context.test.ts src/tests/support-reply-pagination.test.ts src/tests/m1-sprint-meeting-support-ui.test.ts
& $businessNode ./server/node_modules/typescript/bin/tsc -p server/tsconfig.json
& $businessNode ./node_modules/typescript/bin/tsc -p tsconfig.app.json --noEmit
& $businessNode ./node_modules/vite/bin/vite.js build
& $businessNode tmp/support-assignment-browser.cjs
& $businessNode tmp/support-private-notes-browser.cjs
& $businessNode tmp/support-write-browser.cjs
```

Scoped server **104 pass / 0 fail** (62 service, 42 actual-router), frontend **93 pass / 0 fail**. Both typechecks/backend compile and frontend build passed; retained chunk-size/mixed-import and outdated Browserslist warnings. Main JS approximately 3.60 MB before gzip; no production performance or full-project acceptance asserted. A guarded external-value TypeScript narrowing issue was fixed before the final check. Final closure/lifecycle changes were followed by the scoped frontend suite, typecheck/build and assignment browser rerun.

The new browser fixture bundles the real Support page, panel, controllers and API with inert navigation headers and synthetic intercepted responses; all other origins are aborted. Four deliberate assignment POSTs include one definitive stale rejection; no public mutations, duplicate recovery POSTs, page errors or requester assignment requests. Verified lost acknowledgement/reload GET recovery, newer assignment preserved, confirmed save/read failure separation, stale-decision reload, unassignment and revoked authority clearing. 28 requests; no horizontal overflow at 390/1024 pixels. Mobile screenshot visually inspected.

Existing private-note browser regression also passed (18 requests, two deliberate note POSTs, no public mutations/requester private requests, GET reload recovery, refresh-error separation and revocation clearing). Existing keyed support creation/reply browser regression passed (12 requests, one create POST, one reply POST, two reloads, opaque UUIDs only, no duplication/overflow/page errors).

Service tests use synthetic transactional rows under isolated I/O guard. Actual-router tests use local loopback HTTP with synthetic SQL and no MySQL. Browser tests are not live backend integration or performance measurements. Artifacts: `tmp/support-assignment-browser.html`, `tmp/support-assignment-{390,1024}.png` and refreshed existing support browser artifacts.

## Readiness and next work

No new migration in this slice. BUILD-14's migration 04 remains **unapplied**; without actual schema proof, discovery/assignment fail closed while ordinary support retains prior behavior. No Git/GitHub, real database/provider, package installation, deployment, migration application or spending.

This remains global platform support. Assigned-only queue, response-time handling, tenant staff identity/authority and remaining context kinds are open. Runtime MySQL locks, query plans/load, schema constraints, administrative deletion/counter invalidation and immutable receipt retention need operational acceptance. No real-time revocation or cancellation of database commits by browser timeout is claimed. The overall business plan remains partial; consult the execution queue for J00–J10.
