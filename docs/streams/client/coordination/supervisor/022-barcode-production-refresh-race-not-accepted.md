# Barcode report reviewed: dependent absent-load race remains

UTC: 2026-10-16T19:02:27Z. Branch verified `codex/human-client`.
Read coordination README; latest worker MD remains 015. Consumed actual MCP result
for `client-m1-barcode-recovery-20261016-03`, reported at 18:53:40Z by
`wb-barcode-recovery-03c`. Report protocol requires worker stop before reporting.
Native IDs unavailable; report says implementation ran inside the coordinator
invocation, not spawned child processes. No fabricated run mapping.

`client-m1-edit-recovery-20261016-01` remains claimed by `wb-edit-recovery-01b`,
heartbeat 18:48:50Z at inspection, no result. Its source/test have changed; they
remain in-progress and were not edited or accepted. Original old claims remain
retired on the user/operator confirmation recorded in 021.

## Independent checks and source findings

- Existing managed Node22.22.2 + tsx attendance suite: **50/50 pass**.
- Full `tsc --noEmit -p tsconfig.app.json --pretty false`: 11 existing outside
  scope diagnostics, zero scoped page/test diagnostics at this observation.
  EditExam remains an active source snapshot; this is not its completed review.
- Both Barcode table consumers now use explicit paid/unpaid/unknown decisions;
  absent table handles unavailable attendance. No reinterpretation of billing
  policy is required to keep unknown from authorizing a payment. Scoped merged
  maps preserve entries across present/absent loaders.

However, `clearCommitted()` in the production controller clears rows/maps without
invalidating the pending absent computation. The two loaders have separate guards.
Verified real production sequence:

1. Successfully load today's attendance as an empty array.
2. Start absent computation, holding its nested previous-attendance request.
3. Start a fresh today load and reject its main request as offline.
4. Resolve the old absent computation's nested requests.

Expected absent rows remain empty after authoritative attendance load failure.
Actual: old computation repopulates `s1` and `s2` as absent. It also republishes
lookup maps after clearing. This violates the existing honest failure/stale-result
acceptance, despite all 50 current tests passing.

Reproduction preserved outside repository:
`C:/Users/BaraaWael/TabwebClientSupervisor/barcode-race-review.mts`.
It reuses the existing isolated test harness and imports the actual production
controller, appending one deferred regression; no controller implementation copied.
Run managed Node22.22.2 with `node_modules/tsx/dist/cli.mjs --test
--test-name-pattern supervisor:` and that file: **1 test, 1 assertion failure**,
actual absent rows contain both students. Initial reproduction failed to import a
Windows drive URL; corrected imports to file URLs before the behavioral run.
No source/test files under worker ownership were edited; no real student data,
services, HTTP, DB or browser used.

## Decision and finite follow-up

Barcode recovery is NOT accepted. Prepared new approved narrow continuation
`client-m1-barcode-refresh-race-20261016-03` after predecessor reported/stopped:
ONLY BarcodeAttendance.tsx and m1-sprint-attendance-ui.test.ts. Dispatch confirms
it ready; at the final dispatch check no active reservations remained, so the
EditExam state changed during this review. Its new completion evidence requires
its own source/result review and is not accepted here. Codex did not claim/start
any worker.

WorkBuddy: fence absent computations against the authoritative attendance snapshot
and refresh/failure lifecycle, clear dependent loading/state coherently, stop
superseded nested reads, and add the reproduced production regression. Preserve
correct scope/auth/payment/availability fixes. No expansion, calendar/billing policy
changes or shared/backend edits. Report after relevant tests/types and stop; no
self-acceptance. Keep the active EditExam owner's work untouched.

Consolidated verification follows these two finite corrections. No M1 completion,
M2 or live-service claims. User-authorized schedules continue; no new operational
stop condition observed. Remaining backend/performance contract notes stay separate.
