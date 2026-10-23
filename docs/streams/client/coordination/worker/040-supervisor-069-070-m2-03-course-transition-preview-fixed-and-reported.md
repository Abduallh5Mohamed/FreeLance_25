# M2-03 correction (070) claimed, implemented, verified, reported

UTC 2026-10-18T18:01Z / Cairo 21:01. Branch `codex/human-client`.

## Messages consumed

- `supervisor/069-m2-03-claimed-independent-review-gates.md` (17:30Z) — claim
  observation, no action requested; the review gate it restates (code and
  architecture, not the report) is what this run acted on.
- `supervisor/070-m2-03-course-transition-preview-not-accepted.md` (17:47Z) —
  GOVERNING: M2-03 not accepted, two production probes 0/2, one source-confirmed
  preview defect, bounded correction task prepared.
- `worker/039` (this stream's previous reply) already consumed 067/068. Nothing
  between 039 and 069/070 was read, and no message was overwritten or deleted.

## Claim / run mapping

- `queue_status` once at 18:00Z: active `[]`, ready
  `client-m2-03-course-transition-preview-20261018-02`, blocked `[]`,
  upgradePending false, maxActive 48 / maxPerTeam 6.
- `dispatch_plan` once (advisory, same single ready task).
- One claim, one worker: workerId `wb-m2-03-course-transition-preview-02a`,
  team `frontend`, taskId as above. `approval.by = human`, approvalVersion 2,
  scopeHash `399a5cc5…9886ce`, basis = the same human M2-03 continuation (068).
- allowedPaths verified before any edit, exactly the four:
  `src/pages/CourseContentManager.tsx`,
  `src/features/catalog/material-management.ts`,
  `src/tests/m2-material-management.test.ts`,
  `docs/streams/client/M2-03-CONTRACTS.md`. Nothing outside them was edited.
- No sessionId was available to this invocation and no native run mapping exists
  to report; that is stated rather than invented. The claim token was held in
  memory only — it is not in this file, the report, any source file or any note.

## Defects fixed (all inside the four paths)

1. **A course transition did not retire the write latch** (probe test 1, 0/1).
   `selectCourse` invalidated the list generation and released only the load
   guard, so `writeGuard` stayed held by the previous course's request: a
   deliberate save on the newly selected course was answered `duplicate` with no
   request until the obsolete one settled — a ready-looking form that silently
   refused every save.
   Fix: the transition also releases `writeGuard`, because the generation
   invalidation has already made every in-flight write uncommittable. Safety is
   unchanged and now explicitly relied on: each `finally` releases with **its own
   ticket** (`release(token)` frees only when `token === owner`), so a retired
   operation can neither free a newer operation's latch nor clear its busy
   marker. No cancellation, rollback or fake success was invented for the
   retired server write; it still completes and still commits nothing.
2. **A malformed refresh body erased confirmed data** (probe test 2, 0/1).
   `runMaterialsLoad` treated a non-array body as `phase: 'error'` +
   `materials: []` on every kind, so a server-confirmed create followed by a
   malformed refresh presented the confirmed write as lost and invited a blind
   re-creation.
   Fix: on a refresh-kind load a non-array body is a *refresh* failure — the
   confirmed rows stay, `refreshError` is set on its own channel, `createError`
   stays null, and the retry is a read only. The initial list load still fails
   closed to `phase: 'error'` (existing behaviour and test preserved).
3. **The video preview lived outside every lifetime fence** (source-confirmed).
   `playingVideo` was page state holding a URL + title captured on click, cleared
   only by `VideoPlayer.onClose`; a course switch, an empty selection or a logout
   left the old preview mounted.
   Fix: the controller now owns `previewMaterialId` only, and the page resolves it
   through the exported `resolvePreviewMaterial(materials, id)` against the
   confirmed list on every render. The id is retired by the course transition,
   the empty selection, the session change, `dispose`, and by any confirmed list
   that no longer contains a playable video row for it — so `A → B → A` does not
   resurrect it and an unpublished row cannot keep the player mounted.
   `VideoPlayer` and its protocol, provider and router were not touched; no
   upload/DRM/M3 surface was added.

Preserved deliberately: grade/group payload and `is_published: true`, strict
duration parsing (no `parseInt` partial read), soft-unpublish wording, honest
external-video refusal (a `video://` reference is still only sent when already
supplied), retained form/values and retained delete target on failure, the exact
canonical session reader re-used read-only from accepted M2-02, and the
controller/page split (no framework change, no shared-module edit).

## Verification (local, hermetic, no live anything)

- `src/tests/m2-material-management.test.ts` **39/39** (was 30, +9: the two
  supervisor probes mirrored with extra assertions on the old-`finally` vs newer
  busy state, malformed-refresh preservation, refresh retry without re-creation,
  and five preview-lifetime tests). No existing assertion was weakened.
- All 13 client files **508/508** (baseline from 067 was 499).
- Supervisor's own out-of-repo probe
  `C:/Users/BaraaWael/TabwebClientSupervisor/070-material-lifecycle.mts`:
  **32/32**, including the two previously failing tests
  (`supervisor070 retired course write must not lock the next course`,
  `supervisor070 malformed refresh keeps confirmed data and separate error`).
- `tsc -p tsconfig.app.json --noEmit`: **zero** diagnostics in the four scoped
  paths, same **11** pre-existing outside diagnostics, command nonzero as before.
- Not proven: rendered DOM/RTL paint, real HTTP, real DB, live services,
  end-to-end authorization (the server stays authoritative). There is no
  jsdom/happy-dom/@testing-library in `package.json` and installing packages is
  forbidden, so the preview fence is proven through the production seam the page
  calls, not through a mounted component.

## Blockers / open items (not claimed here)

- `068`'s developer-1 server contract requests remain unanswered by this worker:
  they are outside this task's allowedPaths and outside client ownership. Tracked
  client-side as narrow future blockers only.
- The real upload/provider surface is still not approved: external video stays
  honestly refused, `video://` is only accepted when already supplied, and the
  Drive conversion endpoint remains a source-confirmed permanent 410.

## Schedule

The WorkBuddy side of this batch runs on the existing hourly automation
(`FREQ=HOURLY;INTERVAL=1`, ACTIVE). This worker cannot pause or edit it, and did
not: schedule/runtime/account changes are forbidden by its standing constraints.
Each hourly run reads only new messages and acts only on a ready approved task.

## State

Two `task_checkpoint` notes at natural milestones and exactly **one**
`submit_task_report` → `reported` / `awaiting_supervisor`. Stopped before the
report; nothing is running. A report is not acceptance, and no further phase is
started. No git writes (no add/commit/checkout/stash/merge/push), no dependency
installs, no DB/network/browser/Docker/live services, no edits to
tasks/state/approvals, bridge configuration, accounts, runtime or schedules, and
no 429 or tool-guard error in this run. All pre-existing uncommitted work —
including the accepted 039/055/067 files — is preserved untouched.
