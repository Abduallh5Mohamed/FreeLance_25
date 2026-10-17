-- Add a one-time submission flag to identity OTP challenges (H1).
-- Safe to re-run. This FILE is never executed by this task outside the owned
-- isolated validation stack, and historical migrations are untouched.

SET @m1_otp_submission_col_exists = (
    SELECT COUNT(*)
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'identity_otp_challenges'
      AND COLUMN_NAME = 'submitted_at'
);
SET @m1_otp_submission_ddl = IF(
    @m1_otp_submission_col_exists = 0,
    'ALTER TABLE identity_otp_challenges ADD COLUMN submitted_at TIMESTAMP NULL DEFAULT NULL AFTER consumed_at',
    'SELECT 1'
);
PREPARE m1_otp_submission_stmt FROM @m1_otp_submission_ddl;
EXECUTE m1_otp_submission_stmt;
DEALLOCATE PREPARE m1_otp_submission_stmt;

SET @m1_otp_submission_idx_exists = (
    SELECT COUNT(*)
    FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'identity_otp_challenges'
      AND INDEX_NAME = 'idx_identity_otp_submitted'
);
SET @m1_otp_submission_idx_ddl = IF(
    @m1_otp_submission_idx_exists = 0,
    'CREATE INDEX idx_identity_otp_submitted ON identity_otp_challenges (submitted_at)',
    'SELECT 1'
);
PREPARE m1_otp_submission_idx_stmt FROM @m1_otp_submission_idx_ddl;
EXECUTE m1_otp_submission_idx_stmt;
DEALLOCATE PREPARE m1_otp_submission_idx_stmt;
