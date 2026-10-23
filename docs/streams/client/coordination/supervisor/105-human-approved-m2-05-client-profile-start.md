# Human approved M2-05; WorkBuddy implements, Codex owns acceptance loop

UTC2026-10-19T05:24Z / Cairo08:24. Human replies to the concrete M2-05 proposal:
«ياعم موافق انجز بس واتعاملو مع بعض ومتطولوش ...». This explicitly approves
M2-05 and Codex/WorkBuddy review/correction iterations inside its exact scope.
No repeated human approval required for necessary same-scope fixes; no later
feature/server/schema/services authority inferred. Preserve all accepted work.

Task client-m2-05-dashboard-profile-20261019-01, frontend, five exact paths:

- src/pages/InstructorDashboard.tsx
- src/features/tenant/profile.ts
- src/lib/api-http.ts
- src/tests/m2-tenant-profile-ui.test.ts
- docs/streams/client/M2-05-CONTRACTS.md

Governing scope: ../../M2-05-PROPOSAL.md. Existing /instructor screen displays a
read-only server-confirmed institution identity using accepted101 profile API;
no new screen/route. Include loading/error/retry/no-authorized-workspace states,
runtime DTO validation and request/session/scope/dispose guards. No billing or
local-user fallback identity, no inferred paid access, no client tenant selectors.
All data/service impact is a read of an existing endpoint with mocked transport
in verification, not live API traffic. OTP deferred060.

api-http.ts exception is ONLY additive DTO/getMyTenantProfile using existing
authenticated request. No shared request/auth/error-contract change. Inspect
existing error semantics: do not invent HTTP status metadata discarded by the
transport. Use actual production error messages if sufficient; accurately record
any unavailable distinction, fail closed rather than fake404/permission success.
Keep page integration actually calling the tested seam. No copied implementation
in tests, probabilistic identity hashes, historical token registries or leaked keys.

Tests cover actual production transport canonical auth/path/no selectors, valid/
null/malformed DTO, failure+retry, permission/missing workspace outcomes, reversed
response completion, A-B-A session/scope and old error/finally vs new work, disposal
and clearing private identity. Meaningful production-path tests plus appropriate
existing client regressions and before/after frontend types; distinguish known11
outside diagnostics. No DOM/a11y/load/performance claim without actual evidence.

Inventory first, narrow complete edits, preserve unrelated accepted dirty code
including existing api-http additions. Do not refactor dashboard finance/stats/
countdown, accepted feature controllers, auth/router/backend or other files. No
schema/package/config/services/providers/DB/network/browser/install/Git/deploy.

WorkBuddy claims/implements natively through existing MCP; Codex does not claim,
edit active source or accept a report/count alone. Keep actual native IDs if
available, otherwise honest mapping limitation. Checkpoint at milestones, stop
before final report, no self-acceptance/new phases. On guard/429 stop once, no
retry/model/account workaround. Approval overrides old invocation's M1-only path
language for this exact batch; no edits to worker schedule/account configuration.

Codex reviews actual stopped source/diffs/architecture/contracts/tests/types.
Verified defects become exact bounded correction tasks only after predecessor
stops; same scope, no repeated approval or arbitrary work. Continuous075 cadence
persists through individual acceptance; M2-B01/101 and prior accepted batches
remain closed. No STOP merely for batch closure. Whole M2 still incomplete.

Activation verified in this turn: scope hash valid, dispatch active=[],ready=[M2-05],
blocked=[]. All22 prior accepted055/067/074/080/101 file hashes unchanged; five-path
start checkpoint saved externally105. Existing supervisor prompt now recognizes
105 and same-scope correction delegation, parses successfully; timer Ready/result0,
next08:30:09 Cairo, STOP/pending absent. No new timer/account/worker schedule changes.
No native claim/start observed yet; ready is not implementation liveness. No tests
or product source edits during preparation.
