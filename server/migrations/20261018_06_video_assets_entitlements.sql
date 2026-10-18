-- =============================================================================
-- M3 V1/V3/V8 — Video asset lifecycle, playback entitlements & usage schema
-- Task:    m3-server-video-lifecycle-entitlement-usage-20261018-06
-- Batch:   m3-server-video-20261018
-- Date:    2026-10-18
-- Scope:   V1 provider-neutral asset lifecycle, V3 per-tenant playback
--          entitlement, V8 watch/storage usage events.
--
-- PROVENANCE
--   V1 needs a provider-neutral asset row plus a callback ledger whose
--   UNIQUE(provider, callback_id) makes a replayed provider callback a no-op
--   and whose rows carry the dead-letter reason. V3 needs a table of issued,
--   short-lived playback entitlements so a single token can be revoked.
--   V8 needs an append-only usage ledger with a per-tenant dedupe key so
--   replayed heartbeats/provider callbacks are absorbed and aggregates can be
--   reconciled per tenant. None of these tables existed.
--
-- OWNERSHIP
--   Every row carries tenant_id. The application sets it exclusively from a
--   verified principal (asset commands, heartbeats) or a signature-verified
--   provider payload (callbacks); the column is never read from a request
--   body. No legacy row is re-scoped, moved or deleted.
--
-- IDEMPOTENCY
--   Every statement is wrapped in an information_schema probe +
--   PREPARE/EXECUTE, so re-running this file is a no-op. No DROP, no TRUNCATE,
--   no FK-disable, no data rewrite.
--
-- !! THIS FILE IS AUTHORING-ONLY. SQL EXECUTION and live/bootstrap validation
--    are OUT OF SCOPE for this batch and require a separately approved
--    isolated bootstrap + live verification step. Do not run here.
-- =============================================================================

SET @m3_db = DATABASE();

-- -----------------------------------------------------------------------------
-- video_assets (V1): provider-neutral asset + lifecycle state.
-- status is the state machine (uploaded -> processing -> ready/failed);
-- attempts/max_attempts bound retries; dead_lettered/dead_letter_reason record
-- an exhausted asset so no further retry is granted.
-- -----------------------------------------------------------------------------
SET @has_assets = (SELECT COUNT(*) FROM information_schema.TABLES
                   WHERE TABLE_SCHEMA = @m3_db AND TABLE_NAME = 'video_assets');
