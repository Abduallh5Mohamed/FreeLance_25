-- =============================================================================
-- M4 A2 + A3 — Timed exams with immutable snapshots + deterministic grading
-- Task:    m4-server-exam-snapshots-grading-20261018-09
-- Batch:   m4-server-assessment-20261018
-- Date:    2026-10-18
-- Scope:   A2 immutable, versioned exam snapshots (pinned question-bank
--          versions, server-authoritative start/deadline/auto-submit window,
--          one attempt per student per exam) and A3 deterministic MCQ
--          auto-grading (integer-hundredths scoring, essay -> pending_review,
--          idempotent regrade with a persisted fingerprint).
--
-- PROVENANCE
--   The legacy `exams` / `exam_questions` rows are mutable and unversioned and
--   the legacy `exam_attempts.answers` blob has no per-question award ledger.
--   Neither can prove that an active attempt read a frozen snapshot, so this
--   migration introduces a parallel, tenant-scoped snapshot model. No legacy
--   row, column or answer is rewritten, moved or deleted.
--
-- OWNERSHIP
--   Every table carries tenant_id and is only ever read/written through a
--   predicate that includes it. Snapshot questions pin a question-bank version
--   (source_version_id) so publishing freezes content; a NULL provenance is a
--   historical/unpinned row, never a shared row. Answer keys live only in the
--   snapshot tables and are never projected to a student before grading.
--
-- TENSOR CONTRACT (server clock is authoritative)
--   opens_at / closes_at / started_at / deadline_at store explicit UTC DATETIME
--   instants. duration_seconds is the attempt budget; deadline_at is minted by
--   the server as min(start + duration, closes_at). client timestamps are never
--   trusted.
--
-- IDEMPOTENCY
--   Every statement is wrapped in an information_schema probe + PREPARE/EXECUTE
--   so a re-run is a no-op. exam_grading_runs carries a UNIQUE key on
--   (attempt_id, idempotency_key) so a repeated grading pass cannot double-apply;
--   exam_versioned_attempts has a UNIQUE key on (exam_id, student_enrollment_id)
--   so one attempt per student per exam is enforced at the storage boundary.
--   No DROP, no TRUNCATE, no FK-disable, no data rewrite, no runtime DDL.
--
-- !! THIS FILE IS AUTHORING-ONLY. SQL EXECUTION and live/bootstrap validation
--    are OUT OF SCOPE for this batch and require a separately approved isolated
--    bootstrap + live verification step before deployment.
-- =============================================================================

SET @m4_db = DATABASE();

-- -----------------------------------------------------------------------------
-- exam_versions: a frozen, versioned snapshot header for one legacy exam.
-- A row becomes immutable once status='published'.
-- -----------------------------------------------------------------------------
SET @has_exam_versions = (SELECT COUNT(*) FROM information_schema.TABLES
    WHERE TABLE_SCHEMA = @m4_db AND TABLE_NAME = 'exam_versions');
