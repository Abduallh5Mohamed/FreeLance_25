-- Migration: Add password_hash and accessible_pages columns to staff table
-- Run this script to enable staff login with permissions

-- Add password_hash column for authentication
ALTER TABLE staff 
ADD COLUMN IF NOT EXISTS password_hash VARCHAR(255) NULL AFTER phone;

-- Add accessible_pages column for permissions (JSON array of page IDs)
ALTER TABLE staff 
ADD COLUMN IF NOT EXISTS accessible_pages JSON DEFAULT '[]' AFTER role;

-- Drop the email unique constraint if it exists (we want to allow null emails)
-- and make phone required for login
ALTER TABLE staff 
MODIFY COLUMN email VARCHAR(255) NULL;

-- Add index on phone for faster lookups during login
CREATE INDEX IF NOT EXISTS idx_staff_phone ON staff(phone);

-- Update existing staff records to have empty accessible_pages array
UPDATE staff SET accessible_pages = '[]' WHERE accessible_pages IS NULL;

-- Sample: To create a staff member with password
-- Password below is bcrypt hash of 'password123'
-- INSERT INTO staff (name, phone, password_hash, role, accessible_pages, is_active) 
-- VALUES ('Test Staff', '01234567890', '$2a$10$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llC/.og/at2.uheWG/igi', 'staff', '["messages"]', 1);

SELECT 'Staff table migration completed!' AS status;
