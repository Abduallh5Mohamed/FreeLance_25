# B2-C-INTEGRATION — production wiring report (correction pass, 2026-10-21)

Task: B2-C-INTEGRATION correction. One worker; the previous integration worker
is stopped. This lane owns exactly seven files; everything else is read-only.
The tree was dirty before the task; all pre-existing uncommitted changes were
preserved. No git mutation, database, listener, install, provider or network
was used.

## 1. Files and hashes

`sha256` is over the file bytes. Baseline was recorded before any edit.

| File | Baseline | After |
| --- | --- | --- |
| `server/src/index.ts` | `95b70b93070f89a667b54dcc48e20520ff3a0bf5ccfa92b5472d652c11ad982e` | `95b70b93070f89a667b54dcc48e20520ff3a0bf5ccfa92b5472d652c11ad982e` (unchanged) |
| `server/bootstrap/m1/manifest.json` | `5b048ff3c61827ae504e5935cfa46a42cd9df4ff3ca62058e6725d5869d1f399` | `5b048ff3c61827ae504e5935cfa46a42cd9df4ff3ca62058e6725d5869d1f399` (unchanged) |
| `server/src/services/school-reporting-wiring.ts` | `7faecee732547745c7a7cd4f00eccb01d9f71cb32097f493bc4d3daa2080332b` | `5c778d127432ea446b469e185dd20db87fcc954a38534481455e7f3d1e487075` |
| `server/tests/b2-production-wiring.test.ts` | `0f42bb35f15038b669007d4574a218022d38cdfa4ab204e37ec9117f8a1c20e8` | `ea1db80e7e1461e2194157709a8ca18f1c2c9c90716e3baba941a61b0174438e` |
| `docs/streams/server/B2-C-INTEGRATION-20261021.md` | `832ae1e012631e0be2b34ee782128623f7f0446f38bc906407dfb3ff73c2e739` | this file (own hash reported in the task summary) |
| `server/src/routes/attendance-reports.ts` | `db9e257cde03d894156e916bea8d4cb5f01e5952669f99f8702f49b69f4afaba` | `ff2e2675ea51032103e5afed5e362eeeb8dc4d33562b9e54ae8d5b61cd7ea145` |
| `server/tests/m5-attendance-reports.test.ts` | `c80ab00c39604a671bd36ab7339a009b0001613f733255e18db4e1547ec4ba0d` | `dd53084bf9a5adf06acc68d2efb2df68499806c871ffb3cb58ae70c107bb3f65` |

Only localized edits were made. `server/src/index.ts` and the manifest required
no change for this correction and were not edited.

## 2. Corrections delivered

1. **Manual-grading authority.** The membership-only branch grant was removed
   from `createSqlExamManualGradingAuthority`.
2. **Attendance export audit.** The export now requires an explicit sealed
   audit writer instead of the plain `recordAudit(store.execute, ...)` INSERT.
3. **Schema readiness by columns.** The lazy probe now checks required columns
   as well as tables, and known MySQL schema-error codes raised during a
   request map to the generic 503 while unknown errors stay a generic 500.
4. **Pool wording.** The incorrect pool-creation comment was corrected.

## 3. Manual-grading authority

`authorizeExam` in `school-reporting-wiring.ts` now grants only from explicit,
server-derived teaching relations:

- tenant owner (`authority === 'owner'`),
- the course instructor (`courses.instructor_id`),
- an instructor of a group of that course (`groups.instructor_id`).

A verified branch membership and a group of the course in that branch is **no
longer a grant**. Branch membership is a constraint only. `createBranchAccess`,
`courseHasGroupInBranch`, the `resolveBranchAccess` import and the
`BranchAccessDeps` import were removed because nothing else in the module used
them. Ambiguous or unrelated relations deny. `listAuthorizedExamIds` was
already explicit-only and is unchanged.

Acceptance tests run the real wiring authority and the real routers over the
recording seam (real SQL text and bindings):

- a verified branch member with **no** teaching assignment is refused on the
  pending list (200 with an empty queue, revealing nothing) and on attempt
  detail, grade and finalize (403), with zero writes and zero audit rows; the
  recorded SQL contains no `branch_memberships` read and no
  `branch_scope='branch'` grant;
