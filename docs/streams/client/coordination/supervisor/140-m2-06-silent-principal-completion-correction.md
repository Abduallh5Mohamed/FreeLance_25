# M2-06: prior findings fixed; one completion-order correction required

2026-10-19T16:28Z. Manual human status review, no scheduled review marker owned.
Worker058 stopped/reported; native session mapped by host metadata to
`ses_eab38a35fffeQZr5bVWUx2zP7g`, task
`client-m2-06-editor-lifecycle-correction-20261019-01`. Native exit0 and MCP
reported agree; this establishes completed execution, not acceptance.

## Independent evidence

Reviewed actual controller, dashboard wiring/rendering, additive PATCH adapter,
new tests and contract. Operation-owned phase/editor settlement and exact form
institution binding fix136. Ran real production tests using local Node22/tsx:
30 edit + unchanged38 read +61 nearby + unchanged3 external136 probes =132 pass.
Frontend `tsc -p tsconfig.app.json --noEmit` exits1: zero scoped errors, same11
outside diagnostics. No browser/DB/network/load/latency proof claimed.

## F3: retired GET completion bypasses silent principal observation

`src/features/tenant/profile.ts`, `runLoad`, BOTH success and catch branches:
`!sequence.isCurrent(generation)` calls `settleReadPhase` and returns BEFORE
`readPrincipal` / `adoptPrincipalChange`. The newly restored ready phase can
therefore render a prior session's institution and private draft after logout.

Reproduction: load tenant-a under session-a; open draft; start refresh GET;
start PATCH (retires GET's data generation); silently change principal to null;
resolve OR reject the GET while PATCH remains pending. Actual: ready tenant-a
and private draft remain. Expected: observe principal change before any phase
settlement; retire old operations and clear profile/draft. A stale payload must
still never commit, release a newer latch, or mutate the newer principal's state.

Two independent probes against the real production controller fail 0/2:
`C:/Users/BaraaWael/TabwebClientSupervisor/140-m2-06-silent-principal-probes.test.ts`.
Run this exact file unchanged, and136 unchanged. This is not a copied controller.

Required bounded fix: ensure success AND error completion observe/adopt a changed
canonical principal before stale phase settlement. Preserve existing generation,
form identity, silent A-B-A/session-event/dispose and old-finally protections.
Add production regressions for both outcomes and a new principal with a newer
pending request, proving stale completion cannot clear the newer state/latch.
No transport/auth/session-events change, new selector, extra request or policy.

## Handoff and limits

Same exact five paths under131; fresh task
`client-m2-06-principal-completion-correction-20261019-01` only after stopped058.
Codex grants read access only to the public external140 probe under human138;
other supervisor files remain denied. No product source edited by Codex.
OpenCode implements and stops/reports; Codex reviews actual stable evidence.
No acknowledgment needed. Do not reopen accepted earlier batches or claim M2 done.
Both timers continue; invoke immediate idle-worker handoff once after queuing.
OTP remains deferred. No new human approval needed for this bounded correction.
