# M2-01 implemented, tested and reported — completion record with independent verification

- **Author:** WorkBuddy (client worker/coordinator)
- **UTC timestamp:** 2026-10-17T19:17:08Z (22:17 Cairo local)
- **Replies to:** `supervisor/047-m2-01-operator-approval-task-ready.md` and
  `supervisor/048-m2-01-claimed-contract-inventory-started.md`
- **Branch:** `codex/human-client`
- **Changed paths by this message:** `docs/streams/client/coordination/worker/031-m2-01-implemented-tested-and-verified.md` (new file only)

## 1. Claim and task lifecycle

- Task `client-m2-01-enrollment-workflows-20261017-01` (batch `client-m2-01-20261017`,
  frontend/write) was claimed **once** by the native worker `wb-m2-01-01a`. The claim
  returned the **exact** seven approved `allowedPaths` (scopeHash `b345ab…80618`); no
  mismatch, no second claim, no preclaim, no replacement worker. No 429 and no tool-guard
  error occurred at any point.
- The worker checkpointed at natural milestones and submitted exactly **one**
  `submit_task_report` (`status: reported`, receipt `awaiting_supervisor`) **within the same
  continuous session as the claim** — the claim token never crossed a session boundary and
  appears in no file, report or message.
- `queue_status` after the report: `active: []`, `ready: []`, `blocked: []` — the claim was
  released by the report. The batch is complete on the worker side; **acceptance remains
  with the coordinator** and has not been claimed by the worker.

## 2. What was implemented (inside the approved paths only)

New production seam (smallest unit actually used by the pages, no generic framework):

- `src/features/enrollment/workflows.ts` (724 lines, new) — join-invite, tenant-activation
  and student-spaces controllers with a **synchronous** single-flight latch (set before the
  first `await`), a monotonic generation sequence for stale-reply fencing, documented
  failure classification, and injected transport/storage/notifier boundaries.

Pages rewired to the seam (existing Arabic copy and page structure preserved):

- `src/pages/JoinInstructor.tsx` — the invitation load no longer keeps previous invitation
  data or commits a stale reply; submit/reset use the synchronous latch instead of React
  busy state.
- `src/pages/TenantInvitation.tsx` — activation is gated by an immediate latch (no
  render-time window), fields carry proper labels/keyboard handling with `Enter` submit,
  and a live hash-token guard rejects an incomplete link.
- `src/pages/StudentSpaces.tsx` — explicit loading / empty / error states; single-flight
  space selection; after a token swap a **profile-load failure discards the stale
  currentStudent/currentStudentSpace**, notifies `'identity'`, never restores the old
  token, and retry re-reads only the profile.

Contracts (read from source BEFORE any behaviour change, as the task required):

- `docs/streams/client/M2-CONTRACTS.md` (301 lines, new) pins every method/path/body/query,
  principal/tenant context, field types, null/empty handling, real 401/403/404/409/410/429/
  503 behaviour, expiry, and join-success semantics for the eight client functions with
  `file:line` citations (api-http.ts, session-events.ts, server routes
  `student-enrollment.ts` / `tenant-invitations.ts` / `students.ts` / `auth.ts`).
- It records the shared-request limitation Codex flagged in `048`: `api-http.ts:69-89`
  throws the server **message**, never the numeric status, so no client branch on 4xx/5xx
  numbers exists or was invented. The server messages are the contract surface; visible
  server errors are preserved as errors.
- Unbuilt spec-19 items are documented as fail-closed gaps (OTP, online payment, 30-day
  entitlement, 410 backfill resolve). No activation success is inferred from client state;
  pending-approval semantics of the 202 join response are pinned verbatim.

## 3. Independent verification (re-run by the coordinator, not relayed)

Runtime for all test runs — the managed Node with `registerHooks`:
`C:/Users/BaraaWael/.workbuddy-ai/binaries/node/versions/22.22.2-6/node.exe node_modules/tsx/dist/cli.mjs --test …`

- **New M2 suites** (`src/tests/m2-enrollment-workflows.test.ts`,
  `src/tests/m2-tenant-invitation.test.ts`): **36 tests, 36 pass, 0 fail, 0 skipped** —
  duplicate-before-render suppression, failure-then-retry, 401/403/expired handling,
  invitation A→B→A with reversed completions, unmount invalidation, token-swap-then-
  profile-failure, malformed-payload fail-closed. The tests drive the production
  controllers through injected transport/storage/clock; no copied orchestration.
- **Full M1 regression** (all nine existing client suites, including
  `m1-attendance-calendar` and `m1-session-contract`): **342 tests, 342 pass, 0 fail,
  0 skipped** — no regression in accepted M1 work.
- **Full typecheck** — `./node_modules/.bin/tsc --noEmit -p tsconfig.app.json --pretty false`
  → exit 2 with **exactly the 11 known pre-existing out-of-scope diagnostics**
  (`NotificationBell.tsx:59`, `StudentHeader_OLD_BACKUP.tsx:496/510`,
  `ExamReports.tsx:78/82`, `ExamResults.tsx:104`, `Fees.tsx:483/497`,
  `StudentBarcodes.tsx:99`, `StudentDashboard.tsx:127`, `versionChecker.ts:28`) and
  **zero diagnostics in any file created or changed by this batch**.
- **Scope audit**: every changed/untracked path is either one of the seven approved paths
  (`src/features/` contains only `enrollment/workflows.ts`), pre-existing uncommitted work
  (`M2-HANDOFF.md`, coordination `README.md`, the automation memory log) or the
  coordination mailbox itself. No `src/lib/**`, server, component, package, config, schema,
  migration, bridge, `tasks/state/approvals` or schedule change.
- **Secret scan** across the diff and all four new files: no claim token, Bearer value,
  40+ hex string or credential anywhere.

## 4. Open items reported, not invented (need a human/coordinator decision)

1. **Tenant-invite link format.** The page preserves the existing `#token=…` fragment
   semantics; if invitation emails ever use a different fragment shape the page correctly
   shows the "incomplete link" state. Confirm the real email format before any change.
2. **Status-specific UX is impossible on the approved contract.** Because `api-http`
   drops the numeric status (documented above), distinguishing e.g. 403 from 404 by status
   class would require an api-http change — outside this batch's allowedPaths — so it was
   **reported narrowly with source evidence, not attempted**, per `048`'s instruction.

## 5. Not done, deliberately

No git write (no add/commit/checkout/stash/merge/push), no dependency install, no real
DB/network/provider/Docker/browser run, no api-http/server/router/shared/auth edit, no
OTP/checkout/entitlement invention, no M3 or further M2 batch, no scope expansion, no
self-acceptance. All pre-existing uncommitted work was preserved; nothing reverted. No
earlier message was overwritten or deleted; this record is a new uniquely named file and
the only path this message changed.

Next review gate: the coordinator's independent assessment of this batch against the
handoff's acceptance criteria (real production-path tests, scoped type diagnostics zero,
exact commands, honest contract gaps).
