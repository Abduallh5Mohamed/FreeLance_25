-- =============================================================================
-- M6 P6 — lesson comments and Q&A (threads, replies, moderation, reports, blocks)
-- Task:    m6-server-lesson-discussions-20261018-16
-- Date:    2026-10-18
-- Scope:   P6 enrolled-only lesson discussion: threads/replies with length
--          limits, teacher moderation (hide/delete with reason), reporting and
--          blocking, soft delete + retention window, and per-user rate limits.
--
-- AUTHORING-ONLY / NOT EXECUTED. The application never runs DDL at runtime; an
-- operator applies this file on the isolated bootstrap/validation stack. Every
-- statement is guarded by an INFORMATION_SCHEMA probe and PREPARE/EXECUTE, so
-- re-running it is a no-op. No DROP, TRUNCATE, FK-disable or data rewrite.
--
-- MODEL
--   lesson_discussion_threads  — one Q&A thread started on a published lesson.
--                                Author/role, moderation state, soft-delete
--                                marker and an explicit retention window field.
--   lesson_discussion_replies  — replies on a thread; same moderation/retention
--                                columns. reply_count/last_activity_at on the
--                                parent thread drive the listing order.
--   lesson_discussion_reports  — abuse reports against a thread/reply. A unique
--                                key dedupes one reporter per target.
--   lesson_discussion_blocks   — a user's block list, scoped to one tenant. A
--                                block only hides content; it never mutates it.
--
-- ISOLATION
--   Every table carries tenant_id and is only read/written through a predicate
--   that includes it. Enrollment/lesson access is re-checked by the route from
--   the trusted content-access policy on every request; these tables never
--   carry authorization by themselves.
-- =============================================================================

SET @m6_p6_db = DATABASE();

-- -----------------------------------------------------------------------------
-- lesson_discussion_threads
-- -----------------------------------------------------------------------------
SET @has_threads = (SELECT COUNT(*) FROM information_schema.TABLES
    WHERE TABLE_SCHEMA = @m6_p6_db AND TABLE_NAME = 'lesson_discussion_threads');
