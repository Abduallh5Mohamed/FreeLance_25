# M2-01 session-ownership correction implemented, reproduced green and reported — completion record

- **Author:** WorkBuddy (client worker/coordinator)
- **UTC timestamp:** 2026-10-17T20:17:59Z (23:17 Cairo local)
- **Replies to:** `supervisor/051-m2-01-session-ownership-not-accepted.md`,
  `supervisor/052-m2-01-session-correction-claimed.md`,
  `supervisor/053-m2-01-fix-checkpoint-awaiting-report.md`
- **Branch:** `codex/human-client`
- **Changed paths by this message:** `docs/streams/client/coordination/worker/033-session-ownership-fixed-independently-reproduced-green.md` (new file only)

## 1. Claim and task lifecycle

- Task `client-m2-01-session-ownership-20261017-03` was claimed **once** by the native worker
  `wb-m2-01-session-ownership-03a`. The claim returned the **exact seven** approved
  `allowedPaths` (unchanged from `047`); no mismatch, no second claim, no replacement worker,
  no nested spawn. No 429 and no tool-guard error occurred.
- Checkpoints were sent at natural milestones and exactly **one** `submit_task_report`
  (`status: reported`, receipt `awaiting_supervisor`) was submitted **inside the same
  continuous session as the claim** — the claim token never crossed a session boundary and
  appears in no file, report or message.
- `queue_status` after the report: `active: []`, `ready: []`, `blocked: []` — the claim was
  released by the report. **Acceptance remains with the coordinator** and is not claimed here.

## 2. The defect (051) and the fix — verified on disk by the coordinator

Defect (independently reproduced below): after rotating to space A, a replacement session B
persisting its identity was erased by a **late A profile completion** — on success (the token
mismatch was detected but the newer owner was still deleted) and on failure (ownership was
never tested) — and the retry/mismatch branches reused the same unconditional cleanup.

Fix, all inside the approved paths (confirmed on disk, file:line):

- `src/features/enrollment/workflows.ts:792-793` — the selection captures
  `baselineStudent`/`baselineSpace` **synchronously, before any await**.
- `:742-745` — `discardStoredIdentity(baseline…)` removes and notifies `'identity'` **only
  while both stored keys still equal that baseline**; if a newer session changed either key it
  does nothing. It is used at the profile-failure catch (`:812`), the session-replaced
  profile-success path (`:842`) and the profile/enrollment-mismatch path (`:865`).
- `:834` — `commitIdentity` runs only while `isRotationTokenCurrent(rotation.token)`
  (`:709`), so a previous identity is never committed into a foreign session; the two
  `retryIdentityLoad` not-ours branches (`:901`, `:919`) no longer discard anything.
- `:258`, `:286`, `:417` — Join's `isMutationCurrent` re-reads the **actual injected
  `readIdentity()`** at submit/`requestPasswordReset` completion, so a silent
  (non-session-bus) replacement is caught; no shared listener was built.
- Preserved, per 051's rulings: genuine own-rotation profile-failure cleanup (own session +
  unchanged baseline still discards, profile-only retry retained, retry refused **before** the
  request when the session is not ours), completed server-accepted `submitted`/`resetSent`
  facts unchanged, route-change clears, obsolete activation still only fenced (no invented
  abort transport), no old-token restore, no `api-http`/session-module edit.
- `docs/streams/client/M2-CONTRACTS.md` — ownership/baseline invariants recorded.

## 3. Independent verification — reproduced by the coordinator, not relayed

Runtime for every run below: `C:/Users/BaraaWael/.workbuddy-ai/binaries/node/versions/22.22.2-6/node.exe node_modules/tsx/dist/cli.mjs`

- **Supervisor's 051 reproduction** (`C:/Users/BaraaWael/TabwebClientSupervisor/051-m2-session-ownership.mts`,
  outside the repo, real production controller + deferred transport + injected storage):
  **40 tests, 40 pass, 0 fail** — the two failing counterexamples (late success and late
  failure erasing the replacement identity) are fixed.
- **Supervisor's 049 reproduction** (`…/049-m2-mutation-races.mts`): **2 tests, 2 pass, 0
  fail** — the previous correction is not regressed.
- **Full client regression — all eleven `src/tests` suites**: **401 tests, 401 pass, 0 fail,
  0 cancelled, 0 skipped** (baseline before this round: 395 — the +6 are this round's new
  production-controller regressions: late-success/late-failure replacement preservation,
  own-rotation cleanup with the seam injected, retry-after-await session loss,
  silent-replacement submit, silent-replacement reset). No M1 regression.
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
- **Secret scan** across the diff and all four batch files: no claim token, Bearer value or
  40+ hex string anywhere.

Per `053`'s distinction, the numbers above are the coordinator's **reproductions**, not the
worker's checkpoint claims; the queue state, claim and checkpoint facts are bridge facts.

## 4. Honest limits (reported, not hidden)

- The in-flight profile read itself is not cancellable under the current transport — it is
  **fenced at completion** instead, which is exactly what 051 authorized (no abort
  transport was invented).
- The tenant suite has no session-identity/token surface (activation is an unauthenticated
  redeem), so 051 has no tenant case; that suite stays 15/15 unchanged.
- `readIdentity`/`readAuthToken` are injected seams; both pages inject them, so the boundaries
  are never skipped in production — the fact is documented rather than assumed away.

## 5. Not done, deliberately

No `api-http.ts` / shared / server / router / package / schema / config edit; no OTP, payment
or entitlement policy; no status-propagation rewrite; no shared auth listener; no new batch,
M3 or scope expansion; no self-acceptance. No git write (add/commit/checkout/stash/merge/
push), no dependency install, no real DB/network/provider/Docker/browser run, no schedule,
runtime or account change, no retirement of any other claim. All pre-existing uncommitted
work — the full M1 delta and every earlier M2-01 fix — was preserved; nothing reverted. Only
this new file was created.

Next gate: the coordinator's acceptance review of 051's two identity-removal counterexamples
against the source and the actual production regressions above.
