# Business implementation — 2026-11-05, BUILD-13

Continues [BUILD-12](BUSINESS-IMPLEMENTATION-2026-11-05-BUILD-12.md). Contract: [J04 private support notes](../streams/server/J04-SUPPORT-PRIVATE-NOTES.md).

Follow-up: [BUILD-14](BUSINESS-IMPLEMENTATION-2026-11-05-BUILD-14.md) adds the versioned assignment/transfer backend locally; assignment UI and staff mapping remain open. Remaining-work statements below preserve the BUILD-13 checkpoint.

## Result

The actual Support page now has a separate, explicitly internal notes panel for authorized platform support. Notes never enter the requester-visible reply stream, change ticket status/public update time or trigger delivery. Current server permission proof is required for every read, write and recovery; ownership or a role label alone is insufficient. Closed-ticket notes do not reopen tickets.

Keyed note insertion and sanitized audit are atomic; identical replay is a no-op. Unknown commit recovery is read-only and uses the same opaque attempt key. The page distinguishes confirmed persistence from failed list refresh, clears stale/private rows when appropriate, and fences session/ticket changes.

## Changed files

| File | Change |
|---|---|
| `server/src/services/support-private-notes.ts` (new) | Actual schema/index gate, fixed DTO, UTC conversion and bounded same-ticket paging |
| `server/src/services/support-writes.ts` | Verified private-note authority, keyed insertion/audit and read-only recovery |
| `server/src/routes/support-tickets.ts` | Three real authenticated private-note endpoints |
| `server/migrations/20261105_03_support_private_notes.sql` (new, unapplied) | Separate immutable note table, foreign keys and paging index |
| `server/tests/support-writes.test.ts` | Isolation, authority, schema, replay, rollback, uncertain commit and paging cases |
| `server/tests/m1-sprint-notification-support.test.ts` | Mounted route privacy/authority and requester/public-surface regressions |
| `src/features/support/private-notes.ts` (new) | Strict parsers and private read/write lifecycle controller |
| `src/features/support/SupportPrivateNotes.tsx` (new) | Collapsed internal panel, recovery, paging and accessible editor |
| `src/features/support/session.ts` (new) | Shared existing in-memory session identity reader |
| `src/pages/Support.tsx` | Actual panel integration and shared session reader |
| `src/lib/api-http.ts` | Canonical authenticated/no-store private-note transport |
| `src/tests/support-private-notes.test.ts` (new) | DTO, canonical API, lifecycle, paging, recovery and refresh behavior |
| `src/tests/m1-sprint-meeting-support-ui.test.ts` | Existing inert fixture exports extended |
| `tmp/support-private-notes-browser.cjs` (new) | Real page/controller/API browser fixture with synthetic intercepted responses |

Context updated: this record, README, FEATURE_MATRIX, strategy 22, private-note contract and preceding J04 follow-up pointers.

## Verification

Installed Node v24.19.0, no installation. Exact scoped commands:

```powershell
$businessNode = 'C:/Users/BaraaWael/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe'
& $businessNode --import ./node_modules/tsx/dist/loader.mjs --import ./server/tests/helpers/isolated-io-guard.ts --test --test-reporter=spec server/tests/support-writes.test.ts
& $businessNode --import ./node_modules/tsx/dist/loader.mjs --test --test-reporter=spec server/tests/m1-sprint-notification-support.test.ts
& $businessNode --import ./node_modules/tsx/dist/loader.mjs --test --test-reporter=dot src/tests/support-private-notes.test.ts src/tests/support-write-attempt.test.ts src/tests/support-lesson-context.test.ts src/tests/support-reply-pagination.test.ts src/tests/m1-sprint-meeting-support-ui.test.ts
& $businessNode ./server/node_modules/typescript/bin/tsc -p server/tsconfig.json
& $businessNode ./node_modules/typescript/bin/tsc -p tsconfig.app.json --noEmit
& $businessNode ./node_modules/vite/bin/vite.js build
& $businessNode tmp/support-private-notes-browser.cjs
& $businessNode tmp/support-write-browser.cjs
```

Scoped server **84 pass / 0 fail**: 46 isolated service cases and 38 actual-router fixture cases. Frontend **74 pass / 0 fail**. Both typechecks and Vite build passed. Retained large-chunk/mixed-import warnings, approximately 3.58 MB main JS before gzip; no production performance claim. The final stored-record validation was followed by the 46 service cases and server typecheck; the accessible label adjustment was followed by browser verification and frontend typecheck/build.

Private-note browser evidence: 18 intercepted synthetic requests, two deliberate private-note POSTs, zero public mutations, zero private requests while collapsed and zero private requests from the requester view. Lost acknowledgement recovered after reload by GET without another POST; browser storage held UUID keys only. Confirmed save/list refresh failure stayed distinct, manual refresh recovered, and revoked authority cleared private rows. No page errors or horizontal overflow at 390/1024 pixels; mobile screenshot inspected. Existing support create/reply reload regression also passed: one create POST, one reply POST, two reloads, GET recovery, opaque keys only, 12 requests, no duplicates/overflow/page errors.

Browser fixtures bundle the actual page, controllers and transport; navigation headers are inert and responses are synthetic at an intercepted secure origin. They are not live backend/database acceptance. Service tests use in-memory transactional fixtures under the isolated I/O guard; the legacy actual-router suite uses local loopback HTTP and synthetic SQL. No live database/provider was contacted.

Artifacts: `tmp/support-private-notes-browser.html`, `tmp/support-private-notes-{390,1024}.png`, and existing support-write browser artifacts.

## Readiness and next work

Migration 03 is a file only and was not applied. Until real schema proof passes, private notes return unavailable while existing public support continues. No Git/GitHub, live data, real providers, deployment, spending or package installation was used.

Authority is the existing global platform-support grant, not tenant teacher ownership, assignment or staff membership. Scoped assignment/transfer and staff identity mapping, response-time policy and real MySQL/index/locking acceptance remain open. Replay holds while immutable resources remain stored; future hard deletion/retention needs a tombstone contract. The rest of the business strategy is not complete.
