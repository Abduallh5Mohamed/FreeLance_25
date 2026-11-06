# Batch A — independent Codex review — 6 November 2026

Decision: **correction required; not accepted**. No next business journey yet.
Implementation remains OpenCode-owned. Read
[the allocated correction](OPENCODE-BUSINESS-BATCH-A-CORRECTION-01.md) for exact
reproductions, architecture and required acceptance cases.

## Reviewed snapshot and scope

Original native OpenCode session stopped with exit 0. Actual owner/host process
absence was verified before independent tests. A substantive original report
exists, but it was not submitted through MCP. Same-session report-only recovery
also stopped and stated original claim context unavailable; there was no quota
or tool-denial indication in that recovery. Supervisor formally retired that
terminated claim with explicit evidence, preserving source/report and token
fencing; it was not retired due to lease age. Old WorkBuddy reservation untouched.

Ordinary-file comparison against the pre-dispatch baseline identified 19 allocated
changed/new files. None of the old WorkBuddy reserved paths had a modification
timestamp after dispatch in the bounded check. Real template router/service and
tenant-self mount, private Courses.tsx UI, timing helpers and migrations exist.
This is source evidence, not migration application or complete behavior acceptance.

## Independent commands and results

Using installed compatible Node explicitly, after native product work stopped:

```powershell
$businessNode='C:/Users/BaraaWael/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe'
& $businessNode --import ./node_modules/tsx/dist/loader.mjs --import ./server/tests/helpers/isolated-io-guard.ts --test --test-reporter=spec server/tests/lesson-package-templates.test.ts server/tests/lesson-package-timing.test.ts server/tests/lesson-package-reuse.test.ts
$frontendTests=@(Get-ChildItem src/tests/*.test.ts | ForEach-Object {$_.FullName}) + @('src/auth/access-control.test.ts')
& $businessNode --import ./node_modules/tsx/dist/loader.mjs --test --test-reporter=spec @frontendTests
& $businessNode ./node_modules/typescript/bin/tsc -p tsconfig.app.json --noEmit
& $businessNode ./server/node_modules/typescript/bin/tsc -p server/tsconfig.json
& $businessNode ./node_modules/vite/bin/vite.js build
```

All exit 0. Scoped backend: **35 pass / 0 fail**. Full frontend: **2118 pass /
0 fail**. Both type checks/server compilation and Vite build pass; main chunk
warning remains (~3.77 MB minified / ~1.07 MB gzip). The original report's five
registerHooks failures disappear under the required compatible runtime; they are
not product defects. Full backend/premium-lecture acceptance was not rerun.

Independent logs: `D:/Automation/TabwebBusinessSupervisor/review-a-{server,frontend,types,server-types,vite}.txt`.
Additional reviewer diagnostic script/output:
`D:/Automation/TabwebBusinessSupervisor/review-a-probes.mts` and `.txt`.
No raw native/MCP output, credentials or claim tokens were saved in these logs.

## Acceptance failures

1. **Library write uncertainty (P1)**: a synthetic create commits, then its reply
   rejects. The real controller unfreezes and says no revision was created.
   Durable idempotency/recovery and truthful uncertain-state handling are missing
   for library create/revise/archive. Archive also lacks the standard deadline.
2. **Actual parent navigation (P1)**: real component callbacks can switch to
   create or close application while child state is uncertain, discarding its
   in-memory receipt context. Child dropdown disabling alone does not protect it.
3. **Principal/privacy fencing (P1)**: real library controller's next-page
   response after A→B principal change leaves one A-owned row visible/loading.
   Its current() guard includes principal equality, making the later invalidation
   branch unreachable. Manual source/revision reads and parent retained selectors
   need equivalent fencing/hiding and bounded page state.
4. **Revision history/selection (P1/P2)**: UI fetches only first revision page,
   automatically selects its last item and does not clear an existing review
   when that asynchronous selection changes. Wrong/stale displayed selection
   must not be applied; add bounded current-template history paging and binding.
5. **Schema/stored-state checks (P1)**: isolated actual new-schema gate accepts
   nullable VARCHAR(1) for every new field when names/engines/index names match.
   Check types/lengths/nullability/collations/relationships and complete stored
   position/count/hash invariants before mutation.
6. **Coverage gap**: existing template backend begin/commit/rollback fixture is
   a no-op and cannot prove atomic rollback. New frontend suites do not invoke
   actual template UI callbacks. Add real transactional state failure tests and
   actual UI lifecycle/navigation tests; green existing counts do not prove them.

Diagnostic probes use synthetic dependencies and actual controller/component
callbacks; they are not a real MySQL/browser run. Corrections preserve the
separate quiz pin/publication/progress/access boundaries and existing direct
reuse contracts. No Git/GitHub, live DB, migration application, provider, install
or deployment occurred.

## Current handoff

`business-20261106-a-correction-01` has a new disjoint 24-path allocation and
22 existing-file baselines. Initial attempt stopped before claim when OpenCode
refused reads of external bridge task JSON. Those reads remain denied; no config,
permissions, model/account or shell/copy workaround is authorized. The intended
approved MCP claim/scope interface is the safer route; if it is denied too, stop.
Only a genuine correction report and independent rerun can close these findings.
