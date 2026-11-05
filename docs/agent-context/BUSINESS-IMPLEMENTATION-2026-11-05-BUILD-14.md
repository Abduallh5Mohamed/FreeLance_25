# Business implementation — 2026-11-05, BUILD-14

Local backend continuation of [BUILD-13](BUSINESS-IMPLEMENTATION-2026-11-05-BUILD-13.md). [Assignment contract](../streams/server/J04-SUPPORT-ASSIGNMENT.md).

Follow-up: [BUILD-15](BUSINESS-IMPLEMENTATION-2026-11-05-BUILD-15.md) adds bounded eligible-recipient discovery and the actual claim/transfer/unassign UI locally. Backend-only and UI-pending statements below preserve the BUILD-14 checkpoint.

## Result and scope

Mounted support assignment read/write/recovery endpoints now support claim, transfer and unassignment for verified platform support. The existing assignee field is reused; a version counter prevents overwriting a later decision. Immutable keyed receipts preserve an original confirmed outcome after subsequent transfers. An assigned user must still hold current support authority; assignment grants no new access. Ticket owners and role-only callers cannot see or mutate assignments.

Update, receipt and sanitized audit are atomic; unknown commit is reconciled by actor/ticket-scoped GET. No-op attempts get receipts without changing assignment version, public ticket timestamp, status or reply history. Closed tickets reject new decisions while retaining prior receipts. Current-state reads withhold the name of a recipient who lost eligibility.

This is the backend slice, **not a completed assignment UI**. The actual picker, fresh current-state refresh after historical receipt recovery and private assigned queue are next. No frontend source changed or new browser journey was claimed.

## Changed files

| File | Change |
|---|---|
| `server/src/services/support-assignment.ts` (new) | Real schema gate, strict persisted version/state/receipt conversion |
| `server/src/services/support-writes.ts` | Live platform actor/recipient proof, versioned transfer/no-op, immutable attempt and atomic audit |
| `server/src/routes/support-tickets.ts` | Three actual authenticated/no-store assignment endpoints |
| `server/migrations/20261105_04_support_assignment.sql` (new, unapplied) | Counter on existing ticket and immutable attempt table |
| `server/tests/support-writes.test.ts` | Concurrency, stale decisions, recipient authority, rollback, lost commit, replay, malformed input/state and gates |
| `server/tests/m1-sprint-notification-support.test.ts` | Real route authority/projections/recovery/cache behavior and fixed synthetic `/mine` SQL projection |

Context: this record, assignment contract, README, FEATURE_MATRIX, strategy 22 and preceding-build follow-up.

## Verification

Installed Node v24.19.0, no install. Exact commands:

```powershell
$businessNode = 'C:/Users/BaraaWael/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe'
& $businessNode --import ./node_modules/tsx/dist/loader.mjs --import ./server/tests/helpers/isolated-io-guard.ts --test --test-reporter=spec server/tests/support-writes.test.ts
& $businessNode --import ./node_modules/tsx/dist/loader.mjs --test --test-reporter=spec server/tests/m1-sprint-notification-support.test.ts
& $businessNode ./server/node_modules/typescript/bin/tsc -p server/tsconfig.json
```

Final scoped results: **102 pass / 0 fail** (61 isolated service tests, 41 actual-router tests). Server TypeScript compile passed. The compile emits the backend build. No frontend changes, frontend build or full-project acceptance is asserted in this slice.

Service fixtures exercise the real transaction/service helpers under the isolated I/O guard with synthetic rows and serialized fake transactions. Route fixtures exercise actual auth/router paths with synthetic SQL and local loopback HTTP, including success/401/404/400 `no-store`, owner/role-label denial, schema failure, claim/transfer/stale/replay, distinct actor recovery, public projection and revoked permission. They are not a MySQL emulator or production concurrency evidence. Existing support/private-note/context tests remain included in these totals.

During verification, TypeScript required an explicit terminating return on missing receipt; fixed. A requester-list assertion exposed the legacy fixture returning whole rows despite the real SQL's fixed projection; corrected the fixture to project the actual eight selected fields. The final runs passed after both corrections.

## Remaining gates

Migration 04 was authored but **not applied**. Until actual receipt/counter schema passes runtime checks, assignment is unavailable; ordinary support remains operational within its prior schema requirements. No Git/GitHub, real DB/provider, migration application, package installation, deployment or spending.

Actual MySQL constraints/index/locking/load acceptance is pending. Assignment is global platform-support organization, not a new teacher/tenant staff inbox. Future user deletion or administrative writers must honor the version/invalidation contract; hard-delete/retention needs replay/tombstone policy. The next bounded slice is eligible-recipient discovery and the actual Support assignment UI, with session/target fences, opaque-key recovery and a separate fresh-state read after historical confirmation. Remaining business journeys are still open.
