# Schema audit: server/src SQL vs server/migrations (read-only, 2026-10-16)

Method: listed every table the code reads or writes (`FROM/JOIN/INTO/UPDATE`), compared against `CREATE TABLE`/`ALTER TABLE` in `server/migrations/*.sql` (29 files, applied in filename order), then spot-checked columns for the main write paths. Only `server/migrations` was treated as the schema source; loose SQL in `/database`, repo root and `server/*.js` is not a migration path (no runner, see M7). All findings were confirmed in the cited files.

## A. Tables used by code that no migration creates (HIGH)

| Table | Used at | Notes |
|---|---|---|
| `lectures` | routes/lectures.ts (all), routes/instructor-video-requests.ts:83,95,127, routes/videos.ts:2352 | Referenced by FKs in migrations 20260920_05 (`instructor_video_requests`, `instructor_shared_lectures`) and altered in 20260920_05, 20260924_instructor_video_exchange, 20260927. Never created. Fresh install fails at 20260920_05. |
| `messages`, `conversations`, `message_status`, `user_online_status`, `message_deletions` | routes/messages.ts:130,159,189,190,224,322,324,371,581; services/socket.ts:540; routes/files.ts:65 | Only exist in loose `database/messages-schema.sql`, `add-missing-tables.sql`, `add-more-tables.sql`. `messages.ts` also needs `conversations.unread_count_user1/2` (added only in `add-more-tables.sql`). |
| `subscription_plans` | routes/subscription-plans.ts:65,78,115,152+ | No migration. Not to be confused with `platform_plans`. |
| `tenant_custom_domains` | services/domain-verification.ts:377,385,392 (untracked new file) | The module comment says the table is "created by a versioned migration outside this change"; none exists. |

Fix: add migrations (before the first file that references them) with `CREATE TABLE IF NOT EXISTS`. For `tenant_custom_domains` the code requires a UNIQUE key on `hostname` (`ON DUPLICATE KEY UPDATE` at domain-verification.ts:392) and columns `hostname, tenant_id, status, verification_token, txt_name, created_at, updated_at, verified_at`, plus `FOREIGN KEY (tenant_id) REFERENCES tenants(id)` and an index on `tenant_id`. `lectures` needs at least `id, course_id, grade_id, group_id, instructor_id, title, description, video_url, duration_minutes, price, display_order, is_free, is_published, archived_at, created_at, updated_at`, indexes on `(instructor_id)`, `(course_id)`, `(grade_id, group_id)`, and a `video_url` lookup index (the code joins on `CONCAT('video://', v.id)`).

## B. Columns the code uses that no migration defines (HIGH)

1. `exams.grade_id`, `exams.start_dt`, `exams.end_dt`
   - routes/exams.ts:550 (`INSERT INTO exams (..., grade_id, ...)`), :388-418 (`e.grade_id`), :421-432 (`e.start_dt`, `e.end_dt`).
   - Baseline `exams` (20260920_00:230) has no `grade_id`; no migration alters `exams`.
   - Fix: `ALTER TABLE exams ADD COLUMN grade_id CHAR(36) NULL, ADD COLUMN start_dt DATETIME NULL, ADD COLUMN end_dt DATETIME NULL, ADD INDEX idx_exams_grade (grade_id), ADD FOREIGN KEY (grade_id) REFERENCES grades(id) ON DELETE SET NULL;` (idempotent wrapper, see M1).

2. `exam_attempts.status` enum is too small
   - Migration 20260920_07: `ENUM('in_progress','completed','abandoned')`.
   - Code writes `'failed'` (routes/exams.ts:1136,1305,1382,1468), `'passed'`/`'failed'`/`'pending_review'` (exams.ts:1578; exam-results.ts:159; manual-grading.ts:93). Under strict SQL mode these writes raise "Data truncated", so timeouts, submissions and the manual-grading queue fail. The commit "preserve pending essay review status" shows this is live behaviour.
   - Fix: `ALTER TABLE exam_attempts MODIFY status ENUM('in_progress','completed','abandoned','passed','failed','pending_review') NOT NULL DEFAULT 'in_progress';`.
   - Related: `exam_attempts.student_id` FK points to `students(id)` (enrollment id), consistent with the code.

3. `online_meetings.meeting_link`, `meeting_type`, `grade_id`
   - routes/meetings.ts:363 inserts all three. Baseline `online_meetings` (20260920_00:477) has `meeting_url`, no `meeting_type`, no `grade_id`; no migration alters it.
   - Fix: add the three columns (copy `meeting_url` to `meeting_link` for existing rows), add `INDEX (created_by)` and `INDEX (grade_id, group_id)`; both `m.created_by = ?` and the student query at meetings.ts:236 otherwise scan.

