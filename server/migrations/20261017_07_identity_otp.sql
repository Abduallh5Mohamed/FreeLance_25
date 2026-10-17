-- Contact-verification (OTP) challenge lifecycle for identity flows (S2).
-- Safe to re-run. This FILE is never executed by this task outside the owned
-- isolated validation stack, and historical migrations are untouched.
--
-- Only HMAC hashes of one-time codes are persisted; plaintext codes are never
-- stored or logged. Challenges are single-use (consumed_at), attempt-capped,
-- expiring, and bound to contact + purpose + tenant + identity.

SET @m1_identity_otp_exists = (
    SELECT COUNT(*)
    FROM information_schema.TABLES
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'identity_otp_challenges'
);
SET @m1_identity_otp_ddl = IF(
    @m1_identity_otp_exists = 0,
    'CREATE TABLE identity_otp_challenges (
        id CHAR(36) NOT NULL,
        contact_hash CHAR(64) NOT NULL,
        purpose VARCHAR(32) NOT NULL,
        tenant_id CHAR(36) NULL,
        identity_id VARCHAR(64) NULL,
        code_hash CHAR(64) NOT NULL,
        attempts INT NOT NULL DEFAULT 0,
        max_attempts INT NOT NULL DEFAULT 5,
        resend_available_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        expires_at TIMESTAMP NOT NULL,
        consumed_at TIMESTAMP NULL DEFAULT NULL,
        created_ip VARCHAR(64) NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY idx_identity_otp_contact (contact_hash, purpose, consumed_at),
        KEY idx_identity_otp_expiry (expires_at, consumed_at),
        CONSTRAINT fk_identity_otp_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci',
    'SELECT 1'
);
PREPARE m1_identity_otp_stmt FROM @m1_identity_otp_ddl;
EXECUTE m1_identity_otp_stmt;
DEALLOCATE PREPARE m1_identity_otp_stmt;
