# M2-06 silent-principal completion correction — implemented, verified and reported

**Task:** `client-m2-06-principal-completion-correction-20261019-01` (supervisor140
finding F3, same five paths, over the stopped/reported058 predecessor).
**Worker:** `opencode-worker-060` — claimed once in this native session; no
re-claim, no second worker, no new task, no retirement, no ownership transfer.
**UTC:** 2026-10-19T16:43Z — **Branch:** `codex/human-client`.
Native session ID is not exposed by the available tooling. Supervisor141/142 map
this claim to the native session `ses_eab01da19ffeQ62rCDE9vI5Iis`; the work
continued in the same native conversation context with the original claim token
from that context, and no private claim file was read.

## Changed paths (five allowed paths + this coordination report)

- `src/features/tenant/profile.ts` — the only product file changed in this
  correction. F3 fix in `runLoad`: **both** the success and the catch branch of
  the stale-generation path now observe the canonical principal
  (`readPrincipal()`) **before** any visible-state settlement. If the observed
  principal differs from the principal the retired read started under, the
  change is adopted through the new `adoptRetiredPrincipalChange`: the shared
  generation is invalidated (no in-flight reply can commit into the changed
  view), the form generation is invalidated (a late reply can never close or
  rewrite a newer form), and the private card/draft are cleared with the phase
  set to `idle`. The latches are deliberately **not** released there — every
  operation releases only its own ticket in its `finally`, so a retired
  completion can never free a newer operation's latch. When the observed
  principal is unchanged, the retired read still settles only the phase it
  owns (`settleReadPhase`, the supervisor136 behaviour), so no phantom
  `loading` remains. No transport/auth/session-events change, no new request,
  no tenant selector, no owner flag, no new capability inference.
- `src/tests/m2-tenant-profile-edit.test.ts` — 3 new hermetic production-path
  regressions (33 tests total): a retired GET that observes a silent logout
  before it settles the visible state (success **and** error outcomes), and a
  retired GET that observes a silent change while a newer principal's read is
  pending, proving the stale completion neither clears the newer principal's
  state nor frees its latch.
- `docs/streams/client/M2-06-CONTRACTS.md` — new section 9 (F3 semantics,
  actual evidence, coverage limits) and refreshed counts in sections 5 and 7.
- This report only in `docs/streams/client/coordination/worker/`.

`src/pages/InstructorDashboard.tsx` and `src/lib/api-http.ts` were **not**
modified in this correction: the page already renders the resulting states and
the accepted canonical adapter needs no change. All previously accepted dirty
work and the unchanged 38-read test package were preserved untouched.

## Before/after behavior

Before (reproduced by the external supervisor140 probes, unchanged, 0/2): with a
tenant-a profile confirmed under session-a, a draft open, a refresh GET on the
wire and a PATCH pending, a silent logout (no notifier) followed by the GET
resolving **or** rejecting left `phase === 'ready'` with tenant-a and the
private draft `'Private draft'` on screen — the retired GET settled the
`loading` phase back to `ready` and returned *before* any canonical principal
observation, so the previous session's identity was revived.

After: the retired GET observes the principal first, adopts the change, and the
previous principal's card, draft and phase are cleared (`profile === null`,
`edit.draft === ''`, `phase === 'idle'`). The still-pending PATCH of the
retired principal never commits, never closes the form as a success and is
never retried automatically. A newer principal with a newer pending read is
untouched: the newer read keeps the phase and keeps its latch (a duplicate
read is still latched away), and the newer principal's own server-confirmed
identity is what the card finally shows. Unchanged behaviour is preserved: a
retired read with an unchanged principal still settles only its own phase
(supervisor136 F1), a foreign-institution PATCH reply is still never committed
(F2), and the silent A → B → A, session-event, dispose and old-`finally`
protections are unchanged.

## Verification (actual commands, locally run)

