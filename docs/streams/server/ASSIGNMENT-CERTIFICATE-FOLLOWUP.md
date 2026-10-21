# Assignment submission history and certificate authority — follow-up

- **Task:** `post-claude-assignment-certificate-followup-20261018-01` (team `backend`)
- **Worker:** `wb-followup-assigncert-20261018-01`
- **Repo / branch:** `FreeLance_25-1`, `codex/workbuddy-server`
- **HEAD:** `28288ed` plus the previous round's uncommitted server work (transaction wiring, branch-authority tightening, prior M4/M5 fixes)
- **Mode:** read-only git, hermetic handler tests only. No DB, SQL execution, Docker, network, provider calls, secrets/`.env`, dependency installs, migrations, or Git writes.
- **Status:** reported, **not accepted**. Acceptance is the supervisor's/Codex's.

## Scope

Only these files were written:

| File | Change |
|---|---|
| `server/src/routes/assignments.ts` | Enrollment-scoped own-history SQL for reads, submit decisions and duplicate-key recovery |
| `server/src/routes/certificates.ts` | Revocation now requires the same course authority as issuance |
| `server/tests/m4-assignments.test.ts` | +4 regression tests; the existing `mine` test now asserts the SQL predicate |
| `server/tests/m4-certificates.test.ts` | +5 regression/characterisation tests; two revoke fixtures supply the course row |
| `docs/streams/server/ASSIGNMENT-CERTIFICATE-FOLLOWUP.md` | This report |

`server/src/services/assignments.ts` and `server/src/services/certificates.ts` needed no change: the truncation was in the route's row selection, and the certificate policy helpers were already pure and correct. No schema, migration, frontend, auth, shared helper, `index.ts`, package, script or `.env` file was touched. Sibling-owned `secure-video.ts`, `video-assets.ts`, `playback-entitlement.ts` and parent-links files were not modified.

## Defect 1 — own submission history was truncated tenant-wide

### Before (source at `28288ed` + prior uncommitted work)

`server/src/routes/assignments.ts:319-325` (old `loadSubmissions`):

```sql
SELECT ... FROM assignment_submissions
WHERE assignment_id = ? AND tenant_id = ?
ORDER BY version DESC LIMIT 200
```

Every student path then filtered those ≤200 tenant-wide rows in JavaScript by `student_enrollment_id`:

- `POST /:id/submissions` — `existing` (`:510-512`) and the duplicate-key recovery (`:582-584`)
- `GET /:id/submissions/mine` — `:630-631`

Consequences once an assignment has more than 200 submissions tenant-wide: a student's older versions can fall outside the window, so `GET …/mine` is incomplete, `evaluateSubmission` computes `nextVersion = 1` (a version already taken), the limit gate sees too few active versions, and a lost UNIQUE race is re-evaluated from the same truncated window.

### Fix

- `server/src/routes/assignments.ts:343-354` — new `loadEnrollmentSubmissions(tenantId, assignmentId, enrollmentId)` filters **`tenant_id + assignment_id + student_enrollment_id` in SQL** with no `LIMIT`, ordered `version DESC`. The enrollment id is the server-resolved `enrollment.id` from the authenticated principal, never a request value.
- `:539-540` — submit decision reads the complete own history.
- `:610-611` — duplicate-key recovery reads the complete own history (same UNIQUE semantics; a lost race is still answered 409 or a precise 403, never 500).
- `:657` — `GET …/submissions/mine` reads the complete own history.
- `:328-334` — the staff listing keeps the tenant-wide `LIMIT 200`; it is a deliberate page cap and no version/limit decision is made from it. The shared projection column list is factored into `SUBMISSION_COLUMNS` (`:319-321`).

The UNIQUE key `uq_assignment_submission_version (assignment_id, student_enrollment_id, version)` (`server/migrations/20261018_08_question_bank_assignments.sql:207`) is unchanged and still owns the append race; the existing index prefix serves the new predicate.

### Reproduction (handler-level, real router, scripted SQL recorder)

The fake adapter returns rows verbatim, so the new tests emulate the two SQL shapes: the tenant-wide query applies `ORDER BY version DESC LIMIT 200`; the enrollment query applies the enrollment predicate and no cap. This is what MySQL does.

