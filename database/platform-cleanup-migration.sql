-- ============================================
-- Al-Qaed Educational Platform
-- Comprehensive Database Cleanup Migration
-- ============================================
-- Run this ONCE on the production database
-- Purpose: Fix relations, clean up unused columns,
--          ensure proper educational platform structure

USE Freelance;

-- ============================================
-- 1. Fix users.role ENUM (add instructor + staff)
-- ============================================
ALTER TABLE users MODIFY COLUMN role 
    ENUM('admin', 'teacher', 'student', 'instructor', 'staff') 
    NOT NULL DEFAULT 'student';

-- ============================================
-- 2. Add missing columns to users table
-- ============================================
-- suspended_until / suspension_reason (for video security)
SET @col = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS 
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'suspended_until');
SET @sql = IF(@col = 0, 
  'ALTER TABLE users ADD COLUMN suspended_until DATETIME NULL AFTER updated_at', 
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS 
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'suspension_reason');
SET @sql = IF(@col = 0, 
  'ALTER TABLE users ADD COLUMN suspension_reason TEXT NULL AFTER suspended_until', 
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ============================================
-- 3. Students table - fix relations & add columns
-- ============================================

-- Add foreign key for group_id if missing
SET @fk = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'students' AND COLUMN_NAME = 'group_id' AND REFERENCED_TABLE_NAME IS NOT NULL);
SET @sql = IF(@fk = 0,
  'ALTER TABLE students ADD CONSTRAINT fk_students_group FOREIGN KEY (group_id) REFERENCES `groups`(id) ON DELETE SET NULL',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Add instructor_id if missing
SET @col = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS 
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'students' AND COLUMN_NAME = 'instructor_id');
SET @sql = IF(@col = 0,
  'ALTER TABLE students ADD COLUMN instructor_id CHAR(36) DEFAULT NULL AFTER group_id, ADD INDEX idx_inst_id (instructor_id)',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ============================================
-- 4. Lectures table - ensure proper structure
-- ============================================
-- Check if lectures table exists, create if not
CREATE TABLE IF NOT EXISTS lectures (
    id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
    course_id CHAR(36) NOT NULL,
    grade_id CHAR(36) DEFAULT NULL,
    group_id CHAR(36) DEFAULT NULL,
    instructor_id CHAR(36) DEFAULT NULL,
    title VARCHAR(255) NOT NULL,
    description TEXT,
    video_url VARCHAR(500),
    duration_minutes INT DEFAULT 0,
    display_order INT DEFAULT 0,
    is_free BOOLEAN DEFAULT FALSE,
    is_published BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (course_id) REFERENCES courses(id) ON DELETE CASCADE,
    FOREIGN KEY (grade_id) REFERENCES grades(id) ON DELETE SET NULL,
    FOREIGN KEY (group_id) REFERENCES `groups`(id) ON DELETE SET NULL,
    FOREIGN KEY (instructor_id) REFERENCES users(id) ON DELETE SET NULL,
    INDEX idx_course_id (course_id),
    INDEX idx_grade_id (grade_id),
    INDEX idx_group_id (group_id),
    INDEX idx_instructor_id (instructor_id),
    INDEX idx_published (is_published)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Add instructor_id column if missing
SET @col = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS 
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'lectures' AND COLUMN_NAME = 'instructor_id');
SET @sql = IF(@col = 0,
  'ALTER TABLE lectures ADD COLUMN instructor_id CHAR(36) DEFAULT NULL AFTER group_id, ADD INDEX idx_instructor_id (instructor_id)',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Add grade_id column if missing
SET @col = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS 
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'lectures' AND COLUMN_NAME = 'grade_id');
SET @sql = IF(@col = 0,
  'ALTER TABLE lectures ADD COLUMN grade_id CHAR(36) DEFAULT NULL AFTER course_id, ADD INDEX idx_grade_id (grade_id)',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Add group_id column if missing
SET @col = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS 
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'lectures' AND COLUMN_NAME = 'group_id');
SET @sql = IF(@col = 0,
  'ALTER TABLE lectures ADD COLUMN group_id CHAR(36) DEFAULT NULL AFTER grade_id, ADD INDEX idx_group_id (group_id)',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ============================================
-- 5. Remove redundant/useless columns
-- ============================================

-- students.grade (text field) - redundant since we have grade_id FK
-- Keep it for backward compatibility but it's not used in new code
-- Do NOT drop - existing queries may reference it

-- courses.grade (text field) - redundant since we have grade_id via groups
-- Do NOT drop - existing queries may reference it

-- ============================================
-- 6. Instructor system tables
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
-- 7. Staff table - add auth columns if missing
-- ============================================
SET @col = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS 
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'staff' AND COLUMN_NAME = 'password_hash');
SET @sql = IF(@col = 0,
  'ALTER TABLE staff ADD COLUMN password_hash VARCHAR(255) NULL AFTER phone',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS 
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'staff' AND COLUMN_NAME = 'accessible_pages');
SET @sql = IF(@col = 0,
  'ALTER TABLE staff ADD COLUMN accessible_pages JSON DEFAULT \'[]\' AFTER role',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Add phone index if missing
SET @idx = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'staff' AND INDEX_NAME = 'idx_staff_phone');
SET @sql = IF(@idx = 0,
  'CREATE INDEX idx_staff_phone ON staff(phone)',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ============================================
-- 8. Subscription requests table
-- ============================================
CREATE TABLE IF NOT EXISTS subscription_requests (
    id INT AUTO_INCREMENT PRIMARY KEY,
    student_name VARCHAR(255) NOT NULL,
    phone VARCHAR(50) NOT NULL,
    guardian_phone VARCHAR(50),
    grade_id INT,
    grade_name VARCHAR(255),
    group_id INT,
    group_name VARCHAR(255),
    subscription_plan_id INT,
    subscription_plan_name VARCHAR(255),
    amount DECIMAL(10,2),
    notes TEXT,
    receipt_image_url VARCHAR(500),
    status ENUM('pending', 'approved', 'rejected') DEFAULT 'pending',
    rejection_reason TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_status (status),
    INDEX idx_phone (phone)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================
-- 9. Ensure proper indexes on all tables
-- ============================================

-- Users table indexes (if missing)
SET @idx = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND INDEX_NAME = 'idx_users_role');
SET @sql = IF(@idx = 0,
  'CREATE INDEX idx_users_role ON users(role)',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ============================================
-- 10. Auto-create wallets for existing instructors
-- ============================================
INSERT IGNORE INTO instructor_wallets (instructor_id, balance)
SELECT id, 0.00 FROM users WHERE role = 'instructor';

-- ============================================
-- 11. Fix exam_groups foreign keys
-- ============================================
-- Ensure exam_groups has proper FK
SET @fk = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'exam_groups' AND COLUMN_NAME = 'exam_id' AND REFERENCED_TABLE_NAME IS NOT NULL);
SET @sql = IF(@fk = 0,
  'ALTER TABLE exam_groups ADD CONSTRAINT fk_eg_exam FOREIGN KEY (exam_id) REFERENCES exams(id) ON DELETE CASCADE',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @fk = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'exam_groups' AND COLUMN_NAME = 'group_id' AND REFERENCED_TABLE_NAME IS NOT NULL);
SET @sql = IF(@fk = 0,
  'ALTER TABLE exam_groups ADD CONSTRAINT fk_eg_group FOREIGN KEY (group_id) REFERENCES `groups`(id) ON DELETE CASCADE',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ============================================
-- 12. Premium lectures tables
-- ============================================
CREATE TABLE IF NOT EXISTS premium_lectures (
    id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
    title VARCHAR(255) NOT NULL,
    description TEXT,
    video_url VARCHAR(500),
    thumbnail_url VARCHAR(500),
    duration_minutes INT DEFAULT 0,
    price DECIMAL(10,2) NOT NULL DEFAULT 0,
    grade_id CHAR(36),
    group_id CHAR(36),
    is_published BOOLEAN DEFAULT FALSE,
    created_by CHAR(36),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (grade_id) REFERENCES grades(id) ON DELETE SET NULL,
    FOREIGN KEY (group_id) REFERENCES `groups`(id) ON DELETE SET NULL,
    FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
    INDEX idx_grade_id (grade_id),
    INDEX idx_group_id (group_id),
    INDEX idx_published (is_published)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS premium_lecture_access (
    id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
    student_id CHAR(36) NOT NULL,
    premium_lecture_id CHAR(36) NOT NULL,
    granted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY unique_student_premium (student_id, premium_lecture_id),
    FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE,
    FOREIGN KEY (premium_lecture_id) REFERENCES premium_lectures(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS premium_lecture_payments (
    id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
    student_id CHAR(36) NOT NULL,
    premium_lecture_id CHAR(36) NOT NULL,
    receipt_image_url VARCHAR(500),
    amount DECIMAL(10,2) NOT NULL,
    status ENUM('pending', 'approved', 'rejected') DEFAULT 'pending',
    notes TEXT,
    rejection_reason TEXT,
    reviewed_by CHAR(36),
    reviewed_at TIMESTAMP NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE,
    FOREIGN KEY (premium_lecture_id) REFERENCES premium_lectures(id) ON DELETE CASCADE,
    FOREIGN KEY (reviewed_by) REFERENCES users(id) ON DELETE SET NULL,
    INDEX idx_student_id (student_id),
    INDEX idx_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================
-- 13. Video tables (for future video uploads)
-- ============================================
CREATE TABLE IF NOT EXISTS videos (
    id VARCHAR(36) PRIMARY KEY,
    title VARCHAR(255) NOT NULL,
    description TEXT,
    file_url VARCHAR(500),
    thumbnail_url VARCHAR(500),
    duration_seconds INT DEFAULT 0,
    file_size BIGINT DEFAULT 0,
    status ENUM('uploading', 'processing', 'ready', 'failed') DEFAULT 'uploading',
    processing_progress INT DEFAULT 0,
    uploaded_by VARCHAR(36),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_status (status),
    INDEX idx_uploaded_by (uploaded_by)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================
-- 14. Notifications table
-- ============================================
CREATE TABLE IF NOT EXISTS notifications (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id VARCHAR(36),
    user_type ENUM('student', 'admin', 'teacher', 'instructor', 'staff') DEFAULT 'student',
    title VARCHAR(255) NOT NULL,
    message TEXT NOT NULL,
    type VARCHAR(50) DEFAULT 'info',
    is_read BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_user (user_id, user_type),
    INDEX idx_read (is_read),
    INDEX idx_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================
-- 15. Messages table
-- ============================================
CREATE TABLE IF NOT EXISTS messages (
    id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
    sender_id CHAR(36),
    recipient_id CHAR(36),
    message_text TEXT NOT NULL,
    is_read BOOLEAN DEFAULT FALSE,
    sent_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    read_at TIMESTAMP NULL,
    INDEX idx_sender (sender_id),
    INDEX idx_recipient (recipient_id),
    INDEX idx_read (is_read),
    INDEX idx_sent_at (sent_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================
-- Done!
-- ============================================
SELECT '✅ Al-Qaed Platform cleanup migration completed!' AS status;