- `node --import tsx --test C:/Users/BaraaWael/TabwebClientSupervisor/140-m2-06-silent-principal-probes.test.ts`
  (external supervisor140 probes, absolute path, run unchanged, not copied into
  the workspace) → **2/2 pass**, exit 0. **Before the fix the same command gave
  0/2** (both assertions failed: prior-principal card and draft revived) —
  this is the before/after sensitivity evidence for the production path.
- `node --import tsx --test C:/Users/BaraaWael/TabwebClientSupervisor/136-m2-06-review-probes.test.ts`
  (external supervisor136 probes, unchanged) → **3/3 pass**, exit 0 (F1/F2
  regressions preserved).
- `node --import tsx --test src/tests/m2-tenant-profile-edit.test.ts`
  → **33/33 pass**, 0 fail (30 accepted + 3 new), exit 0.
- Unchanged accepted read suite
  `node --import tsx --test src/tests/m2-tenant-profile-ui.test.ts`
  → **38/38 pass**, exit 0 (file unchanged).
- Nearby shared-helper regression
  `node --import tsx --test src/tests/m2-course-management.test.ts`
  → **61/61 pass**, exit 0 (file unchanged).
- `.\node_modules\.bin\tsc.cmd -p tsconfig.app.json --noEmit` → **zero errors in
  the five scoped paths** (all five are inside `include: ["src"]` except the
  markdown contract). The known **11 outside** diagnostics remain
  (NotificationBell, StudentHeader_OLD_BACKUP×2, ExamReports×2, ExamResults,
  Fees×2, StudentBarcodes, StudentDashboard, versionChecker) — the same set
  recorded before this correction in the contracts doc §5 and in supervisor140.
  Wrapper exit code 2 (errors present). No pre-change tsc measurement was
  captured in this session; the pre-change baseline used is the recorded one.
  Two later re-runs of the same command were interrupted by the tool host; the
  completed run above printed the complete 11-error list.
- `.\node_modules\.bin\eslint.cmd src/features/tenant/profile.ts src/tests/m2-tenant-profile-edit.test.ts`
  → **exit 0, no problems** in the two files changed in this correction.
- Request-count evidence (numbers, not timings): the corrected paths issue **no
  extra GET** and **no automatic PATCH retry**; a silent change during a
  pending write costs zero additional requests; a deliberate retry after the
  retired operation settles is still exactly one PATCH.
- File-integrity check after editing: `src/features/tenant/profile.ts`
  893 lines with exactly one `adoptRetiredPrincipalChange` definition and one
  `settleReadPhase`/`closeEdit`/`adoptPrincipalChange` each;
  `src/tests/m2-tenant-profile-edit.test.ts` 1001 lines with 32 `test(`/`for`
  declarations expanding to 33 executed tests — no duplicated block.

## Limitations / blockers

- No DOM/RTL/browser, no real HTTP/DB/provider/live service: the controller is
  exercised hermetically with injected transport/principal/notifier. No
  performance, latency or scalability claim is made.
- The rejected temporary-source-mutation action was **not** repeated (per
  supervisor142). Regression sensitivity is demonstrated by the unchanged
  external 140 probe failing 0/2 before the production change and passing 2/2
  after it, on the same production module — not by mutating production code.
- The denied command never touched disk: the production file still contains
  exactly one copy of the fix, no TEMP backup was written, and no
  replace/restore was performed. Verified by reading the file and counting
  declarations.
- Real server-side commit ambiguity, row locking and audit rollback remain
  server integration concerns; the accepted129 write contract was not re-run.
- A retired PATCH whose principal changed is neither a success nor a rollback
  claim; it stays discarded and unretried, as stated in the contracts doc.
- Work is stopped. Codex independently reviews the stable source, contracts,
  tests and types and decides acceptance; this report is not self-acceptance.

## Schedule

Next scheduled **check** (not a guaranteed implementation start):
**2026-10-19 19:48:58 Africa/Cairo**, about **6 minutes 5 seconds** from
19:42:53 local at report-writing. `Get-ScheduledTaskInfo` reports
`NextRunTime 19:48:58`, `LastRunTime 19:39:42` (result 0) and the task state
was `Ready`; the schedule was not changed.
