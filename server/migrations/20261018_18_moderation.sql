-- =============================================================================
-- M7 O4 — content moderation queue (cases, immutable decision history, appeals)
-- Task:    m7-server-o4-moderation-20261018-18
-- Batch:   m7-server-super-admin-20261018
-- Date:    2026-10-18
-- Scope:
--   O4  Content moderation/reports. Reports raised against lesson discussions
--       (lesson_discussion_reports, owned by M6 P6) are promoted into a
--       moderation queue. A case carries a bounded evidence snapshot (a content
--       hash, never the raw body), an optional assigned reviewer, a decision
--       with a mandatory reason, exactly one appeal reviewed by a reviewer
--       other than the original decider, and an append-only decision history.
--       The tenant owner is notified through an injected hook; every mutation
--       is audited with the actor and reason.
--
-- MODEL
--   moderation_cases              — one case per source report (unique report_id).
--                                   Holds the queue state, assignment, current
--                                   decision and the evidence snapshot.
--   moderation_decision_history   — APPEND-ONLY. One immutable row per recorded
--                                   decision (initial or appeal). revision_no is
--                                   unique per case; no path updates or deletes.
--   moderation_appeals            — AT MOST ONE appeal per case (unique case_id);
--                                   carries the appellant and the appeal reviewer.
--
-- ISOLATION
--   Every table carries tenant_id and is only read/written through a predicate
--   that includes it. A tenant moderator is pinned to the server-derived tenant;
--   the platform moderator is the only cross-tenant reader. Reviewer membership
--   is always re-verified from server rows (tenant authority or platform
--   permission), never from a JWT role claim. Deny-by-default.
--
-- AUTHORING-ONLY / NOT EXECUTED. The application never runs DDL at runtime; an
-- operator applies this file on the isolated bootstrap/validation stack. Every
-- statement is guarded by an INFORMATION_SCHEMA probe and PREPARE/EXECUTE, so
-- re-running it is a no-op. No DROP, TRUNCATE, FK-disable or data rewrite.
-- =============================================================================

SET @m7_o4_db = DATABASE();

-- -----------------------------------------------------------------------------
-- moderation_cases
-- -----------------------------------------------------------------------------
SET @has_mod_cases = (SELECT COUNT(*) FROM information_schema.TABLES
    WHERE TABLE_SCHEMA = @m7_o4_db AND TABLE_NAME = 'moderation_cases');
