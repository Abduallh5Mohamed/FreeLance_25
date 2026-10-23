# Two M1 corrections implemented and reported; decisions on 007 answered

- **Author:** WorkBuddy (client worker/coordinator)
- **UTC timestamp:** 2026-10-16T15:43:27Z
- **Replies to:** `supervisor/007-hourly-ack-decisions-and-source-followups.md`
- **Branch:** `codex/human-client`
- **Changed paths by this message:** `docs/streams/client/coordination/worker/007-two-tasks-reported-and-supervisor-decisions.md` (new file only)

Both ready tasks from `supervisor/007` were claimed via MCP, implemented inside their
narrowed `allowedPaths`, and reported. `supervisor/007` was the only new message since
`worker/006`; no other supervisor message was unread. No claim token, credential or
student data appears in this file.

## 1. Bridge state at this check

`queue_status` called once at the start of the round: `active: []`, `ready` =
`[client-m1-final-review-20261016-04, client-m1-final-review-20261016-06]`,
`blocked: []`, `upgradePending: false`, `maxActive: 48`, `maxPerTeam: 6`.
`dispatch_plan` called once (ready tasks existed). One claim per task, one unique
workerId per claim, no nesting, no preclaim, no scope edit.

| task | workerId | allowedPaths (from the claim) |
| --- | --- | --- |
| `client-m1-final-review-20261016-04` | `wb-client-worker-20261016-04a` | `src/pages/ManualGrading.tsx`, `src/tests/m1-sprint-exam-ui.test.ts` |
| `client-m1-final-review-20261016-06` | `wb-client-worker-20261016-06b` | `src/pages/Subscriptions.tsx`, `src/tests/m1-sprint-subscription-ui.test.ts` |

Each task received one checkpoint after inventory, one checkpoint after the tests went
green, and exactly one `submit_task_report` (`reported`). No other path was written.
`git status` still lists the same 22 tracked files as before the round; the overall
working-tree diff moved from 3666/439 to 4162/450 lines, i.e. this round added 496
insertions and 11 deletions, all inside the four scoped paths. No predecessor change
was reverted. No 429 and no tool-guard error occurred.

## 2. Task 04 — ManualGrading (both findings corrected)

1. **Selector loads are no longer silently swallowed.** `fetchGrades`/`fetchGroups`
   committed only `ok && !malformed` and only `console.error`'d thrown errors, so 401,
   403, a missing token, a network failure and a malformed body all rendered as a
   legitimately empty, retry-less selector. Added the exported pure mapper
   `describeSelectorLoadFailure` plus separate `gradesError`/`groupsError` state and a
   visible retry action; a failed load keeps the last good rows, and no error object or
   non-array body can reach array state.
2. **Mutation completion is tied to a scope generation, not string equality.**
   `GradingSubmitterHooks` now exposes `getScopeGeneration`; `createGradingSubmitter`
   compares the generation captured at submit with the generation at resolve, and the
   page increments it on every real grade/group change. A pending first-A submit that
   resolves after an A → B → A roundtrip therefore no longer deletes the newly loaded or
   re-edited A row, while a submit resolving inside its own generation still removes it.
   Duplicate suppression and failed-submit retention (row plus entered scores kept on
   401/403/500) are unchanged.
3. A 2xx non-array pending-attempts body is now an error state
   (`describePendingLoadFailure`), not a silent empty list.

Tests 34/34 (25 before). Regression strength: under the previous string-equality rule the
new A → B → A test would fail, because the old rule removes the row.

## 3. Task 06 — Subscriptions (finding corrected)

The stale edit target can no longer leak into an explicit Add. The dialog is now a single
explicit state object `{open, editing, form}` driven by exported production transitions —
`beginCreateSubscription()` (Add: clears the target, empty form), `beginEditSubscription(row)`,
`completeSubscriptionSave()` (successful save: closes and clears the target),
`closeSubscriptionDialog(state)` (keeps the target so a failed save can be retried), and
`resolveSubscriptionSubmitTarget(editing)`, which the page's `handleSubmit` consumes to
choose create vs update. Edit → close/save → Add → submit now calls `createSubscription`
once with fresh state and never `updateSubscription(oldId)`; a failed save still returns
early, preserving the edit target and the entered values. `load()` additionally treats a
non-array body as an error instead of committing `[]` through
`Array.isArray(rows) ? rows : []`, so invalid server data is distinguishable from a
genuinely empty list. The single-flight latch, load-generation guard, zero-price
preservation and successful-mutation-vs-reload-failure authority are unchanged.

Tests 35/35 (27 before). The malformed-list change is a behaviour change beyond the exact
wording of the finding — flagged as a question in the report.

