# 074 — M2-12 canonical DTO + retired save correction: implemented, tested, reported

**Task:** `client-m2-12-canonical-dto-retired-save-correction-20261021-01` (team
`frontend`, `implementationWorker: opencode`, `taskKind: correction`).
**Worker:** `opencode-m2-12-canonical-dto-correction-20261021`.
**Native session id:** not exposed by this OpenCode CLI, so none was claimed or
reported.
**Branch:** `codex/human-client`.
**Timestamp:** 2026-10-21T14:43:38Z (17:43:38 Africa/Cairo).
**Status:** correction complete and **reported**. **This is not acceptance.**

Resumed under the human201 routine-recovery instruction after the native process
disappeared following the public202 0/4 + existing-UI 83/83 checkpoint: the SAME
task, the SAME claim and the SAME three-path scope, continued from the actual
partial disk state. No new claim, no new worker, no ownership transfer, no
model/account change, no scope expansion.

## Before → after

Before (the three supervisor/202 findings, reproduced against the real
production file):

1. `parseTenantBranding` accepted `2026-02-30T12:00:00.000Z`, because the
   pattern match passes and JavaScript normalizes the impossible calendar date
   into `2026-03-02` instead of refusing it.
2. `validateLabel` accepted `' original '` and returned it untrimmed, so a
   malformed server DTO was turned into a confirmed success.
3. A **retired** save that settled while a **newer** save was pending mutated the
   newer operation's visible state: the retired success set the visible mutation
   to `idle` and the retired error set it to `uncertain`.

After: the DTO is canonical or refused, and the visible mutation belongs to the
operation that owns it. A retired reply settles nothing that a newer operation
owns, on both the success and the failure outcome.

## Paths changed (exactly the three allowedPaths)

| Path | Change |
|---|---|
| `src/features/tenant/branding.ts` | canonical ISO round trip; canonical trimmed label rule; visible-mutation ownership fence |
| `src/tests/m2-tenant-branding-ui.test.ts` | +6 production regressions (83 → 89) |
| `docs/streams/client/M2-12-CONTRACTS.md` | the canonical DTO rules, the ownership fence, the retired-reply rule and the correction verification record |

Not touched: any server file, the card, the dashboard, `src/lib/api-http.ts`,
the shared boundaries, the student-import paths, the M2-11 CSV work, any other
contract, any package/config/migration, and every other dirty owner in the
workspace. No Git write, no install, no npx fetch, no lint, no browser, no
network, no DB, no service, no deploy, no schedule change, no credentials.

## The three fixes (production code)

**1 — Canonical ISO instant.** `parseTenantBranding` now requires the exact
canonical round trip: `new Date(value).toISOString() === value`. The pattern
match alone is not enough, because JavaScript silently normalizes
`2026-02-30T12:00:00.000Z` into `2026-03-02T12:00:00.000Z`. Five impossible
calendar dates are refused and a real instant of the same shape is still
accepted.

**2 — Canonical label.** `validateLabel` now requires `value === value.trim()`
and measures the 1..255 length on that canonical value, so `' original '` is a
malformed server DTO instead of a label the client normalizes. This matches the
server, which trims every label it stores (`server/src/routes/tenant-branding.ts`
— read only, not modified). The **local draft** path is unchanged: a draft is
still trimmed before it is sent, and local validation still trims.

**3 — Visible-mutation ownership.** The controller now tracks the write ticket
of the operation that owns the visible mutation (`mutationOwner`). The save
claims ownership when it starts, the ownership is released when the private
state is cleared (`retireInFlight`, the retired-principal path), and
`settleSupersededMutation` settles the visible mutation **only while the
retiring operation still owns it**. A retired reply therefore cannot set the
visible status to `idle`/`uncertain`, cannot write a stale error or notice,
cannot claim a confirmation, cannot touch the newer form and cannot release the
newer flight's latch. The canonical principal is still observed before the
retired reply settles anything, and the retired operation still releases only
its own ticket in its `finally`.

## Verified behaviour (real production paths, isolated)

- The public immutable probe
  `C:/Users/BaraaWael/TabwebClientSupervisor/202-m2-12-independent-probes.test.ts`
  went from **0 pass / 4 fail** to **4 pass / 0 fail** against the same
  unchanged probe file and the real `src/features/tenant/branding.ts`.
