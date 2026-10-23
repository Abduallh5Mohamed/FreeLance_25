# M2-06 not accepted: settled UI lifetimes and response identity

Review9f310ae5-ea1c-476b-999b-be28ac1700b9,2026-10-19. Worker057 explicitly
stopped, native MCP task reported by original owner; session coordinator mapping
ses_eab5c7b62ffeglHtH1qBRc8eRV. No active claims at inspection. Source stable for
review; direct-Node recovery134 reached an actual submission, not proof of root
cause or permanent runtime stability. Preserve all partial/accepted dirty work.

Independently inspected exact five131 paths, form/controller/actual request adapter
and tests/contracts. Canonical additive PATCH/no tenant selectors, server authority,
failure draft retention and explicit uncertain-write reconciliation are present.
Local Node22.22.2 --import tsx --test:23 edit+38 unchanged read+61 nearby catalog
tests all pass (122). Frontend tsc: zero scoped errors/same11 outside, exit1.
Those passing tests omit the failing conditions below: NOT ACCEPTED.

Three independent production-controller probes fail at absolute path:
C:/Users/BaraaWael/TabwebClientSupervisor/136-m2-06-review-probes.test.ts.
Run node --import tsx --test with that exact path using installed local tools.
No production implementation copied, DB/browser/network/provider involved.

## F1: generation fences drop data but strand presentation state

profile.ts runLoad/runSave share sequence, but stale completion returns before
settling the state it owns, and finally releases only the latch:
1. Save starts -> newer refresh GET commits -> old save resolves: card keeps newer
   data, but edit.status remains saving forever. Dashboard disables input/save/
   cancel and openEditor refuses; no usable recovery even though requests settled.
2. Refresh GET starts -> save starts and rejects with documented owner denial ->
   older GET settles ignored: phase remains loading forever, hiding valid profile
   and retained draft. All network promises are complete.

Fix operation-owned busy/read/edit lifetime cleanup separately from profile data
generation fencing. Preserve valid current identity/draft and settle retired
loading/saving into usable truthful state, without letting old finally alter a
newer form/request or claiming success/rollback of uncertain writes. No automatic
PATCH retry or extra uncontrolled reads. Existing success-only race tests assert
profile values but omit these stranded phases: extend real production assertions
to complete state, usable deliberate retry, success/error reversals and newer busy.
Do not remove generation guards or weaken unchanged38 read regressions.

## F2: valid foreign-institution DTO can commit on save

runSave validates four-field shape/current principal but never matches returned
tenant.id to editor/request's institution. Probe opens tenant-a, saves, receives
well-formed tenant-b under unchanged principal; tenant-b commits to the card and
form closes as success. Required131 scope binds selected-profile identity as well
as session. A valid shape alone is insufficient.

Bind form/save to exact current confirmed institution identity, invalidate a form
if a current read changes its target, and reject mismatched success DTO as uncertain
without foreign profile commit, draft loss, fake success or automatic retry. Keep
backend selected authority and canonical transport; never add client tenant
selectors/headers or infer owner/capability from local state. No lossy IDs/history.
Tests must cover mismatch and ordinary matching server-authoritative success.

## Bounded next task

client-m2-06-editor-lifecycle-correction-20261019-01, SAME five131 paths after
stopped/reported057. Existing approval131 covers necessary corrections. OpenCode
inventories actual partial state, fixes F1/F2 and contract, runs external3 probes,
unchanged38 read suite, meaningful edit/nearby tests and scoped types, then stops
and reports. No rewrite/shared request/auth/backend/schema/services/installs/Git/
new feature or policy. Codex independently reviews; no self-acceptance.

Human131 handoff helper invoked once after ready task creation: idle starts now;
busy native process is preserved and next15minute check dispatches. Next invocation
model follows human135 alternative free-model request, no higher-quota guarantee.
No per-batch STOP; OTP deferred, whole M2 incomplete. Remove own matching marker.
