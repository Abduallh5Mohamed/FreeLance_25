-- =============================================================================
-- M3 V4/V5/V6 — playback sessions, device registry, progress/resume
-- Task:    m3-playback-sessions-progress
-- Date:    2026-10-18
-- Scope:   V4 dynamic watermark inputs, V5 device + concurrent session
--          registry with per-tenant policy, V6 playback progress/resume.
--
-- IDEMPOTENCY: every statement guarded by INFORMATION_SCHEMA; re-run no-op.
-- No runtime DDL; authoring only.
-- =============================================================================

SET @m3_db = DATABASE();

-- playback_tenant_policies: configurable per-tenant concurrency/device limits.
SET @has_tbl = (SELECT COUNT(*) FROM information_schema.TABLES
  WHERE TABLE_SCHEMA = @m3_db AND TABLE_NAME = 'playback_tenant_policies');
SET @sql = IF(@has_tbl = 0,
  'CREATE TABLE playback_tenant_policies (
      tenant_id CHAR(36) NOT NULL,
      max_concurrent_sessions INT NOT NULL DEFAULT 2,
      max_devices INT NOT NULL DEFAULT 3,
      warning_threshold INT NOT NULL DEFAULT 1,
      self_revoke_allowed TINYINT(1) NOT NULL DEFAULT 1,
      support_revoke_allowed TINYINT(1) NOT NULL DEFAULT 1,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (tenant_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    COMMENT ''V5 per-tenant playback policy''',
  'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- playback_devices: registered devices per user/tenant.
SET @has_tbl = (SELECT COUNT(*) FROM information_schema.TABLES
  WHERE TABLE_SCHEMA = @m3_db AND TABLE_NAME = 'playback_devices');
SET @sql = IF(@has_tbl = 0,
  'CREATE TABLE playback_devices (
      id CHAR(36) NOT NULL,
      tenant_id CHAR(36) NOT NULL,
      user_id CHAR(36) NOT NULL,
      device_fingerprint VARCHAR(255) NOT NULL,
      device_label VARCHAR(128) NULL,
      status VARCHAR(32) NOT NULL DEFAULT ''active'',
      first_seen_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_seen_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      revoked_at TIMESTAMP NULL,
      revoked_by CHAR(36) NULL,
      revoke_reason VARCHAR(255) NULL,
      PRIMARY KEY (id),
      UNIQUE KEY uq_playback_device (tenant_id, user_id, device_fingerprint),
      KEY idx_playback_device_user (tenant_id, user_id, status)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    COMMENT ''V5 device registry''',
  'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- playback_session_slots: concurrent session slots (atomic acquisition).
SET @has_tbl = (SELECT COUNT(*) FROM information_schema.TABLES
  WHERE TABLE_SCHEMA = @m3_db AND TABLE_NAME = 'playback_session_slots');
SET @sql = IF(@has_tbl = 0,
  'CREATE TABLE playback_session_slots (
      id CHAR(36) NOT NULL,
      tenant_id CHAR(36) NOT NULL,
      user_id CHAR(36) NOT NULL,
      device_id CHAR(36) NOT NULL,
      session_id CHAR(36) NOT NULL,
      status VARCHAR(32) NOT NULL DEFAULT ''active'',
      started_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_heartbeat_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      ended_at TIMESTAMP NULL,
      ended_reason VARCHAR(128) NULL,
      PRIMARY KEY (id),
      UNIQUE KEY uq_playback_session_slot (session_id),
      KEY idx_playback_slot_user (tenant_id, user_id, status),
      KEY idx_playback_slot_device (device_id, status)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    COMMENT ''V5 concurrent session slots''',
  'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- playback_progress: monotonic resume positions per enrollment/asset/device.
SET @has_tbl = (SELECT COUNT(*) FROM information_schema.TABLES
  WHERE TABLE_SCHEMA = @m3_db AND TABLE_NAME = 'playback_progress');
SET @sql = IF(@has_tbl = 0,
  'CREATE TABLE playback_progress (
      id CHAR(36) NOT NULL,
      tenant_id CHAR(36) NOT NULL,
      student_enrollment_id CHAR(36) NOT NULL,
      asset_id CHAR(36) NOT NULL,
      device_id CHAR(36) NULL,
      session_id CHAR(36) NULL,
      position_seconds INT NOT NULL DEFAULT 0,
      duration_seconds INT NOT NULL DEFAULT 0,
      completed TINYINT(1) NOT NULL DEFAULT 0,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_playback_progress (tenant_id, student_enrollment_id, asset_id),
      KEY idx_playback_progress_device (device_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    COMMENT ''V6 playback progress/resume''',
  'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
