# Two recovery tasks completed and reported (supervisor/021 consumed)

UTC: 2026-10-16T18:52Z. Branch: `codex/human-client`. Reply to: `supervisor/021-operator-confirmed-stop-recovery-tasks-ready.md`
(review 18:46:55Z). Worker replies of record before this one: `worker/015` (operator-confirmed
termination + recovery-task request).

## What 021 instructed and what was done

021 recorded the operator-confirmed stop, retired the two stale claims through the supervisor-only
`retire` path, and queued two new human-approved continuation tasks with the same allowedPaths.
This run consumed it through the normal MCP flow only:

- `queue_status` once (18:49Z): `active: []`, both new tasks `ready`, `blocked: []`,
  `upgradePending: false`, maxActive 48 / maxPerTeam 6.
- `dispatch_plan` once (same advisory snapshot; no ready-task work was invented beyond it).
- Two claims, one unique workerId each — no duplicate worker, no nested spawning, no preclaim:
  - `client-m1-barcode-recovery-20261016-03` → worker `wb-barcode-recovery-03c`
  - `client-m1-edit-recovery-20261016-01` → worker `wb-edit-recovery-01b`
- `allowedPaths` returned by each claim were verified before editing and never left:
  barcode = `src/pages/BarcodeAttendance.tsx` + `src/tests/m1-sprint-attendance-ui.test.ts`;
  edit = `src/pages/EditExam.tsx` + `src/tests/m1-expanded-exam-authoring-ui.test.ts`.
- One checkpoint after inventory and one after tests-green per task; exactly one
  `submit_task_report` per task. Both reports are **`reported`, not accepted** — this message is
  not acceptance and opens no phase. No 429, no tool-guard error, no account/model change.
- Claim tokens were never written to any file, report or message.

## Inventory before editing (021 requirement)

- Working tree at start: 24 tracked files, 6951 insertions / 825 deletions — identical to the last
  snapshot (16:42Z). The retired claims' partial work was present and was preserved and continued,
  never rewritten.
- Barcode partial work confirmed on disk: canonical `authToken` adapter + protected transport,
  scan classifier, submission guard, scoped response guard, `createBarcodeAttendanceController`
  (resetScope / clearCommitted / nested-read guards), honest load states + retry banner.
- EditExam partial work confirmed: canonical auth headers on question-list/upload/mutations,
  `createEditExamRouteLoadGuard` (generation + reset-on-scope-change + `isScopeCurrent` reload
  guard + unmount invalidate), single-flight save guard.

## Task 1 — client-m1-barcode-recovery-20261016-03 (018/021 rendering scope)

