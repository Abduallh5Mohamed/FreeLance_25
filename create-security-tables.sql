-- Video Security Logs Table
-- This table stores all security violation attempts
-- Version 4.0 - Enhanced security logging

CREATE TABLE IF NOT EXISTS video_security_logs (
    id VARCHAR(36) PRIMARY KEY,
    user_id VARCHAR(36) NOT NULL,
    video_id VARCHAR(36) NOT NULL,
    activity_type VARCHAR(50) NOT NULL COMMENT 'screenshot, screenrecord, alttab, blur, focus_loss, devtools, resize, keyboard, pip, unknown',
    ip_address VARCHAR(100),
    user_agent TEXT,
    details TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    INDEX idx_user_id (user_id),
    INDEX idx_video_id (video_id),
    INDEX idx_activity_type (activity_type),
    INDEX idx_created_at (created_at),
    
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Add additional security-related columns to videos table if not exists
ALTER TABLE videos 
ADD COLUMN IF NOT EXISTS is_drm_protected BOOLEAN DEFAULT FALSE COMMENT 'Whether DRM protection is enabled',
ADD COLUMN IF NOT EXISTS security_level ENUM('low', 'medium', 'high', 'ultra') DEFAULT 'high' COMMENT 'Security level for the video';

-- Create index for faster security lookups
CREATE INDEX IF NOT EXISTS idx_security_logs_user_time ON video_security_logs(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_security_logs_video_time ON video_security_logs(video_id, created_at DESC);

-- View for recent security violations (optional)
CREATE OR REPLACE VIEW recent_security_violations AS
SELECT 
    vsl.*,
    u.name as user_name,
    u.phone as user_phone,
    v.title as video_title
FROM video_security_logs vsl
LEFT JOIN users u ON vsl.user_id = u.id
LEFT JOIN videos v ON vsl.video_id = v.id
WHERE vsl.created_at > DATE_SUB(NOW(), INTERVAL 24 HOUR)
ORDER BY vsl.created_at DESC;

-- Procedure to get violation summary for a user
DELIMITER //
CREATE PROCEDURE IF NOT EXISTS GetUserViolationSummary(IN p_user_id VARCHAR(36))
BEGIN
    SELECT 
        COUNT(*) as total_violations,
        COUNT(DISTINCT video_id) as videos_affected,
        SUM(CASE WHEN activity_type = 'screenshot' THEN 1 ELSE 0 END) as screenshot_attempts,
        SUM(CASE WHEN activity_type = 'screenrecord' THEN 1 ELSE 0 END) as recording_attempts,
        SUM(CASE WHEN activity_type = 'focus_loss' THEN 1 ELSE 0 END) as focus_loss_count,
        MIN(created_at) as first_violation,
        MAX(created_at) as last_violation
    FROM video_security_logs
    WHERE user_id = p_user_id;
END //
DELIMITER ;

SELECT 'Security tables and procedures created successfully!' as status;
