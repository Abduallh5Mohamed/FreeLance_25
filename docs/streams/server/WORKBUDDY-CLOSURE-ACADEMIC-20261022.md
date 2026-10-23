# WorkBuddy — academic lane closure (C1-R / C2-R / C3-R)

Task: `server-closure-academic-20261022-01` · worker `wb-closure-academic-20261022-01` · team `backend`
Repo `C:/Users/abdua/OneDrive/سطح المكتب/FreeLance_25-1` · branch `codex/workbuddy-server` · HEAD `cab9120`
Scope: the 38 `allowedPaths` of group `academic` only. No file outside them was written.

Status legend: **implemented** = source written and wired · **verified** = typecheck + the named
focused hermetic suites pass · **untested** = no automated test exercises this exact path (rule:
no new tests for existing modules) · **live-unproven** = no DB/provider was touched ·
**policy-held** = blocked on a product decision, not guessed.

---

## 0. Inherited state, preserved

Before any write, all 38 owned paths were hashed against
`C:/Users/abdua/WorkBuddySupervisorBridge/handoff/WORKBUDDY-THREE-LANE-BASELINE-20261022.md`.
**All 37 present files matched byte-for-byte** (23 sources + 14 tests); the report path was
`ABSENT` as recorded. Nothing inherited was rewritten, reset, cleaned, stashed or pulled.

The finished W4 upload/storage work (`routes/assignments.ts` upload lifecycle,
`services/assignment-storage.ts`, `services/assignment-scan-worker.ts` and their tests) was read and
left intact. This task's only edit inside `routes/assignments.ts` is **additive** (new authority
helper, one new endpoint, `created_by` added to the assignment projection); the storage/scan code
paths, their SQL, their exact-version cleanup and their audit calls are unchanged.

Writer registry used (one writer per file, no overlap with the media/notification lanes):

| # | file | item |
|---|---|---|
| 1 | `server/src/services/gradebook.ts` | 2 |
| 2 | `server/src/routes/gradebook.ts` | 2 |
| 3 | `server/src/routes/assignments.ts` | 1, 2 |
| 4 | `server/src/services/exam-manual-grading.ts` | 3 |
| 5 | `server/src/services/exam-manual-grading-sql.ts` | 3 |
| 6 | `server/src/routes/exam-manual-grading.ts` | 3 |
| 7 | `server/src/services/schedules.ts` | 4 |
| 8 | `server/src/routes/schedules.ts` | 4 |

---

## 1. Assignment grading ↔ gradebook (C2-R, part 1)

**Implemented.** New endpoint `POST /assignments/:id/submissions/:submissionId/grade`
(`server/src/routes/assignments.ts`, handler after `POST …/revoke`).

- **Assigned-teacher authority** — `authorizeAssignmentGrading()` (assignments.ts, above
  `SUBMISSION_COLUMNS`). Grading is stricter than row visibility: allowed only for the tenant owner,
  the assignment's author (`assignments.created_by`), the instructor of `assignments.group_id`, the
  instructor of `assignments.course_id` or of a group mapped to that course, or a caller with a
  verified branch membership when `branch_scope='branch'`. A tenant-wide instructor membership alone
  is **not** authority (the inherited `buildStaffVisibility` would have allowed it, so it is
  deliberately not used here).
- **Intended student proven server-side** — the submission row is loaded by
  `(id, assignment_id, tenant_id)`; its `student_enrollment_id` is resolved to a `students` row in
  the same tenant, and the handler requires `students.user_id = assignment_submissions.student_user_id`,
  `enrollmentMatchesAssignment(...)` for the assignment audience, and membership of the assignment's
  course (`enrollmentInCourse()`, group course or active `student_courses`). No name, phone or
  client-supplied student id is matched anywhere.
- **Gradeable state** — only a verified, clean submission: `status<>'revoked'`,
  `file_size_bytes>0`, `scan_status='clean'`. A revoked row, an unfinished upload and a quarantined
  scan are refused with 409 and write nothing (a grade can never exist for bytes nobody verified).
