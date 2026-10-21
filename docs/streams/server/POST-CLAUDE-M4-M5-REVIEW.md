# Post-Claude M4/M5 verification and correction — server

- **Task:** `post-claude-m4-m5-verify-correct-20261018-01` (team `backend`)
- **Worker:** `wb-postclaude-m4m5-20261018-01`
- **Repo / branch:** `FreeLance_25-1`, `codex/workbuddy-server`
- **Baseline HEAD:** `28288ed` (`M4/M5 review fixes — …`)
- **Review under verification:** `docs/agent-reports/review-m4-m5.md` (15 findings)
- **Mode:** read-only git, hermetic tests only. No DB, Docker, network, SQL execution, dependency installs, migrations, or secrets.
- **Status:** reported, **not accepted**. Final acceptance is the supervisor's.

## Method

1. Ran the full guarded hermetic suite and source typecheck **before any edit** and recorded exit
   codes, counts and the exact failing test (baseline section below).
2. Opened the real code for every finding and classified it FIXED / CORRECTED / OPEN / OUT-OF-SCOPE.
   No finding was re-implemented from the review text; each verdict cites the mechanism in the
   current tree.
3. Reproduced only verified gaps with handler-level tests that drive the real router through
   injected dependencies, then fixed them minimally.
4. Re-ran the full suite from both working directories, the in-scope M4/M5 files, typecheck and the
   diff check.

## Findings — verdicts against `28288ed`