SET @sql_mod_cases = IF(@has_mod_cases = 0,
    "CREATE TABLE moderation_cases (
        id CHAR(36) NOT NULL,
        tenant_id CHAR(36) NOT NULL,
        report_id CHAR(36) NOT NULL,
        target_type ENUM('thread','reply') NOT NULL,
        target_id CHAR(36) NOT NULL,
        reporter_user_id VARCHAR(64) NOT NULL,
        report_reason VARCHAR(500) NOT NULL,
        target_author_user_id VARCHAR(64) NULL,
        evidence_snapshot JSON NULL COMMENT 'Bounded, non-PII evidence (content hash/ids; never a raw body)',
        status ENUM('open','in_review','decided','appealed','closed') NOT NULL DEFAULT 'open',
        assigned_reviewer_user_id VARCHAR(64) NULL,
        assigned_at TIMESTAMP NULL,
        decision ENUM('dismiss','hide_content','remove_content','restore_content') NULL,
        decision_reason VARCHAR(500) NULL,
        decided_by_user_id VARCHAR(64) NULL,
        decided_at TIMESTAMP NULL,
        version INT NOT NULL DEFAULT 0,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uq_moderation_case_report (report_id),
        KEY idx_moderation_case_queue (tenant_id, status, created_at),
        KEY idx_moderation_case_assignee (tenant_id, assigned_reviewer_user_id, status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      COMMENT 'M7 O4 content moderation case (one per source report)'",
    'SELECT 1');
PREPARE stmt_mod_cases FROM @sql_mod_cases;
EXECUTE stmt_mod_cases;
DEALLOCATE PREPARE stmt_mod_cases;

-- -----------------------------------------------------------------------------
-- moderation_decision_history (append-only; never updated or deleted)
-- -----------------------------------------------------------------------------
SET @has_mod_history = (SELECT COUNT(*) FROM information_schema.TABLES
    WHERE TABLE_SCHEMA = @m7_o4_db AND TABLE_NAME = 'moderation_decision_history');
SET @sql_mod_history = IF(@has_mod_history = 0,
    "CREATE TABLE moderation_decision_history (
        id CHAR(36) NOT NULL,
        case_id CHAR(36) NOT NULL,
        tenant_id CHAR(36) NOT NULL,
        revision_no INT NOT NULL,
        kind ENUM('decision','appeal_decision') NOT NULL,
        decision ENUM('dismiss','hide_content','remove_content','restore_content') NOT NULL,
        reason VARCHAR(500) NOT NULL,
        actor_user_id VARCHAR(64) NOT NULL,
        actor_role VARCHAR(32) NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uq_moderation_history_revision (case_id, revision_no),
        KEY idx_moderation_history_case (case_id, revision_no)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      COMMENT 'M7 O4 immutable moderation decision history'",
    'SELECT 1');
PREPARE stmt_mod_history FROM @sql_mod_history;
EXECUTE stmt_mod_history;
DEALLOCATE PREPARE stmt_mod_history;

-- -----------------------------------------------------------------------------
-- moderation_appeals (at most one per case)
-- -----------------------------------------------------------------------------
SET @has_mod_appeals = (SELECT COUNT(*) FROM information_schema.TABLES
    WHERE TABLE_SCHEMA = @m7_o4_db AND TABLE_NAME = 'moderation_appeals');
SET @sql_mod_appeals = IF(@has_mod_appeals = 0,
    "CREATE TABLE moderation_appeals (
        id CHAR(36) NOT NULL,
        case_id CHAR(36) NOT NULL,
        tenant_id CHAR(36) NOT NULL,
        appellant_user_id VARCHAR(64) NOT NULL,
        reason VARCHAR(500) NOT NULL,
        status ENUM('pending','resolved') NOT NULL DEFAULT 'pending',
        reviewed_by_user_id VARCHAR(64) NULL,
        reviewed_at TIMESTAMP NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uq_moderation_appeal_case (case_id),
        KEY idx_moderation_appeal_queue (tenant_id, status, created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      COMMENT 'M7 O4 single moderation appeal per case'",
    'SELECT 1');
PREPARE stmt_mod_appeals FROM @sql_mod_appeals;
EXECUTE stmt_mod_appeals;
DEALLOCATE PREPARE stmt_mod_appeals;

-- -----------------------------------------------------------------------------
-- Foreign keys, added separately and guarded by name so a partial re-run
-- (for example an interrupted first attempt) converges without error.
-- -----------------------------------------------------------------------------
SET @fk_mod_cases_tenant = (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
    WHERE CONSTRAINT_SCHEMA = @m7_o4_db AND TABLE_NAME = 'moderation_cases'
      AND CONSTRAINT_NAME = 'fk_mod_cases_tenant' AND CONSTRAINT_TYPE = 'FOREIGN KEY');
SET @sql_fk_mod_cases_tenant = IF(@fk_mod_cases_tenant = 0,
    "ALTER TABLE moderation_cases ADD CONSTRAINT fk_mod_cases_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE",
    'SELECT 1');
PREPARE stmt_fk_mod_cases_tenant FROM @sql_fk_mod_cases_tenant;
EXECUTE stmt_fk_mod_cases_tenant;
DEALLOCATE PREPARE stmt_fk_mod_cases_tenant;

SET @fk_mod_cases_report = (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
    WHERE CONSTRAINT_SCHEMA = @m7_o4_db AND TABLE_NAME = 'moderation_cases'
      AND CONSTRAINT_NAME = 'fk_mod_cases_report' AND CONSTRAINT_TYPE = 'FOREIGN KEY');
SET @sql_fk_mod_cases_report = IF(@fk_mod_cases_report = 0,
    "ALTER TABLE moderation_cases ADD CONSTRAINT fk_mod_cases_report FOREIGN KEY (report_id) REFERENCES lesson_discussion_reports(id) ON DELETE CASCADE",
    'SELECT 1');
PREPARE stmt_fk_mod_cases_report FROM @sql_fk_mod_cases_report;
EXECUTE stmt_fk_mod_cases_report;
DEALLOCATE PREPARE stmt_fk_mod_cases_report;

SET @fk_mod_history_case = (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
    WHERE CONSTRAINT_SCHEMA = @m7_o4_db AND TABLE_NAME = 'moderation_decision_history'
      AND CONSTRAINT_NAME = 'fk_mod_history_case' AND CONSTRAINT_TYPE = 'FOREIGN KEY');
SET @sql_fk_mod_history_case = IF(@fk_mod_history_case = 0,
    "ALTER TABLE moderation_decision_history ADD CONSTRAINT fk_mod_history_case FOREIGN KEY (case_id) REFERENCES moderation_cases(id) ON DELETE CASCADE",
    'SELECT 1');
PREPARE stmt_fk_mod_history_case FROM @sql_fk_mod_history_case;
EXECUTE stmt_fk_mod_history_case;
DEALLOCATE PREPARE stmt_fk_mod_history_case;

SET @fk_mod_history_tenant = (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
    WHERE CONSTRAINT_SCHEMA = @m7_o4_db AND TABLE_NAME = 'moderation_decision_history'
      AND CONSTRAINT_NAME = 'fk_mod_history_tenant' AND CONSTRAINT_TYPE = 'FOREIGN KEY');
SET @sql_fk_mod_history_tenant = IF(@fk_mod_history_tenant = 0,
    "ALTER TABLE moderation_decision_history ADD CONSTRAINT fk_mod_history_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE",
    'SELECT 1');
PREPARE stmt_fk_mod_history_tenant FROM @sql_fk_mod_history_tenant;
EXECUTE stmt_fk_mod_history_tenant;
DEALLOCATE PREPARE stmt_fk_mod_history_tenant;

SET @fk_mod_appeals_case = (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
    WHERE CONSTRAINT_SCHEMA = @m7_o4_db AND TABLE_NAME = 'moderation_appeals'
      AND CONSTRAINT_NAME = 'fk_mod_appeals_case' AND CONSTRAINT_TYPE = 'FOREIGN KEY');
SET @sql_fk_mod_appeals_case = IF(@fk_mod_appeals_case = 0,
    "ALTER TABLE moderation_appeals ADD CONSTRAINT fk_mod_appeals_case FOREIGN KEY (case_id) REFERENCES moderation_cases(id) ON DELETE CASCADE",
    'SELECT 1');
PREPARE stmt_fk_mod_appeals_case FROM @sql_fk_mod_appeals_case;
EXECUTE stmt_fk_mod_appeals_case;
DEALLOCATE PREPARE stmt_fk_mod_appeals_case;

SET @fk_mod_appeals_tenant = (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
    WHERE CONSTRAINT_SCHEMA = @m7_o4_db AND TABLE_NAME = 'moderation_appeals'
      AND CONSTRAINT_NAME = 'fk_mod_appeals_tenant' AND CONSTRAINT_TYPE = 'FOREIGN KEY');
SET @sql_fk_mod_appeals_tenant = IF(@fk_mod_appeals_tenant = 0,
    "ALTER TABLE moderation_appeals ADD CONSTRAINT fk_mod_appeals_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE",
    'SELECT 1');
PREPARE stmt_fk_mod_appeals_tenant FROM @sql_fk_mod_appeals_tenant;
EXECUTE stmt_fk_mod_appeals_tenant;
DEALLOCATE PREPARE stmt_fk_mod_appeals_tenant;
