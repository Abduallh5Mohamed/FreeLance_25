-- =============================================================================
-- B2-C-SCHEMA — manual exam grading + progress-report publication schema
-- Task:    b2-c-schema-20261021-01
-- Batch:   batch2-claude-20261021
-- Date:    2026-10-21
-- Purpose: storage for the INJECTED store contracts
--   `server/src/services/exam-manual-grading.ts`  (ManualGradingStore)
--   `server/src/services/progress-publication.ts` (PublicationStore)
--   Contract: docs/contracts/B2-SCHEMA-CONTRACT-20261021.md
--
-- DESIGN
--   1. `exam_manual_answer_revisions`: append-only per-question manual grade
--      history. Awards are exact integer HUNDREDTHS (INT, CHECK >= 0),
--      consistent with the DECIMAL(6,2)/DECIMAL(10,2) point columns of the
--      exam baseline. Every regrade appends revision N+1 for
--      (attempt_id, question_ref); history is never overwritten.
--      UNIQUE (attempt_id, question_ref, revision) is the backstop that makes
--      a duplicate revision write impossible to miss (`duplicate_revision`).
--      The composite FK (attempt_id, question_ref) REFERENCES the EXISTING
--      UNIQUE key of exam_versioned_answers, so a revision can only grade an
--      actual answer row of that attempt — proven without any rebuild.
--   2. `exam_versioned_attempts.reviewer_user_id`: the ONLY attempt-level
--      column added, because it is verified missing (20261018_09 has status,
--      version, score, graded_at, passed but no reviewer). Nullable: the
--      auto-grader path never sets it. The optimistic CAS
--      (status = 'pending_review' AND version = expected) uses the EXISTING
--      `status` and `version` columns — nothing is added for the guard.
--   3. `progress_report_publications`: one row per
--      (tenant_id, student_enrollment_id, course_id) with state
--      draft|published, published_by, published_at and a monotonic version;
--      the UNIQUE key backs both the initial-row race and the version CAS.
--
-- OWNERSHIP
--   Every new table carries tenant_id. FKs reference tables/columns whose
--   uniqueness is ALREADY proven (tenants.id, users.id, students.id,
--   courses.id, exam_versioned_attempts.id PK, and the existing UNIQUE
--   (attempt_id, question_ref) on exam_versioned_answers). No legacy row,
--   column or table is rebuilt, moved or deleted.
--
-- IDEMPOTENCY
--   Every statement is wrapped in an INFORMATION_SCHEMA probe (tables/columns/
--   indexes/constraints) + PREPARE/EXECUTE so a re-run is a no-op. No DROP,
--   no TRUNCATE, no FK-disable, no data rewrite, no runtime DDL.
--
-- !! THIS FILE IS AUTHORING-ONLY. SQL EXECUTION and live bootstrap validation
--    are OUT OF SCOPE for this batch and require a separately approved
--    isolated bootstrap + live verification step before deployment.
-- =============================================================================

SET @b2c_db = DATABASE();

-- -----------------------------------------------------------------------------
-- Step 1: exam_manual_answer_revisions — append-only manual grade revisions.
-- -----------------------------------------------------------------------------
SET @b2c_has_revisions = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
    WHERE TABLE_SCHEMA = @b2c_db AND TABLE_NAME = 'exam_manual_answer_revisions');

SET @b2c_sql_revisions = IF(@b2c_has_revisions = 0,
    "CREATE TABLE exam_manual_answer_revisions (
        id CHAR(36) NOT NULL,
        tenant_id CHAR(36) NOT NULL,
        attempt_id CHAR(36) NOT NULL COMMENT 'exam_versioned_attempts.id',
        question_ref CHAR(36) NOT NULL COMMENT 'Same value domain as exam_versioned_answers.question_ref',
        revision INT NOT NULL DEFAULT 1 COMMENT 'Planned as max(existing)+1 before the transaction',
        awarded_hundredths INT NOT NULL COMMENT 'Exact integer hundredths of an exam point; >= 0',
        reviewer_user_id CHAR(36) NOT NULL COMMENT 'users.id of the grader',
        feedback VARCHAR(2000) NULL COMMENT 'Bounded by MAX_MANUAL_FEEDBACK_LENGTH = 2000',
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT 'Store-supplied absolute UTC instant',
        PRIMARY KEY (id),
        UNIQUE KEY uq_manual_answer_revision (attempt_id, question_ref, revision),
        KEY idx_manual_revisions_tenant (tenant_id, attempt_id),
        CONSTRAINT fk_manual_revision_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id),
        CONSTRAINT fk_manual_revision_attempt FOREIGN KEY (attempt_id) REFERENCES exam_versioned_attempts(id),
        CONSTRAINT fk_manual_revision_answer FOREIGN KEY (attempt_id, question_ref) REFERENCES exam_versioned_answers(attempt_id, question_ref),
        CONSTRAINT fk_manual_revision_reviewer FOREIGN KEY (reviewer_user_id) REFERENCES users(id),
        CONSTRAINT chk_manual_revision_award CHECK (awarded_hundredths >= 0)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      COMMENT 'B2 append-only manual answer-grade revision history'",
    'SELECT 1');
