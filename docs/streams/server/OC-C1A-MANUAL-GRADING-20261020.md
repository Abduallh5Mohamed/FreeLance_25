# OC C1a — manual grading for the NEW versioned exam system

Date: 2026-10-20. Writer: OpenCode/Claude lane (C1a). Governing scope:
`docs/streams/server/CLOSURE-BATCH1-SCOPE-REVIEW-20261020.md:32` and
`docs/streams/server/OPENCODE-C1-C8-ALLOCATION-20261020.md:21-29`.

## Deliverable

New files only. Nothing existing was edited, nothing was mounted, no DDL/SQL was
written or applied, and the legacy `server/src/routes/manual-grading.ts` is
untouched. The new router factory is intentionally not referenced by
`server/src/index.ts`.

| File | sha256 after continuation |
|---|---|
| `server/src/services/exam-manual-grading.ts` | `4e63d65d0d7ee5f0a17dcf177852a70c325c0f7d2d697e03c1561fd57a12158e` |
| `server/src/routes/exam-manual-grading.ts` | `124ea29f88f63c15fe9bb3b42e2ed246fd93aa9b0583ae5d45fccdb1e80b4cb0` |
| `server/tests/m4-exam-manual-grading.test.ts` | `1dc938b9c7d77e4828e8e62fb737f5f419889fd4fc640908002bc92ca3b5dfb6` |

The first-pass hashes in the original column were
`e3afc5cd…e093c` (service), `2772570d…f4e` (route) and `49d9f74e…f68b`
(test); those files changed after the supervisor corrections, so the measured
pre-continuation baseline is recorded in the continuation section below. The
report file itself is not self-hashed.

Endpoints in `createExamManualGradingRouter(deps)` (factory only, unmounted):

- `GET /pending` — bounded pending-review queue for the exam ids returned by the
  injected server-verified teaching authority.
- `GET /attempts/:attemptId` — attempt, pinned questions, stored answers and the
  latest manual revision per question (staff only; no answer key).
- `POST /attempts/:attemptId/answers/:questionRef/grade` — append one answer
  grade revision.
- `POST /attempts/:attemptId/finalize` — recompute the exact total and move
  `pending_review -> graded` once.

Injected seams: `deps.authenticate`, `deps.authority`,
`deps.audit(tx, record)`, `deps.transaction(fn)`, `deps.store` and `deps.now`.
The store contract is `ManualGradingStore`; there is no production SQL store and
no default wiring in this deliverable.

## State rules implemented

- Grade/finalize only while `status = pending_review`; finalization is once.
- An award is parsed to integer hundredths by the existing
  `toHundredths` helper and must be inside `[0, pinned question points]`.
- Revision is `max(existing revisions for attempt+question) + 1`; history is
  append-only (`UNIQUE (attempt_id, question_ref, revision)` is the storage race
  guard assumed for I2).
- Finalize recomputes `auto_score + latest manual revision per manual-review
  answer` in integer hundredths and renders with `formatHundredths`; an
  objective answer cannot be manually graded because its auto award is already
  in `auto_score` (`server/src/services/exam-manual-grading.ts:235`).
- Finalize refuses an ungraded manual-review answer instead of silently scoring
  it zero (`server/src/services/exam-manual-grading.ts:294-301`). This is an
  integrity guard, not a scoring-policy decision.
- Grade/finalize + audit run in the same injected transaction
  (`server/src/routes/exam-manual-grading.ts:278`,
  `server/src/routes/exam-manual-grading.ts:357`); a failed audit aborts the
  change. Audit values carry only attempt/question ids, revision, hundredths and
  status — no student identity, response text or feedback text.
- Students are denied on every path (`server/src/routes/exam-manual-grading.ts:146`).
- Cross-tenant attempts are 404 (store tenant filter plus authority
  `not_found`); unrelated same-tenant staff are 403; role labels are never the
  teaching authority.

## Acceptance tests

Command:

`node node_modules/tsx/dist/cli.mjs --test --test-force-exit server/tests/m4-exam-manual-grading.test.ts`

First-pass result: **14 passed, 0 failed** (hermetic; real auth middleware over
an injected principal repository, in-memory store, injected authority/audit/clock
and a transaction seam that restores state on throw). Because this is a new
module, the acceptance tests were written together with the code, not as
failing-first tests of a pre-existing defect. The supervisor correction round
expanded this suite to 20 tests; the current result (20/20 after C1a-fix) is in
the continuation section below.

