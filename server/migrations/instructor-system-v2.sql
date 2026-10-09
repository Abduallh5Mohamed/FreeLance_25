-- ============================================
-- Instructor System Migration (Fixed for CHAR(36) UUIDs)
-- ============================================
-- Run this file once on your MySQL database.

-- Step 1: Add 'instructor' to the users.role ENUM (if not already present)
-- Use a safe approach that won't fail if instructor is already in the ENUM
SET @enum_values = (SELECT COLUMN_TYPE FROM INFORMATION_SCHEMA.COLUMNS 
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'role');

-- Only alter if 'instructor' is not already in the ENUM
-- This handles the case where the ENUM already includes 'instructor'
ALTER TABLE users MODIFY COLUMN role ENUM('admin', 'teacher', 'student', 'instructor', 'staff') NOT NULL DEFAULT 'student';

-- ============================================
-- Table: instructor_wallets
-- One wallet per instructor (instructor_id is CHAR(36) UUID)
-- ============================================
CREATE TABLE IF NOT EXISTS instructor_wallets (
    id INT AUTO_INCREMENT PRIMARY KEY,
    instructor_id CHAR(36) NOT NULL,
    balance DECIMAL(10,2) NOT NULL DEFAULT 0.00,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_instructor_wallet (instructor_id),
    FOREIGN KEY (instructor_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================
-- Table: instructor_wallet_transactions
-- Audit log for every credit / debit
-- ============================================
CREATE TABLE IF NOT EXISTS instructor_wallet_transactions (
    id INT AUTO_INCREMENT PRIMARY KEY,
    instructor_id CHAR(36) NOT NULL,
    type ENUM('credit', 'debit') NOT NULL,
    amount DECIMAL(10,2) NOT NULL,
    balance_after DECIMAL(10,2) NOT NULL DEFAULT 0.00,
    description VARCHAR(500),
    reference_id INT DEFAULT NULL,
    created_by CHAR(36) DEFAULT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (instructor_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================
-- Table: instructor_video_requests
-- Request from one instructor to another for a lecture
-- ============================================
CREATE TABLE IF NOT EXISTS instructor_video_requests (
    id INT AUTO_INCREMENT PRIMARY KEY,
    requester_id CHAR(36) NOT NULL,
    owner_id CHAR(36) NOT NULL,
    lecture_id CHAR(36) NOT NULL,
    status ENUM('pending', 'approved_free', 'approved_paid', 'rejected') NOT NULL DEFAULT 'pending',
    offered_price DECIMAL(10,2) DEFAULT NULL,
    message TEXT DEFAULT NULL,
    owner_response TEXT DEFAULT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (requester_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (lecture_id) REFERENCES lectures(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================
-- Table: instructor_shared_lectures
-- Tracks which lectures an instructor has access to
-- ============================================
CREATE TABLE IF NOT EXISTS instructor_shared_lectures (
    id INT AUTO_INCREMENT PRIMARY KEY,
    instructor_id CHAR(36) NOT NULL,
    lecture_id CHAR(36) NOT NULL,
    request_id INT NOT NULL,
    obtained_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_instructor_lecture (instructor_id, lecture_id),
    FOREIGN KEY (instructor_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (lecture_id) REFERENCES lectures(id) ON DELETE CASCADE,
    FOREIGN KEY (request_id) REFERENCES instructor_video_requests(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================
-- Add instructor_id to lectures table (if not exists)
-- ============================================
SET @col_exists = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS 
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'lectures' AND COLUMN_NAME = 'instructor_id');

SET @sql = IF(@col_exists = 0, 
  'ALTER TABLE lectures ADD COLUMN instructor_id CHAR(36) DEFAULT NULL AFTER group_id, ADD INDEX idx_instructor_id (instructor_id)',
  'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- ============================================
-- Add instructor_id to students table (if not exists)
-- ============================================
SET @col_exists2 = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS 
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'students' AND COLUMN_NAME = 'instructor_id');

SET @sql2 = IF(@col_exists2 = 0, 
  'ALTER TABLE students ADD COLUMN instructor_id CHAR(36) DEFAULT NULL AFTER group_id, ADD INDEX idx_inst_id (instructor_id)',
  'SELECT 1');
PREPARE stmt2 FROM @sql2;
EXECUTE stmt2;
DEALLOCATE PREPARE stmt2;

-- ============================================
-- Auto-create wallet for existing instructors
-- ============================================
INSERT IGNORE INTO instructor_wallets (instructor_id, balance)
SELECT id, 0.00 FROM users WHERE role = 'instructor';
