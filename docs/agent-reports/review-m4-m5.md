# Security Review M4–M5 — Tabweb Teachers (Express+TS, `server/`)

- **Reviewer:** independent security reviewer (read-only on code; no git/DB/network; .env never read)
- **Scope:** services {question-bank, assignments, exam-snapshots, exam-grading, gradebook, progress-reports, certificates, schedules, attendance-records}; routes {question-bank, assignments, exam-versions, gradebook, certificates, schedules, attendance-records}; mounts in `server/src/index.ts` (~190–220); migrations `20261018_08..11`.
- **Method:** every finding verified by reading code; severity, `file:line`, concrete fix listed. Only verified findings included.

**Status: IN PROGRESS — findings appended incrementally.**

---

## services/question-bank.ts + routes/question-bank.ts

Service is pure/I-O-free; all route SQL is parameterized; tenant always derived from `user.tenantId`; owner `1=1` visibility is always combined with an explicit `tenant_id = ?` (routes/question-bank.ts:155, 227–228, 472–473); answer key type-checked against options; version immutability fails closed.

| Sev | Finding | Fix |
|---|---|---|
| Low | TOCTOU on version lock: `question_bank_version_usages` is queried **outside** the atomic section (routes/question-bank.ts:353–360), while the version append runs inside `runAtomic` (routes/question-bank.ts:384). An exam published concurrently between check and update could start referencing `current_version` that is then no longer current. Integrity is not broken (append-only keeps old versions intact), but the "published ⇒ immutable" guarantee can be skipped in a race. | Move the usage SELECT inside the same transaction as the update, and/or re-verify usage after the update and roll back on conflict. |
| Info | Any staff instructor (not just owner) may archive (routes/question-bank.ts:421–457) and may edit tenant-scope questions they can see. Confirm this is intended authority model; if edits should be restricted, add authority check. | Clarify product intent; add authority gate if needed. |

## migrations/20261018_08_question_bank_assignments.sql

Idempotent information_schema probes + PREPARE/EXECUTE; CREATE TABLE only, no DROP/TRUNCATE/data rewrite; all tables carry `tenant_id`, private `storage_key` with no public URL column, `scan_status` defaults server-owned. Clean.

## services/assignments.ts + routes/assignments.ts

Deadline conversion uses shared IANA two-pass UTC conversion (services/content-release.ts:119–129); late policy and window resolution fully server-side with server clock; submission gating (`resubmission`, limit, revoked-slot re-open) implemented and protected by UNIQUE (assignment_id, enrollment, version) so concurrent submits fail closed rather than exceed the limit.

| Sev | Finding | Fix |
|---|---|---|
| Medium | **Course-audience assignment leaks tenant-wide to students.** `enrollmentMatchesAssignment` (services/assignments.ts:371–383) and `AssignmentAudienceFacts` (services/assignments.ts:352–357) carry no course context; an assignment with `course_id` set (course audience) falls through to the final `return true`, matching ANY approved enrollment in the tenant. Affects GET `/student` (routes/assignments.ts:436–443), GET `/:id` (routes/assignments.ts:622–630), POST `/:id/submissions` eligibility (routes/assignments.ts:459–463) and GET `/:id/submissions/mine` (routes/assignments.ts:530–534) — students outside the target course see and can submit to it. | Extend the audience match with the course: if `course_id` is set (and no branch/group), require the student's enrollment group's `course_id` (or a course-enrollment table) to equal it; otherwise return false. |
| High | **Client-supplied `storage_key` and `file_size_bytes` — trust boundary at submission metadata.** POST `/:id/submissions` validates upload metadata against the assignment limits but both `storage_key` (routes/assignments.ts:464–468; services/assignments.ts:273–278) and `file_size_bytes` are client-declared. Nothing binds the submission row to a file the server placed: a student may (a) claim a size under the limit while the eventual object is larger, and (b) supply a `storage_key` of another object in the private bucket (the pattern allows `tenants/…`-style paths), causing another user's/tenant's file to be recorded as this submission's content — IDOR-by-reference at scan/grading/download time, and a latent tenant-boundary bypass (STORAGE_KEY_PATTERN accepts any `tenant/…` path). | Server has to own identity of both values: generate the storage key at upload time (server-side presigned flow keyed `tenants/{tenantId}/assignments/{assignmentId}/{enrollmentId}/{submissionId}…`), derive bytes from the actual stored object, and reject/ignore client-provided `storage_key`/`file_size_bytes`. |
| Low | `student_user_id` is written from `enrollment.id` instead of the auth user id (routes/assignments.ts:487 passes `enrollment.id` for both `student_enrollment_id` and `student_user_id`). Data-correctness bug; all reads are tenant-scoped so not directly exploitable, but it breaks any future per-user query on that column. | Pass `req.user.id` for `student_user_id`. |
| Info | Submission limit/resubmission checks run outside the insert transaction (routes/assignments.ts:470–476 then 480). The per-(assignment,enrollment)-version UNIQUE key saves correctness, but losing submitters get a raw 500 instead of a policy denial. | Catch duplicate-key on insert and re-evaluate inside the transaction. |