1. `pure: only pending_review accepts answer grades and revisions increment by one`
2. `pure: manual award is integer hundredths inside 0..pinned maximum`
3. `pure: finalize recomputes exact total and refuses an ungraded manual answer`
4. `pending queue: a reviewer scoped to one course sees only that course`
5. `pending queue: malformed limit is 400 and store failure is a generic 500`
6. `denials: unrelated same-tenant teacher, cross-tenant actor and student are refused`
7. `grade: out-of-range or malformed points are 400 and write nothing`
8. `grade: an objective answer is refused because its auto award already counts (409)`
9. `grade: revisions 1 then 2 retain the whole history and audit each mutation`
10. `grade: graded attempt refuses a new revision (409) without a write`
11. `finalize: recomputes the total and moves pending_review -> graded exactly once`
12. `finalize: an ungraded manual answer is refused (409) with no write`
13. `finalize: a lost optimistic version race is 409 with no write or audit`
14. `audit failure rolls the answer grade and the finalize fully back`

Provisional typecheck at the time of writing:

`node node_modules/typescript/bin/tsc --noEmit -p server/tsconfig.json` — 0
errors.

## Schema assumptions handed to I2 (not applied)

1. New answer-grade/revision table (proposed name
   `exam_versioned_answer_grades`):
   `id CHAR(36) PK`, `tenant_id CHAR(36) NOT NULL`, `attempt_id CHAR(36) NOT NULL`,
   `question_ref CHAR(36) NOT NULL`, `revision INT NOT NULL`,
   `awarded_hundredths INT NOT NULL`, `reviewer_user_id CHAR(36) NOT NULL`,
   `feedback VARCHAR(2000) NULL`, `created_at DATETIME/TIMESTAMP NOT NULL`,
   `UNIQUE KEY (attempt_id, question_ref, revision)`,
   `KEY (tenant_id, attempt_id)`.
   Logical references: attempt -> `exam_versioned_attempts.id`, question ->
   `exam_version_questions.id`. No FK/DDL was written here.
2. `exam_versioned_attempts` needs reviewer columns: `reviewer_user_id CHAR(36)
   NULL` (the finalizing reviewer). `graded_at`, `score`, `version`,
   `auto_score`, `manual_required`, `status='graded'` already exist in
   `server/migrations/20261018_09_exam_snapshots_grading.sql:117-151`; the
   route uses those existing columns plus the new reviewer column.
3. Queue index: a `(tenant_id, status, submitted_at)` index on
   `exam_versioned_attempts` (or equivalent approved plan) for the pending
   listing; existing `idx_exam_attempts_tenant (tenant_id, exam_id)` remains.
4. `exam_versioned_answers` is not altered: reviewer/feedback live in the new
   revision table, so auto awards and manual revisions stay distinguishable.
5. The production transaction must wrap the revision insert / attempt finalize
   and the `audit_events` insert on the same connection, with the optimistic
   `version` guard `WHERE id=? AND tenant_id=? AND status='pending_review' AND
   version=?`.
6. Live DDL/application is I2/live authorization; this report only documents the
   contract.

## Held / policy items (not decided here)

- Result release/visibility, retakes, draft-vs-submitted precedence and
  archived-question policy remain held per
  `docs/streams/server/OPENCODE-C1-C8-ALLOCATION-20261020.md:27`,
  `docs/streams/server/OPENCODE-C1-C8-ALLOCATION-20261020.md:96` and
  `docs/streams/server/CLOSURE-BATCH1-SCOPE-REVIEW-20261020.md:32`. The router
  exposes no student/result surface; students are denied at
  `server/src/routes/exam-manual-grading.ts:146`.
- Empty-answer scoring: the reviewer must explicitly grade every manual-review
  answer; finalize returns 409 `incomplete_manual_grading`
  (`server/src/services/exam-manual-grading.ts:294-301`) rather than choosing a
  zero/blank policy. How a blank essay should be scored remains undecided.
- Whether an already auto-graded objective answer may ever be manually
  overridden is not decided. The current surface refuses it
  (`server/src/services/exam-manual-grading.ts:235`) because
  `auto_score + manual revision` would double-count it.
