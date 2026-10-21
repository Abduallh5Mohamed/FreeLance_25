# Teacher-school product alignment — certificate exclusion

**Task:** `teacher-school-product-alignment-20261019-01` · worker `wb-school-align-20261019-01` (backend, write)
**Run:** 2026-10-19 ~02:50–03:05 (GMT+3) · repo `C:\Users\abdua\OneDrive\سطح المكتب\FreeLance_25-1` · branch `codex/workbuddy-server` · baseline HEAD `28288ed` + prior working tree
**Human decision implemented (2026-10-19):** the product is a **school teachers & students platform**, not a graduation/certificate platform. Certificates are excluded from the current product scope. This overrides the legacy A8 requirement.
**Honored boundaries:** no frontend, no DB, no Docker, no migration execution/SQL, no commit/push, no network, no packages, no parent-links edits (sibling-owned, read-only), no secure-video edits. SMS still deferred; OTP stays fail-closed (503).

---

## 1) TASK1 — product provenance audit (READ-ONLY)

Sources cited: `docs/17-full-feature-backlog.md`, `docs/18-workflows-and-execution-approval-ar.md`, `docs/19`, `docs/20`, `server/src/*`. Governing files `WORKBUDDY-INSTRUCTIONS.md` / `TEAM-OPERATING-MODEL.md` are **not present on disk** (searched repo-wide, excluding node_modules) — recorded, not invented; docs 17/18/19/20 + the task instruction are the governing set used here.

| # | Concept | Where it lives (evidence) | Classification | User consequence if left as-is |
|---|---|---|---|---|
| 1 | **Certificates** (issue / revoke / public verify / tenant-branded projection) | mount `server/src/index.ts:214` (`app.use('/api/certificates', certificatesRoutes)`) + import at `:69`; router `server/src/routes/certificates.ts`; service `server/src/services/certificates.ts` | **(c) genuinely unsupported** by the current human product direction. Historically planned: docs17 line 64 `A8` and docs18 line 33 ("…وشهادات بشروط") — recorded honestly, now **superseded** | A school product would expose graduation certificates (issue/revoke/verify) the business does not offer |
| 2 | Course-completion / graduation gates | none outside certificates: `lesson_completions` + gradebook feed `computeEligibility` **inside** `routes/certificates.ts:157-195` only | (c) tied to excluded feature; no global completion gate elsewhere | none outside the certificate router |
| 3 | Grading thresholds / policies | `services/gradebook.ts`, `routes/gradebook.ts`, `routes/manual-grading.ts`, `routes/grades.ts`; plan docs17 A6 ("weighted/points policy visible") | **(a) supported** — grading is core school teaching | removing would break teaching; kept untouched |
| 4 | Lesson sequential / drip unlocks | `routes/content-access.ts`; plan docs18 line 31 ("شروط drip والتتابع … مفحوصة بالخادم لكل ملف/فيديو/امتحان/واجب/حصة") | **(a) supported**; docs18 also assumes optional teacher-release prerequisites | kept untouched |
| 5 | Published-course catalog | `routes/courses.ts`, `routes/exams.ts`, `routes/lectures.ts`; plan docs18 line 31 ("دوراتي تعرض البداية والنهاية…") | **(a) supported** — a course is a teaching collection (subject taught by a teacher) | kept untouched |
| 6 | Parent links | `routes/parent-links.ts`, `routes/parent-views.ts` (sibling-owned, untracked); plan docs18 line 35 ("parent link موثّق…") | **(a) supported** by docs18 line 35 | out of this task; no edits made, no inference from file timestamps |
| 7 | Online / offline / month / term / payment access | `routes/subscriptions*.ts`, `routes/fees.ts`, `routes/payment-requests.ts`; plan docs18 lines 29-33, docs19 wallet/agreement | **(a) supported** — this is the platform's commercial model | kept untouched |
| 8 | Teacher / group / branch assumptions | `routes/groups.ts`, `routes/branches.ts`, `security/branch-access.ts`; plan docs17 M5 G1 ("membership is branch/tenant scoped…") | **(a) supported** | kept untouched |

**Explicitly not claimed wrong:** groups, terms/subjects, optional teacher-release prerequisites, parent access, monthly/term payments — the clarification targets **certificates only**. No policy invented.

**Audit conclusion:** exactly one surface in `server/src` is a graduation/certificate artifact and it has **no alternate mounts** — grep `-rni "certificate\|graduat" server/src` (excluding the two definition files) returns only the two documentation comments this task added in `index.ts`.

## 2) TASK2 — implemented exclusion (no deletion)

**Changed (all inside allowedPaths):**

1. `server/src/index.ts` — removed the `certificatesRoutes` import and the `app.use('/api/certificates', …)` mount; left a human-decision comment. No other mount, import, or guard ordering touched (`git diff` above shows exactly 2 hunks).
2. `server/tests/m2-m3-mounting.test.ts` —
   - `EXPECTED_MOUNTS` no longer lists `/api/certificates`; new `EXCLUDED_MOUNTS` records the excluded surface.
   - static test now **proves absence** (`excluded certificate surface is not mounted by the primary server`: no `app.use('/api/certificates'`, no `certificatesRoutes` reference, no occupying mount).
   - the guarded surface drops the certificates router; the anonymous-probe list drops `/api/certificates`; a terminal 404 handler mirroring index.ts was added for the new proof tests.
   - the three old public-verify tests were **replaced, not weakened**: the exposed surface now resolves to the primary 404 handler with **zero storage calls**, and sibling teaching surfaces still deny anonymous callers.
