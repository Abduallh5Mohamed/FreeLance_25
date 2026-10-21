# OC-T2 / T2c exam-versions corrections report — 2026-10-20

Owner: OpenCode lane (T2, corrected by T2c). Basis: `docs/streams/server/OPENCODE-EXECUTION-PLAN-20261020.md` §1 T2 with the mandatory scope corrections of `docs/streams/server/OPENCODE-SCOPE-CONFIRMATION-20261020.md` ("T2 exam versions") and `docs/streams/server/OPENCODE-REVIEW-CORRECTIONS-20261020.md` items 2 and 3.

This report supersedes the first-pass report. The first pass's staff attempts list is now removed; the approved authorization, regrade terminal-state/version-guard and branch-visibility-pin fixes remain.

## 1. Files changed (_sha256_ full)

BEFORE = state at the start of this T2c correction. The route/test values equal the first-pass AFTER state, not the original planning baseline.

| File | BEFORE | AFTER |
|---|---|---|
| `server/src/routes/exam-versions.ts` | `e507821d01a060ce3443bc1e3cbfa6733651e8aa419722d49db68a13f1e9c4c9` | `0af8294a43c1b863b330715d77f3d43ffed67e1355ce3e1794d511df1d424cd6` |
| `server/src/services/exam-snapshots.ts` | `ef55fb5e871c4ebbe57d16210ff52a925bc4bce8472ce255a4e944fe7d42b8d5` | `ef55fb5e871c4ebbe57d16210ff52a925bc4bce8472ce255a4e944fe7d42b8d5` (unchanged) |
| `server/tests/m4-exam-snapshots.test.ts` | `8feede235214926336d89565d7b1b9a7574c1274c7ae052dbda7ba66b146830d` | `49c27b0ac1220f5154a722d34dd4ac6f5f53a40e13da86632be11c2399c0659c` |
| `server/tests/m4-exam-grading.test.ts` | `c9356ac6ba37246bb22e7421d1f00d85f7dc5b1ad70c81322cfad57a65789973` | `29a4815fea7dddc0cee27894961523fbb20087fb6533bb56f6320fbe11cfa93e` |
| `docs/streams/server/OC-T2-EXAM-VERSIONS-20261020.md` | `f8ba98856a7be3d89597c0193a1c13b0ba2d694735b7a30c5c34d8a44c810cc2` | (this report; self-hash omitted) |

No other file was created, edited or deleted. No scratch files were left. Pre-existing uncommitted edits in `exam-versions.ts` were preserved; only the correction below was applied on top.

## 2. Part A — staff attempts list held and removed (no approved evidence)

### Evidence search (existing approved docs, not the execution plan)
- `docs/17-full-feature-backlog.md:60` A4 says "examiner only sees assigned tenant/student answers; rubric/revision/audit". It constrains who may grade but does **not** expressly require a staff attempts list or its audience.
- `docs/17-full-feature-backlog.md:63` A7 says "teacher filters tenant/branch" for progress/reports; it does not specify a per-version attempt list or its audience.
- No other approved backlog item expressly requires `GET /exams/:examId/versions/:versionId/attempts`; `docs/streams/server/OPENCODE-EXECUTION-PLAN-20261020.md` is explicitly not evidence.
- Therefore the list and its newly introduced expiry-on-read side effect were removed, and the audience question is held.

### Removed (only list-specific code/tests)
- `server/src/routes/exam-versions.ts`: the `GET /exams/:examId/versions/:versionId/attempts` registration and its per-student loop. `ATTEMPT_COLUMNS_QUALIFIED` remains because the pre-batch `runExamAttemptExpiryPass` still uses it (`server/src/routes/exam-versions.ts:1317`, `:1337`).
- `server/tests/m4-exam-snapshots.test.ts`: the two `staff attempts list:` tests and the list-only fixture plumbing (`attemptsList`, `simulateAttemptUpdates`, the `ORDER BY a.started_at ASC` responder branch).

### Preserved exactly
- `authorizeExamStaff` / `denyExamStaff` and their application to create, version list, version detail (answer key), publish, staff attempt read and regrade.
- Regrade terminal-state preservation plus the expected-state/version guard.
- Branch-visibility pin filter on version create.
- All pre-batch endpoints and pre-batch expiry-on-read behavior: staff/student `GET /attempts/:attemptId`, autosave and submit still call `expireDueAttempt` (`server/src/routes/exam-versions.ts:970`, `:1042`, `:1112`); the periodic sweep is untouched (`:1337`).

