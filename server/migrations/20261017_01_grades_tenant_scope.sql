-- ============================================================
-- Grades tenant scoping (2026-10-17)
-- ============================================================
-- POLICY: grades are PER-TENANT. A row with a tenant_id belongs to exactly
-- one tenant; a NULL tenant_id is a legacy SHARED catalog row that every
-- authenticated principal may read and only a verified platform permission
-- (grade.manage) may write.
--
-- This FILE is idempotent: every step is guarded by INFORMATION_SCHEMA, so
-- re-running it is a no-op. It is not executed by the application at runtime
-- (no DDL belongs in runtime code); it is applied by the operator.
--
-- Steps:
--   1. add nullable grades.tenant_id CHAR(36)
--   2. add the tenant lookup index (idempotent name check)
--   3. add the tenant foreign key (idempotent name check)
-- ============================================================

-- Step 1: nullable tenant column (existing rows keep NULL = shared catalog).
SET @col_exists = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'grades' AND COLUMN_NAME = 'tenant_id');

SET @sql = IF(@col_exists = 0,
  'ALTER TABLE grades ADD COLUMN tenant_id CHAR(36) NULL AFTER id',
  'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Step 2: index for the per-tenant read predicate.
SET @idx_exists = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'grades' AND INDEX_NAME = 'idx_grades_tenant');

SET @sql2 = IF(@idx_exists = 0,
  'ALTER TABLE grades ADD INDEX idx_grades_tenant (tenant_id)',
  'SELECT 1');
PREPARE stmt2 FROM @sql2;
EXECUTE stmt2;
DEALLOCATE PREPARE stmt2;

-- Step 3: foreign key to tenants(id) (nullable column, so NULL rows are kept).
SET @fk_exists = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
  WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'grades' AND CONSTRAINT_NAME = 'fk_grades_tenant');

SET @sql3 = IF(@fk_exists = 0,
  'ALTER TABLE grades ADD CONSTRAINT fk_grades_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE SET NULL',
  'SELECT 1');
PREPARE stmt3 FROM @sql3;
EXECUTE stmt3;
DEALLOCATE PREPARE stmt3;
