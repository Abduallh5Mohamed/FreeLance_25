# M2-04: 078 fixed; remaining scope incarnation defects, not accepted

Review UTC2026-10-18T21:01Z / Cairo2026-10-19. Branch codex/human-client.
Read governing075/068, handoff, remaining inventory/README and new worker045.
Correction client-m2-04-instructor-students-correction-20261018-01 reported at
20:56:41Z; worker045 states all activity stopped. No native session mapping
available; workerId wb-m2-04-instructor-students-correction-01a is coordination
identity only. No age-based retirement or substitute worker started by Codex.

## Independent source and test review

Actual page/controller/tests/contracts read, not report-count acceptance.
078 fixes are present: centralized observed principal adoption clears old cached
private state, post-refresh stillBound fences and link incarnation prevent old
copy from certifying new link. Previous three external078 probes independently
pass unchanged. All577 client tests pass in same run (580 including078 probes).
Frontend tsc nonzero with same11 outside diagnostics, zero scoped. No live/DOM/
performance claim; injected production orchestration is real page integration.

Two additional production-path probes FAIL in external artifact
C:/Users/BaraaWael/TabwebClientSupervisor/079-m2-04-scope-probes.test.ts:

1. Scope A -> B -> A while a decision is awaiting transport, same principal:
   old decision returns approved. stillBound only compares scope ID, so return
   to A revives the old scope. Need monotonic scope lifetime captured by every
   mutation and validated after all awaits, success/error/refresh/page outcomes.
   Preserve read generations, link/form incarnation and server write authority.
2. Scope A -> B while a decision is awaiting transport: B's legitimate decision
   returns duplicate because adoptScope invalidates reads but never releases
   mutation guards/busy state. Retire old scope's operations synchronously and
   permit new scope work. Old finally must never release newer ticket, including
   when old response completes during newer transport. Test real controller,
   both success/error/refresh paths and A-B-A. No automatic server retry.

These probes explicitly hold principal constant to isolate the scope contract;
they establish controller scope lifetime failures, not a demonstrated live
cross-account exploit. Existing handoff already requires scope changes/A-B-A and
old-finally ownership; no new product feature or shared authority is requested.

## Decision / next work

Not accepted. Prepare client-m2-04-instructor-students-scope-correction-20261018-01
after verifying no active owners; same exact four M2-04 paths. Preserve existing
implementation and all66 tests, add meaningful regressions, update contracts,
run client tests/types and both external probes before stopped report. WorkBuddy
alone claims/implements. No broad rewrite, backend/shared/auth/API/router edits,
new policies/services, or self acceptance. Current client-only ownership holds.

076 resolves outside-developer question: only Codex+WorkBuddy execute, no external
delivery is awaited. M2-B01 proposal remains prepared, not approved/queued. Missing
future contracts stay narrow, do not invent completion or implementation scope.
Continuous075 timer remains enabled; no batch STOP, cancellation or429 occurred.
Clear only this review's21:00:11.7072929Z marker after correction verification.

Verified21:01:47Z: correction approval hash valid, active=[],ready=[scope correction],
blocked=[]. Fifteen accepted055/067/074 file hashes unchanged. Timer Ready,
last result0, next00:15:09 Cairo; STOP absent. Own exact pending marker removed.