## 3. Part B — four regrade test failures reproduced and integrated

### Reproduction before the fixture repair
Command: `node node_modules/tsx/dist/cli.mjs --test server/tests/m4-exam-grading.test.ts`
Result: **34 pass / 4 fail**. All four failed with `404` instead of the expected `409`/`200`:
- `regrade: an in-progress attempt is 409` — got 404, expected 409.
- `regrade: re-applies a changed fingerprint and audits it` — got 404, expected 200.
- `regrade: an identical fingerprint is a no-op (no UPDATE) but still audited` — got 404, expected 200.
- `regrade: a concurrent change (zero affected rows) is 409` — got 404, expected 409.

### Diagnosis
The fixture answered the exam→course query with `{ id: 'exam-1' }` only. `authorizeExamStaff` requires the course row's `tenant_id` to match the principal and then a server-side teaching relation (owner, `courses.instructor_id`, a taught group, or a branch membership covering a course group). With no `tenant_id`/`instructor_id` or group/branch evidence it correctly returned `not_found` (404) before the regrade logic ran. Production authority was not changed.

### Repair (test fixtures only)
`server/tests/m4-exam-grading.test.ts` now defines `COURSE_TEACHING_RELATION = { id: 'exam-1', tenant_id: 'tenant-a', instructor_id: 'instructor-a' }` and supplies it explicitly to the in-progress, changed-fingerprint, identical-fingerprint and concurrent-change fixtures. This is the same course-instructor relation `authorizeExamStaff` checks.

### Negative controls retained and strengthened
The test now named `regrade: a student, a cross-tenant actor and an unrelated same-tenant teacher are denied 403 without writes` asserts 403 and no attempt UPDATE for:
- a student,
- a cross-tenant instructor (`instructor-b`, tenant-b),
- an unrelated same-tenant teacher (`instructor-d`, tenant-a, not the course instructor).

The positive fixtures still assert fingerprint application/no-op, audit rows, concurrency 409 and the expiry assertions in autosave/submit remain unchanged and passing.

## 4. Focused test results (this correction)

| Suite | Result |
|---|---|
| `server/tests/m4-exam-snapshots.test.ts` | **46/46 pass** (was 48/48 with the two removed list tests; all authorization/regrade/pin/expiry tests still pass) |
| `server/tests/m4-exam-grading.test.ts` | **38/38 pass** (4/38 failing before the fixture integration; no production change) |
| `node node_modules/typescript/bin/tsc --noEmit -p server/tsconfig.json` | 1 error, **not in my files**: `server/src/services/lesson-discussions.ts(372,65): error TS2552: Cannot find name 'ClosedReportStatus'` — recorded as a provisional cross-lane observation, not fixed |

## 5. Held items (decided elsewhere; NOT implemented, NOT guessed)

| Item | Reference | Why held |
|---|---|---|
| Staff attempts list and its authorized audience | `docs/17-full-feature-backlog.md:60`, `:63` (neither expressly requires it) | No approved backlog evidence; the execution plan is not evidence. Removed rather than inferred. |
| Result-release timing / review visibility | plan §4 G-D2 | undecided; no policy inferred by the removed list or the remaining reads |
| Draft-vs-submitted body precedence on submit | plan §4 G-D1, scope doc "T2"; current route `server/src/routes/exam-versions.ts:1090-1155` | undecided; existing submit behavior preserved |
| Retakes and legacy exam retirement | plan §4 G-D4 | undecided |
| Archived-question pinning | plan §4 G-D3; `server/src/routes/exam-versions.ts:665-674` | undecided; the pin filter remains the existing branch visibility filter only |
| Manual grading schema for `pending_review`/expired essays (G-A4-1) | plan §3 | needs migration + mount; out of scope |
| Who may edit a course's exam precisely vs. `groups.course_id` vs. `student_courses` enrollment relation (G-D6) | plan §4 | gradebook parity pattern used; no new relation invented |

## 6. Limits

- Hermetic injected-dependency tests only: SQL guards are asserted by statement text/bindings. Real MySQL concurrency, ordering and migration application remain unproven (no DB/Docker/network in this lane).
- Row-level branch/course filtering is exercised for SQL shape; actual row results would be decided by MySQL.
- Typecheck is provisional while other lanes write; the single error above is outside this task's allowed files.
- No frontend/bridge/index/auth/db/helper/migration/manifest/dependency/git changes.