| Test (`server/tests/m4-assignments.test.ts`) | Before the fix | After the fix |
|---|---|---|
| `own history: 250 other-student submissions never truncate the caller versions or the next version` (`:765`) | `GET …/mine` returned **0** of the caller's 3 versions; the next version would be **1** (already taken) | **3** versions `[3,2,1]`; submit mints **version 4**; insert binds `enr-a` / `student-a` / `4` |
| `own history: the submission limit is decided from all own versions, not the tenant window` (`:799`) | 5 own active versions were invisible → **201** (fake) or a UNIQUE collision in a real DB | **403 `SUBMISSION_LIMIT_REACHED`**, no insert |
| `duplicate-key recovery: the retry decision reads the caller own history, not the tenant window` (`:813`) | recovery re-read the truncated window and answered **409 retry** | recovery sees the committed fifth version and answers **403 `SUBMISSION_LIMIT_REACHED`**; 2 enrollment-scoped reads; no audit on the lost insert |
| `foreign tenant: own-history reads and submit are 404 and never touch submissions` (`:865`) | 404 (guard already correct) | **404**, no submission read, no insert; body is only `{error:'Assignment not found'}` |
| `mine: returns only the caller own versions and leaks no storage key` (`:666`, strengthened) | post-filter masked the SQL shape | asserts the SQL binds `student_enrollment_id = ?` with `enr-a`, no `LIMIT`, and the other enrollment is excluded |

Controlled A/B: restoring the old tenant-wide `LIMIT 200` + JS filter in `loadEnrollmentSubmissions` and running `tests/m4-assignments.test.ts` produced **33 tests, 29 pass, 4 fail** (the four tests above marked "before"). Restoring the fix produces **33/33 pass**.

## Defect 2 — certificate revocation authority was broader than issuance

### Before

`server/src/routes/certificates.ts:300-316` only required *some* active owner/instructor membership in the tenant (`resolveStaffScope`). Any tenant instructor could revoke any certificate in the tenant, including a course they have no relation to, while issuance required `hasCourseAuthority` (`:139-146`, used at `:272`). The plan/contracts do not name a separate revocation role; the M4 A8 delivery note only says "staff-scoped and tenant-scoped" (`docs/streams/server/M4-A6-A8-DELIVERY.md:35`), and the original review flagged the intra-tenant authority question (`docs/agent-reports/review-m4-m5.md:70`).

### Fix

`server/src/routes/certificates.ts:307-314`:

1. Load the certificate with `tenant_id = caller tenant` (unchanged).
2. Load its course and require `course.tenant_id === caller tenant`; otherwise **404** (fail closed on an integrity anomaly).
3. Require `hasCourseAuthority(scope, course)` — the **same predicate as issuance**: tenant owner, the course's instructor, an instructor who owns a group mapped to the course, or a verified branch instructor whose branch contains a group of this course. An unrelated tenant instructor is **403**.
4. Only then evaluate `status === 'revoked'` (**409**) and perform the guarded `UPDATE` + audit inside the existing atomic seam.

No new role, threshold or broad instructor right was invented. The tenant owner remains the administrative-recovery path because that is already part of the issuance authority model. A certificate's `issued_by` does **not** grant a personal revocation right.

### Reproduction

| Test (`server/tests/m4-certificates.test.ts`) | Before | After |
|---|---|---|
| `revoke: the course instructor may revoke under the same authority as issuance, audited` (`:345`) | 200 (but for the wrong reason: any instructor) | **200**, update records `instructor-c`, audit `certificate.revoke` names `instructor-c` |
| `revoke: an unrelated instructor is denied and nothing is written` (`:362`) | **200** — tenant-wide revocation | **403**, no `UPDATE certificates`, no audit |
| `revoke: a certificate outside the caller tenant is 404 and never updated` (`:374`) | 404 (tenant predicate already correct) | **404**, certificate read bound to `tenant-a`, no update/audit |
| `revoke flips status, audits and is idempotent-safe` (`:250`, existing) | 200 / 409 | unchanged 200 / 409; fixture now supplies the course row the authority check reads |

