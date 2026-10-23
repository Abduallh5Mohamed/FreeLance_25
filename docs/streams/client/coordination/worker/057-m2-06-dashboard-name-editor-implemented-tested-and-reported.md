# M2-06 dashboard name editor — implemented, verified and reported

**Task:** `client-m2-06-dashboard-name-editor-20261019-01`
**Worker:** `opencode-worker-20261019-1750-m2-06` (same claim resumed after
host interruption under supervisor132; no re-claim, no new worker, no ownership
transfer). **UTC:** 2026-10-19T15:26Z — **Branch:** `codex/human-client`.
Native session ID is not exposed by the available tooling; the continuation ran
in the same native conversation context and the original claim token remained
usable, so no private claim file was read.

## Changed paths (exact five allowed products + this coordination report)

- `src/lib/api-http.ts` — additive `updateMyTenantProfile` over the existing
  authenticated `request`: `PATCH /tenants/me/profile`, body
  `{"business_name": ...}` only, no tenant selector, no shared auth/error change.
- `src/features/tenant/profile.ts` — bounded edit lifecycle on the accepted
  read controller: synchronous single-flight, shared GET/PATCH generation, form
  draft/generation lifetimes, session/silent-principal/dispose fences, exact
  trimmed `1..255` validation, honest transported-message failures, uncertain
  write retention and deliberate GET reconciliation.
- `src/pages/InstructorDashboard.tsx` — small labeled form on the existing card
  (owner-only hint, save/cancel, busy/error/uncertain states, keyboard
  Enter/Escape, `aria-live`); no new route/screen.
- `src/tests/m2-tenant-profile-edit.test.ts` — new hermetic production-path
  suite (23 tests).
- `docs/streams/client/M2-06-CONTRACTS.md` — actual contract/evidence/limits.
- This report only in `docs/streams/client/coordination/worker/`.

## Before/after behavior

Before: the card showed the accepted read-only server profile; there was no
write control. After: the verified owner can open the form, submit only the
trimmed institution name through the accepted PATCH, and see the card update
only after a validated same-session success. A 404/409/400 keeps the valid
read-authorised profile and the draft; 401/403 clears identity/draft; 500,
network and malformed 2xx are treated as uncertain with no automatic PATCH
retry and an explicit one-GET reconciliation that is explicitly not proof of
the previous write. Old GET/PATCH replies, canceled/reopened forms, silent
principal changes and disposal cannot commit.

## Verification (actual commands, locally run)

- `.\node_modules\.bin\tsx.cmd --test src/tests/m2-tenant-profile-edit.test.ts`
  → **23/23 pass**, 0 fail/cancel.
- Unchanged accepted read suite
  `.\node_modules\.bin\tsx.cmd --test src/tests/m2-tenant-profile-ui.test.ts`
  → **38/38 pass**.
- Nearby shared-helper regression
  `.\node_modules\.bin\tsx.cmd --test src/tests/m2-course-management.test.ts`
  → **61/61 pass** (file unchanged).
- `.\node_modules\.bin\tsc.cmd -p tsconfig.app.json --noEmit` → **zero errors in
  the five paths**; the known **11 outside** diagnostics remain (NotificationBell,
  StudentHeader_OLD_BACKUP×2, ExamReports×2, ExamResults, Fees×2,
  StudentBarcodes, StudentDashboard, versionChecker). No pre-change measurement
  was captured in this resumed run because the host was interrupted; only the
  current measurement is claimed.
- `.\node_modules\.bin\eslint.cmd` on the changed/new files: no errors in
  `profile.ts` or the new test; reported `no-explicit-any`/dependency warnings
  are on unchanged legacy lines of `api-http.ts` and `InstructorDashboard.tsx`.
- `git diff --check` on the two tracked changed product files → exit 0.
- Request-count evidence: one PATCH per explicit save, duplicate same-tick save
  suppressed, no automatic GET after confirmed success, reconciliation exactly
  one GET and no repeated PATCH.

## Limitations / blockers

- No DOM/RTL/browser, real HTTP/DB, provider or live-service run; fake local
  transport only. No performance/latency claim.
- Real row locking, commit ambiguity and audit rollback remain server integration
  concerns; the accepted129 contract was not re-run here.
- Work is stopped. Codex independently reviews stable source/contracts/tests/
  types and decides acceptance; this report is not self-acceptance.

## Schedule

Next scheduled **check** (not a guaranteed implementation start):
**2026-10-19 18:33:58 Africa/Cairo (UTC+3)**, about **8 minutes 12 seconds**
from 18:25:46 local at report-writing. The scheduled task showed state
`Running` (this run) with `IgnoreNew`, so if this run overlaps that trigger the
next check may be deferred by the scheduler; no exact start is promised and the
schedule was not changed.
