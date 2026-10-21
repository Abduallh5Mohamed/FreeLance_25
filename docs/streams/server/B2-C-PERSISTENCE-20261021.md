# B2-C-PERSISTENCE — SQL adapter delivery (correction pass)

Date: 2026-10-21
Task: B2-C-PERSISTENCE (correction)
Status: source + hermetic tests + provisional typecheck complete

This pass corrects the held items from the first delivery: report-source
unavailability must become HTTP 503, one mutation must have exactly one sealed
audit writer, bounded reads must never present a truncated result as complete,
and FK failures must be classified by the proven constraint name.

## 1. Files and hashes

All paths are relative to the repository root. `sha256` is over the file bytes.

| File | Before | After |
| --- | --- | --- |
| `server/src/services/exam-manual-grading-sql.ts` | `d438d20f8c7f4324a7187d19c37df3687dac4d45b6e889ac1ec0ca1850250c5d` | `40fcb39c63a885854a717c28bbf14aa5f749ebee66f17b94bfba4def15510a63` |
| `server/src/services/progress-publication-sql.ts` | `3ab27b2264c2b00b68696b11c2c14366fc535508ea3b27a6d62ff568da140093` | `fa8a85e10ba99a6dc82f1dfa359847997383c2cb83215126fa1d49d6437450a4` |
| `server/src/services/progress-report-source-sql.ts` | `14513908019d861242a8bf8d3713d7c5b60802f9f5ea9b35362bde5fb6d5c9d4` | `579d5fe237729564665c482113bd8c3295a5401df5820946484624e561d05ed2` |
| `server/src/routes/progress-reports.ts` | `f86a735849f2f1eeaefd8a864db1cc00e1bb708f4ca2e2e5340c702c90da3074` | `21e6a756265ba9f11577c2f6a10a9ad6d3b2a8a534b48040d00cfde23c1d9fd2` |
| `server/tests/exam-manual-grading-sql.test.ts` | `120477173a0c5975be753e2e63e08eb9c1ce3faa86807a0e1e5ae2846c4b736c` | `5f6ad57b1a996276ac8f041459b550eab1b2398a556775b729ca686938d8be28` |
| `server/tests/progress-publication-sql.test.ts` | `7e2e23b6f2d8300f6c0c6ce66c364d945ac2e133a637c21b493beac5194b19de` | `e7957277088f0f5344b40413e86ba95272255e051198f6c95c6e68fbce79df7c` |
| `server/tests/m4-progress-reports.test.ts` | `15744558e0c5a6d42eee752b2b7a842ba0e641a4d2d73123a6d102a47dd94ce7` | `7cbeb2531597a0e490469a1a4a180ae13758237590f317741766be380bba27ef` |
| `docs/streams/server/B2-C-PERSISTENCE-20261021.md` | `8207650995c93b90d409a28efdbb2f74f08390d8fa92355ec1eaaad05f479817` | this report (hash not self-referential) |

Unchanged in this pass (recorded for the audit trail):

| File | SHA-256 |
| --- | --- |
| `server/src/services/billing-ledger-sql.ts` | `d43e60f1481f658af5139bcdbfe16b8260c2f3525032a1ad7297a78462b6b61c` |
| `server/tests/billing-ledger-sql.test.ts` | `63710ccb9cc930d6e9b9738effb66ea5cbc7cebdf7031523522a013e00ae10ec` |
| `server/src/routes/exam-manual-grading.ts` | `124ea29f88f63c15fe9bb3b42e2ed246fd93aa9b0583ae5d45fccdb1e80b4cb0` |
| `server/tests/m4-exam-manual-grading.test.ts` | `1dc938b9c7d77e4828e8e62fb737f5f419889fd4fc640908002bc92ca3b5dfb6` |

No existing source file outside the allowed set was edited. No migration was
created, edited or executed. No manifest, `index.ts`, `db.ts`, auth/helper,
frontend, bridge or WorkBuddy file was touched. Git was read-only.

## 2. Single sealed audit writer per mutation

### 2.1 Chosen writer

The writer that already ran inside the transaction callback is the domain
service/route layer:

