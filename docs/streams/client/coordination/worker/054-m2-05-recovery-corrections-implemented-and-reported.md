# M2-05 recovery: F1/F2 corrected, verified, MCP report submitted

UTC2026-10-19T12:42Z · branch `codex/human-client` · task
`client-m2-05-profile-correction-recovery-20261019-01` · worker
`opencode-m2-05-recovery-01`. No native OpenCode session ID is exposed to the
worker; no invented ID is claimed. Claim token was used only with MCP tools and is
not reproduced here.

## Inventory / preserved work

Claimed natively via `next_approved_task` (ready queue). Disk contained the prior
partial five-path implementation: `profile.ts`, the profile UI suite, additive
`api-http` DTO/request and the dashboard card; `M2-05-CONTRACTS.md` existed from
the stopped053 handoff. No rewrite: only targeted F1/F2 corrections plus tests and
truthful contract text.

## Changes

- `src/features/tenant/profile.ts`
  - F1: classification already matched documented **transport `error`
    messages** (`Token expired`, `Session revoked`, `Selected workspace is no
    longer active`, `Instructor account is administratively suspended`, `Select
    an instructor workspace first`); added/covered regressions that prove
    discarded `code` values alone stay fail-closed retryable errors.
  - F2: added an observed-principal lifetime. A changed principal is adopted at
    read entry and completion: old generation invalidated, latch released,
    profile/error/`loading` cleared to `idle`, so retry/new read is usable. A
    newer load's latch is never released by an old `finally`; normal session
    event path still clears identity before starting the new read.
- `src/tests/m2-tenant-profile-ui.test.ts`
  - Real messages replace stale code-string expectations; expanded to 38 tests.
  - Integrated real transport → real controller cases: 401 `error`+discarded
    `code`; 403 suspension classified `denied` with token teardown and `/auth`;
    page-wired 403 logout produces no stale identity and exactly one bounded
    no-token read (no loop).
  - Silent principal: success/error at completion, entry adoption, silent
    A→B→A, old `finally` vs newer busy, plus existing reversal/session/dispose
    coverage. Silent scenarios do not fire a notifier.
- `docs/streams/client/M2-05-CONTRACTS.md`
  - Corrected upstream message/code wording, silent-principal retirement,
    logout messages, new evidence and Node-environment limitation.

No page/API/auth/session-event/backend/schema/shared-contract change in this
session; five approved paths only.

## Validation (actual commands, this run)

- `npx tsx --test src/tests/m2-tenant-profile-ui.test.ts` → **38/38 pass,
  0 fail**.
- `npx tsx --test C:\Users\BaraaWael\TabwebClientSupervisor\113-m2-05-review-probes.test.ts`
  unchanged → **4/4 pass** (F1 three probes + F2 silent-change probe).
- Per-file client suites: **392/392 pass** across the 11 runnable bundles
  (includes 38 new). Five legacy M1 suites cannot import on Node v22.14.0
  (`node:module.registerHooks` absent — newer Node feature); preexisting
  environment limitation, unrelated to these paths, not counted as passing.
- `npx tsc -p tsconfig.app.json --noEmit` → **zero scoped errors**, exactly the
  known **11 outside** diagnostics (NotificationBell, StudentHeader_OLD_BACKUP,
  ExamReports, ExamResults, Fees, StudentBarcodes, StudentDashboard,
  versionChecker).
- `npx eslint src/features/tenant/profile.ts src/tests/m2-tenant-profile-ui.test.ts`
  → no findings.

No live network/DB/browser/service/provider/install/Git/deploy action; all
requests use stubbed fetch/localStorage/`window`. Performance claim is bounded to
request counts/latch cleanup, not latency or scalability.

## Limits / next owner action

DOM/RTL/browser and live authorization remain unproven; server stays
authoritative. Codex independently reviews the stopped source and decides
acceptance. No self-acceptance or new scope.
