-- =============================================================================
-- M6 P3/P4/P5/P7 — notification consent ledger, event outbox, delivery receipts
-- Task:    m6-server-notification-delivery-20261018-14
-- Date:    2026-10-18
-- Scope:   P3 consent (purpose/channel, append-only), P4 event outbox with
--          idempotency + bounded retries, P5 delivery-proof receipts, P7
--          parent-report delivery rows (queued through the outbox).
--
-- AUTHORING-ONLY / NOT EXECUTED. The application never runs DDL at runtime; an
-- operator applies this file on the isolated bootstrap/validation stack. Every
-- statement is guarded by an INFORMATION_SCHEMA probe and PREPARE/EXECUTE, so
-- re-running it is a no-op. No DROP, TRUNCATE, FK-disable or data rewrite.
--
-- MODEL
--   notification_consent_events     — append-only ledger; the latest event per
--                                     (user, purpose, channel) wins, so a
--                                     STOP/unsubscribe overrides any earlier
--                                     grant with zero latency.
--   notification_outbox             — one row per delivery stream, keyed by an
--                                     idempotency key; bounded-backoff retries
--                                     advance next_attempt_at without new rows.
--   notification_delivery_receipts  — per-attempt channel proof / success or
--                                     failure receipt. Contact data is stored
--                                     only as an HMAC ref, never the contact.
--
-- ISOLATION
--   Rows are addressed through recipient (user_id, user_type) predicates bound
--   from the token, and every tenant-owned row carries tenant_id checked in
--   the same predicate. There is no FK on user_id: consent history is
--   append-only and must survive even a role-space cleanup.
-- =============================================================================

SET @m6_db = DATABASE();

-- -----------------------------------------------------------------------------
-- notification_consent_events
-- -----------------------------------------------------------------------------
SET @has_consent_events = (SELECT COUNT(*) FROM information_schema.TABLES
    WHERE TABLE_SCHEMA = @m6_db AND TABLE_NAME = 'notification_consent_events');
