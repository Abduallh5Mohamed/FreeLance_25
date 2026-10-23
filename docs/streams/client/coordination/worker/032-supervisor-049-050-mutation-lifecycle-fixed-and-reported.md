# supervisor/049 + 050 — mutation lifecycle guards implemented, tested and reported

- **Author:** WorkBuddy (client worker/coordinator)
- **UTC timestamp:** 2026-10-17T19:41Z (22:41 Cairo local)
- **Replies to:** `supervisor/049-m2-01-mutation-races-not-accepted.md`,
  `supervisor/050-m2-01-correction-claimed-awaiting-checkpoint.md`
- **Branch:** `codex/human-client`
- **Changed paths by this message:** this file only (new uniquely named file)

## 1. Claim (one continuous run)

- Task `client-m2-01-mutation-lifecycle-20261017-02` claimed **once** via
  `next_approved_task` with workerId `wb-m2-01-mutation-lifecycle-02a`.
- Returned `allowedPaths` are the **exact seven** from `supervisor/047`:
  `src/pages/JoinInstructor.tsx`, `src/pages/TenantInvitation.tsx`,
  `src/pages/StudentSpaces.tsx`, `src/features/enrollment/workflows.ts`,
  `src/tests/m2-enrollment-workflows.test.ts`,
  `src/tests/m2-tenant-invitation.test.ts`, `docs/streams/client/M2-CONTRACTS.md`.
  No mismatch, no second claim, no preclaim, no replacement worker, no nested spawn.
- `queue_status` once, `dispatch_plan` once (one ready task), two `task_checkpoint`
  calls (inventory; fix+tests green), exactly one `submit_task_report` — all inside
  this same session. No 429, no tool-guard error. The claim token lived only in
  runtime memory and appears in no file, report or message.

## 2. Root cause and fix (source, not speculation)

`049` is correct: the loaders had a generation guard, the **mutations** had none.
`join.submit` / `join.requestPasswordReset` awaited and then patched
`submitted` / `resetSent` / `actionError` unconditionally, and `tenant.activate`
awaited `redeem` and committed `activated`/`failed` unconditionally. `dispose`
and `syncToken` only stopped *future* requests.

Changes, all inside the approved paths:

**`src/features/enrollment/workflows.ts`**
- `createEnrollmentGuard` is now **ticket-scoped**: `release(ticket)` frees the
  latch only if that ticket still owns it, so a superseded operation's `finally`
  can never release a *newer* operation's latch; `release()` without a ticket is
  the unconditional retire used only by the lifecycle paths. `holder()` exposes
  the ticket. `acquire()`/`isBusy()` semantics unchanged (existing test still green).
- `createEnrollmentSequence` gained `current()` — a mutation *captures* the
  generation instead of bumping it, so it is fenced against a later invalidation.
- Join: `isMutationCurrent(generation, token, principal)` gates **every** success
  and error commit in `submit` and `requestPasswordReset`. A superseded mutation
  returns `'blocked'` and patches nothing, so it can neither mark a new invitation
  submitted nor blame it with the old invitation's error.
- Join: `loadInvite()` retires in-flight work (`invalidate` + `guard.release`)
  **before** anything else, for *any* route change — including an **empty token**,
  which now patches `phase: 'incomplete'` with the message "رابط الانضمام غير مكتمل."
  and fires **no** request (the page effect no longer skips the empty token).
  `busyKind` is reset with the route, so no stranded spinner survives.
- Join: new `syncIdentity()` — the identity key is captured with the mutation and
  a change retires in-flight work (the password-required precondition it was
  submitted under no longer holds). Terminal `submitted`/`resetSent` are **kept**
  across an identity change (they are facts the server accepted for that link) but
  cleared by a route change. Documented in M2-CONTRACTS §4.
- Tenant: `syncToken()` now invalidates the sequence **unconditionally** — so
  A→B→A does not revive an old incarnation — releases the latch, and resets a
  stranded `'activating'` back to `'form'`. `activate` re-reads the fragment
  first, then captures generation + token, and gates success *and* failure on
  `!disposed && isCurrent(generation) && state.token === token`. `dispose()` now
  invalidates the sequence too.
- StudentSpaces: new optional `hooks.readAuthToken`. The identity is persisted
  only while the token in storage is **exactly** the one this selection rotated to
  (api-http.ts:2278). A replaced token or a logout makes the controller discard the
  stored identity, never notify `'scope'`, never navigate, and set
  `pendingIdentityLoad`; `retryIdentityLoad` is refused **before** the request so
  it can never read another session's profile. Without the injected reader the
  boundary is skipped rather than guessed — the page always injects it.

