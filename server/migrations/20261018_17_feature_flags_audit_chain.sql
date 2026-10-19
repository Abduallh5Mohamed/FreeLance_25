-- =============================================================================
-- M7 O2 + O7 — platform feature flags and a tamper-evident audit chain
-- Task:    m7-server-o2-o7-20261018-17
-- Batch:   m7-server-super-admin-20261018
-- Date:    2026-10-18
-- Scope:
--   O2  Platform feature-flag editor storage: feature flags plus versioned
--       targeting snapshots (all / plan / tenant_list / percentage) that the
--       server-side enforcement helper resolves per tenant. The active
--       version pointer is the only mutable flag field; every version is
--       immutable and rollback is a pointer change to an older version row.
--   O7  Tamper-evident audit chain columns on audit_events. Rows sealed by the
--       server (entry_hash IS NOT NULL) carry sha256(entry_payload linked to
--       the previous sealed hash); the verification function re-computes and
--       reports any payload mutation or broken link. Audit retention floor is
--       365 days; no API path updates or deletes audit rows.
--
-- QUERIES SERVED (read-only source; this file is authoring-only and does not
-- run them)
--   server/src/services/feature-flags.ts
--     flag by key, active version by flag, plan subscription lookup,
--     preview over active tenants, version history
--   server/src/services/audit-log.ts
--     chain leaf lookup, sealed insert, ascending chain verify scan,
--     filtered read/export with pagination caps
--
-- IDEMPOTENCY
--   Every statement is wrapped in an INFORMATION_SCHEMA probe plus
--   PREPARE/EXECUTE, so re-running this file is a no-op. No destructive DDL,
--   no row rewrite, no foreign-key check disable.
--
-- !! AUTHORING-ONLY. SQL EXECUTION and live/bootstrap validation are OUT OF
--    SCOPE for this batch and require a separately approved isolated
--    bootstrap + live verification step. Do not run here.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Step 1: platform feature flags registry.
-- -----------------------------------------------------------------------------
SET @m7_has_flags = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'feature_flags');

SET @m7_sql_flags = IF(@m7_has_flags = 0,
  'CREATE TABLE feature_flags (
    id CHAR(36) PRIMARY KEY,
    flag_key VARCHAR(80) NOT NULL,
    description VARCHAR(500) NULL,
    active_version_id CHAR(36) NULL,
    is_archived TINYINT(1) NOT NULL DEFAULT 0,
    created_by CHAR(36) NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NULL,
    UNIQUE KEY uq_feature_flags_key (flag_key)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci',
  'SELECT 1');
PREPARE m7_stmt_flags FROM @m7_sql_flags;
EXECUTE m7_stmt_flags;
DEALLOCATE PREPARE m7_stmt_flags;

-- -----------------------------------------------------------------------------
-- Step 2: immutable targeting versions. A version is frozen at creation;
-- enabling/disabling/retargeting always produces a NEW version row.
-- -----------------------------------------------------------------------------
SET @m7_has_versions = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'feature_flag_versions');

SET @m7_sql_versions = IF(@m7_has_versions = 0,
  'CREATE TABLE feature_flag_versions (
    id CHAR(36) PRIMARY KEY,
    flag_id CHAR(36) NOT NULL,
    version_no INT UNSIGNED NOT NULL,
    targeting_mode ENUM(''all'',''plan'',''tenant_list'',''percentage'') NOT NULL,
    plan_id CHAR(36) NULL,
    percentage INT NULL,
    tenant_ids JSON NULL,
    enabled TINYINT(1) NOT NULL DEFAULT 1,
    created_by CHAR(36) NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    reason VARCHAR(1000) NULL,
    UNIQUE KEY uq_feature_flag_versions_no (flag_id, version_no),
    CONSTRAINT fk_feature_flag_versions_flag FOREIGN KEY (flag_id)
      REFERENCES feature_flags(id),
    CONSTRAINT fk_feature_flag_versions_plan FOREIGN KEY (plan_id)
      REFERENCES platform_plans(id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci',
  'SELECT 1');
PREPARE m7_stmt_versions FROM @m7_sql_versions;
EXECUTE m7_stmt_versions;
DEALLOCATE PREPARE m7_stmt_versions;

-- -----------------------------------------------------------------------------
-- Step 3: active version pointer (added only when both tables and the column
-- exist and the constraint is absent, so re-running is a no-op).
-- -----------------------------------------------------------------------------
SET @m7_has_active_version_col = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'feature_flags'
    AND COLUMN_NAME = 'active_version_id');
SET @m7_has_active_version_fk = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'feature_flags'
    AND CONSTRAINT_NAME = 'fk_feature_flags_active_version');

SET @m7_sql_active_version_fk = IF(@m7_has_active_version_col = 1 AND @m7_has_active_version_fk = 0,
  'ALTER TABLE feature_flags ADD CONSTRAINT fk_feature_flags_active_version
     FOREIGN KEY (active_version_id) REFERENCES feature_flag_versions(id)',
  'SELECT 1');
PREPARE m7_stmt_active_version_fk FROM @m7_sql_active_version_fk;
EXECUTE m7_stmt_active_version_fk;
DEALLOCATE PREPARE m7_stmt_active_version_fk;

-- -----------------------------------------------------------------------------
-- Step 4: tamper-evident audit chain columns on the existing audit_events
-- table (append-only: no consumer of these columns ever rewrites a sealed
-- row).
-- -----------------------------------------------------------------------------
SET @m7_has_audit_events = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'audit_events');

SET @m7_has_entry_hash = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'audit_events'
    AND COLUMN_NAME = 'entry_hash');

SET @m7_add_entry_hash_sql = IF(@m7_has_audit_events = 1 AND @m7_has_entry_hash = 0,
  'ALTER TABLE audit_events
     ADD COLUMN entry_hash VARCHAR(64) NULL,
     ADD COLUMN prev_entry_hash VARCHAR(64) NULL',
  'SELECT 1');
PREPARE m7_stmt_add_entry_hash FROM @m7_add_entry_hash_sql;
EXECUTE m7_stmt_add_entry_hash;
DEALLOCATE PREPARE m7_stmt_add_entry_hash;

-- -----------------------------------------------------------------------------
-- Step 5: chain verification scan index (ordered walk over created_at + id).
-- -----------------------------------------------------------------------------
SET @m7_idx_chain_exists = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'audit_events'
    AND INDEX_NAME = 'idx_audit_chain_created');

SET @m7_sql_chain_idx = IF(@m7_has_audit_events = 1 AND @m7_idx_chain_exists = 0,
  'ALTER TABLE audit_events ADD INDEX idx_audit_chain_created (created_at, id)',
  'SELECT 1');
PREPARE m7_stmt_chain_idx FROM @m7_sql_chain_idx;
EXECUTE m7_stmt_chain_idx;
DEALLOCATE PREPARE m7_stmt_chain_idx;