SET @sql_assets = IF(@has_assets = 0,
    "CREATE TABLE video_assets (
        id CHAR(36) NOT NULL,
        tenant_id CHAR(36) NOT NULL,
        owner_user_id CHAR(36) NOT NULL,
        provider VARCHAR(128) NOT NULL,
        provider_asset_id VARCHAR(128) NOT NULL,
        title VARCHAR(200) NOT NULL DEFAULT 'Untitled asset',
        status ENUM('uploaded','processing','ready','failed') NOT NULL DEFAULT 'uploaded',
        attempts INT NOT NULL DEFAULT 0,
        max_attempts INT NOT NULL DEFAULT 3,
        last_error VARCHAR(500) NULL,
        dead_lettered TINYINT(1) NOT NULL DEFAULT 0,
        dead_letter_reason VARCHAR(200) NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uq_video_asset_provider (provider, provider_asset_id),
        KEY idx_video_assets_tenant (tenant_id, status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      COMMENT 'V1 provider-neutral video asset lifecycle'",
    'SELECT 1');
PREPARE stmt_assets FROM @sql_assets;
EXECUTE stmt_assets;
DEALLOCATE PREPARE stmt_assets;

-- -----------------------------------------------------------------------------
-- video_asset_callbacks (V1): idempotent callback ledger. UNIQUE(provider,
-- callback_id) absorbs replayed provider callbacks; the row keeps the applied
-- target state and any dead-letter/failure detail.
-- -----------------------------------------------------------------------------
SET @has_callbacks = (SELECT COUNT(*) FROM information_schema.TABLES
                      WHERE TABLE_SCHEMA = @m3_db AND TABLE_NAME = 'video_asset_callbacks');
SET @sql_callbacks = IF(@has_callbacks = 0,
    "CREATE TABLE video_asset_callbacks (
        id CHAR(36) NOT NULL,
        tenant_id CHAR(36) NOT NULL,
        asset_id CHAR(36) NOT NULL,
        provider VARCHAR(128) NOT NULL,
        callback_id VARCHAR(128) NOT NULL,
        target_state VARCHAR(32) NOT NULL,
        outcome VARCHAR(32) NOT NULL DEFAULT 'pending',
        detail VARCHAR(500) NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uq_video_asset_callback (provider, callback_id),
        KEY idx_video_asset_callbacks_asset (asset_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      COMMENT 'V1 idempotent provider callback ledger'",
    'SELECT 1');
PREPARE stmt_callbacks FROM @sql_callbacks;
EXECUTE stmt_callbacks;
DEALLOCATE PREPARE stmt_callbacks;

-- -----------------------------------------------------------------------------
-- playback_entitlements (V3): issued short-lived tokens. The jti is the
-- revocation key; revoked_at/revoke_reason mark a revocation that denies the
-- token immediately.
-- -----------------------------------------------------------------------------
SET @has_entitlements = (SELECT COUNT(*) FROM information_schema.TABLES
                         WHERE TABLE_SCHEMA = @m3_db AND TABLE_NAME = 'playback_entitlements');
SET @sql_entitlements = IF(@has_entitlements = 0,
    "CREATE TABLE playback_entitlements (
        jti CHAR(36) NOT NULL,
        tenant_id CHAR(36) NOT NULL,
        lesson_id CHAR(36) NOT NULL,
        student_enrollment_id CHAR(36) NOT NULL,
        session_id CHAR(36) NOT NULL,
        issued_at TIMESTAMP NOT NULL,
        expires_at TIMESTAMP NOT NULL,
        revoked_at TIMESTAMP NULL DEFAULT NULL,
        revoke_reason VARCHAR(200) NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (jti),
        KEY idx_playback_entitlements_tenant (tenant_id),
        KEY idx_playback_entitlements_expiry (expires_at, revoked_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      COMMENT 'V3 per-tenant playback entitlements (revocable)'",
    'SELECT 1');
PREPARE stmt_entitlements FROM @sql_entitlements;
EXECUTE stmt_entitlements;
DEALLOCATE PREPARE stmt_entitlements;

-- -----------------------------------------------------------------------------
-- video_usage_events (V8): append-only watch/storage ledger. UNIQUE(tenant_id,
-- dedupe_key) absorbs replayed heartbeats/provider callbacks; tenant_id makes
-- every aggregate tenant-scoped.
-- -----------------------------------------------------------------------------
SET @has_usage = (SELECT COUNT(*) FROM information_schema.TABLES
                  WHERE TABLE_SCHEMA = @m3_db AND TABLE_NAME = 'video_usage_events');
SET @sql_usage = IF(@has_usage = 0,
    "CREATE TABLE video_usage_events (
        id CHAR(36) NOT NULL,
        tenant_id CHAR(36) NOT NULL,
        asset_id CHAR(36) NULL,
        kind ENUM('watch','storage') NOT NULL,
        watch_seconds INT NOT NULL DEFAULT 0,
        storage_bytes BIGINT NOT NULL DEFAULT 0,
        dedupe_key VARCHAR(200) NOT NULL,
        session_id CHAR(36) NULL,
        student_enrollment_id CHAR(36) NULL,
        source VARCHAR(32) NOT NULL DEFAULT 'other',
        occurred_at TIMESTAMP NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uq_video_usage_dedupe (tenant_id, dedupe_key),
        KEY idx_video_usage_tenant (tenant_id, kind)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      COMMENT 'V8 watch/storage usage events with tenant attribution'",
    'SELECT 1');
PREPARE stmt_usage FROM @sql_usage;
EXECUTE stmt_usage;
DEALLOCATE PREPARE stmt_usage;
