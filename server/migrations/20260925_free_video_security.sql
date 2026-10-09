-- Free encrypted-HLS session security. This deliberately keeps legacy paid
-- provider columns untouched while removing them from the runtime path.

CREATE TABLE video_sessions (
  id CHAR(36) PRIMARY KEY,
  user_id CHAR(36) NOT NULL,
  video_id CHAR(36) NOT NULL,
  ip_address VARCHAR(45) NULL,
  user_agent TEXT NULL,
  fingerprint VARCHAR(255) NOT NULL,
  screen_resolution VARCHAR(50) NULL,
  watermark_seed CHAR(32) NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  active_user_id CHAR(36) GENERATED ALWAYS AS (IF(is_active,user_id,NULL)) STORED,
  violation_score INT NOT NULL DEFAULT 0,
  killed_reason VARCHAR(255) NULL,
  killed_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_video_session_video (video_id,created_at),
  UNIQUE KEY uq_video_session_active_user (active_user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE video_security_logs (
  id CHAR(36) PRIMARY KEY,
  user_id CHAR(36) NOT NULL,
  video_id CHAR(36) NULL,
  activity_type VARCHAR(100) NOT NULL,
  ip_address VARCHAR(45) NULL,
  user_agent TEXT NULL,
  details TEXT NULL,
  session_id CHAR(36) NULL,
  violation_score INT NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_video_security_user (user_id,created_at),
  INDEX idx_video_security_session (session_id),
  INDEX idx_video_security_type (activity_type,created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE users
  ADD COLUMN suspended_until DATETIME NULL,
  ADD COLUMN suspension_reason TEXT NULL;