- owner, course instructor and a group instructor of the same course are
  positive for pending, attempt detail, grade and finalize (two sealed audit
  rows: grade + finalize);
- the group-instructor case deliberately assigns the caller to a **different**
  group of the same course, asserting the implemented explicit course-level
  relation.

## 4. Attendance export is sealed

`server/src/routes/attendance-reports.ts`:

- `AttendanceReportsStore` is now read-only (`query` only); the old `execute`
  write seam is gone.
- `deps.audit` is a REQUIRED, typed
  `AttendanceReportAuditWriter(store, input)`. Construction without a callable
  writer throws `Attendance reports require a sealed audit writer` before any
  request.
- The export calls `deps.audit(store, input)` exactly once with the same store
  handle used for the read, **before** `res.send(csv)`. An audit failure is
  caught by the existing generic error path: HTTP 500, no CSV bytes, no
  content-type and no partial data.
- The payload is unchanged: actor, tenant, action
  `attendance_report.export`, resource type, range, filter ids, row count,
  truncated flag, totals and requested-at. No `reason`/`reason`-like field and
  no PII is added.

`school-reporting-wiring.ts` binds it to the sealed writer on one transaction
connection:

```ts
const attendanceAudit = (_store, input) =>
    db.transaction((conn) => sealedAuditSink(conn, input));
```

`sealedAuditSink` is `recordSealedAuditEvent` in production. The recording test
asserts exactly one sealed `INSERT INTO audit_events` (with `entry_hash`), all
seal statements on one non-zero connection id, no plain audit INSERT, and that
an audit failure rolls back and leaves no CSV/audit.

## 5. Schema readiness by columns

`REPORTING_REQUIRED_COLUMNS` is explicit and documented in code. It contains:

- `exam_versioned_attempts.reviewer_user_id` — added by migration
  `20261021_01` to an EXISTING table;
- every column the adapter SQL names on `exam_manual_answer_revisions`:
  `id, tenant_id, attempt_id, question_ref, revision, awarded_hundredths,
  reviewer_user_id, feedback, created_at`;
- every column the adapter SQL names on `progress_report_publications`:
  `id, tenant_id, student_enrollment_id, course_id, state, published_by,
  published_at, version`.

The probe still runs lazily at request time (never at import or router
construction), still caches a successful reading for the short TTL, and never
caches a probe error. It now issues a read-only
`INFORMATION_SCHEMA.COLUMNS` query after the table query; a missing table or
column yields `503 { "error": "Reporting is temporarily unavailable" }` before
any handler, data read, write or audit.

Request-time schema errors are classified by a per-request
`AsyncLocalStorage` marker installed by the wiring's datastore wrapper and a
response interceptor around each returned router:

| Error code | Result |
| --- | --- |
| `ER_NO_SUCH_TABLE` | generic 503 |
| `ER_BAD_FIELD_ERROR` | generic 503 |
| `ER_BAD_TABLE_ERROR` | generic 503 |
| any other error (e.g. `ER_LOCK_WAIT_TIMEOUT`) | unchanged generic 500 |

Unknown errors are never converted to success or 503. Tests assert all four
codes, zero writes and zero audit rows.

## 6. Pool wording correction

The old comment said the pool "is still created lazily on the first real
request". That sentence was removed. The corrected wording in
`school-reporting-wiring.ts` states the verifiable invariant: importing this
module issues no query, acquires no connection and starts no worker; it imports
the existing `../db` module, which owns the MySQL pool, but the wiring module
itself evaluates no statement at import.

Honest note: in the `server/src/db.ts` actually present in this tree, the pool
is created inside `getPool()` (lazy), not by a top-level `mysql.createPool` at
import. The review text said the pool object is created at import; that does
not match the file read here. `db.ts` is read-only for this lane and was not
edited. The comment and this report record only the invariant both readings
share: the wiring issues no query/connection at import.

## 7. Tests and results

Command form:
`node node_modules/tsx/dist/cli.mjs --test --test-force-exit server/tests/<file>`.

