# 076 — M2-14/B08 read-only student-import reconciliation: implemented, tested, reported

**Task:** `client-m2-14-student-import-server-reconciliation-20261021-01` (team
`integration`, `taskKind: implementation`).
**Worker:** `workbuddy-native-m2-14-import-resolution-20261021`.
**Branch:** `codex/human-client`.
**Status:** implementation complete and **reported**. **This is not acceptance.**

## Before → after

Before: the accepted local CSV preview could flag within-file duplicate
candidates and the accepted decisions could prepare an inclusion set, but neither
could say anything about records that already exist in the tenant.

After: the owner of the server-selected tenant can click one explicit control and
receive, per included row, which of the three exact keys (email / phone / barcode)
already exist in that tenant — and nothing else. No student is created, no record
is modified, no access is granted, and no existing record's identity or data is
returned.

## Paths changed (exactly the eleven allowedPaths)

| Path | Change |
|---|---|
| `server/src/routes/student-import-resolution.ts` | **new** injected READ-ONLY router (`execute`+`release` only), no default export, `AuthRequest` type-only |
| `server/src/routes/tenant-self.ts` | **additive only**: 1 import + 1 `router.use('/student-import', …)` after the academic-periods mount |
| `server/tests/helpers/m2-student-import-resolution-harness.ts` | **new** positive isolation + read-only-refusing fixture |
| `server/tests/m2-student-import-resolution.test.ts` | **new** 60 tests |
| `server/tests/m2-student-import-resolution-failures.test.ts` | **new** 17 tests |
| `src/features/students/StudentImportPreview.tsx` | **additive**: 1 ref, 1 state, 1 controller, 1 block, 1 per-row warning, clear wiring |
| `src/features/students/server-resolution.ts` | **new** builder / strict parser / controller |
| `src/lib/api-http.ts` | **additive**: 4 DTO types + `resolveStudentImportRows` |
| `src/tests/m2-student-import-server-resolution.test.ts` | **new** 63 tests |
| `docs/streams/server/M2-B08-CONTRACT.md` | **new** |
| `docs/streams/client/M2-14-CONTRACTS.md` | **new** |