3. `server/tests/teacher-school-product-alignment.test.ts` (**new**, 7 tests): no primary mount; no *other* src file mounts the router (src-wide scan); sources + historic migration preserved on disk (registry + `CREATE TABLE` intact); teaching surfaces (`/api/auth|groups|students|courses|attendance|attendance-records|lectures|videos|materials|question-bank|assignments|exams|exam-versions|gradebook|schedules|student-enrollment|branches`) remain mounted after the guard chain; runtime 404 proof.
4. `docs/17-full-feature-backlog.md` — A8 row marked `superseded — out of scope` + human-decision note (2026-10-19): excluded by owner clarification, **not** an M1/M4 completion blocker, history retained as superseded, no phase rewrite.
5. `docs/18-workflows-and-execution-approval-ar.md` — line 33: the "وشهادات بشروط" clause now carries the same exclusion note inline.

**Preserved (nothing deleted):** `server/src/routes/certificates.ts`, `server/src/services/certificates.ts`, the historic certificates-table migration (`server/migrations/20261018_10_gradebook_certificates.sql:65` — `CREATE TABLE certificates`, verified intact on disk), and all data. `server/tests/m4-certificates.test.ts` is **untouched** — its 30 security/eligibility unit tests (authority matrix, duplicate issuance, public-facts projection, rate limiting) still run green.

**Alternate mounts inspection:** no alternate certificate mount exists in `server/src` (§1 evidence). Frontend is out of scope by boundary and was not inspected or changed.

## 3) TASK3 — other mismatches (evidence + minimal proposed scope; NOT changed)

1. **Certificate exam gate is fail-open (latent, now unreachable).** `routes/certificates.ts:185`: `allExamsPassed = totalExams === 0 ? true : …` — a course with published exams but zero attempt rows issues 201. With the router unmounted this is no longer reachable, but it is a real defect if the feature is ever re-enabled. Minimal proposed fix: count `is_published=1 AND is_active=1` exams as required and demand a `graded` attempt with `passed=1` each — needs the product decision (no "required for certificate" flag exists in schema).
2. **`server/src/services/parent-links.ts:429` typecheck error** (`'deps.otp' is possibly 'undefined'`). Sibling-owned, untracked, outside allowedPaths — not fixed, not attributed; the only tsc error before and after this task.
3. **`playback_entitlements` has no index on `session_id`** (migration `20261018_06_video_assets_entitlements.sql:106-119`) while the now-live secure-delivery code queries by session on manifest/media/segment/key. Needs a new migration — outside this task's boundaries.
4. **`storageStat` is still a null stub** (prior reports) — production submissions stay `pending_upload` / 0 bytes until an upload-finalize pipeline exists.
5. **secure-video unverified assumptions** (read-only listing per task): ambiguous multi-lecture video ownership is denied (`VIDEO_PARENT_AMBIGUOUS` — owner decision pending); lesson-less / staff playback has no entitlement family (access policy remains the authority); `VIDEO_PLAYBACK_SECRET` must be configured before deploy (503 fail-closed otherwise).
6. **`WORKBUDDY-INSTRUCTIONS.md` / `TEAM-OPERATING-MODEL.md` absent from disk** — if they exist elsewhere, they should be added to the repo or their location recorded.

## 4) Verification evidence (actual commands / exits)

| Check | Command (from) | Result |
|---|---|---|
| Focused | `M1_NETWORK_MODE=hermetic node --require ./scripts/m1-network-guard.cjs --import tsx --test server/tests/m2-m3-mounting.test.ts server/tests/teacher-school-product-alignment.test.ts server/tests/m4-certificates.test.ts` (root) | **exit 0 — 41/41 pass** |
| Full hermetic | same guard, `--test server/tests/*.test.ts` (root) | **exit 0 — 1843 tests, 1843 pass, 0 fail** (18.3 s) |
| Full hermetic | `M1_NETWORK_MODE=hermetic node --require ../scripts/m1-network-guard.cjs --import tsx --test tests/*.test.ts` (server cwd) | **exit 0 — 1843/1843** (16.9 s) |
| Typecheck | `node node_modules/typescript/bin/tsc --noEmit` (server) | **exit 2 — 1 error**, `src/services/parent-links.ts(429,31)` — pre-existing, sibling-owned, identical to baseline |
| Diff check | `git status --short` / `git diff --stat` | This task changed only: `docs/17`, `docs/18`, `server/src/index.ts`, `server/tests/m2-m3-mounting.test.ts` (+ new `server/tests/teacher-school-product-alignment.test.ts`). Remaining modified files are the pre-existing 2026-10-18 rounds' work; no frontend, no package/lock, no migration, no manifest |

**Count reconciliation:** baseline 1836 → 1843 (+7 new alignment tests). The mounting file kept the same number of tests: the 3 public-verify tests were replaced by 2 stricter exclusion tests; the static and anonymous-denial tests remain, with the certificate entry replaced by its absence proof. No security/eligibility unit test was skipped or deleted.

## 5) Remaining / needs decision

1. Certificate exam-gate rule (§3.1) if the feature is ever revisited — product decision required.
2. Re-dispatch of the 5 retired `-followup-recovery-01` server claims; blocked review chain `m1-review-implementation-security ← m1-fix-02-frontend/-03-devops/-04-media-sockets` (unchanged).
3. Sibling `parent-links` ownership + typecheck error; the `playback_entitlements.session_id` index migration; the storage upload-finalize pipeline.

**No milestone self-acceptance. Final acceptance is Codex's.**