| Mutation | Single writer |
| --- | --- |
| `exam_manual_grade.answer` | `server/src/routes/exam-manual-grading.ts` inside `deps.transaction` |
| `exam_manual_grade.finalize` | `server/src/routes/exam-manual-grading.ts` inside `deps.transaction` |
| `progress_report.publish` | `server/src/services/progress-publication.ts` inside `PublicationTransaction` |
| `progress_report.unpublish` | `server/src/services/progress-publication.ts` inside `PublicationTransaction` |

The SQL adapters no longer write an audit row in `appendAnswerGradeRevision`,
`finalizeAttempt` or `transitionPublication`. Their default audit fallback was
removed entirely; there is no built-in unsealed INSERT and no silent no-op.

### 2.2 Adapter contract

Both SQL adapters now require the audit writer at construction:

- `ExamManualGradingSqlDeps.audit` and `ProgressPublicationSqlDeps.audit` are
  required. Construction throws `invalid_audit` before any statement when the
  writer is absent or not callable.
- The transaction-bound handle implements:
  - `ExamManualGradingSqlBoundStore.writeAudit(input)`
  - `ProgressPublicationSqlBoundStore.writeAudit(input)`
- `writeAudit` calls the injected sink with the **same `conn`** object whose
  `query`/`execute` are used by the mutation. No pooled connection, no separate
  transaction and no autocommit path exists.
- Production binding requirement: the injected `audit` callback must be a
  sealed writer — `recordSealedAuditEvent` from `services/audit-log.ts` or the
  repository's transaction-aware sealed writer — invoked with that same
  transaction connection. Passing a pooled or separate connection is a wiring
  defect; the recording tests detect a different connection identity.
- Ledger journal writes keep their own journal rows. No audit row was added to
  `billing-ledger-sql.ts`.

Tests assert, on a recording connection: zero audit rows from the adapter
alone, exactly one audit row when the single writer calls `writeAudit`, one
audit row for publish and one for unpublish, and full rollback (state change,
revision row, publication row) when the audit write fails. Missing audit writer
and missing transaction runner are rejected before any write.

## 3. Report source 503 contract

`server/src/routes/progress-reports.ts` now defines the injected contract:

```ts
type ProgressReportSourceUnavailableCode = 'unavailable' | 'incomplete';

class ProgressReportSourceUnavailableError extends Error {
  readonly code: ProgressReportSourceUnavailableCode;
  readonly detail: string;
}

type ProgressReportSourceResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: ProgressReportSourceUnavailableCode; detail: string };
```

`ProgressReportSource` gains optional `listRecordsResult` /
`findRecordResult`. The route prefers the discriminated result and also
recognises the typed error from a legacy `listRecords` throw. Both the teacher
list and the CSV export:

- return HTTP 503 with `{ "error": "Progress reports are temporarily
  unavailable" }`;
- send no records and no CSV bytes;
- write no export audit row and no success audit;
- do not read the publication store after an unavailable source.

Untyped/unknown errors are rethrown to the existing generic 500 path and are
never converted to success, an empty report or a partial CSV. An authorized
source that legitimately returns zero rows still returns HTTP 200 with an empty
list.

Completeness in `progress-report-source-sql.ts`:

- record list and score reads request `cap + 1` rows;
- a full extra row returns typed `{ ok: false, code: 'incomplete' }` and never a
  truncated list or an average over a truncated subset;
- invalid COUNT values (null/undefined, NaN, negative, fractional,
  non-numeric string, unsafe integer) return typed `incomplete`; they are never
  coerced to zero;
- `overall` stays `null` because no approved weighting formula exists.

## 4. FK failure mapping

Constraint names come from `server/migrations/20261021_01_exam_manual_publication.sql`.

| Constraint | Typed outcome |
| --- | --- |
| `fk_manual_revision_answer` | `answer_not_found` |
| `fk_manual_revision_attempt` | `attempt_not_found` |
| `fk_manual_revision_reviewer` | `reviewer_not_found` |
| `fk_manual_revision_tenant` | `tenant_not_found` |
| `fk_exam_attempts_reviewer` (finalize) | `reviewer_not_found` |
| unknown / unnamed FK | `foreign_key_violation` with the constraint name in the message and the original error as `cause` |

`answer_not_found` is now returned only for the answer/question reference
constraint. An attempt, reviewer or tenant reference failure is distinct, and
an unknown constraint is never relabelled as `answer_not_found`.

## 5. Verification

Commands (run from the repository root):