| File | Tests | Pass | Fail | Skipped |
| --- | --- | --- | --- | --- |
| `b2-production-wiring.test.ts` | 23 | 23 | 0 | 0 |
| `m5-attendance-reports.test.ts` | 24 | 24 | 0 | 0 |
| `m2-m3-mounting.test.ts` | 20 | 20 | 0 | 0 |
| `m1-bootstrap-plan.test.ts` | 2 | 2 | 0 | 0 |
| `m8-stabilization-mounting.test.ts` | 2 | 2 | 0 | 0 |
| `exam-manual-grading-sql.test.ts` | 18 | 18 | 0 | 0 |
| `progress-publication-sql.test.ts` | 20 | 20 | 0 | 0 |
| `billing-ledger-sql.test.ts` | 15 | 15 | 0 | 0 |
| `m4-progress-reports.test.ts` | 43 | 43 | 0 | 0 |
| `m4-exam-manual-grading.test.ts` | 20 | 20 | 0 | 0 |
| `b2-schema-contract.test.ts` | 26 | 26 | 0 | 0 |
| **Total** | **213** | **213** | **0** | **0** |

Notable new/strengthened test names:

- `manual grading authority: a verified branch member with no teaching
  assignment is never granted by branch membership`;
- `manual grading authority: owner, course instructor and group instructor stay
  positive for read, grade and finalize`;
- `attendance export writes exactly one sealed audit on one transaction
  connection before the CSV`;
- `attendance export audit failure returns a generic error with no CSV bytes,
  no audit and a rollback`;
- `readiness: tables present but a required column missing answers 503 before
  data/write/audit`;
- `readiness: all required tables and columns present lets the real request
  flow`;
- `readiness: construction and import issue no INFORMATION_SCHEMA or data
  query`;
- `request-time schema errors: known codes become a generic 503, unknown codes
  stay a generic 500`;
- `attendance reports: construction without a sealed audit writer throws before
  any request`;
- `attendance reports: export is audited ...` now asserts one event with the
  same store handle as the read.

New acceptance tests were written together with the code (new behavior, not
failing-first defect fixes); the attendance and wiring suites were adapted to
the new required dependencies without removing or weakening assertions.

Provisional typecheck:

```text
node node_modules/typescript/bin/tsc --noEmit -p server/tsconfig.json
# exit 0, no diagnostics
```

`server/tsconfig.json` includes only `src/**/*`; test files run under `tsx`.

## 8. Held items

1. **Attendance row visibility is copied, not imported.** The attendance module
   does not export its predicate; the wiring copies the exact server-verified
   SQL fragment. If that predicate changes, both copies must be updated.
2. **Ledger is not exposed.** `createInternalLedgerStore` remains an unused
   factory seam; no financial route, collection, reserve/release/consume
   endpoint or startup hook exists.
3. **Notification worker is not started.** Wiring it remains a follow-up after
   W9 acceptance.
4. **Base-table readiness is global.** All three surfaces share one required
   table/column set, so a missing unrelated base column fails all three closed
   with 503 rather than only the affected surface. This is deliberately
   conservative.
5. **`index.ts` is not imported in tests.** Mount/order/CORS verification is
   static source inspection; live Express behavior is proven only for the
   routers via the wiring module.
6. **The schema is not applied.** The routes answer 503 in production until
   migration `20261021_01` (and the readiness columns it adds) is applied under
   separate authorization. Registration in the manifest is not application.
7. The attendance export is no longer a held item: it is sealed in this pass.

## 9. Limits

- The recording connection is not MySQL. Tests prove router -> service ->
  adapter -> audit sequencing, statement text/bindings, connection identity,
  column-readiness shape and rollback counters; they do not prove InnoDB
  locking, FK/CHECK enforcement, collation, privilege behavior or MySQL
  8.0.16+.
- Real `INFORMATION_SCHEMA.COLUMNS` output, live driver behavior and the
  production sealed writer's behavior remain unproven until an authorized live
  run.
- No live server was started; no listener, network, Docker, database, provider,
  secret or install was used.
- The schema migrations remain source-only and NOT applied.
- No `any`, `ts-ignore`, skipped test, assertion weakening, runtime DDL or git
  mutation was added.

## 10. Stop state

Writing is complete. No further file will be created or edited for this task
unless the coordinator requests a specific correction.
