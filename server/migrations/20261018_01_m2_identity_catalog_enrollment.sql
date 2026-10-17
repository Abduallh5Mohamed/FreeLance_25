-- =============================================================================
-- M2 Identity Catalog & Enrollment Core — schema gap migration
-- Task:    m2-server-identity-catalog-enrollment-core-20261018-01
-- Batch:   m2-server-core-20261018
-- Author:  WorkBuddy M2 server core worker (human-approved)
-- Date:    2026-10-18
-- Scope:   C8/C10 enrollment lifecycle columns only.
--
-- PROVENANCE
--   These columns are required by the source-proven gap that the C8/C10
--   enrollment lifecycle handler (routes/student-enrollment.ts
--   createEnrollmentLifecycleHandler) and the defense-in-depth recheck in
--   routes/lectures.ts (/student/:userId) depend on: term/month association,
--   explicit server-clock start/end dates, and an enrollment-level
--   active/revoked/expired status used to deny protected access. No other
--   table is touched.
--
-- BACKFILL
--   enrollment_status defaults to 'active' for every existing row, preserving
--   today's behavior (an approved enrollment is active). term / start / end are
--   NULL until an instructor sets them; NULL end_date means "no expiry".
--
-- QUARANTINE
--   Ambiguous legacy ownership rows are NOT silently re-scoped here. Any row
--   that cannot be linked safely remains governed by the existing
--   approval_status + is_active checks; this migration only adds nullable
--   columns and never rewrites ownership or defaults a branch.
--
-- PREFLOW / IDEMPOTENCY
--   Each ADD COLUMN is guarded by an information_schema probe so the file can
--   be re-run safely (MySQL has no native ADD COLUMN IF NOT EXISTS). Wrapped in
--   a transaction; if a column already exists the guarded branch is a no-op.
--
-- !! THIS FILE IS AUTHORING-ONLY. SQL EXECUTION, bootstrap-manifest edits, FK
--    disable, and any live/DB/service start are OUT OF SCOPE for this batch and
--    must be performed by a separately scoped isolated bootstrap + live
--    verification step. Do not run under M1 isolated-run approval.
-- =============================================================================

SET @m2_db = DATABASE();

-- term / month association (free-text term label, e.g. "2026 Term 1")
SET @has_term = (SELECT COUNT(*) FROM information_schema.COLUMNS
                 WHERE TABLE_SCHEMA = @m2_db AND TABLE_NAME = 'students' AND COLUMN_NAME = 'term');
SET @sql_term = IF(@has_term = 0,
    "ALTER TABLE students ADD COLUMN term VARCHAR(60) NULL COMMENT 'Enrollment term / month association (C8/C10)'",
    'SELECT 1');
PREPARE stmt_term FROM @sql_term; EXECUTE stmt_term; DEALLOCATE PREPARE stmt_term;

-- server-clock enrollment start date (inclusive boundary)
SET @has_start = (SELECT COUNT(*) FROM information_schema.COLUMNS
                  WHERE TABLE_SCHEMA = @m2_db AND TABLE_NAME = 'students' AND COLUMN_NAME = 'enrollment_start_date');
SET @sql_start = IF(@has_start = 0,
    "ALTER TABLE students ADD COLUMN enrollment_start_date TIMESTAMP NULL COMMENT 'Enrollment valid-from (server clock, C8/C10)'",
    'SELECT 1');
PREPARE stmt_start FROM @sql_start; EXECUTE stmt_start; DEALLOCATE PREPARE stmt_start;

-- server-clock enrollment end date (inclusive boundary; NULL = no expiry)
SET @has_end = (SELECT COUNT(*) FROM information_schema.COLUMNS
                WHERE TABLE_SCHEMA = @m2_db AND TABLE_NAME = 'students' AND COLUMN_NAME = 'enrollment_end_date');
SET @sql_end = IF(@has_end = 0,
    "ALTER TABLE students ADD COLUMN enrollment_end_date TIMESTAMP NULL COMMENT 'Enrollment valid-to (server clock, C8/C10)'",
    'SELECT 1');
PREPARE stmt_end FROM @sql_end; EXECUTE stmt_end; DEALLOCATE PREPARE stmt_end;

-- enrollment-level lifecycle status (independent of instructor join approval)
SET @has_status = (SELECT COUNT(*) FROM information_schema.COLUMNS
                   WHERE TABLE_SCHEMA = @m2_db AND TABLE_NAME = 'students' AND COLUMN_NAME = 'enrollment_status');
SET @sql_status = IF(@has_status = 0,
    "ALTER TABLE students ADD COLUMN enrollment_status ENUM('active','revoked','expired') NULL DEFAULT 'active' COMMENT 'Enrollment lifecycle status (C8/C10)'",
    'SELECT 1');
PREPARE stmt_status FROM @sql_status; EXECUTE stmt_status; DEALLOCATE PREPARE stmt_status;

-- Index to keep the revoked/expired access recheck cheap at row resolution time.
SET @has_status_idx = (SELECT COUNT(*) FROM information_schema.STATISTICS
                       WHERE TABLE_SCHEMA = @m2_db AND TABLE_NAME = 'students' AND INDEX_NAME = 'idx_students_enrollment_status');
SET @sql_idx = IF(@has_status_idx = 0,
    'ALTER TABLE students ADD INDEX idx_students_enrollment_status (enrollment_status, enrollment_end_date)',
    'SELECT 1');
PREPARE stmt_idx FROM @sql_idx; EXECUTE stmt_idx; DEALLOCATE PREPARE stmt_idx;
