# 073 — M2-12/B06 private branding: implemented, tested, reported

**Task:** `client-m2-12-private-branding-20261021-01` (team `integration`,
`implementationWorker: workbuddy`, `taskKind: implementation`).
**Worker:** `workbuddy-native-m2-12-branding-20261021`.
**Branch:** `codex/human-client`.
**Status:** implementation complete and **reported**. **This is not acceptance.**

## Before → after

Before: no private branding configuration contract or editor existed; the
selected tenant had no way to carry its own localized display labels or accent
color.

After: the verified owner of the server-selected tenant can read and save two
localized display labels and one accent color through
`GET|PATCH /api/tenants/me/branding`, edit them in an accessible Arabic/RTL card
on the existing instructor dashboard, and see an honest local RTL/English
preview. Nothing else changed: `business_name` is not renamed, no account,
access, pricing, billing, student or policy behaviour moved, and no global
application language, theme, logo, host, subdomain, DNS or TLS rule was touched.

## Paths changed (exactly the thirteen allowedPaths)

| Path | Change |
|---|---|
| `server/src/routes/tenant-branding.ts` | **new** injected router, no default export, no production adapter, `AuthRequest` type-only |
| `server/src/routes/tenant-self.ts` | **additive only**: 1 import + 1 `router.use('/branding', …)` after the lesson mount; all 11 accepted handlers/mounts byte-identical |
| `server/migrations/20261021_02_tenant_branding.sql` | **new** additive table FILE — **never applied** |
| `server/tests/helpers/m2-tenant-branding-harness.ts` | **new** positive isolation + transaction-replaying fixture |
| `server/tests/m2-tenant-branding.test.ts` | **new** 51 tests |
| `server/tests/m2-tenant-branding-failures.test.ts` | **new** 28 tests |
| `src/pages/InstructorDashboard.tsx` | **additive only**: 1 import + 1 `<TenantBrandingCard />` mount |
| `src/features/tenant/TenantBrandingCard.tsx` | **new** Arabic/RTL card |
| `src/features/tenant/branding.ts` | **new** parser/controller/lifetimes |
| `src/lib/api-http.ts` | **additive only**: DTO + 2 adapters |
| `src/tests/m2-tenant-branding-ui.test.ts` | **new** 83 tests |
| `docs/streams/server/M2-B06-CONTRACT.md` | **new** |
| `docs/streams/client/M2-12-CONTRACTS.md` | **new** |

Not touched: `csv-preview.ts`, `InstructorStudents.tsx`, the student-import
sources, `server/src/index.ts`, `middleware/auth.ts`, the shared boundaries, any
other router, the accepted unit/lesson routers and their accepted tests, the
shared `request`/error/session contract, a package, a config file, or the schema
of an existing table. OpenCode's six student-import194 paths were left alone.

## Verified behaviour (real production paths, isolated)

Server, through the real composition (optional auth → tenant-authority boundary →
student-workspace boundary → real `createTenantSelfRouter` with the real branding
mount), with only leaf repositories and the transactional connection injected:

- owner read of the exact four-field DTO; membership instructor / role-owner
  label / admin / student / no-membership / inactive workspace all refused;
- `billingOnly` 403 **before** any connection is acquired (0 statements issued);
- body/query/`x-tenant-id` selectors still rejected 400 by the real boundary;
- absent row → all-null DTO with `updated_at: null`; stored row → canonical ISO
  from the epoch projection, provably **not** the `+02:00` driver-shifted value;
- strict payload: empty object, unknown/selector key, empty/whitespace/over-255
  label, non-string, shorthand/named/`rgb()`/URL color, array/number/boolean body
  all 400 with **zero** connections taken; 255-char and Unicode labels accepted;
- uppercase canonicalization (`#a1b2c3` → `#A1B2C3`), trimming, `null` stored as
  inherit and never `''`;
- no-op (identical, whitespace-variant, absent+all-null) → **no UPDATE, no
  INSERT, no audit, no commit**; absent+all-null **stays absent**;
- first insert writes the complete effective row with unmentioned fields `NULL`;
- **exactly one** bounded audit event with the three branding fields only;
- statement order `begin → owner → branding_lock → update → audit → read-back →
  commit`; the DTO is materialized **before** the single commit;
- failures: acquisition (nothing released), begin (destroy), owner/select/insert/
  update/audit/read-back (rollback + release), failed rollback (destroy), lost
  commit ack (**destroy, no rollback claim, no success, no retry**), missing
  schema (500 — never a fabricated all-null success), unreadable epoch on read
  and on write (500, nothing committed), non-canonical stored color (500);