SET @sql_exam_versions = IF(@has_exam_versions = 0,
    "CREATE TABLE exam_versions (
        id CHAR(36) NOT NULL,
        exam_id CHAR(36) NOT NULL,
        tenant_id CHAR(36) NOT NULL,
        version INT NOT NULL DEFAULT 1,
        status ENUM('draft','published','archived') NOT NULL DEFAULT 'draft',
        duration_seconds INT NOT NULL DEFAULT 3600,
        opens_at DATETIME NULL COMMENT 'Absolute UTC instant the exam opens',
        closes_at DATETIME NULL COMMENT 'Absolute UTC instant the exam closes',
        grace_seconds INT NOT NULL DEFAULT 0 COMMENT 'Auto-submit grace window after the attempt deadline',
        total_points DECIMAL(10,2) NOT NULL DEFAULT 0,
        passing_points DECIMAL(10,2) NOT NULL DEFAULT 0,
        scoring_policy JSON NULL COMMENT 'versioned deterministic scoring rubric',
        published_at DATETIME NULL,
        created_by CHAR(36) NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        version_lock INT NOT NULL DEFAULT 0,
        PRIMARY KEY (id),
        UNIQUE KEY uq_exam_version (exam_id, version),
        KEY idx_exam_versions_tenant (tenant_id),
        KEY idx_exam_versions_tenant_status (tenant_id, status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      COMMENT 'M4 A2 immutable versioned exam snapshot header'",
    'SELECT 1');
PREPARE stmt_exam_versions FROM @sql_exam_versions;
EXECUTE stmt_exam_versions;
DEALLOCATE PREPARE stmt_exam_versions;

-- -----------------------------------------------------------------------------
-- exam_version_questions: the frozen question content of one snapshot. The
-- answer key (correct_answers) is stored here and only read by the grading path.
-- -----------------------------------------------------------------------------
SET @has_exam_version_questions = (SELECT COUNT(*) FROM information_schema.TABLES
    WHERE TABLE_SCHEMA = @m4_db AND TABLE_NAME = 'exam_version_questions');
SET @sql_exam_version_questions = IF(@has_exam_version_questions = 0,
    "CREATE TABLE exam_version_questions (
        id CHAR(36) NOT NULL,
        exam_version_id CHAR(36) NOT NULL,
        tenant_id CHAR(36) NOT NULL,
        position INT NOT NULL,
        question_id CHAR(36) NULL COMMENT 'Pinned question-bank head id provenance',
        question_version INT NULL COMMENT 'Pinned question-bank version',
        source_version_id CHAR(36) NULL COMMENT 'question_bank_versions.id that was copied',
        question_type ENUM('single_choice','multiple_choice','true_false','essay') NOT NULL,
        question_text TEXT NOT NULL,
        options JSON NULL,
        correct_answers JSON NULL,
        points DECIMAL(6,2) NOT NULL DEFAULT 1.00,
        explanation TEXT NULL,
        content_hash CHAR(64) NULL COMMENT 'SHA-256 over the frozen content',
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uq_exam_version_question (exam_version_id, position),
        KEY idx_exam_version_questions_tenant (tenant_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      COMMENT 'M4 A2 frozen question content per exam snapshot'",
    'SELECT 1');
PREPARE stmt_exam_version_questions FROM @sql_exam_version_questions;
EXECUTE stmt_exam_version_questions;
DEALLOCATE PREPARE stmt_exam_version_questions;

-- -----------------------------------------------------------------------------
-- exam_versioned_attempts: one attempt per student per exam, bound to exactly
-- one snapshot version. The UNIQUE key enforces the single-attempt invariant.
-- -----------------------------------------------------------------------------
SET @has_exam_versioned_attempts = (SELECT COUNT(*) FROM information_schema.TABLES
    WHERE TABLE_SCHEMA = @m4_db AND TABLE_NAME = 'exam_versioned_attempts');
SET @sql_exam_versioned_attempts = IF(@has_exam_versioned_attempts = 0,
    "CREATE TABLE exam_versioned_attempts (
        id CHAR(36) NOT NULL,
        tenant_id CHAR(36) NOT NULL,
        exam_id CHAR(36) NOT NULL,
        exam_version_id CHAR(36) NOT NULL,
        student_enrollment_id CHAR(36) NOT NULL,
        student_user_id CHAR(36) NOT NULL,
        status ENUM('in_progress','pending_review','graded','expired') NOT NULL DEFAULT 'in_progress',
        started_at DATETIME NOT NULL,
        deadline_at DATETIME NOT NULL COMMENT 'Server-minted min(start+duration, closes_at)',
        submitted_at DATETIME NULL,
        auto_submitted TINYINT(1) NOT NULL DEFAULT 0,
        auto_score DECIMAL(10,2) NULL,
        score DECIMAL(10,2) NULL,
        manual_required TINYINT(1) NOT NULL DEFAULT 0,
        grading_fingerprint CHAR(64) NULL COMMENT 'Deterministic fingerprint of the last grading input',
        graded_at DATETIME NULL,
        passed TINYINT(1) NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        version INT NOT NULL DEFAULT 0,
        PRIMARY KEY (id),
        UNIQUE KEY uq_exam_attempt_student (exam_id, student_enrollment_id),
        KEY idx_exam_attempts_tenant (tenant_id, exam_id),
        KEY idx_exam_attempts_enrollment (student_enrollment_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      COMMENT 'M4 A2 one snapshot-bound attempt per student per exam'",
    'SELECT 1');
PREPARE stmt_exam_versioned_attempts FROM @sql_exam_versioned_attempts;
EXECUTE stmt_exam_versioned_attempts;
DEALLOCATE PREPARE stmt_exam_versioned_attempts;

-- -----------------------------------------------------------------------------
-- exam_versioned_answers: append-only per-question award ledger. The UNIQUE key
-- (attempt_id, question_ref) makes a repeated apply a single row.
-- -----------------------------------------------------------------------------
SET @has_exam_versioned_answers = (SELECT COUNT(*) FROM information_schema.TABLES
    WHERE TABLE_SCHEMA = @m4_db AND TABLE_NAME = 'exam_versioned_answers');
SET @sql_exam_versioned_answers = IF(@has_exam_versioned_answers = 0,
    "CREATE TABLE exam_versioned_answers (
        id CHAR(36) NOT NULL,
        tenant_id CHAR(36) NOT NULL,
        attempt_id CHAR(36) NOT NULL,
        exam_version_id CHAR(36) NOT NULL,
        question_ref CHAR(36) NOT NULL COMMENT 'exam_version_questions.id',
        question_type ENUM('single_choice','multiple_choice','true_false','essay') NOT NULL,
        response JSON NULL COMMENT 'Student response, never an answer key',
        awarded_points DECIMAL(6,2) NULL COMMENT 'NULL for manual-only questions',
        is_correct TINYINT(1) NULL,
        manual_review TINYINT(1) NOT NULL DEFAULT 0,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uq_exam_answer (attempt_id, question_ref),
        KEY idx_exam_answers_tenant (tenant_id, attempt_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      COMMENT 'M4 A3 per-question deterministic award ledger'",
    'SELECT 1');
PREPARE stmt_exam_versioned_answers FROM @sql_exam_versioned_answers;
EXECUTE stmt_exam_versioned_answers;
DEALLOCATE PREPARE stmt_exam_versioned_answers;

-- -----------------------------------------------------------------------------
-- exam_grading_runs: idempotency + audit ledger for each grading pass. The
-- UNIQUE key (attempt_id, idempotency_key) is the storage-level "no double
-- apply" gate; applied=0 records a detected no-op regrade.
-- -----------------------------------------------------------------------------
SET @has_exam_grading_runs = (SELECT COUNT(*) FROM information_schema.TABLES
    WHERE TABLE_SCHEMA = @m4_db AND TABLE_NAME = 'exam_grading_runs');
SET @sql_exam_grading_runs = IF(@has_exam_grading_runs = 0,
    "CREATE TABLE exam_grading_runs (
        id CHAR(36) NOT NULL,
        tenant_id CHAR(36) NOT NULL,
        attempt_id CHAR(36) NOT NULL,
        exam_version_id CHAR(36) NOT NULL,
        idempotency_key CHAR(64) NOT NULL COMMENT 'Deterministic grading fingerprint',
        auto_score DECIMAL(10,2) NOT NULL DEFAULT 0,
        manual_required TINYINT(1) NOT NULL DEFAULT 0,
        applied TINYINT(1) NOT NULL DEFAULT 1,
        created_by CHAR(36) NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uq_exam_grading_run (attempt_id, idempotency_key),
        KEY idx_exam_grading_runs_tenant (tenant_id, attempt_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      COMMENT 'M4 A3 idempotent grading run ledger'",
    'SELECT 1');
PREPARE stmt_exam_grading_runs FROM @sql_exam_grading_runs;
EXECUTE stmt_exam_grading_runs;
DEALLOCATE PREPARE stmt_exam_grading_runs;
