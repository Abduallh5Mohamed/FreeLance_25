-- =============================================================================
-- M7 O6 + O9 — platform MFA (TOTP) and support impersonation sessions
-- Task:    m7-server-o6-o9-20261018-19
-- Batch:   m7-server-super-admin-20261018
-- Date:    2026-10-19
-- Scope:
--   O9  Platform MFA storage: one sealed TOTP row per platform-admin user
--       (AES-256-GCM envelope over the RFC-6238 secret, key from MFA_SECRET_KEY),
--       a replay-protected last-used time-step, persisted failed-attempt
--       lockout and a step-up epoch; single-use recovery codes stored hashed.
--   O6  Impersonation session storage: a pending/active/revoked/expiry-bounded
--       session row per started session (mandatory reason, explicit
--       read/write scope, <=30 min, second-admin approval) that the context
--       verifier re-reads live on every request so revoke is immediate.
--
-- QUERIES SERVED (read-only source; this file is authoring-only and does not
-- run them)
--   server/src/services/platform-mfa.ts
--     row lookup, pending upsert, activation, monotonic last_used_step step
--     consumption, failure/lockout updates, recovery-code insert and
--     single-use consume, step-up epoch read/bump, disable
--   server/src/routes/platform-mfa.ts (production store wiring)
--   server/src/services/impersonation.ts
--     insert/lookup, conditional pending->active approval transition,
--     conditional revocation, recent-sessions listing, active-per-target count
--   server/src/routes/impersonation.ts (production store wiring)
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
-- Step 1: platform MFA secrets (one row per platform-admin user).
-- -----------------------------------------------------------------------------
SET @m7_has_mfa = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'platform_mfa_secrets');

SET @m7_sql_mfa = IF(@m7_has_mfa = 0,
  'CREATE TABLE platform_mfa_secrets (
    user_id CHAR(36) PRIMARY KEY,
    sealed_secret TEXT NULL,
    status ENUM(''pending'',''active'',''disabled'') NOT NULL DEFAULT ''pending'',
    last_used_step BIGINT NOT NULL DEFAULT 0,
    failed_attempts INT UNSIGNED NOT NULL DEFAULT 0,
    locked_until TIMESTAMP NULL,
    stepup_epoch INT UNSIGNED NOT NULL DEFAULT 1,
    activated_at TIMESTAMP NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NULL,
    CONSTRAINT fk_platform_mfa_user FOREIGN KEY (user_id) REFERENCES users(id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci',
  'SELECT 1');
PREPARE m7_stmt_mfa FROM @m7_sql_mfa;
EXECUTE m7_stmt_mfa;
DEALLOCATE PREPARE m7_stmt_mfa;

-- -----------------------------------------------------------------------------
-- Step 2: single-use, hash-stored recovery codes.
-- -----------------------------------------------------------------------------
SET @m7_has_recovery = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'platform_mfa_recovery_codes');

SET @m7_sql_recovery = IF(@m7_has_recovery = 0,
  'CREATE TABLE platform_mfa_recovery_codes (
    id CHAR(36) PRIMARY KEY,
    user_id CHAR(36) NOT NULL,
    code_hash CHAR(64) NOT NULL,
    used_at TIMESTAMP NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_platform_mfa_recovery_hash (user_id, code_hash),
    CONSTRAINT fk_platform_mfa_recovery FOREIGN KEY (user_id)
      REFERENCES users(id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci',
  'SELECT 1');
PREPARE m7_stmt_recovery FROM @m7_sql_recovery;
EXECUTE m7_stmt_recovery;
DEALLOCATE PREPARE m7_stmt_recovery;

-- -----------------------------------------------------------------------------
-- Step 3: impersonation sessions (second-admin approval, 30-minute cap).
-- -----------------------------------------------------------------------------
SET @m7_has_impersonation = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'impersonation_sessions');

SET @m7_sql_impersonation = IF(@m7_has_impersonation = 0,
  'CREATE TABLE impersonation_sessions (
    id CHAR(36) PRIMARY KEY,
    started_by CHAR(36) NOT NULL,
    approved_by CHAR(36) NULL,
    target_user_id CHAR(36) NOT NULL,
    tenant_id CHAR(36) NOT NULL,
    reason VARCHAR(1000) NOT NULL,
    scope ENUM(''read'',''write'') NOT NULL DEFAULT ''read'',
    status ENUM(''pending_approval'',''active'',''revoked'',''expired'') NOT NULL DEFAULT ''pending_approval'',
    requested_seconds INT UNSIGNED NULL,
    expires_at TIMESTAMP NULL,
    revoked_at TIMESTAMP NULL,
    revoked_by CHAR(36) NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NULL,
    CONSTRAINT fk_imp_started_by FOREIGN KEY (started_by) REFERENCES users(id),
    CONSTRAINT fk_imp_target_user FOREIGN KEY (target_user_id) REFERENCES users(id),
    CONSTRAINT fk_imp_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id),
    INDEX idx_imp_target_user (target_user_id, status),
    INDEX idx_imp_tenant (tenant_id, status),
    INDEX idx_imp_started (started_by, created_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci',
  'SELECT 1');
PREPARE m7_stmt_impersonation FROM @m7_sql_impersonation;
EXECUTE m7_stmt_impersonation;
DEALLOCATE PREPARE m7_stmt_impersonation;