## migrations/20261018_09_exam_snapshots_grading.sql + services/exam-snapshots.ts + services/exam-grading.ts

Schema is idempotent (probe+PREPARE), tenant-scoped, and storage-enforced: UNIQUE (exam_id, student_enrollment_id) blocks a second attempt at the DB boundary even under an application-level race; UNIQUE (attempt_id, question_ref) prevents award double-apply; UNIQUE (attempt_id, idempotency_key) backs regrade idempotency. Snapshot content is pinned to exact question-bank versions and hashed; publishing freezes the version and writes usage provenance that locks question-bank versions. Grading is integer-hundredths, deterministic, and the student-facing projection (`projectQuestion(row, false)`, routes/exam-versions.ts:701) never exposes the answer key or explanation. Deadline is server-minted, never derived from client input. Clean.

## routes/exam-versions.ts

| Sev | Finding | Fix |
|---|---|---|
| High | **Answers are only persisted at submit time, and after the grace window nothing can ever capture them.** The documented auto-submit path has no executor anywhere in the codebase (grep: `auto_submitted` is never set to 1; status 'expired' is never written; no timer/scheduled job exists for exam attempts — the `setInterval` timers in index.ts only handle subscriptions and privacy cleanup). Consequence, verified end-to-end: POST `/attempts/:attemptId/submit` is rejected with `LATE_REJECTED` inside grace (routes/exam-versions.ts:739–743) and with `EXPIRED` after it (services/exam-snapshots.ts:357–361), and there is no auto path that reads and stores the client-held answers. A student who filled in the exam right up to the deadline irrevocably loses every answer (client-held only), and the attempt is then stuck `in_progress` forever — staff regrade is refused for in-progress attempts (routes/exam-versions.ts:849–851). Integrity fails closed (no post-deadline cheating) but the exam becomes ungradeable and student work is silently destroyed. | Implement the server-side auto-submit: a scheduled pass (or on-request compensation triggered on any touch of the attempt after `graceDeadlineUtc`) that sets `status='expired'`, `auto_submitted=1` and preserves the last answers the client reported while phase was still open/grace; meanwhile persist answer drafts during the attempt (e.g., autosave endpoint) so a lost connection cannot destroy answers. |
| Low | Attempt start does an existence check then INSERT (routes/exam-versions.ts:632–641, 645–655); the UNIQUE (exam_id, student_enrollment_id) key makes the race fail closed, but the losing concurrent request surfaces as a raw 500 "Failed to start exam attempt" while the winner's attempt is live. | Catch duplicate-key errors and return 409 with `already_attempted` instead of a 500. |
| Info | Regrade recomputes from stored responses and applies only on fingerprint change (routes/exam-versions.ts:878–888, 890–936) — no staff can inflate or double-apply via regrade. Because stored responses never change except by the student's single submit, regrade results are deterministic. No further finding. |
| Info | GET `/attempts/:attemptId` for a student shows their own attempt only (`student_enrollment_id` equality check, routes/exam-versions.ts:695) with `revealAnswerKey=false` (routes/exam-versions.ts:701); the staff read carries the answer key only behind `resolveStaffScope` (routes/exam-versions.ts:705–713). No leakage found. |

## services/gradebook.ts + routes/gradebook.ts + services/progress-reports.ts (CSV primitives)

Fixed-point BigInt arithmetic; policy and score entry validation are bounded; CSV export uses `toCsv`/`escapeCsvValue` (services/progress-reports.ts:16–27), which applies `neutralizeCsvCell` (prefixes a `'` to `=`,`+`,`-`,`@`,tab/CR/LF cells) to every cell — gradebook export cells (student_enrollment_id, category_id, item_type, numeric fields) are hence injection-safe even for client-influenced strings like `category_id` (routes/gradebook.ts:233–244). All SQL parameterized.

