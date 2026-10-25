-- Source only: never executed by authoring/review. MySQL 8.0.16+ enforced CHECKs.
-- Create once under the migration runner. Existing table -> fail; do not silently
-- accept an unverified shape via IF NOT EXISTS. No data backfill or flag activation.
-- user_id is polymorphic users/staff; no misleading FK to only one identity table.
-- Enable AUTH_LOGIN_SESSIONS_ENABLED only after independent schema/upgrade verification.
CREATE TABLE login_sessions (
    id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    user_id VARCHAR(36) COLLATE utf8mb4_0900_bin NOT NULL,
    identity_source ENUM('users','staff') NOT NULL,
    token_version BIGINT UNSIGNED NOT NULL,
    issued_at_ms BIGINT UNSIGNED NOT NULL,
    expires_at_ms BIGINT UNSIGNED NOT NULL,
    revoked_at_ms BIGINT UNSIGNED NULL,
    PRIMARY KEY (id),
    KEY idx_login_session_identity (user_id, identity_source),
    KEY idx_login_session_expiry (expires_at_ms, id),
    CONSTRAINT chk_login_session_version CHECK (token_version <= 9007199254740991),
    CONSTRAINT chk_login_session_lifetime CHECK (
        issued_at_ms < expires_at_ms AND expires_at_ms <= 9007199254740991
        AND (revoked_at_ms IS NULL OR (revoked_at_ms >= issued_at_ms AND revoked_at_ms <= 9007199254740991))
    ),
    CONSTRAINT chk_login_session_uuid CHECK (id REGEXP '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
    CONSTRAINT chk_login_session_user CHECK (CHAR_LENGTH(user_id) BETWEEN 1 AND 36 AND BINARY user_id = BINARY TRIM(user_id))
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin;
