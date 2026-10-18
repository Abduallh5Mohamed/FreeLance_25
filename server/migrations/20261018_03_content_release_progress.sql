-- =============================================================================
-- M2 C6/C7 Content Release & Lesson Progress — schema gap migration
-- Task:    m2-server-content-release-sequential-unlock-20261018-03
-- Batch:   m2-server-core-20261018
-- Date:    2026-10-18
-- Scope:   C6 scheduled drip release and C7 sequential lesson unlocking.
--
-- PROVENANCE
--   The C6 release policy needs a server-owned schedule per lecture
--   (release mode, UTC release instant, authoring timezone, sequential
--   prerequisite) plus a materialized release marker so retries are
--   idempotent. The C7 progress service needs an idempotent per-enrollment
--   completion record so the next lesson can be unlocked only after the
--   configured prerequisite lesson is completed. Neither table existed.
--
-- OWNERSHIP
--   Rows are strictly tenant-scoped: every row carries tenant_id and is only
--   ever read/written through a course whose server row proves the tenant. No
--   legacy row is re-scoped, moved or deleted by this file.
--
-- IDEMPOTENCY
--   MySQL has no CREATE TABLE IF NOT EXISTS guard requirement here, but every
--   statement is still wrapped in an information_schema probe + PREPARE/EXECUTE
--   so a re-run is a no-op. No DROP, no TRUNCATE, no FK-disable, no data
--   rewrite.
--
-- !! THIS FILE IS AUTHORING-ONLY. SQL EXECUTION and live/bootstrap validation
--    are OUT OF SCOPE for this batch and require a separately approved isolated
--    bootstrap + live verification step. Do not run under M1 approval.
-- =============================================================================

SET @m2_db = DATABASE();

-- -----------------------------------------------------------------------------
-- lesson_release_policies: C6 drip schedule + C7 prerequisite gate per lecture.
-- release_at is the absolute UTC instant derived from (local release time,
-- release_timezone) at configuration time; released_at is the materialized
-- marker set exactly once by the idempotent release runner.
-- -----------------------------------------------------------------------------
SET @has_release_table = (SELECT COUNT(*) FROM information_schema.TABLES
                          WHERE TABLE_SCHEMA = @m2_db AND TABLE_NAME = 'lesson_release_policies');
SET @sql_release_table = IF(@has_release_table = 0,
    "CREATE TABLE lesson_release_policies (
        lecture_id CHAR(36) NOT NULL,
        tenant_id CHAR(36) NOT NULL,
        course_id CHAR(36) NOT NULL,
        release_mode ENUM('immediate','scheduled','sequential') NOT NULL DEFAULT 'immediate',
        release_at TIMESTAMP NULL COMMENT 'Absolute UTC instant of the scheduled release (C6)',
        release_timezone VARCHAR(64) NOT NULL DEFAULT 'UTC' COMMENT 'IANA timezone the schedule was authored in',
        prerequisite_lecture_id CHAR(36) NULL COMMENT 'Sequential prerequisite lesson (C7)',
        released_at TIMESTAMP NULL COMMENT 'Materialized release marker; set once, idempotent retries',
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        version INT NOT NULL DEFAULT 0,
        PRIMARY KEY (lecture_id),
        KEY idx_lesson_release_course (course_id),
        KEY idx_lesson_release_due (release_mode, release_at, released_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      COMMENT 'C6/C7 per-lecture release policy'",
    'SELECT 1');
PREPARE stmt_release_table FROM @sql_release_table;
EXECUTE stmt_release_table;
DEALLOCATE PREPARE stmt_release_table;

-- -----------------------------------------------------------------------------
-- lesson_completions: C7 idempotent completion record per enrollment+lesson.
-- The UNIQUE key makes a retried completion a no-op instead of a duplicate row.
-- -----------------------------------------------------------------------------
SET @has_completion_table = (SELECT COUNT(*) FROM information_schema.TABLES
                             WHERE TABLE_SCHEMA = @m2_db AND TABLE_NAME = 'lesson_completions');
SET @sql_completion_table = IF(@has_completion_table = 0,
    "CREATE TABLE lesson_completions (
        id CHAR(36) NOT NULL,
        tenant_id CHAR(36) NOT NULL,
        student_enrollment_id CHAR(36) NOT NULL,
        course_id CHAR(36) NOT NULL,
        lecture_id CHAR(36) NOT NULL,
        source VARCHAR(32) NOT NULL DEFAULT 'student',
        completed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uq_lesson_completion (student_enrollment_id, lecture_id),
        KEY idx_lesson_completion_course (student_enrollment_id, course_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      COMMENT 'C7 idempotent lesson completion record'",
    'SELECT 1');
PREPARE stmt_completion_table FROM @sql_completion_table;
EXECUTE stmt_completion_table;
DEALLOCATE PREPARE stmt_completion_table;
