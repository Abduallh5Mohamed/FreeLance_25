# M2-02 acceptance correction (061) claimed, implemented and reported

UTC2026-10-18T16:14Z / Cairo19:14. Branch `codex/human-client` verified.
Worker: `wb-m2-02-dialog-target-02a`. Task
`client-m2-02-dialog-target-lifecycle-20261018-02`
(batch `client-m2-02-20261018`, role `m2-02-existing-course-management-client`).
No native run/session id exists in this invocation; `sessionId` was not set and
no liveness is claimed beyond this run's own activity.

## What was read

Coordination README + `tools/workbuddy-bridge/WORKER-PROMPT-CLIENT.md`, then
ONLY the five supervisor messages newer than `worker/035`: `059`, `060`, `061`,
`062`, `063`. No other supervisor message was re-read; nothing in
`supervisor/` was modified or deleted.

- `059` — claim/inventory checkpoint observation, plus review notes
  (Infinity is truthy under `parseFloat(...)||0`, keep the optional/blank price
  semantics, grade must not be silently nulled). Noted; no numeric policy
  changed.
- `060` — OTP/paid-provider deferred by the human. Recorded as a dependency
  only; no OTP code, no provider account, no scope expansion.
- `061` — the governing correction (three findings + the `readPrincipal` gap).
- `062` / `063` — the correction is ready and unclaimed; both explicitly ask
  for no acknowledgment-only reply. This file is the substantive reply 061
  asks for, not an ack.

## Queue (one `queue_status`, one `dispatch_plan`)

- `queue_status` once: `active=[]`, `ready=[client-m2-02-dialog-target-lifecycle-20261018-02]`,
  `blocked=[]`, `upgradePending=false`, `maxActive=48`, `maxPerTeam=6`.
- `dispatch_plan` once (advisory, same single ready task).
- One claim, one unique workerId `wb-m2-02-dialog-target-02a`. Claim token held
  in runtime only — not written to any file, report, checkpoint or message.
- `allowedPaths` returned by the claim, verified before any edit:
  `src/pages/Courses.tsx`, `src/features/catalog/course-management.ts`,
  `src/tests/m2-course-management.test.ts`, `docs/streams/client/M2-02-CONTRACTS.md`.
  Nothing outside them was touched.

## Inventory before editing

`git status --porcelain`: 7 tracked files dirty; the 6 pre-existing M1/M2-01
files (JoinInstructor, StudentSpaces, TenantInvitation, M2-HANDOFF,
coordination README, automation memory) were left exactly as found. Scoped file
sizes: Courses.tsx 540 lines, course-management.ts 712, m2-course-management.test.ts
591, M2-02-CONTRACTS.md 81.

## Fix — the three 061 findings, plus the principal gap

### 1. Archive target incarnation (061 finding 1)

`src/features/catalog/course-management.ts`: a `deleteTargetTicket`
incarnation is advanced by every `requestArchive`, by every `cancelArchive`,
and by `retireInFlight()` (session change / dispose). `confirmArchive` captures
it and may commit only while `isTargetCurrent(ticket)` holds. A late A success
can no longer clear B's target; a late A failure can no longer write A's error
onto B.

### 2. Radix action auto-close (061 finding 2)

`src/pages/Courses.tsx`: the confirm control is now a plain `Button`, not
`AlertDialogAction` — the installed action renders a `Close` child that fires
`onOpenChange(false)` on click, which cancelled the target before the awaited
request resolved and defeated failure retention. Dismissal (Escape/overlay)
while `busyKind === 'archive'` is now ignored and `AlertDialogCancel` is
disabled while busy, so only a server-confirmed archive of the **current**
target closes the dialog. Cancel semantics are preserved: `cancelArchive`
retires the incarnation, so an already-sent request can no longer commit.

### 3. Form/dialog and session lifetime inside the page (061 finding 3)

- Controller: new `openForm(target)` / `closeForm()` / `isFormCurrent(instance)`
  and `submit(form, target, instance?)`. A save whose dialog was closed or
  replaced returns `blocked` and commits nothing (checked before the request and
  again at completion).
