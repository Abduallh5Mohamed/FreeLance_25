-- =============================================================================
-- L2 — single-use notification unsubscribe tokens
-- Task:    m6-unsubscribe-single-use-20261018-21
-- Date:    2026-10-18
-- Scope:   Persist the signed unsubscribe token's `jti` the first time it is
--          presented, so the primary key makes every replay a handled
--          duplicate. The token already carries an expiry, minted short (24h
--          default) by services/notification-outbox.ts.
--
-- AUTHORING-ONLY / NOT EXECUTED. The application never runs DDL at runtime; an
-- operator applies this file on the isolated bootstrap/validation stack. The
-- statement is guarded by an INFORMATION_SCHEMA probe and PREPARE/EXECUTE, so
-- re-running it is a no-op. No DROP, TRUNCATE, FK-disable or data rewrite.
--
-- MODEL
--   notification_unsubscribe_token_uses — one row per consumed jti. Rows are
--   deliberately FK-free: consumption is an append-only, single-use marker and
--   must survive a later role-space or consent cleanup.
-- =============================================================================

SET @m6_db = DATABASE();

-- -----------------------------------------------------------------------------
-- notification_unsubscribe_token_uses
-- -----------------------------------------------------------------------------
SET @has_unsub_uses = (SELECT COUNT(*) FROM information_schema.TABLES
    WHERE TABLE_SCHEMA = @m6_db AND TABLE_NAME = 'notification_unsubscribe_token_uses');
SET @sql_unsub_uses = IF(@has_unsub_uses = 0,
    "CREATE TABLE notification_unsubscribe_token_uses (
        jti CHAR(36) NOT NULL,
        user_id VARCHAR(64) NOT NULL,
        user_type VARCHAR(30) NOT NULL,
        consumed_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        PRIMARY KEY (jti),
        KEY idx_unsub_use_user (user_id, user_type, consumed_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      COMMENT 'L2 one-time unsubscribe token consumption (jti)'",
    'SELECT 1');
PREPARE stmt_unsub_uses FROM @sql_unsub_uses;
EXECUTE stmt_unsub_uses;
DEALLOCATE PREPARE stmt_unsub_uses;
