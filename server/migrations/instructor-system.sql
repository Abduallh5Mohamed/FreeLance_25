-- ============================================
-- Instructor System Migration
-- ============================================
-- Run this file once on your MySQL database
-- to enable the instructor role and related features.

-- Step 1: Add 'instructor' to the users.role ENUM
-- (Skip if already present)
ALTER TABLE users MODIFY COLUMN role ENUM('admin', 'teacher', 'student', 'instructor') NOT NULL DEFAULT 'student';

-- ============================================
-- Table: instructor_wallets
-- One wallet per instructor
-- ============================================
CREATE TABLE IF NOT EXISTS instructor_wallets (
    id INT AUTO_INCREMENT PRIMARY KEY,
    instructor_id INT NOT NULL,
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
    instructor_id INT NOT NULL,
    type ENUM('credit', 'debit') NOT NULL,
    amount DECIMAL(10,2) NOT NULL,
    balance_after DECIMAL(10,2) NOT NULL DEFAULT 0.00,
    description VARCHAR(500),
    reference_id INT DEFAULT NULL,        -- e.g. video request id
    created_by INT DEFAULT NULL,          -- admin who performed the action
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (instructor_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================
-- Table: instructor_video_requests
-- Request from one instructor to another for a lecture
-- ============================================
CREATE TABLE IF NOT EXISTS instructor_video_requests (
    id INT AUTO_INCREMENT PRIMARY KEY,
    requester_id INT NOT NULL,            -- instructor who wants the video
    owner_id INT NOT NULL,                -- instructor who owns the video
    lecture_id INT NOT NULL,              -- the lecture being requested
    status ENUM('pending', 'approved_free', 'approved_paid', 'rejected') NOT NULL DEFAULT 'pending',
    offered_price DECIMAL(10,2) DEFAULT NULL,   -- price set by owner when approving
    message TEXT DEFAULT NULL,            -- optional message from requester
    owner_response TEXT DEFAULT NULL,     -- optional response from owner
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (requester_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (lecture_id) REFERENCES lectures(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================
-- Table: instructor_shared_lectures
-- Tracks which lectures an instructor has access to (obtained via request)
-- ============================================
CREATE TABLE IF NOT EXISTS instructor_shared_lectures (
    id INT AUTO_INCREMENT PRIMARY KEY,
    instructor_id INT NOT NULL,           -- who received access
    lecture_id INT NOT NULL,              -- the lecture they can now use
    request_id INT NOT NULL,              -- the approved request
    obtained_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_instructor_lecture (instructor_id, lecture_id),
    FOREIGN KEY (instructor_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (lecture_id) REFERENCES lectures(id) ON DELETE CASCADE,
    FOREIGN KEY (request_id) REFERENCES instructor_video_requests(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================
-- Automatically create a wallet for any existing
-- users who already have role = 'instructor'
-- (safe to run multiple times - INSERT IGNORE)
-- ============================================
INSERT IGNORE INTO instructor_wallets (instructor_id, balance)
SELECT id, 0.00 FROM users WHERE role = 'instructor';
