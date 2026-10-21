# Claude schedules correctness audit — 2026-10-19

Task: claude-schedules-correctness-20261019-01 (backend). Scope: schedules routes/service/test only.
Not production/phase acceptance. Whole-suite gates are for Codex after all writers stop.

## Source hashes (sha256)

| File | Baseline | Current |
|---|---|---|
| server/src/routes/schedules.ts | d8d91424...5a85c1 (full d8d914247c227e1ae69c2a952caa1e776dc3195e87c0f1d4f86a5325baed85c1) | unchanged (same) |
| server/src/services/schedules.ts | 566e93b3b325db9a8c9217b19936210d50d3e58e7429243e3bfa1ead61adcec4 | db8e28c377cc266d28ac5269d92830488fa9512cdd12d4797b95ee532887e78c |
| server/tests/m5-schedules.test.ts | 9ed15c3e14b00c124184c1a5fd2af4c0fb6bd1c3841619680a97216a1a605ca7 | c1330e57c86e255bfd31bbd779eeab07fe30743a7de6606029ffb7406cd4d842 |

## Commands

- Baseline: `node node_modules/tsx/dist/cli.mjs --test server/tests/m5-schedules.test.ts` -> 26 pass, 0 fail.
- After adding 14 tests (before fixes): 33 pass, 7 fail (the 7 reproduced defects below).
- After fixes: 40 pass, 0 fail.
- `node node_modules/typescript/bin/tsc --noEmit -p server/tsconfig.json` -> exit 0, no errors at the time of the run.

## Proven defects (each reproduced by a failing test first) and fixes (services/schedules.ts only)

1. Weekday list coerced blanks to Sunday: `['1','']`, `[' ']`, `'1,,3'` became Sunday (Number('')=0); `[[1]]` accepted via String(). Fixed with `strictWholeNumber` (number or plain digit string only).
2. `duration_minutes: true` stored a 1-minute session; `day_of_month: true` / `[5]` accepted. Same helper.
3. `start_time: '09:30:45'` silently dropped the seconds. Non-zero seconds now rejected (`09:30`, `9:30`, `09:30:00` still valid).
4. Years outside DATETIME range were accepted: `starts_on: '0001-01-01'` was normalized to the invalid string `1-01-01` (would 500 in MySQL). `parseCalendarDate` now accepts years 1000..9999 only.
5. Expansion near year 9999 produced `+010000-01-01...` ISO strings (invalid DATETIME -> 500). `buildOccurrence` now skips occurrences whose start/end are outside year 1000..9999.
6. Reschedule: a bare date (`2026-06-02`) silently became midnight; windows were unbounded (1 year, or ending in year 10000 -> `+010000-...`), bypassing the 24h session maximum enforced on series. Now: a time of day is required, both instants must be storable, and the window is capped at MAX_DURATION_MINUTES (1440). Route returns 400 (no write) instead of reaching the DB.

Positive access preserved: numeric strings (`'90'`, `'15'`), `2026-06-02T09:00`, exactly-24h windows, existing owner/instructor flows, all original tests unchanged.

## Verified no defect (tests added as regression guards)

- Weekly DST: wall time kept across fall-back (EDT->EST) and spring-forward; month-end clamp incl. leap Feb 29; mid-month start; no duplicate instants; cap honoured (HARD 2000, route 366).
- Cancel/reschedule: `status='scheduled' AND version=?` guard; lost race -> 409, no audit row, no notification. Audit failure propagates inside the transaction callback (500, buffered tx test shows nothing committed, no notification). Notifier throw never hides a committed change.
- Scoping: every query carries `tenant_id`; non-owner list uses owned-group / creator / own-branch predicates (no `1=1`); owner is tenant-scoped; group create needs tenant + ownership; student feed uses proven branch/group filter and `status='scheduled'`.

## Not changed — ambiguous product policy or outside scope (documented, not invented)

- DST gap (nonexistent wall time, e.g. 2026-03-08 02:30 New_York) resolves to 06:30Z = 01:30 EST (an hour before the gap) because `localWallTimeToInstant` (content-release.ts, not in scope) does a two-pass offset. Many calendars shift forward to 03:30 EDT. Needs a policy decision and a change in content-release.ts (shared by lesson release), so not touched here.
- DST overlap (2026-11-01 01:30 New_York) resolves to the FIRST (EDT, 05:30Z) instant. docs/agent-reports/review-m4-m5.md says "later"; actual behaviour is earlier. Documentation discrepancy only.
- Non-owner instructors may create `tenant`-audience and any-active-branch `branch`-audience series (only `group` requires ownership). Same model as routes/announcements.ts; narrowing is a policy decision. A non-owner with a bound branch can also cancel/reschedule branch sessions of that branch created by others (intentional per code comment). Creator retains authority after a group is reassigned.
- Repeated POST /series with an identical payload creates a second series (random series id defeats the `(series_id, starts_at)` unique key; idempotency is only within one series). An idempotency key would be new API surface.
- A long `ends_on` with a bounded cap silently truncates materialization (response `sessions` shows the count). Whether to reject or flag is policy.
- Series `INSERT IGNORE` can mask a failed row; a unique conflict is impossible with fresh ids and now-bounded years, so left as is.

## Remaining

- Codex whole-suite/server-cwd runs, tsc and diff check after all writers stop.
- No git actions, DB, network or installs were performed. Claim token file removed.
