# C4a — Progress report publication (M4 A7/P2), correction 2

Date: 2026-10-21. Owner: Claude (OpenCode lane C4). This is the second source-level
correction of C4a on the same three files plus this report. Governing document for
this pass: `docs/streams/server/C4-AUTHORITY-PROJECTION-CORRECTION-20261021.md`
(read in full). Also read: `docs/streams/server/CLOSURE-BATCH1-SCOPE-REVIEW-20261020.md`
(governs when it differs), `docs/streams/server/OPENCODE-C1-C8-ALLOCATION-20261020.md`,
`docs/streams/server/SERVER-CLOSURE-INVENTORY-20261020.md`,
`docs/17-full-feature-backlog.md`, `docs/19-commercial-registration-wallet-agreement-ar.md`.

This is a delivery report, not acceptance and not a claim that production SQL
works. The router factory remains **not mounted**. No `index.ts`, auth, `db.ts`,
helper, migration, manifest, frontend, bridge or parent-view file was touched.

## 1. What was still wrong after the first correction

Codex review of 2026-10-21 found two remaining defects in the C4 code itself:

1. **Branch membership was an assignment.** In
   `server/src/routes/progress-reports.ts`, `mayActOnEnrollment` returned
   `exact` when the student's group branch equalled the actor's verified branch
   and `branch_scope='branch'`; `readableScope` appended
   `OR (g.branch_id=? AND g.branch_scope='branch')`; and `canAccessCourse`
   granted `ok` through `courseHasGroupInBranch`. Any verified member of a
   branch could therefore read/export/publish every teacher's groups and
   students in that branch, not only their own assignments.
2. **`parentProjection` had a scalar success bypass.** In
   `server/src/services/progress-publication.ts` the line
   `if (state === 'published') return projectProgressForParent(...)` ran before
   the identity comparison, and a test called
   `parentProjection(record(), 'published')` with no identity and expected data.

Both findings were valid. The first correction's fake-authority tests could not
detect (1) because the production SQL factory was never instantiated. No
assertion was weakened to fix either defect.

## 2. Correction 1 — branch is a constraint, never an assignment

`server/src/routes/progress-reports.ts` (`createSqlCourseAuthority`):

- Removed the membership-only branch grant from all three places:
  - `mayActOnEnrollment` no longer returns `exact` for a matching group branch;
  - `readableScope` no longer appends the `OR (g.branch_id=?)` branch grant;
  - `canAccessCourse` no longer grants through `courseHasGroupInBranch`
    (that helper was deleted).
- Branch is still **verified** through `security/branch-access` and is still
  returned as `ReadableReportScope.branchId`. It now only **narrows** what an
  already-authorized actor can read: the route filters every source row by that
  branch. It never adds a course, group or enrollment.
- Positive relations kept exactly as before, with the course/enrollment link
  check still ahead of them:
  - tenant owner (same tenant only);
  - `courses.instructor_id === actor`;
  - the student's direct `students.instructor_id === actor`;
  - `groups.instructor_id === actor` for the student's own group;
  - the enrollment must be linked to the requested course through
    `group.course_id` or an active `student_courses` row; otherwise it is
    `none`.
- Ambiguity still denies: `mayActOnEnrollment` returns `none`/`unknown` only,
  and callers treat anything other than `exact` as a denial.
- The enrollment query no longer reads `groups.branch_id`/`groups.branch_scope`,
  removing an assumption the authority no longer needs.

The router did not need a change for this correction: it already re-checks every
row with `mayActOnEnrollment` before projection/export and before publish.

## 3. Correction 2 — no scalar publication bypass

`server/src/services/progress-publication.ts`:

- `parentProjection` now accepts only `PublicationRecord | null`; the
  `PublicationState` string overload is gone at the type level.
- A runtime guard (`typeof state !== 'object'`) rejects a bare `'published'` or
  `'draft'` string for untyped/JS callers.
- A record projects only when **all** of the following hold:
  - `state.state === 'published'`;
  - an explicit `ProgressReportIdentity` is supplied;
  - publication `tenantId`, `studentEnrollmentId`, `courseId` match the identity;
  - the report record's `studentEnrollmentId` and `courseId` match the identity.
- Missing identity, scalar marker, draft row, forged identity, mismatched
  publication row or mismatched report record all return `null`.
- The mandatory transaction seam, version guard, idempotency and real-callback
  rollback behaviour were left intact.

## 4. Files changed (only the allowed files)

| File | before sha256 | after sha256 |
|---|---|---|
| `server/src/routes/progress-reports.ts` | `0d66ffe85cf4e61a225a06db3985a8f6942084d303a71b996ddec337ad9a49b0` | `f86a735849f2f1eeaefd8a864db1cc00e1bb708f4ca2e2e5340c702c90da3074` |
| `server/src/services/progress-publication.ts` | `335805b46cd5c97b89b58928c440eac4734007d3bde7b2dfc3b875fae7a9ed72` | `ef07eeaab6d11760ade56d8d51c6c7db25c475fdd5610668f337a67ac6b96af6` |
| `server/tests/m4-progress-reports.test.ts` | `76c9fea5b0f2fe935ebbe775fdbef6430c789a776e7d7cad326be281ef36a7b4` | `15744558e0c5a6d42eee752b2b7a842ba0e641a4d2d73123a6d102a47dd94ce7` |