Controlled A/B: disabling only the new authority check produced **27 tests, 26 pass, 1 fail** (the unrelated-instructor test). With the check restored, **27/27 pass**.

## Defect 3 — certificate eligibility with zero exam attempts (characterised, not changed)

`server/src/routes/certificates.ts:175-185` counts **recorded** attempts only:

```sql
SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN a.passed=1 THEN 1 ELSE 0 END),0) AS passed
FROM exam_versioned_attempts a INNER JOIN exams e ON e.id=a.exam_id
WHERE a.tenant_id=? AND a.student_enrollment_id=? AND e.course_id=?
```

`allExamsPassed = totalExams === 0 ? true : passedExams >= totalExams`.

Therefore a course that defines a published exam, but for which the student has **no attempt row at all**, yields `totalExams = 0` and is treated as "all exams passed". It does **not** 500 and does **not** fail closed — it **wrongly passes** the exam gate. A recorded `in_progress`/`pending_review` attempt (`passed` NULL) is counted as not passed and correctly denies, so the two cases are inconsistent.

| Test | Result |
|---|---|
| `eligibility: an exam-gated course with no attempt row currently passes the exam gate (documented open policy)` (`:395`) | **201**, certificate inserted; asserts the route never queries `FROM exams` (the course exam catalogue) |
| `eligibility: a recorded but not-passed attempt denies the certificate` (`:426`) | **400**, reason `exams_not_passed`, no insert |
| Existing `issue mints a server-generated unique verification id and audits it` (`:182`) | positive control: one recorded passed attempt → **201** |

No behaviour was changed here because the governing plan does not define which exams are certificate-required. The exact open question is in "Residual" below. The characterisation test deliberately records current behaviour; if policy changes, that test must change with it.

## Coverage matrix

| Requirement | Test(s) | Status |
|---|---|---|
| >200 other-student submissions + caller's own older history | `m4-assignments` `:765` | covered (before/after A/B) |
| Retry / duplicate-key submit | `:813`, plus existing `:580`, `:623` | covered |
| Foreign-tenant enrollment/assignment, no leak | `:865`, existing `:560` cross-tenant case | covered |
| Correct identity in the written row | `:765` (`enr-a`, `student-a`, version 4), existing `:487` | covered |
| Next version / limit from untruncated history | `:765`, `:799`, `:813` | covered |
| Revoke allowed for issuance-equivalent authority | `m4-certificates` `:345`, existing `:250` (owner) | covered |
| Revoke denied for unrelated instructor | `:362` | covered |
| No cross-tenant revoke read/write | `:374`, existing `:267` | covered |
| Revoke audit row | `:345`, existing `:250` | covered |
| Zero-attempt exam gate | `:395` | characterised; policy open |
| Failed/pending attempt denies | `:426`, existing `:182` (positive) | covered |

No existing assertion was weakened, skipped or deleted. The existing `mine` test was strengthened from a post-filter count to the SQL predicate because the route no longer post-filters.

## Commands and results (actual)

Baseline was taken before any edit. Final runs were taken after all edits and after the temporary A/B edits were reverted.

### Baseline — before any edit

| Command | Exit | Tests | Pass | Fail |
|---|---|---|---|---|
| `M1_NETWORK_MODE=hermetic node --require ./scripts/m1-network-guard.cjs --import tsx --test server/tests/*.test.ts` (repo root) | **0** | 1804 | 1804 | 0 |
| `cd server && M1_NETWORK_MODE=hermetic node --require ../scripts/m1-network-guard.cjs --import tsx --test tests/*.test.ts` | **0** | 1804 | 1804 | 0 |
| `cd server && ../node_modules/.bin/tsc --noEmit` | **2** | — | — | 1 error |
| Focused: `cd server && … --test tests/m4-assignments.test.ts tests/m4-certificates.test.ts` | **0** | 51 | 51 | 0 |

Baseline typecheck error (pre-existing, sibling-owned): `src/services/parent-links.ts(429,31): error TS18048: 'deps.otp' is possibly 'undefined'.` No error in any file this task touched.

### Final — after all edits

