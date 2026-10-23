# M2-07 review: three verified defects require same-six-path correction

Review `c5c73663-c0ca-4008-a8a6-17a9d23e53dd`,2026-10-19.
Worker061 stopped/reported, existing task client-m2-07-branch-management-ui-
20261019-01; native same-session map ses_eaa82fdbaffex8u7Fh6fDGvAke.160 exact
recovery instruction delivered and native MCP report now present; consumed061.
This resolves reporting interruption, not product acceptance.

## Fresh independent verification and architecture

Read actual stable branches.ts, BranchManager.tsx, adapters, dashboard mount and
tests. Dedicated render component/injected lifecycle/canonical transport split
is appropriate; additive adapters preserve shared request and accepted profile.
Ran local Node22/tsx explicit43 branch+38 read+33 edit+61 helper tests:175 pass,
exit0. Frontend tsc exit1: zero scoped diagnostics, same11 outside. No whole-project
clean, live DB/browser/provider or unmeasured speed/scalability claim.

Five external production-path probes FAIL0/5 at
`C:/Users/BaraaWael/TabwebClientSupervisor/161-m2-07-independent-probes.test.ts`.
Run this exact absolute file unchanged; worker may read only that public probe,
never edit it. Four drive real DTO/controller; fifth drives real controller's
post-conflict state into actual production component with injected hook snapshot
and real React server rendering. No copied render decision or browser/DOM claim.
The Node-only classic JSX harness supplies React locally and restores hooks/globals;
do not change production JSX to address the already-fixed harness setup.

## F1 — request limit does not enforce a response memory bound

branches.ts `parseTenantBranchList` iterates every response row and `runRead`
stores all of them. A26-row well-formed response is accepted; held rows26 even
though limit25, controller/doc/test claim <=25. Source contract/runtime validation
must enforce the bound, not rely only on the request/server promise.
Fix: reject oversized pages BEFORE row traversal/copy (no silent truncation/
fabricated cursor), show malformed-response error, never retain >25 held rows.
Regression: legitimate25 accepted;26 rejected by parser AND real controller.
Do not claim total HTTP parsing memory bounded without shared transport evidence.

## F2 — loss of list authorization leaves private form visible

branches.ts `runRead` failure clears rows/cursors but not form/target/draft or
lastConfirmed/mutation state. Component renders an open form independently of
phase. Repro: open valid row; open rename with private draft; refresh rejects
`Token expired` OR `Forbidden`. Rows clear but form remains rename with private
draft, still rendered and actionable under unauthorized/denied phase.
Fix: definite read authorization/scope loss clears private rows, form, target,
draft and confirmation and invalidates older in-flight operations; preserve the
truthful failure phase/message. An old write/read must not repopulate cleared
private state. Do not erase draft on ordinary retryable network/500 read failure
as though permission loss were proven; distinguish those conditions. Existing
write-denial retention and uncertain-write semantics must remain appropriate.
Regressions cover both errors plus late pending mutation after loss and successful
authorized retry, with existing session/form/page/finally guards unchanged.

## F3 — status action remains disabled after definite failure

BranchManager.tsx status button condition includes
`mutation.kind==='status' && mutation.targetId===row.id` even when status is
idle. A409 conflict leaves controller mutation idle but retains kind/target for
error context; actual component still renders archive button disabled forever.
Repro: open row; setStatus archived rejects `Branch was modified concurrently`;
assert actual rendered archive button can be clicked for deliberate retry. It is
disabled in external probe5. Fix disabled state to reflect an actual busy operation
and legitimate form constraints; error target alone must not be a permanent latch.
Prove idle-after-conflict retry enabled and true saving/duplicate flight disabled.
Keep uncertainty warnings, no automatic write retry or unrelated operation needed
to unlock the failed row. Component/controller production behavior regression.

## Dispatch

No acceptance. Fresh correction `client-m2-07-ui-guard-correction-20261019-01`
under human152 same SIX153 paths only, after reported061 stopped. Preserve all
good partial work/accepted144/151, no whole rewrite/new feature/role/API/shared
auth/backend/schema change. Grant READ only exact public161 test under138; no
TEMP grants or rejected-action bypass. Required suites/types and honest contract,
no optional lint/TEMP differential experiments. Stop/report before acceptance.
Codex invokes direct handoff once; busy owner preserved. Supervisor10min continues.
Remove only this review's matching marker at end; no acknowledgment requested.
