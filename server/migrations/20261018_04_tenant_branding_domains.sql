-- ============================================================
-- Tenant branding + custom domains (2026-10-18, task C2/C3)
-- ============================================================
-- Idempotent: every step is guarded by INFORMATION_SCHEMA / IF NOT EXISTS.
-- Not executed at runtime; applied by the operator.
-- ============================================================

-- 1. Platform subdomain key on tenants (nullable, unique when present).
SET @col_exists = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'tenants' AND COLUMN_NAME = 'subdomain');
SET @sql = IF(@col_exists = 0,
  'ALTER TABLE tenants ADD COLUMN subdomain VARCHAR(63) NULL AFTER business_name',
  'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @idx_exists = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'tenants' AND INDEX_NAME = 'uq_tenants_subdomain');
SET @sql2 = IF(@idx_exists = 0,
  'ALTER TABLE tenants ADD UNIQUE INDEX uq_tenants_subdomain (subdomain)',
  'SELECT 1');
PREPARE stmt2 FROM @sql2;
EXECUTE stmt2;
DEALLOCATE PREPARE stmt2;

-- 2. Challenge expiry on custom-domain claims.
SET @col_exists = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'tenant_custom_domains' AND COLUMN_NAME = 'expires_at');
SET @sql3 = IF(@col_exists = 0,
  'ALTER TABLE tenant_custom_domains ADD COLUMN expires_at DATETIME NULL AFTER verified_at',
  'SELECT 1');
PREPARE stmt3 FROM @sql3;
EXECUTE stmt3;
DEALLOCATE PREPARE stmt3;

-- 3. Tenant branding settings.
CREATE TABLE IF NOT EXISTS tenant_branding (
  tenant_id CHAR(36) NOT NULL PRIMARY KEY,
  logo_url VARCHAR(2048) NULL,
  primary_color VARCHAR(16) NULL,
  secondary_color VARCHAR(16) NULL,
  accent_color VARCHAR(16) NULL,
  locale VARCHAR(8) NOT NULL DEFAULT 'ar',
  rtl TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_tenant_branding_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