This report cannot contain its own sha256; its pre-update hash was
`7c3b8fa8f7e75fb20be09f877bcb0f5db6b9955854f46a422efec9a18bb68f29`. No other
file was written by this pass.

## 5. Acceptance tests — 39/39 pass

Command:

```text
node node_modules/tsx/dist/cli.mjs --test --test-force-exit server/tests/m4-progress-reports.test.ts
```

Result after the correction: `tests 39`, `pass 39`, `fail 0`. Before the source
fix the same file was run red: `pass 33`, `fail 6` (tests 12 and 22–25 and 27
below). That was the intended failing evidence for both defects.

| # | Test | Result |
|---|---|---|
| 1 | anonymous requests are denied before any store or source call | pass |
| 2 | a student cannot reach the teacher list | pass |
| 3 | a teacher of another course is denied and performs no write | pass |
| 4 | a cross-tenant course is a 404 | pass |
| 5 | a foreign enrollment yields 404 before any write | pass |
| 6 | publish is idempotent: the second publish writes nothing and bumps no version | pass |
| 7 | a version race returns 409 with no write and no audit | pass |
| 8 | unpublish is idempotent and returns the parent projection to null | pass |
| 9 | publish/unpublish cycles bump the version monotonically | pass |
| 10 | published projection contains exactly the explicit field list and no internal ids | pass |
| 11 | draft data never leaks through the parent projection (serialized object) | pass |
| 12 | a publication row for another report key can never unlock the projection | pass |
| 13 | a student sees only their own report | pass |
| 14 | two teachers in the same branch and course cannot see each other's groups | pass |
| 15 | removing the course selector does not widen a teacher to the whole tenant | pass |
| 16 | two branches are isolated even on the same course | pass |
| 17 | a forged course selector is denied | pass |
| 18 | a forged branch selector is denied | pass |
| 19 | a teacher cannot publish another teacher's student in the same branch | pass |
| 20 | a teacher cannot unpublish another teacher's published student | pass |
| 21 | the owner is positive across the tenant but never cross-tenant | pass |
| 22 | SQL authority: teacherA cannot list teacherB's student in the same branch, with or without selectors | pass |
| 23 | SQL authority: teacherA cannot export teacherB's student | pass |
| 24 | SQL authority: branch membership alone grants no rows and no publish | pass |
| 25 | SQL authority: teacherA cannot publish or unpublish teacherB's student without a write or success audit | pass |
| 26 | SQL authority: the owner and the explicitly assigned teachers remain positive | pass |
| 27 | SQL authority: recorded SQL text contains no membership-only branch grant | pass |
| 28 | the CSV export carries only rows the teacher may act on | pass |
| 29 | a forged export course is denied and sends no CSV | pass |
| 30 | the CSV export is audited, neutralized and capped | pass |
| 31 | an export audit failure returns 500 and sends no CSV | pass |
| 32 | an audit failure rolls the state change back (real callback execution) | pass |
| 33 | a store failure after the write leaves no audit row and rolls back | pass |
| 34 | an incomplete configuration is rejected before any write | pass |
| 35 | a store failure surfaces as a generic 500 without leaking details | pass |
| 36 | normalizeId accepts a well-formed id and rejects a malformed one | pass |
| 37 | filterReportsByBranch narrows only when a branch scope is supplied | pass |
| 38 | buildProgressReport and toCsv keep their existing contracts | pass |
| 39 | the service factory is usable directly with an injected store and transaction | pass |

The new SQL-authority tests instantiate the **real** `createSqlCourseAuthority`
over a recording `query`/`queryOne` seam that logs every SQL text + binding and
answers from in-memory tables (`courses`, `groups`, `students`,
`student_courses`, `branches`, `branch_memberships`) with real relation
semantics. The same harness uses the **real** `createProgressReportsRouter`.
Fixture: one tenant, one branch, `course-1`; teacherA owns groupA/studentA,
teacherB owns groupB/studentB, both are active members of the branch; teacherC
has only branch membership. A second course (`course-2`) is taught by teacherB
in the same branch and linked to studentB through an active `student_courses`
row, so a forged course selector is exercised.

Test 27 inspects the recorded SQL text and asserts no `g.branch_id=?` grant and
no `OR (g.branch_id...)` membership grant is emitted, while branch membership is
still verified. Tests 22–25 cover omitted selectors, branch-only selectors, the
forged course, export, publish/unpublish, and assert zero store transitions and
zero success-audit rows on denial. Test 26 keeps owner and assigned-teacher
positives. The tests prove the factory's behaviour over the recording seam; they
do **not** prove MySQL accepts or returns what the seam returns.

