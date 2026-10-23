# M2-01 join busy-recovery correction implemented, supervisor probes reproduced green and reported

- **Author:** WorkBuddy (client worker/coordinator)
- **UTC timestamp:** 2026-10-17T20:42:48Z (23:42 Cairo local)
- **Replies to:** `supervisor/054-m2-01-join-session-recovery-not-accepted.md`
- **Branch:** `codex/human-client`
- **Changed paths by this message:** `docs/streams/client/coordination/worker/034-join-busy-recovery-fixed-probes-green.md` (new file only)

## 1. Claim and task lifecycle

- Task `client-m2-01-join-session-recovery-20261017-04` was claimed **once** by the native
  worker `wb-m2-01-join-session-recovery-04a`. The claim returned the **exact seven** approved
  `allowedPaths` (unchanged from `047`); no mismatch, no second claim, no replacement worker,
  no nested spawn. No 429 and no tool-guard error occurred.
- Checkpoints were sent at natural milestones and exactly **one** `submit_task_report`
  (`status: reported`, receipt `awaiting_supervisor`) was submitted **inside the same
  continuous session as the claim**; the claim token never crossed a session boundary and
  appears in no file, report or message.
- `queue_status` after the report: `active: []`, `ready: []`, `blocked: []` — released by the
  report. **Acceptance remains with the coordinator** and is not claimed here.

## 2. The defect (054) and the fix — verified on disk by the coordinator

Defect (independently reproduced below): on a silent session replacement, Join's submit/reset
returned `'blocked'` **before** patching `busyKind`, so the guard-releasing `finally` left
`busyKind: 'submit' | 'reset'` behind — the operation had settled but the page's controls
stayed disabled forever — and the cached principal stayed old, so a deliberate next operation
could be misclassified as obsolete.

Fix, all inside the approved paths (confirmed on disk, file:line):

- `src/features/enrollment/workflows.ts` — a `busyOwner` guard ticket now tracks which
  operation owns `state.busyKind`; `retireObsoleteBusy(ticket)` (`~:289`) clears `busyKind`
  **only while the settling operation still owns the marker**, so a newer operation's marker is
  never cleared and the settled operation always ends `busyKind: null` (honest non-busy state).
  The obsolete branches of submit (`~:390`) and `requestPasswordReset` (`~:431`) call it on both
  success and failure paths.
- The ticket-scoped `guard.release(ticket)` in the `finally` (the 049 fencing) is unchanged and
  still guarantees an old `finally` cannot reset a newer operation.
- Principal reconciliation: submit/`requestPasswordReset` re-read the actual injected
  `readIdentity()` immediately after `guard.acquire()`, before capturing `principal` — a
  replacement **before** an operation starts cannot misclassify it — and
  `retireObsoleteBusy` also refreshes the cached `identity` from the real reader, so a
  deliberate current-principal retry captures the current principal, acquires the released
  latch and produces **exactly one** request: no reload, no session-bus event, **no automatic
  replay**.
- Preserved as required: form-input retention on failure, terminal facts (`submitted`/
  `resetSent` kept across an identity change per `051`), route/dispose guards, single-flight,
  and every 049/051 fence. `loadInvite`/`syncIdentity` keep their unconditional-retire roles and
  release busy ownership when they null `busyKind`. `JoinInstructor.tsx` was **not** changed
  (it reads controls' disabled state from `busyKind`, lines 78/81).
- `docs/streams/client/M2-CONTRACTS.md` — new §6 records the busy-ownership invariant.

## 3. Independent verification — reproduced by the coordinator, not relayed

Runtime for every run below: `C:/Users/BaraaWael/.workbuddy-ai/binaries/node/versions/22.22.2-6/node.exe node_modules/tsx/dist/cli.mjs`

- **Supervisor's 054 probe** (`C:/Users/BaraaWael/TabwebClientSupervisor/054-m2-join-busy.mts`,
  real production controller + deferred fixture transport): **46 tests, 46 pass, 0 fail** —
  the two failing selected probes (stuck `busyKind` after a silent replacement on submit and on
  reset) are fixed, and the current-session retry assertions that were previously unreachable
  are now exercised.
- **Supervisor's 049 probe** (`…/049-m2-mutation-races.mts`): **2 tests, 2 pass, 0 fail**.
- **Supervisor's 051 probe** (`…/051-m2-session-ownership.mts`): **40 tests, 40 pass, 0
  fail** — both replacement-identity counterexamples remain fixed.
- **Full client regression — all eleven `src/tests` suites**: **408 tests, 408 pass, 0 fail,
  0 cancelled, 0 skipped** (baseline before this round: 401; the +7 are this round's
  production-controller regressions: silent replacement during submit success / reset success,
  during submit failure / reset failure, replacement before an operation starts, and an
  obsolete completion never clearing a newer operation's busy marker). No M1 regression.
- **Full typecheck** — `./node_modules/.bin/tsc --noEmit -p tsconfig.app.json --pretty false`
  → exit 2 with **exactly the 11 known pre-existing out-of-scope diagnostics**
  (`NotificationBell.tsx:59`, `StudentHeader_OLD_BACKUP.tsx:496/510`,
  `ExamReports.tsx:78/82`, `ExamResults.tsx:104`, `Fees.tsx:483/497`,
  `StudentBarcodes.tsx:99`, `StudentDashboard.tsx:127`, `versionChecker.ts:28`) and
  **zero diagnostics in any file created or changed by this batch**.
- **Scope audit**: every changed/untracked path is inside the seven approved paths (the
  untracked `src/features/` contains only `enrollment/workflows.ts`), pre-existing
  uncommitted work, or the coordination mailbox. No `src/lib/**`, server, component, package,
  config, schema, migration, bridge, `tasks/state/approvals` or schedule change; nothing under
  `C:/Users/BaraaWael/TabwebClientSupervisor/` was modified.
- **Secret scan** across the diff and all changed files: no claim token, Bearer value or 40+
  hex string anywhere.

Per `053`'s distinction, the numbers above are the coordinator's **reproductions**, not the
worker's checkpoint claims.

## 4. Not done, deliberately

No automatic replay of any request; no new shared transport or session-listener module; no
`api-http.ts` / shared / server / router / package / schema / config edit; no OTP, payment or
entitlement policy; no status-propagation rewrite; no new batch, M3 or scope expansion; no
self-acceptance. No git write (add/commit/checkout/stash/merge/push), no dependency install,
no real DB/network/provider/Docker/browser run, no schedule, runtime or account change. All
pre-existing uncommitted work — the full M1 delta and every earlier M2-01 fix (049 mutation
fences, 051 ownership fences) — was preserved; nothing reverted. Only this new file was
created.

Next gate: the coordinator's acceptance review of 054's stuck-busy counterexamples against the
source and the production regressions above.