- **Course scope** — an assignment with `course_id IS NULL` (tenant/branch-wide) is refused with 409
  `assignment_not_course_scoped`: `gradebook_scores.course_id` is `NOT NULL`, and inventing a course
  would be a fabricated link.
- **Write** — one `gradebook_scores` row with `item_type='assignment'`, `item_id=<assignment id>`,
  inside the route's existing `runAtomic` seam, with `recordAudit` on the same transaction
  (`assignment.submission.grade` / `assignment.submission.grade.correct`). The audit payload carries
  ids, course, score and max score only — no student identity.

**Verified.** `tsc --noEmit` exit 0. `tests/m4-assignments.test.ts` 43/43 pass (the inherited upload,
finalize, revoke, cancel and scan paths are unaffected).
**Untested.** No automated test exercises the new endpoint (adding one would mean adding tests for an
existing module, which this task forbids). **Live-unproven.** No DB was touched.

---

## 2. Idempotent grade writes (C2-R, part 2)

**Implemented.** Idempotency without a schema change, via a deterministic primary key.

- `server/src/services/gradebook.ts`: `deterministicScoreId()` builds a name-based UUID (SHA-256 over
  `tenant|enrollment|course|itemType|itemId`, RFC 4122 v5 shape). Same source item + same student +
  same course ⇒ same `gradebook_scores.id`, so a repeat collides on the existing PRIMARY KEY instead
  of appending. Different tenant/student/course/item ⇒ different id (no cross-tenant collision).
  `validateLinkedGradeInput()` bounds `score`/`max_score` (finite, `0 ≤ score ≤ max_score ≤ 1e9`) so a
  correction can never store a value the calculator would silently drop.
  `LINKED_SCORE_ITEM_TYPES = ['assignment','exam']` — only source-owned items are de-duplicated; a
  free `manual`/`lesson` entry keeps the historical append behaviour (two manual scores are
  legitimately two rows).
- `server/src/routes/gradebook.ts` (`POST /scores`): for a linked item the handler now locks the row
  (`SELECT … FOR UPDATE`), and
  - identical values ⇒ **no write at all**, `200 {id, idempotent:true}`;
  - different values ⇒ **correction of the same row**, `201 {id, corrected:true}`, audited
    `gradebook.score.correct` with `oldValue` = previous score/max/weight;
  - absent ⇒ insert, audited `gradebook.score.create` (unchanged action);
  - a concurrent first write that loses the PK race (`ER_DUP_ENTRY`) is answered as a replay, not 500.
