-- Create online_meetings table
CREATE TABLE IF NOT EXISTS online_meetings (
    id VARCHAR(36) PRIMARY KEY DEFAULT (UUID()),
    title VARCHAR(255) NOT NULL,
    description TEXT,
    meeting_link VARCHAR(500) NOT NULL,
    meeting_type ENUM('zoom', 'google_meet', 'other') DEFAULT 'zoom',
    grade_id VARCHAR(36) NOT NULL,
    group_id VARCHAR(36) DEFAULT NULL,
    scheduled_at DATETIME NOT NULL,
    duration_minutes INT DEFAULT 60,
    is_active TINYINT(1) DEFAULT 1,
    created_by VARCHAR(36) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (grade_id) REFERENCES grades(id) ON DELETE CASCADE,
    FOREIGN KEY (group_id) REFERENCES `groups`(id) ON DELETE SET NULL,
    FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE CASCADE
);

-- Add index for faster queries
CREATE INDEX idx_meetings_grade ON online_meetings(grade_id);
CREATE INDEX idx_meetings_group ON online_meetings(group_id);
CREATE INDEX idx_meetings_scheduled ON online_meetings(scheduled_at);
