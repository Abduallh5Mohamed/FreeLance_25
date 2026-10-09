CREATE TABLE video_security_consents (
  id CHAR(36) PRIMARY KEY,
  user_id CHAR(36) NOT NULL,
  terms_version VARCHAR(40) NOT NULL,
  accepted_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ip_address VARCHAR(45) NULL,
  user_agent TEXT NULL,
  UNIQUE KEY uq_video_consent_user_version (user_id,terms_version),
  INDEX idx_video_consent_accepted (accepted_at),
  FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE video_security_logs
  ADD COLUMN violation_weight INT NOT NULL DEFAULT 1 AFTER violation_score,
  ADD COLUMN confidence ENUM('low','medium','high') NOT NULL DEFAULT 'medium' AFTER violation_weight;
