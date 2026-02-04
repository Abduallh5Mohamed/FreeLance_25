-- Add missing column to staff table
ALTER TABLE staff ADD COLUMN accessible_pages TEXT DEFAULT NULL;

-- Add messages table if not exists
CREATE TABLE IF NOT EXISTS messages (
  id VARCHAR(36) PRIMARY KEY DEFAULT (UUID()),
  sender_id VARCHAR(36) NOT NULL,
  receiver_id VARCHAR(36) NOT NULL,
  message TEXT NOT NULL,
  is_read TINYINT(1) DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_sender (sender_id),
  INDEX idx_receiver (receiver_id),
  INDEX idx_created (created_at)
);

-- Add conversations table if not exists
CREATE TABLE IF NOT EXISTS conversations (
  id VARCHAR(36) PRIMARY KEY DEFAULT (UUID()),
  user1_id VARCHAR(36) NOT NULL,
  user2_id VARCHAR(36) NOT NULL,
  last_message_id VARCHAR(36),
  last_message_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY unique_conversation (user1_id, user2_id),
  INDEX idx_user1 (user1_id),
  INDEX idx_user2 (user2_id)
);

-- Add premium_lectures table if not exists
CREATE TABLE IF NOT EXISTS premium_lectures (
  id VARCHAR(36) PRIMARY KEY DEFAULT (UUID()),
  lecture_id VARCHAR(36) NOT NULL,
  price DECIMAL(10,2) NOT NULL DEFAULT 0,
  is_active TINYINT(1) DEFAULT 1,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- Add lecture_purchases table if not exists  
CREATE TABLE IF NOT EXISTS lecture_purchases (
  id VARCHAR(36) PRIMARY KEY DEFAULT (UUID()),
  student_id VARCHAR(36) NOT NULL,
  lecture_id VARCHAR(36) NOT NULL,
  amount DECIMAL(10,2) NOT NULL,
  payment_method VARCHAR(50) DEFAULT 'manual',
  payment_status ENUM('pending', 'completed', 'failed', 'refunded') DEFAULT 'pending',
  transaction_id VARCHAR(100),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY unique_purchase (student_id, lecture_id)
);

-- Add ai_chat_history table if not exists
CREATE TABLE IF NOT EXISTS ai_chat_history (
  id VARCHAR(36) PRIMARY KEY DEFAULT (UUID()),
  user_id VARCHAR(36) NOT NULL,
  message TEXT NOT NULL,
  response TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Add video_uploads table if not exists
CREATE TABLE IF NOT EXISTS video_uploads (
  id VARCHAR(36) PRIMARY KEY DEFAULT (UUID()),
  lecture_id VARCHAR(36),
  filename VARCHAR(255) NOT NULL,
  original_name VARCHAR(255),
  file_size BIGINT,
  mime_type VARCHAR(100),
  status ENUM('pending', 'processing', 'completed', 'failed') DEFAULT 'pending',
  upload_progress INT DEFAULT 0,
  hls_path VARCHAR(500),
  thumbnail_path VARCHAR(500),
  duration INT,
  resolution VARCHAR(20),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- Add exam_attempts table if not exists
CREATE TABLE IF NOT EXISTS exam_attempts (
  id VARCHAR(36) PRIMARY KEY DEFAULT (UUID()),
  exam_id VARCHAR(36) NOT NULL,
  student_id VARCHAR(36) NOT NULL,
  started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  submitted_at TIMESTAMP NULL,
  time_spent INT DEFAULT 0,
  answers JSON,
  score DECIMAL(5,2),
  status ENUM('in_progress', 'submitted', 'graded') DEFAULT 'in_progress',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);
