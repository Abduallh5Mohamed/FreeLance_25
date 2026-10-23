# M2-07 UI-guard correction — F1/F2/F3 implemented, verified, stopped

2026-10-19T20:05Z · branch `codex/human-client` · task
`client-m2-07-ui-guard-correction-20261019-01` · worker `opencode-worker-062`
(native MCP claim; no native session id is exposed to this run, so none is
claimed). Governed by human152/153 and the independent review
`supervisor/161-m2-07-review-memory-authorization-and-retry-corrections.md`.
No new task, no ownership change, no self-acceptance, no schedule change.

## Scope: the same six approved paths only

Changed in this run (nothing else was touched):

- `src/features/tenant/branches.ts`
- `src/features/tenant/BranchManager.tsx`
- `src/tests/m2-tenant-branches-ui.test.ts`
- `docs/streams/client/M2-07-CONTRACTS.md`

`src/lib/api-http.ts` and `src/pages/InstructorDashboard.tsx` were **not**
changed in this run (the accepted additive adapters and the mount are
preserved byte-for-byte). All accepted dirty work, the accepted 144 editor
and the accepted 151 migration FILE are preserved.

## F1 — the response page bound is now enforced on the response

`parseTenantBranchList` rejects a page with more than
`TENANT_BRANCH_PAGE_LIMIT` (25) rows **before** any row is traversed or
copied. An oversized page is a malformed response
(`MALFORMED_BRANCH_MESSAGE`), never a silent truncation and never a
fabricated cursor. The request limit was only a promise; the response limit
is now a contract. No claim is made about the total HTTP parsing memory:
only the held page inside this module is bounded.

## F2 — a definite read authorization loss clears the private state

New exported `isTenantBranchAuthorizationLoss(reason)` separates the
documented denials (`session`, `suspended`, `billing-only`, `not-owner`,
`no-workspace`) from the retryable read failures (`server`, `unknown`).

- Definite loss: `runRead` clears the rows, **the form, the draft, the
  target and the confirmed result**, retires every in-flight operation, and
  keeps the truthful failure phase, reason and the server's own message. A
  late pending write or read can no longer repopulate the cleared private
  state.
- Retryable failure (the handler 500, a network error, an unknown message):
  the private draft and the form survive, because no permission loss was
  proven. The existing write-denial retention and the uncertain-write
  semantics are unchanged.

## F3 — the status action is no longer latched disabled

`BranchManager.tsx` no longer includes
`mutation.kind === 'status' && mutation.targetId === row.id` in the disabled
condition. The action is disabled only while a mutation is **actually**
saving (`mutation.status === 'saving'`) or while a form is open. After a
definite 409 conflict the error message stays visible and a deliberate
retry is immediately possible — no unrelated operation, no automatic write.
The shared `Button` primitive was **not** replaced and no shared file was
touched.

## Before / after

Before: a 26-row response was accepted and 26 rows were held although the
documented bound is 25; a list authorization loss cleared the rows but left
the private rename form and draft rendered and actionable; a definite
conflict left the row's archive button permanently disabled.

After: an oversized response is refused before traversal and never held; a
definite read authorization loss clears the whole private surface while a
retryable failure keeps the draft; a definite conflict leaves the action
enabled for a deliberate retry while a real flight still disables it.

## Validation actually executed in this native session

Baselines before the change:

- `.\node_modules\.bin\tsx.cmd --test src/tests/m2-tenant-branches-ui.test.ts`
  → 43 pass / 0 fail.
- `.\node_modules\.bin\tsx.cmd --test "C:\Users\BaraaWael\TabwebClientSupervisor\161-m2-07-independent-probes.test.ts"`
  → **0/5 pass** (all five failed), exactly as recorded in 161.

After the change:

- `.\node_modules\.bin\tsx.cmd --test src/tests/m2-tenant-branches-ui.test.ts`
  → **52 pass / 0 fail** (43 unchanged + 9 new).
- `.\node_modules\.bin\tsx.cmd --test src/tests/m2-tenant-branches-ui.test.ts
  src/tests/m2-tenant-profile-ui.test.ts src/tests/m2-tenant-profile-edit.test.ts
  src/tests/m2-course-management.test.ts` → **184 pass / 0 fail** (52 + the
  unchanged 38 + 33 + 61).
- `.\node_modules\.bin\tsc.cmd -p tsconfig.app.json --noEmit` → **zero
  diagnostics in the six scoped paths**; the output is the same 11 known
  outside errors (NotificationBell, StudentHeader_OLD_BACKUP×2,
  ExamReports×2, ExamResults, Fees×2, StudentBarcodes, StudentDashboard,
  versionChecker) and the same 13 output lines as the baseline.
- The public external probe, run unchanged from its absolute path:
  **4/5 pass** (was 0/5). Probes #1 (26-row response refused), #2 (the real
  controller never retains an oversized page), #3 and #4 (`Token expired` and
  `Forbidden` clear the private draft and target) now pass.

The 9 new tests are in the allowed suite and drive the **real** controller,
the **real** transport and the **real** `BranchManager` component rendered by
the React server renderer: the 25/26 row bound at parser **and** controller
level, the authorization loss for both documented messages, the retained
draft on a retryable failure, the classifier, the late pending mutation, the
authorized retry, the duplicate status click, and the rendered
`disabled` **attribute** of the archive action.

## Honest limitation — external probe #5 still fails, and the cause is in the probe

Probe #5 asserts `/\bdisabled\b/.test(openingTag) === false` on the rendered
archive button's opening tag. After the fix the rendered opening tag is
`<button class="… disabled:pointer-events-none disabled:opacity-50 …"
type="button">` — the HTML **`disabled` attribute is absent** (the behaviour
the probe targets is correct), but the tag still contains the shared design
system's `disabled:` utility classes, which `src/components/ui/button.tsx`
emits for **every** button in the application (including the accepted 144
profile editor). That file is outside the six approved paths, so the
substring match cannot distinguish a CSS class from an HTML attribute.

I did **not** modify the probe (read-only), did **not** change the shared
Button or its classes, did **not** hand-roll a replacement button and did
**not** add a decoy button. The in-suite regression asserts the attribute
shape (`/\sdisabled(?:=|\s|>)/`) against real rendered markup and passes.

## Remaining limitations

- No DOM, RTL paint, browser, real HTTP, database or live service was
  involved; the accepted migration was not applied, so no runtime branch
  rollout is claimed and no production data is invented.
- No performance, latency or scalability measurement was taken; only request
  counts and the held-page bound are proven.
- The server's physical row locking, keyset paging and audit writes remain
  the accepted 151 server-contract scope.
- OTP stays deferred; M2-07 does not close C1 or M2.

## Next owner action

Codex independent review of the stable source, then acceptance or an exact
scoped correction. One decision is needed on the external probe #5: the
product behaviour is fixed and proven in-repo, and the probe's own assertion
is class-insensitive; the probe file is Codex's to adjust. The worker timer
`Tabweb-OpenCode-Worker-15min` remains **DISABLED** per human152 (verified:
State `Disabled`, Enabled `False`); the live cadence is the Codex supervisor
task `Tabweb-Codex-Supervisor-10min` (State `Ready`, Enabled `True`, last run
22:54:59 Cairo, result 0).