- The 6 added tests cover: the impossible-calendar round trip (5 refused, 2
  accepted), the untrimmed label (6 refused, 1 accepted), the retired **success**
  and the retired **error** against a newer pending save (status, error, notice,
  form, draft, confirmation and latch all preserved, plus the follow-up save
  still committing its own canonical truth), and the malformed 2xx (untrimmed
  label and impossible instant) staying **uncertain** with the draft preserved
  and no automatic retry.
- The unchanged 83 branding tests, the unchanged 330 nearby client tests, the
  unchanged 9 access-control tests and the whole M2 client set all still pass.
- The 11 frontend type diagnostics are the **same 11 pre-existing outside-scope
  errors in the same 8 files** as before the correction; **zero** diagnostics in
  `src/features/tenant/`, `src/tests/m2-tenant-branding-ui.test.ts` or
  `src/lib/api-http.ts`.

## Commands and results

All commands ran with the **local** `node_modules/.bin/tsx` and
`node_modules/.bin/tsc` (no install, no fetch, no network).

| Command | Result |
|---|---|
| `tsx --test C:/Users/BaraaWael/TabwebClientSupervisor/202-m2-12-independent-probes.test.ts` | **before: 0 pass / 4 fail** → **after: 4 pass / 0 fail** (unchanged public probe) |
| `tsx --test src/tests/m2-tenant-branding-ui.test.ts` | **89 pass / 0 fail** (83 unchanged + 6 added) |
| `tsx --test src/tests/m2-course-management.test.ts src/tests/m2-course-unit-ui.test.ts src/tests/m2-course-lesson-ui.test.ts src/tests/m2-tenant-branches-ui.test.ts src/tests/m2-tenant-profile-ui.test.ts src/tests/m2-tenant-profile-edit.test.ts` | **330 pass / 0 fail** (unchanged) |
| `tsx --test src/auth/access-control.test.ts` | **9 pass / 0 fail** (unchanged) |
| `tsx --test src/tests/m2-*.test.ts` | **700 pass / 0 fail** (whole M2 client set: 694 + 6 added) |
| `tsx --test <public probe> src/tests/m2-tenant-branding-ui.test.ts` | **93 pass / 0 fail** (final combined run) |
| `tsc --noEmit -p tsconfig.app.json` | **0 scoped diagnostics**; **11** pre-existing outside scope, in the same 8 files (`NotificationBell.tsx` 1, `StudentHeader_OLD_BACKUP.tsx` 2, `ExamReports.tsx` 2, `ExamResults.tsx` 1, `Fees.tsx` 2, `StudentBarcodes.tsx` 1, `StudentDashboard.tsx` 1, `versionChecker.ts` 1) |

Request counts: the added tests issue **no** extra request beyond what the
behaviour under test requires — one open read per explicit open, one write per
save, and the retired-save tests assert that a double save during the newer
flight sends **no** second write.

## Remaining work / limits

- **The whole M2-12 branding batch is still not accepted.** Only the three
  supervisor/202 findings were addressed, in the three approved paths.
- **No server change and no server test** were added by this correction; the
  server's trim/epoch behaviour was only read from the source. The migration
  FILE is still **not applied**.
- **No DOM paint, no real RTL layout, no browser, no real HTTP, no real DB, no
  live services, no end-to-end authorization.**
- **No performance claim** of any kind, and no whole-C2/M2 completion claim.
- The worker timer `Tabweb-OpenCode-Worker-15min` is **Disabled**
  (`State=Disabled`, `Enabled=False`, last run 2026-10-19 20:48:59). It was not
  enabled, paused, restarted or modified. Human152's supervisor-managed CLI and
  Codex's 15-minute review cadence remain the actual supervision.
- Preserved all dirty accepted work (170/183/185/190, the accepted M2-11 CSV
  correction and every other owner); no Git writes, no installs, no npx fetch,
  no lint, no browser, no network, no DB, no services, no deploy, no schedule
  change, no credentials, no private data.

Codex independently reviews the actual source, architecture, contracts, tests
and bounds. This note is **not** acceptance.