Not touched: the six OpenCode-owned academic-period correction paths (their mtimes
18:15–18:21 all predate this session's first edit at 18:29), the accepted CSV
parser/decision/report modules, the shared `request`/auth/error/session contract,
any other router, a package, a config file, or a schema.

## Verified behaviour (real production paths, isolated)

Server, through the real composition (optional auth → tenant-authority boundary →
student-workspace boundary → real `createTenantSelfRouter` with the real
student-import mount), with only the read connection injected:

- owner-only for the **verified owner row** of the selected **active** tenant;
  instructor / membership-labelled-owner / multi-tenant instructor → 403; admin and
  no-scope → 404 (authority boundary); student → 409 `STUDENT_SPACE_REQUIRED`;
  inactive caller → 401 `SESSION_REVOKED`; suspended tenant → 404;
- `billingOnly` 403 **before** any connection (0 statements);
- a client tenant selector is refused **by the real boundary** with 400 before the
  handler runs (query and `x-tenant-id` each with their own documented message);
- strict request: non-object body, extra top-level key, missing/non-array/empty
  rows, 1001 rows, missing/extra row key, non-object row, row_number
  1/0/−3/1002/2.5/`'2'`, duplicate row_number, non-string value, 4097 chars,
  untrimmed value, all-blank row, and the 2 Mi total bound — **all 400 with zero
  connections and zero statements**; a value at exactly 4096 is accepted;
- matching: exact equality only. With the collation superset modelled,
  `A@x.com` matches neither stored `a@x.com` nor stored `A@X.COM`, while
  `a@x.com` and `A@X.COM` each match their own exact row; `007` matches and `7`
  does not; an inactive student never matches; a `NULL` cell is skipped; a blank
  value never matches; a clear row is returned as `[]`, not omitted;
- cost: deduplicated per field, chunked at 200 values per statement — three rows
  sharing a phone issue **one** statement, 1000 distinct emails issue **5**, and a
  field with no nonblank value issues none. No N+1, no quadratic scan;
- privacy: the statement projects **only** the match column (no id, user_id, name,
  approval_status, guardian, grade, notes, address), and the serialized response
  contains no stored value and no seeded record id;
- read-only: zero mutation statements, no `begin`/`commit`/`rollback`, no audit,
  `destroy` never called (the seam does not expose it), `release` exactly once on
  success, on 403 and on every 500;
- failures: acquisition / owner read / first, second or third field read / later
  chunk / missing table all answer an **opaque 500 with no `rows` and no
  `summary`**, so a broken reconciliation can never read as "nothing exists"; no
  body leaks a table name, SQL, `ER_` code or stack;
- `Cache-Control: no-store` on 200, 400, 403 and 500.

Client, through the real parser/decision model and the real component:

- only `included` rows are submitted; pending/excluded/invalid dropped; physical
  row numbers preserved (proven with a quoted multi-line cell); values copied
  unchanged (`007`, `A@B.C`, `00B1`); no name/guardian/grade/rowIndex anywhere;
- parser rejects a reordered row, a substituted or duplicated row number, an extra
  or missing key, an unknown/lowercased/duplicated field, an out-of-order subset
  (`phone` before `email`), a non-balancing summary and an extra summary key;
- single flight (`busy`), ticket fence (`superseded`), own-latch rule (a retired
  reply cannot release a **newer** latch), reversed completion cannot overwrite,
  principal change before/during the flight → `scope-changed` with nothing sent,
  session event clears, dispose publishes nothing;
- failure is never "the rows do not exist"; retry is explicit and re-sends the
  same rows; zero storage writes and zero console calls across a full cycle;
- component: reconcile control is `type="button"`, disabled when nothing is
  included or while in flight, drives the real controller with only the included
  rows, never adds a submit control; failure shows an honest message plus a
  working retry; close stays enabled during a request.

## Two real problems found and fixed in the product (not in the assertions)

- **The visible notice became false.** The accepted text claimed
  «لا يُرسل أي شيء إلى الخادم», which is no longer true once a read-only request
  exists. The panel now keeps the accepted «معاينة محلية فقط» / «لا يُحفظ أي طالب» /
  «ولا استيراد فعلي» wording and states the single exception explicitly. The
  accepted M2-08 assertion was satisfied by fixing the component.
- **The field order was not the contract's.** The accepted duplicate-column
  vocabulary is `phone,email,barcode`, while M2-14 fixes the `matched_fields`
  order as `email,phone,barcode`. The module now declares its own ordered
  constant instead of aliasing the parser's array, and exports
  `SERVER_RESOLUTION_VOCABULARY_MATCHES_CSV` (same set, different order) which the
  suite asserts.

## Commands and results

| Command | Result |
|---|---|
| `cd server && npx tsx --test tests/m2-student-import-resolution.test.ts` | 60 pass / 0 fail |
| `cd server && npx tsx --test tests/m2-student-import-resolution-failures.test.ts` | 17 pass / 0 fail |
| `cd server && npx tsx --test` on 7 nearby tenant suites (profile, profile-update, branches, units, lessons, reorder, branding) | 296 pass / 0 fail (unchanged) |
| `cd server && npx tsx --test tests/m2-academic-periods*.test.ts` (OpenCode's lane) | 127 pass / 0 fail |
| `cd server && npx tsc --noEmit` | 0 diagnostics |
| `npx tsx --test src/tests/m2-student-import-server-resolution.test.ts` | 63 pass / 0 fail |
| `npx tsx --test src/tests/m2-student-import-resolution.test.ts src/tests/m2-student-csv-preview.test.ts` | 101 pass / 0 fail (unmodified) |
| `npx tsx --test src/tests/m2-*.test.ts` | 876 pass / 0 fail (whole M2 client set) |
| `npx tsc --noEmit -p tsconfig.app.json` | 0 scoped; same 11 pre-existing outside scope |

New tests: **140** (60 + 17 + 63).

**Note on the typecheck command.** `npx tsc --noEmit` at the repository root
checks **nothing**: the root `tsconfig.json` has `"files": []` and no `include`.
The real frontend check is `npx tsc --noEmit -p tsconfig.app.json`. The 11
remaining diagnostics are pre-existing and outside this scope: `NotificationBell`
(1), `StudentHeader_OLD_BACKUP` (2), `ExamReports` (2), `ExamResults` (1), `Fees`
(2), `StudentBarcodes` (1), `StudentDashboard` (1), `versionChecker` (1).

## Remaining work / limits

- **No live MySQL, no real collation, no real concurrency, no listener, no socket,
  no HTTP, no app startup.** The collation superset is **modelled**
  (`collationSuperset`) rather than observed, and real index usage is not measured.
- **No migration was created or applied** — this batch needs none, because it
  reads existing `students` rows only.
- **The reconciliation is informational only.** A match blocks nothing: not an
  inclusion decision, not the JSON report, not any import. Making it blocking is
  product policy the handoff did not authorize.
- **"Active" means `students.is_active = 1`.** `approval_status` is deliberately
  not part of the predicate, because the handoff did not name it.
- **No record-level detail and no per-field counts** are returned: only the field
  names, by design.
- **No DOM paint / real RTL layout / browser**, and no performance claim.
- Preserved all dirty accepted work including OpenCode's academic-period
  correction; no Git writes, no installs, no npx fetch, no lint, no browser, no
  network, no DB, no services, no deploy, no schedule change, no credentials.

## Open questions carried in the report

1. Should an existing-record match ever block an inclusion/report/import, and if
   so with what explicit override?
2. Is `is_active` the intended definition of "active student", or should
   `approval_status` also be required?
3. Is a per-field existing-record **count** (still without identity) wanted later?
4. Real collation, index usage and concurrency remain unverified by design.

Codex independently reviews source, architecture, contracts, tests and bounds.
This note is **not** acceptance.
