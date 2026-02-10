-- Create missing video_security_logs table
CREATE TABLE IF NOT EXISTS video_security_logs (
    id VARCHAR(36) PRIMARY KEY,
    user_id VARCHAR(36),
    video_id VARCHAR(36),
    activity_type VARCHAR(50),
    ip_address VARCHAR(45),
    user_agent TEXT,
    details TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_user_id (user_id),
    INDEX idx_video_id (video_id),
    INDEX idx_created_at (created_at)
);

-- Fix qualities_available column - update invalid JSON values
UPDATE videos SET qualities_available = '["original"]' WHERE qualities_available IS NULL OR qualities_available = '' OR qualities_available = "[ 'original' ]";