- every outcome carries `Cache-Control: no-store`; 500 bodies leak no SQL/stack;
  no response written twice; no forbidden default adapter ever called.

Client, through the real `request` and the real component:

- canonical `/tenants/me/branding` path, bearer header, **no** selector anywhere;
- dirty-subset PATCH only; `undefined` never sent; explicit `null` sent as inherit;
- the 4-key DTO and the `{ branding }` envelope enforced; extra key, lowercase
  color, empty/over-long label, non-ISO instant and a **null instant beside a
  non-null field** (a contradiction) all refused;
- one read per explicit open, one write per save, no request for a no-op save;
- local validation (label/color) before any request; confirmed save shows server
  truth; uncertain save preserves the draft, states uncertainty, retries nothing;
  reconcile reads current state and never confirms the earlier save;
- principal observed at entry **and** completion; retired reply observes it
  before settling; stale read never overwrites a confirmed save; late save never
  closes a newer form; older `finally` never releases a newer latch;
- session event / close / dispose clear the private state and drop in-flight work;
- preview is local + unsaved, switches `rtl`/`ltr` inside the preview only, and
  never applies an unvalidated color as CSS;
- component: exactly one `type="submit"`, every non-submit control `type="button"`,
  bound labels + real inherit checkboxes, close never disabled, actual callbacks
  invoked from the production element tree.

## Commands and results

| Command | Result |
|---|---|
| `cd server && npx tsx --test tests/m2-tenant-branding.test.ts` | 51 pass / 0 fail |
| `cd server && npx tsx --test tests/m2-tenant-branding-failures.test.ts` | 28 pass / 0 fail |
| `cd server && npx tsx --test tests/m2-tenant-profile.test.ts tests/m2-tenant-profile-update.test.ts tests/m2-tenant-branches.test.ts tests/m2-course-units.test.ts tests/m2-course-lessons.test.ts tests/m2-course-lessons-reorder.test.ts` | 245 pass / 0 fail (unchanged) |
| `cd server && npx tsc --noEmit` | 0 diagnostics |
| `npx tsx --test src/tests/m2-tenant-branding-ui.test.ts` | 83 pass / 0 fail |
| `npx tsx --test src/tests/m2-course-management.test.ts src/tests/m2-course-unit-ui.test.ts src/tests/m2-course-lesson-ui.test.ts src/tests/m2-tenant-branches-ui.test.ts src/tests/m2-tenant-profile-ui.test.ts src/tests/m2-tenant-profile-edit.test.ts` | 330 pass / 0 fail (unchanged) |
| `npx tsx --test src/auth/access-control.test.ts` | 9 pass / 0 fail (unchanged) |
| `npx tsx --test src/tests/m2-*.test.ts` | 694 pass / 0 fail (whole M2 client set) |
| `npx tsc --noEmit -p tsconfig.app.json` | 0 scoped; 11 pre-existing outside scope |

New tests: **162** (51 + 28 + 83). Combined server: 324. Combined client: 413.

**Note on the typecheck command.** `npx tsc --noEmit` at the repository root
checks **nothing**: the root `tsconfig.json` has `"files": []` and no `include`.
The real frontend check is `npx tsc --noEmit -p tsconfig.app.json`, and that is
the command reported above. The 11 remaining diagnostics are pre-existing and
outside this scope: `NotificationBell.tsx` (1), `StudentHeader_OLD_BACKUP.tsx`
(2), `ExamReports.tsx` (2), `ExamResults.tsx` (1), `Fees.tsx` (2),
`StudentBarcodes.tsx` (1), `StudentDashboard.tsx` (1), `versionChecker.ts` (1).

## Remaining work / limits

- **No live MySQL, no real concurrency, no listener, no socket, no HTTP, no
  provider, no app startup.** Real row-lock behaviour, real index usage and the
  real server-side abort of a destroyed connection are **not** exercised; the
  fixture models the statements and the transaction replay only.
- **The migration FILE is not applied.** Branding is unavailable in a real
  deployment until a separately authorized gate applies it; a real deployment
  answers a truthful 500 and the client shows that failure rather than inventing
  data.
- **No lost-update-prevention, version or CAS promise**, and deliberately no 409:
  the only serialization is the row lock inside the handler's transaction.
- **No DOM paint / real RTL layout / browser.** Component behaviour is proven
  from the production element tree, not pixels.
- **No performance claim** of any kind, and no whole-C2/M2 completion claim.
- Preserved all dirty accepted 170/183/185/190 work; no Git writes, no installs,
  no npx fetch, no lint, no browser, no network, no DB, no services, no deploy,
  no schedule change, no credentials.

Codex independently reviews source, architecture, contracts, tests and bounds.
This note is **not** acceptance.