Test 12 now exercises the narrowed `parentProjection`: matching
`PublicationRecord` + identity positive with the field allowlist retained;
negatives for scalar `'published'` (with and without identity), missing
identity, draft row, identity tenant/enrollment/course mismatch, record
enrollment/course mismatch, and publication tenant/enrollment/course mismatch.

## 6. Typecheck (provisional)

```text
node node_modules/typescript/bin/tsc --noEmit -p server/tsconfig.json
```

→ **0 errors** after the correction. This is provisional while other writers are
active. `server/tsconfig.json` includes `src/**/*` only, so the test file is
executed by `tsx`, not typechecked by this project command. No error in another
file was fixed here.

## 7. Schema assumptions handed to I2 (not created)

Publication state, unchanged: one table keyed by
`(tenant_id, student_enrollment_id, course_id)` with
`state ENUM('draft','published')`, `published_by`, `published_at`, `version`,
`created_at`, `updated_at`. Version-guarded transition:

```sql
UPDATE <published_state>
   SET state = ?, published_by = ?, published_at = ?, version = version + 1,
       updated_at = CURRENT_TIMESTAMP
 WHERE tenant_id = ? AND student_enrollment_id = ? AND course_id = ?
   AND version = ?;
-- affected_rows = 0 => lost race, no write
```

Authority read assumptions (MySQL columns used by the unmounted SQL adapter;
I2/domain owner must confirm them):

- `courses(id, tenant_id, instructor_id)`
- `groups(id, course_id, instructor_id)`
- `students(id, tenant_id, group_id, instructor_id)`
- `student_courses(student_id, course_id, status)`
- `branches(id, tenant_id, status, version)`
- `branch_memberships(branch_id, user_id, role, status, version)`

The authority no longer reads `groups.branch_id` or `groups.branch_scope`.
Branch context is the verified `branches`/`branch_memberships` pair; the row
source's `branchId` is used only to narrow projected/exported rows. An
enrollment is treated as course-related only through its group's course or an
active `student_courses` row. This is a **schema/authority assumption**, not a
product decision applied to live data. No DDL, migration or manifest was written
or applied.

## 8. Held / policy items (not decided here)

- Report cadence and any new published fields remain held
  (`docs/streams/server/CLOSURE-BATCH1-SCOPE-REVIEW-20261020.md:34`,
  `docs/17-full-feature-backlog.md:63,85`).
- Parent report delivery (P7) and parent provisioning/link liveness remain held;
  no notification/outbox/parent-link file was touched
  (`docs/17-full-feature-backlog.md:85`).
- The parent HTTP read route is out of scope; `parentProjection` is only a
  prepared function. Existing parent surfaces remain ungated:
  `server/src/routes/parent-views.ts:168` (`gradeSummary` response) with the SQL
  summary at `:236`, and `server/src/routes/gradebook.ts:389` (student
  `/progress` still returns only the gradebook grade). This task does not claim
  to close them.
- The canonical enrollment policy and any new capability were **not** invented
  or changed. The route consumes the injected authority verdict and fails closed
  on anything other than `exact`; the adapter's course-link rule remains an
  assumption for I2 (`server/src/routes/progress-reports.ts:241`).
- No decision was made about whether a verified branch should *always* narrow an
  explicit assignment in another branch. This pass only removed branch as a
  grant; it did not add a new branch-based denial policy. That question is held
  for the domain owner.

## 9. Limits — what the recording/injected seams do not prove

- The SQL texts were **not** run on MySQL. The recording seam matches the
  adapter's SQL text and answers from in-memory arrays; it does not prove the
  tables/columns exist, that MySQL accepts the SQL, that indexes/permissions are
  correct, or that MySQL returns the same rows.
- Supplying `PublicationStore`, `ProgressReportSource`, the recording DB or the
  fake authority in a test is **not** evidence that any SQL runs or that the I2
  schema works. No DB, Docker, network or provider was contacted.
- The version guard is only as strong as the store's conditional `UPDATE`; this
  task supplies no SQL store and no migration.
- The transaction fake proves the service/router call the injected seam and that
  rollback restores the in-memory state; it does not prove MySQL transactional
  behaviour.
- The router is not mounted and no default production wiring is exported, so
  nothing here is claimed reachable in production.
- Idempotency/race behaviour is verified against the in-memory contract only.

## 10. Self-report

- The correction tests were authored before the correction code and run red
  first (`pass 33`, `fail 6`); the same focused file passes 39/39 after the
  source fix. No assertion was weakened; the unsafe scalar-positive assertion
  was replaced with a stricter record+identity positive and additional
  negatives.
- No existing source file outside the three allowed files was edited. No
  `any`/`ts-ignore`; no unrelated cleanup; no dependency change; no git
  mutation; no DB/Docker/network/provider/install.
- Writing stopped after this report.
