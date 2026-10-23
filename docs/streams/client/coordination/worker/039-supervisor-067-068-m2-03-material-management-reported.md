# M2-03 material management — claimed, implemented, verified, reported

UTC 2026-10-18T17:35Z / Cairo 20:35. Branch `codex/human-client`.
Answers **supervisor/067** (M2-02 acceptance consumed) and **supervisor/068**
(M2-remaining contract requests + bounded M2-03). `worker/038` is the previous
reply; 066 was already consumed by it, so 067 and 068 are the only messages new
to this run.

## Queue / claim mapping (actual, no fabrication)

- `queue_status` called **once**: `active = []`, `ready = [client-m2-03-material-management-20261018-01]`,
  `blocked = []`, `upgradePending = false`, `maxActive 48`, `maxPerTeam 6`.
- `dispatch_plan` called **once** (1 ready, 0 conflicts, 0 unmet dependencies).
- **One** claim via `next_approved_task`, `workerId = wb-m2-03-material-management-01a`,
  team `frontend`. Task approval returned `approval.by = human`,
  `approvalVersion 2`, `scopeHash 05e5aa53e5b5dfd95759d673dd0ece06657a33c85242ec97f2b283d6fcc51a65`,
  basis = the latest direct human request to finish the remaining M2 while
  deferring OTP (060), with the concrete four-path slice described before
  creation and recorded in 068 / `M2-03-HANDOFF.md`. The claim token was held in
  runtime only — never written into any file, report or message.
- `allowedPaths` returned by the claim are exactly the four approved paths, and
  every edit stayed inside them (verified after the last edit).
- Native session id: **not available** to this invocation (`sessionId: null` in
  the bridge record). No liveness is claimed and no native run id is invented.
- Hourly schedule acknowledgement: this automation is ACTIVE with
  `FREQ=HOURLY;INTERVAL=1` and fired on time for this run. Per instruction it is
  not modified, paused or re-created.

## What was changed (four paths only)

1. **`src/features/catalog/material-management.ts`** (new, the production seam
   the page now delegates to):
   - **course lifetime**: every selection advance invalidates all in-flight
     material replies, so `A → B → A` cannot resurrect the first A's rows, and
     an **empty selection clears** the previous list (`idle`) instead of leaving
     it on screen (the pre-existing defect);
   - **session lifetime**: the canonical principal is re-read at claim *and*
     commit through M2-02's accepted `readCourseSessionPrincipal` — one
     canonical session lifetime, exact canonical comparison, no 32-bit digest
     and no historical registry;
   - **form lifetime**: `openForm` / `closeForm` / `isFormCurrent`; a submit
     started by a form incarnation that was closed, replaced or reset since can
     never commit, close or clear a newer one;
   - **operation lifetime**: a synchronous latch is acquired **before** the
     first `await`, released only by its own ticket, and the busy marker is
     owner-scoped so an older `finally` can never clear a newer operation's
     busy state;
   - **separate refresh**: a failed refresh *after* a server-confirmed write is
     reported as `refreshError` and never as a failed write (no duplicate
     recreation invited);
   - **strict duration**: whole minutes ≥ 1 only; blank stays unset;
     `parseInt('30abc') === 30` is refused;
   - **honest external-video refusal**: `video` requires an internal
     `video://` reference and is refused *before any request* otherwise;
     `pdf`/`presentation` links are stored as typed (the Drive conversion
     endpoint is a permanent 410);
   - **delete = soft unpublish** (`unpublishMaterial`), never described as a
     hard delete; failed deletes keep their target for a deliberate retry.
2. **`src/pages/CourseContentManager.tsx`**: rewired to the seam. Distinct
   `idle` / `loading` / `ready` / `empty` / `error` rendering with retry,
   separate refresh banner, per-field errors, disabled submit/delete while busy,
   unpublish wording in the confirmation and the toast, honest video hint and
   `video://` placeholder. RTL/labels/keyboard structure preserved.
3. **`src/tests/m2-material-management.test.ts`** (new): 30 hermetic tests on
   the real seam with injected transport/principal/session.
4. **`docs/streams/client/M2-03-CONTRACTS.md`** (new): the source-verified
   contracts, the documented Drive/video contradiction and the verification
   limits.

No accepted file was modified: `course-management.ts` (M2-02, 067 hashes) and
the seven M2-01 files are untouched — this module only *imports* the accepted
principal reader.

## Verification (local, isolated tools only)

| Check | Before | After |
| --- | --- | --- |
| new `m2-material-management` suite | — | **30/30 pass** |
| all client suites (13 files) | 469/469 | **499/499 pass**, 0 fail/skip/cancel |
| `tsc -p tsconfig.app.json` | 11 outside diagnostics | **same 11 outside, zero scoped** |

The 11 outside diagnostics are unchanged and outside this batch:
NotificationBell, StudentHeader_OLD_BACKUP, ExamReports, ExamResults, Fees,
StudentBarcodes, StudentDashboard, versionChecker. The whole repository is not
type-clean and is not claimed to be.

Runner: managed Node 22.22.2 + the repository's existing local `tsx`. No
dependency install, no live DB/HTTP/browser/provider/Docker, no Git writes.

## Blockers and gaps (reported, not implemented)

- **External video is structurally impossible from this page.** The server
  denies every non-`video://` video row (materials.ts:412-416) and the Drive
  converter is a permanent 410 (materials.ts:577-578), while the page has no
  upload path. The page now refuses honestly; a real upload surface is a
  different (unapproved) feature, not something invented here.
- **`convert-drive-url` is dead server-side** — any client still calling it
  gets 410. This page no longer calls it.
- **No rendered-DOM evidence**: `package.json` has no jsdom/happy-dom/
  @testing-library and installs are forbidden, so RTL paint and real component
  rendering are unproven. UI evidence is the installed component source plus
  the production seam.
- **068's developer-1 contract requests** (C1–C4, C5–C8/C10, C11–C12, and the
  B1–B7/B9–B12/S10/N1/F1 commercial coverage) are **not** answered by this
  reply: they are server/contract deliverables outside this client batch's
  `allowedPaths`, and none is claimed as delivered. OTP stays deferred (060) and
  is not labelled verified.
- `M2-REMAINING.md` is treated as the inventory of record; nothing in it was
  edited by this run.

## State

All work stopped before the report; no child workers, no nested spawning, no
preclaim, no duplicate worker on the claim. Exactly one `submit_task_report`
follows (`reported`, awaiting supervisor acceptance — a worker report is not
acceptance). All pre-existing uncommitted work is preserved; nothing was
reverted, stashed, committed or pushed. No 429 and no tool-guard error occurred.
