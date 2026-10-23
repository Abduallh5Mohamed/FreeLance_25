# M2-B03 branch metadata foundation accepted within file-only scope

2026-10-19, direct CLI supervision under human148. Task
`client-m2-b03-tenant-branches-20261019-01` stopped/reported by
`opencode-cli-m2-b03-20261019`; native host maps the same owner to
`ses_eaaaf9ca7ffebNdgGtpMvC3hi3`, final native exit0. Read worker060 and actual
stable route, migration draft, contract and behavioral tests. No active owner
replaced/retired, no claim token/private state inspected, no source edited by Codex.

## Decision and architecture

Accept exact148 four-path implementation: additive tenant_branches migration
FILE; GET/POST branches and PATCH branchId in existing tenant-self router;
isolated tests; API contract. This is source/isolated-contract acceptance ONLY.
Migration was not applied; runtime branch functionality is not proven available.

Verified server-selected tenant and real owner/active tenant/user rows; writes
recheck under row locks; role labels do not grant authority. Local billingOnly
denial happens before connection acquisition, preserving shared auth/profile/
billing behavior. All branch lookups/updates qualify tenant AND id; foreign and
absent ids have the same404. Payload/name/status validation, no row spread,
bounded keyset page default25/max100, no-store before own awaits/errors.

Write + audit use one transaction; identical PATCH is a no-op, failed audit never
commits, failed rollback and ambiguous commit destroy connection instead of
pooling it. No automatic POST retry or false idempotency claim. Branch archive
is metadata only, not enrollment/group/teacher/financial access policy. Keyset
bounds do not imply a frozen multi-page snapshot under concurrent insertions.

Migration static review: single new InnoDB table, UUID id and tenant FK consistent
with inspected tenant schema, active/archive enum and tenant/id indexes; no
ALTER/DROP/backfill/runtime DDL. SQL constraints, deployment compatibility and
real concurrency remain an unexecuted separately authorized integration gate.

## Independent evidence and exact limits

Fresh safe verification evidence:44 branch + unchanged20 profile-read +31
profile-write =95 passing real-handler tests with positive import interception.
Four additional external independent real-handler probes at
`C:/Users/BaraaWael/TabwebClientSupervisor/151-b03-independent-probes.test.ts`
pass4/4: billingOnly all-route no-DB denial, invalid list input no-DB denial,
tenant-qualified foreign branch + failed rollback disposal, audit failure plus
rollback failure with no commit/release. External probes positively intercept all
three default adapter modules before loading route; no copied production logic.
Accepted isolated evidence total99 tests, not a latency/performance benchmark.

Actual broader118-test command also passed, but23 legacy tests from
m1-expanded-tenant-admin/auth-boundary construct/import default adapters or
dotenv. Including these was a Codex verification-selection error: I batched
execution before inspecting both old test import paths. Do not repeat those
suites under the positive-isolation rule. Their pass is NOT used as isolation or
provider/environment safety evidence. Worker060's broad-run count must not be
read as proof all118 imports were positively isolated. No live HTTP/DB/DDL
verification claimed. All test processes ended; no test service left running.

Server installed tsc `--noEmit -p server/tsconfig.json`: fresh exit0, zero
diagnostics. Its include is src only; test files are exercised at runtime, not
type-checked by this command. Worker recorded its own baseline separately.
`git diff --check` on route exits0. Optional ESLint is not clean: worker measured
80 rule errors on route/new suite. Same rule names on an old suite do NOT prove
new warnings are preexisting; no such clean/preexisting claim is accepted here.

Byte preservation check performed ONLY IN MEMORY (no reconstructed source file
written): removing the two new B03 blocks and reversing one subscription-route
indentation change yields the exact SHA256 of accepted129 tenant-self.ts.
Thus existing accepted route code is byte-identical except that harmless indent.
All five accepted144 client hashes unchanged. Exact current four-path hashes
recorded in external151 checkpoint and supervisor ledger.

## Continuation and operation

Both schedulers remain DISABLED by direct human instruction. No pending timer
promise, no STOP for this acceptance, no acknowledgement or reopening requested.
No model active after this stopped task. CLI review/correction workflow is ready
for applicable next approved scope; never manufacture implementation from an
empty queue. Same-four-path necessary corrections need no new gate if verified.

This closes branch metadata source foundation only, not branch assignment/RBAC,
UI, migration application, full C1, C2-C12 or whole M2. OTP stays deferred.
Next Codex coordination owner identifies branch UI/integration scope against
the accepted contract and records its limits before any new product-path work.
No broader schema/service/provider/network/Git/deploy authority inferred.
