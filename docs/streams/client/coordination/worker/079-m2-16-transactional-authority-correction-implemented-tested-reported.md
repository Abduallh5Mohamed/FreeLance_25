# 079 — M2-16 transactional-authority correction: implemented, tested, reported

**Task:** `client-m2-16-transactional-authority-correction-20261022-01` (team
`integration`, `taskKind: correction`, approvalVersion 2, batch `M2-16`).
**Worker:** `opencode-session-native-m2-16` (OpenCode native CLI lane).
**Branch:** `codex/human-client`. **Status:** implemented, tested, **reported** —
**this is not acceptance**; Codex independently reviews.
**Reported at:** 2026-10-21T22:30:01Z / 2026-10-22 01:30 Cairo.

## The defect this correction fixes

Supervisor/225 found a concrete transaction-authority defect in
`server/src/routes/student-import-resolution.ts`, `POST /commit`.

**Before (actual):** the verified-owner authority SELECT executed **before**
`beginTransaction()`:

```
acquire → owner SELECT → BEGIN → idempotency lock → re-check → writes
```

The approved M2-16 policy and the M2-B09 contract require the authority
revalidation **inside the same transaction as the writes**. The gap let the
owner's authority, the tenant status or the caller's active state change
between the authorization read and the transaction start, so the write could be
authorized against a snapshot that was already stale.

**After (actual):** the transaction opens **before** the authority read, and
that read and every recheck and write after it share one transaction on one
connection:

```
acquire → BEGIN → owner SELECT → idempotency lock → re-check → writes → COMMIT
```

A denied authority now rolls that transaction back **before** the answer, so
the 403 path closes its session cleanly, releases the connection exactly once
and writes nothing.

## Paths changed (exactly the four allowedPaths)

| Path | Change |
|---|---|
| `server/src/routes/student-import-resolution.ts` | `POST /commit` opens the transaction **before** the owner/tenant/caller authority SELECT; the denied-authority branch rolls the open transaction back (`transactionOpen = false`) before answering `403`; the module header and the handler JSDoc now state the order truthfully |
| `server/tests/m2-student-import-commit.test.ts` | +3 production-path regressions (the successful-path event order corrected to `begin → owner → …`; the new transaction-authority regressions) |
| `server/tests/m2-student-import-commit-failures.test.ts` | +1 regression (denied authority whose rollback fails) and the owner-verification / failed-BEGIN / batch-read / batch-INSERT event orders corrected to `begin → owner → …` |
| `docs/streams/server/M2-B09-CONTRACT.md` | correction reference in the header; the Authorization section now states the inside-transaction requirement, the observable order and the "no statement outside a transaction" rule; Connection hygiene gained the denied-authority rollback bullet |

Not touched: the shared harness
(`server/tests/helpers/m2-student-import-resolution-harness.ts` — **not** in the
allowed set, so the new tests use only its existing API), `tenant-self.ts`, the
migration FILE, the client lane, the M2-B08 resolution suites, any shared/auth/
provider/config/package file, and any schedule.

## Behaviour, precisely

* **Pre-connection behaviour is unchanged**: malformed payload (`400`),
  billing-only (`403`), no server-selected tenant (`404`) and no transactional
  seam (`503`) are all still decided before a connection is taken, and the
  transactional seam is still never replaced by the read-only one.
* **The authority read now happens inside the transaction.** When
  `beginTransaction` fails, **no statement is issued at all** — the owner
  authority can never be read outside a transaction.
* **A denied authority** (`owner_user_id` mismatch, tenant not `active`, caller
  not active) answers `403 {"error":"Forbidden"}` after an explicit
  `rollback()`: the session is closed, the connection is released exactly once,
  and neither a batch record nor a student row is written.
* **A rollback that fails on the denial path** discards the session instead of
  returning it to the pool and answers an opaque `500`, because the transaction
  state is then unknown. It never answers `403` over an open transaction.
* **Idempotency, privacy, bounds, chunked reads/inserts, the uncertain-commit
  handling and every exact response body are unchanged.** The duplicate-key
  path still rolls back and re-reads the batch record outside the transaction
  exactly as before, and the uncertain commit still destroys the session with
  `STUDENT_IMPORT_COMMIT_UNCERTAIN`.

