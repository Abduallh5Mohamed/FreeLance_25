# supervisor/064 correction claimed, implemented and reported

UTC 2026-10-18T16:23:57Z / Cairo 19:23:57. Branch `codex/human-client`.
Workspace `D:\FreeLance_25-1\FreeLance_25-1`.

## What was read, and what was not

- Coordination README + `tools/workbuddy-bridge/WORKER-PROMPT-CLIENT.md`: read.
- Supervisor folder: `001`–`064`. The only message newer than the last worker
  reply (`worker/036`, 16:14Z) is **`064-m2-02-lossy-session-fence-not-accepted.md`**
  (16:16:59Z, created during this run). Read only that one. `062` and `063`
  were already consumed by `worker/036` and were NOT re-read.
- `queue_status` exactly once (16:17Z): active `[]`, blocked `[]`,
  upgradePending false, ready = `client-m2-02-exact-session-fence-20261018-03`.
  `dispatch_plan` exactly once (same single ready task, advisory).
- One claim, one worker, one task, in ONE continuous run:
  - taskId `client-m2-02-exact-session-fence-20261018-03`
  - workerId `wb-m2-02-exact-session-fence-03a` (unique; no other worker on
    this task; no preclaim, no nested spawning)
  - sessionId: none available (no native run/child mapping in this
    invocation) — reported honestly, not invented
  - allowedPaths returned by the claim: the exact four from 056/061 —
    `src/pages/Courses.tsx`, `src/features/catalog/course-management.ts`,
    `src/tests/m2-course-management.test.ts`,
    `docs/streams/client/M2-02-CONTRACTS.md`. Verified before editing;
    nothing outside them was touched.
  - The claim token stayed in runtime only — it is not written here, in any
    file, or in any MCP note.

## The defect, independently reproduced first

064 is correct, and the cause is arithmetically exact:

- `djb2` multiplies by 33, so `33*'A' + 'b' === 33*'B' + 'A' === 2243`. The
  two genuinely distinct fixture sessions `fixture-Ab-session` and
  `fixture-BA-session` therefore produced the SAME digest. Verified directly:
  both hash to `t2brylp`.
- Before any edit, the supervisor's own out-of-repo probe
  `C:/Users/BaraaWael/TabwebClientSupervisor/064-course-session-collision.mts`
  with `--test-name-pattern supervisor064`: **1 test, 0 pass / 1 fail**
  (`actual 'created'`, `expected 'blocked'`). A pending create started under
  the first canonical session accepted its late completion under the second,
  with the same id and role.
- 064's framing is kept: this proves failed stale-result fencing, not a
  server authentication bypass or a real JWT exploit.

## Fix — exact canonical session equality in a private closure

All changes are inside the four allowedPaths. No shared helper, auth module,
api-http, router, backend, schema, package or config file was touched; no new
dependency, no crypto, no DOM harness.

`src/features/catalog/course-management.ts`

1. `digestSessionToken` is **gone** — the lossy 32-bit fingerprint is no
   longer available as a boundary anywhere in the seam.
2. New module-private registry: the whole canonical session
   (`id`, `role`, `billingOnly`, `scope`, and the canonical `authToken`) is
   canonicalised (`JSON.stringify` of normalised parts, so no separator can be
   forged by a value containing it) and compared by **EXACT equality**. The
   function that builds it is private and never returned, so the token cannot
   leave the module.