| Sev | Finding | Fix |
|---|---|---|
| Medium | **Intra-tenant IDOR / authz bypass: no teaching relation required.** All gradebook write/read surfaces only verify that the caller is *some* owner/instructor of the tenant: PUT `/policy/:courseId` (routes/gradebook.ts:138–161) lets an instructor set the weighting policy of any course in the tenant; POST `/scores` (routes/gradebook.ts:164–185) lets an instructor record scores for **any** `student_enrollment_id` in the tenant with **no check that the enrollment or course exists in this tenant or that the instructor teaches that course/group** (the `course_id`/`enrollment_id` are client ids, inserted as-is); GET `/scores` and GET `/students/:enrollmentId` (routes/gradebook.ts:188–225) let an instructor read every score of every course in the tenant. Compare with the assignments router, which restricts non-owners to their groups/branches — this router fails to apply the same model (`branchAccess` is declared in deps at routes/gradebook.ts:28,65–68 but **never consulted**). | Before any read/write, verify the instructor's relation to the course (course instructor / group ownership / branch access via the already-injected `branchAccess`), and verify `courseId` + `student_enrollment_id` exist and belong to the same tenant. |
| Info | GET `/me` / `/progress` for students accept any `course_id` in the tenant (routes/gradebook.ts:203–213, 248–256); scores are still only the student's own (their enrollment id), but the gradebook *policy* of an arbitrary unrelated course (mode, categories, weights) is exposed to any registered student of the tenant. | Require an enrollment relation to the course before returning the policy view. |

## migrations/20261018_10_gradebook_certificates.sql

Idempotent probes + CREATE TABLE only; every table carries `tenant_id`; `uq_cert_verification` makes verification ids unique, `uq_cert_student_course` prevents double-issuance at the storage boundary, `uq_gradebook_policy (tenant_id, course_id)` prevents policy duplication. Clean.

## services/certificates.ts + routes/certificates.ts

`verification_id` is 32 bytes of CSPRNG hex (services/certificates.ts:47–57) — unguessable; public verify is rate-limited per client address (routes/certificates.ts:207) and answers 404 on unknown ids (routes/certificates.ts:85); the public projection excludes internal enrollment ids and issuer identity (services/certificates.ts:75–105). All SQL parameterized.

| Sev | Finding | Fix |
|---|---|---|
| High | **Certificate forgery: eligibility is entirely client-declared.** POST `/` (routes/certificates.ts:128–136) trusts `final_score`, `completed_lessons`, `total_lessons`, `all_assignments_submitted`, `all_exams_passed` and even `threshold` straight from the request body — no server-side cross-check against the gradebook / exams / lesson-progress data. Any tenant instructor can therefore mint certificates (and an arbitrary `final_score`) for any enrollment, independent of real academic results. | Recompute eligibility server-side from gradebook `calculateGrade`, exam attempt `passed` flags and lesson-progress counts for that enrollment+course; ignore the body's declared facts (or use them only as fallback when nothing is recorded, and mark the certificate as such). |
| Medium | **Enrollment/course ids are unvalidated on issue.** POST `/` inserts whatever strings arrive in `student_enrollment_id`/`course_id` (routes/certificates.ts:124–126, 145–148) — no check that they exist and belong to this tenant, no instructor-teaching-relation check. This pollutes the certificate table with arbitrary ids (and, worse, a certificate can be issued for a student the instructor never taught) and it lets a certificate carry tenant A's course id fabricated into tenant B's... (tenants are tagged correctly, so not a cross-tenant read leak — the issue is integrity/qualification rather than disclosure). | Validate the enrollment and course exist under `scope.tenantId` and that the issuer holds authority over that course (same fix pattern as the gradebook finding). |
| Low | **Public verify leaks internal ids.** The "name" fields passed to the public projection are raw internal identifiers: `courseName: row.course_id` and `tenantName: row.tenant_id` (routes/certificates.ts:90, 92), and the raw `final_score` (routes/certificates.ts:93). An anonymous verifier learns the tenant and course internal UUIDs and the numeric score; combined with enumeration this is an information-disclosure leak (the design comment promises "course/tenant display names"). | Project display names via a lookups table and gate `final_score` behind an explicit product decision (or omit it from public view). |
| Info | Revocation (routes/certificates.ts:158–174) is status-toggle idempotent (`AND status='issued'` guards the update) but any tenant instructor can revoke any certificate in the tenant. Same intra-tenant authority model question as the gradebook finding. |

## migrations/20261018_11_schedules_attendance_records.sql