4. `videos.encryption_key`, `videos.is_encrypted`
   - routes/secure-video.ts:125,186,340,732-740; routes/videos.ts:1414; routes/instructor-video-requests.ts:86. Not in 20260920_11 or any later ALTER (the only ALTERs are tenant_id, preview_*, drm_*).
   - Fix: `ALTER TABLE videos ADD COLUMN is_encrypted BOOLEAN NOT NULL DEFAULT FALSE, ADD COLUMN encryption_key CHAR(32) NULL;` (and review S2 in security.md: this column is currently returned by `PUT /api/videos/:id`).

5. `students.password_hash` and other baseline-only columns are still returned by `SELECT s.*` (routes/students.ts:67,118). Not a missing column, but the column should be dropped or excluded after migration to `users`.

## C. Ordering errors (HIGH)

- C1. `20260925_01_student_tenant_enrollment.sql` runs `UPDATE students s INNER JOIN groups g ... g.instructor_id` and `t.owner_user_id=g.instructor_id` (lines ~24-27) before `groups.instructor_id` exists. That column is only added in `20260928_runtime_schema_replacement.sql`. On a database built from `server/migrations` this fails with "Unknown column g.instructor_id".
  - Fix: move `ALTER TABLE groups ADD COLUMN instructor_id ...` (and its index) into a file ordered before 20260925_01, or into 20260920_05 next to the lectures/students instructor_id additions.
- C2. `20260920_05_instructor_system.sql` creates FKs to `lectures` before any migration creates it (A). Add the `lectures` creation as 20260920_04.
- C3. `20260924_instructor_video_exchange.sql` header says "Run once after instructor-system-v2.sql" which does not exist; it also alters `lectures` and `videos.thumbnail_key` (thumbnail_key exists in 20260920_11, fine).
- C4. File-number gaps (`_02`, `_04`, `_06` missing in the 20260920 series) suggest files were dropped; confirm nothing referenced them (`_02`/`_04` likely hold the lectures/messages tables).

## D. Non-idempotent migrations (MEDIUM)

There is no migration runner and no tracking table (`package.json` has no `migrate` script; no `schema_migrations`). Re-running any of these fails or duplicates data:
- Plain `ALTER TABLE ... ADD COLUMN` / `ADD INDEX` / `ADD CONSTRAINT` (fail on 2nd run): 20260920_03 (also plain `CREATE INDEX`), 20260920_08, 20260920_09 (also `CREATE INDEX idx_staff_phone`), 20260922_00 (videos, video_processing_queue), 20260924_instructor_topups_auto_renewal (ADD COLUMN/CONSTRAINT on `tenant_subscriptions`), 20260924_instructor_video_exchange, 20260925_01, 20260925_04, 20260925_05, 20260926_student_auth_revocation, 20260926_video_deterrence_controls, 20260927, 20260928.
- Plain `CREATE TABLE` without `IF NOT EXISTS`: 20260924_instructor_topups_auto_renewal (`instructor_topup_requests`, `tenant_renewal_intents`, `platform_revenue_events`), 20260925_02 (`student_enrollment_backfill_reviews`), 20260925_03 (`video_sessions`, `video_security_logs`), 20260926_video_deterrence_controls, 20260928 (`student_fees`, `revenues`, `import_items`), 20260929 (`payment_requests`).
- Data statements that are not re-runnable: 20260925_02 `INSERT ... SELECT UUID()` (relies on a UNIQUE key to fail rather than skip; use `INSERT IGNORE`), 20260925_01 backfills (re-run is safe but quarantines more rows each time), 20260921 tenant seed (`INSERT IGNORE ... UUID()` re-creates nothing because of the UNIQUE owner, fine).
- Duplicate definitions (harmless but confusing): `analyst_calculations`, `tenant_billing_profiles`, `tenant_account_notes` are created in both 20260921_saas_foundation and 20260923_admin_scope_hardening.
- Fix: add a `schema_migrations(version, applied_at)` table plus a small runner (and a CI check that applies all files twice), and make each statement guarded. MySQL has no `ADD COLUMN IF NOT EXISTS`, so use the `INFORMATION_SCHEMA` + `PREPARE` pattern already used in 20260920_05 (lines ~84-98) or switch to a tool (Knex/Flyway).

## E. Tenant isolation at the schema level (HIGH, ties to security.md S3-S9)