- `server/src/routes/assignments.ts` (item 1's endpoint) applies the same three outcomes and returns
  `idempotent` / `corrected` flags.

**Verified.** `tsc` exit 0; `tests/m4-gradebook.test.ts` 34/34 pass; `tests/m4-assignments.test.ts`
43/43 pass.
**Untested / live-unproven.** The replay and correction branches have no automated test and no DB.

**Policy-held — grade void and durable revision history.**
Overwriting the single row keeps the *previous* value only in the audit record
(`gradebook.score.correct`), which is a history but not a queryable revision series. A real
void/revision model needs columns that do not exist. Exact request (owner: Claude, schema source):

```sql
ALTER TABLE gradebook_scores
  ADD COLUMN status ENUM('active','void') NOT NULL DEFAULT 'active',
  ADD COLUMN revision INT NOT NULL DEFAULT 1,
  ADD COLUMN voided_at TIMESTAMP NULL,
  ADD COLUMN voided_by CHAR(36) NULL,
  ADD COLUMN void_reason VARCHAR(255) NULL,
  ADD UNIQUE KEY uq_gradebook_linked (tenant_id, student_enrollment_id, course_id, item_type, item_id);

CREATE TABLE gradebook_score_revisions (
  id CHAR(36) NOT NULL,
  tenant_id CHAR(36) NOT NULL,
  score_id CHAR(36) NOT NULL,
  revision INT NOT NULL,
  action ENUM('create','correct','void') NOT NULL,
  score DECIMAL(12,4) NULL,
  max_score DECIMAL(12,4) NULL,
  weight DECIMAL(8,4) NULL,
  actor_user_id CHAR(36) NULL,
  reason VARCHAR(255) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_gradebook_revision (score_id, revision),
  KEY idx_gradebook_revision_tenant (tenant_id, score_id),
  CONSTRAINT fk_gradebook_revision_score FOREIGN KEY (score_id) REFERENCES gradebook_scores(id),
  CONSTRAINT fk_gradebook_revision_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

Why: `uq_gradebook_linked` makes idempotency a DB invariant instead of an application convention;
`status`/`revision` make a void expressible without deleting a grade (deleting would destroy history
and contradict the no-destructive-cleanup rule); `gradebook_score_revisions` makes the correction
series queryable rather than audit-only. Until then, void is **not** implemented — it is not faked by
writing a zero score or by deleting the row.

---

## 3. Exam results → gradebook (C1-R)

**Implemented.** The finalize transaction now projects the sealed result into the course gradebook on
the **same** connection.

- `server/src/services/exam-manual-grading.ts`: optional capability
  `ManualGradingStore.recordGradebookScore?(input)`, `ExamGradebookProjectionInput/Result`, and
  `PendingManualAttemptRow.total_points` (the pinned total the projection needs). Optional means every
  existing fake store still compiles and behaves exactly as before.
- `server/src/services/exam-manual-grading-sql.ts`: `v.total_points` added to `ATTEMPT_COLUMNS`
  (additive projection); `recordGradebookScore()` resolves the course from
  `exams e INNER JOIN courses c … c.tenant_id=?`, **re-proves** the enrollment belongs to that course,
  validates `0 ≤ score ≤ total_points`, and upserts one `gradebook_scores` row
  (`item_type='exam'`, `item_id=<exam id>`, deterministic id). Skips are explicit and non-destructive
  (`not_course_scoped`, `student_not_in_course`, `invalid_score`); a real write failure throws, which
  rolls the finalize back.
- `server/src/routes/exam-manual-grading.ts`: called after a successful `finalizeAttempt` and before
  the audit, inside the same `deps.transaction`, and the finalize audit row records
  `gradebook_linked: true|false`. No API response field was added.

**Guards preserved, not weakened.** The answer-revision CAS (`status` + `version`), the finalize CAS,
the in-transaction re-read, the "no revision after finalize" rejection, the single audit writer and
the rollback-on-audit-failure behaviour are untouched. The gradebook write is strictly *after* a
successful CAS, so it can never precede or bypass sealing.

**Verified.** `tsc` exit 0; `tests/exam-manual-grading-sql.test.ts` 18/18;
`tests/m4-exam-manual-grading.test.ts` 20/20; `tests/m1-sprint-exam-boundary.test.ts` 26/26;
`tests/m4-exam-grading.test.ts` 38/38; `tests/m4-exam-snapshots.test.ts` 46/46.
**Untested / live-unproven.** The projection SQL and the skip branches run against no database.

**Policy-held (unchanged, not guessed).** draft/submitted/retake policy, results-release policy and
archived-question policy (inventory §7 `D3 الدرجات`) still gate *when a result may be shown or
re-attempted*. The gradebook projection is a storage link only; it does not publish a result to any
student surface.

`server/src/routes/exam-results.ts` was reviewed and **left unchanged**: it is a read-only legacy
projection over `exam_results` / `exam_attempts`, and the versioned C1a path (attempts →
`exam_versioned_attempts`) is the one that owns sealing. Wiring the legacy read route to the gradebook
would have created a second, unsanctioned result source.

---

## 4. Schedule series creation (C3-R)

**Implemented** in `server/src/routes/schedules.ts` + `server/src/services/schedules.ts`.

- **Idempotency** — `Idempotency-Key` header (or `idempotency_key` in the body), 8–200 chars of
  `[A-Za-z0-9._:-]`, normalized by `normalizeIdempotencyKey()`. The series id becomes
  `deterministicSeriesId({tenantId, userId, idempotencyKey})` (name-based UUID over tenant + author +
  key), so a retry resolves to the series the first attempt created. A replay returns **201 with the
  exact creation shape** (`id, status, audience, timezone, recurrence, sessions`), read back from
  `schedule_series` + `COUNT(*)` of its sessions; no second series and no second session batch is
  materialized. A concurrent retry that loses the PK race (`ER_DUP_ENTRY`) is answered as a replay,
  not a 500. Without a key the previous behaviour (fresh series per request) is unchanged.
- **Permissions** — a non-owner creating a **branch**-audience series now needs an active
  `branch_memberships` row for that branch inside the tenant (`branchMembership()`); the inherited
  check only proved the branch existed in the tenant. Group creation already required ownership of
  the group; that is unchanged.
- **Response shapes** — unchanged. The replay body is byte-identical in shape to the fresh 201; list
  feeds keep their bare arrays and the `X-Results-Truncated` header.
- **List limits / time validation** — reviewed and left as inherited (series 200, staff sessions 500,
  student feed 100, each `+1` probe with an explicit truncation header; `validateSeriesInput` bounds
  title/timezone/recurrence/`starts_on`/`ends_on`/`start_time`/`duration`; the DST spring-forward gap
  and a zero-occurrence expansion are refused before any write).

**Verified.** `tsc` exit 0; `tests/m5-schedules.test.ts` 58/58 pass. One regression was found and
fixed during the work: the first version read the header via `req.get()`, which the hermetic route
harness does not provide (500 on a legitimate create); it now reads `req.headers` and the suite is
green again — no test assertion was changed.
**Untested / live-unproven.** The replay path and the branch-membership refusal have no automated test
and no DB.

**Policy-held.** Who may author a *tenant-wide* series, and whether overlapping sessions for the same
group must be rejected, are open product decisions (`D3 الحضور`: «سلطة إنشاء السلاسل والتداخل»).
Tightening tenant-wide creation to the owner would have changed an accepted behaviour without a
decision, so it was not done. Automatic attendance and legacy/new attendance reconciliation remain
blocked on the attendance-source policy (W10) — no attendance file was touched.

---

## 5. What is blocked, named precisely

| item | blocked on | owner |
|---|---|---|
| grade void + queryable correction series | missing columns/table (§2 DDL request) | Claude (schema source) |
| draft/submitted/retake/results-release/archived-question policy (C1-R remainder) | product decision, `D3 الدرجات` | owner / Claude |
| who may author tenant-wide series; session overlap policy (C3-R remainder) | product decision, `D3 الحضور` | owner |
| automatic attendance + legacy/new reconciliation | attendance-source policy + W10 | owner / media lane |
| sealed audit-chain coverage for these new writes | `recordSealedAuditEvent` chain ownership is Codex; this lane preserved the inherited `recordAudit` transaction guarantee instead of forking the audit path | Codex |

---

## 6. Commands actually run

```
git status --porcelain ; git rev-parse --short HEAD ; git rev-parse --abbrev-ref HEAD
sha256sum/stat -c%s on all 38 owned paths   # baseline comparison, before any write
node node_modules/typescript/bin/tsc --noEmit -p server/tsconfig.json      # exit 0 (repeated after each item)
cd server && M1_NETWORK_MODE=hermetic node --require ../scripts/m1-network-guard.cjs --import tsx --test tests/m4-gradebook.test.ts              # 34/34
cd server && M1_NETWORK_MODE=hermetic node --require ../scripts/m1-network-guard.cjs --import tsx --test tests/m4-assignments.test.ts           # 43/43
cd server && M1_NETWORK_MODE=hermetic node --require ../scripts/m1-network-guard.cjs --import tsx --test tests/exam-manual-grading-sql.test.ts   # 18/18
cd server && M1_NETWORK_MODE=hermetic node --require ../scripts/m1-network-guard.cjs --import tsx --test tests/m4-exam-manual-grading.test.ts    # 20/20
cd server && M1_NETWORK_MODE=hermetic node --require ../scripts/m1-network-guard.cjs --import tsx --test tests/m1-sprint-exam-boundary.test.ts   # 26/26
cd server && M1_NETWORK_MODE=hermetic node --require ../scripts/m1-network-guard.cjs --import tsx --test tests/m4-exam-grading.test.ts           # 38/38
cd server && M1_NETWORK_MODE=hermetic node --require ../scripts/m1-network-guard.cjs --import tsx --test tests/m4-exam-snapshots.test.ts         # 46/46
cd server && M1_NETWORK_MODE=hermetic node --require ../scripts/m1-network-guard.cjs --import tsx --test tests/m5-schedules.test.ts              # 58/58
git diff --stat -- server/src ; git diff -- <each touched file>   # self-review of every hunk
```

No full-suite run, no DB, no Docker, no service, no listener, no migration, no provider, no Git
mutation, no new file outside `allowedPaths`.

---

## 7. File hashes — before → after (every file touched)

| file | before sha256 | before bytes | after sha256 | after bytes |
|---|---|---:|---|---:|
| `server/src/routes/assignments.ts` | `33668d50dc997e74d1fba89f3678a0c324decea3f0ecbd29e722e17208c239c4` | 88693 | `72e13d9edd6c4e0e6af2dcf9ffaf0fd35d8c773781577d9f30196cf20d79cfd2` | 102742 |
| `server/src/routes/exam-manual-grading.ts` | `124ea29f88f63c15fe9bb3b42e2ed246fd93aa9b0583ae5d45fccdb1e80b4cb0` | 23410 | `8211b9e291b1372a1e52cc0f17ff65ba8a82789d029ade403af886188cba3821` | 24888 |
| `server/src/routes/gradebook.ts` | `2a02657fffe86edec6a25ba0fed39298039221dbde7840d6a22994173481055a` | 26525 | `b063373dca15b4a89387a1945424e92cb93867b215451efa97db84754cd90ea8` | 31520 |
| `server/src/routes/schedules.ts` | `3662c4e2a11cefe2c8fbebca23df7af6937529d928c768f046422f73604748b1` | 31594 | `df8603f2409cce0c7e7012024e20204d9f57088ee5deb28f375140d9b6df5805` | 36472 |
| `server/src/services/exam-manual-grading-sql.ts` | `40fcb39c63a885854a717c28bbf14aa5f749ebee66f17b94bfba4def15510a63` | 25714 | `db4ebc7540d4c876c637972733060a7dde0c083926a1039d5ba337f8ba77e5e8` | 31162 |
| `server/src/services/exam-manual-grading.ts` | `4e63d65d0d7ee5f0a17dcf177852a70c325c0f7d2d697e03c1561fd57a12158e` | 18946 | `172abfbbf2e1cdce7bd255c38dffde3ca795255b4e678ea5fd14afad5f82f82d` | 21003 |
| `server/src/services/gradebook.ts` | `55d410d2eb8a3cfa7621ec3195eef5af42791302e2471523e6604b330e9982ad` | 15570 | `909450c76ea71fad2a928a2d3cd24bc2420cd5428fc010e1267ddb1e2a4b0924` | 20778 |
| `server/src/services/schedules.ts` | `cac07600ad83a27e246dc8fc211e84d675c4d1a2a36c58bfc1cce2f0c572897d` | 26755 | `e1c8f0c7829ac54d1d916062a9111421d0cb326d46d09b467a82e754a7b918cf` | 29196 |

Untouched and still byte-identical to the baseline: the other 15 sources and all 14 test files
(`assignment-storage.ts`, `assignment-scan-worker.ts`, `services/assignments.ts`,
`attendance*.ts`, `exam-grading.ts`, `exam-snapshots.ts`, `question-bank.ts`, `manual-grading.ts`,
`exam-versions.ts`, `exam-results.ts` and every `server/tests/*` in the group).

Attribution: **all eight changes above are this session's own work**. No inherited line was deleted
except inside the `POST /schedules/series` handler body, where the insert block was re-indented into a
`try` (same statements, same parameters, plus `idempotent` in the audit payload) and the
`POST /gradebook/scores` handler, where `const id = randomUUID()` became the deterministic-id
selection. Every other hunk is an addition.

---

## 8. Honest limit statement

Implemented and wired: four items, eight files. Verified by typecheck and eight focused hermetic
suites (283 assertions across them, all green, no assertion modified). Not proven: none of the new
paths has a dedicated automated test, and none has run against a real MySQL instance, a real
scanner or a real provider. Grade void and the durable correction series are held on a schema
decision; three product policies remain held and are named above rather than guessed. No claim of
100% closure is made.

---

## 9. Correction pass — authority and idempotency replay (2026-10-22)

Task: `server-closure-academic-authority-idempotency-correction-20261022-01` · worker
`wb-academic-authority-idempotency-correction-20261022-01` · team `backend`.
This is a correction of **two named defects** found by source review in the delivery documented in
§1–§8. It is not a new feature pass and it is not acceptance of that report. Sections §0–§8 are
retained unchanged; only `server/src/routes/assignments.ts`, `server/src/routes/schedules.ts` and
this document were written. Everything else the previous worker delivered (the grade endpoint,
deterministic `gradebook_scores.id`, the optional `recordGradebookScore` projection on the exam
finalize transaction, schedule-series `Idempotency-Key` support) was preserved as inherited.

Baseline for this pass:
`C:/Users/abdua/WorkBuddySupervisorBridge/handoff/WORKBUDDY-ACADEMIC-CORRECTION-BASELINE-20261022.md`
(captured 2026-10-21T23:25:41Z). Both source files matched that baseline byte-for-byte before this
pass. No `git reset`, `clean`, `stash` or `pull` was run; no test file was edited.

### 9.1 Defect 1 — grading authority (confirmed, fixed)

**What was wrong.** `authorizeAssignmentGrading` (`server/src/routes/assignments.ts:426`) granted
grading rights to any caller with a **verified branch membership** whenever the assignment was
`branch_scope='branch'`:

```ts
if (assignment.branch_scope === 'branch' && assignment.branch_id) {
    if (await authorizeBranch(scope, assignment.branch_id)) return true;   // removed
}
```

Membership is a placement in an org unit; it is not an assignment to a cohort's work. A branch
member who is not the assigned teacher could put a grade on any branch-scoped assignment.

A second, narrower hole sat in the same predicate: for **any** assignment with a `course_id`, a
caller who instructed *any* group mapped to that course was granted grading rights. For a
**group-scoped** assignment that let the teacher of group B grade group A's assignment because both
groups happen to sit in the same course (and, via the removed branch branch, the same branch).

**What changed.**

1. `server/src/routes/assignments.ts:426` `authorizeAssignmentGrading` — the branch-membership
   grant is **deleted**. The predicate now returns true only for:
   - the tenant owner (`scope.isOwner`),
   - the assignment's author (`assignments.created_by === scope.userId` — the only explicit
     per-assignment control that exists in the schema; there is no `assignment_teachers` table,
     verified by search),
   - the instructor of `assignments.group_id` (tenant-checked),
   - the instructor of `assignments.course_id` (tenant-checked, course owner).
2. `server/src/routes/assignments.ts:429` — `const groupScoped = assignment.group_id !== null;`.
   The course-level widening ("instructor of a group in this course", line 446–453) is now applied
   **only when `!groupScoped`**. A group-scoped assignment therefore accepts no peer-group teacher
   from the same course or branch. Course-wide assignments keep that widening: a teacher of a group
   in the course is a legitimate grader of a course-wide task.
3. `server/src/routes/assignments.ts:1637–1643` (inside `POST /:id/submissions/:submissionId/grade`,
   handler at line 1571) — the exact **assignment/student pair** is re-proven:
   `if (assignment.group_id !== null && enrollment.group_id !== assignment.group_id) → 403`. This
   matters because `enrollmentMatchesAssignment` checks the *branch* first for a `branch_scope='branch'`
   row, so a peer group inside the same branch would otherwise satisfy the audience test. The pair
   check closes that without touching the shared audience helper (which is used by the student
   submission routes and must not change semantics here).

**Why the authority rule is correct (truth table, not a test).** For a non-owner caller, grading is
allowed iff `created_by = caller` ∨ `group.instructor_id = caller for assignment.group_id` ∨
`course.instructor_id = caller for assignment.course_id` ∨ (`assignment.group_id IS NULL` ∧
∃ group in `assignment.course_id` with `instructor_id = caller`). Every clause names the exact
target row (assignment → its group, its course, its author) and every clause is tenant-scoped.
No clause accepts a role label, a tenant membership, a branch membership or a client-supplied id.
A teacher of another group fails all five clauses for a group-scoped assignment, which is the
required outcome; the group's own teacher and the course owner still pass, which is the required
preservation.

**Status: implemented · untested.** No test was added (this task has no test mandate) and the new
`groupScoped` refusal plus the exact-pair 403 are not exercised by any existing assertion.
`tests/m4-assignments.test.ts` remains 43/43 (it does not cover the grade endpoint), which proves
only that the shared file still compiles and the inherited upload/finalize/revoke/cancel/scan paths
are untouched. **Live-unproven** — no DB.

### 9.2 Defect 2 — idempotency replay without payload matching (confirmed, fixed)

**What was wrong.** `loadSeriesReplay` (`server/src/routes/schedules.ts`) derived the series id from
`(tenant, actor, Idempotency-Key)` and returned the stored creation body with **no comparison to
the incoming request**. A caller that reused a key with a different title, group, time, timezone or
recurrence received `201` describing the *old* series — a false success for a request that was
never applied. The duplicate-key race path had the same defect: the request that lost the unique-key
race answered `201` with the winner's row regardless of payload.

**What changed** (`server/src/routes/schedules.ts`):

- `:154` `SeriesReplayRow` — the persisted input projected for comparison; `:171`
  `SeriesReplayOutcome` = `absent | conflict | match`.
- `:275` `loadSeriesReplayRow` — selects the **canonical validated persisted input**: `title,
  audience, timezone, recurrence, branch_id, group_id, weekdays, day_of_month, starts_on, ends_on,
  start_time, duration_minutes`, with `CAST(… AS CHAR)` on the id/date/time columns so driver type
  mapping cannot make two identical payloads compare unequal.
- `:293` `seriesReplayMatches` — field-by-field comparison against `ValidatedSeries` (the same
  object `validateSeriesInput` produced and the INSERT wrote): trimmed title, audience, nullable
  branch/group, timezone, recurrence, `weekdays` as a sorted integer set (`normalizeWeekdayCsv`),
  `day_of_month` as integer/null, `starts_on`/`ends_on` as `YYYY-MM-DD`, `start_time` as `HH:MM`
  (`TIME` arrives as `HH:MM:SS`), `duration_minutes` as a number. Weekly and monthly are both
  covered: monthly stores an empty weekday CSV and `day_of_month`, weekly stores the day set and
  `NULL` day-of-month.
- `:315` `loadSeriesReplay(tenantId, seriesId, value)` — returns `absent` (no row → proceed to
  insert), `conflict` (row exists, payload differs), or `match` (row exists, payload identical →
  replay body built from the stored row + session count). `:341` `sendIdempotencyConflict` answers
  `409 { code: 'idempotency_key_reused' }`.
- `:477` pre-insert check — `conflict` → 409, `match` → 201 replay, `absent` → insert.
- `:535` duplicate-key race path — on `ER_DUP_ENTRY` the losing request **re-reads the row and
  re-compares**; identical → 201 replay, different → 409. It can no longer answer success for a
  payload the stored series does not hold. A re-read that finds no row re-throws, so an unrelated
  duplicate is never disguised as a replay.

Nothing else in the handler changed: the deterministic series id, the `INSERT` column list and
parameters, `INSERT IGNORE` on sessions, the audit payload, the post-commit notification and the
response shape of a fresh 201 are the inherited behaviour. No schema change was made; no
fingerprint column was invented, so the comparison reads the real persisted values.

**Status: implemented · untested.** No test was added for the 409 path or the race path (no test
mandate). `tests/m5-schedules.test.ts` remains 58/58, which proves the create path, the list shapes
and the branch-membership refusal still behave and that the new read is type-correct, but it does
**not** assert a same-key/different-payload conflict. **Live-unproven** — no DB, so the duplicate-key
race was reasoned from the code path, not executed.

### 9.3 Boundaries held

- Only the three files above were written; no new file, no test file, no schema/migration.
- Not guessed: overlap policy, tenant-wide authoring policy, result-release policy, and any
  assignment-level co-teacher model (none exists in the schema).
- Not run: full suite, DB, Docker, service, listener, migration, provider, Git mutation.
- The 132 + 365 inherited test totals were not re-run in full; only the two suites for the touched
  files were executed, per the task rules.

### 9.4 File hashes — before → after (this correction pass only)

| file | before sha256 | before bytes | after sha256 | after bytes |
|---|---|---:|---|---:|
| `server/src/routes/assignments.ts` | `72e13d9edd6c4e0e6af2dcf9ffaf0fd35d8c773781577d9f30196cf20d79cfd2` | 102742 | `ae3786f32c03461b3ec8aa9e62a6469d42bc4c4befb155265e717cf07086c082` | 103625 |
| `server/src/routes/schedules.ts` | `df8603f2409cce0c7e7012024e20204d9f57088ee5deb28f375140d9b6df5805` | 36472 | `710f201e5ac557df8d7f639f7e3b0ff78f742e2435394c5d5c5edf3308711a8b` | 41020 |
| `docs/streams/server/WORKBUDDY-CLOSURE-ACADEMIC-20261022.md` | `e18a74baf123df91c172d722f457ef01e5dc82f030dd51a278efe5305f23729f` | 19581 | recorded in §9.5 / report evidence | — |

A file cannot carry its own final hash without changing it, so the document's post-edit sha256 and
byte size are stated in §9.5 below and in the supervisor report evidence, measured after the last
write to it.

### 9.5 Verification actually run in this pass

```
node node_modules/typescript/bin/tsc --noEmit -p server/tsconfig.json      # exit 0
cd server && M1_NETWORK_MODE=hermetic node --require ../scripts/m1-network-guard.cjs --import tsx --test tests/m4-assignments.test.ts   # 43/43
cd server && M1_NETWORK_MODE=hermetic node --require ../scripts/m1-network-guard.cjs --import tsx --test tests/m5-schedules.test.ts     # 58/58
git diff -- server/src/routes/assignments.ts server/src/routes/schedules.ts   # hunk self-review
```

No assertion was modified, no test file was touched, and no new test was written. Honest limit:
both defects are fixed in source and typecheck-clean, but neither new branch is covered by an
automated test and neither has been exercised against a real database.

This document's own post-edit sha256 and byte size were measured after the final write and are
carried in the supervisor report evidence for this task (embedding them here would change the file
again).