Idempotent probes (tables + name-guarded foreign keys); CREATE/ALTER ADD CONSTRAINT only, no DROP/TRUNCATE/data rewrite; `tenant_id` on every table; UNIQUE (series_id, starts_at) makes series re-materialization idempotent; UNIQUE (session_id, student_id) is the attendance duplicate-marking guard. Clean.

## services/schedules.ts + routes/schedules.ts

DST: every occurrence/reschedule instant is computed by `localWallTimeToInstant` (services/content-release.ts:119–129) with an authenticated IANA zone and two-pass offset resolution, so a fixed wall time stays the wall time across DST changes; expansion is hard-capped (HARD_MAX_OCCURRENCES 2000, services/schedules.ts:60) so no DoS by open-ended recurrences; reschedule reuses the session's retained timezone and recomputes duration server-side (routes/schedules.ts:432–438); cancel/reschedule are optimistic-version + audited in the same transaction; students are served only by `buildVisibleScheduleFilter` combined with `tenant_id=?` (services/announcements.ts:257–262 — viewer with no branch/group binds NULL and matches nothing). Clean, with one note:

| Sev | Finding | Fix |
|---|---|---|
| Info | Ambiguous wall times at a fall-back DST overlap (e.g. 01:30 occurring twice) are deterministically resolved to the *second* (later) instant (services/content-release.ts:124–128) — consistent, but sessions landing inside the overlap always schedule to the later occurrence. Non-security behavior note; document for operators. |
| Info | Non-owner staff cannot see tenant-wide sessions/series created by others (routes/schedules.ts:180–192 requires owned-group/own-branch/created_by) even though the session's audience is the whole tenant. Under-exposure, defensive direction; confirm this matches the intended collaboration model. |

## migrations summary (20261018_08–11)

All four are re-runnable (information_schema probes, guarded FK adds), non-destructive (no DROP/TRUNCATE/FK-disable/data rewrite), tenant-scoped, and integrity-enforcing at the storage layer (uniques documented per finding above). One caution: they are authoring-only ("NOT EXECUTED" per 11) — deployment still requires the separately approved bootstrap run.

## services/attendance-records.ts + routes/attendance-records.ts

Mount and audience model verified: the session is loaded under a tenant+visibility predicate (routes/attendance-records.ts:137–145) so foreign sessions are indistinguishable from not-found; students are re-validated live in-tenant with group/branch scope in one SQL predicate (routes/attendance-records.ts:152–175); idempotency via UNIQUE (session_id, student_id) with same-state no-op and audited version-guarded corrections; bulk is atomic with per-record audits; student `/me` returns the caller's own rows only. All SQL parameterized.

| Sev | Finding | Fix |
|---|---|---|
| Low | Concurrent first-time marks for the same (session, student) both pass the "no existing record" window (routes/attendance-records.ts:183–214, eligibility/SELECT happens before `runAtomic`); the UNIQUE (session_id, student_id) key blocks the duplicate but the loser surfaces as a 500. | Catch the duplicate-key error inside the atomic section and re-SELECT: return the existing row as `unchanged` (or `conflict` → 409). |

## server/src/index.ts mounts (~190–220)

Verified: all six in-scope routers are mounted at index.ts:210–216 (`/api/question-bank`, `/api/assignments`, `/api/exam-versions`, `/api/gradebook`, `/api/certificates`, `/api/schedules`, `/api/attendance-records`) behind the `/api` guard chain `optionalAuth → enforceTenantAuthorityBoundary → enforceStudentWorkspaceBoundary` (index.ts:154). Every one of the seven factories is default-wired with the **real pool**: each module defines `productionDb` over the lazily loaded `../db` module plus `authenticateToken` — verified in routes/question-bank.ts:571–598, assignments.ts:832–877, exam-versions.ts:969–996, gradebook.ts:263–272, certificates.ts:192–208, schedules.ts:580–607, attendance-records.ts:461–488. **No in-memory store reaches production on any of these surfaces** (the only Map-based in-memory state found is per-request aggregation or test-path code in playback-sessions). The gradebook and certificates `loadActiveTenantAuthority` variants (gradebook.ts:270, certificates.ts:199) check role membership but *not* owner status (they omit the tenants.owner_user_id UNION branch): harmless here because both routers treat owner/instructor identically (`STAFF_AUTHORITIES`), but a drift risk if owner-only checks are ever added to those routers.

---

## Checked-and-clean

