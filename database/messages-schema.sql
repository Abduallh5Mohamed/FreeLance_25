-- Messages System Schema
-- Tables for messaging system between teachers and students

-- Table: messages
-- Stores all messages sent between users
CREATE TABLE IF NOT EXISTS messages (
    id INT PRIMARY KEY AUTO_INCREMENT,
    sender_id CHAR(36) NOT NULL,
    receiver_id CHAR(36) NOT NULL,
    message_type ENUM('text', 'image') DEFAULT 'text',
    content TEXT,
    image_url VARCHAR(500),
    is_edited BOOLEAN DEFAULT FALSE,
    edited_at DATETIME,
    is_deleted BOOLEAN DEFAULT FALSE,
    deleted_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (sender_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (receiver_id) REFERENCES users(id) ON DELETE CASCADE,
    INDEX idx_sender (sender_id),
    INDEX idx_receiver (receiver_id),
    INDEX idx_created_at (created_at),
    INDEX idx_conversation (sender_id, receiver_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Table: message_status
-- Tracks delivery and read status of messages
CREATE TABLE IF NOT EXISTS message_status (
    id INT PRIMARY KEY AUTO_INCREMENT,
    message_id INT NOT NULL,
    is_delivered BOOLEAN DEFAULT FALSE,
    delivered_at DATETIME,
    is_read BOOLEAN DEFAULT FALSE,
    read_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE,
    INDEX idx_message (message_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Table: user_online_status
-- Tracks online/offline status of users
CREATE TABLE IF NOT EXISTS user_online_status (
    id INT PRIMARY KEY AUTO_INCREMENT,
    user_id CHAR(36) NOT NULL UNIQUE,
    is_online BOOLEAN DEFAULT FALSE,
    last_seen DATETIME DEFAULT CURRENT_TIMESTAMP,
    socket_id VARCHAR(100),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    INDEX idx_user (user_id),
    INDEX idx_online (is_online)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Table: conversations
-- Stores conversation metadata for quick access
CREATE TABLE IF NOT EXISTS conversations (
    id INT PRIMARY KEY AUTO_INCREMENT,
    user1_id CHAR(36) NOT NULL,
    user2_id CHAR(36) NOT NULL,
    last_message_id INT,
    unread_count_user1 INT DEFAULT 0,
    unread_count_user2 INT DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (user1_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (user2_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (last_message_id) REFERENCES messages(id) ON DELETE SET NULL,
    UNIQUE KEY unique_conversation (user1_id, user2_id),
    INDEX idx_user1 (user1_id),
    INDEX idx_user2 (user2_id),
    INDEX idx_updated (updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