SET @sql_consent_events = IF(@has_consent_events = 0,
    "CREATE TABLE notification_consent_events (
        id CHAR(36) NOT NULL,
        seq BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        tenant_id CHAR(36) NULL,
        user_id VARCHAR(64) NOT NULL,
        user_type VARCHAR(30) NOT NULL,
        purpose VARCHAR(50) NOT NULL,
        channel VARCHAR(20) NOT NULL,
        action ENUM('grant','revoke') NOT NULL,
        source VARCHAR(30) NOT NULL,
        recorded_by VARCHAR(64) NULL,
        note VARCHAR(200) NULL,
        recorded_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        PRIMARY KEY (id),
        UNIQUE KEY uq_consent_seq (seq),
        KEY idx_consent_lookup (user_id, user_type, purpose, channel),
        KEY idx_consent_history (user_id, user_type, seq),
        KEY idx_consent_tenant (tenant_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      COMMENT 'M6 P3 append-only notification consent ledger'",
    'SELECT 1');
PREPARE stmt_consent_events FROM @sql_consent_events;
EXECUTE stmt_consent_events;
DEALLOCATE PREPARE stmt_consent_events;

-- -----------------------------------------------------------------------------
-- notification_outbox
-- -----------------------------------------------------------------------------
SET @has_outbox = (SELECT COUNT(*) FROM information_schema.TABLES
    WHERE TABLE_SCHEMA = @m6_db AND TABLE_NAME = 'notification_outbox');
SET @sql_outbox = IF(@has_outbox = 0,
    "CREATE TABLE notification_outbox (
        id CHAR(36) NOT NULL,
        idempotency_key VARCHAR(160) NOT NULL,
        tenant_id CHAR(36) NULL,
        event_type VARCHAR(60) NOT NULL,
        purpose VARCHAR(50) NOT NULL,
        recipient_user_id VARCHAR(64) NOT NULL,
        recipient_user_type VARCHAR(30) NOT NULL,
        channel VARCHAR(20) NOT NULL,
        locale VARCHAR(5) NOT NULL,
        template_id VARCHAR(120) NULL,
        payload TEXT NOT NULL,
        status ENUM('pending','sending','sent','failed','bounced','cancelled') NOT NULL DEFAULT 'pending',
        attempts INT NOT NULL DEFAULT 0,
        max_attempts INT NOT NULL DEFAULT 5,
        next_attempt_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        last_error VARCHAR(500) NULL,
        delivered_at TIMESTAMP(3) NULL,
        created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
        PRIMARY KEY (id),
        UNIQUE KEY uq_outbox_idempotency (idempotency_key),
        KEY idx_outbox_due (status, next_attempt_at),
        KEY idx_outbox_recipient (recipient_user_id, recipient_user_type, created_at),
        KEY idx_outbox_tenant (tenant_id, event_type)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      COMMENT 'M6/P4 event outbox with idempotency and bounded-backoff retries'",
    'SELECT 1');
PREPARE stmt_outbox FROM @sql_outbox;
EXECUTE stmt_outbox;
DEALLOCATE PREPARE stmt_outbox;

-- -----------------------------------------------------------------------------
-- notification_delivery_receipts
-- -----------------------------------------------------------------------------
SET @has_receipts = (SELECT COUNT(*) FROM information_schema.TABLES
    WHERE TABLE_SCHEMA = @m6_db AND TABLE_NAME = 'notification_delivery_receipts');
SET @sql_receipts = IF(@has_receipts = 0,
    "CREATE TABLE notification_delivery_receipts (
        id CHAR(36) NOT NULL,
        outbox_id CHAR(36) NOT NULL,
        tenant_id CHAR(36) NULL,
        channel VARCHAR(20) NOT NULL,
        outcome VARCHAR(20) NOT NULL,
        proof TEXT NULL,
        detail VARCHAR(500) NULL,
        recorded_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        PRIMARY KEY (id),
        KEY idx_receipt_outbox (outbox_id),
        KEY idx_receipt_outcome (outbox_id, outcome)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      COMMENT 'M6 P5/P7 sanitized channel-proof receipts (no PII: HMAC contact ref only)'",
    'SELECT 1');
PREPARE stmt_receipts FROM @sql_receipts;
EXECUTE stmt_receipts;
DEALLOCATE PREPARE stmt_receipts;

-- -----------------------------------------------------------------------------
-- Foreign keys, added separately and guarded by name so a partial re-run
-- converges without error. Consent events stay FK-free: the ledger is
-- append-only and must never be cascaded away.
-- -----------------------------------------------------------------------------
SET @fk_outbox_tenant = (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
    WHERE CONSTRAINT_SCHEMA = @m6_db AND TABLE_NAME = 'notification_outbox'
      AND CONSTRAINT_NAME = 'fk_outbox_tenant' AND CONSTRAINT_TYPE = 'FOREIGN KEY');
SET @sql_fk_outbox_tenant = IF(@fk_outbox_tenant = 0,
    "ALTER TABLE notification_outbox ADD CONSTRAINT fk_outbox_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE",
    'SELECT 1');
PREPARE stmt_fk_outbox_tenant FROM @sql_fk_outbox_tenant;
EXECUTE stmt_fk_outbox_tenant;
DEALLOCATE PREPARE stmt_fk_outbox_tenant;

SET @fk_receipt_outbox = (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
    WHERE CONSTRAINT_SCHEMA = @m6_db AND TABLE_NAME = 'notification_delivery_receipts'
      AND CONSTRAINT_NAME = 'fk_receipt_outbox' AND CONSTRAINT_TYPE = 'FOREIGN KEY');
SET @sql_fk_receipt_outbox = IF(@fk_receipt_outbox = 0,
    "ALTER TABLE notification_delivery_receipts ADD CONSTRAINT fk_receipt_outbox FOREIGN KEY (outbox_id) REFERENCES notification_outbox(id) ON DELETE CASCADE",
    'SELECT 1');
PREPARE stmt_fk_receipt_outbox FROM @sql_fk_receipt_outbox;
EXECUTE stmt_fk_receipt_outbox;
DEALLOCATE PREPARE stmt_fk_receipt_outbox;
