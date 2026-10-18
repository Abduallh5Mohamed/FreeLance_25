-- =============================================================================
-- M4 A1 + A5 — Question bank and assignments/submissions — schema migration
-- Task:    m4-server-question-bank-assignments-20261018-08
-- Batch:   m4-server-assessment-20261018
-- Date:    2026-10-18
-- Scope:   A1 reusable tenant-owned question bank (tagged, versioned, soft
--          archive, branch/tenant scope) and A5 assignments with private file
--          submissions (tenant-timezone deadline, late policy, size/type
--          limits, scan status, resubmission versions, revoke policy).
--
-- PROVENANCE
--   Neither a versioned tenant-owned question bank nor an assignment/submission
--   store existed. The legacy `exam_questions` rows are exam-bound and
--   unversioned, so they cannot serve reuse or immutability guarantees.
--
-- OWNERSHIP
--   Rows are strictly tenant-scoped: every table carries tenant_id and is only
--   ever read/written through a predicate that includes it. Branch columns are
--   optional refinements of a tenant-owned row; a NULL branch is a tenant-level
--   row, never a shared row. No legacy row is re-scoped, moved or deleted.
--
-- PRIVATE FILES
--   assignment_submissions.storage_key is an opaque private reference. The
--   schema deliberately stores NO public URL column; scan_status is
--   server-owned and defaults to 'pending'.
--
-- IDEMPOTENCY
--   Every statement is wrapped in an information_schema probe + PREPARE/EXECUTE
--   so a re-run is a no-op. No DROP, no TRUNCATE, no FK-disable, no data
--   rewrite, no runtime DDL.
--
-- !! THIS FILE IS AUTHORING-ONLY. SQL EXECUTION and live/bootstrap validation
--    are OUT OF SCOPE for this batch and require a separately approved isolated
--    bootstrap + live verification step before deployment.
-- =============================================================================

SET @m4_db = DATABASE();

-- -----------------------------------------------------------------------------
-- question_bank_questions: current (head) revision of a tenant-owned question.
-- `current_version` points at the newest immutable row in
-- question_bank_versions; the columns here mirror that version for fast reads.
-- -----------------------------------------------------------------------------
SET @has_qb_questions = (SELECT COUNT(*) FROM information_schema.TABLES
    WHERE TABLE_SCHEMA = @m4_db AND TABLE_NAME = 'question_bank_questions');