| # | Sev | Verdict | Where it is closed now | Evidence test |
|---|---|---|---|---|
| 1 | High | **FIXED at the trust boundary; storage backend OUT-OF-SCOPE** | `server/src/services/assignments.ts:277-279` rejects any client `storage_key`; `:291-305` accepts only a server-verified byte count; `server/src/routes/assignments.ts:519-545` generates the key and reads size only from the injected `storageStat`; `:552-559` persists that size. Residual: production `storageStat` is a null stub (`assignments.ts:970`), so production rows stay `pending_upload` with 0 bytes until an object store/presign flow exists. | `m4-assignments.test.ts` — “submit: a client-supplied storage_key is rejected with 400 and nothing is written”, “submit: with no verified object the submission is recorded pending_upload (0 bytes, client size ignored)”, “submit: the verified size (not the client claim) enforces the limits, cross-tenant is 404” |
| 2 | High | **FIXED** | `server/src/routes/certificates.ts:157-195` recomputes eligibility from gradebook policy/scores (`calculateGrade`), lesson completions and exam attempt flags; `:275-277` refuses ineligible issuance. Body-declared score/threshold/counters are never read. | `m4-certificates.test.ts` — “issue requires server-side eligibility (no recorded pass fails closed)”, “issue ignores body-declared facts: server records below threshold are rejected”, “issue mints a server-generated unique verification id and audits it” |
| 3 | High | **FIXED** | Autosave drafts: `server/src/routes/exam-versions.ts:903-969`. Server-side expiry that grades saved drafts: `:349-380`. Periodic sweep: `:1210-1223`, scheduled at `server/src/index.ts:354-370` (startup + 60 s, non-overlapping). On-touch compensation for reads/autosave/submit: `:871`, `:886`, `:924`, `:995`. `status='expired'` / `auto_submitted=1` are written by `persistAttemptGrade` (`:292-341`). | `m4-exam-grading.test.ts` — “autosave: persists draft responses while the phase is open, without grading”, “autosave: past the grace deadline the touch finalizes the saved drafts as expired”, “submit: an expired submit grades the saved drafts and audits the server-side auto-submit”; `m4-exam-snapshots.test.ts` — “read attempt: past the grace deadline the touch expires the attempt (server-minted, audited)” |
| 4 | Medium | **FIXED** | `server/src/services/assignments.ts:429-444` matches course audience through the enrollment's group course and denies when the enrollment has no course; applied on list `routes/assignments.ts:479`, read `:722`, submit `:500`, mine `:627`. | `m4-assignments.test.ts` — “course audience: a student outside the course is denied, an enrolled course student is served (read/submit)”, “enrollmentMatchesAssignment: deny-by-default tenant/branch/group/course scope” |
| 5 | Medium | **FIXED, then CORRECTED** | Course relation enforced on every staff read/write: `server/src/routes/gradebook.ts:157-183` (`authorizeCourse`), score write `:238-241`, score list `:264-279`, student read `:311`/`:362`. **Correction:** the branch branch of `authorizeCourse` was a blanket tenant pass (any branch membership authorised any course). It now also requires a group of *this* course inside the caller's branch: `gradebook.ts:151-160`, `:179`. | Existing: “non-owner instructor cannot set the policy of a course they are not related to”, “non-owner instructor may set the policy of a course they teach through a group”, “non-owner instructor score listing is restricted to courses they teach”. Added: “a branch membership alone does not grant authority over an unrelated course”, “a branch membership covers a course that has a group inside that branch” |
| 6 | Medium | **FIXED, then CORRECTED** | Enrollment and course are validated in-tenant and issuer authority is required before eligibility: `server/src/routes/certificates.ts:265-273`. **Correction:** branch authority had the same blanket-pass shape as #5; it now requires a course group inside the branch (`certificates.ts:118-144`). | Existing: “issue rejects an enrollment that does not exist in the caller tenant”, “issue rejects a course that does not belong to the caller tenant”, “issue rejects an instructor with no authority over the course”. Added: “a branch membership alone does not grant certificate authority over an unrelated course”, “a branch membership covers a course that has a group inside that branch” |
| 7 | Low | **FIXED, then CORRECTED (production wiring)** | The usage read is a locking read inside the atomic block (`server/src/routes/question-bank.ts:375-388`). **Correction:** the default export passed no `transaction`, so `runAtomic` degraded to `fn(db)` and the `FOR UPDATE` lock was released in autocommit. Production now supplies a pooled transaction (`question-bank.ts:600-626`, wired at `:633`). | `m4-question-bank.test.ts` — “edit: a version-lock usage check runs inside the atomic section (FOR UPDATE, anti-TOCTOU)”, “edit: a version used by a published exam is immutable (409, no write)” |
| 8 | Low | **FIXED** | `server/src/routes/assignments.ts:556` writes `enrollment.userId` (the authenticated principal) as `student_user_id`; `resolveEnrollment` derives it from `req.user.id` (`:246`). | `m4-assignments.test.ts` — “submit: an enrolled student creates version 1 with no public URL and audits” asserts `params[4] === 'student-a'` |
| 9 | Low | **FIXED** | `server/src/routes/exam-versions.ts:829-836` converts a lost `UNIQUE (exam_id, student_enrollment_id)` race into `409 already_attempted`; no raw 500. | `m4-exam-snapshots.test.ts` — “start: a lost UNIQUE race on the attempt insert surfaces as 409 already_attempted, never a 500” |
| 10 | Low | **FIXED** | Public verify resolves display names in SQL and the projection emits no internal ids and `final_score: null`: `server/src/routes/certificates.ts:185-215`, `server/src/services/certificates.ts:89-107`. | `m4-certificates.test.ts` — “verify endpoint is public, minimal and reports revocation” (asserts no `id`/`course_id`/`tenant_id`, `final_score === null`, display names) |
| 11 | Low | **FIXED, then CORRECTED** | Duplicate-key loss returns the winner's row as `unchanged`: `server/src/routes/attendance-records.ts:234-247`. **Correction:** with a real transaction the plain re-read is served from the REPEATABLE READ snapshot taken before the winner committed, so the race path now uses a locking read (`:191-199`, `:242`). | `m5-attendance-records.test.ts` — “attendance: a duplicate-key race on the first mark returns the existing row as unchanged (no 500)”, now also asserting the race re-read is `FOR UPDATE` |
| 12 | Info | **OPEN — product intent** | Any instructor may edit/archive tenant-scope questions they can see: `server/src/services/question-bank.ts:264-273`, `server/src/routes/question-bank.ts:430-460`. Behaviour is unchanged and documented as a question below. | n/a |
| 13 | Info | **FIXED** | Student policy/grade reads require an enrollment relation to the course: `server/src/routes/gradebook.ts:311` (`/me`), `:362` (`/progress`). | `m4-gradebook.test.ts` — “student cannot read the gradebook policy of a course they are not enrolled in” |
| 14 | Info | **ACCEPTED (documented, no code change)** | Fall-back DST overlap deterministically resolves to the later instant (`server/src/services/content-release.ts:124-128`). This is a consistent, tested behaviour; operator note only. | `m5-schedules.test.ts` — “expandRecurrence keeps the local wall time across a DST boundary” |
| 15 | Info | **OPEN — product intent** | A non-owner staff member still sees only sessions in an owned group, own branch, or own creation (`server/src/routes/schedules.ts:176-192`). Under-exposure, unchanged; question below. | `m5-schedules.test.ts` — “schedules: a session outside the caller groups is 404 (deny by default)” |