## Commands and results

| Command | Result |
| --- | --- |
| `cd server && npx tsx --test tests/m2-student-import-commit.test.ts tests/m2-student-import-commit-failures.test.ts` | **73 pass / 0 fail** |
| `cd server && npx tsx --test tests/m2-student-import-commit.test.ts tests/m2-student-import-commit-failures.test.ts tests/m2-student-import-resolution.test.ts tests/m2-student-import-resolution-failures.test.ts` | **150 pass / 0 fail** (baseline before the correction: 146/146) |
| `cd server && npx tsc --noEmit -p tsconfig.json` | **0 diagnostics** (baseline before the correction: 0) |

The unchanged M2-B08 resolution suites
(`m2-student-import-resolution.test.ts`,
`m2-student-import-resolution-failures.test.ts`) are included in the 150 and
were not modified.

New tests: **4** (3 in the commit suite, 1 in the failures suite).

## The regression is non-vacuous (verified, not asserted)

The pre-correction ordering was temporarily restored **inside the allowed route
path**, the suites were re-run, and the correction was restored immediately
afterwards. Under the old ordering the run was **65 pass / 8 fail**:

```
not ok 2  - failure: a failed owner verification is a 500 with the connection released
not ok 3  - failure: a denied authority whose rollback fails discards the session and writes nothing
not ok 4  - failure: a failed beginTransaction opens nothing and writes nothing
not ok 5  - failure: a failed batch/idempotency read rolls the transaction back
not ok 8  - failure: a failed batch INSERT rolls the whole batch back
not ok 47 - transaction authority: BEGIN precedes the owner-authority SELECT on the production path
not ok 48 - transaction authority: a denied authority rolls back, releases once and writes nothing
not ok 57 - write: the batch record is written before the students, so the key serializes
```

Every new or strengthened assertion therefore fails against the defect and
passes against the correction. The temporary edit was reverted in the same
session; no temporary marker text remains in the file, and the final tree is
the corrected one (150/150, tsc 0).

## Evidence limits

* The tests drive the **real** production route, mount and middleware through
  the existing hermetic fixture: the real optional-auth middleware, the real
  tenant-authority and student-workspace boundaries and the real
  `createTenantSelfRouter` with the real student-import router. Only the leaf
  data repositories and the connection are injected.
* **Not exercised and not claimed:** live MySQL, real transaction isolation
  levels, real row/gap-lock contention, real collation behaviour, HTTP
  transport, a listener, a socket, a browser or an app startup. The
  transactional fixture models the ordering, the rollback and the write
  staging.
* The migration FILE `server/migrations/20261021_04_student_import_batches.sql`
  is still **NOT applied**; no statement of it was executed and no database was
  contacted.
* No performance, latency or scalability claim. The statement count of the
  commit path is unchanged by this correction: it adds no statement, only a
  reordering of BEGIN relative to the existing authority read.
* No Git write, no install, no npx fetch, no lint, no deploy, no migration
  application, no account/credential change, no schedule change and no
  self-acceptance. All uncommitted work (including the accepted M2-12/M2-13
  work and WorkBuddy078's M2-16 batch) is preserved; the tracked-file
  `git status` list is identical to the pre-session list.
* No native OpenCode session id is exposed by this run, so none is reported.

## Open questions for the reviewer

1. Should the duplicate-key (`ER_DUP_ENTRY`) path also re-read the batch record
   **inside** its transaction instead of after the rollback? It is a read of
   the idempotency record only — no authority read and no write — and the
   correction deliberately preserved the existing idempotency behaviour and
   responses, so this was left untouched. It is a bounded follow-up if the
   reviewer wants every post-BEGIN statement inside the transaction.
2. Should the denied-authority path keep answering `403` when the rollback
   itself fails, at the cost of releasing a session whose transaction state is
   unknown? This correction answers an opaque `500` and discards the session,
   which is the documented degraded behaviour; the other choice is a contract
   decision.

Codex independently reviews the source, architecture, contracts, tests and
bounds. This note is **not** acceptance.