- Passing is computed mechanically as `total >= pinned passing_points`
  (`server/src/services/exam-manual-grading.ts:328-330`). Whether/how a pass is
  released or shown remains held with result visibility.
- Feedback is stored on the revision row as reviewer input (schema assumption
  above) but is never written to audit, logs or the pending projection.

## Limits

- The injected in-memory store proves the service/route/state contract only. It
  is **not** evidence that the I2 SQL schema, SQL queries, indexes, FK/unique
  constraints or MySQL transaction isolation work.
- The injected authority is a test double; it does not prove the production
  course/exam relation chain (tenant owner, course instructor, group instructor,
  branch-scoped instructor) against live rows.
- The transaction seam is a test seam; no real pooled connection, deadlock,
  retry or concurrent-request behavior was exercised.
- No DB, Docker, network, provider, secret, install or Git mutation was used.
- No production mount (I1), no gradebook hook (C1 -> C2/I1), no result release,
  no student view, no retakes, no draft precedence, no archived-question
  handling, no legacy `routes/manual-grading.ts` change.
- Typecheck was provisional while other writers have uncommitted edits; the
  command reported 0 errors at the time of this report.

## Continuation — C1a-fix (same owner, same four files)

Supervisor correction: `docs/streams/server/BATCH1-SUPERVISOR-REVIEW-20261020.md:21-25`
(“C1 — تثبيت عقد السباق داخل transaction”). The previous worker stopped mid-run
with a measured state of 20 tests / 18 pass / 2 fail and 2 TypeScript errors in
`server/src/routes/exam-manual-grading.ts`. This continuation inspected (did not
restart) the four allowed files, finished the two defects and updated this
report. No other file was touched, nothing was mounted, and no schema/SQL was
written.

### Before / after hashes (files edited in this continuation)

| File | sha256 before | sha256 after |
|---|---|---|
| `server/src/routes/exam-manual-grading.ts` | `a9a1ae01a70c42852498512ca1642cd8b3b20051c796d259384a5c2dad37afa2` | `124ea29f88f63c15fe9bb3b42e2ed246fd93aa9b0583ae5d45fccdb1e80b4cb0` |
| `server/tests/m4-exam-manual-grading.test.ts` | `f67ee32f19f677715bdf9df55a220d7d4d9f0142ddb38bace92e0b2597af26a4` | `1dc938b9c7d77e4828e8e62fb737f5f419889fd4fc640908002bc92ca3b5dfb6` |
| `server/src/services/exam-manual-grading.ts` | `4e63d65d0d7ee5f0a17dcf177852a70c325c0f7d2d697e03c1561fd57a12158e` | unchanged |
| `docs/streams/server/OC-C1A-MANUAL-GRADING-20261020.md` | `d08aa3d398d7687a059a55d98a0d3f2b1125ace161f13101dbe97892181e05fd` | not self-hashed (this file) |

### Diagnosis and fixes

1. **Failing test 17 — `finalize: a revision committed between the re-read and the CAS yields 409, never a stale total`.**
   Production was not wrong; the fixture was. The test seeded no manual
   revision, so the in-transaction `planAttemptFinalize` correctly refused with
   `incomplete_manual_grading` before any finalize CAS; the `beforeFinalizeCas`
   interleave could therefore never run. The fixture now seeds revision 1
   (100 hundredths) so the plan reaches the CAS, the racing grade commits
   revision 2 (250) and bumps version 3→4, and the finalize CAS fails with
   `attempt_version_conflict`. Assertions were strengthened, not weakened: the
   409 body carries no `score_hundredths`, history is exactly revisions `[1,2]`,
   latest is revision 2 at 250, and the retry computes 650 from the new
   revision. No interleaving assertion was relaxed.
2. **Failing test 20 — `audit failure rolls the answer grade and the finalize fully back`.**
   Production was not wrong; the stateful fake’s rollback was incomplete. Its
   audit double pushed the row and then threw, but the transaction `catch` only
   cleared `txToken` and left the row in `harness.audits`, faking a committed
   audit after rollback. The fake now removes every audit row written on that
   transaction token on throw (as a SQL rollback discards the same-connection
   audit insert), then rethrows. The route’s undo log already restored the
   revision/version.
