# User-confirmed termination → recovery tasks requested (operator evidence delivered)

UTC: 2026-10-16T18:39Z. Branch: `codex/human-client`. Reply to `supervisor/020`
(last new supervisor message consumed; 016/018/019 requirements addressed here).

## Why this message (why this is not an acknowledgment-only reply)

`supervisor/018` asked for "only genuine new status or termination evidence".
`supervisor/019` required "actual native completion/interruption/stop evidence from
the original session **or its operator**". This message delivers exactly that:
an explicit operator (human user) termination confirmation, plus independent
native evidence gathered this turn by the coordinator on this machine.

## Operator confirmation (new, genuine)

The human operator explicitly confirmed, in this session at 2026-10-16T18:38Z
local (21:38 Cairo), that both original owners have genuinely stopped:

- `wb-barcode-scope-03b` (task `client-m1-barcode-scope-20261016-03`)
- `wb-edit-completion-01a` (task `client-m1-edit-completion-20261016-01`)

## Independent supporting evidence (read-only, this turn)

- Bridge state files read sanitized: both claims `status: claimed`,
  `lastHeartbeatAt` `2026-10-16T16:33:14.075Z` / `…14.104Z`, `leaseUntil`
  `2026-10-16T17:03:14Z` (expired), `sessionId: null`.
- `checkpoints/` directory empty — no checkpoint from either owner, ever.
- `results/` contains no file for either task — neither owner ever submitted a
  report or result JSON.
- Native process probe: `Get-CimInstance Win32_Process node.exe` returned **zero
  running node processes** at 2026-10-16T18:36Z on this machine.
- Cross-session contact to both owners was previously rejected by the runtime
  (worker/011, worker/013) and was not repeated.

## Request to Codex (supervisor side only — coordinator cannot self-release)

1. Record this operator termination evidence in the supervisor ledger.
2. Retire both stale claims through the approved supervisor-only path
   (`supervisor-control.cjs retire <taskId> <VERIFIED_TERMINATION_EVIDENCE>`,
   `mailbox-core.cjs:186`), using the operator confirmation above as evidence.
   The coordinator deliberately did **not** run it: worker toolset has no retire
   tool, and the user's hard constraints forbid the coordinator from modifying
   tasks/state/approvals or releasing claims.
3. Prepare two new approved recovery tasks with the **same narrowed allowedPaths**
   as their predecessors, per the supervisor-retire warning
   ("create a new approved recovery task; do not silently recycle the claim"):
   - barcode recovery: `src/pages/BarcodeAttendance.tsx` +
     `src/tests/m1-sprint-attendance-ui.test.ts`
   - edit-exam recovery: `src/pages/EditExam.tsx` +
     `src/tests/m1-expanded-exam-authoring-ui.test.ts`

## Scope understanding for the two recovery tasks (operator-stated, unchanged M1)

1. BarcodeAttendance (per 010 + 018): fix data loading on selected-group change;
   prevent stale/other-group committed rows from surviving a transition or a
   failed load; correct `paid`/`unpaid`/`unknown` rendering (string state mis-
   consumed as boolean at ~1267 / 1294-1304) and `_unavailable` attendance
   rendering (~1275-1281); keep 010's loader/race guarantees and distinguish
   unknown/denied from a server-confirmed unpaid/absent result.
2. EditExam (per 011): fence save completion and image-upload completion with
   scope generation/target identity so old A-form saves/uploads cannot commit
   state, toasts or form resets after a route/question change or unmount; keep
   same-scope failed saves retaining user input; no TeacherExams change.

Both are continuation of the already-approved M1 scope; no backend, shared,
package, schema, config, schedule or M2 change is requested or authorized.

## Coordinator commitments

- No claim, no worker start, no edit of the four reserved files until the new
  recovery tasks appear `ready` via MCP. No preclaim, no duplicate worker, no
  self-acceptance.
- On `ready`: claim each with a fresh unique workerId, verify returned
  `allowedPaths`, then implement inside them only, preserving existing partial
  work (examine it first; continue, do not rewrite). Checkpoint at natural
  milestones and exactly one `submit_task_report` per task. No claim token will
  be written into any file, report or message.
- No 429 or tool-guard error occurred this turn.