## What I changed and why

All changes are inside `allowedPaths`. No assertion was weakened, skipped or deleted; no production
SQL was replaced with in-memory state.

1. **Production atomic seam was declared but never wired (all seven routers).**
   Every M4/M5 router documents an atomic section and calls `runAtomic`, and every handler test
   injects `transaction`. The default exports passed only `db`, so in production `runAtomic` fell
   back to `fn(db)`: multi-statement writes ran in autocommit, a failed audit could leave an
   unaudited row, and `SELECT … FOR UPDATE` in the question-bank version lock was released at
   statement end (finding #7 inert). Wired a pooled `withTransaction` adapter in:
   `question-bank.ts:600-626`, `assignments.ts:977-999`, `exam-versions.ts:1226-1252`,
   `gradebook.ts:383-403`, `schedules.ts:600-626`, `attendance-records.ts:509-535`, and added the
   seam to `certificates.ts:38-42`, `:70-74`, `:361-381` (issue `:283-296`, revoke `:308-314`).
   The exam expiry sweep also uses the real transaction now (`exam-versions.ts:1217`).
2. **Branch authority was a tenant-wide pass (findings #5, #6).**
   `authorizeCourse` / `hasCourseAuthority` accepted any verified branch membership as authority
   over any course in the tenant, because `courses` has no `branch_id`. Both now require a
   branch-scoped group that belongs to *this* course (`gradebook.ts:151-160,179`;
   `certificates.ts:118-144`).
3. **Attendance race re-read under a real transaction (finding #11).**
   The duplicate-key recovery read is now `… FOR UPDATE` (`attendance-records.ts:191-199,242`) so it
   bypasses the transaction snapshot and sees the winner's committed row instead of throwing a 500.
4. **Tests added** (extend existing phase files only):
   `m4-gradebook.test.ts` +2 branch-authority tests, `m4-certificates.test.ts` +2 branch-authority
   tests, `m5-attendance-records.test.ts` +1 assertion on the locking re-read. No existing assertion
   was modified.

## Commands and results (actual)

Baseline was taken before any edit; final was taken after all edits. Both suites are the exact
guarded commands from the brief. Counts include tests added by the concurrently running sibling
worker, so the total grows between runs (1772 → 1804).

### Baseline — before any edit

| Command | Exit | Tests | Pass | Fail |
|---|---|---|---|---|
| `M1_NETWORK_MODE=hermetic node --require ./scripts/m1-network-guard.cjs --import tsx --test server/tests/*.test.ts` (repo root) | **1** | 1772 | 1771 | 1 |
| `cd server && M1_NETWORK_MODE=hermetic node --require ../scripts/m1-network-guard.cjs --import tsx --test tests/*.test.ts` | **1** | 1772 | 1771 | 1 |
| `cd server && ../node_modules/.bin/tsc --noEmit` | **2** | — | — | 10 errors |

Pre-existing baseline failures (reported separately, not caused by this task):
- `server/tests/m1-bootstrap-plan.test.ts` — “stages every migration in order with exact source
  hashes and reviewed dependency moves”: `Source hash differs from reviewed manifest for
  20261018_13_parent_links.sql`. Cause: the untracked `server/migrations/20261018_13_parent_links.sql`
  had no reviewed manifest entry. Bootstrap manifest and migrations are outside `allowedPaths`.
- Typecheck: 10 `error TS` in `server/src/routes/parent-links.ts` and
  `server/src/services/parent-links.ts` (untracked, sibling-owned).

### Final — after all edits

| Command | Exit | Tests | Pass | Fail |
|---|---|---|---|---|
| Root guarded suite (run 1) | **1** | 1804 | 1797 | 7 |
| Root guarded suite (run 2, required re-run) | **1** | 1804 | 1797 | 7 |
| `cd server` guarded suite | **1** | 1804 | 1797 | 7 |
| In-scope: `cd server && … --test tests/m4-*.test.ts tests/m5-*.test.ts` | **0** | 229 | 229 | 0 |
| Mounting: `cd server && … --test tests/m2-m3-mounting.test.ts` | **0** | 7 | 7 | 0 |
| `cd server && ../node_modules/.bin/tsc --noEmit` | **2** | — | — | 1 error |

- All 7 remaining failures are in `server/tests/m6-parent-links.test.ts` (untracked, outside
  `allowedPaths`, edited concurrently by the sibling worker — the failing test names changed between
  the two runs). Representative names: “verify: correct code creates one link and issues a scoped
  token”, “revoke: tenant staff authority can revoke”, “request: unknown student and unregistered
  contact are 404”.
- The baseline bootstrap-plan failure is gone in the final runs because the sibling worker updated
  `server/bootstrap/m1/manifest.json`; I did not touch that file or any migration.
- The single remaining typecheck error is `server/src/services/parent-links.ts(429,31): TS18048`
  (sibling file). **Zero typecheck errors in any file I touched.**
- `git status --short` / `git diff --stat`: my changes are 7 route files + 3 test files
  (348 insertions, 17 deletions). Untracked pre-existing items (`docs/*.zip`, `docs/share/`,
  `docs/New Text Document.md`, `server/migrations/20261018_13_parent_links.sql`) are untouched.

## Residual blockers and questions

**Schema / live (blocking parts of #1):**
1. No object storage is integrated, so `productionStorageStat` returns `null` and every production
   submission is stored `pending_upload` with `file_size_bytes = 0` (`assignments.ts:970`,
   `:1004-1005`). Closing the storage half of finding #1 needs a server-generated upload target
   (presign/upload endpoint), a post-upload stat/finalize step that flips `pending_upload → clean`,
   and a scan pipeline. Those touch storage configuration, not these routers.
2. Transaction wiring can only be observed end-to-end against MySQL; the hermetic proof is the
   injected-transaction handler tests plus typecheck. No DB was connected, per the task rules.

**Product policy (not invented here):**
3. Finding #12: may a non-owner instructor edit/archive tenant-scope questions they can read
   (`services/question-bank.ts:264-273`)? Current answer is yes. Restricting it changes the
   collaboration model.
4. Finding #15: should non-owner staff see tenant-audience sessions created by others
   (`schedules.ts:176-192`)? Current answer is no (defensive).
5. Certificate revocation still only requires *some* instructor membership in the tenant
   (`certificates.ts:300-316`), unlike issuance. Should revocation be course-authority-scoped
   (consistent with #6) or stay tenant-wide for administrative recovery?
6. Certificate exam gate counts recorded attempts only (`certificates.ts:175-186`): a student with no
   attempt at all is treated as “all exams passed”. Should eligibility require one attempt per exam
   defined for the course?

**Client / out of scope:**
7. Frontend callers must use `POST /api/exam-versions/attempts/:id/autosave` for draft persistence
   and expect `upload_status: 'pending_upload'` plus a creator-only `storage_key` on assignment
   submission. `src/**` is owned elsewhere.

**Observation, not a review finding (not changed):**
8. `loadSubmissions` is capped at 200 tenant-wide rows per assignment
   (`routes/assignments.ts:319-325`) and is then filtered per enrollment. On an assignment with more
   than 200 submissions a student's own history can fall outside the window, which would make
   `version` computation collide and `GET /:id/submissions/mine` incomplete. Proposed fix: filter by
   `student_enrollment_id` in SQL for the student paths. Left untouched to keep this task bounded.

No milestone or phase is declared complete by this report.