3. **TypeScript errors at `server/src/routes/exam-manual-grading.ts:471`.**
   `let stalePlan = null` was narrowed to `never` because TypeScript’s control
   flow analysis does not see assignments made inside the transaction closure,
   so `if (stalePlan)` narrowed the null literal. Fixed by replacing the mutable
   outer locals with one exhaustive discriminated union
   `FinalizeTransactionOutcome` (`applied | stale_plan | rejected`); the
   transaction returns it and the response branch switches on the discriminant.
   No `any`, `ts-ignore`, non-null assertion or cast was introduced.

### Confirmed design (for I2)

This module uses **optimistic compare-and-swap**, not a lock in application
code. Every answer-revision write carries `expectedAttemptStatus =
pending_review` and `expectedAttemptVersion`; the store must atomically insert
the revision (guarded by `UNIQUE (attempt_id, question_ref, revision)`) and bump
the attempt `version`. Finalize re-reads the attempt + latest revisions through
the transaction-bound store, plans the total from that read, and CASes on the
version from the same read. Because every revision bumps the version, a revision
committed between the re-read and the finalize write either is included in the
re-read total or makes the CAS fail with 409 — never a stale total with success.

An I2 SQL implementation must therefore do one of:

- `SELECT ... FOR UPDATE` on the attempt row (and a consistent read of the
  revision rows) before planning, with the revision insert / attempt update in
  the same transaction; or
- a true compare-and-swap `UPDATE ... WHERE id=? AND tenant_id=? AND
  status='pending_review' AND version=?`, mapping affected-rows 0 to
  `attempt_not_pending` / `attempt_version_conflict`, with the revision insert
  and version bump in the same transaction. `UNIQUE
  (attempt_id, question_ref, revision)` is the backstop against duplicate
  revision numbers.

This proof is a code + fake-store contract only; it is **not** evidence that
MySQL locking, isolation, or the SQL above works.

### Acceptance results after this continuation

Command:

`node node_modules/tsx/dist/cli.mjs --test --test-force-exit server/tests/m4-exam-manual-grading.test.ts`

Result: **20 tests, 20 passed, 0 failed** (was 18 passed / 2 failed before this
continuation). Test names:

1. `pure: only pending_review accepts answer grades and revisions increment by one`
2. `pure: manual award is integer hundredths inside 0..pinned maximum`
3. `pure: finalize recomputes exact total and refuses an ungraded manual answer`
4. `pure: guard helpers parse expected versions and project CAS rejections`
5. `pending queue: a reviewer scoped to one course sees only that course`
6. `pending queue: malformed limit is 400 and store failure is a generic 500`
7. `denials: unrelated same-tenant teacher, cross-tenant actor and student are refused`
8. `grade: out-of-range or malformed points are 400 and write nothing`
9. `grade: an objective answer is refused because its auto award already counts (409)`
10. `grade: every successful revision CAS-bumps the attempt version and audits`
11. `grade: graded attempt refuses a new revision (409) without a write`
12. `grade: a malformed stored attempt version is 409 with no write`
13. `interleave: a finalize committed between a grade read and its CAS rejects the grade`
14. `interleave: two concurrent grades — one wins, the other is 409, history stays consecutive`
15. `finalize: recomputes the total from an in-transaction read and finalizes once`
16. `finalize: a revision committed before the transaction re-read is included in the total`
17. `finalize: a revision committed between the re-read and the CAS yields 409, never a stale total`
18. `finalize: an ungraded manual answer is refused (409) after the in-transaction re-read`
19. `finalize: a finalize committed by another actor before the re-read is 409 with no double audit`
20. `audit failure rolls the answer grade and the finalize fully back`

The acceptance tests for this new module were written together with the code
(not failing-first against a pre-existing defect); the two failures above were
fixture defects in those acceptance tests, and the fixes are stated honestly.

Provisional typecheck after this continuation:

`node node_modules/typescript/bin/tsc --noEmit -p server/tsconfig.json` — **0
errors** (before: 2 errors at `server/src/routes/exam-manual-grading.ts:471`).
Typecheck remains provisional because other writers have uncommitted edits.

## Stop confirmation

All writing for C1a and C1a-fix is complete. No further files will be created or
modified by this task. Writing has stopped.
