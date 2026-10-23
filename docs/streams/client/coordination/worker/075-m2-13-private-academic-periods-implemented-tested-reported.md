# 075 — M2-13/B07 private academic periods: implemented, tested, reported

**Task:** `client-m2-13-private-academic-periods-20261021-01` (team `integration`,
`taskKind: implementation`).
**Worker:** `workbuddy-native-m2-13-periods-20261021`.
**Branch:** `codex/human-client`.
**Status:** implementation complete and **reported**. **This is not acceptance.**

## Before → after

Before: no private academic-period catalog contract or editor existed; a tenant
had no way to record its own named date ranges.

After: the verified owner of the server-selected tenant can list, create and
update named date ranges through
`GET|POST /api/tenants/me/academic-periods` and `PATCH /api/tenants/me/academic-periods/:id`,
and manage them in an accessible Arabic/RTL card on the existing instructor
dashboard. Nothing else changed: no enrollment, attendance, pricing, billing,
access or student behaviour moved, no automatic period transition exists, and no
global application language, theme or route was touched.

## Paths changed (exactly the thirteen allowedPaths)

| Path | Change |
|---|---|
| `server/src/routes/academic-periods.ts` | **new** injected router (`getConnection` only), no default export, `AuthRequest` type-only |
| `server/src/routes/tenant-self.ts` | **additive only**: 1 import + 1 `router.use('/academic-periods', …)` after the branding mount |
| `server/migrations/20261021_03_academic_periods.sql` | **new** additive table FILE — **never applied** |
| `server/tests/helpers/m2-academic-periods-harness.ts` | **new** positive isolation + transaction-replaying fixture |
| `server/tests/m2-academic-periods.test.ts` | **new** 91 tests |
| `server/tests/m2-academic-periods-failures.test.ts` | **new** 32 tests |
| `src/pages/InstructorDashboard.tsx` | **additive only**: 1 import + 1 `<AcademicPeriodsCard />` mount |
| `src/features/tenant/AcademicPeriodsCard.tsx` | **new** Arabic/RTL card |
| `src/features/tenant/academic-periods.ts` | **new** parsers / classifiers / controller / lifetimes |
| `src/lib/api-http.ts` | **additive only**: 3 adapters appended after the branding adapters |
| `src/tests/m2-academic-periods-ui.test.ts` | **new** 104 tests |
| `docs/streams/server/M2-B07-CONTRACT.md` | **new** |
| `docs/streams/client/M2-13-CONTRACTS.md` | **new** |

Not touched: OpenCode's three M2-12 correction paths
(`src/features/tenant/branding.ts`, `src/tests/m2-tenant-branding-ui.test.ts`,
`docs/streams/client/M2-12-CONTRACTS.md`), the CSV/student-import sources,
`server/src/index.ts`, `middleware/auth.ts`, the shared boundaries, any other
router, the accepted unit/lesson/branding routers and their accepted tests, the
shared `request`/error/session contract, a package, a config file, or the schema
of an existing table.

## Verified behaviour (real production paths, isolated)

Server, through the real composition (optional auth → tenant-authority boundary →
student-workspace boundary → real `createTenantSelfRouter` with the real academic
periods mount), with only the transactional connection injected:

- `billingOnly` 403 **before** any connection is acquired (0 statements issued);
  instructor / admin / student / no-membership / inactive workspace all refused;
- list: exact query key set enforced (unknown key 400), `limit` 1..100 default 25,
  `offset` 0..10000 default 0, `archived` `true|false` default `false`;
  `LIMIT ?+1 OFFSET ?`; `{periods, pagination:{limit,offset,has_more}}`;
  `has_more` from the extra row, with **no** cross-request snapshot claim;
- ordering by `starts_on,id` proven against a fixture deliberately seeded
  spring-before-autumn, so insertion order would fail the test;
- POST: exactly `{name,starts_on,ends_on}` (missing **and** extra keys 400) →
  `201 {period}` with the exact seven-key DTO; audit
  `tenant.academic_period_created` with `old_value: null`;
- PATCH: nonempty subset of `{name,starts_on,ends_on,is_archived}`; the **merged**
  range is validated inside the transaction so a start-only update can never store
  a reversed range (400 + rollback + a single release); zero-change patch → current
  DTO with **no UPDATE, no audit, no commit**; audit
  `tenant.academic_period_updated` with bounded old/new; read-back compared before
  commit → 500 on mismatch; `commit` set only after the DTO is materialized;
- dates: `DATE_FORMAT(p.starts_on,'%Y-%m-%d')` so the installed mysql2 pool
  `timezone:'+02:00'` cannot shift a `DATE` a day at boundaries; the fixture stores
  the driver-shifted value so a regression to a raw `DATE` selection is observable;
- epochs: `UNIX_TIMESTAMP(...) AS *_epoch`; an unreadable or invalid epoch is
  refused **500**, never fabricated;
- permitted by contract and asserted as permitted: duplicate names and overlapping
  periods (no uniqueness, no overlap constraint, no rejection);
- statement order `begin → owner → … → audit → read-back → commit`; failures:
  acquisition (nothing released), begin (destroy), owner/select/insert/update/
  audit/read-back (rollback + release), failed rollback (destroy), lost commit ack
  (**destroy, no rollback claim, no success, no retry**), missing schema (500);
