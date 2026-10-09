-- Video Security System Tables
-- Run this migration on the server

-- Video Sessions table
CREATE TABLE IF NOT EXISTS video_sessions (
    id VARCHAR(36) PRIMARY KEY,
    user_id VARCHAR(36) NOT NULL,
    video_id VARCHAR(36) NOT NULL,
    ip_address VARCHAR(45),
    user_agent TEXT,
    fingerprint VARCHAR(255),
    screen_resolution VARCHAR(50),
    watermark_seed VARCHAR(64),
    is_active BOOLEAN DEFAULT TRUE,
    violation_score INT DEFAULT 0,
    killed_reason VARCHAR(255),
    killed_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_user_id (user_id),
    INDEX idx_video_id (video_id),
    INDEX idx_active (is_active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Add session_id and violation_score to existing security logs
ALTER TABLE video_security_logs 
    ADD COLUMN IF NOT EXISTS session_id VARCHAR(36),
    ADD COLUMN IF NOT EXISTS violation_score INT DEFAULT 0;

-- Add suspension columns to users table
ALTER TABLE users 
    ADD COLUMN IF NOT EXISTS suspended_until DATETIME NULL,
    ADD COLUMN IF NOT EXISTS suspension_reason TEXT NULL;

-- Ensure video_security_logs table exists
CREATE TABLE IF NOT EXISTS video_security_logs (
    id VARCHAR(36) PRIMARY KEY,
    user_id VARCHAR(36),
    video_id VARCHAR(36),
    activity_type VARCHAR(100),
    ip_address VARCHAR(45),
    user_agent TEXT,
    details TEXT,
    session_id VARCHAR(36),
    violation_score INT DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_user (user_id),
    INDEX idx_session (session_id),
    INDEX idx_type (activity_type),
    INDEX idx_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