1. **Explicit payment states in BOTH table consumers** (the 018 string-as-boolean defect at the
   former lines ~1267/1294-1304): added exported production helpers
   `describePaymentPresentation` and `describeLastAttendancePresentation` consumed by the absent
   table (and the present table's payment action). `paid`/`unpaid`/`unknown` now render distinct
   badges; the payment action is exposed **only** for a verified `unpaid` state; `unknown`/
   missing never implies paid or unpaid and never authorizes a payment (the present table
   previously offered the action for any non-paid state, including unknown — narrowed per 021's
   "Unknown must not authorize payment").
2. **Honest previous-attendance rendering**: an entry with `_attended: null` + `_unavailable: true`
   (failed lookup) now renders "غير متاح" instead of a confirmed "لم يحضر آخر حصة".
3. **Additional verified defect found during implementation (not in 018/021)**: the partial
   controller replaced the whole `lastAttendance`/`monthlyPayments` maps in each loader, so the
   absent loader — which the page effect fires after every today load — erased the present
   table's entries. The original page merged (`prev => ({ ...prev, ...next })`); the controller
   now owns scope-keyed merged maps and publishes full snapshots, with `resetScope` clearing both
   maps entirely on every group transition (including A→B) and on clear.
4. 15 new production-path tests drive the real controller with a deferred injected transport and
   state sinks: successful commit with nested lookups, A→B immediate clearing, A→B reversed
   completion, top-level 401 and network failure clearing rows with actionable error, late
   superseded failure never surfacing, group clear without replacement request, unmount
   invalidation, scope change mid nested reads, nested fees failure → `unknown`, failed
   previous-attendance lookup → `_unavailable`, honest absent computation (no successful today
   load → no absent rows, zero requests), absent rows from committed present records with the
   merge semantics.

## Task 2 — client-m1-edit-recovery-20261016-01 (011/021 lifecycle scope)

1. **Route generation separated from load generation**: `createEditExamRouteLoadGuard` gained
   `currentRouteGeneration()`, which changes ONLY on a scope change or unmount — never on a
   same-scope reload — so string-only scope equality can no longer be defeated by A→B→A (the
   loaded scope legitimately returns to `exam-A`) and a save's own reload no longer supersedes
   its sibling operations.
2. **Per-operation fencing** (the 011 gap: only the reload was guarded): added exported
   `createEditExamOperationTracker`, `isEditExamOperationCurrent` and `runEditExamOperation`.
   Every operation captures its scope, route generation and target identity
   (`'details' | 'new' | question id`) at start and may commit only while it still owns the
   current route AND target; for the same target the newest committed operation wins.
3. **All handlers rewired through the lifecycle**: `handleUpdateExamDetails`,
   `handleUpdateQuestion`, `handleDeleteQuestion`, `handleAddNewQuestion` and BOTH upload
   handlers — every toast, form reset/close and image commit is fenced, not just the reload.
   Uploads use functional setState so concurrent user edits survive; failures commit only a
   toast and keep the form/draft open (rejection retains current input).
4. Defects closed: A→B late success no longer closes B's form, resets B's draft or toasts over
   B; A→B→A stale commits dropped; unmount retires every outstanding operation; late uploads
   after a route change, new-question form close or target switch are dropped; out-of-order
   same-target uploads keep only the newest image.
5. 12 new production-path tests drive `runEditExamOperation` with deferred adapters and mutable
   state sinks: commit-while-current, A→B, A→B→A, unmount, closed `new` form, out-of-order
   same-target, `markCommitted` precedence, failure-keeps-form, failure-after-route-change,
   token capture, route-generation semantics, `isEditExamOperationCurrent` matrix.
6. TeacherExams was NOT edited despite inherited historical references — current allowedPaths
   govern (021). The canonical auth headers, single-flight saves and route-load reset from the
   partial work are preserved unchanged.

## Verification (before/after)

- Barcode suite: **50/50** (was 35). EditExam suite: **65/65** (was 53). All 7 `src/tests`
  suites: **291/291** (was 264/264). Runtime: managed Node
  `C:/Users/BaraaWael/.workbuddy-ai/binaries/node/versions/22.22.2-6/node.exe` (v22.22.2) with
  `node_modules/tsx/dist/cli.mjs --test`; reproducible command supplied for the supervisor's
  independent reproduction (the supervisor's Node v22.14.0 lacks `registerHooks`; no install or
  runtime/account/config change was made).
- `tsc --noEmit -p tsconfig.app.json`: exactly the **same 11 pre-existing out-of-scope
  diagnostics** (NotificationBell, StudentHeader_OLD_BACKUP, ExamReports, ExamResults, Fees,
  StudentBarcodes, StudentDashboard, versionChecker); **zero** diagnostics in either scoped page
  or test file.
- Tree after: 24 tracked files, 8239 insertions / 1018 deletions (was 6951/825). Only the four
  scoped files carry this run's changes; every other dirty file is untouched; nothing reverted;
  no git write, no dependency install, no DB/network/live service/browser/hardware, no schedule,
  bridge, account, tasks/state/approval change.

## Limitations and open questions (no implementation under them)

1. Native run/session IDs are unavailable from this hourly invocation (no child processes were
   spawned; the two workers ran inside this invocation). The coordinator-side mapping
   (workerId → taskId) is recorded in the MCP claims, not fabricated anywhere.
2. Payment-policy interpretation for `unknown`: the payment action is now hidden in BOTH tables
   when the fee lookup is unknown (previously the present table offered it for any non-paid
   state). If the established policy intends to allow a payment attempt on `unknown`, that is a
   follow-up decision for the supervisor/human.
3. Same-scope reloads deliberately do NOT supersede in-flight operations (route generation
   changes only on scope change/unmount). If operations should also be fenced by their own
   reload, that is a follow-up decision.

Both MCP reports are `reported` and await supervisor review; neither task is accepted, and no
next phase is authorized by this message.
