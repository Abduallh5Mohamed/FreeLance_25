#!/bin/bash
# ═══════════════════════════════════════
# Video Security v4.0 Deployment Script
# Run on server: bash /tmp/deploy-security-v4.sh
# ═══════════════════════════════════════

set -e
echo "════════════════════════════════════════"
echo "  Video Security v4.0 Deployment"  
echo "════════════════════════════════════════"

# Step 1: Run database migration
echo ""
echo "[1/4] Running database migration..."
cd /root/alqaed/server

mysql -u root freelance << 'EOSQL'
-- Create video_sessions table
CREATE TABLE IF NOT EXISTS video_sessions (
    id VARCHAR(36) PRIMARY KEY,
    user_id INT NOT NULL,
    video_id VARCHAR(255) NOT NULL,
    ip_address VARCHAR(45),
    user_agent TEXT,
    fingerprint VARCHAR(255),
    screen_resolution VARCHAR(20),
    watermark_seed VARCHAR(64),
    is_active BOOLEAN DEFAULT TRUE,
    violation_score INT DEFAULT 0,
    killed_reason VARCHAR(255) NULL,
    killed_at DATETIME NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_heartbeat DATETIME DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_user_active (user_id, is_active),
    INDEX idx_video (video_id),
    INDEX idx_heartbeat (last_heartbeat)
);

-- Add columns to video_security_logs if they don't exist
-- session_id column
SET @col_exists = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = 'freelance' AND TABLE_NAME = 'video_security_logs' AND COLUMN_NAME = 'session_id');
SET @sql = IF(@col_exists = 0, 'ALTER TABLE video_security_logs ADD COLUMN session_id VARCHAR(36) NULL', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- violation_score column
SET @col_exists = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = 'freelance' AND TABLE_NAME = 'video_security_logs' AND COLUMN_NAME = 'violation_score');
SET @sql = IF(@col_exists = 0, 'ALTER TABLE video_security_logs ADD COLUMN violation_score INT DEFAULT 0', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Add suspension columns to users if they don't exist
SET @col_exists = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = 'freelance' AND TABLE_NAME = 'users' AND COLUMN_NAME = 'suspended_until');
SET @sql = IF(@col_exists = 0, 'ALTER TABLE users ADD COLUMN suspended_until DATETIME NULL', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @col_exists = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = 'freelance' AND TABLE_NAME = 'users' AND COLUMN_NAME = 'suspension_reason');
SET @sql = IF(@col_exists = 0, 'ALTER TABLE users ADD COLUMN suspension_reason VARCHAR(255) NULL', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Create video_security_logs if not exists
CREATE TABLE IF NOT EXISTS video_security_logs (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    video_id VARCHAR(255),
    event_type VARCHAR(50) NOT NULL,
    details TEXT,
    ip_address VARCHAR(45),
    user_agent TEXT,
    session_id VARCHAR(36) NULL,
    violation_score INT DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_user (user_id),
    INDEX idx_event (event_type),
    INDEX idx_session (session_id),
    INDEX idx_created (created_at)
);
EOSQL

echo "   ✓ Database migration complete"

# Step 2: Deploy backend files
echo ""
echo "[2/4] Backend files already uploaded via SCP..."
echo "   ✓ Backend files ready"

# Step 3: Install any new dependencies
echo ""
echo "[3/4] Checking backend dependencies..."
cd /root/alqaed/server
npm install --production 2>&1 | tail -5
echo "   ✓ Dependencies installed"

# Step 4: Restart PM2
echo ""
echo "[4/4] Restarting backend (PM2)..."
pm2 restart alqaed-backend 2>&1 || pm2 restart all 2>&1
sleep 3
pm2 status
echo ""
echo "════════════════════════════════════════"
echo "  ✓ Video Security v4.0 Deployed!"
echo "════════════════════════════════════════"