## 4. Verification (both tasks)

- Runtime: `C:/Users/BaraaWael/.workbuddy-ai/binaries/node/versions/22.22.2-6/node.exe`
  with `node_modules/tsx/dist/cli.mjs --test`. Reproducible command for your independent
  run, from the workspace root:
  `C:/Users/BaraaWael/.workbuddy-ai/binaries/node/versions/22.22.2-6/node.exe node_modules/tsx/dist/cli.mjs --test src/tests/m1-sprint-exam-ui.test.ts src/tests/m1-sprint-subscription-ui.test.ts`
- Scoped suites: 34/34 and 35/35. All seven `src/tests/*.test.ts` suites: 227/227 pass,
  0 fail, 0 cancelled.
- `tsc -p tsconfig.app.json --noEmit`: exactly 11 diagnostics, identical to the recorded
  pre-existing set (all in `NotificationBell.tsx`, `StudentHeader_OLD_BACKUP.tsx`,
  `ExamReports.tsx`, `ExamResults.tsx`, `Fees.tsx`, `StudentBarcodes.tsx`,
  `StudentDashboard.tsx`, `versionChecker.ts`). Zero in any of the four scoped files.
  `tsconfig.app.json` includes `src`, so the scoped test files were type-checked, not
  filtered out.
- `eslint` on the two page files: 0 errors (26 pre-existing `react-refresh` warnings).

## 5. Decisions on `supervisor/007`

### 5.1 Offline course persistence — agreed, blocker stays narrow

Agreed: no demonstrated direct write contract exists, and neither a new backend endpoint
nor diversion through the approval flow is authorized. I will keep the narrow blocker
explicit and will not describe the whole flow as accepted merely because a
non-persistence notice is shown. No endpoint or business-policy decision is made here.
This is a human/Codex contract decision, not something I will implement under M1.

### 5.2 Committed meeting links — scoped defense proposed (proposal only)

Agreed that a `storage` listener alone cannot close this: the `storage` event does not
fire in the document that performs the change. I also confirm the missing upstream
contract is real — `src/pages/StudentMeetings.tsx:70-73` documents that the app exposes
no reactive auth signal (no auth context; `AuthGuard` reads localStorage once on mount).

Proposal, for an exact approved task only:

1. **Deterministic action-time re-authorization.** The page already computes a load scope
   in `meetingLoadScope()` (`StudentMeetings.tsx:78-82`, userId + token) and already
   documents it as the scope a load was issued under (`:63-73`). Recompute it at the
   moment of action and refuse the action when it is `null` or differs from the scope the
   currently rendered links were loaded under:
   - `joinMeeting` (`:350-362`) — gate before `window.open` at `:361`, reusing the
     existing invalid-link toast at `:351-358`;
   - the copy path (`copyToClipboard` at `:258-259`, invoked at `:523`) — gate before
     writing to the clipboard.
2. **Best-effort refresh trigger, not enforcement.** On `window` `focus` and `document`
   `visibilitychange` (when becoming visible), re-evaluate the scope and, if it changed,
   call the loader invalidation already used on unmount
   (`meetingsLoaderRef.current?.invalidate()`, `:346`) so a re-render drops the links.

What this guarantees versus what it only reduces, stated plainly:

- **Guaranteed:** a user who has signed out, or whose token/tenant changed, in *this*
  document can no longer open or copy an already-rendered private link, because the check
  reads the live stored identity/token at click time. This closes the gap for every
  *action* path.
- **Not guaranteed:** the link text and URL remain visible on screen until something
  causes a re-render. Only a reactive auth signal — which the app does not expose
  (`:70-73`) — can remove an already-rendered link synchronously. The focus/visibility
  refresh narrows the exposure window to "until the tab is next focused or becomes
  visible"; that is risk reduction, not immediate removal.
- **Out of reach client-side:** a link already copied to the clipboard before sign-out
  cannot be revoked from the page at all.

This is proposal and discussion only. I have not edited `StudentMeetings.tsx`,
`OnlineMeeting.tsx`, `AuthGuard.tsx` or any shared auth code, and no token value appears
here.

### 5.3 Orphan banner — coverage-limit decision accepted

Understood and accepted: controller/adapter coverage is the declared hermetic testing
boundary for this batch, no DOM dependency or package change is required or approved, and
this is a coverage limit — not a claim that the rendered banner was tested. I will not
describe the rendered banner as verified. (The same boundary applies to the new selector
banner and retry button in task 04.)

### 5.4 Barcode ownership — classification corrected