| Command | Exit | Tests | Pass | Fail |
|---|---|---|---|---|
| Root guarded suite (run A, immediately after edits) | **0** | 1813 | 1813 | 0 |
| Root guarded suite (run B, after the A/B revert cycle) | **1** | 1813 | 1810 | 3 |
| `cd server` guarded suite | **1** | 1813 | 1810 | 3 |
| Focused M4 files: `cd server && … --test tests/m4-assignments.test.ts tests/m4-certificates.test.ts` | **0** | 60 | 60 | 0 |
| `cd server && ../node_modules/.bin/tsc --noEmit` | **2** | — | — | 1 error |

- The 3 failures in runs B are **not in this task's files**: `m1-media-socket-regressions.test.ts` —
  “wiring: secure-video checkVideoAccess delegates to the pure production policy”,
  “wiring: secure-video session creation carries no early tenant-only filter”,
  “wiring: manifest, segment, and key delivery recheck the grant before any exposure”.
  `git status` shows `server/src/routes/secure-video.ts` and `server/src/services/playback-entitlement.ts`
  modified concurrently by the sibling worker; both files are outside this task's scope and were not touched.
  Run A (same source, before the sibling's later edit landed) passed 1813/1813.
- The single typecheck error remains `src/services/parent-links.ts(429,31)` (sibling-owned). **Zero typecheck errors in the four source/test files this task changed.**
- `git status --short` / `git diff --stat`: my changes are 2 route files + 2 test files + this report. Untracked pre-existing items (`docs/*.zip`, `docs/share/`, `docs/New Text Document.md`, `server/migrations/20261018_13_parent_links.sql`, parent-links sources/tests) are untouched.

### Reproduction A/B (temporary, reverted)

| Variant | Command | Exit | Tests | Pass | Fail |
|---|---|---|---|---|---|
| Old tenant-wide `LIMIT 200` + JS filter | `tests/m4-assignments.test.ts` | **1** | 33 | 29 | 4 |
| Revoke authority check disabled | `tests/m4-certificates.test.ts` | **1** | 27 | 26 | 1 |

Both temporary edits were reverted; the focused suite was re-run to **60/60 pass** and `grep "if (false"` confirms no debug condition remains.

## Residual dependencies and open policy questions

**Policy (not invented here):**

1. **Certificate exam requirement.** Should a course exam be a certificate requirement, and if so which ones? The current aggregate counts recorded attempts only, so a student with **no attempt row** passes the exam gate (`certificates.ts:175-185`; characterised by `:395`). A complete server-owned check needs a product/schema decision:
   - Does every `exams.is_published=1 AND is_active=1` row for the course count as required?
   - Must the student have a `graded` attempt with `passed=1` for each required exam, and do `in_progress` / `pending_review` attempts count as not passed?
   - Is there an explicit "required for certificate" flag, or are optional/practice exams excluded?
   There is no such flag in the current schema (`server/migrations/20260920_00_legacy_baseline.sql:230-250`; `20261018_09_exam_snapshots_grading.sql:123-151`). Implementing a guessed rule would fabricate completion; the current behaviour is documented instead.
2. **Revocation administrative recovery.** Revocation now matches issuance authority. The plan does not define a tenant-wide administrative role that may revoke a certificate for a course it does not teach. If such recovery is required, it needs an explicit role/policy decision; it was not granted here. A tenant owner retains the existing recovery path.

**Schema / live:**

3. No migration is needed for the assignment fix: the existing `uq_assignment_submission_version` index prefix and `idx_assignment_submissions_student` serve the new predicate. No SQL was executed and no DB was connected, per the task rules; the hermetic proof is the injected-dependency handler tests plus typecheck.
4. Production `storageStat` remains a null stub, so submissions still persist `pending_upload` with 0 bytes until an upload/finalize/scan pipeline exists (`assignments.ts:996`, `:562-577`). Unchanged and out of scope.

**Client:**

5. Item 1 keeps the same response shapes and status codes; `GET …/submissions/mine` now returns the complete own history instead of an arbitrary window. Item 2 changes an unrelated instructor's revoke from 200 to 403; clients must surface that denial. `src/**` is owned elsewhere.
6. The certificate `verify` projection and the public response shape are unchanged.

No milestone or phase is declared complete by this report. No live verification is claimed.