- **SQL injection:** every query in all 7 routers and their helpers is fully parameterized (placeholders only; no string interpolation of user data other than fixed column/alias fragments). `JSON_CONTAINS(tags, JSON_QUOTE(?))` is quote-bound parameterized.
- **Tenant isolation:** every read/write in all routers carries `tenant_id = <server-derived principal tenant>`; owner `1=1` visibility shortcuts are always combined with the tenant predicate; audience matching (assignments, exams, schedules, attendance) is deny-by-default.
- **Question-bank version immutability:** append-only versions, published-exam usage lock, optimistic `current_version` update — implemented and fail-closed (only a TOCTOU window noted above).
- **Exam snapshot immutability & grading integrity:** published snapshots frozen with SHA-256 content hashes; pinned (never "latest") question versions; attempts bound to an exact `exam_version_id`; server-minted deadlines; single attempt per student per exam enforced by DB UNIQUE; grading deterministic in integer hundredths; regrade fingerprint-gated and idempotent; student projections never carry the answer key or explanation.
- **Certificate verification ids:** 32-byte CSPRNG hex — not guessable/enumerable; public verify is rate-limited (30/min per client address) and 404s unknown ids; public projection excludes internal ids except the noted course/tenant id passthrough.
- **CSV export injection:** `neutralizeCsvCell` (=`'`-prefix on `=`,`+`,`-`,`@`,tab/CR/LF) is applied to every cell of the gradebook export via `toCsv`/`escapeCsvValue`.
- **State held only in memory:** none on the in-scope production surfaces — all default-wired routers use the real SQL pool (verified per file above); audit rows are transactional writes via `recordAudit(tx.execute, …)` on all mutating handlers checked.
- **Destructive/non-idempotent migrations:** none — 20261018_08..11 are all probe-guarded, additive, idempotent, and carry no drops or data rewrites.
- **Authentication chain:** all seven routers begin with `router.use(deps.authenticate)` → production wiring binds `authenticateToken`; anonymous access exists only to `/api/certificates/verify/:verificationId` (rate-limited, minimal projection), by design.

## Summary of findings

| # | Sev | Where | Finding |
|---|---|---|---|
| 1 | High | routes/assignments.ts:464–468 / services/assignments.ts:273–281 | Client-supplied `storage_key`/`file_size_bytes` — no server binding of submission to a real stored object (IDOR-by-reference / size-limit bypass at storage layer). |
| 2 | High | routes/certificates.ts:128–136 | Certificate eligibility fully client-declared — instructor mintable forged certificates/scores. |
| 3 | High | routes/exam-versions.ts:739–743, 849–851 / services/exam-snapshots.ts:357–361 | No auto-submit executor: answers lost at deadline; in_progress attempts stuck; work silently destroyed (fail-closed but ungradeable). |
| 4 | Medium | services/assignments.ts:371–383 + routes/assignments.ts:436–443, 459–463, 530–534, 622–630 | Course-audience assignments are tenant-wide for students; wrong students see and can submit. |
| 5 | Medium | routes/gradebook.ts:138–225 | Intra-tenant IDOR: any instructor edits/reads any course's policy/scores regardless of teaching relation; `branchAccess` injected but never used; ids unvalidated. |
| 6 | Medium | routes/certificates.ts:124–126, 145–148 | Enrollment/course ids unvalidated on issue; no teaching-relation check. |
| 7 | Low | routes/question-bank.ts:353–360 | Version-lock usage check outside the write transaction (TOCTOU window). |
| 8 | Low | routes/assignments.ts:487 | `student_user_id` written from enrollment id instead of user id. |
| 9 | Low | routes/exam-versions.ts:632–641 | Attempt-start race → raw 500 instead of 409 (DB UNIQUE saves correctness). |
| 10 | Low | routes/certificates.ts:90–93 | Public verify exposes internal course/tenant UUIDs and raw final_score. |
| 11 | Low | routes/attendance-records.ts:183–232 | First-mark race → 500 instead of idempotent no-op (DB UNIQUE saves correctness). |
| 12 | Info | routes/question-bank.ts:421–457 | Any instructor may archive/edit; authority model to confirm. |
| 13 | Info | routes/gradebook.ts:203–213, 248–256 | Student can fetch policy of arbitrary course in tenant. |
| 14 | Info | routes/schedules.ts / services/content-release.ts:124–128 | Fall-back DST overlap resolves to later instant; operators should know. |
| 15 | Info | routes/schedules.ts:180–192 | Non-owner staff cannot see tenant-wide sessions created by others (defensive direction; model to confirm). |

**Status: COMPLETE.**