```text
node node_modules/tsx/dist/cli.mjs --test --test-force-exit server/tests/exam-manual-grading-sql.test.ts
node node_modules/tsx/dist/cli.mjs --test --test-force-exit server/tests/progress-publication-sql.test.ts
node node_modules/tsx/dist/cli.mjs --test --test-force-exit server/tests/billing-ledger-sql.test.ts
node node_modules/tsx/dist/cli.mjs --test --test-force-exit server/tests/m4-progress-reports.test.ts
node node_modules/tsx/dist/cli.mjs --test --test-force-exit server/tests/m4-exam-manual-grading.test.ts
```

Results:

| File | Tests | Pass | Fail | Skipped |
| --- | --- | --- | --- | --- |
| `exam-manual-grading-sql.test.ts` | 18 | 18 | 0 | 0 |
| `progress-publication-sql.test.ts` | 20 | 20 | 0 | 0 |
| `billing-ledger-sql.test.ts` | 15 | 15 | 0 | 0 |
| `m4-progress-reports.test.ts` | 43 | 43 | 0 | 0 |
| `m4-exam-manual-grading.test.ts` | 20 | 20 | 0 | 0 |
| **Total** | **116** | **116** | **0** | **0** |

Notable new/strengthened test names:

- construction fails fast without the required audit writer before any write
  (exam and publication);
- append success writes the state change, no implicit audit, then exactly one
  explicit audit on the same conn;
- finalize audit failure rolls the finalized state back;
- finalize locks the attempt first, re-reads revisions on the same connection,
  then CASes;
- audit failure after the state change rolls back every write and the revision
  row;
- the audit writer is bound to the transaction connection and a foreign conn is
  detectable;
- FK mapping: answer / attempt / reviewer / tenant / unknown / finalize
  reviewer;
- service publish / unpublish writes exactly one audit row on the same
  connection as the transition;
- service audit failure rolls the publication state change back;
- record-list cap exactly at cap is complete; cap + 1 is incomplete;
- score cap exactly at cap is complete; cap + 1 is incomplete;
- invalid COUNT values are a typed incomplete result, never coerced to zero;
- an unavailable source makes the list return 503 with a generic body and no
  records;
- an incomplete source makes the CSV export return 503 with no CSV bytes and no
  export audit;
- an untyped source error stays a generic 500, never an empty report or a
  success;
- an authorized but empty source still returns 200 with an empty list.

Existing permission, concurrency, HK1 and HK2 tests in the affected files were
kept and still pass. The route tests were extended only by adding
`listRecordsResult` to the in-memory source and a `listCalls` counter; no
existing assertion was removed or weakened.

Provisional typecheck:

```text
node node_modules/typescript/bin/tsc --noEmit -p server/tsconfig.json
# exit 0, no diagnostics
```

`server/tsconfig.json` includes only `src/**/*`; the test files are executed by
`tsx` at runtime and are not part of that tsc program.

## 6. Held items / limits

1. **No approved `overall` formula.** `ProgressRecord.overall` remains `null`;
   no weighting between exam and assignment averages is invented.
2. **Domain race union still has no FK reason.** `StoreAppendRaceReason` has no
   `answer_not_found`; the adapter exposes it as a typed
   `ExamManualGradingSqlError`. If the domain union should carry the case, that
   is an owner decision outside this task's file set.
3. **Production wiring is not done.** No factory is mounted; the integration
   owner must bind the route/service writer to
   `ExamManualGradingSqlBoundStore.writeAudit` /
   `ProgressPublicationSqlBoundStore.writeAudit`, and that writer must be the
   sealed `recordSealedAuditEvent` on the same transaction connection.
4. **Recording seam is not MySQL.** Tests verify SQL text, bindings, statement
   order, connection identity, rollback counters and result mapping. They do
   not execute SQL. InnoDB row-lock ordering, real FK names/errno payloads,
   duplicate-key arbitration, CHECK enforcement, collation and the MySQL
   8.0.16+ requirement remain unproven until an approved live run.
5. **Ledger adapter unchanged.** Its BIGINT normalization assumes mysql2
   `supportBigNumbers: true` and `bigNumberStrings: true`; a different binding
   shape is rejected rather than silently rounded.
6. No database, Docker, network, provider, secret, install or git mutation was
   used.

## 7. Stop state

Writing is complete. No further file will be created or edited for this task
unless the coordinator requests a specific correction.
