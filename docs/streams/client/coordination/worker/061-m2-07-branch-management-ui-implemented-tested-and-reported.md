# M2-07 branch management UI — implemented, verified locally, stopped

2026-10-19T19:38Z · branch `codex/human-client` · task
`client-m2-07-branch-management-ui-20261019-01` · worker `opencode-worker-061`
(existing claim resumed, native session `ses_eaa82fdbaffex8u7Fh6fDGvAke`).
Governed by human152/153, supervisor159/160. No new task, no ownership change,
no self-acceptance, no schedule change.

## Scope actually implemented (exactly the six 153 allowed paths)

- `src/features/tenant/branches.ts` (new) — injected production request/form
  lifecycle: explicit panel open, one bounded 25-row page, next/first paging,
  create/rename/archive/reactivate, strict runtime DTO validation, uncertain
  write handling, page/request/form/session generations, canonical principal
  observation at entry and at both stale completions, close/dispose fences.
- `src/features/tenant/BranchManager.tsx` (new) — dedicated Arabic/RTL
  component (rendering and labels only, no request logic).
- `src/lib/api-http.ts` (modified) — additive only: `TenantBranchStatus`,
  `TenantBranch`, `TenantBranchListEnvelope`, `TenantBranchEnvelope`,
  `TENANT_BRANCH_PAGE_LIMIT = 25`, `listMyTenantBranches`, `createMyTenantBranch`,
  `updateMyTenantBranch` over the existing `request`. No change to `request`,
  auth, errors, session events, teardown, `clearAuthToken` or the BILLING_ONLY /
  TENANT_SUSPENDED semantics.
- `src/pages/InstructorDashboard.tsx` (modified) — mount only: one import and
  `<BranchManager />`; the accepted 144 profile card is untouched.
- `src/tests/m2-tenant-branches-ui.test.ts` (new) — 43 hermetic tests driving
  the real controller and the real transport with a fake fetch/localStorage/window.
- `docs/streams/client/M2-07-CONTRACTS.md` (new) — source contract, request
  counts, evidence and coverage limits.

No backend, schema, migration application, package/config, provider, router,
shared auth/error/profile or accepted-test file was edited. The accepted 151
migration FILE stays unapplied.

## Before / after

Before: the accepted 151 branch metadata API and migration FILE existed with no
client surface; the dashboard had no branch control.

After: the existing dashboard mounts a dedicated branch panel that is opened
**explicitly** by the user. One bounded page (25 rows) is listed with
next/first-page navigation over the server's opaque cursor, and a server
authorized owner can create, rename, archive and reactivate branch metadata.
Owner-only is a label only — no capability is inferred from the local role,
profile or tenant status, and the server stays authoritative. Transport and
DTO shapes are exactly the accepted 151 contract; a PATCH response whose id
does not match the requested branch id is not a success.

## Request counts and bounds proven by the tests

| Action | Requests |
| --- | --- |
| Panel closed | 0 |
| Explicit open | 1 × GET (`limit=25`, no cursor) |
| Next page / first page / refresh | 1 × GET per press (a duplicate press is dropped) |
| Create | 1 × POST (+ at most 1 bounded GET after a **confirmed** success) |
| Rename / archive / reactivate | 1 × PATCH, no extra GET |
| Uncertain write (500/network/malformed/id mismatch) | 0 automatic write retries and 0 automatic reads; deliberate "read current list" = 1 × GET |
| Duplicate click on any action | 0 extra requests |

Memory bound: exactly one page (≤ 25 rows) is held; pages are replaced, never
accumulated. No polling, no all-page draining, no eager query for a viewer who
never opens the panel.

## Validation actually executed in this native session

Baselines before the change:
- `.\node_modules\.bin\tsx.cmd --test src/tests/m2-tenant-profile-ui.test.ts` → 38 pass / 0 fail
- `.\node_modules\.bin\tsx.cmd --test src/tests/m2-tenant-profile-edit.test.ts` → 33 pass / 0 fail
- `.\node_modules\.bin\tsx.cmd --test src/tests/m2-course-management.test.ts` → 61 pass / 0 fail
- `.\node_modules\.bin\tsc.cmd -p tsconfig.app.json --noEmit` → 11 known outside
  diagnostics (NotificationBell, StudentHeader_OLD_BACKUP×2, ExamReports×2,
  ExamResults, Fees×2, StudentBarcodes, StudentDashboard, versionChecker) and
  none in the scoped paths.

After the change:
- `.\node_modules\.bin\tsx.cmd --test src/tests/m2-tenant-branches-ui.test.ts` →
  **43 pass / 0 fail**.
- `.\node_modules\.bin\tsx.cmd --test src/tests/m2-tenant-branches-ui.test.ts
  src/tests/m2-tenant-profile-ui.test.ts src/tests/m2-tenant-profile-edit.test.ts
  src/tests/m2-course-management.test.ts` → **175 pass / 0 fail** (43 new + the
  unchanged 38 + 33 + 61).
- `.\node_modules\.bin\tsc.cmd -p tsconfig.app.json --noEmit` → **0 diagnostics in
  the six scoped paths**; the output was the same 11 known outside errors and
  the same 13 output lines as the baseline run.

Two defects during this session were in **my own new test code** and were fixed
before the final runs: an over-broad "no tenant selector" regex that matched the
canonical path segment `/tenants/`, and a `waitForIdle` ordering deadlock in the
superseded-mutation test. No product code changed because of them. No lint was
run (optional lint is not pursued under supervisor/150/152).

## Honest limitations

- The optional **TEMP tsc-log differential comparison was denied** and was not
  performed: the two log files were not read, and the comparison was not re-run
  through any other tool or shell. The before/after type result above is taken
  from the two separately observed console outputs in this context only — it is
  not a byte-level diff and is not claimed as one.
- No DOM, RTL paint, browser, real HTTP, database or live service was involved;
  the accepted migration was not applied, so no runtime branch rollout is
  claimed and no production data is invented.
- No performance, latency or scalability measurement was taken; only request
  counts and the memory bound are proven.
- The server's physical row locking, keyset paging behaviour and audit writes
  remain the accepted 151 server-contract scope and were not re-exercised here.
- OTP stays deferred; M2-07 does not close C1 or M2.

## Blocker

None for the six-path scope. The implementation, the new hermetic suite, the
contract document and the scoped type result are complete and stable on disk.

## Next owner action

Codex independent review of the stable source, the component/controller
responsibility split, the additive adapters, the page/form/session safeguards,
the request bounds and the tests/types, then acceptance or an exact scoped
correction. The worker timer `Tabweb-OpenCode-Worker-15min` remains **DISABLED**
per human152 (verified: task State `Disabled`, Enabled `False`); the recurring
check is the Codex supervisor task `Tabweb-Codex-Supervisor-10min` (State `Ready`,
Enabled `True`, last run 22:34:59 Cairo result 0).