- Page: `openCreateDialog` and `handleEdit` open a new incarnation;
  `handleSubmit` re-checks `controller.isFormCurrent(instance)` after the await
  before closing/resetting or toasting; closing the dialog retires it.
- Page: a new effect subscribes to the canonical `session-events` notifier and
  clears the page-owned `formData`, `editingCourse`, `selectedCourse` and all
  three dialogs on every session change. Previously the controller cleared only
  its own state, leaving the previous scope's form and detail dialog on screen.
- Hardening: both completion paths now clear busy through `clearBusy(ticket)`
  (ticket ownership) instead of patching `busyKind` directly, so a retired
  completion can never clear a newer operation's marker.

### 4. `readPrincipal` gap (061)

New exported `digestSessionToken` (djb2, base36) and `buildCoursePrincipal` in
the controller. The page's `readPrincipal` now includes a NON-REVERSIBLE digest
of the canonical `authToken` plus `billing_only`, so a token rotation or a
silent re-login that keeps the same `id:role` invalidates in-flight writes. The
raw token is never stored in state, rendered, logged or sent.

`Infinity` is truthy under `parseFloat(...)||0` — 061 is right, and the strict
parser already refuses it (`nonfinite` for the number case, `malformed` for the
string `"Infinity"`); the refusal stands, no pricing policy invented.

## Verification (independent numbers, this run)

Managed Node 22.22.2 + local `tsx`, hermetic, no DB/network/browser/services,
no installs, no git writes:

- `src/tests/m2-course-management.test.ts` **46/46** (was 33; +13 new), the
  pre-existing 33 unchanged and still passing.
- All 12 client suites **454/454** (was 441).
- Supervisor's own out-of-repo probe
  `C:/Users/BaraaWael/TabwebClientSupervisor/061-course-target-races.mts`
  (`--test-name-pattern supervisor061`): **2/2 pass** (was 0/2).
- `tsc -p tsconfig.app.json --noEmit`: **zero diagnostics in the four scoped
  files**; the same 11 pre-existing out-of-scope errors remain untouched
  (NotificationBell:59; StudentHeader_OLD_BACKUP:496/510; ExamReports:78/82;
  ExamResults:104; Fees:483/497; StudentBarcodes:99; StudentDashboard:127;
  versionChecker:28).

`docs/streams/client/M2-02-CONTRACTS.md` gained a section 4bis documenting the
three defects and the principal fix, plus the updated counts.

## Honest limitations

- No DOM/browser render test: no jsdom/happy-dom is installed and installing one
  is forbidden. Finding 2 is proven from the INSTALLED Radix source plus the
  controller/page seam tests, not from a rendered click.
- No real HTTP, DB, or end-to-end authorization: the server stays authoritative.
- Dismissal is blocked only while an archive is genuinely in flight.
- This is a worker report, not acceptance. M1/039 and M2-01/055 remain closed;
  OTP stays deferred per 060; the `subscription_id` gap is still documented only
  (no removal, no invented backend contract); the archive (not hard-delete)
  wording is preserved.

## Constraints respected

No edit to tasks/state/approvals, bridge configuration, accounts, runtime or any
schedule. No git writes (no add/commit/checkout/stash/merge/push). No dependency
installs. No live DB/services/network providers/Docker. No M2 beyond the
human-approved M2-02 correction, no new phase, no scope expansion, no
self-acceptance. Two checkpoints (inventory/implementation; tests+verification)
and exactly one `submit_task_report` for this task, all inside this one
continuous run. No claim token written anywhere. No 429 or tool-guard error.

## Worker-hourly schedule acknowledgement (061/062 ask it explicitly)

The only hourly check on this workspace is this automation:
`FREQ=HOURLY;INTERVAL=1`, status ACTIVE, cwd `D:\FreeLance_25-1\FreeLance_25-1`.
It cannot be paused from here — schedule/runtime edits are a hard constraint, so
the control limitation is reported rather than worked around. Codex's own
quarter-hour review task is its own scheduling domain and was not touched.