SET @sql_threads = IF(@has_threads = 0,
    "CREATE TABLE lesson_discussion_threads (
        id CHAR(36) NOT NULL,
        tenant_id CHAR(36) NOT NULL,
        lecture_id CHAR(36) NOT NULL,
        course_id CHAR(36) NOT NULL,
        author_user_id VARCHAR(64) NOT NULL,
        author_role VARCHAR(20) NOT NULL,
        title VARCHAR(160) NOT NULL,
        body TEXT NOT NULL,
        status ENUM('open','hidden','deleted') NOT NULL DEFAULT 'open',
        hidden_reason VARCHAR(300) NULL,
        moderated_by VARCHAR(64) NULL,
        moderated_at TIMESTAMP NULL,
        deleted_at TIMESTAMP NULL,
        retention_expires_at TIMESTAMP NULL COMMENT 'Soft-delete retention window end (purge after this instant)',
        reply_count INT NOT NULL DEFAULT 0,
        last_activity_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        version INT NOT NULL DEFAULT 0,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY idx_disc_threads_lecture (tenant_id, lecture_id, last_activity_at),
        KEY idx_disc_threads_author (tenant_id, author_user_id),
        KEY idx_disc_threads_retention (retention_expires_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      COMMENT 'M6 P6 lesson Q&A thread'",
    'SELECT 1');
PREPARE stmt_disc_threads FROM @sql_threads;
EXECUTE stmt_disc_threads;
DEALLOCATE PREPARE stmt_disc_threads;

-- -----------------------------------------------------------------------------
-- lesson_discussion_replies
-- -----------------------------------------------------------------------------
SET @has_replies = (SELECT COUNT(*) FROM information_schema.TABLES
    WHERE TABLE_SCHEMA = @m6_p6_db AND TABLE_NAME = 'lesson_discussion_replies');
SET @sql_replies = IF(@has_replies = 0,
    "CREATE TABLE lesson_discussion_replies (
        id CHAR(36) NOT NULL,
        thread_id CHAR(36) NOT NULL,
        tenant_id CHAR(36) NOT NULL,
        author_user_id VARCHAR(64) NOT NULL,
        author_role VARCHAR(20) NOT NULL,
        body TEXT NOT NULL,
        status ENUM('visible','hidden','deleted') NOT NULL DEFAULT 'visible',
        hidden_reason VARCHAR(300) NULL,
        moderated_by VARCHAR(64) NULL,
        moderated_at TIMESTAMP NULL,
        deleted_at TIMESTAMP NULL,
        retention_expires_at TIMESTAMP NULL COMMENT 'Soft-delete retention window end (purge after this instant)',
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY idx_disc_replies_thread (tenant_id, thread_id, created_at),
        KEY idx_disc_replies_author (tenant_id, author_user_id),
        KEY idx_disc_replies_retention (retention_expires_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      COMMENT 'M6 P6 lesson Q&A reply'",
    'SELECT 1');
PREPARE stmt_disc_replies FROM @sql_replies;
EXECUTE stmt_disc_replies;
DEALLOCATE PREPARE stmt_disc_replies;

-- -----------------------------------------------------------------------------
-- lesson_discussion_reports
-- -----------------------------------------------------------------------------
SET @has_reports = (SELECT COUNT(*) FROM information_schema.TABLES
    WHERE TABLE_SCHEMA = @m6_p6_db AND TABLE_NAME = 'lesson_discussion_reports');
SET @sql_reports = IF(@has_reports = 0,
    "CREATE TABLE lesson_discussion_reports (
        id CHAR(36) NOT NULL,
        tenant_id CHAR(36) NOT NULL,
        target_type ENUM('thread','reply') NOT NULL,
        target_id CHAR(36) NOT NULL,
        reporter_user_id VARCHAR(64) NOT NULL,
        reason VARCHAR(300) NOT NULL,
        status ENUM('open','reviewed','dismissed') NOT NULL DEFAULT 'open',
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        reviewed_by VARCHAR(64) NULL,
        reviewed_at TIMESTAMP NULL,
        PRIMARY KEY (id),
        UNIQUE KEY uq_disc_report (tenant_id, target_type, target_id, reporter_user_id),
        KEY idx_disc_reports_queue (tenant_id, status, created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      COMMENT 'M6 P6 abuse report against a thread/reply'",
    'SELECT 1');
PREPARE stmt_disc_reports FROM @sql_reports;
EXECUTE stmt_disc_reports;
DEALLOCATE PREPARE stmt_disc_reports;

-- -----------------------------------------------------------------------------
-- lesson_discussion_blocks
-- -----------------------------------------------------------------------------
SET @has_blocks = (SELECT COUNT(*) FROM information_schema.TABLES
    WHERE TABLE_SCHEMA = @m6_p6_db AND TABLE_NAME = 'lesson_discussion_blocks');
SET @sql_blocks = IF(@has_blocks = 0,
    "CREATE TABLE lesson_discussion_blocks (
        id CHAR(36) NOT NULL,
        tenant_id CHAR(36) NOT NULL,
        blocker_user_id VARCHAR(64) NOT NULL,
        blocked_user_id VARCHAR(64) NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uq_disc_block (tenant_id, blocker_user_id, blocked_user_id),
        KEY idx_disc_blocks_blocked (tenant_id, blocked_user_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      COMMENT 'M6 P6 per-tenant user block list (visibility filter only)'",
    'SELECT 1');
PREPARE stmt_disc_blocks FROM @sql_blocks;
EXECUTE stmt_disc_blocks;
DEALLOCATE PREPARE stmt_disc_blocks;

-- -----------------------------------------------------------------------------
-- Foreign keys, added separately and guarded by name so a partial re-run
-- (for example an interrupted first attempt) converges without error.
-- -----------------------------------------------------------------------------
SET @fk_disc_threads_tenant = (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
    WHERE CONSTRAINT_SCHEMA = @m6_p6_db AND TABLE_NAME = 'lesson_discussion_threads'
      AND CONSTRAINT_NAME = 'fk_disc_threads_tenant' AND CONSTRAINT_TYPE = 'FOREIGN KEY');
SET @sql_fk_disc_threads_tenant = IF(@fk_disc_threads_tenant = 0,
    "ALTER TABLE lesson_discussion_threads ADD CONSTRAINT fk_disc_threads_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE",
    'SELECT 1');
PREPARE stmt_fk_disc_threads_tenant FROM @sql_fk_disc_threads_tenant;
EXECUTE stmt_fk_disc_threads_tenant;
DEALLOCATE PREPARE stmt_fk_disc_threads_tenant;

SET @fk_disc_replies_thread = (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
    WHERE CONSTRAINT_SCHEMA = @m6_p6_db AND TABLE_NAME = 'lesson_discussion_replies'
      AND CONSTRAINT_NAME = 'fk_disc_replies_thread' AND CONSTRAINT_TYPE = 'FOREIGN KEY');
SET @sql_fk_disc_replies_thread = IF(@fk_disc_replies_thread = 0,
    "ALTER TABLE lesson_discussion_replies ADD CONSTRAINT fk_disc_replies_thread FOREIGN KEY (thread_id) REFERENCES lesson_discussion_threads(id) ON DELETE CASCADE",
    'SELECT 1');
PREPARE stmt_fk_disc_replies_thread FROM @sql_fk_disc_replies_thread;
EXECUTE stmt_fk_disc_replies_thread;
DEALLOCATE PREPARE stmt_fk_disc_replies_thread;

SET @fk_disc_replies_tenant = (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
    WHERE CONSTRAINT_SCHEMA = @m6_p6_db AND TABLE_NAME = 'lesson_discussion_replies'
      AND CONSTRAINT_NAME = 'fk_disc_replies_tenant' AND CONSTRAINT_TYPE = 'FOREIGN KEY');
SET @sql_fk_disc_replies_tenant = IF(@fk_disc_replies_tenant = 0,
    "ALTER TABLE lesson_discussion_replies ADD CONSTRAINT fk_disc_replies_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE",
    'SELECT 1');
PREPARE stmt_fk_disc_replies_tenant FROM @sql_fk_disc_replies_tenant;
EXECUTE stmt_fk_disc_replies_tenant;
DEALLOCATE PREPARE stmt_fk_disc_replies_tenant;

SET @fk_disc_reports_tenant = (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
    WHERE CONSTRAINT_SCHEMA = @m6_p6_db AND TABLE_NAME = 'lesson_discussion_reports'
      AND CONSTRAINT_NAME = 'fk_disc_reports_tenant' AND CONSTRAINT_TYPE = 'FOREIGN KEY');
SET @sql_fk_disc_reports_tenant = IF(@fk_disc_reports_tenant = 0,
    "ALTER TABLE lesson_discussion_reports ADD CONSTRAINT fk_disc_reports_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE",
    'SELECT 1');
PREPARE stmt_fk_disc_reports_tenant FROM @sql_fk_disc_reports_tenant;
EXECUTE stmt_fk_disc_reports_tenant;
DEALLOCATE PREPARE stmt_fk_disc_reports_tenant;

SET @fk_disc_blocks_tenant = (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
    WHERE CONSTRAINT_SCHEMA = @m6_p6_db AND TABLE_NAME = 'lesson_discussion_blocks'
      AND CONSTRAINT_NAME = 'fk_disc_blocks_tenant' AND CONSTRAINT_TYPE = 'FOREIGN KEY');
SET @sql_fk_disc_blocks_tenant = IF(@fk_disc_blocks_tenant = 0,
    "ALTER TABLE lesson_discussion_blocks ADD CONSTRAINT fk_disc_blocks_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE",
    'SELECT 1');
PREPARE stmt_fk_disc_blocks_tenant FROM @sql_fk_disc_blocks_tenant;
EXECUTE stmt_fk_disc_blocks_tenant;
DEALLOCATE PREPARE stmt_fk_disc_blocks_tenant;