SET @sql_qb_questions = IF(@has_qb_questions = 0,
    "CREATE TABLE question_bank_questions (
        id CHAR(36) NOT NULL,
        tenant_id CHAR(36) NOT NULL,
        branch_id CHAR(36) NULL COMMENT 'Set only when branch_scope=branch',
        branch_scope ENUM('tenant','branch') NOT NULL DEFAULT 'tenant',
        question_type ENUM('single_choice','multiple_choice','true_false','essay') NOT NULL,
        question_text TEXT NOT NULL,
        options JSON NULL,
        correct_answers JSON NULL,
        points DECIMAL(6,2) NOT NULL DEFAULT 1.00,
        explanation TEXT NULL,
        tags JSON NULL,
        current_version INT NOT NULL DEFAULT 1,
        archived_at TIMESTAMP NULL,
        created_by CHAR(36) NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        version INT NOT NULL DEFAULT 0,
        PRIMARY KEY (id),
        KEY idx_qb_questions_tenant (tenant_id),
        KEY idx_qb_questions_tenant_type (tenant_id, question_type),
        KEY idx_qb_questions_tenant_archived (tenant_id, archived_at),
        KEY idx_qb_questions_branch (tenant_id, branch_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      COMMENT 'M4 A1 tenant-owned question bank head revision'",
    'SELECT 1');
PREPARE stmt_qb_questions FROM @sql_qb_questions;
EXECUTE stmt_qb_questions;
DEALLOCATE PREPARE stmt_qb_questions;

-- -----------------------------------------------------------------------------
-- question_bank_versions: append-only immutable revisions. A version referenced
-- by a published exam (question_bank_version_usages.exam_published=1) is locked.
-- -----------------------------------------------------------------------------
SET @has_qb_versions = (SELECT COUNT(*) FROM information_schema.TABLES
    WHERE TABLE_SCHEMA = @m4_db AND TABLE_NAME = 'question_bank_versions');
SET @sql_qb_versions = IF(@has_qb_versions = 0,
    "CREATE TABLE question_bank_versions (
        id CHAR(36) NOT NULL,
        question_id CHAR(36) NOT NULL,
        tenant_id CHAR(36) NOT NULL,
        version INT NOT NULL,
        question_type ENUM('single_choice','multiple_choice','true_false','essay') NOT NULL,
        question_text TEXT NOT NULL,
        options JSON NULL,
        correct_answers JSON NULL,
        points DECIMAL(6,2) NOT NULL DEFAULT 1.00,
        explanation TEXT NULL,
        tags JSON NULL,
        created_by CHAR(36) NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uq_qb_version (question_id, version),
        KEY idx_qb_versions_tenant (tenant_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      COMMENT 'M4 A1 append-only immutable question revisions'",
    'SELECT 1');
PREPARE stmt_qb_versions FROM @sql_qb_versions;
EXECUTE stmt_qb_versions;
DEALLOCATE PREPARE stmt_qb_versions;

-- -----------------------------------------------------------------------------
-- question_bank_version_usages: forward-compatible usage provenance written by
-- the exams domain (A2). `exam_published=1` locks the referenced version.
-- -----------------------------------------------------------------------------
SET @has_qb_usages = (SELECT COUNT(*) FROM information_schema.TABLES
    WHERE TABLE_SCHEMA = @m4_db AND TABLE_NAME = 'question_bank_version_usages');
SET @sql_qb_usages = IF(@has_qb_usages = 0,
    "CREATE TABLE question_bank_version_usages (
        id CHAR(36) NOT NULL,
        question_id CHAR(36) NOT NULL,
        version_id CHAR(36) NOT NULL,
        tenant_id CHAR(36) NOT NULL,
        version INT NOT NULL,
        exam_id CHAR(36) NOT NULL,
        exam_published TINYINT(1) NOT NULL DEFAULT 0,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uq_qb_usage (version_id, exam_id),
        KEY idx_qb_usage_question (question_id, version, exam_published),
        KEY idx_qb_usage_tenant (tenant_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      COMMENT 'M4 A1 published-exam usage provenance (immutability lock)'",
    'SELECT 1');
PREPARE stmt_qb_usages FROM @sql_qb_usages;
EXECUTE stmt_qb_usages;
DEALLOCATE PREPARE stmt_qb_usages;

-- -----------------------------------------------------------------------------
-- assignments: tenant-owned assignment definition. deadline_at is the absolute
-- UTC instant derived from (deadline wall time, deadline_timezone). audience is
-- exactly one of: tenant-wide, a branch, or a course/group target.
-- -----------------------------------------------------------------------------
SET @has_assignments = (SELECT COUNT(*) FROM information_schema.TABLES
    WHERE TABLE_SCHEMA = @m4_db AND TABLE_NAME = 'assignments');
SET @sql_assignments = IF(@has_assignments = 0,
    "CREATE TABLE assignments (
        id CHAR(36) NOT NULL,
        tenant_id CHAR(36) NOT NULL,
        branch_id CHAR(36) NULL COMMENT 'Set only when branch_scope=branch',
        branch_scope ENUM('tenant','branch') NOT NULL DEFAULT 'tenant',
        course_id CHAR(36) NULL,
        group_id CHAR(36) NULL,
        title VARCHAR(255) NOT NULL,
        instructions TEXT NULL,
        deadline_at TIMESTAMP NULL COMMENT 'Absolute UTC instant of the deadline',
        deadline_timezone VARCHAR(64) NOT NULL DEFAULT 'UTC' COMMENT 'IANA timezone the deadline was authored in',
        late_policy ENUM('block','mark_late','accept') NOT NULL DEFAULT 'block',
        resubmission_policy ENUM('allow','block') NOT NULL DEFAULT 'allow',
        max_submissions INT NOT NULL DEFAULT 5,
        max_file_bytes BIGINT NOT NULL DEFAULT 26214400,
        allowed_file_types JSON NULL,
        status ENUM('draft','published','closed') NOT NULL DEFAULT 'draft',
        archived_at TIMESTAMP NULL,
        created_by CHAR(36) NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        version INT NOT NULL DEFAULT 0,
        PRIMARY KEY (id),
        KEY idx_assignments_tenant (tenant_id),
        KEY idx_assignments_tenant_status (tenant_id, status),
        KEY idx_assignments_branch (tenant_id, branch_id),
        KEY idx_assignments_course (tenant_id, course_id),
        KEY idx_assignments_group (tenant_id, group_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      COMMENT 'M4 A5 tenant-owned assignment definition'",
    'SELECT 1');
PREPARE stmt_assignments FROM @sql_assignments;
EXECUTE stmt_assignments;
DEALLOCATE PREPARE stmt_assignments;

-- -----------------------------------------------------------------------------
-- assignment_submissions: append-only private file-submission versions. The
-- UNIQUE key (assignment, enrollment, version) makes retries idempotent. No
-- public URL column exists; storage_key is a private opaque reference and
-- scan_status is server-owned.
-- -----------------------------------------------------------------------------
SET @has_submissions = (SELECT COUNT(*) FROM information_schema.TABLES
    WHERE TABLE_SCHEMA = @m4_db AND TABLE_NAME = 'assignment_submissions');
SET @sql_submissions = IF(@has_submissions = 0,
    "CREATE TABLE assignment_submissions (
        id CHAR(36) NOT NULL,
        tenant_id CHAR(36) NOT NULL,
        assignment_id CHAR(36) NOT NULL,
        student_enrollment_id CHAR(36) NOT NULL,
        student_user_id CHAR(36) NOT NULL,
        version INT NOT NULL DEFAULT 1,
        status ENUM('submitted','late','revoked') NOT NULL DEFAULT 'submitted',
        file_name VARCHAR(255) NOT NULL,
        file_type VARCHAR(120) NOT NULL,
        file_size_bytes BIGINT NOT NULL,
        storage_key VARCHAR(255) NOT NULL COMMENT 'Private opaque reference; never a public URL',
        scan_status ENUM('pending','clean','infected','failed') NOT NULL DEFAULT 'pending',
        is_late TINYINT(1) NOT NULL DEFAULT 0,
        submitted_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        revoked_at TIMESTAMP NULL,
        revoked_by CHAR(36) NULL,
        revoke_reason VARCHAR(255) NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uq_assignment_submission_version (assignment_id, student_enrollment_id, version),
        KEY idx_assignment_submissions_tenant (tenant_id, assignment_id),
        KEY idx_assignment_submissions_student (student_enrollment_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      COMMENT 'M4 A5 private resubmission versions with scan status'",
    'SELECT 1');
PREPARE stmt_submissions FROM @sql_submissions;
EXECUTE stmt_submissions;
DEALLOCATE PREPARE stmt_submissions;