Correction accepted: `src/pages/BarcodeAttendance.tsx` **is** owned by original task 03 and
by its first follow-up; `worker/005` said otherwise and that statement was wrong. I am not
repeating it.

The mixed UTC/local observation is still not a product decision, so here is the exact
backend date contract and a concrete near-midnight counterexample, as requested. Server
files were read only; nothing was changed.

**Contract (verified by reading the server):**

- `server/src/routes/attendance.ts:110-117` — `normalizeDay()` accepts a `Date` or any
  string `new Date()` can parse, and returns `parsed.toISOString().slice(0, 10)`, i.e. the
  **UTC** calendar day; shape pinned by `DAY_PATTERN` at `:92` (`^\d{4}-\d{2}-\d{2}$`).
- `POST /attendance` (`:433`) — `attendance_date` absent defaults to
  `normalizeDay(new Date())` (`:456`), the current **UTC** day; present-but-unparseable
  returns 400 `Invalid attendance_date` (`:452-458`).
- Duplicate detection compares the stored column against that same day string:
  `WHERE a.student_id = ? AND DATE(a.attendance_date) = ?` (`:543`).
- `GET /attendance` runs its `date` filter through the same `readOptionalDay`/`normalizeDay`
  path (`:329`, `:357-359`), so `date=YYYY-MM-DD` is interpreted as a UTC day.
- `attendance_time` is written with `CURTIME()` (`:527`) — the MySQL server's local
  wall-clock time, a different clock origin from `attendance_date`.

**Client mixing:** UTC day at `BarcodeAttendance.tsx:177`, `:401`, `:501`, `:590`
(matches the contract) versus local date parts at `:193-194`, `:263-265`, `:572-573`
(does not). `getPreviousScheduledDay` (`:41-44`) mixes both inside one function: it walks
with local `getDate()`/`getDay()` and then returns
`candidate.toISOString().split('T')[0]`, a UTC day.

**Counterexample (Africa/Cairo, UTC+2 — the app's own `ar-EG` locale):**

- Teacher scans at 2026-06-02 00:20 local. `new Date()` is 2026-06-01T22:20:00Z, so
  `:401` sends `attendance_date = "2026-06-01"` and the row is stored on **2026-06-01**,
  one day before the teacher's local day.
- In the same screen, `fetchAbsentStudents` derives `today` from local parts at `:263`
  (`"2026-06-02"`) and filters the present set by that local day at `:274-277`, while the
  list load at `:177`/`:183` queried `date = "2026-06-01"`. The page therefore disagrees
  with itself between 00:00 and 02:00 local.
- Duplicate protection follows the UTC day (`:543`): a scan at 23:50 local on 2026-06-01
  (day `2026-06-01`) and a scan at 00:20 local on 2026-06-02 (day `2026-06-01`) are treated
  as the same day, while a scan at 01:00 local and 20:00 local on 2026-06-02 (days
  `2026-06-01` and `2026-06-02`) produce two records for one local day.
- Symmetrically, west of UTC the same expression shifts the other way: 2026-06-01 20:00
  local at UTC-5 is 2026-06-02T01:00Z, so an evening scan lands on the *next* day.

**Minimal fix, if you approve it:** keep the server untouched and make the page send one
convention — the server's UTC day — through a single scoped helper
(`toUtcDay = (d: Date) => d.toISOString().slice(0, 10)`), replacing the local-part
computations at `:193-194`, `:263-265`, `:572-573`, the local walk inside
`getPreviousScheduledDay` at `:41-44` (use `setUTCDate`/`getUTCDay`), and
`const today = toUtcDay(new Date())` at `:263`. That makes the write day, the list filter
and the absent computation identical and keeps duplicate detection aligned with what the
server stores. This file is outside every claim I hold and the choice of which calendar
day a near-midnight session belongs to is arguably a product decision, so I am not
implementing it. It needs an approved scoped task; I am reporting it, not acting on it.

### 5.5 Runtime evidence — acknowledged

Accepted, no dispute. The exact already-installed runtime is
`C:/Users/BaraaWael/.workbuddy-ai/binaries/node/versions/22.22.2-6/node.exe`; no installs,
no runtime/account/config changes were made. The reproducible command is in §4.

## 6. Not done, deliberately

No git write (no add/commit/checkout/stash/merge/push), no dependency install, no shared
helper, config, package, schema, migration, server or bridge change, no task/state/approval
edit, no M2, no new phase, no self-acceptance. The two reports are `reported`, not
accepted; M1 acceptance remains with you. The four open items in `worker/005` §3.1–3.4
remain open exactly as `supervisor/007` framed them, with the BarcodeAttendance
classification corrected above.

Round ends here. No further action until the next scheduled check or new supervisor
message.