**Pages** — `JoinInstructor.tsx` loads on every route change (empty token
included), re-reads `currentUser` through `subscribeSessionChange` instead of a
memoize-once value, and every label now has a real `htmlFor`/`id` association
(`join-student-name`, `join-phone`, `join-guardian-name`, `join-guardian-phone`,
`join-grade`, `join-group`, `join-password`) with `aria-label` on the reset-phone
input. `StudentSpaces.tsx` injects `readAuthToken`.
`TenantInvitation.tsx` needed no change (it already had `htmlFor`/`id`).

`docs/streams/client/M2-CONTRACTS.md` §4 records the invariant table, including
the honest statement that the two identity boundaries are skipped when their
seam is not injected.

## 3. Independent verification (re-run here, not relayed)

Runtime: `C:/Users/BaraaWael/.workbuddy-ai/binaries/node/versions/22.22.2-6/node.exe
node_modules/tsx/dist/cli.mjs --test …` (managed Node 22.22.2 + local tsx).

- **Supervisor 049's own repro** (`C:/Users/BaraaWael/TabwebClientSupervisor/049-m2-mutation-races.mts`,
  outside the repo, imports the real production controllers): **2/2 pass** — was
  0 pass / 2 fail. Both counterexamples are fixed.
- **M2 suites** `m2-enrollment-workflows.test.ts` + `m2-tenant-invitation.test.ts`:
  **53/53 pass** (was 36) — +17 new deferred-transport controller regressions:
  superseded submit / reset / A→B→A / superseded failure / unmount-dispose;
  route change retires the latch *and* the old `finally` does not free the newer
  one (a duplicate is still blocked); empty-token invalidation; identity-change
  retirement; tenant superseded success / same-text return / superseded failure /
  retired-latch-does-not-block / dispose; and the four session-boundary cases
  (own rotation commits, replaced token, logout, retry refused).
- **Full client regression** — all eleven `src/tests` suites: **395/395 pass**
  (was 378). No M1 regression.
- **Types** — `./node_modules/.bin/tsc --noEmit -p tsconfig.app.json --pretty false`:
  the **same 11 pre-existing out-of-scope diagnostics**
  (`NotificationBell.tsx:59`, `StudentHeader_OLD_BACKUP.tsx:496/510`,
  `ExamReports.tsx:78/82`, `ExamResults.tsx:104`, `Fees.tsx:483/497`,
  `StudentBarcodes.tsx:99`, `StudentDashboard.tsx:127`, `versionChecker.ts:28`) and
  **zero diagnostics** in any file created or changed by this batch.
- **Scope audit** — only the seven approved paths changed. No `src/lib/**`, server,
  component, package, config, schema, migration, bridge, `tasks/state/approvals`
  or schedule change. All pre-existing uncommitted work (including `M2-HANDOFF.md`,
  the coordination README and the whole M1 delta) is preserved; nothing reverted.
- **Secret scan** — no claim token, Bearer value or 40+ hex string in any changed
  or new file. The claim token was never written down.

## 4. Not done, deliberately

No `api-http.ts` edit (049/050: do not turn error strings into authority, do not
invent numeric status), no server/router/shared-auth/package/schema/config edit,
no fragment-format invention, no OTP/payment/entitlement policy, no new batch or
M3, no self-acceptance. No git write (no add/commit/checkout/stash/merge/push),
no dependency install, no real DB/network/provider/Docker/browser run, no
schedule/runtime/account change, no retire or release of any other claim.

## 5. Honest limits

- A superseded tenant activation leaves `token` on the *new* fragment and returns
  `'blocked'`; the in-flight redeem itself cannot be cancelled — it is only
  prevented from committing (the contract has no abort).
- `readIdentity` / `readAuthToken` are injected seams: without them the identity
  boundaries cannot be evaluated and are skipped. Both pages inject them, so
  production never skips; the hermetic tests that exercise the boundaries inject
  their own.
- The join page's `existingStudent` now refreshes on the session bus; a session
  change that does **not** go through `notifySessionChange` (a pure cross-tab
  storage write) is still not observed — existing cross-tab listeners are outside
  this batch's paths.

Status: **reported**, awaiting supervisor acceptance. A worker report is not
acceptance.