3. `buildCoursePrincipal` now returns only a meaningless, monotonic, opaque
   `session:<n>` incarnation id — no id, no role, no token, no digest. Two
   distinct canonical sessions can never share an identity; the same canonical
   session always yields the same id (stability across the page's own reads).
4. Memory is bounded to the most recent 64 identities. Forgetting is
   fail-safe, not a correctness risk: a session that returns after eviction is
   handed a NEW incarnation, so an old in-flight write can no longer commit
   under it.
5. New exported `readCourseSessionPrincipal(storage)` — the ACTUAL production
   reader, now living in the seam so the page's real logic is testable with an
   injected storage (no DOM, no browser, no live app). It reads `currentUser`
   and `authToken` fresh on every call, so a rotation, a logout or a silent
   re-login of the same account is seen at claim time AND at commit time.

`src/pages/Courses.tsx`

6. `readPrincipal` is now a thin wrapper over `readCourseSessionPrincipal`
   (same `try/catch`, same keys, same behaviour); the stale comment claiming a
   "NON-REVERSIBLE digest" was corrected. `buildCoursePrincipal` is no longer
   imported by the page. All 061 dialog/form/target/session fixes are
   **preserved unchanged** — including the plain (non-Radix-Close) confirm
   Button, archive dismissal while busy, and clearing page-owned form /
   editingCourse / selectedCourse / dialogs on session notifications.

`src/tests/m2-course-management.test.ts` — 10 new tests (46 → 56)

- the colliding fixture pair stays distinct (the exact 064 counterexample);
- the key is opaque: `/^session:\d+$/`, and contains neither the token, nor the
  id, nor the role;
- same-token stability;
- user / role / billing / scope changes each produce their own session;
- end-to-end: a pending write cannot commit under the colliding fixture
  session (matching the supervisor probe's meaning, not a copy of it);
- end-to-end silent replacement: same id/role, different token → `blocked`;
- end-to-end A→B→A: the write started under the first A is still foreign
  (the canonical key is stable again, but the operation incarnation advanced);
- **positive control**: an unchanged session still commits (`created`) — the
  exact fence must not become a blanket refusal;
- the page's real reader with injected storage: colliding tokens distinct,
  stable across reads, token absent from the key;
- the page's real reader: logged out = `null`, a token with an unreadable
  profile is still its own session and never matches a signed-in one, and a
  malformed profile never throws.

`docs/streams/client/M2-02-CONTRACTS.md` — §4bis item 4 corrected (it still
described the digest as the boundary), new **§4ter** documenting the 064
defect, the exact-equality boundary and the production reader, and §5 numbers
updated.

## Verification (all independent, this session, managed Node 22.22.2 + local tsx)

- `src/tests/m2-course-management.test.ts`: **56/56** (was 46; +10 new, no
  existing assertion weakened).
- All 12 client suites `src/tests/*.test.ts`: **464/464** (was 454; +10 new).
- Supervisor's own out-of-repo probe
  `064-course-session-collision.mts --test-name-pattern supervisor064`:
  **1/1 pass** (was 0/1). The whole probe file: **47/47**.
- Supervisor's earlier probe
  `061-course-target-races.mts --test-name-pattern supervisor061`:
  **2/2 pass** — the 061 fixes are preserved.
- `tsc -p tsconfig.app.json --noEmit`: **zero diagnostics in the four scoped
  files**; the same 11 pre-existing out-of-scope errors
  (NotificationBell:59; StudentHeader_OLD_BACKUP:496/510; ExamReports:78/82;
  ExamResults:104; Fees:483/497; StudentBarcodes:99; StudentDashboard:127;
  versionChecker:28). Overall exit remains nonzero because of those.
- Working tree (read-only check): 7 tracked files modified — `Courses.tsx`
  (this batch) plus the 6 pre-existing M1/M2-01 dirty files
  (`JoinInstructor.tsx`, `StudentSpaces.tsx`, `TenantInvitation.tsx`,
  `M2-HANDOFF.md`, coordination README, this automation's memory) — **all
  preserved, nothing reverted**. New untracked: `src/features/`,
  `src/tests/m2-course-management.test.ts`, `M2-02-CONTRACTS.md`. Branch
  unchanged: `codex/human-client`.

## Constraints honoured

No git write (no add/commit/checkout/stash/merge/push), no dependency install,
no real DB / live service / network provider / Docker, no M2 beyond this
human-authorized M2-02 batch, no new phase, no self-acceptance. No change to
tasks/state/approvals, bridge configuration, accounts, runtime or any
schedule. No claim token written to any file, report or message. No 429 and no
tool-guard error this run.

## Answers to 064's remaining points

- **Hourly schedule**: acknowledged as a worker statement — this automation is
  ACTIVE with `FREQ=HOURLY;INTERVAL=1` at this workspace (as 064 records);
  schedule modification is outside my constraints, so no change was made.
- **subscription_id**: still documented only in §4 of the contracts, no
  backend contract invented, not removed.
- **OTP**: still deferred per 060.
- **Archive wording / dismissal**: unchanged per 064's acceptance.
- **Honest limitation**: there is still no rendered-DOM test (no jsdom
  installed; installing one is forbidden). The 064 finding is proven from the
  actual production seam plus the supervisor's own probe, which is exactly the
  limit 064 declared sufficient.
- A worker report is not acceptance: this task is `reported` /
  `awaiting_supervisor`.

## Next gate

Supervisor acceptance of this 064 correction. A NOT-ACCEPTED review would
arrive with a fresh `ready` task: it must be claimed once with a new unique
workerId and finished claim → checkpoint → single report inside ONE continuous
run (the claim token cannot survive a session boundary).
