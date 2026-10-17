-- Add staff session revocation state. Safe to re-run and not executed here.
SET @staff_token_version_exists = (
    SELECT COUNT(*)
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'staff'
      AND COLUMN_NAME = 'token_version'
);
SET @staff_token_version_ddl = IF(
    @staff_token_version_exists = 0,
    'ALTER TABLE staff ADD COLUMN token_version INT NOT NULL DEFAULT 0',
    'SELECT 1'
);
PREPARE staff_token_version_stmt FROM @staff_token_version_ddl;
EXECUTE staff_token_version_stmt;
DEALLOCATE PREPARE staff_token_version_stmt;
