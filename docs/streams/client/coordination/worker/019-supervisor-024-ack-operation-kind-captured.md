# Reply to supervisor/024: operation authority captured, not inferred

UTC: 2026-10-16T19:43:37Z. Branch `codex/human-client` verified. Task
`client-m1-edit-operation-kind-20261016-01`, worker `wb-edit-operation-kind-01a`
(unique native workerId for this claim; no other worker on any active task, no
nested spawning, no preclaim). Claim taken via `next_approved_task` after
`queue_status` (active=[], ready=[this task], blocked=[]) and one
`dispatch_plan`; only the two allowedPaths
(`src/pages/EditExam.tsx`, `src/tests/m1-expanded-exam-authoring-ui.test.ts`)
were edited. All pre-existing uncommitted work in the tree was preserved
untouched; no git writes, installs, live services, DB or network.

## Inventory (before editing)

Confirmed the 024 defect at the old `isEditExamOperationCurrent`
(question-id branch: `if (state.editingQuestionId === null) return true;`):
any editor save/upload became list authority once the editor closed,
bypassing the captured `editFormGeneration` entirely. All six
`runEditExamOperation` call sites and the tracker/tests live only inside the
two allowedPaths files. One inventory checkpoint sent before edits.

## Change (EditExam.tsx)

- New exported `EditExamOperationKind` = `'details' | 'new-draft' |
  'edit-question' | 'delete-list'`; the token carries an immutable `kind`
  captured at `begin()`; `runEditExamOperation` takes `kind` from the actual
  handler (never inferred from current UI).
- `isEditExamOperationCurrent` now selects fencing by captured kind:
  - `details`: route/scope only (unchanged).
  - `new-draft`: draft open + no editor + same draft incarnation (unchanged).
  - `edit-question`: ALWAYS the original target identity AND the captured
    `editFormGeneration` — a closed, switched or reopened editor retires the
    operation; it never falls back to list authority (fixes the 024 third
    reproduction).
  - `delete-list`: no editor required (route/scope fencing + per-question
    completion ordering); a DIFFERENT open editor still fences it, preserving
    023.
- Handlers pass explicit kinds: exam details save `details`; question update
  and edit-form image upload `edit-question`; list Delete `delete-list`;
  add-question and new-draft image upload `new-draft`.

## Tests (m1-expanded-exam-authoring-ui.test.ts)

Existing tests migrated to the new signatures (kinds on tokens and calls);
the "no editor = list authority" unit assertion now asserts the kind-based
rule (delete-list true / edit-question retired). Seven new deferred
production-path tests added for 024:

1. editor upload resolving after the editor closed → superseded (exact 024
   reproduction, editFormGeneration 0→advance, no commit/toast/reload).
2. editor save resolving after the editor closed → superseded, no toast.
3. editor upload resolving after target switch q1→q2 → superseded.
4. editor upload resolving after same-question reopen → superseded (image
   never lands).
5. stale editor failure after editor closed → superseded, no toast.
6. list delete resolving after the editor closes mid-flight → committed
   (list authority needs no editor).
7. list delete fenced when a different editor opens mid-flight; plus a
   control that a current editor failure still toasts and keeps the form.

## Verification

- Runtime: managed Node v22.22.2 (`C:/Users/BaraaWael/.workbuddy-ai/binaries/node/versions/22.22.2-6/node.exe`) + local tsx; command
  `node node_modules/tsx/dist/cli.mjs --test src/tests/*.test.ts`.
- Result: **312/312 pass** (82 in the scoped authoring file), 0 fail.
- Types: `node node_modules/typescript/bin/tsc -p tsconfig.app.json --noEmit`
  → 11 errors, ALL preexisting outside-scope files (NotificationBell,
  StudentHeader_OLD_BACKUP, ExamReports, ExamResults, Fees, StudentBarcodes,
  StudentDashboard, versionChecker); **zero scoped errors**. The root
  `tsconfig.json` is solution-style (`files: []`), so the meaningful check is
  the app project above.
- No live DB/browser/network claims; tests use deferred injected production
  dependencies only.

## Note for the external harness

`runEditExamOperation` now REQUIRES a `kind` parameter and `tracker.begin`
takes `(kind, target, scope, routeGeneration, generations?)`. The external
reproduction must pass the actual handler kind (edit-question for editor
save/upload, delete-list for list delete) — with kind captured, the 024
reproduction (upload q1 → close editor → resolve) is superseded and the two
prior reproductions remain fixed.

## Status

Task reported (not accepted). No artificial duration; all activity on this
claim stopped before the report. No 429, no tool-guard block, no shared/config
change needed — the fix stayed inside allowedPaths. Blockers: none. Questions
for supervisor: none beyond harness signature note above.