PREPARE b2c_stmt_revisions FROM @b2c_sql_revisions;
EXECUTE b2c_stmt_revisions;
DEALLOCATE PREPARE b2c_stmt_revisions;

-- -----------------------------------------------------------------------------
-- Step 2: exam_versioned_attempts.reviewer_user_id — verified missing on the
-- baseline; guarded ADD COLUMN (nullable, so the auto-grader path is untouched).
-- -----------------------------------------------------------------------------
SET @b2c_has_attempts = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
    WHERE TABLE_SCHEMA = @b2c_db AND TABLE_NAME = 'exam_versioned_attempts');

SET @b2c_has_reviewer_col = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = @b2c_db AND TABLE_NAME = 'exam_versioned_attempts'
      AND COLUMN_NAME = 'reviewer_user_id');

SET @b2c_sql_add_reviewer = IF(@b2c_has_attempts = 1 AND @b2c_has_reviewer_col = 0,
    'ALTER TABLE exam_versioned_attempts ADD COLUMN reviewer_user_id CHAR(36) NULL COMMENT ''Manual grader of the finalize write'' AFTER passed',
    'SELECT 1');
PREPARE b2c_stmt_add_reviewer FROM @b2c_sql_add_reviewer;
EXECUTE b2c_stmt_add_reviewer;
DEALLOCATE PREPARE b2c_stmt_add_reviewer;

-- -----------------------------------------------------------------------------
-- Step 3: FK for the new reviewer column (idempotent name check).
-- The column probe MUST be re-read AFTER Step 2: on the first run
-- @b2c_has_reviewer_col is 0 when the ADD COLUMN is issued, and that variable
-- is not refreshed by MySQL. Using the stale value here silently skipped the
-- FK on a first application. @b2c_has_reviewer_col_after reads the catalog as
-- it stands now; a second run still sees the column and the FK and adds nothing.
-- -----------------------------------------------------------------------------
SET @b2c_has_reviewer_col_after = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = @b2c_db AND TABLE_NAME = 'exam_versioned_attempts'
      AND COLUMN_NAME = 'reviewer_user_id');

SET @b2c_has_reviewer_fk = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
    WHERE CONSTRAINT_SCHEMA = @b2c_db AND TABLE_NAME = 'exam_versioned_attempts'
      AND CONSTRAINT_NAME = 'fk_exam_attempts_reviewer');

SET @b2c_sql_reviewer_fk = IF(@b2c_has_attempts = 1 AND @b2c_has_reviewer_col_after = 1 AND @b2c_has_reviewer_fk = 0,
    'ALTER TABLE exam_versioned_attempts ADD CONSTRAINT fk_exam_attempts_reviewer FOREIGN KEY (reviewer_user_id) REFERENCES users(id) ON DELETE SET NULL',
    'SELECT 1');
PREPARE b2c_stmt_reviewer_fk FROM @b2c_sql_reviewer_fk;
EXECUTE b2c_stmt_reviewer_fk;
DEALLOCATE PREPARE b2c_stmt_reviewer_fk;

-- -----------------------------------------------------------------------------
-- Step 4: progress_report_publications — per-scope published state for the
-- parent-facing progress reports (matches the certificates scope pattern).
-- The UNIQUE key is the storage gate for the initial-row race and the CAS.
-- -----------------------------------------------------------------------------
SET @b2c_has_publications = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
    WHERE TABLE_SCHEMA = @b2c_db AND TABLE_NAME = 'progress_report_publications');

SET @b2c_sql_publications = IF(@b2c_has_publications = 0,
    "CREATE TABLE progress_report_publications (
        id CHAR(36) NOT NULL,
        tenant_id CHAR(36) NOT NULL,
        student_enrollment_id CHAR(36) NOT NULL COMMENT 'students.id enrollment identity',
        course_id CHAR(36) NOT NULL,
        state ENUM('draft','published') NOT NULL DEFAULT 'draft',
        published_by CHAR(36) NULL COMMENT 'Actor of the most recent publish',
        published_at DATETIME NULL,
        version INT NOT NULL DEFAULT 0 COMMENT 'Monotonic counter bumped by every transition',
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uq_progress_publication (tenant_id, student_enrollment_id, course_id),
        KEY idx_progress_publications_course (tenant_id, course_id),
        CONSTRAINT fk_progress_publication_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id),
        CONSTRAINT fk_progress_publication_enrollment FOREIGN KEY (student_enrollment_id) REFERENCES students(id),
        CONSTRAINT fk_progress_publication_course FOREIGN KEY (course_id) REFERENCES courses(id),
        CONSTRAINT fk_progress_publication_published_by FOREIGN KEY (published_by) REFERENCES users(id) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      COMMENT 'B2 progress report publication state per (tenant, enrollment, course)'",
    'SELECT 1');
PREPARE b2c_stmt_publications FROM @b2c_sql_publications;
EXECUTE b2c_stmt_publications;
DEALLOCATE PREPARE b2c_stmt_publications;
