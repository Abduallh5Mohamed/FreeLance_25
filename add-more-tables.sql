-- Add user_online_status table
CREATE TABLE IF NOT EXISTS user_online_status (
  id VARCHAR(36) PRIMARY KEY DEFAULT (UUID()),
  user_id VARCHAR(36) NOT NULL UNIQUE,
  is_online TINYINT(1) DEFAULT 0,
  last_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  socket_id VARCHAR(100),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- Add missing columns to conversations
ALTER TABLE conversations ADD COLUMN unread_count_user1 INT DEFAULT 0;
ALTER TABLE conversations ADD COLUMN unread_count_user2 INT DEFAULT 0;

-- Add content column to messages if missing
ALTER TABLE messages ADD COLUMN content TEXT;
ALTER TABLE messages ADD COLUMN message_type VARCHAR(50) DEFAULT 'text';

-- Update messages: copy message to content if content is null
UPDATE messages SET content = message WHERE content IS NULL;
