-- Create message_deletions table for per-user message deletion
CREATE TABLE IF NOT EXISTS message_deletions (
    id INT AUTO_INCREMENT PRIMARY KEY,
    message_id INT NOT NULL,
    user_id VARCHAR(36) NOT NULL,
    deleted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY unique_message_user (message_id, user_id),
    INDEX idx_user_message (user_id, message_id),
    FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
);

-- Remove is_deleted column from messages table (no longer needed)
-- Note: Uncomment these lines after migrating data if needed
-- ALTER TABLE messages DROP COLUMN IF EXISTS is_deleted;
-- ALTER TABLE messages DROP COLUMN IF EXISTS deleted_at;
