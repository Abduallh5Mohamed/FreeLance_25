#!/bin/bash
# Video Security v4.0 DB Migration
MYSQL_PWD='NewSecureP@ssw0rd2025!' mysql -u root freelance << 'EOSQL'

-- Create video_sessions table
CREATE TABLE IF NOT EXISTS video_sessions (
    id VARCHAR(36) PRIMARY KEY,
    user_id INT NOT NULL,
    video_id VARCHAR(255) NOT NULL,
    ip_address VARCHAR(45),
    user_agent TEXT,
    fingerprint VARCHAR(255),
    screen_resolution VARCHAR(20),
    watermark_seed VARCHAR(64),
    is_active BOOLEAN DEFAULT TRUE,
    violation_score INT DEFAULT 0,
    killed_reason VARCHAR(255) NULL,
    killed_at DATETIME NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_heartbeat DATETIME DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_user_active (user_id, is_active),
    INDEX idx_video (video_id),
    INDEX idx_heartbeat (last_heartbeat)
);

-- Create video_security_logs if not exists
CREATE TABLE IF NOT EXISTS video_security_logs (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    video_id VARCHAR(255),
    event_type VARCHAR(50) NOT NULL,
    details TEXT,
    ip_address VARCHAR(45),
    user_agent TEXT,
    session_id VARCHAR(36) NULL,
    violation_score INT DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_user (user_id),
    INDEX idx_event (event_type),
    INDEX idx_session (session_id),
    INDEX idx_created (created_at)
);

-- Add session_id to video_security_logs if doesn't exist
SET @col = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA='freelance' AND TABLE_NAME='video_security_logs' AND COLUMN_NAME='session_id');
SET @s = IF(@col=0, 'ALTER TABLE video_security_logs ADD COLUMN session_id VARCHAR(36) NULL', 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Add violation_score to video_security_logs
SET @col = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA='freelance' AND TABLE_NAME='video_security_logs' AND COLUMN_NAME='violation_score');
SET @s = IF(@col=0, 'ALTER TABLE video_security_logs ADD COLUMN violation_score INT DEFAULT 0', 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Add suspended_until to users
SET @col = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA='freelance' AND TABLE_NAME='users' AND COLUMN_NAME='suspended_until');
SET @s = IF(@col=0, 'ALTER TABLE users ADD COLUMN suspended_until DATETIME NULL', 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Add suspension_reason to users
SET @col = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA='freelance' AND TABLE_NAME='users' AND COLUMN_NAME='suspension_reason');
SET @s = IF(@col=0, 'ALTER TABLE users ADD COLUMN suspension_reason VARCHAR(255) NULL', 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SELECT 'Migration complete!' AS status;
EOSQL