Tables used by tenant-facing routes with no `tenant_id`: `groups` (only `instructor_id`, no FK), `grades` (global), `lectures` (`instructor_id`, no FK), `exams` (linked via `exam_groups -> groups`), `exam_results`/`exam_attempts` (via student), `attendance`, `course_materials` (via `courses`), `online_meetings` (`created_by`), `student_registration_requests`, `subscriptions` (via student), `subscription_plans`, `staff`, `premium_lectures` (via group), `notifications` (user only).
- `students.tenant_id` and `students.user_id` (20260925_01) are nullable with no FK to `tenants`/`users`; the migration deliberately leaves unresolved rows `NULL`. Add FKs and, once the backfill-review table is empty, `NOT NULL` on `tenant_id`.
- `groups.instructor_id`, `lectures.instructor_id`, `students.instructor_id`, `online_meetings.created_by` are plain CHAR(36) with no FK to `users(id)`; ownership therefore cannot be enforced by the database.
- `courses.tenant_id` FK is `ON DELETE SET NULL` (20260927), which converts a deleted tenant's courses into public ownerless rows (routes/courses.ts treats `tenant_id IS NULL` as public). Use `RESTRICT`.
- Recommended: add `tenant_id CHAR(36) NOT NULL` + FK + `(tenant_id, ...)` index to `groups`, `lectures`, `exams`, `online_meetings`, `course_materials`, `attendance`, `student_registration_requests`, `subscriptions`, `subscription_plans`; backfill from `tenants.owner_user_id = instructor_id`; make routes filter on it.

## F. Missing or weak indexes (MEDIUM / LOW)

- `students.phone` has no index (baseline indexes: email, barcode, grade_id, group_id, approval_status). Hot lookups: routes/lectures.ts:164, routes/exams.ts (`resolveAttemptStudentId`: `students WHERE phone = ?`), migration 20260925_01 join on `u.phone=s.phone`. Add `INDEX idx_students_phone (phone)` (and `(tenant_id, phone)` for the enrollment flow).
- `online_meetings.created_by` and `.grade_id`: no indexes (see B3).
- `lectures`: no indexes defined anywhere (table not in migrations); list queries filter on `is_published`, `instructor_id`, `course_id`, `grade_id`, `group_id`.
- `attendance`: lookups by `(student_id, attendance_date)` and `(group_id, attendance_date)` exist only as single-column indexes; a UNIQUE `(student_id, attendance_date, course_id)` would also prevent duplicate marks (routes/attendance.ts:526 inserts with `UUID()` and no unique guard).
- `video_sessions`: `UNIQUE (active_user_id)` allows only one active video session per user across all tenants. Intentional for anti-sharing, but means a user enrolled in two tenants cannot watch in both at once; confirm.

## G. Type/collation consistency (MEDIUM)

- Baseline tables, `exam_attempts`, `videos`, `video_*`, `premium_*` are created without `CHARSET/COLLATE`; newer tables use `utf8mb4_unicode_ci`. On MySQL 8 with the default `utf8mb4_0900_ai_ci`, FKs and joins between the two groups (e.g. `tenants.owner_user_id -> users.id` in 20260921, `students.user_id` joins, `t.owner_user_id = s.instructor_id` in 20260925_01) can fail ("incompatible FK") or raise "Illegal mix of collations" at query time. Confirm the database default collation in the target environment and set `DEFAULT CHARSET/COLLATE` explicitly on the baseline.
- `notification_preferences.user_id` and `notifications.user_id` are `VARCHAR(64)` while ids are `CHAR(36)`; no FK, so orphans accumulate on user deletion.
- `instructor_wallets.id`, `instructor_video_requests.id`, `instructor_wallet_transactions.id` are `INT AUTO_INCREMENT` while the rest of the schema is UUID; `platform_revenue_events.wallet_transaction_id INT` follows this. Not a bug, but mixed id types complicate sharding and exports.

## H. Code/schema mismatches in app code (MEDIUM)

- routes/staff.ts:183 uses `result.insertId` (always `0`) for `staff.id`, which is `CHAR(36) DEFAULT (UUID())`; the response returns `id: "0"`. Generate the UUID in code and insert it.
- `users.role` enum (20260920_01) is `admin, teacher, student, instructor, staff`; `middleware/auth.ts:50` and `services/socket.ts:35` also accept `parent`. If `parent` accounts are ever created, inserts will fail until the enum is widened.
- `exams.is_published` is inserted as a literal `1` (routes/exams.ts:551) while the baseline default is FALSE, so exams created by the API are always published; check this is intended.

## Suggested fix order
1. Add missing tables/columns (A, B) and fix ordering (C1, C2) so a fresh DB builds from `server/migrations` alone.
2. Widen `exam_attempts.status` (B2) immediately; it affects live grading.
3. Add `schema_migrations` + idempotency guards (D).
4. Add tenant columns, FKs and indexes (E, F) together with the route fixes in security.md.