- every outcome carries `Cache-Control: no-store`; 500 bodies leak no SQL/stack.

Client, through the real `request` and the real component:

- canonical `/tenants/me/academic-periods` paths, bearer header, **no** selector;
- strict parsers: malformed DTO, malformed list entry and a bad response bound are
  refused **before** any state copy; `classifyAcademicPeriodFailure` /
  `classifyAcademicPeriodWriteFailure` / `isAcademicPeriodAuthorizationLoss`
  separate authorization loss from other failures;
- `buildAcademicPeriodPatch` returns a dirty subset or an explicit message; `undefined`
  is never sent; a zero-change save issues no request;
- one read per explicit open, one write per save; confirmed save shows server truth;
  write 500 / network / malformed 2xx → `uncertain`, draft preserved, **no auto-retry**,
  and `reconcile()` reads current state and never claims to prove the earlier save;
- fences: page generation, form generation, `confirmedWriteEpoch`, `mutationOwner`,
  `phaseOwner`, monotonic ticket source; a retired reply cannot change visible save
  state, error, notice, latch or form, and its `finally` cannot release a newer latch;
- a new form cannot be opened while a write is in flight; cancelling during a save
  never reopens the form and the save is still reported;
- session event / close / dispose clear the private state and drop in-flight work;
- component: explicit open, `aria-pressed` archived toggle, exactly one
  `type="submit"` with every other control `type="button"`, **close never disabled**,
  `aria-live="polite"`, dates in `dir="ltr"` spans, planning-only wording, and real
  callbacks invoked from the production element tree.

## Commands and results

| Command | Result |
|---|---|
| `cd server && npx tsx --test tests/m2-academic-periods.test.ts` | 91 pass / 0 fail |
| `cd server && npx tsx --test tests/m2-academic-periods-failures.test.ts` | 32 pass / 0 fail |
| `cd server && npx tsx --test` on the 8 unchanged accepted suites (branding 79 + accepted 245) | 324 pass / 0 fail (unchanged) |
| `cd server && npx tsc --noEmit` | 0 diagnostics |
| `npx tsx --test src/tests/m2-academic-periods-ui.test.ts` | 104 pass / 0 fail |
| `npx tsx --test` on the accepted 330 client suites | 330 pass / 0 fail (unchanged) |
| `npx tsx --test` on the accepted 173 CSV suites | 173 pass / 0 fail (unchanged) |
| `npx tsc --noEmit -p tsconfig.app.json` | 0 scoped; 11 pre-existing outside scope |

New tests: **227** (91 + 32 + 104).

**Note on the typecheck command.** `npx tsc --noEmit` at the repository root
checks **nothing**: the root `tsconfig.json` has `"files": []` and no `include`.
The real frontend check is `npx tsc --noEmit -p tsconfig.app.json`, and that is
the command reported above. The 11 remaining diagnostics are pre-existing and
outside this scope: `NotificationBell.tsx` (1), `StudentHeader_OLD_BACKUP.tsx`
(2), `ExamReports.tsx` (2), `ExamResults.tsx` (1), `Fees.tsx` (2),
`StudentBarcodes.tsx` (1), `StudentDashboard.tsx` (1), `versionChecker.ts` (1).

## Defects found by the new tests and fixed in the product

- **The close control was disabled during a save**, violating the handoff's
  "close always usable". The component was fixed (removed `disabled`), and the
  assertion rewritten to read the production control's `disabled` and click it.
- The `failReadBack` seam also broke the locked read, making the "missing row
  after write" branch unreachable; split into `readBackMalformedEpoch` /
  `readBackMalformedDate` and scoped `failReadBack` to the read-back statement.

No assertion was weakened to reach green.

## Remaining work / limits

- **No live MySQL, no real concurrency, no listener, no socket, no HTTP, no app
  startup.** Real row-lock behaviour, real index usage and the real server-side
  abort of a destroyed connection are **not** exercised; the fixture models the
  statements and the transaction replay only.
- **The migration FILE is not applied.** Academic periods are unavailable in a
  real deployment until a separately authorized gate applies it; a real deployment
  answers a truthful 500 and the client shows that failure rather than inventing
  data.
- **No lost-update-prevention, version or CAS promise**, and deliberately no 409:
  the only serialization is the owner-row lock inside the handler's transaction.
  No automatic active/archived transition, no overlap rejection.
- **No DOM paint / real RTL layout / browser.** Component behaviour is proven from
  the production element tree, not pixels.
- **No performance claim** of any kind, and no whole-C2/M2 completion claim.
- Preserved all dirty accepted work including OpenCode's three M2-12 correction
  paths; no Git writes, no installs, no npx fetch, no lint, no browser, no
  network, no DB, no services, no deploy, no schedule change, no credentials.

## Open questions carried in the report

1. Should the B07 migration gate seed any period for an existing tenant, or is an
   empty catalog the intended first-run state? No seed data was invented.
2. If a later batch wants a `409` on overlap or an automatic active/archived
   transition on date boundaries, that needs an explicit approved contract.
3. Should a later batch link academic periods to attendance, enrollment, pricing
   or instructor access? Nothing in the schema or handlers references another
   domain and the accepted DTO is exactly seven keys.

Codex independently reviews source, architecture, contracts, tests and bounds.
This note is **not** acceptance.
